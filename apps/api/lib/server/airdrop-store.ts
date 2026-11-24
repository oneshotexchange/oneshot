import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { database, withLocalNamespace } from './store';
import { ApiError } from './errors';
import {
  airdropCampaignSchema,
  type AirdropCampaign,
  type AirdropParticipant,
  type AirdropPublishedMerkle,
  type AirdropPublishedProof,
  type AirdropSnapshotEntry,
  type AirdropSnapshotTier,
} from '../../../web/lib/airdrop-schema';

export type AirdropAudit = {
  at: string;
  actor: string;
  action: string;
  participantId?: string;
  details?: unknown;
};

export type AirdropPublishedMerkleMeta = {
  root: string;
  chainId: number;
  distributor: string;
  totalCommittedRaw: string;
  publishedAt: string;
  recipientCount: number;
};

export interface AirdropTransaction {
  campaign(): Promise<AirdropCampaign>;
  saveCampaign(campaign: AirdropCampaign): Promise<void>;
  importSnapshot(
    entries: readonly { wallet: string; tier: AirdropSnapshotTier; txCount?: number }[],
    mode: 'merge' | 'replace',
    importedAt: string,
  ): Promise<{ imported: number; total: number; winners: number; fiveTx: number }>;
  lookupSnapshot(wallet: string): Promise<AirdropSnapshotEntry | null>;
  snapshotStats(): Promise<{ total: number; winners: number; fiveTx: number }>;
  participant(field: 'id' | 'userId' | 'xId' | 'code' | 'wallet', value: string): Promise<AirdropParticipant | null>;
  participantByPostId(postId: string): Promise<AirdropParticipant | null>;
  saveParticipant(participant: AirdropParticipant): Promise<void>;
  allParticipants(): Promise<AirdropParticipant[]>;
  countQualifiedReferrals(participantId: string): Promise<number>;
  qualifiedReferralCounts(): Promise<Record<string, number>>;
  referralCounts(): Promise<Record<string, { total: number; qualified: number }>>;
  countReservedSlots(): Promise<{ slots: number; generalTokens: number }>;
  maxReservedSlotNumber(): Promise<number>;
  publishedMerkle(): Promise<AirdropPublishedMerkle | null>;
  publishedMerkleMeta(): Promise<AirdropPublishedMerkleMeta | null>;
  publishedMerkleProof(wallet: string): Promise<AirdropPublishedProof | null>;
  savePublishedMerkle(merkle: AirdropPublishedMerkle): Promise<void>;
  budget(limit: number, now: number): Promise<boolean>;
  audit(event: AirdropAudit): Promise<void>;
}

export interface AirdropStore {
  transaction<T>(fn: (tx: AirdropTransaction) => Promise<T>, options?: { readOnly?: boolean }): Promise<T>;
}

type LocalState = {
  campaign: AirdropCampaign;
  snapshot: Record<string, AirdropSnapshotEntry>;
  participants: Record<string, AirdropParticipant>;
  publishedMerkle: AirdropPublishedMerkle | null;
  budget: Record<string, number>;
  audit: AirdropAudit[];
};

const fresh = (): LocalState => ({
  campaign: airdropCampaignSchema.parse({}),
  snapshot: {},
  participants: {},
  publishedMerkle: null,
  budget: {},
  audit: [],
});

function fieldMatch(p: AirdropParticipant, field: 'id' | 'userId' | 'xId' | 'code' | 'wallet', value: string): boolean {
  if (field === 'id') return p.id === value;
  if (field === 'userId') return p.userId === value;
  if (field === 'xId') return p.profile.id === value;
  if (field === 'code') return p.code === value;
  return Boolean(p.wallet && p.wallet.toLowerCase() === value.toLowerCase());
}

function isQualifiedReferral(p: AirdropParticipant): boolean {
  return Boolean(p.wallet && p.checks.follow?.state === 'verified' && p.posts.length >= 1);
}

function dedupeSnapshotEntries(
  entries: readonly { wallet: string; tier: AirdropSnapshotTier; txCount?: number }[],
): { wallet: string; tier: AirdropSnapshotTier; txCount?: number }[] {
  const byWallet = new Map<string, { wallet: string; tier: AirdropSnapshotTier; txCount?: number }>();
  for (const entry of entries) {
    const wallet = entry.wallet.toLowerCase();
    const prev = byWallet.get(wallet);
    if (!prev) {
      byWallet.set(wallet, {
        wallet,
        tier: entry.tier,
        ...(entry.txCount !== undefined ? { txCount: entry.txCount } : {}),
      });
    } else {
      const tier: AirdropSnapshotTier =
        prev.tier === 'lz_winner' || entry.tier === 'lz_winner' ? 'lz_winner' : 'lz_user_5tx';
      const hasTxCount = prev.txCount !== undefined || entry.txCount !== undefined;
      byWallet.set(wallet, {
        wallet,
        tier,
        ...(hasTxCount ? { txCount: Math.max(prev.txCount ?? 0, entry.txCount ?? 0) } : {}),
      });
    }
  }
  return [...byWallet.values()];
}

