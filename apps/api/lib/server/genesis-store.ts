import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { database, withLocalNamespace } from './store';
import { ApiError } from './errors';
import { genesisCampaignSchema, type GenesisApplication, type GenesisCampaign, type GenesisTask } from '../../../web/lib/genesis-schema';

export type GenesisJob = { id: string; applicationId: string; xId: string; ruleVersion: number; task: GenesisTask; postId?: string; attempts: number; state: 'pending' | 'running' | 'done'; nextAt: number; leaseUntil: number };
export type GenesisAudit = { at: string; actor: string; action: string; applicationId?: string; details?: unknown };
export interface GenesisTransaction {
  campaign(): Promise<GenesisCampaign>;
  saveCampaign(campaign: GenesisCampaign): Promise<void>;
  application(field: 'id' | 'userId' | 'xId' | 'code', value: string): Promise<GenesisApplication | null>;
  saveApplication(application: GenesisApplication): Promise<void>;
  applications(offset: number, limit: number): Promise<GenesisApplication[]>;
  count(kind: 'selected' | 'total' | 'referrals' | 'reserved', referrerId?: string): Promise<number>;
  nominator(xId: string): Promise<GenesisApplication | null>;
  jobs(limit: number, now: number): Promise<GenesisJob[]>;
  job(id: string): Promise<GenesisJob | null>;
  saveJob(job: GenesisJob): Promise<void>;
  budget(limit: number, now: number): Promise<boolean>;
  audit(event: GenesisAudit): Promise<void>;
}
export interface GenesisStore { transaction<T>(fn: (tx: GenesisTransaction) => Promise<T>): Promise<T> }
type LocalState = { campaign: GenesisCampaign; applications: Record<string, GenesisApplication>; jobs: Record<string, GenesisJob>; budget: Record<string, number>; audit: GenesisAudit[] };
const fresh = (): LocalState => ({ campaign: genesisCampaignSchema.parse({}), applications: {}, jobs: {}, budget: {}, audit: [] });
const key = (app: GenesisApplication, field: string) => field === 'xId' ? app.profile.id : (app as unknown as Record<string, string>)[field];
function localTransaction(state: LocalState): GenesisTransaction {
  return {
    campaign: async () => structuredClone(state.campaign),
    saveCampaign: async value => { state.campaign = structuredClone(value); },
    application: async (field, value) => structuredClone(Object.values(state.applications).find(app => key(app, field) === value) || null),
    saveApplication: async app => {
      if (Object.values(state.applications).some(other => other.id !== app.id && (other.userId === app.userId || other.profile.id === app.profile.id || other.code === app.code))) throw new ApiError(409, 'GENESIS_IDENTITY_USED', 'This X account already has an application. Sign in to the original oneshot account.');
      state.applications[app.id] = structuredClone(app);
    },
    applications: async (offset, limit) => structuredClone(Object.values(state.applications).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(offset, offset + limit)),
    count: async (kind, referrerId) => kind === 'reserved' ? Object.values(state.applications).reduce((sum,app) => sum + (app.nominationQuota || 0) - (app.nominations || []).filter(n => n.accepted).length,0) : Object.values(state.applications).filter(app => kind === 'selected' ? app.decision === 'selected' : kind === 'referrals' ? app.referrerId === referrerId && app.status === 'under_review' : true).length,
    nominator: async xId => structuredClone(Object.values(state.applications).find(app => app.nominations?.some(n => n.xId === xId)) || null),
    jobs: async (limit, now) => structuredClone(Object.values(state.jobs).filter(job => job.state !== 'done' && job.nextAt <= now && job.leaseUntil <= now).slice(0, limit)),
    job: async id => structuredClone(state.jobs[id] || null),
    saveJob: async job => { state.jobs[job.id] = structuredClone(job); },
    budget: async (limit, now) => { const day = new Date(now).toISOString().slice(0,10); for (const date of Object.keys(state.budget)) if (date !== day) delete state.budget[date]; if ((state.budget[day] || 0) >= limit) return false; state.budget[day] = (state.budget[day] || 0) + 1; return true; },
    audit: async event => { state.audit.push(structuredClone(event)); },
  };
}

/** An isolated transactional adapter for tests; never selected by a production flag. */
export function memoryGenesisStore(): GenesisStore {
  let state = fresh(); let tail: Promise<unknown> = Promise.resolve();
  return { transaction<T>(fn: (tx: GenesisTransaction) => Promise<T>) {
    const work = tail.then(async () => { const next = structuredClone(state); const result = await fn(localTransaction(next)); state = next; return result; }); tail = work.catch(() => undefined); return work;
  } };
}

