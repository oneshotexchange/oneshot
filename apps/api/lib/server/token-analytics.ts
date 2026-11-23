import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import {
  createVerifiedRpc,
  networkConfig,
  nftExecutionNetwork,
  type IndexedTokenMarket,
  type TokenAnalytics,
  type TokenAnalyticsContext,
  type TokenAnalyticsFeedResponse,
  type TokenAnalyticsMarketListItem,
  type TokenAnalyticsSort,
  type TokenAnalyticsTrade,
  type TokenHolderBalance,
} from '@oneshot/evm';
import type { Address } from 'viem';
import { loadTokenManifestFile } from './indexed-tokens';
import { database } from './store';
import { tokenWalletRead } from './token-wallets';
import { ApiError } from './errors';
import { decodeFollowedWallets } from '../../../web/lib/wallet-following';
import { VerifiedTokenSource } from '../../../indexer/src/token-source';
import { parseTokenManifest, tokenManifestId, type TokenManifest } from '../../../indexer/src/token-manifest';
import { tokenCheckpoint } from '../../../indexer/src/token-store';
import { tokenMarketDto } from '../../../indexer/src/token-snapshot';
import { tokenMarketAnalytics } from '../../../indexer/src/token-event-projector';
import type { TokenMarketAnalytics } from '../../../indexer/src/token-event-types';
import { isAddress, isHash } from '../../../indexer/src/manifest';
import type { Block } from '../../../indexer/src/types';
import type { SqlPool, SqlClient } from '../../../indexer/src/store';

type Env = Record<string, string | undefined>;
type Source = {
  verify(manifest: TokenManifest, block?: Block): Promise<unknown>;
  verifyMarket(manifest: TokenManifest, market: Address, block: Block): Promise<IndexedTokenMarket>;
  height(): Promise<bigint>;
  block(number: bigint): Promise<Block>;
};
type Dependencies = {
  env: () => Env;
  pool: () => SqlPool | null;
  loadManifest: (env: Env) => Promise<TokenManifest>;
  source: (env: Env) => Promise<Source>;
};
type Kind = 'markets' | 'trades-feed' | 'detail' | 'holders' | 'pool-swap' | 'oneshot-trade' | 'all';
type ListCursor = {
  id: string;
  number: string;
  hash: string;
  kind: 'markets';
  sort: TokenAnalyticsSort;
  q: string;
  limit: number;
  after: string;
};
type FeedCursor = {
  id: string;
  number: string;
  hash: string;
  kind: 'trades-feed';
  tradeKind: 'pool-swap' | 'oneshot-trade' | 'all';
  wallet: string | null;
  walletsHash: string | null;
  limit: number;
  after: string;
};
type MarketCursor = {
  id: string;
  number: string;
  hash: string;
  market: string;
  kind: Exclude<Kind, 'markets' | 'trades-feed'>;
  limit: number;
  after: string;
};
type Cursor = ListCursor | FeedCursor | MarketCursor;

type Selection =
  | { kind: 'markets'; market: null; sort: TokenAnalyticsSort; q: string; limit: number; cursor: ListCursor | null }
  | {
      kind: 'trades-feed';
      market: null;
      tradeKind: 'pool-swap' | 'oneshot-trade' | 'all';
      wallet: Address | null;
      wallets: Address[] | null;
      walletsHash: string | null;
      limit: number;
      cursor: FeedCursor | null;
    }
  | { kind: Exclude<Kind, 'markets' | 'trades-feed'>; market: Address; limit: number; cursor: MarketCursor | null };

const hashWallets = (wallets: readonly string[]) => createHash('sha256').update(JSON.stringify(wallets)).digest('hex');

const SORTS: readonly TokenAnalyticsSort[] = ['newest', 'volume', 'trades', 'holders'];
const MAX_LIST_MARKETS = 1024;
const MAX_SEARCH_HYDRATIONS = 50;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (): never => { throw new ApiError(503, 'TOKEN_ANALYTICS_INVALID', 'Token activity is temporarily unavailable. Please try again shortly.'); };
const bad = (): never => { throw new ApiError(400, 'TOKEN_ANALYTICS_INPUT_INVALID', 'Check the market address or page selection and try again.'); };
const stale = (): never => { throw new ApiError(409, 'TOKEN_ANALYTICS_CURSOR_STALE', 'Token activity has changed. Refresh this page from the beginning.'); };
const moved = (): never => { throw new ApiError(409, 'TOKEN_CHAIN_MOVED', 'Token activity is being updated after a network change. Please refresh shortly.'); };
const decimal = (value: unknown, bits?: number): string =>
  typeof value === 'string' && /^(0|[1-9]\d{0,255})$/.test(value) && (!bits || BigInt(value) < 2n ** BigInt(bits)) ? value : invalid();
const signed = (value: unknown): string =>
  typeof value === 'string' && /^(0|-?[1-9]\d{0,38})$/.test(value) && BigInt(value) >= -(2n ** 127n) && BigInt(value) < 2n ** 127n
    ? value
    : invalid();
