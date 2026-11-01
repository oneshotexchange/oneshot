import { describe, expect, it, vi } from 'vitest';
import { RpcError } from '@oneshot/evm';
import { watchIndexer, indexerRetryReason, pauseIndexerWatch, type WatchEvent } from '../src/watch';
import { IndexerError, type Block, type ChainSource, type Manifest } from '../src/types';
import { MemoryIndexerStore } from '../src/store';
import { syncIndexer } from '../src/engine';

const hash = (number: number) => `0x${number.toString(16).padStart(64, '0')}` as const;
const manifest: Manifest = { schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', mode: 'local', chainId: 31337,
  genesisHash: hash(0), startBlock: 1n, anchorHash: hash(0),
  factory: { address: '0x0000000000000000000000000000000000000001', codeHash: hash(1) },
  marketplace: { address: '0x0000000000000000000000000000000000000002', codeHash: hash(2) } };
const block = (number: bigint): Block => ({ number, hash: hash(Number(number)), parentHash: hash(Number(number - 1n)), timestamp: number });
function source(height = 0n): ChainSource {
  return { verify: async () => {}, height: async () => height, block: async number => block(number), logs: async () => [] };
}
const success = { processed: 0, rolledBack: 0, head: null, target: 0n, caughtUp: true };
const noopPause = async () => {};

