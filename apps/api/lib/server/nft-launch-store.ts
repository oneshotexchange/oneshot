import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Hex } from 'viem';
import type { NftLaunchDraft } from '@oneshot/evm';
import type { NftReview, NftReviewInput } from './nft-launch';
import { database, withLocalNamespace } from './store';
import { ApiError } from './errors';

export const NFT_REVIEW_NAMESPACE = 'oneshot_nft_reviews';
export const NFT_PUBLICATION_NAMESPACE = 'oneshot_nft_publications';
const DAY = 86_400_000;
const CLEANUP_BATCH = 1000;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const HASH = /^0x[\da-f]{64}$/i;
const ADDRESS = /^0x[\da-f]{40}$/i;
const PUBLICATION_KEY = /^[\da-f]{64}:0x[\da-f]{40}$/;
const object = (value: unknown): value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export type StoredNftReview = {
  review: NftReview;
  input: NftReviewInput;
  owner: string;
  session: string;
  createdAt: number;
  transactionHash?: Hex;
  outcome?: 'submitted' | 'confirmed' | 'reverted';
  updatedAt?: string;
  /** Kept server-side only, for publishing a verified immutable launch after confirmation. */
  publicationDraft?: NftLaunchDraft;
};
export type NftPublication = {
  deploymentId: string;
  collection: `0x${string}`;
  draft: NftLaunchDraft;
  termsHash: Hex;
  openHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  creatorUserId?: string;
};
type Options = {
  database?: () => Pool | null;
  retentionMs?: number;
  activeLimit?: number;
  retainedLimit?: number;
};
type ListOptions = { wallet?: string; limit: number; cursor?: string };
type Cursor = { version:1; scope:string; createdAt:number; id:string };
function invalid(message = 'The transaction storage input is invalid.'): never { throw new ApiError(400,'TRANSACTION_INPUT_INVALID',message); }
function integrity(): never { throw new ApiError(503,'TRANSACTION_INTEGRITY','Stored transaction data failed its integrity check.'); }
function notFound(): never { throw new ApiError(404,'REVIEW_NOT_FOUND','The transaction review was not found in this account.'); }
function changed(): never { throw new ApiError(409,'TRANSACTION_CHANGED','This review is already tracking a different transaction.'); }
function timestamp(nowMs: number) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8_640_000_000_000_000) return invalid();
  return nowMs;
}
function ownerValue(owner: string) { if (typeof owner !== 'string' || !owner || owner.length > 256) return invalid(); return owner; }
function hashValue(hash: string): Hex { if (!HASH.test(hash)) return invalid(); return hash.toLowerCase() as Hex; }
function idValue(id: string) { if (typeof id !== 'string' || !UUID.test(id)) return invalid(); return id; }
function stored(value: unknown): StoredNftReview {
  if (!object(value) || !object(value.review) || !object(value.input) || typeof value.owner !== 'string' || !value.owner || value.owner.length > 256
    || typeof value.session !== 'string' || !value.session || value.session.length > 256
    || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0
    || typeof value.review.id !== 'string' || !UUID.test(value.review.id) || typeof value.review.from !== 'string' || !ADDRESS.test(value.review.from)
    || typeof value.review.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.review.expiresAt))
    || Date.parse(value.review.expiresAt) <= Number(value.createdAt) || Date.parse(value.review.expiresAt) > Number(value.createdAt) + 120_000
    || (value.transactionHash !== undefined && (typeof value.transactionHash !== 'string' || !HASH.test(value.transactionHash)))
    || (value.outcome !== undefined && !['submitted','confirmed','reverted'].includes(String(value.outcome)))
    || (value.updatedAt !== undefined && (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))))) return integrity();
  return value as StoredNftReview;
}
function publicationValue(key: string, value: unknown): NftPublication {
  if (!PUBLICATION_KEY.test(key) || !object(value) || typeof value.deploymentId !== 'string' || typeof value.collection !== 'string'
    || key !== `${value.deploymentId}:${value.collection}` || !object(value.draft) || value.draft.status !== 'prepared'
    || typeof value.termsHash !== 'string' || !HASH.test(value.termsHash) || typeof value.openHash !== 'string' || !HASH.test(value.openHash)
    || typeof value.blockHash !== 'string' || !HASH.test(value.blockHash) || typeof value.blockNumber !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value.blockNumber)
    || (value.creatorUserId !== undefined && (typeof value.creatorUserId !== 'string' || !value.creatorUserId || value.creatorUserId.length > 256))) return integrity();
  return value as NftPublication;
}
function encoded(value: unknown, maximum: number) {
  let json: string;
  try { json = JSON.stringify(value); } catch { return invalid(); }
  if (!json || Buffer.byteLength(json) > maximum) return invalid('The transaction storage record exceeds its size limit.');
  return json;
}
function scope(owner: string, wallet?: string) { return createHash('sha256').update(JSON.stringify([owner,wallet ?? ''])).digest('hex'); }
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().filter(key=>value[key] !== undefined).map(key=>[key,canonical(value[key])])) : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function parseCursor(input: string | undefined, owner: string, wallet?: string): Cursor | null {
  if (input === undefined) return null;
  if (typeof input !== 'string' || input.length > 1024 || !/^[\w-]+$/.test(input)) return invalid('Use a valid transaction history cursor.');
  try {
    const bytes = Buffer.from(input,'base64url');
    if (bytes.toString('base64url') !== input) return invalid('Use a valid transaction history cursor.');
    const value = JSON.parse(bytes.toString('utf8'));
    if (!object(value) || Object.keys(value).sort().join(',') !== 'createdAt,id,scope,version' || value.version !== 1
      || value.scope !== scope(owner,wallet) || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0
      || typeof value.id !== 'string' || !UUID.test(value.id)) return invalid('Use a valid transaction history cursor.');
    return value as Cursor;
  } catch (error) { if (error instanceof ApiError) throw error; return invalid('Use a valid transaction history cursor.'); }
}

