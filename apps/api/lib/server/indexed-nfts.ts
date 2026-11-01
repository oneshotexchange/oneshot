import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { NextRequest } from 'next/server';
import { createVerifiedRpc, networkConfig, type IndexedNftContext, type IndexedCollection, type IndexedListing, type IndexedNftItem, type IndexedActivity, type IndexedClaim, type IndexedNftPresentation } from '@oneshot/evm';
import { manifestId, parseManifest, isAddress, isHash } from '../../../indexer/src/manifest';
import { VerifiedRpcSource } from '../../../indexer/src/rpc-source';
import type { ChainSource, Manifest } from '../../../indexer/src/types';
import type { SqlClient, SqlPool } from '../../../indexer/src/store';
import { database } from './store';
import { ApiError } from './errors';
import { createNftPublicContentResolver } from './nft-public-content';

type Env = Record<string, string | undefined>;
type ContentResolver = (contentHash: string, tokenId: string) => Promise<IndexedNftPresentation | null>;
export type IndexedReaderDependencies = {
  env: () => Env;
  pool: () => SqlPool | null;
  loadManifest: (env: Env) => Promise<Manifest>;
  source: (env: Env) => Promise<ChainSource>;
  /** A new cache belongs to each indexed request, never to a collection address across checkpoints. */
  contentResolver: (client: SqlClient) => ContentResolver;
};
type Resource = 'status' | 'collections' | 'collection' | 'items' | 'item' | 'listings' | 'activity' | 'wallet-items' | 'claims';
type Selection = { resource: Resource; collection?: string; wallet?: string; tokenId?: string; seller?: string; status?: string; limit: number; cursor?: string; scope: string };
type Cursor = { v: 1; manifest: string; block: string; hash: string; scope: string; limit: number; after: string[] };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const json = (body: unknown) => Response.json(body, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const badInput = (): never => { throw new ApiError(400, 'INDEXED_INPUT_INVALID', 'Use a valid indexed NFT address, page size and cursor.'); };
const invalidData = (): never => { throw new ApiError(503, 'INDEXER_DATA_INVALID', 'Indexed NFT data is unavailable. Refresh after the indexer has synchronized.'); };
const numberText = (value: unknown, maximum = 256): string => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || value.length > maximum) return invalidData();
  return value;
};
const text = (value: unknown): string => typeof value === 'string' ? value : invalidData();
const address = (value: unknown): string => isAddress(value) ? value.toLowerCase() : invalidData();
const hash = (value: unknown): string => isHash(value) ? value.toLowerCase() : invalidData();
const optionalAddress = (value: unknown) => value == null ? null : address(value);
const optionalAmount = (value: unknown) => value == null ? null : numberText(value);
const optionalHash = (value: unknown) => value == null ? null : hash(value);
const boolean = (value: unknown) => typeof value === 'boolean' ? value : invalidData();
function valueRecord(value: unknown) { return object(value) ? value : invalidData(); }

