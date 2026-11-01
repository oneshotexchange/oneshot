import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ApiError } from './errors';
import { database, withLocalNamespace } from './store';
import { NFT_REVIEW_NAMESPACE, type StoredNftReview } from './nft-launch-store';

export const NFT_LAUNCH_NAMESPACE = 'oneshot_nft_launches';
const uuid = z.string().uuid();
const address = z.string().regex(/^0x[\da-f]{40}$/).refine(value => !/^0x0{40}$/.test(value));
const hash = z.string().regex(/^0x[\da-f]{64}$/);
const integer = z.number().int().nonnegative().max(8_640_000_000_000_000);
const associationSchema = z.object({
  version: z.literal(1), id: uuid, owner: z.string().min(1).max(256), draftId: uuid,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), deploymentId: z.string().regex(/^[a-f0-9]{64}$/),
  from: address, collection: address, createHash: hash,
  blockNumber: z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(value => BigInt(value) < 2n ** 256n), blockHash: hash, createdAt: integer,
}).strict();
export type NftLaunchAssociation = z.infer<typeof associationSchema>;
type Selection = { draftId: string; revision: number; deploymentId: string; from: string };
type PageSelection = Selection & { limit: number; cursor?: string };
type Cursor = { v: 1; scope: string; createdAt: number; id: string };
const invalid = (): never => { throw new ApiError(400, 'LAUNCH_PROGRESS_INPUT_INVALID', 'Use a valid saved launch selection.'); };
const integrity = (): never => { throw new ApiError(503, 'LAUNCH_PROGRESS_INTEGRITY', 'Saved launch progress is unavailable.'); };
const changed = (): never => { throw new ApiError(409, 'LAUNCH_ASSOCIATION_CHANGED', 'This saved launch changed. Refresh before continuing.'); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function association(value: unknown): NftLaunchAssociation {
  const result = associationSchema.safeParse(value); return result.success ? result.data : integrity();
}
function select(owner: string, input: Selection) {
  if (typeof owner !== 'string' || !owner || owner.length > 256 || !input || !uuid.safeParse(input.draftId).success
    || !Number.isSafeInteger(input.revision) || input.revision < 1 || !/^[a-f0-9]{64}$/.test(input.deploymentId)
    || !address.safeParse(input.from).success) return invalid();
  return createHash('sha256').update(JSON.stringify([owner, input.draftId, input.revision, input.deploymentId, input.from])).digest('hex');
}
function decodeCursor(value: string | undefined, scope: string): Cursor | null {
  if (value === undefined) return null;
  if (!value || value.length > 512 || !/^[\w-]+$/.test(value)) return invalid();
  try {
    const bytes = Buffer.from(value, 'base64url'); if (bytes.toString('base64url') !== value) return invalid();
    const cursor = z.object({ v: z.literal(1), scope: z.literal(scope), createdAt: integer, id: uuid }).strict().parse(JSON.parse(bytes.toString('utf8')));
    return cursor;
  } catch { return invalid(); }
}
const matches = (item: NftLaunchAssociation, owner: string, input: Selection) => item.owner === owner && item.draftId === input.draftId
  && item.revision === input.revision && item.deploymentId === input.deploymentId && item.from === input.from;
const same = (a: NftLaunchAssociation, b: NftLaunchAssociation) => JSON.stringify(a) === JSON.stringify(b);

/** Permanent create associations are separate from the 30-day transaction-review store. */
export function createNftLaunchProgressRepository(options: { database?: () => Pool | null } = {}) {
  const db = options.database ?? database;
  async function get(id: string): Promise<NftLaunchAssociation | null> {
    if (!uuid.safeParse(id).success) return invalid();
    const pool = db();
    const value = pool ? (await pool.query('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2', [NFT_LAUNCH_NAMESPACE, id])).rows[0]?.value
      : await withLocalNamespace<NftLaunchAssociation, NftLaunchAssociation | undefined>(NFT_LAUNCH_NAMESPACE, records => records[id], false);
    if (!value) return null;
    const result = association(value); return result.id === id ? result : integrity();
  }
  async function save(value: NftLaunchAssociation, expectedPrevious?: NftLaunchAssociation): Promise<void> {
    const item = association(value), expected = expectedPrevious === undefined ? undefined : association(expectedPrevious);
    const check = (old: unknown) => {
      if (!old) { if (expected !== undefined) return changed(); return; }
      const previous = association(old);
      if (same(previous, item)) return;
      if (!expected || !same(previous, expected)) return changed();
      // Only canonical reorg reconciliation may replace collection/block provenance.
      for (const key of ['id', 'owner', 'draftId', 'revision', 'deploymentId', 'from', 'createHash', 'createdAt'] as const)
        if (previous[key] !== item[key]) return changed();
    };
    const pool = db();
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${NFT_LAUNCH_NAMESPACE}:${item.id}`]);
        const previous = await client.query('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2', [NFT_LAUNCH_NAMESPACE, item.id]);
        check(previous.rows[0]?.value);
        await client.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()', [NFT_LAUNCH_NAMESPACE, item.id, JSON.stringify(item)]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      finally { client.release(); }
    } else await withLocalNamespace<NftLaunchAssociation, void>(NFT_LAUNCH_NAMESPACE, records => { check(records[item.id]); records[item.id] = item; }, true);
  }
  async function list(owner: string, input: PageSelection) {
    const scope = select(owner, input);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10) return invalid();
    const cursor = decodeCursor(input.cursor, scope), pool = db();
    let items: NftLaunchAssociation[];
    if (pool) {
      const rows = await pool.query(`SELECT value FROM b20_app_records WHERE namespace=$1 AND value->>'owner'=$2 AND value->>'draftId'=$3 AND (value->>'revision')::bigint=$4 AND value->>'deploymentId'=$5 AND value->>'from'=$6 AND ($7::bigint IS NULL OR ((value->>'createdAt')::bigint,id) < ($7::bigint,$8::text)) ORDER BY (value->>'createdAt')::bigint DESC,id DESC LIMIT $9`, [NFT_LAUNCH_NAMESPACE, owner, input.draftId, input.revision, input.deploymentId, input.from, cursor?.createdAt ?? null, cursor?.id ?? null, input.limit + 1]);
      items = rows.rows.map(row => association(row.value));
    } else items = await withLocalNamespace<unknown, NftLaunchAssociation[]>(NFT_LAUNCH_NAMESPACE, records => Object.entries(records)
      .filter(([, item]) => object(item) && item.owner === owner && item.draftId === input.draftId && item.revision === input.revision && item.deploymentId === input.deploymentId && item.from === input.from)
      .map(([id, value]) => { const item = association(value); return item.id === id ? item : integrity(); })
      .filter(item => matches(item, owner, input) && (!cursor || item.createdAt < cursor.createdAt || item.createdAt === cursor.createdAt && item.id < cursor.id))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).slice(0, input.limit + 1), false);
    const page = items.slice(0, input.limit), last = page.at(-1);
    return { items: page, nextCursor: items.length > input.limit && last ? Buffer.from(JSON.stringify({ v: 1, scope, createdAt: last.createdAt, id: last.id } satisfies Cursor)).toString('base64url') : null };
  }
  async function pending(owner: string, input: Selection, nowMs: number) {
    select(owner, input); if (!Number.isSafeInteger(nowMs) || nowMs < 0) return invalid();
    const minimum = nowMs - 30 * 86_400_000, pool = db();
    const wanted = (item: StoredNftReview) => {
      if (!object(item) || item.owner !== owner) return false;
      if (!object(item.review) || !integer.safeParse(item.createdAt).success) return integrity();
      return item.createdAt > minimum && (item.review.scope || 'draft') === 'draft'
        && item.review.action === 'create' && item.review.draftId === input.draftId && item.review.revision === input.revision
        && item.review.deploymentId === input.deploymentId && item.review.from === input.from && !!item.transactionHash && item.outcome !== 'reverted';
    };
    let records: StoredNftReview[];
    if (pool) {
      const rows = await pool.query(`SELECT r.value FROM b20_app_records r WHERE r.namespace=$1 AND r.value->>'owner'=$2 AND r.value->'review'->>'draftId'=$3 AND (r.value->'review'->>'revision')::bigint=$4 AND r.value->'review'->>'deploymentId'=$5 AND r.value->'review'->>'from'=$6 AND COALESCE(r.value->'review'->>'scope','draft')='draft' AND r.value->'review'->>'action'='create' AND r.value->>'transactionHash' IS NOT NULL AND COALESCE(r.value->>'outcome','submitted')<>'reverted' AND (r.value->>'createdAt')::bigint>$7 AND NOT EXISTS(SELECT 1 FROM b20_app_records a WHERE a.namespace=$8 AND a.id=r.id) ORDER BY (r.value->>'createdAt')::bigint DESC,r.id DESC LIMIT 10`, [NFT_REVIEW_NAMESPACE, owner, input.draftId, input.revision, input.deploymentId, input.from, minimum, NFT_LAUNCH_NAMESPACE]);
      records = rows.rows.map(row => row.value);
    } else {
      const associated = new Set(await withLocalNamespace<NftLaunchAssociation, string[]>(NFT_LAUNCH_NAMESPACE, values => Object.keys(values), false));
      records = await withLocalNamespace<StoredNftReview, StoredNftReview[]>(NFT_REVIEW_NAMESPACE, values => Object.values(values)
        .filter(item => wanted(item) && !associated.has(item.review.id)).sort((a, b) => b.createdAt - a.createdAt || b.review.id.localeCompare(a.review.id)).slice(0, 10), false);
    }
    return records.map(item => {
      if (!wanted(item) || !uuid.safeParse(item.review.id).success || !hash.safeParse(item.transactionHash).success) return integrity();
      return { reviewId: item.review.id, hash: item.transactionHash! };
    });
  }
  return { get, save, list, pending };
}
export type NftLaunchProgressRepository = ReturnType<typeof createNftLaunchProgressRepository>;
export const nftLaunchProgressRepository = createNftLaunchProgressRepository();
