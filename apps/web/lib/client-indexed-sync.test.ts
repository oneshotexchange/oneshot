import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIndexedReceiptSync } from './client-indexed-sync';
import { IndexedReadError } from './client-indexed-api';
import { NftLaunchError, createNftLaunchApi } from './client-nft-launch';

const tx = `0x${'12'.repeat(32)}`, block = `0x${'34'.repeat(32)}`, other = `0x${'56'.repeat(32)}`;
const target = { scope: 'account:a/wallet:a/chain:31337/collection:a/item:1', deploymentId: 'local-one', reviewId: 'review-one', transactionHash: tx, blockNumber: '10', blockHash: block };
function context(height = '9', hash = other) {
  return { enabled: true, available: true, reason: null, deploymentId: target.deploymentId,
    network: { mode: 'local', name: 'Local Anvil', chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 },
    checkpoint: { number: height, hash, timestamp: '1000' }, readonly: true, finalized: false };
}
const confirmed = { status: 'confirmed', hash: tx, blockNumber: '10', blockHash: block };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function harness() {
  let scope: string | null = target.scope;
  const status = vi.fn<(signal: AbortSignal) => Promise<unknown>>().mockResolvedValue({ context: context() });
  const receipt = vi.fn<(input: { reviewId: string; hash: string }, signal: AbortSignal) => Promise<unknown>>().mockResolvedValue(confirmed);
  const refresh = vi.fn(), wallet = vi.fn();
  // There is deliberately no wallet dependency in the controller's interface.
  const dependencies = { context: () => scope, status, receipt, refresh, wallet };
  const controller = createIndexedReceiptSync(dependencies);
  return { controller, status, receipt, refresh, wallet, setScope: (value: string | null) => { scope = value; } };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
describe('receipt to indexed display synchronization', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps confirmation independent while polling every two seconds, then proves its canonical receipt before refreshing', async () => {
    const h = harness(); h.controller.start(target); await flush();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'syncing', message: 'Transaction confirmed; activity is updating.' });
    expect(h.status).toHaveBeenCalledOnce(); expect(h.receipt).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1999); expect(h.status).toHaveBeenCalledOnce();
    h.status.mockResolvedValue({ context: context('10', block) });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.receipt).toHaveBeenCalledExactlyOnceWith({ reviewId: target.reviewId, hash: tx }, expect.any(AbortSignal));
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'indexed', canRetry: false }); expect(h.refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000); expect(h.status).toHaveBeenCalledTimes(2); expect(h.wallet).not.toHaveBeenCalled();
  });

  it('rechecks canonicality even when the index checkpoint is higher than the receipt block', async () => {
    const h = harness(), proof = deferred<unknown>(); h.status.mockResolvedValue({ context: context('99999999999999999999') }); h.receipt.mockReturnValue(proof.promise);
    h.controller.start(target); await flush(); expect(h.controller.getSnapshot().phase).toBe('syncing'); expect(h.refresh).not.toHaveBeenCalled();
    proof.resolve(confirmed); await flush(); expect(h.controller.getSnapshot().phase).toBe('indexed'); expect(h.refresh).toHaveBeenCalledOnce();
  });

  it('does not accept a checkpoint at the receipt height with a different hash, even if the receipt remains canonical', async () => {
    const h = harness(); h.status.mockResolvedValue({ context: context('10', other) }); h.controller.start(target); await flush();
    expect(h.receipt).toHaveBeenCalledOnce(); expect(h.controller.getSnapshot().phase).toBe('syncing'); expect(h.refresh).not.toHaveBeenCalled();
    h.status.mockResolvedValue({ context: context('10', block) }); await vi.advanceTimersByTimeAsync(2000);
    expect(h.controller.getSnapshot().phase).toBe('indexed'); expect(h.refresh).toHaveBeenCalledOnce();
  });

  it.each(['pending', 'reverted'])('shows a chain change when the fresh receipt is %s and refreshes stale indexed records', async status => {
    const h = harness(); h.status.mockResolvedValue({ context: context('10', block) }); h.receipt.mockResolvedValue({ status }); h.controller.start(target); await flush();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'reorg', canRetry: false }); expect(h.controller.getSnapshot().message).toContain('Confirmation changed'); expect(h.refresh).toHaveBeenCalledOnce(); expect(h.wallet).not.toHaveBeenCalled();
  });

  it.each([{ blockHash: other }, { blockNumber: '11', blockHash: other }])('treats a reminted or replaced receipt as a chain change: %j', async fields => {
    const h = harness(); h.status.mockResolvedValue({ context: context('12') }); h.receipt.mockResolvedValue({ ...confirmed, ...fields }); h.controller.start(target); await flush();
    expect(h.controller.getSnapshot().phase).toBe('reorg'); expect(h.refresh).toHaveBeenCalledOnce();
  });

  it('bounds slow indexing to thirty seconds, aborts its signal, and permits an explicit retry', async () => {
    const h = harness(); h.controller.start(target); await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'pending', canRetry: true }); expect(h.controller.getSnapshot().message).toContain('Transaction confirmed');
    expect(h.status.mock.calls[0][0].aborted).toBe(true); expect(h.status).toHaveBeenCalledTimes(15);
    h.status.mockResolvedValue({ context: context('10', block) }); h.controller.retry(); await flush();
    expect(h.controller.getSnapshot().phase).toBe('indexed'); expect(h.wallet).not.toHaveBeenCalled();
  });

  it('aborts a hung status request at the deadline and ignores its late success', async () => {
    const h = harness(), request = deferred<unknown>(); h.status.mockReturnValue(request.promise); h.controller.start(target); await flush();
    await vi.advanceTimersByTimeAsync(30_000); expect(h.status.mock.calls[0][0].aborted).toBe(true); expect(h.controller.getSnapshot().phase).toBe('pending');
    request.resolve({ context: context('10', block) }); await flush(); expect(h.receipt).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
  });

  it('aborts a hung canonical receipt check at the same deadline', async () => {
    const h = harness(), request = deferred<unknown>(); h.status.mockResolvedValue({ context: context('10', block) }); h.receipt.mockReturnValue(request.promise); h.controller.start(target); await flush();
    await vi.advanceTimersByTimeAsync(30_000); expect(h.receipt.mock.calls[0][1].aborted).toBe(true); expect(h.controller.getSnapshot().phase).toBe('pending');
    request.resolve(confirmed); await flush(); expect(h.refresh).not.toHaveBeenCalled();
  });

  it('backs off rate limits within the same deadline without resubmitting anything', async () => {
    const h = harness(); h.status.mockRejectedValue(new IndexedReadError(429, 'RATE_LIMITED', 'Try later')); h.controller.start(target); await flush();
    await vi.advanceTimersByTimeAsync(3999); expect(h.status).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(h.status).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7999); expect(h.status).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(h.status).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(18_000); expect(h.controller.getSnapshot().phase).toBe('pending'); expect(h.status).toHaveBeenCalledTimes(5); expect(h.wallet).not.toHaveBeenCalled();
  });

  it('keeps network failures separate from the saved transaction confirmation', async () => {
    const h = harness(); h.status.mockRejectedValue(new Error('Network down')); h.controller.start(target); await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'pending', canRetry: true }); expect(h.controller.getSnapshot().message).not.toMatch(/failed|reverted/i); expect(h.refresh).not.toHaveBeenCalled();
  });

  it('surfaces a disabled indexer with an explicit retry', async () => {
    const h = harness(); h.status.mockResolvedValue({ context: { ...context(), enabled: false, available: false, deploymentId: null, network: null, checkpoint: null } }); h.controller.start(target); await flush();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'unavailable', canRetry: true }); expect(h.receipt).not.toHaveBeenCalled();
    h.status.mockResolvedValue({ context: context('10', block) }); h.controller.retry(); await flush(); expect(h.controller.getSnapshot().phase).toBe('indexed');
  });

  it('waits through a not-yet-available checkpoint without treating it as transaction failure', async () => {
    const h = harness(); h.status.mockResolvedValue({ context: { ...context(), available: false, checkpoint: null } }); h.controller.start(target); await flush();
    expect(h.controller.getSnapshot().phase).toBe('syncing'); h.status.mockResolvedValue({ context: context('10', block) }); await vi.advanceTimersByTimeAsync(2000); expect(h.controller.getSnapshot().phase).toBe('indexed');
  });

  it('waits for an enabled indexer whose verified network context is not yet available', async () => {
    const h = harness(); h.status.mockResolvedValue({ context: { ...context(), available: false, network: null, checkpoint: null } }); h.controller.start(target); await flush();
    expect(h.controller.getSnapshot().phase).toBe('syncing'); h.status.mockResolvedValue({ context: context('10', block) }); await vi.advanceTimersByTimeAsync(2000); expect(h.controller.getSnapshot().phase).toBe('indexed');
  });

  it('handles the receipt API explicit canonical reorganization conflict as a chain change', async () => {
    const h = harness(); h.status.mockResolvedValue({ context: context('10', block) }); h.receipt.mockRejectedValue(new NftLaunchError('Receipt orphaned', 'RECEIPT_REORGED', 409)); h.controller.start(target); await flush();
    expect(h.controller.getSnapshot().phase).toBe('reorg'); expect(h.refresh).toHaveBeenCalledOnce(); expect(h.wallet).not.toHaveBeenCalled();
  });

  it('refreshes a proven orphaned indexed checkpoint once without claiming the saved receipt changed', async () => {
    const h = harness(); h.status.mockRejectedValue(new IndexedReadError(409, 'INDEXER_CHAIN_MOVED', 'Indexed checkpoint orphaned')); h.controller.start(target); await flush();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'pending', canRetry: true });
    expect(h.controller.getSnapshot().message).toContain('Activity changed after a network update');
    expect(h.controller.getSnapshot().message).not.toContain('Confirmation changed');
    expect(h.refresh).toHaveBeenCalledOnce(); expect(h.receipt).not.toHaveBeenCalled(); expect(h.wallet).not.toHaveBeenCalled();
    expect(h.status.mock.calls[0][0].aborted).toBe(true); await vi.advanceTimersByTimeAsync(30_000); expect(h.refresh).toHaveBeenCalledOnce(); expect(h.status).toHaveBeenCalledOnce();
  });

  it('ignores an orphaned-checkpoint response after the owner context changed', async () => {
    const h = harness(); let reject!: (error: unknown) => void;
    h.status.mockReturnValue(new Promise((_resolve, no) => { reject = no; })); h.controller.start(target); await flush();
    h.setScope('account:b'); reject(new IndexedReadError(409, 'INDEXER_CHAIN_MOVED', 'Indexed checkpoint orphaned')); await flush();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'idle', scope: null }); expect(h.refresh).not.toHaveBeenCalled(); expect(h.receipt).not.toHaveBeenCalled();
  });

  it('stops when the canonical receipt endpoint reports a changed deployment', async () => {
    const h = harness(); h.status.mockResolvedValue({ context: context('10', block) }); h.receipt.mockRejectedValue(new NftLaunchError('New deployment', 'DEPLOYMENT_CHANGED', 409)); h.controller.start(target); await flush();
    expect(h.controller.getSnapshot().phase).toBe('changed'); expect(h.refresh).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(30_000); expect(h.receipt).toHaveBeenCalledOnce();
  });

  it('stops when indexed data belongs to a different deployment', async () => {
    const h = harness(); h.status.mockResolvedValue({ context: { ...context('11'), deploymentId: 'other-deployment' } }); h.controller.start(target); await flush();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'changed', canRetry: false }); expect(h.receipt).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000); expect(h.status).toHaveBeenCalledOnce();
  });

  it.each([{ chainId: 1 }, { nativeDecimals: 6 }, { nativeSymbol: 'USD' }, { mode: 'remote' }])('stops an available indexer on a changed network: %j', async fields => {
    const h = harness(); h.status.mockResolvedValue({ context: { ...context('10', block), network: { ...context().network, ...fields } } }); h.controller.start(target); await flush();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'changed', canRetry: false }); expect(h.receipt).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
  });

  it.each(['account', 'wallet', 'chain', 'collection', 'deployment', 'item-selection'])('cancels timer work when %s context changes', async field => {
    const h = harness(); h.controller.start(target); await flush(); h.setScope(`${target.scope}/${field}:changed`); await vi.advanceTimersByTimeAsync(2000);
    expect(h.controller.getSnapshot().phase).toBe('idle'); expect(h.status.mock.calls[0][0].aborted).toBe(true); expect(h.status).toHaveBeenCalledOnce(); expect(h.refresh).not.toHaveBeenCalled();
  });

  it.each(['status', 'receipt'])('ignores a late %s response after cancellation or unmount', async stage => {
    const h = harness(), pending = deferred<unknown>();
    if (stage === 'status') h.status.mockReturnValue(pending.promise);
    else { h.status.mockResolvedValue({ context: context('10', block) }); h.receipt.mockReturnValue(pending.promise); }
    h.controller.start(target); await flush(); h.controller.cancel();
    const signal = stage === 'status' ? h.status.mock.calls[0][0] : h.receipt.mock.calls[0][1]; expect(signal.aborted).toBe(true);
    pending.resolve(stage === 'status' ? { context: context('10', block) } : confirmed); await flush();
    expect(h.controller.getSnapshot().phase).toBe('idle'); expect(h.refresh).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(30_000); expect(h.status).toHaveBeenCalledOnce();
  });

  it('cannot refresh or publish a late canonical response under the next account', async () => {
    const h = harness(), pending = deferred<unknown>(); h.status.mockResolvedValue({ context: context('10', block) }); h.receipt.mockReturnValue(pending.promise); h.controller.start(target); await flush();
    h.setScope('account:b'); pending.resolve(confirmed); await flush(); expect(h.controller.getSnapshot()).toMatchObject({ phase: 'idle', scope: null }); expect(h.refresh).not.toHaveBeenCalled();
  });

  it.each([
    {}, { context: null }, { context: { ...context('10', block), readonly: false } },
    { context: { ...context('10', block), finalized: true } }, { context: { ...context('10', block), network: null } },
    { context: { ...context('10', block), checkpoint: { ...context().checkpoint, number: '010' } } },
    { context: { ...context('10', block), checkpoint: { ...context().checkpoint, hash: '0x12' } } },
    { context: { ...context('10', block), checkpoint: { ...context().checkpoint, timestamp: '-1' } } },
  ])('does not declare malformed indexed data caught up: %j', async response => {
    const h = harness(); h.status.mockResolvedValue(response); h.controller.start(target); await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'pending', canRetry: true }); expect(h.receipt).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
  });

  it.each([{ ...confirmed, blockHash: 'bad' }, { ...confirmed, blockNumber: '1e2' }, { ...confirmed, hash: other }, { status: 'confirmed' }, { status: 'unknown' }, { status: ['confirmed'] }, { status: { toString: (): string => 'confirmed' } }, { status: ['pending'] }, { status: ['reverted'] }])('does not accept malformed canonical receipt proof: %j', async proof => {
    const h = harness(); h.status.mockResolvedValue({ context: context('10', block) }); h.receipt.mockResolvedValue(proof); h.controller.start(target); await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controller.getSnapshot().phase).toBe('pending'); expect(h.refresh).not.toHaveBeenCalled();
  });

  it.each([{ scope: '' }, { scope: 'other-account' }, { reviewId: '' }, { deploymentId: '' }, { blockNumber: '01' }, { blockNumber: (2n ** 256n).toString() }, { blockHash: '0x12' }, { transactionHash: 'bad' }])('rejects invalid synchronization targets before making requests: %j', async fields => {
    const h = harness(); h.controller.start({ ...target, ...fields }); await flush(); expect(h.status).not.toHaveBeenCalled(); expect(h.receipt).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
  });

  it('does not leak an older response into a newly started receipt check', async () => {
    const h = harness(), old = deferred<unknown>(); h.status.mockReturnValueOnce(old.promise); h.controller.start(target); await flush();
    h.status.mockResolvedValue({ context: context('10', block) }); h.controller.start({ ...target, reviewId: 'next-review' }); await flush();
    expect(h.controller.getSnapshot().phase).toBe('indexed'); old.resolve({ context: { ...context('12'), deploymentId: 'obsolete' } }); await flush();
    expect(h.controller.getSnapshot().phase).toBe('indexed'); expect(h.refresh).toHaveBeenCalledOnce(); expect(h.receipt.mock.calls[0][0].reviewId).toBe('next-review');
  });

  it('cannot retry the prior account receipt after a scope change', async () => {
    const h = harness(); h.status.mockResolvedValue({ context: { ...context(), enabled: false } }); h.controller.start(target); await flush();
    expect(h.controller.getSnapshot().canRetry).toBe(true); h.setScope('account:b'); h.controller.retry(); await flush();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'idle', scope: null }); expect(h.status).toHaveBeenCalledOnce(); expect(h.receipt).not.toHaveBeenCalled();
  });

  it('contains refresh failures after proof without restarting the transaction or background polling', async () => {
    const h = harness(); h.status.mockResolvedValue({ context: context('10', block) }); h.refresh.mockRejectedValue(new Error('View closed')); h.controller.start(target); await flush();
    expect(h.controller.getSnapshot().phase).toBe('indexed'); await vi.advanceTimersByTimeAsync(30_000); expect(h.status).toHaveBeenCalledOnce(); expect(h.wallet).not.toHaveBeenCalled();
  });

  it('forwards cancellation to the authenticated receipt request without invoking wallet methods', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(confirmed));
    const api = createNftLaunchApi({ identityScope: () => target.scope, getAccessToken: async () => 'test-token', fetcher });
    const abort = new AbortController(); await api.receipt({ reviewId: target.reviewId, hash: tx }, abort.signal);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({ signal: abort.signal, method: 'POST', cache: 'no-store' }));
  });

  it('does not start a private receipt fetch after cancellation while session lookup was pending', async () => {
    const token = deferred<string | null>(), fetcher = vi.fn<typeof fetch>();
    const api = createNftLaunchApi({ identityScope: () => target.scope, getAccessToken: () => token.promise, fetcher });
    const abort = new AbortController(), request = api.receipt({ reviewId: target.reviewId, hash: tx }, abort.signal);
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' }); abort.abort(); token.resolve('test-token'); await rejected; expect(fetcher).not.toHaveBeenCalled();
  });
});
