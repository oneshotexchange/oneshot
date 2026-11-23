import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { Hex } from 'viem';
import { reviewedNftCanonicalReceiptSchema, reviewedNftExecutionInputSchema, reviewedNftExecutionReviewSchema, type ReviewedNftExecutionReview } from '../../../web/lib/reviewed-nft-execution';
import { database, withLocalNamespace } from './store';
import { stableJson } from './media';
import { ApiError } from './errors';

export const REVIEWED_NFT_EXECUTION_NAMESPACE = 'oneshot_reviewed_nft_reviews';
const DAY = 86_400_000, RETENTION = 30 * DAY, MAX_RECORD_BYTES = 1024 * 1024;
const hash = z.string().regex(/^0x[a-f0-9]{64}$/).refine(value => !/^0x0{64}$/.test(value)).transform(value => value as Hex);
const ownerSchema = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const moment = z.number().int().min(0).max(8_640_000_000_000_000).refine(Number.isSafeInteger);
const receiptSchema = reviewedNftCanonicalReceiptSchema;
export type ReviewedNftCanonicalReceipt = z.infer<typeof receiptSchema>;
const recordSchema = z.object({
  schemaVersion: z.literal(1), owner: ownerSchema, session: z.string().min(1).max(256), createdAt: moment,
  review: reviewedNftExecutionReviewSchema, input: reviewedNftExecutionInputSchema,
  transactionHash: hash.nullable(), outcome: z.enum(['review', 'submitted', 'confirmed', 'reverted']), updatedAt: z.string().datetime(),
  canonicalReceipt: receiptSchema.nullable().default(null),
}).strict().superRefine((value, context) => {
  const expiry = Date.parse(value.review.expiresAt), terminal = value.outcome === 'confirmed' || value.outcome === 'reverted';
  if (expiry <= value.createdAt || expiry > value.createdAt + 120_000 || Date.parse(value.updatedAt) < value.createdAt
    || (value.outcome === 'review') !== (value.transactionHash === null) || terminal !== (value.canonicalReceipt !== null)
    || value.input.action !== value.review.action || value.input.from !== value.review.from
    || value.input.expectedChainId !== value.review.chainId || value.input.expectedDeploymentId !== value.review.deploymentId)
    context.addIssue({ code: 'custom', message: 'Inconsistent execution record.' });
  const input = value.input, review = value.review;
  let matches = true;
  if (input.action !== 'claim' && review.action !== 'claim') matches &&= input.collection === review.terms.collection && input.tokenId === review.terms.tokenId;
  if (input.action === 'buy' && review.action === 'buy') matches &&= input.listingId === review.terms.listingId && input.recipient === review.terms.recipient && input.expectedTotalPriceRaw === review.terms.totalPriceRaw;
  if (input.action === 'cancel' && review.action === 'cancel') matches &&= input.listingId === review.terms.listingId && input.recipient === review.terms.recipient;
  if (input.action === 'claim' && review.action === 'claim') matches &&= input.recipient === review.terms.recipient;
  if (input.action === 'list' && review.action === 'list') {
    const [whole, fraction = ''] = input.price.split('.');
    matches &&= BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0')) === BigInt(review.terms.totalPriceRaw);
  }
  if (!matches) context.addIssue({ code: 'custom', message: 'Execution input does not match the immutable review.' });
});
export type StoredReviewedNftExecution = z.infer<typeof recordSchema>;
type ReceiptOutcome = 'submitted' | 'confirmed' | 'reverted';
const reservationSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('transaction-reservation'), owner: ownerSchema,
  deploymentId: z.string().regex(/^[a-f0-9]{64}$/), transactionHash: hash, reviewId: z.string().uuid(), reviewHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: moment }).strict();
type Reservation = z.infer<typeof reservationSchema>;
const integrity = (): never => { throw new ApiError(503, 'REVIEWED_NFT_REVIEW_INTEGRITY', 'This saved transaction review could not be verified. Please try again.'); };
const missing = (): never => { throw new ApiError(404, 'REVIEWED_NFT_REVIEW_NOT_FOUND', 'This transaction review was not found in your account.'); };
const changed = (): never => { throw new ApiError(409, 'REVIEWED_NFT_TRANSACTION_CHANGED', 'This review is already tracking another transaction or receipt. Reload its saved status.'); };
const invalid = (): never => { throw new ApiError(400, 'REVIEWED_NFT_REVIEW_INVALID', 'Use a valid, fresh transaction review and transaction reference.'); };
const limit = (): never => { throw new ApiError(429, 'REVIEWED_NFT_REVIEW_LIMIT', 'You have several active transaction reviews. Check submitted transactions or wait for a review to expire.'); };

