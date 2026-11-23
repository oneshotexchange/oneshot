import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from 'pg';
import { decodeEventLog, encodeEventTopics, toHex, type Address, type Hex } from 'viem';
import {
  LAYERZERO_DEFAULT_ARBITRUM_RPC_URL,
  LAYERZERO_DEFAULT_SCAN_API_URL,
  LAYERZERO_FALLBACK_ARBITRUM_RPC_URL,
  LAYERZERO_ZRO_CLAIM_ABI,
  LAYERZERO_ZRO_CLAIM_ARBITRUM_ADDRESS,
  decodeLayerZeroZroClaimedResult,
  encodeLayerZeroZroClaimedData,
} from '@oneshot/evm';
import { airdropCampaignSchema, type AirdropSnapshotTier } from '../../apps/web/lib/airdrop-schema';

export type LayerZeroSyncOptions = {
  fromBlock?: number;
  toBlock?: number;
  chunkSize?: number;
  maxWallets?: number;
  maxScanWallets?: number;
  includeScan?: boolean;
  cutoffAt?: string | null;
  rpcUrl?: string;
  rpcUrls?: string[];
  scanApiUrl?: string;
  claimContract?: Address;
  flushEvery?: number;
  retryDelayMs?: number;
  dryRun?: boolean;
  actor?: string;
  pool?: Pool | null;
  fetcher?: typeof fetch;
  now?: () => number;
};

export type LayerZeroSyncResult = {
  dryRun: boolean;
  fromBlock: number;
  toBlock: number;
  claimEvents: number;
  winnersFound: number;
  scanUsersFound: number;
  syncedWallets: number;
  sampleWallets: string[];
  snapshotTotal?: number;
  snapshotWinners?: number;
  snapshotFiveTx?: number;
};

type RpcLog = {
  data: Hex;
  topics: [Hex, ...Hex[]];
};

type SyncEntry = {
  wallet: string;
  tier: AirdropSnapshotTier;
  txCount?: number;
};

class RpcError extends Error {
  status?: number;
  code?: number;

  constructor(message: string, details: { status?: number; code?: number } = {}) {
    super(message);
    this.name = 'RpcError';
    this.status = details.status;
    this.code = details.code;
  }
}

function isRangeLimitRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof RpcError && (error.code === -32005 || error.code === -32602)) {
    return true;
  }
  return /block range|too wide|more than|limit exceeded|max results|log response size|too many logs|exceeds max/i.test(
    error.message,
  );
}

function isTransientRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  if (error instanceof RpcError) {
    if (error.status === 429 || error.status === 502 || error.status === 503 || error.status === 504) {
      return true;
    }
  }
  return /rate limit|too many requests|429|timeout|aborted|temporarily unavailable|bad gateway|service unavailable|fetch failed|econnreset|network/i.test(
    error.message,
  );
}