const addr = (value: unknown): string => (isAddress(value) && !/^0x0{40}$/i.test(value) ? value.toLowerCase() : invalid());
const hash = (value: unknown): string => (isHash(value) ? value.toLowerCase() : invalid());
const json = (value: unknown) => Response.json(value, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const defaults: Dependencies = {
  env: () => process.env,
  pool: database,
  loadManifest: env => loadTokenManifestFile(env.ONESHOT_TOKEN_INDEXER_MANIFEST_PATH!),
  source: async env => new VerifiedTokenSource(await createVerifiedRpc(networkConfig(env))),
};

function selection(request: NextRequest): Selection {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Token activity is read-only.');
  if (request.nextUrl.pathname.length > 1024 || request.nextUrl.search.length > 4096) return bad();
  const parts = request.nextUrl.pathname.replace(/\/$/, '').split('/');
  const query = request.nextUrl.searchParams;

  if (parts.length === 5 && parts.slice(0, 5).join('/') === '/api/oneshot/token-analytics/markets') {
    for (const key of query.keys()) {
      if (!['limit', 'sort', 'q', 'cursor'].includes(key) || query.getAll(key).length !== 1) return bad();
    }
    const limitText = query.get('limit') ?? '20';
    if (!/^[1-9]\d?$/.test(limitText) || Number(limitText) > 50) return bad();
    const limit = Number(limitText);
    const sortText = (query.get('sort') ?? 'newest') as TokenAnalyticsSort;
    if (!SORTS.includes(sortText)) return bad();
    const rawQuery = query.get('q') ?? '';
    if (rawQuery.length > 100 || /[\u0000-\u001f\u007f]/.test(rawQuery)) return bad();
    const q = rawQuery.trim();

    let cursor: ListCursor | null = null;
    const raw = query.get('cursor');
    if (raw !== null) {
      try {
        if (!raw || raw.length > 2048 || !/^[\w-]+$/.test(raw)) return bad();
        const bytes = Buffer.from(raw, 'base64url');
        if (bytes.toString('base64url') !== raw) return bad();
        const value: unknown = JSON.parse(bytes.toString('utf8'));
        if (
          !object(value) ||
          Object.keys(value).sort().join(',') !== 'after,hash,id,kind,limit,number,q,sort' ||
          typeof value.id !== 'string' ||
          !/^[a-f0-9]{64}$/.test(value.id) ||
          typeof value.number !== 'string' ||
          !/^(0|[1-9]\d{0,77})$/.test(value.number) ||
          !isHash(value.hash) ||
          value.kind !== 'markets' ||
          value.sort !== sortText ||
          value.q !== q ||
          value.limit !== limit ||
          typeof value.after !== 'string' ||
          !/^(0|[1-9]\d{0,3})$/.test(value.after) ||
          Number(value.after) > MAX_LIST_MARKETS
        ) {
          return bad();
        }
        cursor = value as ListCursor;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        return bad();
      }
    }
    return { kind: 'markets', market: null, sort: sortText, q, limit, cursor };
  }

  if (parts.length === 5 && parts.slice(0, 5).join('/') === '/api/oneshot/token-analytics/trades') {
    for (const key of query.keys()) {
      if (!['limit', 'kind', 'wallet', 'wallets', 'cursor'].includes(key) || query.getAll(key).length !== 1) return bad();
    }
    const limitText = query.get('limit') ?? '20';
    if (!/^[1-9]\d?$/.test(limitText) || Number(limitText) > 50) return bad();
    const limit = Number(limitText);
    const tradeKind = (query.get('kind') ?? 'oneshot-trade') as 'pool-swap' | 'oneshot-trade' | 'all';
    if (!['pool-swap', 'oneshot-trade', 'all'].includes(tradeKind)) return bad();
    const rawWallet = query.get('wallet');
    const rawWallets = query.get('wallets');
    if (rawWallet !== null && rawWallets !== null) return bad();
    let wallet: Address | null = null;
    if (rawWallet !== null) {
      const normalized = rawWallet.toLowerCase();
      if (!isAddress(normalized) || /^0x0{40}$/i.test(normalized)) return bad();
      wallet = normalized as Address;
    }
    let wallets: Address[] | null = null;
    if (rawWallets !== null) {
      try {
        wallets = decodeFollowedWallets(rawWallets) as Address[];
      } catch {
        return bad();
      }
    }
    if ((wallet !== null || wallets !== null) && tradeKind !== 'oneshot-trade') return bad();
    const walletsHash = wallets ? hashWallets(wallets) : null;

    let cursor: FeedCursor | null = null;
    const raw = query.get('cursor');
    if (raw !== null) {
      try {
        if (!raw || raw.length > 2048 || !/^[\w-]+$/.test(raw)) return bad();
        const bytes = Buffer.from(raw, 'base64url');
        if (bytes.toString('base64url') !== raw) return bad();
        const value: unknown = JSON.parse(bytes.toString('utf8'));
        if (
          !object(value) ||
          Object.keys(value).sort().join(',') !== 'after,hash,id,kind,limit,number,tradeKind,wallet,walletsHash' ||
          typeof value.id !== 'string' ||
          !/^[a-f0-9]{64}$/.test(value.id) ||
          typeof value.number !== 'string' ||
          !/^(0|[1-9]\d{0,77})$/.test(value.number) ||
          !isHash(value.hash) ||
          value.kind !== 'trades-feed' ||
          value.tradeKind !== tradeKind ||
          value.wallet !== wallet ||
          value.walletsHash !== walletsHash ||
          value.limit !== limit ||
          typeof value.after !== 'string' ||
          !/^(0|[1-9]\d{0,77}):(0|[1-9]\d{0,9})$/.test(value.after)
        ) {
          return bad();
        }
        if (BigInt(value.after.split(':')[0]) > BigInt(value.number) || BigInt(value.after.split(':')[1]) > 2147483647n) {
          return bad();
        }
        cursor = value as FeedCursor;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        return bad();
      }
    }
    return { kind: 'trades-feed', market: null, tradeKind, wallet, wallets, walletsHash, limit, cursor };
  }

  const market = parts[5]?.toLowerCase();
  const operation = parts[6];
  if (
    parts.slice(0, 5).join('/') !== '/api/oneshot/token-analytics/markets' ||
    !isAddress(market) ||
    (parts.length !== 6 && parts.length !== 7) ||
    (operation && !['trades', 'holders'].includes(operation))
  ) {
    throw new ApiError(404, 'NOT_FOUND', 'Token activity not found.');
  }
  for (const key of query.keys()) {
    if (!operation || !['limit', 'cursor', ...(operation === 'trades' ? ['kind'] : [])].includes(key) || query.getAll(key).length !== 1) return bad();
  }
  const limitText = query.get('limit') ?? '20';
  if (!/^[1-9]\d?$/.test(limitText) || Number(limitText) > 50) return bad();
  const limit = Number(limitText);
  const kind = (!operation ? 'detail' : operation === 'holders' ? 'holders' : (query.get('kind') ?? 'pool-swap')) as Exclude<Kind, 'markets' | 'trades-feed'>;
  if (operation === 'trades' && !['pool-swap', 'oneshot-trade', 'all'].includes(kind)) return bad();
  let cursor: MarketCursor | null = null;
  const raw = query.get('cursor');
  if (raw !== null) {
    try {
      if (!raw || raw.length > 2048 || !/^[\w-]+$/.test(raw)) return bad();
      const bytes = Buffer.from(raw, 'base64url');
      if (bytes.toString('base64url') !== raw) return bad();
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (
        !object(value) ||
        Object.keys(value).sort().join(',') !== 'after,hash,id,kind,limit,market,number' ||
        typeof value.id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.id) ||
        typeof value.number !== 'string' ||
        !/^(0|[1-9]\d{0,77})$/.test(value.number) ||
        !isHash(value.hash) ||
        value.market !== market ||
        value.kind !== kind ||
        value.limit !== limit ||
        typeof value.after !== 'string' ||
        (kind === 'holders' ? !/^0x[\da-f]{40}$/.test(value.after) : !/^(0|[1-9]\d{0,77}):(0|[1-9]\d{0,9})$/.test(value.after))
      ) {
        return bad();
      }
      if (kind !== 'holders' && (BigInt(value.after.split(':')[0]) > BigInt(value.number) || BigInt(value.after.split(':')[1]) > 2147483647n)) {
        return bad();
      }
      cursor = value as MarketCursor;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      return bad();
    }
  }
  return { market: market as Address, kind, limit, cursor };
}

