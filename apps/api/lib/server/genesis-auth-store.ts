import type { Pool } from 'pg';
import { database, withLocalNamespace } from './store';
import { ApiError } from './errors';
import type { GenesisProfile } from '../../../web/lib/genesis-schema';

export type GenesisOAuthState = { verifier: string; browserHash: string; expiresAt: number; referral?: string };
export type GenesisXSession = { xId: string; expiresAt: number };
type Stored = { states: Record<string, GenesisOAuthState>; identities: Record<string, GenesisProfile>; sessions: Record<string, GenesisXSession> };
export interface GenesisAuthTransaction {
  state(hash: string, value: GenesisOAuthState): Promise<void>;
  consume(hash: string, browserHash: string, now: number): Promise<GenesisOAuthState | null>;
  identity(id: string): Promise<GenesisProfile | null>;
  saveIdentity(profile: GenesisProfile): Promise<void>;
  session(hash: string): Promise<GenesisXSession | null>;
  saveSession(hash: string, session: GenesisXSession): Promise<void>;
  revoke(hash: string): Promise<void>;
  prune(now: number): Promise<void>;
}
export interface GenesisAuthStore { transaction<T>(operation: (tx: GenesisAuthTransaction) => Promise<T>): Promise<T> }
const fresh = (): Stored => ({ states: {}, identities: {}, sessions: {} });
function local(state: Stored): GenesisAuthTransaction {
  return {
    state: async (hash, value) => { state.states[hash] = structuredClone(value); },
    consume: async (hash, browserHash, now) => { const value = state.states[hash]; if (!value || value.browserHash !== browserHash || value.expiresAt <= now) return null; delete state.states[hash]; return structuredClone(value); },
    identity: async id => structuredClone(state.identities[id] || null),
    saveIdentity: async profile => { state.identities[profile.id] = structuredClone(profile); },
    session: async hash => structuredClone(state.sessions[hash] || null),
    saveSession: async (hash, session) => { state.sessions[hash] = structuredClone(session); },
    revoke: async hash => { delete state.sessions[hash]; },
    prune: async now => { for (const [hash, value] of Object.entries(state.states)) if (value.expiresAt <= now) delete state.states[hash]; for (const [hash, value] of Object.entries(state.sessions)) if (value.expiresAt <= now) delete state.sessions[hash]; },
  };
}
export function memoryGenesisAuthStore(): GenesisAuthStore {
  let state = fresh(); let tail: Promise<unknown> = Promise.resolve();
  return { transaction<T>(operation: (tx: GenesisAuthTransaction) => Promise<T>) { const work = tail.then(async () => { const next = structuredClone(state); const result = await operation(local(next)); state = next; return result; }); tail = work.catch(() => undefined); return work; } };
}
export function createGenesisAuthStore(pool: () => Pool | null = database): GenesisAuthStore {
  return { async transaction<T>(operation: (tx: GenesisAuthTransaction) => Promise<T>) {
    const db = pool();
    if (!db) {
      if (process.env.NODE_ENV === 'production') throw new ApiError(503, 'GENESIS_UNAVAILABLE', 'X sign-in is temporarily unavailable. Please try again later.');
      return withLocalNamespace<Stored, Promise<T>>('oneshot_genesis_auth', async records => { const state = structuredClone(records.auth || fresh()); const result = await operation(local(state)); records.auth = state; return result; }, true);
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const tx: GenesisAuthTransaction = {
        state: async (hash, value) => { await client.query('INSERT INTO oneshot_genesis_oauth(state_hash,browser_hash,value,expires_at) VALUES($1,$2,$3,$4)', [hash, value.browserHash, JSON.stringify(value), value.expiresAt]); },
        consume: async (hash, browserHash, now) => (await client.query('DELETE FROM oneshot_genesis_oauth WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>$3 RETURNING value', [hash, browserHash, now])).rows[0]?.value || null,
        identity: async id => (await client.query('SELECT value FROM oneshot_genesis_identities WHERE x_id=$1', [id])).rows[0]?.value || null,
        saveIdentity: async profile => { await client.query('INSERT INTO oneshot_genesis_identities(x_id,value) VALUES($1,$2) ON CONFLICT(x_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()', [profile.id, JSON.stringify(profile)]); },
        session: async hash => (await client.query('SELECT value FROM oneshot_genesis_sessions WHERE session_hash=$1', [hash])).rows[0]?.value || null,
        saveSession: async (hash, session) => { await client.query('INSERT INTO oneshot_genesis_sessions(session_hash,x_id,value,expires_at) VALUES($1,$2,$3,$4)', [hash, session.xId, JSON.stringify(session), session.expiresAt]); },
        revoke: async hash => { await client.query('DELETE FROM oneshot_genesis_sessions WHERE session_hash=$1', [hash]); },
        prune: async now => { await client.query('DELETE FROM oneshot_genesis_oauth WHERE expires_at<=$1', [now]); await client.query('DELETE FROM oneshot_genesis_sessions WHERE expires_at<=$1', [now]); },
      };
      const result = await operation(tx); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } };
}
export const genesisAuthStore = createGenesisAuthStore();