describe('local continuous indexer lifecycle', () => {
  it('catches up in bounded serial passes, then wakes for new blocks without overlapping work', async () => {
    let height = 5n, active = 0, maximumActive = 0, waits = 0;
    const chain = source(); chain.height = async () => height;
    const store = new MemoryIndexerStore(), controller = new AbortController(), events: WatchEvent[] = [], delays: number[] = [];
    const run = await watchIndexer(chain, store, manifest, { maxBlocks: 2, pollIntervalMs: 2_000, signal: controller.signal,
      sync: async (...args) => { active++; maximumActive = Math.max(maximumActive, active); await Promise.resolve();
        try { return await syncIndexer(...args); } finally { active--; } },
      onEvent: event => events.push(event), pause: async milliseconds => { delays.push(milliseconds); waits++;
        if (waits === 3) height = 6n; if (waits === 4) controller.abort(); } });
    expect(run).toEqual({ passes: 4, reason: 'aborted' });
    expect(maximumActive).toBe(1); expect(delays).toEqual([500, 500, 2_000, 2_000]);
    expect((await store.snapshot()).blocks.map(entry => entry.block.number)).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
    expect(events.filter(event => event.status === 'syncing').map(event => 'processed' in event && event.processed)).toEqual([2, 2, 1, 1]);
  });

  it('drains an in-flight pass before stop and leaves store ownership to the caller', async () => {
    const controller = new AbortController(), store = new MemoryIndexerStore(), close = vi.spyOn(store, 'close');
    let finish!: () => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const events: WatchEvent[] = [];
    let settled = false;
    const running = watchIndexer(source(), store, manifest, { signal: controller.signal, onEvent: event => events.push(event),
      sync: async () => { started(); await gate; return success; }, pause: async () => { throw new Error('Should not pause after abort'); } })
      .then(result => { settled = true; return result; });
    await ready; controller.abort(); await Promise.resolve(); expect(settled).toBe(false);
    finish(); expect(await running).toEqual({ passes: 1, reason: 'aborted' });
    expect(close).not.toHaveBeenCalled(); expect(events.at(-1)).toEqual({ status: 'stopped', passes: 1 });
  });

  it('does not start an already-aborted watcher or wait after a successful aborted pass', async () => {
    const controller = new AbortController(); controller.abort();
    const sync = vi.fn(), pause = vi.fn();
    expect(await watchIndexer(source(), new MemoryIndexerStore(), manifest, { signal: controller.signal, sync, pause })).toEqual({ passes: 0, reason: 'aborted' });
    expect(sync).not.toHaveBeenCalled(); expect(pause).not.toHaveBeenCalled();
  });

  it('backs off known outages, recovers, resets failures and emits only redacted aggregates', async () => {
    const controller = new AbortController(), events: WatchEvent[] = [], delays: number[] = [];
    const databaseFailure = Object.assign(new Error('postgresql://secret-user:secret-password@private-host/private'), { code: 'ECONNREFUSED' });
    let calls = 0;
    await watchIndexer(source(), new MemoryIndexerStore(), manifest, { signal: controller.signal, onEvent: event => events.push(event),
      sync: async () => { calls++; if ([1, 2, 4].includes(calls)) throw databaseFailure; return success; },
      pause: async milliseconds => { delays.push(milliseconds); if (calls === 5) controller.abort(); } });
    expect(delays).toEqual([500, 1000, 2000, 500, 2000]);
    expect(events.filter(event => event.status === 'retrying').map(event => 'failures' in event && event.failures)).toEqual([1, 2, 1]);
    const serialized = JSON.stringify(events); expect(serialized).not.toContain('secret'); expect(serialized).not.toContain('private-host');
    expect(serialized).not.toContain(manifest.factory.address); expect(serialized).not.toContain(manifest.genesisHash);
  });

  it('caps backoff and stops after eight consecutive retry waits', async () => {
    const delays: number[] = [], sync = vi.fn(async () => { throw new RpcError('RPC_TIMEOUT'); });
    await expect(watchIndexer(source(), new MemoryIndexerStore(), manifest, { sync, pause: async milliseconds => { delays.push(milliseconds); } }))
      .rejects.toMatchObject({ code: 'WATCH_RETRY_EXHAUSTED' });
    expect(sync).toHaveBeenCalledTimes(9); expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it.each(['CHAIN_IDENTITY_MISMATCH', 'DEPLOYMENT_ANCHOR_CHANGED', 'CONTRACT_CODE_MISMATCH', 'REORG_TOO_DEEP', 'EVENT_UNKNOWN_OR_INVALID'])
    ('stops before retrying an integrity failure: %s', async code => {
      const pause = vi.fn(noopPause), sync = vi.fn(async () => { throw new IndexerError(code); });
      await expect(watchIndexer(source(), new MemoryIndexerStore(), manifest, { sync, pause })).rejects.toMatchObject({ code });
      expect(sync).toHaveBeenCalledTimes(1); expect(pause).not.toHaveBeenCalled();
    });

  it('interrupts the real idle timer immediately on abort', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController(); let done = false;
      const waiting = pauseIndexerWatch(60_000, controller.signal).then(() => { done = true; });
      expect(done).toBe(false); controller.abort(); await waiting;
      expect(done).toBe(true); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([499, 60_001, 1.5, NaN])('rejects invalid polling intervals before a pass: %s', async pollIntervalMs => {
    const sync = vi.fn();
    await expect(watchIndexer(source(), new MemoryIndexerStore(), manifest, { pollIntervalMs, sync })).rejects.toMatchObject({ code: 'WATCH_OPTIONS_INVALID' });
    expect(sync).not.toHaveBeenCalled();
  });

  it('refuses a nonlocal profile before starting work', async () => {
    const sync = vi.fn();
    await expect(watchIndexer(source(), new MemoryIndexerStore(), { ...manifest, chainId: 1 } as unknown as Manifest, { sync }))
      .rejects.toMatchObject({ code: 'LOCAL_PROFILE_REQUIRED' });
    expect(sync).not.toHaveBeenCalled();
  });
});

describe('watch retry classification', () => {
  it('retries bounded transport outages and race conditions, not identity/protocol/configuration errors', () => {
    expect(indexerRetryReason(new RpcError('RPC_UNAVAILABLE'))).toBe('RPC_TEMPORARILY_UNAVAILABLE');
    expect(indexerRetryReason(new RpcError('RPC_HTTP_ERROR'))).toBe('RPC_TEMPORARILY_UNAVAILABLE');
    expect(indexerRetryReason(new IndexerError('CHAIN_MOVED'))).toBe('CHAIN_MOVED');
    expect(indexerRetryReason(new IndexerError('CONCURRENT_SYNC'))).toBe('CONCURRENT_SYNC');
    for (const code of ['CHAIN_ID_MISMATCH', 'GENESIS_MISMATCH', 'RPC_RESPONSE_INVALID', 'RPC_REMOTE_ERROR', 'CONFIG_INVALID'] as const) {
      expect(indexerRetryReason(new RpcError(code))).toBeNull();
    }
    for (const error of [new Error('unknown'), { code: '28P01' }, { code: '42P01' }, { code: 'RPC_TIMEOUT' }, null]) {
      expect(indexerRetryReason(error)).toBeNull();
    }
  });
});