const unavailable = (enabled: boolean): TokenAnalyticsContext => ({
  schemaVersion: 1,
  kind: 'canonical-event-journal',
  enabled,
  available: false,
  reason: enabled
    ? 'Token activity is being updated. Please try again shortly.'
    : 'Token activity is currently unavailable. You can explore token markets and return later.',
  deploymentId: null,
  network: null,
  source: null,
  checkpoint: null,
  observedHeadNumber: null,
  lagBlocks: null,
  readonly: true,
  finalized: false,
});

function empty(select: Selection, context: TokenAnalyticsContext) {
  if (select.kind === 'markets') return { context, sort: select.sort, items: [], nextCursor: null };
  if (select.kind === 'trades-feed') return { context, kind: select.tradeKind, wallet: select.wallet, items: [], nextCursor: null };
  return select.kind === 'detail'
    ? { context, market: null, analytics: null }
    : select.kind === 'holders'
      ? { context, market: select.market, token: null, scope: 'all-nonzero-balance-addresses', items: [], nextCursor: null }
      : { context, market: select.market, kind: select.kind, items: [], nextCursor: null };
}

function analyticsDto(analytics: TokenMarketAnalytics): TokenAnalytics {
  const sqrt = BigInt(analytics.sqrtPriceX96Raw!);
  return {
    market: analytics.market,
    token: analytics.token,
    creator: analytics.creator,
    poolId: analytics.poolId,
    tokenDecimals: 8,
    observedSupplyRaw: analytics.observedSupplyRaw,
    mintedRaw: analytics.mintedRaw,
    burnedRaw: analytics.burnedRaw,
    holderCount: analytics.holderCount,
    holderScope: 'all-nonzero-balance-addresses',
    poolSwaps: analytics.poolSwaps,
    poolNativeVolumeRaw: analytics.poolNativeVolumeRaw,
    poolTokenVolumeRaw: analytics.poolTokenVolumeRaw,
    oneshotTrades: analytics.oneshotTrades,
    oneshotBuys: analytics.oneshotBuys,
    oneshotSells: analytics.oneshotSells,
    oneshotGrossNativeVolumeRaw: analytics.oneshotGrossNativeVolumeRaw,
    oneshotExecutionFeesRaw: analytics.oneshotExecutionFeesRaw,
    price: {
      sqrtPriceX96Raw: analytics.sqrtPriceX96Raw!,
      tick: analytics.tick!,
      nativeRawPerWholeToken: { numerator: ((1n << 192n) * 100000000n).toString(), denominator: (sqrt * sqrt).toString() },
      blockNumber: analytics.priceBlockNumber!,
      blockHash: analytics.priceBlockHash!,
    },
  };
}