/** The shared wire schema is parsed before hashing; JSON key order is not authority. */
export function reviewedNftReviewHash(review: Omit<ReviewedNftExecutionReview, 'reviewHash'>): string {
  return createHash('sha256').update(stableJson(review)).digest('hex');
}
function parse(raw: unknown): StoredReviewedNftExecution {
  const parsed = recordSchema.safeParse(raw); if (!parsed.success) return integrity();
  const { reviewHash, ...unsigned } = parsed.data.review;
  if (reviewedNftReviewHash(unsigned) !== reviewHash) return integrity();
  return parsed.data;
}
function encode(value: unknown) { const json = JSON.stringify(value); if (Buffer.byteLength(json) > MAX_RECORD_BYTES) return invalid(); return json; }
function nowTime(value: number) { if (!moment.safeParse(value).success) return invalid(); return value; }
function live(value: StoredReviewedNftExecution, now: number) { return value.outcome === 'submitted' || value.createdAt > now - RETENTION; }
function active(value: StoredReviewedNftExecution, now: number) { return value.outcome === 'submitted' || value.outcome === 'review' && Date.parse(value.review.expiresAt) > now; }
const same = (left: unknown, right: unknown) => stableJson(left) === stableJson(right);
const reservationId = (owner: string, deployment: string, transactionHash: Hex) => `tx:${createHash('sha256').update(JSON.stringify([owner, deployment, transactionHash])).digest('hex')}`;
type Options = { pool?: () => Pool | null; now?: () => number; activeLimit?: number; retainedLimit?: number };
type ListOptions = { wallet?: string; limit?: number; cursor?: string };

/** Independent account-private reviews. Submitted rows and hash reservations are never retention-cleaned.
 * The source service alone proves receipts/reorgs; this store never signs, reads RPC or submits transactions. */