function localTransaction(state: LocalState): AirdropTransaction {
  return {
    campaign: async () => structuredClone(state.campaign),
    saveCampaign: async value => {
      state.campaign = structuredClone(value);
    },
    importSnapshot: async (entries, mode, importedAt) => {
      const uniqueEntries = dedupeSnapshotEntries(entries);
      if (mode === 'replace') state.snapshot = {};
      for (const entry of uniqueEntries) {
        const wallet = entry.wallet;
        const prev = state.snapshot[wallet];
        const tier: AirdropSnapshotTier =
          prev?.tier === 'lz_winner' || entry.tier === 'lz_winner' ? 'lz_winner' : 'lz_user_5tx';
        const hasTxCount = prev?.txCount !== undefined || entry.txCount !== undefined;
        const txCount = Math.max(prev?.txCount ?? 0, entry.txCount ?? 0);
        state.snapshot[wallet] = {
          wallet,
          tier,
          ...(hasTxCount ? { txCount } : {}),
          importedAt,
        };
      }
      const values = Object.values(state.snapshot);
      return {
        imported: uniqueEntries.length,
        total: values.length,
        winners: values.filter(v => v.tier === 'lz_winner').length,
        fiveTx: values.filter(v => v.tier === 'lz_user_5tx').length,
      };
    },
    lookupSnapshot: async wallet => structuredClone(state.snapshot[wallet.toLowerCase()] || null),
    snapshotStats: async () => {
      const values = Object.values(state.snapshot);
      return {
        total: values.length,
        winners: values.filter(v => v.tier === 'lz_winner').length,
        fiveTx: values.filter(v => v.tier === 'lz_user_5tx').length,
      };
    },
    participant: async (field, value) =>
      structuredClone(Object.values(state.participants).find(p => fieldMatch(p, field, value)) || null),
    participantByPostId: async postId =>
      structuredClone(
        Object.values(state.participants).find(p => p.posts.some(post => post.postId === postId)) || null,
      ),
    saveParticipant: async participant => {
      const conflict = Object.values(state.participants).some(
        other =>
          other.id !== participant.id &&
          (other.userId === participant.userId ||
            other.profile.id === participant.profile.id ||
            other.code === participant.code ||
            (participant.wallet && other.wallet?.toLowerCase() === participant.wallet.toLowerCase())),
      );
      if (conflict) {
        throw new ApiError(409, 'AIRDROP_IDENTITY_USED', 'This X account or wallet is already used by another airdrop participant.');
      }
      state.participants[participant.id] = structuredClone(participant);
    },
    allParticipants: async () => structuredClone(Object.values(state.participants)),
    countQualifiedReferrals: async participantId =>
      Object.values(state.participants).filter(p => p.referrerId === participantId && isQualifiedReferral(p)).length,
    qualifiedReferralCounts: async () => {
      const counts: Record<string, number> = {};
      for (const p of Object.values(state.participants)) {
        if (p.referrerId && isQualifiedReferral(p)) {
          counts[p.referrerId] = (counts[p.referrerId] || 0) + 1;
        }
      }
      return counts;
    },
    referralCounts: async () => {
      const counts: Record<string, { total: number; qualified: number }> = {};
      for (const p of Object.values(state.participants)) {
        if (!p.referrerId) continue;
        const entry = (counts[p.referrerId] ||= { total: 0, qualified: 0 });
        entry.total += 1;
        if (isQualifiedReferral(p)) {
          entry.qualified += 1;
        }
      }
      return counts;
    },
    countReservedSlots: async () => {
      let slots = 0;
      let generalTokens = 0;
      for (const p of Object.values(state.participants)) {
        if (p.slotReserved) {
          slots++;
          generalTokens += p.reservedGeneralTokens;
        }
      }
      return { slots, generalTokens };
    },
    maxReservedSlotNumber: async () => {
      let max = 0;
      for (const p of Object.values(state.participants)) {
        if (typeof p.reservedSlotNumber === 'number' && p.reservedSlotNumber > max) {
          max = p.reservedSlotNumber;
        }
      }
      return max;
    },
    publishedMerkle: async () => structuredClone(state.publishedMerkle),
    publishedMerkleMeta: async () => {
      const merkle = state.publishedMerkle;
      if (!merkle) return null;
      return {
        root: merkle.root,
        chainId: merkle.chainId,
        distributor: merkle.distributor,
        totalCommittedRaw: merkle.totalCommittedRaw,
        publishedAt: merkle.publishedAt,
        recipientCount: Object.keys(merkle.allocations).length,
      };
    },
    publishedMerkleProof: async wallet => {
      const entry = state.publishedMerkle?.allocations[wallet.toLowerCase()];
      return entry ? structuredClone(entry) : null;
    },
    savePublishedMerkle: async merkle => {
      state.publishedMerkle = structuredClone(merkle);
    },
    budget: async (limit, now) => {
      const day = new Date(now).toISOString().slice(0, 10);
      for (const date of Object.keys(state.budget)) {
        if (date !== day) delete state.budget[date];
      }
      if ((state.budget[day] || 0) >= limit) return false;
      state.budget[day] = (state.budget[day] || 0) + 1;
      return true;
    },
    audit: async event => {
      state.audit.push(structuredClone(event));
    },
  };
}