function compareDecimalDesc(left: string, right: string): number {
  const a = BigInt(left), b = BigInt(right);
  return a === b ? 0 : b > a ? 1 : -1;
}

function sortMarketAnalytics(items: TokenMarketAnalytics[], sort: TokenAnalyticsSort): TokenMarketAnalytics[] {
  return [...items].sort((left, right) => {
    let cmp = 0;
    if (sort === 'volume') {
      cmp = compareDecimalDesc(left.poolNativeVolumeRaw, right.poolNativeVolumeRaw) ||
        compareDecimalDesc(left.createdBlockNumber, right.createdBlockNumber);
    } else if (sort === 'trades') {
      cmp = compareDecimalDesc(left.oneshotTrades, right.oneshotTrades) ||
        compareDecimalDesc(left.poolSwaps, right.poolSwaps);
    } else if (sort === 'holders') {
      cmp = compareDecimalDesc(left.holderCount, right.holderCount) ||
        compareDecimalDesc(left.poolNativeVolumeRaw, right.poolNativeVolumeRaw);
    } else {
      cmp = compareDecimalDesc(left.createdBlockNumber, right.createdBlockNumber) ||
        (right.createdLogIndex - left.createdLogIndex);
    }
    return cmp || left.market.localeCompare(right.market);
  });
}

function proofMatchesAnalytics(proof: IndexedTokenMarket, analytics: TokenMarketAnalytics): boolean {
  for (const key of [
    'market',
    'token',
    'creator',
    'poolId',
    'executionFeeBps',
    'liquidityAndBurn',
    'tokenDecimals',
    'initialSupplyRaw',
    'observedMarketCodeHash',
    'observedTokenCodeHash',
  ] as const) {
    if (analytics[key] !== proof[key]) return false;
  }
  return proof.totalSupplyRaw === analytics.observedSupplyRaw;
}

function tradeDto(row: Record<string, unknown>, market: Address, token: Address, poolId: string, checkpoint: Block): TokenAnalyticsTrade {
  if (!object(row.value)) return invalid();
  const value = row.value;
  const number = decimal(value.blockNumber, 256), logIndex = value.logIndex, transactionIndex = value.transactionIndex;
  if (
    value.schemaVersion !== 1 ||
    value.market !== market ||
    BigInt(number) > checkpoint.number ||
    hash(value.blockHash) !== row.block_hash ||
    decimal(value.timestamp, 256) !== row.block_timestamp ||
    row.block_number !== number ||
    !Number.isSafeInteger(logIndex) ||
    Number(logIndex) < 0 ||
    Number(logIndex) > 2147483647 ||
    !Number.isSafeInteger(transactionIndex) ||
    Number(transactionIndex) < 0
  ) {
    return invalid();
  }
  const transactionHash = hash(value.transactionHash), id = `${transactionHash}:${logIndex}`;
  if (row.entity_id !== id) return invalid();
  const base = { id, market, blockNumber: number, blockHash: hash(value.blockHash), timestamp: decimal(value.timestamp, 256), transactionHash, transactionIndex: Number(transactionIndex), logIndex: Number(logIndex) };
  if (value.kind === 'pool-swap') {
    if (value.poolId !== poolId || value.trader !== null || value.recipient !== null || !Number.isInteger(value.tick) || Number(value.tick) < -887272 || Number(value.tick) > 887272 || !Number.isInteger(value.feePips) || Number(value.feePips) < 0 || Number(value.feePips) > 1000000) return invalid();
    const sqrtPriceX96Raw = decimal(value.sqrtPriceX96Raw, 160);
    if (sqrtPriceX96Raw === '0') return invalid();
    return { ...base, kind: 'pool-swap', poolId, poolSender: addr(value.poolSender), trader: null, recipient: null, amount0Raw: signed(value.amount0Raw), amount1Raw: signed(value.amount1Raw), sqrtPriceX96Raw, liquidityRaw: decimal(value.liquidityRaw, 128), tick: Number(value.tick), feePips: Number(value.feePips) };
  }
  if (value.kind !== 'oneshot-trade' || value.token !== token || typeof value.buy !== 'boolean') return invalid();
  const tokensRaw = decimal(value.tokensRaw, 256), grossNativeRaw = decimal(value.grossNativeRaw, 256), netNativeRaw = decimal(value.netNativeRaw, 256), executionFeeRaw = decimal(value.executionFeeRaw, 256);
  if (tokensRaw === '0' || grossNativeRaw === '0' || netNativeRaw === '0' || BigInt(netNativeRaw) + BigInt(executionFeeRaw) !== BigInt(grossNativeRaw)) return invalid();
  return { ...base, kind: 'oneshot-trade', token, trader: addr(value.trader), recipient: addr(value.recipient), buy: value.buy, tokensRaw, grossNativeRaw, netNativeRaw, executionFeeRaw };
}