/** Durable, account-scoped transaction capabilities. No token, key or signature is stored. */
export function createNftLaunchRepository(options: Options = {}) {
  const db = options.database ?? database;
  const retentionMs = options.retentionMs ?? 30 * DAY;
  const activeLimit = options.activeLimit ?? 100;
  const retainedLimit = options.retainedLimit ?? 100_000;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1 || retentionMs > 90 * DAY || !Number.isSafeInteger(activeLimit) || activeLimit < 1
    || !Number.isSafeInteger(retainedLimit) || retainedLimit < 1) throw new Error('Invalid NFT transaction retention limits.');
  const expired = (item: StoredNftReview, nowMs: number) => item.createdAt <= nowMs - retentionMs;
  async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>, lock = false) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (lock) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[NFT_REVIEW_NAMESPACE]);
      const result = await run(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
    finally { client.release(); }
  }
  async function create(input: StoredNftReview, nowMs: number) {
    timestamp(nowMs); const item = structuredClone(stored(input));
    if (item.createdAt > nowMs || expired(item,nowMs) || item.transactionHash || item.outcome) return invalid();
    item.updatedAt = new Date(nowMs).toISOString();
    const json = encoded(item,1_048_576), pool = db();
    const check = (total:number,active:number) => {
      if (total >= retainedLimit || active >= activeLimit) throw new ApiError(429,'REVIEW_LIMIT','The transaction review limit has been reached. Retry after active reviews expire.');
    };
    if (pool) return transaction(pool,async client => {
      // A bounded cleanup only touches this namespace. Retained counting excludes any
      // remaining expired rows, so a large old batch cannot hold capacity hostage.
      await client.query(`DELETE FROM b20_app_records WHERE namespace=$1 AND id IN (SELECT id FROM b20_app_records WHERE namespace=$1 AND (value->>'createdAt')::bigint <= $2 ORDER BY (value->>'createdAt')::bigint,id LIMIT ${CLEANUP_BATCH})`,[NFT_REVIEW_NAMESPACE,nowMs-retentionMs]);
      const counts = await client.query(`SELECT count(*)::integer AS total, count(*) FILTER (WHERE value->>'owner'=$3 AND value->>'transactionHash' IS NULL AND (value->'review'->>'expiresAt')::timestamptz > $4::timestamptz)::integer AS active FROM b20_app_records WHERE namespace=$1 AND (value->>'createdAt')::bigint > $2`,[NFT_REVIEW_NAMESPACE,nowMs-retentionMs,item.owner,new Date(nowMs).toISOString()]);
      check(counts.rows[0].total,counts.rows[0].active);
      const result = await client.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,id) DO NOTHING',[NFT_REVIEW_NAMESPACE,item.review.id,json]);
      if (result.rowCount !== 1) throw new ApiError(409,'REVIEW_EXISTS','This transaction review already exists.');
    },true);
    return withLocalNamespace<StoredNftReview,void>(NFT_REVIEW_NAMESPACE,records => {
      let removed = 0;
      for (const [id,value] of Object.entries(records)) if (expired(stored(value),nowMs) && removed++ < CLEANUP_BATCH) delete records[id];
      const retained = Object.values(records).map(stored).filter(value=>!expired(value,nowMs));
      check(retained.length,retained.filter(value=>value.owner === item.owner && !value.transactionHash && Date.parse(value.review.expiresAt) > nowMs).length);
      if (records[item.review.id]) throw new ApiError(409,'REVIEW_EXISTS','This transaction review already exists.');
      records[item.review.id] = JSON.parse(json);
    },true);
  }
  async function get(id: string, nowMs = Date.now()) {
    idValue(id); timestamp(nowMs); const pool = db();
    const value = pool ? (await pool.query('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2',[NFT_REVIEW_NAMESPACE,id])).rows[0]?.value
      : await withLocalNamespace<StoredNftReview,StoredNftReview|undefined>(NFT_REVIEW_NAMESPACE,records=>records[id],false);
    if (!value) return null;
    const item = stored(value); return expired(item,nowMs) ? null : structuredClone(item);
  }
  async function mutate(id: string, nowMs: number, transform: (item: StoredNftReview) => StoredNftReview) {
    idValue(id); timestamp(nowMs); const pool = db();
    const apply = (value: unknown) => {
      if (!value) return notFound(); const item = stored(value);
      if (expired(item,nowMs)) return notFound();
      return transform(structuredClone(item));
    };
    if (pool) return transaction(pool,async client => {
      const previous = await client.query('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2 FOR UPDATE',[NFT_REVIEW_NAMESPACE,id]);
      const item = apply(previous.rows[0]?.value);
      await client.query('UPDATE b20_app_records SET value=$3::jsonb,updated_at=now() WHERE namespace=$1 AND id=$2',[NFT_REVIEW_NAMESPACE,id,encoded(item,1_048_576)]);
      return item;
    });
    return withLocalNamespace<StoredNftReview,StoredNftReview>(NFT_REVIEW_NAMESPACE,records=>{
      const item = apply(records[id]); records[id] = item; return structuredClone(item);
    },true);
  }
  async function bindHash(id: string, owner: string, hash: Hex, nowMs: number) {
    ownerValue(owner); hash = hashValue(hash);
    return mutate(id,nowMs,item=>{
      if (item.owner !== owner) return notFound();
      if (item.transactionHash && item.transactionHash !== hash) return changed();
      if (!item.transactionHash) { item.transactionHash = hash; item.outcome = 'submitted'; item.updatedAt = new Date(nowMs).toISOString(); }
      return item;
    });
  }
  async function setOutcome(id: string, hash: Hex, outcome: 'submitted'|'confirmed'|'reverted', nowMs: number) {
    hash = hashValue(hash);
    if (!['submitted','confirmed','reverted'].includes(outcome)) return invalid();
    await mutate(id,nowMs,item=>{
      if (item.transactionHash !== hash) return changed();
      item.outcome = outcome; item.updatedAt = new Date(nowMs).toISOString(); return item;
    });
  }
  async function list(owner: string, input: ListOptions, nowMs: number) {
    ownerValue(owner); timestamp(nowMs);
    if (!input || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50 || (input.wallet !== undefined && !ADDRESS.test(input.wallet))) return invalid();
    const wallet = input.wallet?.toLowerCase(), cursor = parseCursor(input.cursor,owner,wallet), pool = db();
    let items: StoredNftReview[];
    if (pool) {
      const rows = await pool.query(`SELECT value FROM b20_app_records WHERE namespace=$1 AND value->>'owner'=$2 AND (value->>'createdAt')::bigint > $3 AND ($4::text IS NULL OR lower(value->'review'->>'from')=$4) AND ($5::bigint IS NULL OR ((value->>'createdAt')::bigint,id) < ($5::bigint,$6::text)) ORDER BY (value->>'createdAt')::bigint DESC,id DESC LIMIT $7`,[NFT_REVIEW_NAMESPACE,owner,nowMs-retentionMs,wallet ?? null,cursor?.createdAt ?? null,cursor?.id ?? null,input.limit+1]);
      items = rows.rows.map(row=>stored(row.value));
    } else items = await withLocalNamespace<StoredNftReview,StoredNftReview[]>(NFT_REVIEW_NAMESPACE,records=>Object.values(records).map(stored)
      .filter(item=>item.owner === owner && !expired(item,nowMs) && (!wallet || item.review.from.toLowerCase() === wallet)
        && (!cursor || item.createdAt < cursor.createdAt || item.createdAt === cursor.createdAt && item.review.id < cursor.id))
      .sort((a,b)=>b.createdAt-a.createdAt || b.review.id.localeCompare(a.review.id)).slice(0,input.limit+1),false);
    const more = items.length > input.limit, page = items.slice(0,input.limit), last = page.at(-1);
    return {items:structuredClone(page),...(more && last ? {nextCursor:Buffer.from(JSON.stringify({version:1,scope:scope(owner,wallet),createdAt:last.createdAt,id:last.review.id} satisfies Cursor)).toString('base64url')} : {})};
  }
  async function publish(key: string, input: NftPublication, expectedPrevious?: NftPublication) {
    const item = structuredClone(publicationValue(key,input)), json = encoded(item,1_048_576), pool = db();
    if (expectedPrevious !== undefined) publicationValue(key,expectedPrevious);
    const check = (previous: unknown) => {
      // The service may replace an orphaned launch only after proving its old
      // block noncanonical. Comparing the full previous record keeps that repair atomic.
      if (expectedPrevious !== undefined) {
        if (!previous || !sameJson(previous,expectedPrevious)) throw new ApiError(409,'PUBLICATION_CHANGED','The published launch changed during reconciliation.');
        return;
      }
      if (!previous) return;
      const old = publicationValue(key,previous);
      if (old.termsHash !== item.termsHash || old.creatorUserId !== item.creatorUserId || old.draft.creatorWallet?.toLowerCase() !== item.draft.creatorWallet?.toLowerCase()
        || old.draft.snapshot?.contentHash !== item.draft.snapshot?.contentHash) throw new ApiError(409,'PUBLICATION_CHANGED','A different immutable launch is already published for this collection.');
    };
    if (pool) return transaction(pool,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${NFT_PUBLICATION_NAMESPACE}:${key}`]);
      const previous = await client.query('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2',[NFT_PUBLICATION_NAMESPACE,key]); check(previous.rows[0]?.value);
      await client.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()',[NFT_PUBLICATION_NAMESPACE,key,json]);
    });
    return withLocalNamespace<NftPublication,void>(NFT_PUBLICATION_NAMESPACE,records=>{check(records[key]);records[key]=JSON.parse(json);},true);
  }
  async function publication(key: string) {
    if (!PUBLICATION_KEY.test(key)) return invalid(); const pool = db();
    const value = pool ? (await pool.query('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2',[NFT_PUBLICATION_NAMESPACE,key])).rows[0]?.value
      : await withLocalNamespace<NftPublication,NftPublication|undefined>(NFT_PUBLICATION_NAMESPACE,records=>records[key],false);
    return value ? structuredClone(publicationValue(key,value)) : null;
  }
  return {create,get,bindHash,setOutcome,list,publish,publication};
}
export type NftLaunchRepository = ReturnType<typeof createNftLaunchRepository>;
export const nftLaunchRepository = createNftLaunchRepository();
