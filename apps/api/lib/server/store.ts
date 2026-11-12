import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { ApiError } from './errors';

declare global { var b20Pool: Pool | undefined; }
export function database() {
  if (!process.env.DATABASE_URL) return null;
  return globalThis.b20Pool ||= new Pool({ connectionString: process.env.DATABASE_URL, max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 8000 });
}
export const dataRoot = () => resolve(process.env.ONESHOT_DATA_DIR || process.env.B20_DATA_DIR || '.local/oneshot');
type State = Record<string, Record<string, any>>;
let tail: Promise<unknown> = Promise.resolve();
const renameRetryDelays = [10, 20, 40, 80];
async function replaceLocalState(temp: string, path: string) {
  // Windows scanners/watchers can briefly hold the destination open. Keep the
  // replacement atomic: retry rename itself, never remove the previous state.
  for (let attempt = 0; ; attempt++) {
    try { await rename(temp, path); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code || '') || attempt >= renameRetryDelays.length) throw error;
      await delay(renameRetryDelays[attempt]);
    }
  }
}
async function localOperation<T>(fn: (state: State) => T | Promise<T>, write: boolean): Promise<T> {
  if (process.env.NODE_ENV === 'production') throw new ApiError(503, 'DATABASE_REQUIRED', 'Persistent database configuration is required for hosted writes.');
  const task = tail.then(async () => {
    const path = resolve(dataRoot(), 'state.json');
    let state: State = {};
    try { state = JSON.parse(await readFile(path, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const result = await fn(state);
    if (write) {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
        await replaceLocalState(temp, path);
      } catch (error) {
        // Preserve the write/rename error if removing its unused temp also fails.
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    }
    return result;
  });
  tail = task.catch(() => undefined);
  return task;
}
const validNamespace = (n: string) => { if (!/^[a-z_]{1,32}$/.test(n)) throw new Error('Invalid store namespace'); return n; };
/** Reuse the serialized atomic development store for a single bounded namespace.
 * Hosted callers still require PostgreSQL; this never creates a production file fallback.
 */
export function withLocalNamespace<T, R>(namespace: string, fn: (records: Record<string,T>) => R, write: boolean): Promise<R> {
  validNamespace(namespace);
  return localOperation(state => fn((state[namespace] ||= {}) as Record<string,T>), write);
}
export async function getRecord<T = any>(namespace: string, id: string): Promise<T | null> {
  const db = database(); validNamespace(namespace);
  if (db) { const result = await db.query('SELECT value FROM b20_app_records WHERE namespace=$1 AND id=$2', [namespace, id]); return result.rows[0]?.value || null; }
  return localOperation(s => s[namespace]?.[id] || null, false);
}
export async function putIfAbsent(namespace:string,id:string,value:unknown) {
  validNamespace(namespace);const db=database();
  if(db){await db.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3) ON CONFLICT(namespace,id) DO NOTHING',[namespace,id,JSON.stringify(value)]);return getRecord(namespace,id);}
  return localOperation(s=>{const records=s[namespace]||={};return records[id]||=(value as any);},true);
}
export async function putRecord(namespace: string, id: string, value: unknown) {
  const db = database(); validNamespace(namespace);
  if (db) { await db.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3) ON CONFLICT(namespace,id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()', [namespace, id, JSON.stringify(value)]); return; }
  return localOperation(s => { (s[namespace] ||= {})[id] = value; }, true);
}
export async function mergeRecord(namespace:string,id:string,patch:Record<string,unknown>) {
  const db=database();validNamespace(namespace);
  if(db){await db.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3) ON CONFLICT(namespace,id) DO UPDATE SET value=b20_app_records.value || EXCLUDED.value,updated_at=now()',[namespace,id,JSON.stringify(patch)]);return;}
  await localOperation(s=>{(s[namespace]||={})[id]={...s[namespace][id],...patch};},true);
}
export async function putVersionedRecord(namespace:string,id:string,value:Record<string,unknown>,version:string) {
  validNamespace(namespace);const record={...value,lastVersion:version};const db=database();
  if(db){await db.query("INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3) ON CONFLICT(namespace,id) DO UPDATE SET value=b20_app_records.value || EXCLUDED.value,updated_at=now() WHERE COALESCE(b20_app_records.value->>'lastVersion','0')::numeric <= $4::numeric",[namespace,id,JSON.stringify(record),version]);return;}
  await localOperation(s=>{const previous=s[namespace]?.[id];if(!previous||BigInt(previous.lastVersion||'0')<=BigInt(version))(s[namespace]||={})[id]={...previous,...record};},true);
}
export async function compareAndSetRecord(namespace:string,id:string,expected:unknown,value:unknown) {
  validNamespace(namespace);const db=database();
  if(db){const result=await db.query('UPDATE b20_app_records SET value=$3,updated_at=now() WHERE namespace=$1 AND id=$2 AND value=$4::jsonb',[namespace,id,JSON.stringify(value),JSON.stringify(expected)]);return result.rowCount===1;}
  return localOperation(s=>{if(JSON.stringify(s[namespace]?.[id])!==JSON.stringify(expected))return false;s[namespace][id]=value;return true;},true);
}
export async function consumeRecord<T = any>(namespace: string, id: string): Promise<T | null> {
  const db = database(); validNamespace(namespace);
  if (db) { const result = await db.query('DELETE FROM b20_app_records WHERE namespace=$1 AND id=$2 RETURNING value', [namespace, id]); return result.rows[0]?.value || null; }
  return localOperation(s => { const record = s[namespace]?.[id] || null; if (s[namespace]) delete s[namespace][id]; return record; }, true);
}
export async function listRecords<T = any>(namespace: string): Promise<T[]> {
  const db = database(); validNamespace(namespace);
  if (db) { const result = await db.query('SELECT value FROM b20_app_records WHERE namespace=$1 ORDER BY updated_at DESC LIMIT 200', [namespace]); return result.rows.map(r => r.value); }
  return localOperation(s => Object.values(s[namespace] || {}).slice(-200).reverse(), false);
}

/** Filter ownership before limiting: another creator cannot crowd this account out. */
export async function listOwnedRecords<T = any>(namespace: string, ownerUserId: string, limit = 50): Promise<T[]> {
  validNamespace(namespace);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid page limit');
  const db = database();
  if (db) {
    const result = await db.query("SELECT value FROM b20_app_records WHERE namespace=$1 AND value->>'ownerUserId'=$2 AND COALESCE(value->>'status','') <> 'deleted' ORDER BY updated_at DESC LIMIT $3", [namespace, ownerUserId, limit]);
    return result.rows.map(row => row.value);
  }
  return localOperation(s => Object.values(s[namespace] || {}).filter(row => row.ownerUserId === ownerUserId && row.status !== 'deleted').sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit), false);
}

/** The per-account draft limit and insertion share one database/file transaction. */
export async function createOwnedRecord(namespace: string, id: string, ownerUserId: string, value: unknown, limit = 20) {
  validNamespace(namespace); const db = database();
  if (db) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${namespace}:${ownerUserId}`]);
      const count = await client.query("SELECT count(*)::int AS total FROM b20_app_records WHERE namespace=$1 AND value->>'ownerUserId'=$2 AND COALESCE(value->>'status','') <> 'deleted'", [namespace, ownerUserId]);
      if (count.rows[0].total >= limit) throw new ApiError(409, 'DRAFT_LIMIT', 'This account has reached its saved draft limit. Archive a draft first.');
      await client.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3)', [namespace,id,JSON.stringify(value)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return;
  }
  await localOperation(s => {
    const records = s[namespace] ||= {};
    if (records[id]) throw new ApiError(409, 'DRAFT_CONFLICT', 'Create a new draft identifier.');
    if (Object.values(records).filter(row => row.ownerUserId === ownerUserId && row.status !== 'deleted').length >= limit) throw new ApiError(409, 'DRAFT_LIMIT', 'This account has reached its saved draft limit. Archive a draft first.');
    records[id] = value;
  }, true);
}

type MediaValue = { size: number; [key: string]: unknown };
type PendingMedia = { mediaId: string; asset: MediaValue; expiresAt: number };
export type MediaUpload = { mediaId: string; reservationId: string };
export const MEDIA_UPLOAD_LEASE_MS = 60_000;
const maximumMediaWriters = 32;
function mediaQuota() {
  const quota = Number(process.env.ONESHOT_MEDIA_QUOTA_BYTES || process.env.B20_MEDIA_QUOTA_BYTES || 1073741824);
  if (!Number.isSafeInteger(quota) || quota <= 0) throw new ApiError(503, 'INVALID_STORAGE_QUOTA', 'A positive storage quota must be configured.');
  return BigInt(quota);
}
function fullMediaQuota(): never {
  throw new ApiError(507, 'MEDIA_QUOTA_REACHED', 'There is not enough storage available for this upload. Please try again later.');
}
function assertMediaSize(previous: MediaValue, value: MediaValue) {
  if (previous.size !== value.size) throw new ApiError(503, 'CONTENT_INTEGRITY', 'The saved content could not be verified. Please try again later.');
}
async function mediaTransaction<T>(db: Pool, operation: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(202020)');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
async function mediaUsage(client: PoolClient, now: number) {
  const result = await client.query(`
    SELECT COALESCE(SUM(size),0)::text AS total FROM (
      SELECT id AS media_id, (value->>'size')::bigint AS size
        FROM b20_app_records WHERE namespace='media'
      UNION ALL
      SELECT pending.value->>'mediaId', MAX((pending.value->'asset'->>'size')::bigint)
        FROM b20_app_records pending
       WHERE pending.namespace='media_uploads' AND (pending.value->>'expiresAt')::bigint > $1
         AND NOT EXISTS (SELECT 1 FROM b20_app_records stored
           WHERE stored.namespace='media' AND stored.id=pending.value->>'mediaId')
       GROUP BY pending.value->>'mediaId'
    ) counted`, [now]);
  return BigInt(result.rows[0].total);
}
function localMediaUsage(state: State, now: number) {
  const sizes = new Map<string, number>();
  for (const [id, value] of Object.entries(state.media || {})) sizes.set(id, value.size);
  for (const [token, value] of Object.entries(state.media_uploads || {}) as [string, PendingMedia][]) {
    if (value.expiresAt <= now) delete state.media_uploads[token];
    else if (!sizes.has(value.mediaId)) sizes.set(value.mediaId, value.asset.size);
  }
  return [...sizes.values()].reduce((total, size) => total + BigInt(size), 0n);
}

/** A per-attempt lease reserves space without publishing an unreadable asset.
 * Same-content writers share one quota charge, but can only release their own lease.
 */
export async function beginMediaUpload(id: string, value: MediaValue): Promise<MediaUpload> {
  if (!/^[a-f0-9]{64}\.(webp|json)$/.test(id) || !Number.isSafeInteger(value.size) || value.size < 0) throw new Error('Invalid media upload');
  const quota = mediaQuota();
  const upload = { mediaId: id, reservationId: randomUUID() };
  const db = database();
  if (db) return mediaTransaction(db, async client => {
    const now = Date.now();
    const pending: PendingMedia = { mediaId: id, asset: value, expiresAt: now + MEDIA_UPLOAD_LEASE_MS };
    await client.query("DELETE FROM b20_app_records WHERE namespace='media_uploads' AND (value->>'expiresAt')::bigint <= $1", [now]);
    const existing = await client.query(`SELECT namespace,value FROM b20_app_records
      WHERE (namespace='media' AND id=$1) OR (namespace='media_uploads' AND value->>'mediaId'=$1)`, [id]);
    for (const row of existing.rows) assertMediaSize(row.namespace === 'media' ? row.value : row.value.asset, value);
    if (existing.rows.filter(row => row.namespace === 'media_uploads').length >= maximumMediaWriters) throw new ApiError(503, 'CONTENT_WRITE_BUSY', 'This artwork is still being saved. Please try again.');
    if (!existing.rowCount && await mediaUsage(client, now) + BigInt(value.size) > quota) fullMediaQuota();
    await client.query("INSERT INTO b20_app_records(namespace,id,value) VALUES('media_uploads',$1,$2)", [upload.reservationId, JSON.stringify(pending)]);
    return upload;
  });
  return localOperation(state => {
    const now = Date.now();
    const pending: PendingMedia = { mediaId: id, asset: value, expiresAt: now + MEDIA_UPLOAD_LEASE_MS };
    const total = localMediaUsage(state, now);
    const existing = Object.values(state.media_uploads || {}).filter((entry: PendingMedia) => entry.mediaId === id) as PendingMedia[];
    if (state.media?.[id]) assertMediaSize(state.media[id], value);
    for (const entry of existing) assertMediaSize(entry.asset, value);
    if (existing.length >= maximumMediaWriters) throw new ApiError(503, 'CONTENT_WRITE_BUSY', 'This artwork is still being saved. Please try again.');
    if (!state.media?.[id] && !existing.length && total + BigInt(value.size) > quota) fullMediaQuota();
    (state.media_uploads ||= {})[upload.reservationId] = pending;
    return upload;
  }, true);
}

/** Publish metadata only after the bytes were stored and this attempt is still live. */
export async function commitMediaUpload(upload: MediaUpload): Promise<boolean> {
  const db = database();
  if (db) return mediaTransaction(db, async client => {
    const now = Date.now();
    const result = await client.query("SELECT value FROM b20_app_records WHERE namespace='media_uploads' AND id=$1 AND value->>'mediaId'=$2", [upload.reservationId, upload.mediaId]);
    const pending = result.rows[0]?.value as PendingMedia | undefined;
    if (!pending) return false;
    if (pending.expiresAt > now) {
      const existing = await client.query("SELECT value FROM b20_app_records WHERE namespace='media' AND id=$1", [upload.mediaId]);
      if (existing.rowCount) assertMediaSize(existing.rows[0].value, pending.asset);
      await client.query("INSERT INTO b20_app_records(namespace,id,value) VALUES('media',$1,$2) ON CONFLICT(namespace,id) DO NOTHING", [upload.mediaId, JSON.stringify(pending.asset)]);
    }
    await client.query("DELETE FROM b20_app_records WHERE namespace='media_uploads' AND id=$1 AND value->>'mediaId'=$2", [upload.reservationId, upload.mediaId]);
    return pending.expiresAt > now;
  });
  return localOperation(state => {
    const now = Date.now();
    const pending = state.media_uploads?.[upload.reservationId] as PendingMedia | undefined;
    if (!pending || pending.mediaId !== upload.mediaId) return false;
    if (pending.expiresAt > now) {
      if (state.media?.[upload.mediaId]) assertMediaSize(state.media[upload.mediaId], pending.asset);
      (state.media ||= {})[upload.mediaId] ||= pending.asset;
    }
    delete state.media_uploads[upload.reservationId];
    return pending.expiresAt > now;
  }, true);
}

export async function cancelMediaUpload(upload: MediaUpload) {
  const db = database();
  if (db) return mediaTransaction(db, async client => {
    await client.query("DELETE FROM b20_app_records WHERE namespace='media_uploads' AND id=$1 AND value->>'mediaId'=$2", [upload.reservationId, upload.mediaId]);
  });
  await localOperation(state => {
    if (state.media_uploads?.[upload.reservationId]?.mediaId === upload.mediaId) delete state.media_uploads[upload.reservationId];
  }, true);
}

/** Compatibility for callers recording bytes which have already been stored. */
export async function reserveMedia(id: string, value: MediaValue) {
  const quota = mediaQuota();
  const db = database();
  if (db) {
    await mediaTransaction(db, async client => {
      const now = Date.now();
      const existing = await client.query("SELECT id FROM b20_app_records WHERE namespace='media' AND id=$1", [id]);
      if (!existing.rowCount) {
        const pending = await client.query("SELECT value FROM b20_app_records WHERE namespace='media_uploads' AND value->>'mediaId'=$1 AND (value->>'expiresAt')::bigint > $2", [id, now]);
        for (const row of pending.rows) assertMediaSize(row.value.asset, value);
        if (!pending.rowCount && await mediaUsage(client, now) + BigInt(value.size) > quota) fullMediaQuota();
        await client.query("INSERT INTO b20_app_records(namespace,id,value) VALUES('media',$1,$2)", [id, JSON.stringify(value)]);
      }
    });
    return;
  }
  await localOperation(s => {
    const now = Date.now();
    const records = s.media ||= {};
    if (records[id]) return;
    const total = localMediaUsage(s, now);
    const pending = Object.values(s.media_uploads || {}).filter((entry: PendingMedia) => entry.mediaId === id && entry.expiresAt > now) as PendingMedia[];
    for (const entry of pending) assertMediaSize(entry.asset, value);
    if (!pending.length && total + BigInt(value.size) > quota) fullMediaQuota();
    records[id] = value;
  }, true);
}
