import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { NextRequest } from 'next/server';
import { BASE_SEPOLIA_GENESIS_HASH } from '@oneshot/evm';
import { accountExternalNftImportSchema, externalImportAddressSchema, externalImportDeploymentIdSchema, externalNftImportDecisionSchema, externalNftImportInputSchema, isActiveExternalNftImport, type AccountExternalNftImport } from '../../../web/lib/external-nft-import';
import { requireOneshotSession, type OneshotSession } from './oneshot-auth';
import { database, withLocalNamespace } from './store';
import { ApiError } from './errors';
import { boundedBody, json, rateLimit } from './http';

export const EXTERNAL_NFT_IMPORT_NAMESPACE = 'oneshot_external_nft_imports';
const hash = z.string().regex(/^0x[a-f0-9]{64}$/).refine(value => !/^0x0{64}$/.test(value));
const uint = z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(value => BigInt(value) < 2n ** 256n);
const identity = z.object({
  deploymentId: externalImportDeploymentIdSchema,
  chainId: z.union([z.literal(31337), z.literal(84532)]), genesisHash: hash,
  registry: externalImportAddressSchema, marketplace: externalImportAddressSchema,
}).strict().refine(value => value.registry !== value.marketplace && (value.chainId !== 84532 || value.genesisHash === BASE_SEPOLIA_GENESIS_HASH));
export type ExternalImportDeployment = z.infer<typeof identity>;
const inspectionSchema = z.object({
  deployment: identity, collection: externalImportAddressSchema, runtimeCodeHash: hash,
  currentReviewVersion: uint,
  checkpoint: z.object({ number: uint, hash, timestamp: uint }).strict(),
  inspectedAt: z.string().datetime(),
}).strict();
export type ExternalNftImportInspection = z.infer<typeof inspectionSchema>;
const privateReviewSchema = z.object({
  decision: z.enum(['review-approved', 'rejected']), actor: z.string().min(1).max(128),
  operatorEvidence: z.string().max(8000), customerNote: z.string().max(500),
  inspection: inspectionSchema.nullable(), inspectionCommitment: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  reviewedAt: z.string().datetime(),
}).strict();
const recordSchema = z.object({
  schemaVersion: z.literal(1), ownerUserId: z.string().regex(/^did:privy:[a-zA-Z0-9_-]{1,256}$/),
  request: accountExternalNftImportSchema, review: privateReviewSchema.nullable(),
}).strict().superRefine((value, context) => {
  const { request, review } = value;
  const expected = request.status === 'review-approved' || request.status === 'rejected';
  if (expected && review?.decision !== request.status || request.status === 'submitted' && review !== null
    || request.reviewedAt !== (review?.reviewedAt ?? null) || request.customerNote !== (review?.customerNote ?? null)
    || review && (review.decision === 'review-approved' ? !review.inspection || !review.inspectionCommitment : review.inspection !== null || review.inspectionCommitment !== null))
    context.addIssue({ code: 'custom', message: 'Inconsistent import record' });
});
export type StoredExternalNftImport = z.infer<typeof recordSchema>;
const unavailable = () => new ApiError(503, 'EXTERNAL_IMPORT_UNAVAILABLE', 'Collection import requests are temporarily unavailable. Please try again.');
const notFound = () => new ApiError(404, 'EXTERNAL_IMPORT_NOT_FOUND', 'This collection import request was not found in this account.');
const changed = () => new ApiError(409, 'EXTERNAL_IMPORT_CHANGED', 'This import request changed elsewhere. Reload it before trying again.');
const activeLimit = () => new ApiError(409, 'EXTERNAL_IMPORT_LIMIT', 'You can have up to 20 active collection import requests. Withdraw an existing request first.');
const duplicate = () => new ApiError(409, 'EXTERNAL_IMPORT_DUPLICATE', 'You already have an active request for this collection. Open that request to check its review.');
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function stored(value: unknown): StoredExternalNftImport {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) throw unavailable();
  const record = parsed.data, inspection = record.review?.inspection;
  if (inspection && (inspection.collection !== record.request.collection || inspection.deployment.deploymentId !== record.request.deploymentId
    || digest(inspection) !== record.review!.inspectionCommitment)) throw unavailable();
  return record;
}
type After = { createdAt: string; id: string };
export type ExternalNftImportStore = {
  get(id: string): Promise<StoredExternalNftImport | null>;
  list(owner: string | null, limit: number, after: After | null): Promise<StoredExternalNftImport[]>;
  create(record: StoredExternalNftImport): Promise<void>;
  replace(previous: StoredExternalNftImport, next: StoredExternalNftImport): Promise<boolean>;
};
/** No schema creation and no hosted file fallback. All count/duplicate checks are atomic with insertion. */
export function createExternalNftImportStore(pool: () => Pool | null = database): ExternalNftImportStore {
  function check(records: StoredExternalNftImport[], next: StoredExternalNftImport) {
    const own = records.filter(value => value.ownerUserId === next.ownerUserId);
    if (own.some(value => isActiveExternalNftImport(value.request.status) && value.request.deploymentId === next.request.deploymentId && value.request.collection === next.request.collection)) throw duplicate();
    if (own.filter(value => isActiveExternalNftImport(value.request.status)).length >= 20) throw activeLimit();
  }
  return {
    async get(id) {
      const db = pool(), value = db ? (await db.query('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2', [EXTERNAL_NFT_IMPORT_NAMESPACE, id])).rows[0]?.value
        : await withLocalNamespace<StoredExternalNftImport, unknown>(EXTERNAL_NFT_IMPORT_NAMESPACE, records => records[id] ?? null, false);
      if (value == null) return null;
      const record = stored(value); if (record.request.id !== id) throw unavailable(); return record;
    },
    async list(owner, limit, after) {
      const db = pool();
      if (!db) return withLocalNamespace<StoredExternalNftImport, StoredExternalNftImport[]>(EXTERNAL_NFT_IMPORT_NAMESPACE, records => Object.values(records).filter(value => owner === null || value.ownerUserId === owner).map(stored)
        .filter(value => !after || value.request.createdAt < after.createdAt || value.request.createdAt === after.createdAt && value.request.id < after.id)
        .sort((a, b) => b.request.createdAt.localeCompare(a.request.createdAt) || b.request.id.localeCompare(a.request.id)).slice(0, limit), false);
      return (await db.query("SELECT id,value FROM b20_app_records WHERE namespace=$1 AND ($2::text IS NULL OR value->>'ownerUserId'=$2) AND ($3::text IS NULL OR (value->'request'->>'createdAt',id)<($3,$4)) ORDER BY value->'request'->>'createdAt' DESC,id DESC LIMIT $5", [EXTERNAL_NFT_IMPORT_NAMESPACE, owner, after?.createdAt ?? null, after?.id ?? null, limit])).rows.map(row => {
        const record = stored(row.value); if (record.request.id !== row.id || owner !== null && record.ownerUserId !== owner) throw unavailable(); return record;
      });
    },
    async create(record) {
      stored(record); const db = pool();
      if (!db) return withLocalNamespace<StoredExternalNftImport, void>(EXTERNAL_NFT_IMPORT_NAMESPACE, records => {
        if (records[record.request.id]) throw changed(); check(Object.values(records).filter(value => value.ownerUserId === record.ownerUserId).map(stored), record); records[record.request.id] = structuredClone(record);
      }, true);
      const client = await db.connect();
      try {
        await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='5000ms'"); await client.query("SET LOCAL lock_timeout='3000ms'");
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${EXTERNAL_NFT_IMPORT_NAMESPACE}:${record.ownerUserId}`]);
        const rows = await client.query("SELECT value FROM b20_app_records WHERE namespace=$1 AND value->>'ownerUserId'=$2 AND value->'request'->>'status' IN ('submitted','review-approved') LIMIT 21", [EXTERNAL_NFT_IMPORT_NAMESPACE, record.ownerUserId]);
        check(rows.rows.map(row => stored(row.value)), record);
        const inserted = await client.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3) ON CONFLICT(namespace,id) DO NOTHING RETURNING id', [EXTERNAL_NFT_IMPORT_NAMESPACE, record.request.id, JSON.stringify(record)]);
        if (inserted.rowCount !== 1) throw changed(); await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      finally { client.release(); }
    },
    async replace(previous, next) {
      stored(previous); stored(next);
      if (previous.request.id !== next.request.id || previous.ownerUserId !== next.ownerUserId) throw unavailable();
      const db = pool();
      if (!db) return withLocalNamespace<StoredExternalNftImport, boolean>(EXTERNAL_NFT_IMPORT_NAMESPACE, records => {
        if (!same(records[previous.request.id], previous)) return false; records[previous.request.id] = structuredClone(next); return true;
      }, true);
      return (await db.query('UPDATE b20_app_records SET value=$3,updated_at=now() WHERE namespace=$1 AND id=$2 AND value=$4::jsonb', [EXTERNAL_NFT_IMPORT_NAMESPACE, previous.request.id, JSON.stringify(next), JSON.stringify(previous)])).rowCount === 1;
    },
  };
}
type Dependencies = {
  store: ExternalNftImportStore; now(): string;
  /** Must verify the exact configured external deployment, not a user-supplied label. */
  deployment(deploymentId: string): Promise<ExternalImportDeployment>;
  /** Must perform hash-selected code/interface/registry reads and canonical recheck. No HTTP metadata evidence can substitute. */
  inspect(deployment: ExternalImportDeployment, collection: `0x${string}`): Promise<ExternalNftImportInspection>;
};
function revision(record: StoredExternalNftImport, expected: number) {
  if (!Number.isSafeInteger(expected) || expected !== record.request.revision || expected >= Number.MAX_SAFE_INTEGER) throw changed();
}
export function createExternalNftImports(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { store: createExternalNftImportStore(), now: () => new Date().toISOString(), deployment: async () => { throw unavailable(); }, inspect: async () => { throw unavailable(); }, ...overrides };
  async function deployment(id: string) {
    const parsed = identity.safeParse(await deps.deployment(id)); if (!parsed.success || parsed.data.deploymentId !== id) throw unavailable(); return parsed.data;
  }
  async function get(id: string, owner?: string) {
    if (!z.string().uuid().safeParse(id).success) throw notFound(); const record = await deps.store.get(id);
    if (!record || owner !== undefined && record.ownerUserId !== owner) throw notFound(); return stored(record);
  }
  async function page(owner: string | null, options: { limit?: number; cursor?: string } = {}) {
    const limit = options.limit ?? 20, scope = digest(['external-imports', owner ?? 'admin']); let after: After | null = null;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ApiError(400, 'EXTERNAL_IMPORT_INPUT_INVALID', 'Choose between 1 and 50 requests per page.');
    if (options.cursor !== undefined) {
      try {
        const encoded = options.cursor; if (!encoded || encoded.length > 2048 || !/^[\w-]+$/.test(encoded)) throw new Error();
        const bytes = Buffer.from(encoded, 'base64url'); if (bytes.toString('base64url') !== encoded) throw new Error();
        const parsed = z.object({ v: z.literal(1), scope: z.literal(scope), limit: z.literal(limit), createdAt: z.string().datetime(), id: z.string().uuid() }).strict().parse(JSON.parse(bytes.toString('utf8')));
        after = { createdAt: parsed.createdAt, id: parsed.id };
      } catch { throw new ApiError(400, 'EXTERNAL_IMPORT_CURSOR_INVALID', 'Reload your collection import requests from the beginning.'); }
    }
    const rows = (await deps.store.list(owner, limit + 1, after)).map(stored), items = rows.slice(0, limit), last = items.at(-1);
    if (rows.length > limit + 1 || rows.some(value => owner !== null && value.ownerUserId !== owner)) throw unavailable();
    const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ v: 1, scope, limit, createdAt: last.request.createdAt, id: last.request.id })).toString('base64url') : null;
    return { items, nextCursor };
  }
  return {
    async create(raw: unknown, session: OneshotSession): Promise<AccountExternalNftImport> {
      const input = externalNftImportInputSchema.safeParse(raw); if (!input.success) throw new ApiError(400, 'EXTERNAL_IMPORT_INPUT_INVALID', 'Check the collection address, selected network and request notes.');
      await deployment(input.data.deploymentId); const now = deps.now();
      const record = stored({ schemaVersion: 1, ownerUserId: session.userId, request: { ...input.data, id: randomUUID(), revision: 1, status: 'submitted', admissionStatus: 'not-established', customerNote: null, createdAt: now, updatedAt: now, reviewedAt: null }, review: null });
      await deps.store.create(record); return record.request;
    },
    async read(id: string, session: OneshotSession) { return (await get(id, session.userId)).request; },
    async list(session: OneshotSession, options: { limit?: number; cursor?: string } = {}) { const result = await page(session.userId, options); return { ...result, items: result.items.map(value => value.request) }; },
    async withdraw(id: string, expected: number, session: OneshotSession) {
      const previous = await get(id, session.userId); revision(previous, expected); if (previous.request.status === 'withdrawn') throw changed();
      const next = stored({ ...previous, request: { ...previous.request, status: 'withdrawn', revision: expected + 1, updatedAt: deps.now() } });
      if (!await deps.store.replace(previous, next)) throw changed(); return next.request;
    },
    /** Internal operator methods. The caller must require a server admin session before invoking them. */
    async adminRead(id: string) { return get(id); },
    async adminList(options: { limit?: number; cursor?: string } = {}) { return page(null, options); },
    async review(id: string, expected: number, raw: unknown, actor: string) {
      const input = externalNftImportDecisionSchema.safeParse(raw);
      if (!input.success || !/^[a-zA-Z0-9:_-]{1,128}$/.test(actor)) throw new ApiError(400, 'EXTERNAL_IMPORT_INPUT_INVALID', 'Check the review decision and notes.');
      const previous = await get(id); revision(previous, expected); if (previous.request.status !== 'submitted') throw changed();
      let inspection: ExternalNftImportInspection | null = null;
      if (input.data.decision === 'review-approved') {
        const selected = await deployment(previous.request.deploymentId), proof = inspectionSchema.safeParse(await deps.inspect(selected, previous.request.collection));
        if (!proof.success || !same(proof.data.deployment, selected) || proof.data.collection !== previous.request.collection) throw unavailable(); inspection = proof.data;
      }
      const now = deps.now(), next = stored({ ...previous,
        request: { ...previous.request, status: input.data.decision, revision: expected + 1, customerNote: input.data.customerNote, reviewedAt: now, updatedAt: now },
        review: { ...input.data, actor, inspection, inspectionCommitment: inspection ? digest(inspection) : null, reviewedAt: now },
      });
      if (!await deps.store.replace(previous, next)) throw changed(); return next;
    },
  };
}
export const externalNftImports = createExternalNftImports();
/** Account-private endpoints only. This handler never exposes operator methods or evidence. */
export function createExternalNftImportsApi(service = externalNftImports, authenticate = requireOneshotSession) {
  return async (request: NextRequest) => {
    const prefix = '/api/oneshot/external-nfts/imports', path = request.nextUrl.pathname.replace(/\/$/, '');
    if (path !== prefix && !path.startsWith(`${prefix}/`)) throw notFound();
    const id = path === prefix ? null : path.slice(prefix.length + 1); if (id !== null && !z.string().uuid().safeParse(id).success) throw notFound();
    const session = await authenticate(request); rateLimit(`oneshot:external-imports:${session.userId}`, request.method === 'GET' ? 120 : 20);
    if (request.method === 'GET') {
      const query = request.nextUrl.searchParams;
      if (id) { if (request.nextUrl.search) throw notFound(); return json(await service.read(id, session)); }
      for (const key of query.keys()) if (!['limit', 'cursor'].includes(key) || query.getAll(key).length !== 1) throw new ApiError(400, 'EXTERNAL_IMPORT_INPUT_INVALID', 'Use one import-request page selection.');
      const limit = query.get('limit'); if (limit !== null && !/^[1-9]\d?$/.test(limit)) throw new ApiError(400, 'EXTERNAL_IMPORT_INPUT_INVALID', 'Choose a valid request page size.');
      return json(await service.list(session, { ...(limit === null ? {} : { limit: Number(limit) }), ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}) }));
    }
    if (request.nextUrl.search) throw new ApiError(400, 'EXTERNAL_IMPORT_INPUT_INVALID', 'Remove additional import filters and try again.');
    if (request.method === 'POST' && !id) return json(await service.create(JSON.parse(new TextDecoder().decode(await boundedBody(request, 8192))), session), 201);
    if (request.method === 'DELETE' && id) {
      const body = z.object({ expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().parse(JSON.parse(new TextDecoder().decode(await boundedBody(request, 1024))));
      return json(await service.withdraw(id, body.expectedRevision, session));
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use the import request controls to submit or withdraw a request.');
  };
}
export const externalNftImportsApi = createExternalNftImportsApi();
