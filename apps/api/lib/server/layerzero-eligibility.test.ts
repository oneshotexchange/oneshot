import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionResult, type Hex } from 'viem';
import { LAYERZERO_ZRO_CLAIM_ABI } from '@oneshot/evm';
import { createLayerZeroEligibilityResolver } from './layerzero-eligibility';

afterEach(() => {
  vi.restoreAllMocks();
});

function zroResult(amount: bigint): Hex {
  return encodeFunctionResult({
    abi: LAYERZERO_ZRO_CLAIM_ABI,
    functionName: 'zroClaimed',
    result: amount,
  });
}

describe('Live LayerZero eligibility resolver (Arbitrum ZRO claim + LayerZero Scan V1/V2)', () => {
  const walletA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const cutoff = '2026-11-23T00:00:00.000Z';

  it('classifies zroClaimed > 0 as lz_winner even if LayerZero Scan has an outage or < 5 txs', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('arb1')) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: zroResult(15_000_000_000_000_000_000n) }), {
          status: 200,
        });
      }
      return new Response('Scan down', { status: 503 });
    }) as unknown as typeof fetch;

    const resolver = createLayerZeroEligibilityResolver({
      fetcher,
      arbitrumRpcUrls: () => ['https://arb1.test.local'],
      scanApiUrl: () => 'https://scan.test.local/v1',
    });

    const res = await resolver.resolve(walletA, { cutoffAt: cutoff });
    expect(res).toEqual({
      wallet: walletA,
      tier: 'lz_winner',
      zroClaimedRaw: '15000000000000000000',
      source: 'arbitrum_zro_claim',
    });
  });

  it('counts delivered LayerZero V1+V2 messages before cutoff and ignores post-cutoff farming', async () => {
    const messages = [
      // 3 valid historical messages (DELIVERED before cutoff)
      { guid: 'g1', created: '2024-04-16T09:51:44.000Z', status: { name: 'DELIVERED' }, source: { status: 'SUCCEEDED' } },
      { guid: 'g2', created: '2024-05-01T00:00:00.000Z', status: { name: 'DELIVERED' }, source: { status: 'SUCCEEDED' } },
      { guid: 'g3', created: '2026-11-20T00:00:00.000Z', status: { name: 'DELIVERED' }, source: { status: 'SUCCEEDED' } },
      // 3 post-cutoff or failed messages (must be ignored!)
      { guid: 'g4', created: '2026-11-24T00:00:00.000Z', status: { name: 'DELIVERED' }, source: { status: 'SUCCEEDED' } },
      { guid: 'g5', created: '2026-11-25T00:00:00.000Z', status: { name: 'DELIVERED' }, source: { status: 'SUCCEEDED' } },
      { guid: 'g6', created: '2024-05-05T00:00:00.000Z', status: { name: 'FAILED' }, source: { status: 'FAILED' } },
    ];

    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('arb1')) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: zroResult(0n) }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: messages }), { status: 200 });
    }) as unknown as typeof fetch;

    const resolver = createLayerZeroEligibilityResolver({
      fetcher,
      arbitrumRpcUrls: () => ['https://arb1.test.local'],
      scanApiUrl: () => 'https://scan.test.local/v1',
    });

    // Only 3 messages qualify (< 5) -> community
    const r3 = await resolver.resolve(walletA, { cutoffAt: cutoff });
    expect(r3).toEqual({ wallet: walletA, tier: 'community', source: 'none' });

    // Add 2 more historical messages -> 5 total before cutoff -> lz_user_5tx
    messages.push(
      { guid: 'g7', created: '2023-12-01T00:00:00.000Z', status: { name: 'DELIVERED' }, source: { status: 'SUCCEEDED' } },
      { guid: 'g8', created: '2024-01-10T00:00:00.000Z', status: { name: 'DELIVERED' }, source: { status: 'SUCCEEDED' } },
    );
    const r5 = await resolver.resolve(walletB, { cutoffAt: cutoff });
    expect(r5).toEqual({ wallet: walletB, tier: 'lz_user_5tx', txCount: 5, source: 'layerzero_scan' });
  });

  it('treats Scan 404 (no messages) as community with negative cache, and fails closed 503 on real outages', async () => {
    let time = 1_000_000;
    let mode: '404' | 'outage' = '404';
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('arb1')) {
        if (mode === 'outage') return new Response('Down', { status: 502 });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: zroResult(0n) }), { status: 200 });
      }
      if (mode === '404') {
        return new Response(JSON.stringify({ code: 4040, message: 'Message not found for srcAddress' }), { status: 404 });
      }
      return new Response('Scan outage', { status: 500 });
    }) as unknown as typeof fetch;

    const resolver = createLayerZeroEligibilityResolver({
      fetcher,
      arbitrumRpcUrls: () => ['https://arb1.test.local'],
      scanApiUrl: () => 'https://scan.test.local/v1',
      now: () => time,
      negativeCacheTtlMs: 60_000,
    });

    // Parallel calls deduped in-flight -> 2 fetches total (1 Arb + 1 Scan)
    const [p1, p2] = await Promise.all([resolver.resolve(walletA, { cutoffAt: cutoff }), resolver.resolve(walletA, { cutoffAt: cutoff })]);
    expect(p1.tier).toBe('community');
    expect(p2.tier).toBe('community');
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Negative cache hit -> 0 additional fetches
    const cached = await resolver.resolve(walletA, { cutoffAt: cutoff });
    expect(cached.tier).toBe('community');
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Outage rejects 503 and is NOT cached
    mode = 'outage';
    await expect(resolver.resolve(walletB, { cutoffAt: cutoff })).rejects.toMatchObject({
      code: 'AIRDROP_LAYERZERO_UNAVAILABLE',
      status: 503,
    });
    const callsAfterOutage = vi.mocked(fetcher).mock.calls.length;
    await expect(resolver.resolve(walletB, { cutoffAt: cutoff })).rejects.toMatchObject({
      code: 'AIRDROP_LAYERZERO_UNAVAILABLE',
      status: 503,
    });
    expect(vi.mocked(fetcher).mock.calls.length).toBeGreaterThan(callsAfterOutage);
  });

  it('rejects non-4040 Scan 404 responses with 503 without negative caching', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('arb1')) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: zroResult(0n) }), { status: 200 });
      }
      return new Response('<html>404 Not Found</html>', { status: 404 });
    }) as unknown as typeof fetch;

    const resolver = createLayerZeroEligibilityResolver({
      fetcher,
      arbitrumRpcUrls: () => ['https://arb1.test.local'],
      scanApiUrl: () => 'https://scan.test.local/v1',
      negativeCacheTtlMs: 60_000,
    });

    await expect(resolver.resolve(walletA, { cutoffAt: cutoff })).rejects.toMatchObject({
      code: 'AIRDROP_LAYERZERO_UNAVAILABLE',
      status: 503,
    });
    await expect(resolver.resolve(walletA, { cutoffAt: cutoff })).rejects.toMatchObject({
      code: 'AIRDROP_LAYERZERO_UNAVAILABLE',
      status: 503,
    });
    // Both invocations hit network because non-4040 404 is treated as upstream outage
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('fails over to secondary Arbitrum RPC on primary HTTP error or truncated eth_call word', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('primary-rpc')) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }), { status: 200 });
      }
      if (url.includes('fallback-rpc')) {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: zroResult(42_000_000_000_000_000_000n) }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ code: 4040, message: 'Message not found' }), { status: 404 });
    }) as unknown as typeof fetch;

    const resolver = createLayerZeroEligibilityResolver({
      fetcher,
      arbitrumRpcUrls: () => ['https://primary-rpc.test.local', 'https://fallback-rpc.test.local'],
      scanApiUrl: () => 'https://scan.test.local/v1',
    });

    const res = await resolver.resolve(walletA, { cutoffAt: cutoff });
    expect(res).toMatchObject({
      wallet: walletA,
      tier: 'lz_winner',
      zroClaimedRaw: '42000000000000000000',
      source: 'arbitrum_zro_claim',
    });

    // If both Arbitrum RPCs return malformed/truncated words, fail closed 503
    const brokenResolver = createLayerZeroEligibilityResolver({
      fetcher: (async (input: string | URL | Request) => {
        if (String(input).includes('rpc')) {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1234' }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 4040 }), { status: 404 });
      }) as typeof fetch,
      arbitrumRpcUrls: () => ['https://primary-rpc.test.local', 'https://fallback-rpc.test.local'],
      scanApiUrl: () => 'https://scan.test.local/v1',
    });

    await expect(brokenResolver.resolve(walletB, { cutoffAt: cutoff })).rejects.toMatchObject({
      code: 'AIRDROP_LAYERZERO_UNAVAILABLE',
      status: 503,
    });
  });
});