export function createReviewedNftExecutionStore(options: Options = {}) {
  const pool = options.pool ?? database, clock = options.now ?? Date.now, activeLimit = options.activeLimit ?? 100, retainedLimit = options.retainedLimit ?? 100_000;
  if (!Number.isSafeInteger(activeLimit) || activeLimit < 1 || activeLimit > 100 || !Number.isSafeInteger(retainedLimit) || retainedLimit < activeLimit) throw new TypeError('Invalid execution review capacity.');
  const time = () => nowTime(clock());
  async function transaction<T>(db: Pool, owner: string, run: (client: PoolClient) => Promise<T>) {
    const client = await db.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='5000ms'"); await client.query("SET LOCAL lock_timeout='3000ms'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${REVIEWED_NFT_EXECUTION_NAMESPACE}:${owner}`]);
      const result = await run(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  function owned(raw: unknown, id: string, owner: string, now: number) {
    if (!raw || !objectOwner(raw, owner)) return missing(); const record = parse(raw);
    if (record.review.id !== id || !live(record, now)) return missing(); return record;
  }
  async function get(id: string, owner: string) {
    if (!z.string().uuid().safeParse(id).success || !ownerSchema.safeParse(owner).success) return missing();
    const now = time(), db = pool(), raw = db ? (await db.query('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2', [REVIEWED_NFT_EXECUTION_NAMESPACE, id])).rows[0]?.value
      : await withLocalNamespace<unknown, unknown>(REVIEWED_NFT_EXECUTION_NAMESPACE, records => records[id], false);
    return structuredClone(owned(raw, id, owner, now));
  }
  async function save(raw: StoredReviewedNftExecution) {
    const now = time(), record = parse(structuredClone(raw));
    if (record.createdAt > now || !live(record, now) || record.outcome !== 'review' || record.transactionHash !== null || record.canonicalReceipt !== null || Date.parse(record.review.expiresAt) <= now) return invalid();
    const bytes = encode(record), db = pool();
    if (db) await transaction(db, record.owner, async client => {
      await client.query("DELETE FROM b20_app_records WHERE namespace=$1 AND id IN (SELECT id FROM b20_app_records WHERE namespace=$1 AND id NOT LIKE 'tx:%' AND value->>'outcome' IN ('review','confirmed','reverted') AND (value->>'createdAt')::bigint<=$2 ORDER BY (value->>'createdAt')::bigint,id LIMIT 1000)", [REVIEWED_NFT_EXECUTION_NAMESPACE, now - RETENTION]);
      const count = (await client.query("SELECT count(*)::integer AS retained,count(*) FILTER (WHERE value->>'owner'=$3 AND (value->>'outcome'='submitted' OR value->>'outcome'='review' AND (value->'review'->>'expiresAt')::timestamptz>$4::timestamptz))::integer AS active FROM b20_app_records WHERE namespace=$1 AND id NOT LIKE 'tx:%' AND (value->>'outcome'='submitted' OR (value->>'createdAt')::bigint>$2)", [REVIEWED_NFT_EXECUTION_NAMESPACE, now - RETENTION, record.owner, new Date(now).toISOString()])).rows[0];
      if (!Number.isSafeInteger(count?.retained) || !Number.isSafeInteger(count?.active)) return integrity();
      if (Number(count.retained) >= retainedLimit || Number(count.active) >= activeLimit) return limit();
      const result = await client.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,id) DO NOTHING RETURNING id', [REVIEWED_NFT_EXECUTION_NAMESPACE, record.review.id, bytes]);
      if (result.rowCount !== 1) throw new ApiError(409, 'REVIEWED_NFT_REVIEW_EXISTS', 'This review already exists. Create a new review.');
    });
    else await withLocalNamespace<unknown, void>(REVIEWED_NFT_EXECUTION_NAMESPACE, records => {
      let removed = 0; for (const [id, value] of Object.entries(records)) if (!id.startsWith('tx:') && !live(parse(value), now) && removed++ < 1000) delete records[id];
      const all = Object.entries(records).filter(([id]) => !id.startsWith('tx:')).map(([, value]) => parse(value)).filter(value => live(value, now));
      if (all.length >= retainedLimit || all.filter(value => value.owner === record.owner && active(value, now)).length >= activeLimit) return limit();
      if (records[record.review.id]) throw new ApiError(409, 'REVIEWED_NFT_REVIEW_EXISTS', 'This review already exists. Create a new review.'); records[record.review.id] = JSON.parse(bytes);
    }, true);
    return structuredClone(record);
  }
  function reservation(raw: unknown, record: StoredReviewedNftExecution, transactionHash: Hex, now: number): Reservation {
    if (raw !== undefined && raw !== null) {
      const parsed = reservationSchema.safeParse(raw); if (!parsed.success) return integrity();
      if (parsed.data.owner !== record.owner || parsed.data.deploymentId !== record.review.deploymentId || parsed.data.transactionHash !== transactionHash
        || parsed.data.reviewId !== record.review.id || parsed.data.reviewHash !== record.review.reviewHash) return changed();
      return parsed.data;
    }
    return { schemaVersion: 1, kind: 'transaction-reservation', owner: record.owner, deploymentId: record.review.deploymentId, transactionHash, reviewId: record.review.id, reviewHash: record.review.reviewHash, createdAt: now };
  }
  async function mutate(id: string, owner: string, rawHash: Hex, transform: (record: StoredReviewedNftExecution, now: number) => StoredReviewedNftExecution) {
    if (!z.string().uuid().safeParse(id).success || !ownerSchema.safeParse(owner).success || !hash.safeParse(rawHash).success) return invalid();
    const now = time(), db = pool();
    if (db) return transaction(db, owner, async client => {
      const previousRaw = (await client.query('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2 FOR UPDATE', [REVIEWED_NFT_EXECUTION_NAMESPACE, id])).rows[0]?.value;
      const previous = owned(previousRaw, id, owner, now), key = reservationId(owner, previous.review.deploymentId, rawHash);
      if (previous.transactionHash && previous.transactionHash !== rawHash) return changed();
      const existing = (await client.query('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2', [REVIEWED_NFT_EXECUTION_NAMESPACE, key])).rows[0]?.value;
      if (previous.transactionHash && existing == null) return integrity();
      const reserved = reservation(existing, previous, rawHash, now), next = parse(transform(structuredClone(previous), now));
      if (!existing) await client.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3::jsonb)', [REVIEWED_NFT_EXECUTION_NAMESPACE, key, JSON.stringify(reserved)]);
      const updated = await client.query('UPDATE b20_app_records SET value=$3::jsonb,updated_at=now() WHERE namespace=$1 AND id=$2 AND value=$4::jsonb', [REVIEWED_NFT_EXECUTION_NAMESPACE, id, encode(next), JSON.stringify(previousRaw)]);
      if (updated.rowCount !== 1) return changed(); return structuredClone(next);
    });
    return withLocalNamespace<unknown, StoredReviewedNftExecution>(REVIEWED_NFT_EXECUTION_NAMESPACE, records => {
      const previous = owned(records[id], id, owner, now); if (previous.transactionHash && previous.transactionHash !== rawHash) return changed();
      const key = reservationId(owner, previous.review.deploymentId, rawHash); if (previous.transactionHash && records[key] == null) return integrity();
      const reserved = reservation(records[key], previous, rawHash, now), next = parse(transform(structuredClone(previous), now));
      encode(next); records[key] = reserved; records[id] = next; return structuredClone(next);
    }, true);
  }
  async function attach(id: string, owner: string, transactionHash: Hex) {
    return mutate(id, owner, transactionHash, (previous, now) => previous.transactionHash ? previous : { ...previous, transactionHash, outcome: 'submitted', updatedAt: new Date(now).toISOString() });
  }
  async function settle(id: string, owner: string, transactionHash: Hex, outcome: ReceiptOutcome, updatedAt?: string, canonicalReceipt?: ReviewedNftCanonicalReceipt | null) {
    if (!['submitted', 'confirmed', 'reverted'].includes(outcome) || updatedAt !== undefined && !z.string().datetime().safeParse(updatedAt).success) return invalid();
    if (outcome !== 'submitted' && !receiptSchema.safeParse(canonicalReceipt).success || outcome === 'submitted' && canonicalReceipt !== undefined && canonicalReceipt !== null) return invalid();
    return mutate(id, owner, transactionHash, (previous, now) => {
      if (previous.transactionHash !== transactionHash) return changed();
      const terminal = previous.outcome === 'confirmed' || previous.outcome === 'reverted';
      // A late pending lookup cannot erase a proven receipt. Explicit null is the service's reorg reset.
      if (outcome === 'submitted' && terminal && canonicalReceipt === undefined) return previous;
      if (outcome !== 'submitted' && terminal) { if (previous.outcome !== outcome || !same(previous.canonicalReceipt, canonicalReceipt)) return changed(); return previous; }
      const nextTime = updatedAt ?? new Date(now).toISOString(); if (Date.parse(nextTime) < Date.parse(previous.updatedAt) || Date.parse(nextTime) > now) return changed();
      return { ...previous, outcome, canonicalReceipt: outcome === 'submitted' ? null : canonicalReceipt!, updatedAt: nextTime };
    });
  }
  async function list(owner: string, input: ListOptions = {}) {
    if (!ownerSchema.safeParse(owner).success) return invalid(); const now = time(), size = input.limit ?? 20;
    if (!Number.isInteger(size) || size < 1 || size > 50 || input.wallet !== undefined && (!/^0x[\da-fA-F]{40}$/.test(input.wallet) || /^0x0{40}$/i.test(input.wallet))) return invalid();
    const wallet = input.wallet?.toLowerCase(), scope = createHash('sha256').update(JSON.stringify([owner, wallet ?? '', size])).digest('hex'); let after: { createdAt: number; id: string } | null = null;
    if (input.cursor !== undefined) {
      try { const encoded = input.cursor; if (!encoded || encoded.length > 2048 || !/^[\w-]+$/.test(encoded)) return invalid(); const bytes = Buffer.from(encoded, 'base64url'); if (bytes.toString('base64url') !== encoded) return invalid(); const value = z.object({ v: z.literal(1), scope: z.literal(scope), createdAt: moment, id: z.string().uuid() }).strict().parse(JSON.parse(bytes.toString('utf8'))); after = { createdAt: value.createdAt, id: value.id }; }
      catch { return invalid(); }
    }
    const db = pool(); let rows: StoredReviewedNftExecution[];
    if (db) rows = (await db.query("SELECT id,value FROM b20_app_records WHERE namespace=$1 AND id NOT LIKE 'tx:%' AND value->>'owner'=$2 AND (value->>'outcome'='submitted' OR (value->>'createdAt')::bigint>$3) AND ($4::text IS NULL OR value->'review'->>'from'=$4) AND ($5::bigint IS NULL OR ((value->>'createdAt')::bigint,id)<($5::bigint,$6::text)) ORDER BY (value->>'createdAt')::bigint DESC,id DESC LIMIT $7", [REVIEWED_NFT_EXECUTION_NAMESPACE, owner, now - RETENTION, wallet ?? null, after?.createdAt ?? null, after?.id ?? null, size + 1])).rows.map(row => { const item = parse(row.value); if (row.id !== item.review.id || item.owner !== owner || !live(item, now) || wallet && item.review.from !== wallet) return integrity(); return item; });
    else rows = await withLocalNamespace<unknown, StoredReviewedNftExecution[]>(REVIEWED_NFT_EXECUTION_NAMESPACE, records => Object.entries(records).filter(([id, value]) => !id.startsWith('tx:') && objectOwner(value, owner)).map(([, value]) => parse(value))
      .filter(item => live(item, now) && (!wallet || item.review.from === wallet) && (!after || item.createdAt < after.createdAt || item.createdAt === after.createdAt && item.review.id < after.id))
      .sort((a, b) => b.createdAt - a.createdAt || b.review.id.localeCompare(a.review.id)).slice(0, size + 1), false);
    const page = rows.slice(0, size), last = page.at(-1), nextCursor = rows.length > size && last ? Buffer.from(JSON.stringify({ v: 1, scope, createdAt: last.createdAt, id: last.review.id })).toString('base64url') : null;
    return { items: structuredClone(page), nextCursor };
  }
  return { save, get, list, attach, settle };
}
function objectOwner(raw: unknown, owner: string): boolean { return !!raw && typeof raw === 'object' && 'owner' in raw && raw.owner === owner; }
export const reviewedNftExecutionStore = createReviewedNftExecutionStore();
