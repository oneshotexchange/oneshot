import type { Address, Hex } from 'viem';
import {
  LAYERZERO_DEFAULT_ARBITRUM_RPC_URL,
  LAYERZERO_DEFAULT_SCAN_API_URL,
  LAYERZERO_FALLBACK_ARBITRUM_RPC_URL,
  LAYERZERO_ZRO_CLAIM_ARBITRUM_ADDRESS,
  decodeLayerZeroZroClaimedResult,
  encodeLayerZeroZroClaimedData,
} from '@oneshot/evm';
import { ApiError } from './errors';

export type LayerZeroResolvedEligibility = {
  wallet: string;
  tier: 'lz_winner' | 'lz_user_5tx' | 'community';
  txCount?: number;
  zroClaimedRaw?: string;
  source: 'arbitrum_zro_claim' | 'layerzero_scan' | 'none';
};

export type LayerZeroEligibilityResolver = {
  resolve(
    wallet: string,
    options?: { cutoffAt?: string | null; minTxCount?: number },
  ): Promise<LayerZeroResolvedEligibility>;
};

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Upstream response exceeded size limit.');
    }
    chunks.push(part.value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(combined);
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readBoundedText(response, maxBytes);
  return JSON.parse(text) as unknown;
}

function defaultArbitrumRpcUrls(): string[] {
  const configured = (process.env.ONESHOT_LAYERZERO_ARBITRUM_RPC_URL || '')
    .split(',')
    .map(item => item.trim())
    .filter(item => {
      try {
        const url = new URL(item);
        return url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        return false;
      }
    });
  return configured.length
    ? configured
    : [LAYERZERO_DEFAULT_ARBITRUM_RPC_URL, LAYERZERO_FALLBACK_ARBITRUM_RPC_URL];
}

function defaultScanApiUrl(): string {
  const configured = (process.env.ONESHOT_LAYERZERO_SCAN_API_URL || '').trim().replace(/\/$/, '');
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString().replace(/\/$/, '');
    } catch {
      /* Ignore malformed env override and use official public Scan endpoint */
    }
  }
  return LAYERZERO_DEFAULT_SCAN_API_URL;
}