export function createTokenAnalyticsReader(overrides: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  return async (request: NextRequest): Promise<Response> => {
    const select = selection(request), env = { ...deps.env() }, flag = env.ONESHOT_TOKEN_ANALYTICS_READS_ENABLED;
    if (flag === undefined || flag === '' || flag === 'false') return json(empty(select, unavailable(false)));
    if (flag !== 'true' || !['local', 'base-sepolia'].includes(env.ONESHOT_NETWORK ?? '') || !env.DATABASE_URL || !env.ONESHOT_TOKEN_INDEXER_MANIFEST_PATH) return invalid();
    let client: SqlClient | undefined, began = false;
    try {
      const manifest = await deps.loadManifest(env), id = tokenManifestId(manifest);
      if (manifest.mode !== env.ONESHOT_NETWORK) return invalid();
      const source = await deps.source(env), pool = deps.pool();
      if (!pool) return invalid();
      client = await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      began = true;
      await client.query("SET LOCAL statement_timeout='5000ms'");
      await client.query("SET LOCAL lock_timeout='2000ms'");
      const deployment = (await client.query('SELECT manifest FROM oneshot_evm_token_event_deployments WHERE manifest_id=$1', [id])).rows[0];
      const head = (await client.query('SELECT block_number::text,block_hash,parent_hash,block_timestamp::text FROM oneshot_evm_token_event_journal WHERE manifest_id=$1 ORDER BY oneshot_evm_token_event_journal.block_number DESC LIMIT 1', [id])).rows[0];
      if (!deployment || !head) {
        if (select.cursor) return stale();
        await client.query('COMMIT');
        began = false;
        return json(empty(select, unavailable(true)));
      }
      if (tokenManifestId(parseTokenManifest(deployment.manifest)) !== id) return invalid();
      const block = tokenCheckpoint(head);
      if (block.number < manifest.startBlock) return invalid();
      if (select.cursor && (select.cursor.id !== id || select.cursor.number !== block.number.toString() || select.cursor.hash !== block.hash)) return stale();

      const buildContext = (height: bigint): TokenAnalyticsContext => ({
        schemaVersion: 1,
        kind: 'canonical-event-journal',
        enabled: true,
        available: true,
        reason: null,
        deploymentId: id,
        network: nftExecutionNetwork(manifest),
        source: {
          chainId: manifest.chainId,
          genesisHash: manifest.genesisHash,
          factory: { ...manifest.factory },
          poolManager: { ...manifest.poolManager },
          oracle: { ...manifest.oracle },
          quoter: { ...manifest.quoter },
        },
        checkpoint: { number: block.number.toString(), hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp.toString() },
        observedHeadNumber: height.toString(),
        lagBlocks: (height - block.number).toString(),
        readonly: true,
        finalized: false,
      });

      if (select.kind === 'markets') {
        const rows = (await client.query(
          "SELECT entity_id,value FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 AND kind='markets' LIMIT $2",
          [id, MAX_LIST_MARKETS],
        )).rows;
        const parsed = rows.map(row => {
          if (typeof row.entity_id !== 'string' || !object(row.value)) return invalid();
          const item = tokenMarketAnalytics(row.value, manifest, row.entity_id);
          if (BigInt(item.lastBlockNumber) > block.number || BigInt(item.createdBlockNumber) < manifest.startBlock) return invalid();
          return item;
        });
        const ready = sortMarketAnalytics(
          parsed.filter(item => item.initialized && item.initialMintSeen && item.sqrtPriceX96Raw !== null && item.tick !== null),
          select.sort,
        );
        const offset = select.cursor ? Number(select.cursor.after) : 0;
        const exactAddress = /^0x[\da-f]{40}$/i.test(select.q) ? select.q.toLowerCase() : null;
        const needle = select.q.toLowerCase();
        const filtered = exactAddress
          ? ready.filter(item => item.market === exactAddress || item.token === exactAddress || item.creator === exactAddress)
          : ready;

        const hydrated: TokenAnalyticsMarketListItem[] = [];
        let consumed = 0;
        let hasMore = false;
        if (!needle || exactAddress) {
          const slice = filtered.slice(offset, offset + select.limit + 1);
          hasMore = slice.length > select.limit;
          for (const item of slice.slice(0, select.limit)) {
            const proof = tokenMarketDto(await source.verifyMarket(manifest, item.market, block));
            if (!proofMatchesAnalytics(proof, item)) return invalid();
            hydrated.push({ market: proof, analytics: analyticsDto(item) });
          }
        } else {
          let inspections = 0;
          for (const item of filtered) {
            if (inspections >= MAX_SEARCH_HYDRATIONS) break;
            inspections += 1;
            const proof = tokenMarketDto(await source.verifyMarket(manifest, item.market, block));
            if (!proofMatchesAnalytics(proof, item)) return invalid();
            const match = [proof.market, proof.token, proof.creator, proof.name, proof.symbol].some(field =>
              field.toLowerCase().includes(needle),
            );
            if (!match) continue;
            if (consumed < offset) {
              consumed += 1;
              continue;
            }
            if (hydrated.length >= select.limit) {
              hasMore = true;
              break;
            }
            hydrated.push({ market: proof, analytics: analyticsDto(item) });
          }
        }

        const height = await source.height();
        if (height < block.number) return moved();
        const canonical = await source.block(block.number);
        if (canonical.hash !== block.hash || canonical.parentHash !== block.parentHash || canonical.timestamp !== block.timestamp) return moved();
        await client.query('COMMIT');
        began = false;
        const nextCursor = hasMore
          ? Buffer.from(
              JSON.stringify({
                id,
                number: block.number.toString(),
                hash: block.hash,
                kind: 'markets',
                sort: select.sort,
                q: select.q,
                limit: select.limit,
                after: String(offset + select.limit),
              }),
            ).toString('base64url')
          : null;
        return json({ context: buildContext(height), sort: select.sort, items: hydrated, nextCursor });
      }

      if (select.kind === 'trades-feed') {
        const after = select.cursor?.after.split(':');
        const actors: readonly string[] | null = select.wallet ? [select.wallet] : select.wallets;
        const kinds = select.tradeKind === 'all' ? ['pool-swap', 'oneshot-trade'] : [select.tradeKind];
        const params: unknown[] = [id, kinds, after?.[0] ?? null, after?.[1] ?? null];
        const actorFilter = actors
          ? (() => {
              params.push(actors);
              return `AND (p.value->>'trader'=ANY($${params.length}::text[]) OR p.value->>'recipient'=ANY($${params.length}::text[]))`;
            })()
          : '';
        params.push(select.limit + 1);
        const rows = (
          await client.query(
            `SELECT p.entity_id,p.value,j.block_number::text,j.block_hash,j.block_timestamp::text,m.value AS market_value FROM oneshot_evm_token_event_projections p LEFT JOIN oneshot_evm_token_event_journal j ON j.manifest_id=p.manifest_id AND j.block_number=(p.value->>'blockNumber')::numeric LEFT JOIN oneshot_evm_token_event_projections m ON m.manifest_id=p.manifest_id AND m.kind='markets' AND m.entity_id=p.value->>'market' WHERE p.manifest_id=$1 AND p.kind='events' AND p.value->>'kind'=ANY($2::text[]) ${actorFilter} AND ($3::numeric IS NULL OR ((p.value->>'blockNumber')::numeric,(p.value->>'logIndex')::integer)<($3::numeric,$4::integer)) ORDER BY (p.value->>'blockNumber')::numeric DESC,(p.value->>'logIndex')::integer DESC LIMIT $${params.length}`,
            params,
          )
        ).rows;
        const items = rows.map(row => {
          if (!object(row.value) || !object(row.market_value)) return invalid();
          const market = addr(row.value.market) as Address;
          const marketAnalytics = tokenMarketAnalytics(row.market_value, manifest, market);
          const value = tradeDto(row, market, marketAnalytics.token, marketAnalytics.poolId, block);
          if (row.value.chainId !== manifest.chainId || row.value.source !== (value.kind === 'pool-swap' ? manifest.poolManager.address : market)) {
            return invalid();
          }
          if (
            value.kind === 'oneshot-trade' &&
            BigInt(value.executionFeeRaw) !== (BigInt(value.grossNativeRaw) * BigInt(marketAnalytics.executionFeeBps)) / 10000n
          ) {
            return invalid();
          }
          if (actors && (value.kind !== 'oneshot-trade' || (!actors.includes(value.trader) && !actors.includes(value.recipient)))) {
            return invalid();
          }
          return value;
        });
        if (
          items.some(
            (value, index) =>
              index > 0 &&
              (BigInt(value.blockNumber) > BigInt(items[index - 1].blockNumber) ||
                (value.blockNumber === items[index - 1].blockNumber && value.logIndex >= items[index - 1].logIndex)),
          )
        ) {
          return invalid();
        }
        const height = await source.height();
        if (height < block.number) return moved();
        const canonical = await source.block(block.number);
        if (canonical.hash !== block.hash || canonical.parentHash !== block.parentHash || canonical.timestamp !== block.timestamp) {
          return moved();
        }
        await client.query('COMMIT');
        began = false;
        const last = items[select.limit - 1];
        const nextCursor =
          items.length > select.limit
            ? Buffer.from(
                JSON.stringify({
                  id,
                  number: block.number.toString(),
                  hash: block.hash,
                  kind: 'trades-feed',
                  tradeKind: select.tradeKind,
                  wallet: select.wallet,
                  walletsHash: select.walletsHash,
                  limit: select.limit,
                  after: `${last.blockNumber}:${last.logIndex}`,
                } satisfies FeedCursor),
              ).toString('base64url')
            : null;
        const body: TokenAnalyticsFeedResponse = {
          context: buildContext(height),
          kind: select.tradeKind,
          wallet: select.wallet,
          items: items.slice(0, select.limit),
          nextCursor,
        };
        return json(body);
      }

      const stored = (await client.query("SELECT value FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 AND kind='markets' AND entity_id=$2", [id, select.market])).rows[0];
      if (!stored) {
        try {
          await source.verifyMarket(manifest, select.market, block);
        } catch (error) {
          if (object(error) && error.code === 'TOKEN_MARKET_UNREGISTERED') {
            throw new ApiError(404, 'TOKEN_MARKET_NOT_FOUND', 'This token market is not present at the activity checkpoint.');
          }
          throw error;
        }
        return invalid();
      }
      if (!object(stored.value)) return invalid();
      const analytics = tokenMarketAnalytics(stored.value, manifest, select.market), proof = tokenMarketDto(await source.verifyMarket(manifest, select.market, block));
      if (!proofMatchesAnalytics(proof, analytics)) return invalid();
      if (!analytics.initialized || !analytics.initialMintSeen || BigInt(analytics.lastBlockNumber) > block.number || BigInt(analytics.createdBlockNumber) < manifest.startBlock) return invalid();
      const positions = [{ number: analytics.createdBlockNumber, hash: analytics.createdBlockHash }, { number: analytics.lastBlockNumber, hash: analytics.lastBlockHash }, { number: analytics.priceBlockNumber!, hash: analytics.priceBlockHash! }];
      const journal = (await client.query('SELECT block_number::text,block_hash FROM oneshot_evm_token_event_journal WHERE manifest_id=$1 AND block_number=ANY($2::numeric[])', [id, positions.map(position => position.number)])).rows;
      if (positions.some(position => !journal.some(row => row.block_number === position.number && row.block_hash === position.hash))) return invalid();
      const priceEvent = (await client.query("SELECT value FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 AND kind='events' AND value->>'market'=$2 AND value->>'kind' IN('pool-initialized','pool-swap') ORDER BY (value->>'blockNumber')::numeric DESC,(value->>'logIndex')::integer DESC LIMIT 1", [id, select.market])).rows[0]?.value;
      if (!object(priceEvent) || priceEvent.blockNumber !== analytics.priceBlockNumber || priceEvent.blockHash !== analytics.priceBlockHash || priceEvent.sqrtPriceX96Raw !== analytics.sqrtPriceX96Raw || priceEvent.tick !== analytics.tick || priceEvent.poolId !== analytics.poolId || priceEvent.source !== manifest.poolManager.address || priceEvent.chainId !== manifest.chainId) return invalid();
      const height = await source.height();
      if (height < block.number) return moved();
      const context = buildContext(height);
      const makeCursor = (after: string) => Buffer.from(JSON.stringify({ id, number: block.number.toString(), hash: block.hash, market: select.market, kind: select.kind, limit: select.limit, after })).toString('base64url');
      let result: unknown;
      if (select.kind === 'detail') {
        result = { context, market: proof, analytics: analyticsDto(analytics) };
      } else if (select.kind === 'holders') {
        const total = (await client.query("SELECT count(*) FILTER(WHERE (value->>'balanceRaw')::numeric>0)::text AS holders,COALESCE(sum((value->>'balanceRaw')::numeric),0)::text AS supply FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 AND kind='balances' AND value->>'token'=$2", [id, analytics.token])).rows[0];
        if (!total || decimal(total.holders) !== analytics.holderCount || decimal(total.supply) !== analytics.observedSupplyRaw) return invalid();
        const rows = (await client.query("SELECT p.entity_id,p.value,j.block_number::text,j.block_hash FROM oneshot_evm_token_event_projections p LEFT JOIN oneshot_evm_token_event_journal j ON j.manifest_id=p.manifest_id AND j.block_number=(p.value->>'lastBlockNumber')::numeric WHERE p.manifest_id=$1 AND p.kind='balances' AND p.value->>'token'=$2 AND (p.value->>'balanceRaw')::numeric>0 AND ($3::text IS NULL OR p.value->>'wallet'>$3) ORDER BY p.value->>'wallet' LIMIT $4", [id, analytics.token, select.cursor?.after ?? null, select.limit + 1])).rows;
        const items = rows.map((row): TokenHolderBalance => {
          if (!object(row.value)) return invalid();
          const value = row.value, wallet = addr(value.wallet), balanceRaw = decimal(value.balanceRaw, 256), lastBlockNumber = decimal(value.lastBlockNumber, 256), lastBlockHash = hash(value.lastBlockHash);
          if (value.schemaVersion !== 1 || value.token !== analytics.token || row.entity_id !== `${analytics.token}:${wallet}` || balanceRaw === '0' || BigInt(balanceRaw) > BigInt(analytics.observedSupplyRaw) || BigInt(lastBlockNumber) > block.number || row.block_number !== lastBlockNumber || row.block_hash !== lastBlockHash) return invalid();
          return { wallet, balanceRaw, lastBlockNumber, lastBlockHash };
        });
        if (items.some((value, index) => index > 0 && value.wallet <= items[index - 1].wallet)) return invalid();
        result = { context, market: select.market, token: analytics.token, scope: 'all-nonzero-balance-addresses', items: items.slice(0, select.limit), nextCursor: items.length > select.limit ? makeCursor(items[select.limit - 1].wallet) : null };
      } else {
        const after = select.cursor?.after.split(':');
        const rows = (await client.query("SELECT p.entity_id,p.value,j.block_number::text,j.block_hash,j.block_timestamp::text FROM oneshot_evm_token_event_projections p LEFT JOIN oneshot_evm_token_event_journal j ON j.manifest_id=p.manifest_id AND j.block_number=(p.value->>'blockNumber')::numeric WHERE p.manifest_id=$1 AND p.kind='events' AND p.value->>'market'=$2 AND p.value->>'kind'=ANY($3::text[]) AND ($4::numeric IS NULL OR ((p.value->>'blockNumber')::numeric,(p.value->>'logIndex')::integer)<($4::numeric,$5::integer)) ORDER BY (p.value->>'blockNumber')::numeric DESC,(p.value->>'logIndex')::integer DESC LIMIT $6", [id, select.market, select.kind === 'all' ? ['pool-swap', 'oneshot-trade'] : [select.kind], after?.[0] ?? null, after?.[1] ?? null, select.limit + 1])).rows;
        const items = rows.map(row => {
          const value = tradeDto(row, select.market, analytics.token, analytics.poolId, block);
          if (!object(row.value) || row.value.chainId !== manifest.chainId || row.value.source !== (value.kind === 'pool-swap' ? manifest.poolManager.address : select.market)) return invalid();
          if (value.kind === 'oneshot-trade' && BigInt(value.executionFeeRaw) !== (BigInt(value.grossNativeRaw) * BigInt(analytics.executionFeeBps)) / 10000n) return invalid();
          return value;
        });
        if (items.some((value, index) => index > 0 && (BigInt(value.blockNumber) > BigInt(items[index - 1].blockNumber) || (value.blockNumber === items[index - 1].blockNumber && value.logIndex >= items[index - 1].logIndex)))) return invalid();
        const last = items[select.limit - 1];
        result = { context, market: select.market, kind: select.kind, items: items.slice(0, select.limit), nextCursor: items.length > select.limit ? makeCursor(`${last.blockNumber}:${last.logIndex}`) : null };
      }
      const canonical = await source.block(block.number);
      if (canonical.hash !== block.hash || canonical.parentHash !== block.parentHash || canonical.timestamp !== block.timestamp) return moved();
      await client.query('COMMIT');
      began = false;
      return json(result);
    } catch (error) {
      if (began) await client?.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ApiError) throw error;
      if (object(error) && error.code === 'TOKEN_CHAIN_MOVED') return moved();
      throw new ApiError(503, 'TOKEN_ANALYTICS_UNAVAILABLE', 'Token activity is temporarily unavailable. Please try again shortly.');
    } finally {
      client?.release();
    }
  };
}
const tokenMarketAnalyticsRead = createTokenAnalyticsReader();
export const tokenAnalyticsRead = (request: NextRequest) =>
  request.nextUrl.pathname.startsWith('/api/oneshot/token-analytics/wallets/')
    ? tokenWalletRead(request)
    : tokenMarketAnalyticsRead(request);