function selection(request: NextRequest): Selection {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Indexed NFTs are read-only.');
  const prefix = '/api/oneshot/indexed';
  const path = request.nextUrl.pathname.replace(/\/$/, '');
  if (!path.startsWith(`${prefix}/`) || path.length > 1024 || request.nextUrl.search.length > 4096) throw new ApiError(404, 'NOT_FOUND', 'Indexed resource not found.');
  let parts: string[];
  try { parts = path.slice(prefix.length + 1).split('/').map(decodeURIComponent); } catch { return badInput(); }
  const [kind, id, child, serial] = parts;
  let resource: Resource;
  let collection: string | undefined, wallet: string | undefined, tokenId: string | undefined;
  const inputAddress = (input: string) => isAddress(input) ? input.toLowerCase() : badInput();
  if (parts.length === 1 && kind === 'status') resource = 'status';
  else if (parts.length === 1 && ['collections', 'listings', 'activity'].includes(kind)) resource = kind as Resource;
  else if (kind === 'collections' && parts.length >= 2 && parts.length <= 4) {
    collection = inputAddress(id);
    if (parts.length === 2) resource = 'collection';
    else if (child === 'items' && parts.length === 3) resource = 'items';
    else if (child === 'items' && parts.length === 4 && /^[1-9]\d{0,77}$/.test(serial) && BigInt(serial) < (1n << 256n)) { resource = 'item'; tokenId = serial; }
    else return badInput();
  } else if (kind === 'wallets' && parts.length === 3 && ['items', 'claims'].includes(child)) {
    wallet = inputAddress(id); resource = child === 'items' ? 'wallet-items' : 'claims';
  } else throw new ApiError(404, 'NOT_FOUND', 'Indexed resource not found.');
  const query = request.nextUrl.searchParams;
  const paged = !['status', 'collection', 'item'].includes(resource);
  const allowed = new Set(paged ? ['cursor', 'limit'] : []);
  if (resource === 'listings') for (const key of ['collection', 'seller', 'status']) allowed.add(key);
  if (resource === 'activity') for (const key of ['collection', 'wallet']) allowed.add(key);
  for (const key of query.keys()) if (!allowed.has(key) || query.getAll(key).length !== 1) return badInput();
  const limitText = query.get('limit') ?? '20';
  if (!/^[1-9]\d?$/.test(limitText) || Number(limitText) > 50) return badInput();
  if (query.has('collection')) collection = inputAddress(query.get('collection')!);
  if (query.has('wallet')) wallet = inputAddress(query.get('wallet')!);
  const seller = query.has('seller') ? inputAddress(query.get('seller')!) : undefined;
  const status = query.get('status') ?? undefined;
  if (status !== undefined && !['active', 'sold', 'cancelled'].includes(status)) return badInput();
  const cursor = query.get('cursor') ?? undefined;
  if (cursor !== undefined && (!cursor || cursor.length > 2048)) return badInput();
  const scope = JSON.stringify([resource, collection ?? '', wallet ?? '', tokenId ?? '', seller ?? '', status ?? '']);
  return { resource, collection, wallet, tokenId, seller, status, limit: Number(limitText), cursor, scope };
}

function parseCursor(input: string | undefined, select: Selection): Cursor | null {
  if (!input) return null;
  try {
    if (!/^[\w-]+$/.test(input)) return badInput();
    const bytes = Buffer.from(input, 'base64url');
    if (bytes.toString('base64url') !== input) return badInput();
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(value) || Object.keys(value).sort().join(',') !== 'after,block,hash,limit,manifest,scope,v'
      || value.v !== 1 || typeof value.manifest !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifest)
      || typeof value.block !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value.block) || !isHash(value.hash)
      || value.scope !== select.scope || value.limit !== select.limit || !Array.isArray(value.after)
      || value.after.length < 1 || value.after.length > 2 || !value.after.every(item => typeof item === 'string' && item.length > 0 && item.length < 256)) return badInput();
    const after = value.after as string[];
    if (select.resource === 'activity' && (after.length !== 2 || !/^(0|[1-9]\d{0,77})$/.test(after[0]) || !/^(0|[1-9]\d{0,9})$/.test(after[1]) || Number(after[1]) > 2_147_483_647)) return badInput();
    if (select.resource === 'listings' && (after.length !== 1 || !/^[1-9]\d{0,77}$/.test(after[0]))) return badInput();
    if (['items', 'wallet-items'].includes(select.resource) && (after.length !== 2 || !isAddress(after[0]) || !/^[1-9]\d{0,77}$/.test(after[1]))) return badInput();
    if (['collections', 'claims'].includes(select.resource) && after.length !== 1) return badInput();
    return value as Cursor;
  } catch (error) { if (error instanceof ApiError) throw error; return badInput(); }
}
const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
const disabledContext = (enabled: boolean, reason: string, deploymentId: string | null = null): IndexedNftContext => ({
  enabled, available: false, reason, deploymentId, network: deploymentId ? { mode: 'local', name: 'Local Anvil', chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 } : null,
  checkpoint: null, sync: null, readonly: true, finalized: false,
});
function emptyResult(context: IndexedNftContext, select: Selection) {
  if (select.resource === 'status') return { context };
  if (select.resource === 'collection') return { context, collection: null };
  if (select.resource === 'item') return { context, item: null };
  return { context, items: [], nextCursor: null };
}