export function createLayerZeroEligibilityResolver(options: {
  fetcher?: typeof fetch;
  arbitrumRpcUrls?: () => string[];
  scanApiUrl?: () => string;
  claimContract?: Address;
  now?: () => number;
  negativeCacheTtlMs?: number;
  negativeCacheMaxEntries?: number;
} = {}): LayerZeroEligibilityResolver {
  const fetcher = options.fetcher || fetch;
  const getRpcUrls = options.arbitrumRpcUrls || defaultArbitrumRpcUrls;
  const getScanUrl = options.scanApiUrl || defaultScanApiUrl;
  const claimContract = options.claimContract || LAYERZERO_ZRO_CLAIM_ARBITRUM_ADDRESS;
  const now = options.now || Date.now;
  const negativeCacheTtlMs = options.negativeCacheTtlMs ?? 10 * 60 * 1000;
  const negativeCacheMaxEntries = options.negativeCacheMaxEntries ?? 20_000;

  const inFlight = new Map<string, Promise<LayerZeroResolvedEligibility>>();
  const negativeCache = new Map<string, { value: LayerZeroResolvedEligibility; expiresAt: number }>();

  async function checkArbitrumZroClaimed(wallet: Address): Promise<bigint> {
    const rpcUrls = getRpcUrls();
    const callData = encodeLayerZeroZroClaimedData(wallet);
    let lastError: Error | null = null;

    for (const rpcUrl of rpcUrls) {
      try {
        const response = await fetcher(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_call',
            params: [{ to: claimContract, data: callData }, 'latest'],
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(6000),
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new Error(`Arbitrum RPC HTTP ${response.status}`);
        }
        const payload = (await readBoundedJson(response, 64 * 1024)) as {
          result?: unknown;
          error?: { message?: string };
        };
        if (payload.error || typeof payload.result !== 'string' || !/^0x[\da-fA-F]{64}$/.test(payload.result)) {
          throw new Error(payload.error?.message || 'Unexpected Arbitrum eth_call response');
        }
        return decodeLayerZeroZroClaimedResult(payload.result as Hex);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Arbitrum RPC call failed');
      }
    }
    throw lastError || new Error('Arbitrum RPC unavailable');
  }

  async function checkLayerZeroScan(
    wallet: string,
    cutoffAt: string | null | undefined,
    minTxCount: number,
  ): Promise<number> {
    const scanBase = getScanUrl();
    const cutoffMs = cutoffAt ? Date.parse(cutoffAt) : null;
    if (cutoffMs !== null && !Number.isFinite(cutoffMs)) {
      throw new Error('Invalid LayerZero cutoff timestamp.');
    }

    const seen = new Set<string>();
    let nextToken: string | undefined;

    for (let page = 0; page < 2; page++) {
      const url = new URL(`${scanBase}/messages/wallet/${wallet}`);
      url.searchParams.set('limit', '20');
      if (cutoffAt) url.searchParams.set('end', cutoffAt);
      if (nextToken) url.searchParams.set('nextToken', nextToken);

      const response = await fetcher(url.toString(), {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(6000),
        cache: 'no-store',
      });

      if (response.status === 404) {
        // LayerZero Scan returns HTTP 404 with JSON { code: 4040 } when a wallet has 0 cross-chain messages.
        let payload404: { code?: unknown } | null = null;
        try {
          payload404 = (await readBoundedJson(response, 32 * 1024)) as { code?: unknown };
        } catch {
          payload404 = null;
        }
        if (payload404 && typeof payload404 === 'object' && payload404.code === 4040) {
          return seen.size;
        }
        throw new Error('LayerZero Scan HTTP 404');
      }
      if (!response.ok) {
        throw new Error(`LayerZero Scan HTTP ${response.status}`);
      }

      const payload = (await readBoundedJson(response, 512 * 1024)) as {
        data?: unknown;
        nextToken?: unknown;
        pagination?: { nextToken?: unknown };
      };
      if (!Array.isArray(payload.data)) {
        throw new Error('Unexpected LayerZero Scan payload.');
      }

      for (const rawItem of payload.data) {
        if (!rawItem || typeof rawItem !== 'object') continue;
        const item = rawItem as {
          guid?: unknown;
          created?: unknown;
          status?: { name?: unknown };
          source?: { status?: unknown; tx?: { txHash?: unknown; blockTimestamp?: unknown } };
          pathway?: { id?: unknown; nonce?: unknown };
        };

        const delivered = item.status?.name === 'DELIVERED' || item.source?.status === 'SUCCEEDED';
        if (!delivered) continue;

        if (cutoffMs !== null) {
          let itemMs = NaN;
          if (typeof item.created === 'string') {
            itemMs = Date.parse(item.created);
          } else if (typeof item.source?.tx?.blockTimestamp === 'number') {
            itemMs = item.source.tx.blockTimestamp * 1000;
          }
          if (!Number.isFinite(itemMs) || itemMs > cutoffMs) continue;
        }

        const dedupKey =
          typeof item.guid === 'string' && item.guid
            ? item.guid
            : typeof item.source?.tx?.txHash === 'string' && item.source.tx.txHash
              ? item.source.tx.txHash
              : `${String(item.pathway?.id || '')}:${String(item.pathway?.nonce || seen.size)}`;
        seen.add(dedupKey);
      }

      if (seen.size >= minTxCount) {
        return seen.size;
      }

      const rawNext = payload.nextToken ?? payload.pagination?.nextToken;
      if (typeof rawNext !== 'string' || !rawNext) break;
      nextToken = rawNext;
    }

    return seen.size;
  }

  function rememberNegative(key: string, value: LayerZeroResolvedEligibility) {
    if (negativeCacheMaxEntries <= 0 || negativeCacheTtlMs <= 0) return;
    const currentNow = now();
    if (negativeCache.size >= negativeCacheMaxEntries) {
      for (const [k, entry] of negativeCache) {
        if (entry.expiresAt <= currentNow) negativeCache.delete(k);
      }
      if (negativeCache.size >= negativeCacheMaxEntries) {
        const oldest = negativeCache.keys().next().value;
        if (oldest !== undefined) negativeCache.delete(oldest);
      }
    }
    negativeCache.set(key, { value, expiresAt: currentNow + negativeCacheTtlMs });
  }

  return {
    async resolve(walletInput, resolveOptions = {}): Promise<LayerZeroResolvedEligibility> {
      const normalized = walletInput.trim().toLowerCase();
      if (!/^0x[\da-f]{40}$/.test(normalized) || /^0x0{40}$/.test(normalized)) {
        throw new ApiError(400, 'INVALID_INPUT', 'Enter a valid EVM wallet address.');
      }

      const cutoffAt = resolveOptions.cutoffAt ?? null;
      const minTxCount = resolveOptions.minTxCount ?? 5;
      const cacheKey = `${normalized}:${cutoffAt || ''}:${minTxCount}`;

      const cached = negativeCache.get(cacheKey);
      if (cached && cached.expiresAt > now()) {
        return { ...cached.value };
      }
      if (cached) negativeCache.delete(cacheKey);

      const pending = inFlight.get(cacheKey);
      if (pending) return pending;

      const work = (async (): Promise<LayerZeroResolvedEligibility> => {
        const [arbResult, scanResult] = await Promise.allSettled([
          checkArbitrumZroClaimed(normalized as Address),
          checkLayerZeroScan(normalized, cutoffAt, minTxCount),
        ]);

        if (arbResult.status === 'fulfilled' && arbResult.value > 0n) {
          return {
            wallet: normalized,
            tier: 'lz_winner',
            zroClaimedRaw: arbResult.value.toString(),
            ...(scanResult.status === 'fulfilled' ? { txCount: scanResult.value } : {}),
            source: 'arbitrum_zro_claim',
          };
        }

        if (arbResult.status === 'rejected' || scanResult.status === 'rejected') {
          throw new ApiError(
            503,
            'AIRDROP_LAYERZERO_UNAVAILABLE',
            'LayerZero eligibility verification is temporarily unavailable. Please try again shortly.',
          );
        }

        if (scanResult.value >= minTxCount) {
          return {
            wallet: normalized,
            tier: 'lz_user_5tx',
            txCount: scanResult.value,
            source: 'layerzero_scan',
          };
        }

        const communityResult: LayerZeroResolvedEligibility = {
          wallet: normalized,
          tier: 'community',
          source: 'none',
        };
        rememberNegative(cacheKey, communityResult);
        return communityResult;
      })();

      inFlight.set(cacheKey, work);
      try {
        return await work;
      } finally {
        if (inFlight.get(cacheKey) === work) {
          inFlight.delete(cacheKey);
        }
      }
    },
  };
}

export const layerZeroEligibilityResolver = createLayerZeroEligibilityResolver();