export function createGenesisStore(pool: () => Pool | null = database): GenesisStore {
  return { async transaction<T>(fn: (tx: GenesisTransaction) => Promise<T>) {
    const db = pool();
    if (!db) {
      if (process.env.NODE_ENV === 'production') throw new ApiError(503, 'GENESIS_UNAVAILABLE', 'Applications are temporarily unavailable. Please try again later.');
      return withLocalNamespace<LocalState, Promise<T>>('oneshot_genesis', async records => {
        const state = structuredClone(records.genesis || fresh()); const result = await fn(localTransaction(state)); records.genesis = state; return result;
      }, true);
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO oneshot_genesis_campaign(id,value) VALUES('genesis',$1) ON CONFLICT DO NOTHING", [JSON.stringify(genesisCampaignSchema.parse({}))]);
      // Short database-only transactions serialize allocation, referral and rule changes.
      // Provider requests and image rendering always happen after the lock is released.
      const locked = await client.query("SELECT value FROM oneshot_genesis_campaign WHERE id='genesis' FOR UPDATE");
      let campaign = genesisCampaignSchema.parse(locked.rows[0].value);
      const tx: GenesisTransaction = {
        campaign: async () => structuredClone(campaign),
        saveCampaign: async value => { await client.query("UPDATE oneshot_genesis_campaign SET value=$1 WHERE id='genesis'", [JSON.stringify(value)]); campaign = value; },
        application: async (field, value) => { const column = { id: 'id', userId: 'user_id', xId: 'x_id', code: 'code' }[field]; const result = await client.query(`SELECT value FROM oneshot_genesis_applications WHERE ${column}=$1`, [value]); return result.rows[0]?.value || null; },
        saveApplication: async app => { await client.query('INSERT INTO oneshot_genesis_applications(id,user_id,x_id,code,referrer_id,value) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value', [app.id, app.userId, app.profile.id, app.code, app.referrerId, JSON.stringify(app)]); },
        applications: async (offset, limit) => (await client.query('SELECT value FROM oneshot_genesis_applications ORDER BY created_at DESC,id LIMIT $1 OFFSET $2', [limit, offset])).rows.map(row => row.value),
        count: async (kind, referrerId) => {
          if (kind === 'reserved') return Number((await client.query("SELECT COALESCE(sum(COALESCE((value->>'nominationQuota')::integer,0)-(SELECT count(*) FROM jsonb_array_elements(COALESCE(value->'nominations','[]')) n WHERE n->>'accepted'='true')),0) AS count FROM oneshot_genesis_applications")).rows[0].count);
          const filter = kind === 'selected' ? "WHERE value->>'decision'='selected'" : kind === 'referrals' ? "WHERE referrer_id=$1 AND value->>'status'='under_review'" : ''; return Number((await client.query(`SELECT count(*) FROM oneshot_genesis_applications ${filter}`, kind === 'referrals' ? [referrerId] : [])).rows[0].count);
        },
        nominator: async xId => (await client.query("SELECT value FROM oneshot_genesis_applications WHERE value->'nominations' @> $1::jsonb LIMIT 1", [JSON.stringify([{ xId }])])).rows[0]?.value || null,
        jobs: async (limit, now) => (await client.query("SELECT value FROM oneshot_genesis_jobs WHERE value->>'state'<>'done' AND next_at <= $1 AND lease_until <= $1 ORDER BY next_at,id LIMIT $2", [now, limit])).rows.map(row => row.value),
        job: async id => (await client.query('SELECT value FROM oneshot_genesis_jobs WHERE id=$1', [id])).rows[0]?.value || null,
        saveJob: async job => { await client.query('INSERT INTO oneshot_genesis_jobs(id,application_id,task,next_at,lease_until,value) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET next_at=EXCLUDED.next_at,lease_until=EXCLUDED.lease_until,value=EXCLUDED.value', [job.id, job.applicationId, job.task, job.nextAt, job.leaseUntil, JSON.stringify(job)]); },
        budget: async (limit, now) => { const day = new Date(now).toISOString().slice(0,10); const result = await client.query('INSERT INTO oneshot_genesis_budget(day,reads) SELECT $1,1 WHERE $2>0 ON CONFLICT(day) DO UPDATE SET reads=oneshot_genesis_budget.reads+1 WHERE oneshot_genesis_budget.reads<$2 RETURNING reads', [day, limit]); return result.rowCount === 1; },
        audit: async event => { await client.query('INSERT INTO oneshot_genesis_audit(id,value) VALUES($1,$2)', [randomUUID(), JSON.stringify(event)]); },
      };
      const result = await fn(tx); await client.query('COMMIT'); return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') throw new ApiError(409, 'GENESIS_IDENTITY_USED', 'This X account already has an application. Sign in to the original oneshot account.');
      throw error;
    } finally { client.release(); }
  } };
}
export const genesisStore = createGenesisStore();
