import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, type Address, type Hex } from 'viem';
import { LAYERZERO_ZRO_CLAIM_ABI, LAYERZERO_ZRO_CLAIM_ARBITRUM_ADDRESS } from '@oneshot/evm';
import { syncLayerZeroSnapshot } from './lib/layerzero-sync';

function zroResult(amount: bigint): Hex {
  return encodeFunctionResult({
    abi: LAYERZERO_ZRO_CLAIM_ABI,
    functionName: 'zroClaimed',
    result: amount,
  });
}

describe('Arbitrum + LayerZero Scan snapshot sync', () => {
  const alice = '0x1111111111111111111111111111111111111111' as Address;
  const bob = '0x2222222222222222222222222222222222222222' as Address;
  const charlie = '0x3333333333333333333333333333333333333333' as Address;
  const dave = '0x4444444444444444444444444444444444444444' as Address;

  it('decodes Claim and ClaimRemote logs and adapts block chunk size on RPC range errors', async () => {
    const [claimTopic] = encodeEventTopics({ abi: LAYERZERO_ZRO_CLAIM_ABI, eventName: 'Claim' });
    const [remoteTopic] = encodeEventTopics({ abi: LAYERZERO_ZRO_CLAIM_ABI, eventName: 'ClaimRemote' });

    const claimData = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }],
      [alice, 100n, 100n, alice],
    );
    const remoteData = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint32' }, { type: 'address' }],
      [bob, 200n, 200n, 30110, bob],
    );

    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { params: [{ fromBlock: Hex; toBlock: Hex }] };
      const from = Number(BigInt(payload.params[0]!.fromBlock));
      const to = Number(BigInt(payload.params[0]!.toBlock));

      if (to - from >= 2) {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'block range too wide' } }),
          { status: 200 },
        );
      }
      if (from <= 223_920_001) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: [
              { topics: [claimTopic], data: claimData },
              { topics: [remoteTopic], data: remoteData },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await syncLayerZeroSnapshot({
      fromBlock: 223_920_000,
      toBlock: 223_920_003,
      chunkSize: 10,
      claimContract: LAYERZERO_ZRO_CLAIM_ARBITRUM_ADDRESS,
      rpcUrl: 'https://arb1.test.local',
      retryDelayMs: 0,
      dryRun: true,
      fetcher,
    });

    expect(result).toMatchObject({
      dryRun: true,
      claimEvents: 2,
      winnersFound: 2,
      scanUsersFound: 0,
      syncedWallets: 2,
      sampleWallets: [alice, bob],
    });
  });

  it('fails over/retries on HTTP 429 without splitting block range into single-block spam', async () => {
    const seenRanges: Array<[number, number]> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const payload = JSON.parse(String(init?.body)) as { params: [{ fromBlock: Hex; toBlock: Hex }] };
      seenRanges.push([Number(BigInt(payload.params[0]!.fromBlock)), Number(BigInt(payload.params[0]!.toBlock))]);

      if (url.includes('primary-rpc')) {
        return new Response('rate limit exceeded', { status: 429 });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await syncLayerZeroSnapshot({
      fromBlock: 223_920_000,
      toBlock: 223_920_999,
      chunkSize: 1000,
      rpcUrls: ['https://primary-rpc.test.local', 'https://fallback-rpc.test.local'],
      retryDelayMs: 0,
      dryRun: true,
      fetcher,
    });

    expect(res.syncedWallets).toBe(0);
    // Exactly one call to primary (429) and one call to fallback for the full [223920000, 223920999] chunk — never split!
    expect(seenRanges).toEqual([
      [223_920_000, 223_920_999],
      [223_920_000, 223_920_999],
    ]);

    // Exhausted 429 across all RPCs throws cleanly after 3 attempts without block splitting
    const rateLimitedRanges: Array<[number, number]> = [];
    const always429 = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { params: [{ fromBlock: Hex; toBlock: Hex }] };
      rateLimitedRanges.push([Number(BigInt(payload.params[0]!.fromBlock)), Number(BigInt(payload.params[0]!.toBlock))]);
      return new Response('rate limit', { status: 429 });
    }) as unknown as typeof fetch;

    await expect(
      syncLayerZeroSnapshot({
        fromBlock: 223_920_000,
        toBlock: 223_920_999,
        chunkSize: 1000,
        rpcUrl: 'https://primary-rpc.test.local',
        retryDelayMs: 0,
        dryRun: true,
        fetcher: always429,
      }),
    ).rejects.toThrow(/429/);
    expect(rateLimitedRanges).toEqual([
      [223_920_000, 223_920_999],
      [223_920_000, 223_920_999],
      [223_920_000, 223_920_999],
    ]);
  });

  it('runs --include-scan even when Arbitrum reaches maxWallets and promotes ZRO claimers found via Scan', async () => {
    const [claimTopic] = encodeEventTopics({ abi: LAYERZERO_ZRO_CLAIM_ABI, eventName: 'Claim' });
    const claimData = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }],
      [alice, 100n, 100n, alice],
    );

    const makeDeliveredMsgs = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, idx) => ({
        guid: `${prefix}-${idx}`,
        created: '2024-06-01T00:00:00.000Z',
        status: { name: 'DELIVERED' },
        source: { status: 'SUCCEEDED' },
      }));

    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('arb1.test.local')) {
        const body = JSON.parse(String(init?.body)) as { method: string; params: Array<{ to?: string; data?: string }> };
        if (body.method === 'eth_getLogs') {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: [{ topics: [claimTopic], data: claimData }] }),
            { status: 200 },
          );
        }
        if (body.method === 'eth_call') {
          const calldata = (body.params[0]?.data || '').toLowerCase();
          // charlie claimed ZRO on Arbitrum -> must promote to lz_winner; dave has 0 claimed -> lz_user_5tx
          const amount = calldata.endsWith(charlie.slice(2)) ? 75_000_000_000_000_000_000n : 0n;
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: zroResult(amount) }), { status: 200 });
        }
      }
      if (url.includes('/messages/latest')) {
        return new Response(
          JSON.stringify({
            data: [{ source: { tx: { from: charlie } } }, { source: { tx: { from: dave } } }],
          }),
          { status: 200 },
        );
      }
      if (url.includes(`/messages/wallet/${charlie}`)) {
        return new Response(JSON.stringify({ data: makeDeliveredMsgs('c', 6) }), { status: 200 });
      }
      if (url.includes(`/messages/wallet/${dave}`)) {
        return new Response(JSON.stringify({ data: makeDeliveredMsgs('d', 5) }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await syncLayerZeroSnapshot({
      fromBlock: 223_920_000,
      toBlock: 223_920_010,
      maxWallets: 1, // Reaches maxWallets after alice
      includeScan: true,
      maxScanWallets: 5,
      cutoffAt: '2026-11-23T00:00:00.000Z',
      rpcUrl: 'https://arb1.test.local',
      scanApiUrl: 'https://scan.test.local/v1',
      retryDelayMs: 0,
      dryRun: true,
      fetcher,
    });

    // alice (Arbitrum log) + charlie (promoted from Scan via Arbitrum zroClaimed) = 2 winners; dave = 1 five-tx user
    expect(result).toMatchObject({
      winnersFound: 2,
      scanUsersFound: 1,
      syncedWallets: 3,
      sampleWallets: [alice, charlie, dave],
    });
  });

  it('rejects invalid --cutoff timestamps cleanly', async () => {
    await expect(
      syncLayerZeroSnapshot({
        cutoffAt: 'not-a-valid-date',
        dryRun: true,
      }),
    ).rejects.toThrow(/Invalid --cutoff/i);
  });
});
