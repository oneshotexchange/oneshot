import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { Pool } from 'pg';
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

export async function reserveMedia(id: string, value: { size: number; [key: string]: unknown }) {
  const quota = Number(process.env.ONESHOT_MEDIA_QUOTA_BYTES || process.env.B20_MEDIA_QUOTA_BYTES || 1073741824);
  if (!Number.isSafeInteger(quota) || quota <= 0) throw new ApiError(503, 'INVALID_STORAGE_QUOTA', 'A positive storage quota must be configured.');
  const db = database();
  if (db) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(202020)');
      const existing = await client.query("SELECT id FROM b20_app_records WHERE namespace='media' AND id=$1", [id]);
      if (!existing.rowCount) {
        const total = await client.query("SELECT COALESCE(SUM((value->>'size')::bigint),0)::text AS total FROM b20_app_records WHERE namespace='media'");
        if (BigInt(total.rows[0].total) + BigInt(value.size) > BigInt(quota)) throw new ApiError(507, 'MEDIA_QUOTA_REACHED', 'The beta media quota is full.');
        await client.query("INSERT INTO b20_app_records(namespace,id,value) VALUES('media',$1,$2)", [id, JSON.stringify(value)]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    return;
  }
  await localOperation(s => {
    const records = s.media ||= {};
    if (records[id]) return;
    const total = Object.values(records).reduce((sum, row) => sum + Number(row.size), 0);
    if (total + value.size > quota) throw new ApiError(507, 'MEDIA_QUOTA_REACHED', 'The beta media quota is full.');
    records[id] = value;
  }, true);
}