function collectionDto(input: unknown): IndexedCollection {
  const row = valueRecord(input);
  return { address: address(row.address), creator: address(row.creator), name: text(row.name), symbol: text(row.symbol),
    configured: boolean(row.configured), opened: boolean(row.opened), termsHash: optionalHash(row.termsHash), contentHash: optionalHash(row.contentHash),
    totalMinted: numberText(row.totalMinted), primaryTotalPriceRaw: numberText(row.primaryTotalPrice), primaryPlatformFeeRaw: numberText(row.primaryPlatformFee),
    primaryCreatorProceedsRaw: numberText(row.primaryCreatorProceeds), totalClaimedRaw: numberText(row.totalClaimed) };
}
function listingDto(input: unknown): IndexedListing {
  const row = valueRecord(input);
  if (!['active', 'sold', 'cancelled'].includes(String(row.status))) return invalidData();
  return { id: numberText(row.listingId), collection: address(row.collection), tokenId: numberText(row.tokenId), seller: address(row.seller),
    totalPriceRaw: numberText(row.totalPrice), status: row.status as IndexedListing['status'], buyer: optionalAddress(row.buyer), recipient: optionalAddress(row.recipient),
    platformFeeRaw: optionalAmount(row.platformFee), royaltyRaw: optionalAmount(row.royalty), sellerProceedsRaw: optionalAmount(row.sellerProceeds) };
}
function itemDto(row: Record<string, unknown>): IndexedNftItem {
  const value = valueRecord(row.value);
  return { id: text(row.entity_id), collection: address(value.collection), tokenId: numberText(value.tokenId), owner: optionalAddress(value.owner), burned: boolean(value.burned),
    listing: row.listing_value == null ? null : listingDto(row.listing_value) };
}
async function presentation(collection: unknown, tokenId: string, resolveContent: ContentResolver, expectedAddress?: string) {
  if (collection == null) return null;
  const value = valueRecord(collection);
  if (expectedAddress !== undefined && address(value.address) !== expectedAddress) return invalidData();
  if (!boolean(value.opened) || value.contentHash == null) return null;
  const contentHash = hash(value.contentHash);
  if (/^0x0{64}$/.test(contentHash)) return null;
  return resolveContent(contentHash, tokenId);
}
/** Keep presentation storage work bounded even on the largest permitted history page. */
async function mapPresentation<T>(rows: Record<string, unknown>[], convert: (row: Record<string, unknown>) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(rows.length);
  let next = 0, failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (!failed && next < rows.length) {
      const index = next++;
      try { results[index] = await convert(rows[index]); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  // Drain in-flight lookups before rolling back/releasing their shared SQL client.
  if (failed) throw failure;
  return results;
}
function claimDto(input: unknown): IndexedClaim {
  const row = valueRecord(input);
  return { contract: address(row.contract), beneficiary: address(row.beneficiary), totalClaimedRaw: numberText(row.totalClaimed), recipient: address(row.recipient), lastAmountRaw: numberText(row.lastAmount) };
}
function activityDto(row: Record<string, unknown>): IndexedActivity {
  const value = valueRecord(row.value), args = valueRecord(value.args);
  if (Object.values(args).some(field => typeof field !== 'string' && typeof field !== 'boolean')
    || !Number.isSafeInteger(value.logIndex) || Number(value.logIndex) < 0) return invalidData();
  const seconds = BigInt(numberText(row.event_timestamp));
  if (seconds > 8_640_000_000_000n) return invalidData();
  return { id: text(row.entity_id), eventName: text(value.eventName), source: address(value.source), collection: optionalAddress(row.collection_address),
    transactionHash: hash(value.transactionHash), blockNumber: numberText(value.blockNumber), logIndex: Number(value.logIndex),
    timestamp: new Date(Number(seconds * 1000n)).toISOString(), args: args as Record<string, string | boolean> };
}

async function readRows(client: SqlClient, select: Selection, manifest: string, cursor: Cursor | null) {
  if (select.resource === 'status') return [];
  const values: unknown[] = [manifest];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const where = ['p.manifest_id=$1'];
  let columns = 'p.entity_id,p.value', joins = '', order = 'p.entity_id COLLATE "C" ASC';
  if (['collections', 'collection'].includes(select.resource)) {
    where.push("p.kind='collections'");
    if (select.collection) where.push(`p.entity_id=${bind(select.collection)}`);
    if (cursor) where.push(`p.entity_id COLLATE "C" > ${bind(cursor.after[0])} COLLATE "C"`);
  } else if (['items', 'item', 'wallet-items'].includes(select.resource)) {
    where.push("p.kind='items'", "p.value->>'minted'='true'");
    if (select.collection) where.push(`p.value->>'collection'=${bind(select.collection)}`);
    if (select.tokenId) where.push(`p.value->>'tokenId'=${bind(select.tokenId)}`);
    if (select.wallet) where.push(`p.value->>'owner'=${bind(select.wallet)}`);
    columns += ',l.value AS listing_value,c.value AS collection_value';
    joins = "LEFT JOIN oneshot_evm_projections l ON l.manifest_id=p.manifest_id AND l.kind='listings' AND l.entity_id=p.value->>'activeListingId' AND l.value->>'status'='active' LEFT JOIN oneshot_evm_projections c ON c.manifest_id=p.manifest_id AND c.kind='collections' AND c.entity_id=p.value->>'collection'";
    order = "p.value->>'collection' COLLATE \"C\" ASC,(p.value->>'tokenId')::numeric ASC";
    if (cursor) where.push(`(p.value->>'collection' COLLATE "C",(p.value->>'tokenId')::numeric) > (${bind(cursor.after[0])} COLLATE "C",${bind(cursor.after[1])}::numeric)`);
  } else if (select.resource === 'listings') {
    where.push("p.kind='listings'");
    if (select.collection) where.push(`p.value->>'collection'=${bind(select.collection)}`);
    if (select.seller) where.push(`p.value->>'seller'=${bind(select.seller)}`);
    if (select.status) where.push(`p.value->>'status'=${bind(select.status)}`);
    order = "(p.value->>'listingId')::numeric DESC";
    if (cursor) where.push(`(p.value->>'listingId')::numeric < ${bind(cursor.after[0])}::numeric`);
  } else if (select.resource === 'claims') {
    where.push("p.kind='claims'", `p.value->>'beneficiary'=${bind(select.wallet)}`);
    if (cursor) where.push(`p.entity_id COLLATE "C" > ${bind(cursor.after[0])} COLLATE "C"`);
  } else {
    where.push("p.kind='activity'");
    joins = "JOIN oneshot_evm_journal j ON j.manifest_id=p.manifest_id AND j.block_number=(p.value->>'blockNumber')::numeric AND j.block_hash=p.value->>'blockHash' LEFT JOIN oneshot_evm_projections l ON l.manifest_id=p.manifest_id AND l.kind='listings' AND l.entity_id=p.value->'args'->>'listingId' LEFT JOIN oneshot_evm_projections c ON c.manifest_id=p.manifest_id AND c.kind='collections' AND c.entity_id=p.value->>'source'";
    const collection = "COALESCE(c.entity_id,p.value->'args'->>'collection',l.value->>'collection')";
    columns += `,j.block_timestamp::text AS event_timestamp,${collection} AS collection_address`;
    if (select.collection) where.push(`${collection}=${bind(select.collection)}`);
    if (select.wallet) where.push(`EXISTS(SELECT 1 FROM jsonb_each_text(p.value->'args') field WHERE field.key IN ('creator','payer','recipient','from','to','account','owner','approved','operator','buyer','seller') AND field.value=${bind(select.wallet)})`);
    order = "(p.value->>'blockNumber')::numeric DESC,(p.value->>'logIndex')::integer DESC";
    if (cursor) where.push(`((p.value->>'blockNumber')::numeric,(p.value->>'logIndex')::integer) < (${bind(cursor.after[0])}::numeric,${bind(cursor.after[1])}::integer)`);
  }
  const count = ['collection', 'item'].includes(select.resource) ? 1 : select.limit + 1;
  return (await client.query(`SELECT ${columns} FROM oneshot_evm_projections p ${joins} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${bind(count)}`, values)).rows;
}

function rowKey(select: Selection, row: Record<string, unknown>): string[] {
  const value = valueRecord(row.value);
  if (select.resource === 'activity') return [numberText(value.blockNumber), String(value.logIndex)];
  if (select.resource === 'listings') return [numberText(value.listingId)];
  if (['items', 'wallet-items'].includes(select.resource)) return [address(value.collection), numberText(value.tokenId)];
  return [text(row.entity_id)];
}

const defaults: IndexedReaderDependencies = {
  env: () => process.env, pool: database,
  loadManifest: async env => {
    const input = await readFile(resolve(env.ONESHOT_INDEXER_MANIFEST_PATH!));
    if (input.length > 16_384) throw new Error('Invalid manifest');
    return parseManifest(JSON.parse(input.toString('utf8')));
  },
  source: async env => new VerifiedRpcSource(await createVerifiedRpc(networkConfig(env))),
  contentResolver: client => {
    let queue: Promise<unknown> = Promise.resolve();
    const query = (sql: string, values?: unknown[]) => {
      const pending = queue.then(() => client.query(sql, values));
      // Preserve rejection: no further SQL may run on an aborted transaction.
      queue = pending;
      return pending;
    };
    let available: Promise<boolean> | undefined;
    return createNftPublicContentResolver({
      record: async (namespace, id) => {
        // Standalone indexers initialize their own schema without the optional content store.
        available ??= query("SELECT to_regclass('b20_app_records') IS NOT NULL AS available").then(result => result.rows[0]?.available === true);
        if (!await available) return null;
        return (await query('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2', [namespace, id])).rows[0]?.value ?? null;
      },
    });
  },
};

/** Public chain data only; never authenticates users, initializes a schema or submits a transaction. */
export function createIndexedNftReader(overrides: Partial<IndexedReaderDependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  return async (request: NextRequest): Promise<Response> => {
    const select = selection(request), cursor = parseCursor(select.cursor, select), env = { ...deps.env() };
    const enabled = env.ONESHOT_INDEXER_READS_ENABLED;
    if (enabled === undefined || enabled === '' || enabled === 'false') return json(emptyResult(disabledContext(false, 'NFT records are currently unavailable. You can still create and save collection drafts.'), select));
    if (enabled !== 'true') throw new ApiError(503, 'INDEXER_CONFIG_INVALID', 'Indexed NFT browsing is not configured correctly.');
    if (env.ONESHOT_NETWORK !== 'local') throw new ApiError(503, 'INDEXER_PROFILE_UNSUPPORTED', 'Indexed browsing currently supports the local test chain only.');
    if (!env.DATABASE_URL || !env.ONESHOT_INDEXER_MANIFEST_PATH) throw new ApiError(503, 'INDEXER_CONFIG_INCOMPLETE', 'Indexed NFT browsing needs a database and deployment manifest.');
    let manifest: Manifest, identity: string;
    try { manifest = await deps.loadManifest(env); identity = manifestId(manifest); }
    catch { throw new ApiError(503, 'INDEXER_MANIFEST_INVALID', 'The indexed NFT deployment manifest is unavailable or invalid.'); }
    let source: ChainSource;
    try { source = await deps.source(env); await source.verify(manifest); }
    catch { throw new ApiError(503, 'INDEXER_CHAIN_UNAVAILABLE', 'The configured indexed chain or deployment could not be verified.'); }
    const pool = deps.pool();
    if (!pool) throw new ApiError(503, 'DATABASE_REQUIRED', 'Indexed NFT browsing requires its configured database.');
    let client: SqlClient | undefined, began = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); began = true;
      await client.query("SET LOCAL statement_timeout='5000ms'");
      await client.query("SET LOCAL lock_timeout='2000ms'");
      const deployment = await client.query('SELECT manifest_id FROM oneshot_evm_deployments WHERE manifest_id=$1', [identity]);
      const rows = await client.query('SELECT j.block_number::text,j.block_hash,j.parent_hash,j.block_timestamp::text FROM oneshot_evm_journal j WHERE j.manifest_id=$1 ORDER BY j.block_number DESC LIMIT 1', [identity]);
      const head = rows.rows[0];
      if (!deployment.rows.length || !head) {
        if (cursor) throw new ApiError(409, 'CURSOR_STALE', 'The indexed checkpoint changed. Refresh this list from the beginning.');
        await client.query('COMMIT'); began = false;
        return json(emptyResult(disabledContext(true, 'NFT records are being updated. Please try again shortly.', identity), select));
      }
      const block = numberText(head.block_number, 78), blockHash = hash(head.block_hash), timestamp = numberText(head.block_timestamp, 78);
      if (BigInt(block) < manifest.startBlock) return invalidData();
      if (cursor && (cursor.manifest !== identity || cursor.block !== block || cursor.hash !== blockHash)) throw new ApiError(409, 'CURSOR_STALE', 'The indexed checkpoint changed. Refresh this list from the beginning.');
      const context: IndexedNftContext = { enabled: true, available: true, reason: null, deploymentId: identity,
        network: { mode: 'local', name: 'Local Anvil', chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 },
        checkpoint: { number: block, hash: blockHash, timestamp }, sync: null, readonly: true, finalized: false };
      const resultRows = await readRows(client, select, identity, cursor);
      // Read only the SQL snapshot above; do not attach data from a later journal state.
      const resolveContent = deps.contentResolver(client);
      const convert = async (row: Record<string, unknown>) => {
        if (['collections', 'collection'].includes(select.resource)) {
          const collection = collectionDto(row.value);
          return { ...collection, presentation: await presentation(row.value, '1', resolveContent) };
        }
        if (['items', 'item', 'wallet-items'].includes(select.resource)) {
          const item = itemDto(row);
          return { ...item, presentation: await presentation(row.collection_value, item.tokenId, resolveContent, item.collection) };
        }
        return select.resource === 'listings' ? listingDto(row.value) : select.resource === 'claims' ? claimDto(row.value) : activityDto(row);
      };
      let result: unknown;
      if (select.resource === 'status') result = { context };
      else if (select.resource === 'collection' || select.resource === 'item') {
        if (!resultRows.length) throw new ApiError(404, 'INDEXED_RECORD_NOT_FOUND', 'This NFT record is not present at the indexed checkpoint.');
        result = select.resource === 'collection' ? { context, collection: await convert(resultRows[0]) } : { context, item: await convert(resultRows[0]) };
      } else {
        const page = resultRows.slice(0, select.limit);
        const items = await mapPresentation(page, convert);
        const nextCursor = resultRows.length > select.limit ? encodeCursor({ v: 1, manifest: identity, block, hash: blockHash, scope: select.scope, limit: select.limit, after: rowKey(select, page[page.length - 1]) }) : null;
        result = { context, items, nextCursor };
      }
      try {
        const chainHead = await source.height();
        if (typeof chainHead !== 'bigint' || chainHead < 0n) throw new Error('Invalid observed chain height');
        if (BigInt(block) > chainHead || (await source.block(BigInt(block))).hash !== blockHash) throw new ApiError(409, 'INDEXER_CHAIN_MOVED', 'The indexed checkpoint is no longer canonical. Wait for the indexer to synchronize, then refresh.');
        context.sync = { chainHead: chainHead.toString(), behindBlocks: (chainHead - BigInt(block)).toString() };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, 'INDEXER_CHAIN_UNAVAILABLE', 'The indexed checkpoint could not be verified against its chain.');
      }
      await client.query('COMMIT'); began = false;
      return json(result);
    } catch (error) {
      if (began) await client?.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ApiError) throw error;
      if (object(error) && error.code === '42P01') throw new ApiError(503, 'INDEXER_NOT_STARTED', 'The NFT indexer has not initialized this database.');
      throw new ApiError(503, 'INDEXER_READ_UNAVAILABLE', 'Indexed NFT data could not be read. Please retry.');
    } finally { client?.release(); }
  };
}
export const indexedNftRead = createIndexedNftReader();