function resolveRpcUrls(options: LayerZeroSyncOptions): string[] {
  const rawList =
    options.rpcUrls && options.rpcUrls.length > 0
      ? options.rpcUrls
      : (options.rpcUrl || process.env.ONESHOT_LAYERZERO_ARBITRUM_RPC_URL || '')
          .split(',')
          .map(item => item.trim())
          .filter(Boolean);

  const candidates =
    rawList.length > 0 ? rawList : [LAYERZERO_DEFAULT_ARBITRUM_RPC_URL, LAYERZERO_FALLBACK_ARBITRUM_RPC_URL];

  const valid: string[] = [];
  for (const item of candidates) {
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new Error(`Invalid Arbitrum RPC URL: ${item}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`Arbitrum RPC URL must use http or https: ${item}`);
    }
    const serialized = url.toString();
    if (!valid.includes(serialized)) valid.push(serialized);
  }
  return valid;
}

function resolveScanUrl(options: LayerZeroSyncOptions): string {
  const raw = options.scanApiUrl || process.env.ONESHOT_LAYERZERO_SCAN_API_URL?.trim() || LAYERZERO_DEFAULT_SCAN_API_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid LayerZero Scan API URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`LayerZero Scan API URL must use http or https: ${raw}`);
  }
  return url.toString().replace(/\/$/, '');
}

async function jsonRpcSingle<T>(rpcUrl: string, method: string, params: unknown[], fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new RpcError(`RPC ${method} failed with HTTP ${response.status}.`, { status: response.status });
  }
  const payload = (await response.json()) as { result?: T; error?: { message?: string; code?: number } };
  if (payload.error || payload.result === undefined) {
    throw new RpcError(payload.error?.message || `RPC ${method} returned an error.`, {
      code: payload.error?.code,
    });
  }
  return payload.result;
}

async function jsonRpcWithFailover<T>(
  rpcUrls: readonly string[],
  method: string,
  params: unknown[],
  fetcher: typeof fetch,
  retryDelayMs: number,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    let sawTransient = false;
    for (const rpcUrl of rpcUrls) {
      try {
        return await jsonRpcSingle<T>(rpcUrl, method, params, fetcher);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(`RPC ${method} failed.`);
        lastError = err;
        if (isRangeLimitRpcError(err)) {
          throw err;
        }
        if (isTransientRpcError(err)) {
          sawTransient = true;
        }
      }
    }
    if (!sawTransient || attempt === 2) {
      break;
    }
    if (retryDelayMs > 0) {
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }

  throw lastError || new Error(`RPC ${method} failed.`);
}

async function fetchLogsAdaptive(
  rpcUrls: readonly string[],
  address: Address,
  topics: [Hex, ...Hex[]],
  fromBlock: number,
  toBlock: number,
  fetcher: typeof fetch,
  retryDelayMs: number,
): Promise<RpcLog[]> {
  try {
    return await jsonRpcWithFailover<RpcLog[]>(
      rpcUrls,
      'eth_getLogs',
      [{ address, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), topics: [topics] }],
      fetcher,
      retryDelayMs,
    );
  } catch (error) {
    if (fromBlock < toBlock && !isTransientRpcError(error) && isRangeLimitRpcError(error)) {
      const mid = Math.floor((fromBlock + toBlock) / 2);
      const left = await fetchLogsAdaptive(rpcUrls, address, topics, fromBlock, mid, fetcher, retryDelayMs);
      const right = await fetchLogsAdaptive(rpcUrls, address, topics, mid + 1, toBlock, fetcher, retryDelayMs);
      return [...left, ...right];
    }
    throw error;
  }
}

async function checkArbitrumZroClaimedAmount(
  rpcUrls: readonly string[],
  claimContract: Address,
  wallet: Address,
  fetcher: typeof fetch,
  retryDelayMs: number,
): Promise<bigint> {
  const raw = await jsonRpcWithFailover<unknown>(
    rpcUrls,
    'eth_call',
    [{ to: claimContract, data: encodeLayerZeroZroClaimedData(wallet) }, 'latest'],
    fetcher,
    retryDelayMs,
  );
  if (typeof raw !== 'string' || !/^0x[\da-fA-F]{64}$/.test(raw)) {
    throw new Error('Unexpected Arbitrum eth_call zroClaimed response.');
  }
  return decodeLayerZeroZroClaimedResult(raw as Hex);
}

async function countDeliveredScanMessages(input: {
  scanBase: string;
  wallet: string;
  cutoffAt: string | null;
  cutoffMs: number | null;
  fetcher: typeof fetch;
}): Promise<number> {
  const seen = new Set<string>();
  let nextToken: string | undefined;

  for (let page = 0; page < 2; page++) {
    const walletUrl = new URL(`${input.scanBase}/messages/wallet/${input.wallet}`);
    walletUrl.searchParams.set('limit', '20');
    if (input.cutoffAt) walletUrl.searchParams.set('end', input.cutoffAt);
    if (nextToken) walletUrl.searchParams.set('nextToken', nextToken);

    const res = await input.fetcher(walletUrl.toString(), {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) break;

    const body = (await res.json()) as {
      data?: Array<{
        guid?: unknown;
        created?: unknown;
        status?: { name?: unknown };
        source?: { status?: unknown; tx?: { txHash?: unknown; blockTimestamp?: unknown } };
      }>;
      nextToken?: unknown;
      pagination?: { nextToken?: unknown };
    };
    if (!Array.isArray(body.data)) break;

    for (const msg of body.data) {
      if (msg.status?.name !== 'DELIVERED' && msg.source?.status !== 'SUCCEEDED') continue;
      if (input.cutoffMs !== null) {
        const ts =
          typeof msg.created === 'string'
            ? Date.parse(msg.created)
            : typeof msg.source?.tx?.blockTimestamp === 'number'
              ? msg.source.tx.blockTimestamp * 1000
              : NaN;
        if (!Number.isFinite(ts) || ts > input.cutoffMs) continue;
      }
      const key = String(msg.guid || msg.source?.tx?.txHash || seen.size);
      seen.add(key);
    }

    if (seen.size >= 5) return seen.size;
    const rawNext = body.nextToken ?? body.pagination?.nextToken;
    if (typeof rawNext !== 'string' || !rawNext) break;
    nextToken = rawNext;
  }

  return seen.size;
}

async function discoverScanFiveTxWallets(input: {
  scanBase: string;
  cutoffAt: string | null;
  skipWallets: ReadonlySet<string>;
  maxScanWallets: number;
  rpcUrls: readonly string[];
  claimContract: Address;
  fetcher: typeof fetch;
  retryDelayMs: number;
}): Promise<SyncEntry[]> {
  if (input.maxScanWallets <= 0) return [];

  const cutoffMs = input.cutoffAt ? Date.parse(input.cutoffAt) : null;
  const maxCandidates = Math.min(5_000, Math.max(input.maxScanWallets * 4, 40));
  const seenCandidates = new Set<string>();
  const discovered: SyncEntry[] = [];
  let fiveTxCount = 0;
  let nextToken: string | undefined;

  for (let page = 0; page < 8 && fiveTxCount < input.maxScanWallets && seenCandidates.size < maxCandidates; page++) {
    const latestUrl = new URL(`${input.scanBase}/messages/latest`);
    latestUrl.searchParams.set('limit', '100');
    if (input.cutoffAt) latestUrl.searchParams.set('end', input.cutoffAt);
    if (nextToken) latestUrl.searchParams.set('nextToken', nextToken);

    const latestRes = await input.fetcher(latestUrl.toString(), {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!latestRes.ok) break;

    const latestJson = (await latestRes.json()) as {
      data?: Array<{ source?: { tx?: { from?: unknown } } }>;
      nextToken?: unknown;
      pagination?: { nextToken?: unknown };
    };
    if (!Array.isArray(latestJson.data) || latestJson.data.length === 0) break;

    const pageCandidates: string[] = [];
    for (const item of latestJson.data) {
      const rawFrom = item?.source?.tx?.from;
      if (typeof rawFrom !== 'string' || !/^0x[\da-fA-F]{40}$/.test(rawFrom)) continue;
      const lower = rawFrom.toLowerCase();
      if (/^0x0{40}$/.test(lower) || input.skipWallets.has(lower) || seenCandidates.has(lower)) continue;
      seenCandidates.add(lower);
      pageCandidates.push(lower);
      if (seenCandidates.size >= maxCandidates) break;
    }

    for (const wallet of pageCandidates) {
      if (fiveTxCount >= input.maxScanWallets) break;
      try {
        const txCount = await countDeliveredScanMessages({
          scanBase: input.scanBase,
          wallet,
          cutoffAt: input.cutoffAt,
          cutoffMs,
          fetcher: input.fetcher,
        });
        if (txCount < 5) continue;

        // Cross-check Arbitrum zroClaimed(wallet) so a 5+ tx ZRO airdrop winner is never downgraded to lz_user_5tx.
        const claimed = await checkArbitrumZroClaimedAmount(
          input.rpcUrls,
          input.claimContract,
          wallet as Address,
          input.fetcher,
          input.retryDelayMs,
        );
        if (claimed > 0n) {
          discovered.push({ wallet, tier: 'lz_winner', txCount });
        } else {
          discovered.push({ wallet, tier: 'lz_user_5tx', txCount });
          fiveTxCount++;
        }
      } catch {
        /* Skip individual wallet verification errors during background Scan discovery */
      }
    }

    const rawNext = latestJson.nextToken ?? latestJson.pagination?.nextToken;
    if (typeof rawNext !== 'string' || !rawNext) break;
    nextToken = rawNext;
  }

  return discovered;
}

async function upsertSnapshotBatch(pool: Pool, batch: readonly SyncEntry[], importedAt: string): Promise<void> {
  if (batch.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO oneshot_airdrop_campaign(id,value) VALUES('airdrop',$1) ON CONFLICT DO NOTHING",
      [JSON.stringify(airdropCampaignSchema.parse({}))],
    );

    for (let i = 0; i < batch.length; i += 1000) {
      const chunk = batch.slice(i, i + 1000);
      await client.query(
        `INSERT INTO oneshot_airdrop_snapshot(wallet, tier, tx_count, imported_at)
         SELECT w, t, tc, $4::timestamptz
         FROM unnest($1::text[], $2::text[], $3::int[]) AS u(w, t, tc)
         ON CONFLICT(wallet) DO UPDATE SET
           tier = CASE
             WHEN oneshot_airdrop_snapshot.tier='lz_winner' OR EXCLUDED.tier='lz_winner' THEN 'lz_winner'
             ELSE 'lz_user_5tx'
           END,
           tx_count = CASE
             WHEN oneshot_airdrop_snapshot.tx_count IS NULL AND EXCLUDED.tx_count IS NULL THEN NULL
             ELSE GREATEST(COALESCE(oneshot_airdrop_snapshot.tx_count, 0), COALESCE(EXCLUDED.tx_count, 0))
           END,
           imported_at = EXCLUDED.imported_at`,
        [
          chunk.map(item => item.wallet),
          chunk.map(item => item.tier),
          chunk.map(item => item.txCount ?? null),
          importedAt,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function syncLayerZeroSnapshot(options: LayerZeroSyncOptions = {}): Promise<LayerZeroSyncResult> {
  const fromBlock = options.fromBlock ?? 223_920_000;
  const toBlock = options.toBlock ?? 223_940_000;
  const chunkSize = options.chunkSize ?? 2_000;
  const maxWallets = options.maxWallets ?? 50_000;
  const maxScanWallets = options.maxScanWallets ?? 50;
  const flushEvery = options.flushEvery ?? 2_000;
  const retryDelayMs = options.retryDelayMs ?? 400;
  const rpcUrls = resolveRpcUrls(options);
  const scanBase = resolveScanUrl(options);
  const claimContract = options.claimContract || LAYERZERO_ZRO_CLAIM_ARBITRUM_ADDRESS;
  const fetcher = options.fetcher || fetch;
  const cutoffAt = options.cutoffAt ?? null;
  const dryRun = Boolean(options.dryRun);

  if (!Number.isInteger(fromBlock) || fromBlock < 0 || !Number.isInteger(toBlock) || toBlock < fromBlock) {
    throw new Error('Invalid Arbitrum block range for LayerZero sync.');
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 50_000) {
    throw new Error('chunkSize must be an integer between 1 and 50,000.');
  }
  if (!Number.isSafeInteger(maxWallets) || maxWallets < 0) {
    throw new Error('maxWallets must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(maxScanWallets) || maxScanWallets < 0 || maxScanWallets > 5_000) {
    throw new Error('maxScanWallets must be an integer between 0 and 5,000.');
  }
  if (!Number.isSafeInteger(flushEvery) || flushEvery < 1) {
    throw new Error('flushEvery must be a positive integer.');
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new Error('retryDelayMs must be a non-negative number.');
  }
  if (cutoffAt !== null && (!cutoffAt.trim() || !Number.isFinite(Date.parse(cutoffAt)))) {
    throw new Error('Invalid --cutoff ISO timestamp.');
  }
  if (!dryRun && !options.pool) {
    throw new Error('DATABASE_URL is required unless --dry-run is specified.');
  }

  const importedAt = new Date((options.now || Date.now)()).toISOString();
  const claimTopics = encodeEventTopics({ abi: LAYERZERO_ZRO_CLAIM_ABI, eventName: 'Claim' });
  const remoteTopics = encodeEventTopics({ abi: LAYERZERO_ZRO_CLAIM_ABI, eventName: 'ClaimRemote' });
  const topicFilter = [claimTopics[0]!, remoteTopics[0]!] as [Hex, ...Hex[]];

  const seenWallets = new Set<string>();
  const pendingFlush: SyncEntry[] = [];
  const sampleWallets: string[] = [];
  let claimEvents = 0;
  let winnersFound = 0;
  let scanUsersFound = 0;

  for (let start = fromBlock; start <= toBlock && winnersFound < maxWallets; start += chunkSize) {
    const end = Math.min(toBlock, start + chunkSize - 1);
    const logs = await fetchLogsAdaptive(rpcUrls, claimContract, topicFilter, start, end, fetcher, retryDelayMs);
    claimEvents += logs.length;

    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: LAYERZERO_ZRO_CLAIM_ABI,
          data: log.data,
          topics: log.topics,
        });
        const claimer = (decoded.args as { claimer?: Address }).claimer;
        if (!claimer || /^0x0{40}$/.test(claimer)) continue;
        const wallet = claimer.toLowerCase();
        if (!seenWallets.has(wallet)) {
          seenWallets.add(wallet);
          winnersFound++;
          pendingFlush.push({ wallet, tier: 'lz_winner' });
          if (sampleWallets.length < 10) sampleWallets.push(wallet);
          if (winnersFound >= maxWallets) break;
        }
      } catch {
        /* Ignore unrelated log shapes */
      }
    }

    if (!dryRun && pendingFlush.length >= flushEvery) {
      await upsertSnapshotBatch(options.pool!, pendingFlush.splice(0, pendingFlush.length), importedAt);
    }
  }

  if (options.includeScan && maxScanWallets > 0) {
    const scanEntries = await discoverScanFiveTxWallets({
      scanBase,
      cutoffAt,
      skipWallets: seenWallets,
      maxScanWallets,
      rpcUrls,
      claimContract,
      fetcher,
      retryDelayMs,
    });
    for (const entry of scanEntries) {
      if (seenWallets.has(entry.wallet)) continue;
      seenWallets.add(entry.wallet);
      if (entry.tier === 'lz_winner') {
        winnersFound++;
      } else {
        scanUsersFound++;
      }
      pendingFlush.push(entry);
      if (sampleWallets.length < 10) sampleWallets.push(entry.wallet);
    }
  }

  const syncedWallets = seenWallets.size;
  if (dryRun || syncedWallets === 0) {
    return {
      dryRun,
      fromBlock,
      toBlock,
      claimEvents,
      winnersFound,
      scanUsersFound,
      syncedWallets,
      sampleWallets,
    };
  }

  const pool = options.pool!;
  if (pendingFlush.length > 0) {
    await upsertSnapshotBatch(pool, pendingFlush.splice(0, pendingFlush.length), importedAt);
  }

  const client = await pool.connect();
  try {
    const statsRow = (
      await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE tier='lz_winner')::int AS winners,
                count(*) FILTER (WHERE tier='lz_user_5tx')::int AS five_tx
         FROM oneshot_airdrop_snapshot`,
      )
    ).rows[0];

    await client.query('INSERT INTO oneshot_airdrop_audit(id, value) VALUES($1, $2)', [
      randomUUID(),
      JSON.stringify({
        at: importedAt,
        actor: options.actor || 'cli:sync-layerzero',
        action: 'sync_layerzero_snapshot',
        details: {
          fromBlock,
          toBlock,
          claimEvents,
          winnersFound,
          scanUsersFound,
          syncedWallets,
        },
      }),
    ]);

    return {
      dryRun: false,
      fromBlock,
      toBlock,
      claimEvents,
      winnersFound,
      scanUsersFound,
      syncedWallets,
      sampleWallets,
      snapshotTotal: Number(statsRow?.total || 0),
      snapshotWinners: Number(statsRow?.winners || 0),
      snapshotFiveTx: Number(statsRow?.five_tx || 0),
    };
  } finally {
    client.release();
  }
}