export function memoryAirdropStore(): AirdropStore {
  let state = fresh();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    transaction<T>(fn: (tx: AirdropTransaction) => Promise<T>, options?: { readOnly?: boolean }) {
      if (options?.readOnly) {
        return tail.then(() => fn(localTransaction(structuredClone(state))));
      }
      const work = tail.then(async () => {
        const next = structuredClone(state);
        const result = await fn(localTransaction(next));
        state = next;
        return result;
      });
      tail = work.catch(() => undefined);
      return work;
    },
  };
}

export function createAirdropStore(pool: () => Pool | null = database): AirdropStore {
  return {
    async transaction<T>(fn: (tx: AirdropTransaction) => Promise<T>, options?: { readOnly?: boolean }) {
      const readOnly = Boolean(options?.readOnly);
      const db = pool();
      if (!db) {
        if (process.env.NODE_ENV === 'production') {
          throw new ApiError(503, 'AIRDROP_UNAVAILABLE', 'Airdrop records are temporarily unavailable. Please try again later.');
        }
        return withLocalNamespace<LocalState, Promise<T>>(
          'oneshot_airdrop',
          async records => {
            const state = structuredClone(records.airdrop || fresh());
            const result = await fn(localTransaction(state));
            if (!readOnly) records.airdrop = state;
            return result;
          },
          !readOnly,
        );
      }
      const client = await db.connect();
      try {
        let campaign: AirdropCampaign;
        if (readOnly) {
          await client.query('BEGIN READ ONLY');
          const row = await client.query("SELECT value FROM oneshot_airdrop_campaign WHERE id='airdrop'");
          campaign = row.rows[0]?.value
            ? airdropCampaignSchema.parse(row.rows[0].value)
            : airdropCampaignSchema.parse({});
        } else {
          await client.query('BEGIN');
          await client.query(
            "INSERT INTO oneshot_airdrop_campaign(id,value) VALUES('airdrop',$1) ON CONFLICT DO NOTHING",
            [JSON.stringify(airdropCampaignSchema.parse({}))],
          );
          const locked = await client.query("SELECT value FROM oneshot_airdrop_campaign WHERE id='airdrop' FOR UPDATE");
          campaign = airdropCampaignSchema.parse(locked.rows[0].value);
        }

        const tx: AirdropTransaction = {
          campaign: async () => structuredClone(campaign),
          saveCampaign: async value => {
            await client.query("UPDATE oneshot_airdrop_campaign SET value=$1 WHERE id='airdrop'", [JSON.stringify(value)]);
            campaign = value;
          },
          importSnapshot: async (entries, mode, importedAt) => {
            const uniqueEntries = dedupeSnapshotEntries(entries);
            if (mode === 'replace') {
              await client.query('TRUNCATE oneshot_airdrop_snapshot');
            }
            for (let i = 0; i < uniqueEntries.length; i += 1000) {
              const chunk = uniqueEntries.slice(i, i + 1000);
              const wallets = chunk.map(item => item.wallet);
              const tiers = chunk.map(item => item.tier);
              const txs = chunk.map(item => item.txCount ?? null);
              await client.query(
                `INSERT INTO oneshot_airdrop_snapshot(wallet, tier, tx_count, imported_at)
                 SELECT w, t, tc, $4::timestamptz
                 FROM unnest($1::text[], $2::text[], $3::int[]) AS u(w, t, tc)
                 ON CONFLICT(wallet) DO UPDATE SET
                   tier = CASE WHEN oneshot_airdrop_snapshot.tier='lz_winner' OR EXCLUDED.tier='lz_winner' THEN 'lz_winner' ELSE 'lz_user_5tx' END,
                   tx_count = CASE
                     WHEN oneshot_airdrop_snapshot.tx_count IS NULL AND EXCLUDED.tx_count IS NULL THEN NULL
                     ELSE GREATEST(COALESCE(oneshot_airdrop_snapshot.tx_count, 0), COALESCE(EXCLUDED.tx_count, 0))
                   END,
                   imported_at = EXCLUDED.imported_at`,
                [wallets, tiers, txs, importedAt],
              );
            }
            const stats = await tx.snapshotStats();
            return { imported: uniqueEntries.length, ...stats };
          },
          lookupSnapshot: async wallet => {
            const row = (
              await client.query(
                'SELECT wallet, tier, tx_count, imported_at FROM oneshot_airdrop_snapshot WHERE wallet=$1',
                [wallet.toLowerCase()],
              )
            ).rows[0];
            if (!row) return null;
            return {
              wallet: row.wallet,
              tier: row.tier,
              ...(row.tx_count !== null && row.tx_count !== undefined ? { txCount: Number(row.tx_count) } : {}),
              importedAt: new Date(row.imported_at).toISOString(),
            };
          },
          snapshotStats: async () => {
            const row = (
              await client.query(
                `SELECT count(*)::int AS total,
                        count(*) FILTER (WHERE tier='lz_winner')::int AS winners,
                        count(*) FILTER (WHERE tier='lz_user_5tx')::int AS five_tx
                 FROM oneshot_airdrop_snapshot`,
              )
            ).rows[0];
            return {
              total: Number(row?.total || 0),
              winners: Number(row?.winners || 0),
              fiveTx: Number(row?.five_tx || 0),
            };
          },
          participant: async (field, value) => {
            const column = { id: 'id', userId: 'user_id', xId: 'x_id', code: 'code', wallet: 'wallet' }[field];
            const val = field === 'wallet' ? value.toLowerCase() : value;
            const res = await client.query(`SELECT value FROM oneshot_airdrop_participants WHERE ${column}=$1`, [val]);
            return res.rows[0]?.value || null;
          },
          participantByPostId: async postId => {
            const res = await client.query(
              "SELECT value FROM oneshot_airdrop_participants WHERE value->'posts' @> $1::jsonb LIMIT 1",
              [JSON.stringify([{ postId }])],
            );
            return res.rows[0]?.value || null;
          },
          saveParticipant: async participant => {
            await client.query(
              `INSERT INTO oneshot_airdrop_participants(id, user_id, x_id, code, referrer_id, wallet, value)
               VALUES($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT(id) DO UPDATE SET
                 wallet = EXCLUDED.wallet,
                 value = EXCLUDED.value`,
              [
                participant.id,
                participant.userId,
                participant.profile.id,
                participant.code,
                participant.referrerId,
                participant.wallet ? participant.wallet.toLowerCase() : null,
                JSON.stringify(participant),
              ],
            );
          },
          allParticipants: async () =>
            (await client.query('SELECT value FROM oneshot_airdrop_participants ORDER BY created_at ASC, id ASC')).rows.map(
              row => row.value,
            ),
          countQualifiedReferrals: async participantId => {
            const row = (
              await client.query(
                `SELECT count(*)::int AS total
                 FROM oneshot_airdrop_participants
                 WHERE referrer_id=$1
                   AND wallet IS NOT NULL
                   AND value->'checks'->'follow'->>'state'='verified'
                   AND jsonb_array_length(COALESCE(value->'posts','[]')) >= 1`,
                [participantId],
              )
            ).rows[0];
            return Number(row?.total || 0);
          },
          qualifiedReferralCounts: async () => {
            const res = await client.query(
              `SELECT referrer_id, count(*)::int AS total
               FROM oneshot_airdrop_participants
               WHERE referrer_id IS NOT NULL
                 AND wallet IS NOT NULL
                 AND value->'checks'->'follow'->>'state'='verified'
                 AND jsonb_array_length(COALESCE(value->'posts','[]')) >= 1
               GROUP BY referrer_id`,
            );
            const counts: Record<string, number> = {};
            for (const row of res.rows) {
              if (row.referrer_id) counts[String(row.referrer_id)] = Number(row.total || 0);
            }
            return counts;
          },
          referralCounts: async () => {
            const res = await client.query(
              `SELECT
                 referrer_id,
                 count(*)::int AS total,
                 count(*) FILTER (
                   WHERE wallet IS NOT NULL
                     AND value->'checks'->'follow'->>'state'='verified'
                     AND jsonb_array_length(COALESCE(value->'posts','[]')) >= 1
                 )::int AS qualified
               FROM oneshot_airdrop_participants
               WHERE referrer_id IS NOT NULL
               GROUP BY referrer_id`,
            );
            const counts: Record<string, { total: number; qualified: number }> = {};
            for (const row of res.rows) {
              if (row.referrer_id) {
                counts[String(row.referrer_id)] = {
                  total: Number(row.total || 0),
                  qualified: Number(row.qualified || 0),
                };
              }
            }
            return counts;
          },
          countReservedSlots: async () => {
            const row = (
              await client.query(
                `SELECT count(*)::int AS slots,
                        COALESCE(sum(COALESCE((value->>'reservedGeneralTokens')::bigint, 0)), 0)::text AS tokens
                 FROM oneshot_airdrop_participants
                 WHERE COALESCE((value->>'slotReserved')::boolean, false) = true`,
              )
            ).rows[0];
            return {
              slots: Number(row?.slots || 0),
              generalTokens: Number(row?.tokens || 0),
            };
          },
          maxReservedSlotNumber: async () => {
            const row = (
              await client.query(
                `SELECT COALESCE(MAX((value->>'reservedSlotNumber')::int), 0)::int AS max_slot
                 FROM oneshot_airdrop_participants
                 WHERE value->>'reservedSlotNumber' ~ '^[0-9]+$'`,
              )
            ).rows[0];
            return Number(row?.max_slot || 0);
          },
          publishedMerkle: async () =>
            (await client.query("SELECT value FROM oneshot_airdrop_merkle WHERE id='published'")).rows[0]?.value || null,
          publishedMerkleMeta: async () => {
            const row = (
              await client.query(
                `SELECT value->>'root' AS root,
                        (value->>'chainId')::int AS chain_id,
                        value->>'distributor' AS distributor,
                        value->>'totalCommittedRaw' AS total_committed_raw,
                        value->>'publishedAt' AS published_at,
                        (SELECT count(*)::int FROM jsonb_object_keys(COALESCE(value->'allocations', '{}'::jsonb))) AS recipient_count
                 FROM oneshot_airdrop_merkle
                 WHERE id='published'`,
              )
            ).rows[0];
            if (!row) return null;
            return {
              root: String(row.root),
              chainId: Number(row.chain_id),
              distributor: String(row.distributor),
              totalCommittedRaw: String(row.total_committed_raw),
              publishedAt: String(row.published_at),
              recipientCount: Number(row.recipient_count || 0),
            };
          },
          publishedMerkleProof: async wallet => {
            const row = (
              await client.query(
                "SELECT value->'allocations'->($1::text) AS proof FROM oneshot_airdrop_merkle WHERE id='published'",
                [wallet.toLowerCase()],
              )
            ).rows[0];
            return (row?.proof as AirdropPublishedProof | null) || null;
          },
          savePublishedMerkle: async merkle => {
            await client.query(
              `INSERT INTO oneshot_airdrop_merkle(id, value, updated_at)
               VALUES('published', $1, now())
               ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
              [JSON.stringify(merkle)],
            );
          },
          budget: async (limit, now) => {
            const day = new Date(now).toISOString().slice(0, 10);
            const res = await client.query(
              `INSERT INTO oneshot_airdrop_budget(day, reads)
               SELECT $1, 1 WHERE $2 > 0
               ON CONFLICT(day) DO UPDATE SET reads = oneshot_airdrop_budget.reads + 1
               WHERE oneshot_airdrop_budget.reads < $2
               RETURNING reads`,
              [day, limit],
            );
            return res.rowCount === 1;
          },
          audit: async event => {
            await client.query('INSERT INTO oneshot_airdrop_audit(id, value) VALUES($1, $2)', [
              randomUUID(),
              JSON.stringify(event),
            ]);
          },
        };

        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        if ((error as { code?: string }).code === '23505') {
          throw new ApiError(409, 'AIRDROP_IDENTITY_USED', 'This X account or wallet is already used by another airdrop participant.');
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export const airdropStore = createAirdropStore();
