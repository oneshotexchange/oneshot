import { open } from 'node:fs/promises';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { createVerifiedRpc, networkConfig, nftExecutionNetwork } from '@oneshot/evm';
import { parseReviewedNftManifest, reviewedNftManifestId, reviewedNftManifestJson, type ReviewedNftBlock, type ReviewedNftManifest } from '../../../../packages/evm/src/reviewed-nft';
import { VerifiedReviewedNftJournalSource } from '../../../indexer/src/reviewed-nft-source';
import type { SqlClient, SqlPool } from '../../../indexer/src/store';
import { reviewedActivitySchema, reviewedClaimSchema, reviewedCollectionSchema, reviewedContextSchema, reviewedItemSchema, reviewedListingSchema, reviewedUint, type ReviewedNftContext } from '../../../web/lib/reviewed-nft-data';
import { database } from './store';
import { ApiError } from './errors';

type Environment = Record<string, string | undefined>;
type Source = {
  verify(manifest: ReviewedNftManifest, block?: ReviewedNftBlock): Promise<unknown>;
  height(): Promise<bigint>; block(number: bigint): Promise<ReviewedNftBlock>;
  accounting(manifest: ReviewedNftManifest, block: ReviewedNftBlock): Promise<{ pending: string; balance: string; marketDeployed: boolean; nextListingId: string }>;
};
export type ReviewedNftReaderDependencies = { env(): Environment; pool(): SqlPool | null; loadManifest(env: Environment): Promise<ReviewedNftManifest>; source(env: Environment): Promise<Source> };
type Resource = 'status' | 'collections' | 'collection' | 'items' | 'item' | 'listings' | 'activity' | 'wallet-items' | 'claims';
type Selection = { resource: Resource; collection?: string; tokenId?: string; listingId?: string; wallet?: string; seller?: string; status?: string; limit: number; scope: string; cursor?: string };
type Cursor = { v: 1; deployment: string; block: string; hash: string; scope: string; limit: number; after: string[] };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const address = (value: unknown): value is `0x${string}` => typeof value === 'string' && /^0x[\da-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const hash = (value: unknown): value is `0x${string}` => typeof value === 'string' && /^0x[\da-f]{64}$/.test(value) && !/^0x0{64}$/.test(value);
const unavailable = (): never => { throw new ApiError(503, 'REVIEWED_NFT_READ_UNAVAILABLE', 'External NFT records could not be loaded. Please try again shortly.'); };
const invalidInput = (): never => { throw new ApiError(400, 'REVIEWED_NFT_INPUT_INVALID', 'Check the collection, NFT or page selection and try again.'); };
const stale = (): never => { throw new ApiError(409, 'REVIEWED_NFT_CURSOR_STALE', 'External NFT activity changed. Refresh this list from the beginning.'); };
const missing = (): never => { throw new ApiError(404, 'REVIEWED_NFT_NOT_FOUND', 'This collection or NFT has not been observed at this checkpoint.'); };
const timeout = () => new ApiError(504, 'REVIEWED_NFT_READ_TIMEOUT', 'External NFT records could not be checked in time. Please try again.');
const json = (value: unknown) => Response.json(value, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const coverage = { mode: 'observed-since-admission' as const, completeCollection: false as const, includesPreAdmissionHistory: false as const };
const uint = (value: unknown) => { const parsed = reviewedUint.safeParse(value); return parsed.success ? parsed.data : unavailable(); };

/** The lease has a 75s absolute bound; acquisition and each SQL operation have 5s.
 * Core proofs are independently bounded by the source. Poisoned/late leases are destroyed once. */
async function acquire(pool: SqlPool, external?: AbortSignal) {
  const controller = new AbortController(), signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
  let raw: SqlClient | undefined, released = false, closed = false;
  let reject!: (reason: Error) => void;
  const stopped = new Promise<never>((_resolve, fail) => { reject = fail; }); void stopped.catch(() => undefined);
  const releaseRaw = (destroy?: boolean) => { if (raw && !released) { released = true; raw.release(destroy); } };
  const abort = () => { try { releaseRaw(true); } catch { /* Keep driver errors private. */ } reject(timeout()); };
  const total = setTimeout(() => controller.abort(), 75_000); signal.addEventListener('abort', abort, { once: true });
  const active = () => { if (signal.aborted) { abort(); throw timeout(); } if (closed) throw timeout(); };
  const run = async <T>(operation: () => Promise<T>, sql = false): Promise<T> => {
    active(); const timer = sql ? setTimeout(() => controller.abort(), 5000) : undefined;
    try { const result = await Promise.race([Promise.resolve().then(() => { active(); return operation(); }), stopped]); active(); return result; }
    catch (error) { if (signal.aborted) throw timeout(); throw error; }
    finally { if (timer) clearTimeout(timer); }
  };
  const release = () => { if (closed) return; closed = true; clearTimeout(total); signal.removeEventListener('abort', abort); releaseRaw(signal.aborted ? true : undefined); };
  try {
    await run(async () => { raw = await pool.connect(); if (signal.aborted || closed) { try { releaseRaw(true); } catch { /* Late acquisition cannot re-enter the pool. */ } throw timeout(); } }, true);
    return { query: (sql: string, values?: unknown[]) => run(() => raw!.query(sql, values), true), release, run };
  } catch (error) { release(); throw error; }
}
function select(request: NextRequest): Selection {
  if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'External NFT records are read-only.');
  const prefix = '/api/oneshot/reviewed-nfts/', path = request.nextUrl.pathname.replace(/\/$/, '');
  if (!path.startsWith(prefix) || path.length > 1024 || request.nextUrl.search.length > 4096) return invalidInput();
  let parts: string[]; try { parts = path.slice(prefix.length).split('/').map(decodeURIComponent); } catch { return invalidInput(); }
  const inputAddress = (value: string) => { const normalized = value?.toLowerCase(); return address(normalized) ? normalized : invalidInput(); };
  let resource: Resource, collection: string | undefined, tokenId: string | undefined, wallet: string | undefined;
  if (parts.length === 1 && ['status', 'collections', 'listings', 'activity'].includes(parts[0])) resource = parts[0] as Resource;
  else if (parts[0] === 'collections' && parts.length >= 2 && parts.length <= 4) {
    collection = inputAddress(parts[1]);
    if (parts.length === 2) resource = 'collection';
    else if (parts[2] === 'items' && parts.length === 3) resource = 'items';
    else if (parts[2] === 'items' && parts.length === 4 && reviewedUint.safeParse(parts[3]).success) { resource = 'item'; tokenId = parts[3]; }
    else return invalidInput();
  } else if (parts[0] === 'wallets' && parts.length === 3 && ['items', 'claims'].includes(parts[2])) { wallet = inputAddress(parts[1]); resource = parts[2] === 'items' ? 'wallet-items' : 'claims'; }
  else return invalidInput();
  const query = request.nextUrl.searchParams, paged = !['status', 'collection', 'item'].includes(resource), allowed = new Set(paged ? ['limit', 'cursor'] : []);
  if (resource === 'listings') for (const key of ['collection', 'seller', 'status']) allowed.add(key);
  if (resource === 'activity') for (const key of ['collection', 'wallet']) allowed.add(key);
  for (const key of query.keys()) if (!allowed.has(key) || query.getAll(key).length !== 1) return invalidInput();
  const size = query.get('limit') ?? '20'; if (!/^[1-9]\d?$/.test(size) || Number(size) > 50) return invalidInput();
  if (query.has('collection')) collection = inputAddress(query.get('collection')!); if (query.has('wallet')) wallet = inputAddress(query.get('wallet')!);
  const seller = query.has('seller') ? inputAddress(query.get('seller')!) : undefined, status = query.get('status') ?? undefined, cursor = query.get('cursor') ?? undefined;
  if (status !== undefined && !['active', 'sold', 'cancelled'].includes(status) || cursor !== undefined && (!cursor || cursor.length > 2048)) return invalidInput();
  return { resource, collection, tokenId, wallet, seller, status, cursor, limit: Number(size), scope: JSON.stringify([resource, collection ?? '', tokenId ?? '', wallet ?? '', seller ?? '', status ?? '']) };
}
function cursor(raw: string | undefined, selection: Selection): Cursor | null {
  if (!raw) return null;
  try {
    if (!/^[\w-]+$/.test(raw)) return invalidInput(); const bytes = Buffer.from(raw, 'base64url'); if (bytes.toString('base64url') !== raw) return invalidInput();
    const parsed = z.object({ v: z.literal(1), deployment: z.string().regex(/^[a-f0-9]{64}$/), block: reviewedUint, hash: z.string().refine(hash), scope: z.literal(selection.scope), limit: z.literal(selection.limit), after: z.array(z.string().min(1).max(256)).min(1).max(2) }).strict().parse(JSON.parse(bytes.toString('utf8')));
    if (['collections', 'claims'].includes(selection.resource) ? parsed.after.length !== 1 || !address(parsed.after[0])
      : selection.resource === 'listings' ? parsed.after.length !== 1 || !reviewedUint.safeParse(parsed.after[0]).success || parsed.after[0] === '0'
        : selection.resource === 'activity' ? parsed.after.length !== 2 || !reviewedUint.safeParse(parsed.after[0]).success || !/^(0|[1-9]\d{0,9})$/.test(parsed.after[1]) || BigInt(parsed.after[1]) > 2147483647n
          : parsed.after.length !== 2 || !address(parsed.after[0]) || !reviewedUint.safeParse(parsed.after[1]).success) return invalidInput();
    return parsed;
  } catch { return invalidInput(); }
}
async function loadManifest(env: Environment) {
  const file = await open(env.ONESHOT_REVIEWED_NFT_MANIFEST_PATH!, 'r');
  try { if (!(await file.stat()).isFile() || (await file.stat()).size > 16_384) return unavailable(); const bytes = Buffer.alloc(16_385), result = await file.read(bytes, 0, bytes.length, 0); if (result.bytesRead > 16_384) return unavailable(); return parseReviewedNftManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead)))); }
  finally { await file.close(); }
}
const defaults: ReviewedNftReaderDependencies = { env: () => process.env, pool: database, loadManifest, source: async env => new VerifiedReviewedNftJournalSource(await createVerifiedRpc(networkConfig(env))) };
function disabled(enabled: boolean, deploymentId: string | null = null): ReviewedNftContext {
  return { schemaVersion: 1, kind: 'reviewed-external-nft-journal', enabled, available: false, reason: 'External NFT records are currently unavailable. Please return later.', deploymentId, network: null, source: null, checkpoint: null, sync: null, readonly: true, finalized: false, coverage };
}
function empty(context: ReviewedNftContext, selected: Selection) { return selected.resource === 'status' ? { context } : selected.resource === 'collection' ? { context, collection: null } : selected.resource === 'item' ? { context, item: null, listing: null } : { context, items: [], nextCursor: null }; }
function timestamp(raw: string) { const seconds = BigInt(uint(raw)); if (seconds > 8640000000000n) return unavailable(); return new Date(Number(seconds) * 1000).toISOString(); }
function action(row: Record<string, unknown>, block: ReviewedNftBlock, manifest: ReviewedNftManifest) {
  const parsed = reviewedActivitySchema.safeParse(row.value); if (!parsed.success) return unavailable(); const value = parsed.data;
  if (row.entity_id !== value.id || row.provenance_number !== value.blockNumber || row.provenance_hash !== value.blockHash || value.timestamp !== timestamp(String(row.provenance_timestamp))
    || BigInt(value.blockNumber) < manifest.startBlock || BigInt(value.blockNumber) > block.number
    || (value.eventName === 'ReviewAdmitted' || value.eventName === 'ReviewRevoked' ? value.source !== manifest.registry.address || !value.collection
      : value.eventName === 'Transfer' ? value.source !== value.collection : value.source !== manifest.marketplace.address)
    || selectedCollection(row) !== undefined && selectedCollection(row) !== value.collection) return unavailable();
  return value;
}
function selectedCollection(row: Record<string, unknown>) { return typeof row.expected_collection === 'string' ? row.expected_collection : undefined; }
function position(value: { lastBlockNumber: string; lastBlockHash: string; lastTransactionHash: string; lastLogIndex: number }, row: Record<string, unknown>, block: ReviewedNftBlock, manifest: ReviewedNftManifest) {
  if (row.provenance_number !== value.lastBlockNumber || row.provenance_hash !== value.lastBlockHash || BigInt(value.lastBlockNumber) < manifest.startBlock || BigInt(value.lastBlockNumber) > block.number) return unavailable();
  const event = action({ entity_id: `${value.lastTransactionHash}:${value.lastLogIndex}`, value: row.last_action, provenance_number: row.provenance_number, provenance_hash: row.provenance_hash, provenance_timestamp: row.provenance_timestamp }, block, manifest);
  if (event.transactionHash !== value.lastTransactionHash || event.logIndex !== value.lastLogIndex) return unavailable(); return event;
}
async function rows(client: SqlClient, selected: Selection, deployment: string, after: Cursor | null) {
  const values: unknown[] = [deployment], bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const kind = ['collections', 'collection'].includes(selected.resource) ? 'collections' : ['items', 'item', 'wallet-items'].includes(selected.resource) ? 'items' : selected.resource;
  const where = [`p.manifest_id=$1`, `p.kind=${bind(kind)}`]; let order = 'p.entity_id COLLATE "C" ASC';
  if (kind === 'collections') { if (selected.collection) where.push(`p.entity_id=${bind(selected.collection)}`); if (after) where.push(`p.entity_id COLLATE "C">${bind(after.after[0])} COLLATE "C"`); }
  else if (kind === 'items') {
    if (selected.collection) where.push(`p.value->>'collection'=${bind(selected.collection)}`); if (selected.tokenId !== undefined) where.push(`p.value->>'tokenId'=${bind(selected.tokenId)}`);
    if (selected.wallet) where.push(`p.value->>'owner'=${bind(selected.wallet)}`, "p.value->'burned'='false'::jsonb");
    order = `p.value->>'collection' COLLATE "C" ASC,(p.value->>'tokenId')::numeric ASC`;
    if (after) where.push(`(p.value->>'collection' COLLATE "C",(p.value->>'tokenId')::numeric)>(${bind(after.after[0])} COLLATE "C",${bind(after.after[1])}::numeric)`);
  } else if (kind === 'listings') {
    if (selected.listingId) where.push(`p.value->>'listingId'=${bind(selected.listingId)}`);
    if (selected.collection) where.push(`p.value->>'collection'=${bind(selected.collection)}`); if (selected.seller) where.push(`p.value->>'seller'=${bind(selected.seller)}`); if (selected.status) where.push(`p.value->>'status'=${bind(selected.status)}`);
    order = `(p.value->>'listingId')::numeric DESC`; if (after) where.push(`(p.value->>'listingId')::numeric<${bind(after.after[0])}::numeric`);
  } else if (kind === 'claims') { where.push("p.value->>'kind'='reviewed-market-claim'", `p.value->>'account'=${bind(selected.wallet)}`); if (after) where.push(`p.value->>'marketplace'>${bind(after.after[0])}`); order = `p.value->>'marketplace' COLLATE "C" ASC`; }
  else {
    if (selected.collection) where.push(`p.value->>'collection'=${bind(selected.collection)}`);
    if (selected.wallet) where.push(`EXISTS(SELECT 1 FROM jsonb_each_text(p.value->'args') field WHERE field.key IN ('seller','buyer','recipient','from','to','account','caller','royaltyRecipient') AND field.value=${bind(selected.wallet)})`);
    order = `(p.value->>'blockNumber')::numeric DESC,(p.value->>'logIndex')::integer DESC`; if (after) where.push(`((p.value->>'blockNumber')::numeric,(p.value->>'logIndex')::integer)<(${bind(after.after[0])}::numeric,${bind(after.after[1])}::integer)`);
  }
  const blockKey = kind === 'activity' ? 'blockNumber' : 'lastBlockNumber';
  const ownerJoin = kind === 'items' ? `LEFT JOIN LATERAL (SELECT t.entity_id,t.value FROM oneshot_evm_projections t WHERE t.manifest_id=p.manifest_id AND t.kind='activity' AND t.value->>'eventName'='Transfer' AND t.value->>'collection'=p.value->>'collection' AND t.value->'args'->>'tokenId'=p.value->>'tokenId' ORDER BY (t.value->>'blockNumber')::numeric DESC,(t.value->>'logIndex')::integer DESC LIMIT 1) own ON true LEFT JOIN oneshot_evm_journal oj ON oj.manifest_id=p.manifest_id AND oj.block_number=(own.value->>'blockNumber')::numeric` : '';
  const ownerFields = kind === 'items' ? ',own.entity_id AS owner_event_id,own.value AS owner_event,oj.block_number::text AS owner_number,oj.block_hash AS owner_hash,oj.block_timestamp::text AS owner_timestamp' : '';
  return (await client.query(`SELECT p.entity_id,p.value,j.block_number::text AS provenance_number,j.block_hash AS provenance_hash,j.block_timestamp::text AS provenance_timestamp,a.value AS last_action${ownerFields} FROM oneshot_evm_projections p LEFT JOIN oneshot_evm_journal j ON j.manifest_id=p.manifest_id AND j.block_number=(p.value->>'${blockKey}')::numeric LEFT JOIN oneshot_evm_projections a ON a.manifest_id=p.manifest_id AND a.kind='activity' AND a.entity_id=(p.value->>'lastTransactionHash')||':'||(p.value->>'lastLogIndex') ${ownerJoin} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${bind(['collection', 'item'].includes(selected.resource) ? 1 : selected.limit + 1)}`, values)).rows;
}
export function createReviewedNftReader(overrides: Partial<ReviewedNftReaderDependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  return async (request: NextRequest): Promise<Response> => {
    const selected = select(request), continuation = cursor(selected.cursor, selected), env = { ...deps.env() }, flag = env.ONESHOT_REVIEWED_NFT_READS_ENABLED;
    if (flag === undefined || flag === '' || flag === 'false') return json(empty(disabled(false), selected));
    if (flag !== 'true' || !['local', 'base-sepolia'].includes(env.ONESHOT_NETWORK ?? '') || !env.DATABASE_URL || !env.ONESHOT_REVIEWED_NFT_MANIFEST_PATH) return unavailable();
    let client: Awaited<ReturnType<typeof acquire>> | undefined, began = false;
    try {
      const manifest = parseReviewedNftManifest(reviewedNftManifestJson(await deps.loadManifest(env))), deploymentId = reviewedNftManifestId(manifest);
      if (manifest.mode !== env.ONESHOT_NETWORK) return unavailable(); const pool = deps.pool(); if (!pool) return unavailable(); client = await acquire(pool, request.signal);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); began = true;
      await client.query("SET LOCAL statement_timeout='5000ms'"); await client.query("SET LOCAL lock_timeout='2000ms'");
      const registered = await client.query('SELECT manifest_id FROM oneshot_evm_deployments WHERE manifest_id=$1', [deploymentId]);
      const checkpoints = await client.query('SELECT j.block_number::text,j.block_hash,j.parent_hash,j.block_timestamp::text FROM oneshot_evm_journal j WHERE j.manifest_id=$1 ORDER BY j.block_number DESC LIMIT 1', [deploymentId]);
      if (!registered.rows.length || !checkpoints.rows.length) { if (continuation) return stale(); await client.query('COMMIT'); began = false; return json(empty(disabled(true, deploymentId), selected)); }
      const head = checkpoints.rows[0]; if (!hash(head.block_hash) || !hash(head.parent_hash)) return unavailable();
      const block: ReviewedNftBlock = { number: BigInt(uint(head.block_number)), hash: head.block_hash, parentHash: head.parent_hash, timestamp: BigInt(uint(head.block_timestamp)) };
      if (block.number < manifest.startBlock) return unavailable();
      if (continuation && (continuation.deployment !== deploymentId || continuation.block !== block.number.toString() || continuation.hash !== block.hash)) return stale();
      const source = await client.run(() => deps.source(env)); await client.run(() => source.verify(manifest, block));
      const accounting = await client.run(() => source.accounting(manifest, block));
      const aggregate = (await client.query("SELECT value FROM oneshot_evm_projections WHERE manifest_id=$1 AND kind='claims' AND entity_id=$2", [deploymentId, `${manifest.marketplace.address}:accounting`])).rows[0]?.value;
      if (!object(aggregate) || aggregate.schemaVersion !== 1 || aggregate.kind !== 'reviewed-market-accounting' || aggregate.marketDeployed !== true || accounting.marketDeployed !== true
        || uint(aggregate.pendingRaw) !== uint(accounting.pending) || uint(aggregate.nextListingIdRaw) !== uint(accounting.nextListingId) || BigInt(uint(accounting.balance)) < BigInt(accounting.pending)) return unavailable();
      const context: ReviewedNftContext = { schemaVersion: 1, kind: 'reviewed-external-nft-journal', enabled: true, available: true, reason: null, deploymentId,
        network: nftExecutionNetwork(manifest), source: { genesisHash: manifest.genesisHash, registry: manifest.registry.address, marketplace: manifest.marketplace.address },
        checkpoint: { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString() }, sync: null, readonly: true, finalized: false, coverage };
      const convert = (row: Record<string, unknown>, resource = selected.resource): unknown => {
        if (resource === 'activity') return action(row, block, manifest);
        const schema = ['collections', 'collection'].includes(resource) ? reviewedCollectionSchema : ['items', 'item', 'wallet-items'].includes(resource) ? reviewedItemSchema : resource === 'listings' ? reviewedListingSchema : reviewedClaimSchema;
        const parsed = schema.safeParse(row.value); if (!parsed.success) return unavailable(); const value = parsed.data, event = position(value, row, block, manifest);
        if (value.kind === 'reviewed-external-erc721') { if (row.entity_id !== value.address || event.collection !== value.address || event.eventName !== (value.active ? 'ReviewAdmitted' : 'ReviewRevoked') || event.args.version !== value.reviewVersion) return unavailable(); }
        else if (value.kind === 'reviewed-external-item') {
          const ownerEvent = action({ entity_id: row.owner_event_id, value: row.owner_event, provenance_number: row.owner_number, provenance_hash: row.owner_hash, provenance_timestamp: row.owner_timestamp }, block, manifest);
          if (row.entity_id !== `${value.collection}:${value.tokenId}` || event.collection !== value.collection || !['Transfer','Listed','Sold','Cancelled'].includes(event.eventName)
            || event.eventName === 'Transfer' && event.args.tokenId !== value.tokenId || ownerEvent.source !== value.collection || ownerEvent.eventName !== 'Transfer' || ownerEvent.args.tokenId !== value.tokenId || ownerEvent.args.to !== value.owner
            || BigInt(ownerEvent.blockNumber) > BigInt(value.lastBlockNumber) || ownerEvent.blockNumber === value.lastBlockNumber && ownerEvent.logIndex > value.lastLogIndex
            || value.activeListingId !== null && (value.owner !== manifest.marketplace.address || value.burned)) return unavailable();
        }
        else if (value.kind === 'reviewed-market-listing') { if (row.entity_id !== `${manifest.marketplace.address}:${value.listingId}` || value.marketplace !== manifest.marketplace.address || event.source !== manifest.marketplace.address || event.collection !== value.collection || event.eventName !== ({ active: 'Listed', sold: 'Sold', cancelled: 'Cancelled' } as const)[value.status] || event.args.listingId !== value.listingId) return unavailable(); }
        else if (row.entity_id !== `${manifest.marketplace.address}:${value.account}` || value.marketplace !== manifest.marketplace.address || event.source !== manifest.marketplace.address || !['Sold', 'Claimed'].includes(event.eventName)) return unavailable();
        return value;
      };
      const data = selected.resource === 'status' ? [] : await rows(client, selected, deploymentId, continuation);
      if (data.length > selected.limit + 1) return unavailable();
      const converted = data.map(row => convert(row)), key = (value: unknown): string[] => {
        if (!object(value)) return unavailable(); return ['collections', 'collection'].includes(selected.resource) ? [String(value.address)] : selected.resource === 'listings' ? [String(value.listingId)] : selected.resource === 'activity' ? [String(value.blockNumber), String(value.logIndex)] : selected.resource === 'claims' ? [String(value.marketplace)] : [String(value.collection), String(value.tokenId)];
      };
      // Duplicate or reversed keys indicate a corrupt projection/query result, never an empty page.
      const keys = converted.map(key), cmp = (left: string[], right: string[]) => selected.resource === 'activity' ? BigInt(left[0]) !== BigInt(right[0]) ? BigInt(left[0]) > BigInt(right[0]) : BigInt(left[1]) > BigInt(right[1])
        : selected.resource === 'listings' ? BigInt(left[0]) > BigInt(right[0]) : left[0] !== right[0] ? left[0] < right[0] : left.length === 2 && BigInt(left[1]) < BigInt(right[1]);
      if (keys.some((value, index) => index === 0 ? continuation && !cmp(continuation.after, value) : !cmp(keys[index - 1], value))) return unavailable();
      let result: unknown;
      if (selected.resource === 'status') result = { context };
      else if (selected.resource === 'collection') { if (converted.length !== 1 || !object(converted[0]) || converted[0].address !== selected.collection) return missing(); result = { context, collection: converted[0] }; }
      else if (selected.resource === 'item') {
        if (converted.length !== 1 || !object(converted[0]) || converted[0].collection !== selected.collection || converted[0].tokenId !== selected.tokenId) return missing();
        const activeId = reviewedItemSchema.parse(converted[0]).activeListingId;
        const matches = activeId ? await rows(client, { resource: 'listings', collection: selected.collection, listingId: activeId, status: 'active', limit: 1, scope: '' }, deploymentId, null) : [];
        if (activeId && matches.length !== 1) return unavailable();
        const listing = matches.length ? convert(matches[0], 'listings') : null;
        if (listing && (!object(listing) || listing.tokenId !== selected.tokenId || listing.collection !== selected.collection || listing.listingId !== activeId || converted[0].owner !== manifest.marketplace.address || converted[0].burned !== false)) return unavailable(); result = { context, item: converted[0], listing };
      } else {
        const page = converted.slice(0, selected.limit), nextCursor = converted.length > selected.limit ? Buffer.from(JSON.stringify({ v: 1, deployment: deploymentId, block: block.number.toString(), hash: block.hash, scope: selected.scope, limit: selected.limit, after: key(page[page.length - 1]) } satisfies Cursor)).toString('base64url') : null;
        result = { context, items: page, nextCursor };
      }
      const height = await client.run(() => source.height()); if (typeof height !== 'bigint' || height < block.number) return stale();
      await client.run(() => source.verify(manifest, block)); const canonical = await client.run(() => source.block(block.number));
      if (canonical.hash !== block.hash || canonical.parentHash !== block.parentHash || canonical.timestamp !== block.timestamp) return stale();
      context.sync = { chainHead: height.toString(), behindBlocks: (height - block.number).toString() }; if (!reviewedContextSchema.safeParse(context).success) return unavailable();
      await client.query('COMMIT'); began = false; return json(result);
    } catch (error) { if (began) await client?.query('ROLLBACK').catch(() => undefined); if (error instanceof ApiError) throw error; return unavailable(); }
    finally { client?.release(); }
  };
}
export const reviewedNftRead = createReviewedNftReader();
