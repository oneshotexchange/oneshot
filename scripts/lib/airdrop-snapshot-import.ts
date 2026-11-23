import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import type { Pool, PoolClient } from 'pg';
import {
  airdropCampaignSchema,
  detectSnapshotCsvHeader,
  parseSnapshotCsvRow,
  type AirdropSnapshotTier,
  type SnapshotCsvColumnMap,
} from '../../apps/web/lib/airdrop-schema';

export type SnapshotBatchRow = {
  wallet: string;
  tier: AirdropSnapshotTier;
  txCount?: number;
};

export type ImportSnapshotFilesOptions = {
  files: readonly string[];
  mode: 'merge' | 'replace';
  defaultTier?: AirdropSnapshotTier;
  minTxCount?: number;
  batchSize?: number;
  dryRun?: boolean;
  actor?: string;
  pool?: Pool | null;
  now?: () => number;
};

export type ImportSnapshotFilesResult =
  | {
      dryRun: true;
      mode: 'merge' | 'replace';
      files: string[];
      processedLines: number;
      acceptedRows: number;
      skippedRows: number;
      batches: number;
    }
  | {
      dryRun: false;
      mode: 'merge' | 'replace';
      files: string[];
      processedLines: number;
      acceptedRows: number;
      skippedRows: number;
      batches: number;
      uniqueImported: number;
      total: number;
      winners: number;
      fiveTx: number;
    };

function mergeBatchRow(batch: Map<string, SnapshotBatchRow>, entry: SnapshotBatchRow) {
  const prev = batch.get(entry.wallet);
  if (!prev) {
    batch.set(entry.wallet, entry);
    return;
  }
  const tier: AirdropSnapshotTier =
    prev.tier === 'lz_winner' || entry.tier === 'lz_winner' ? 'lz_winner' : 'lz_user_5tx';
  const hasTxCount = prev.txCount !== undefined || entry.txCount !== undefined;
  batch.set(entry.wallet, {
    wallet: entry.wallet,
    tier,
    ...(hasTxCount ? { txCount: Math.max(prev.txCount ?? 0, entry.txCount ?? 0) } : {}),
  });
}

async function flushBatchToStage(client: PoolClient, batch: Map<string, SnapshotBatchRow>) {
  if (!batch.size) return;
  const rows = [...batch.values()];
  await client.query(
    `INSERT INTO _airdrop_snapshot_stage(wallet, tier, tx_count)
     SELECT w, t, tc
     FROM unnest($1::text[], $2::text[], $3::int[]) AS u(w, t, tc)
     ON CONFLICT(wallet) DO UPDATE SET
       tier = CASE
         WHEN _airdrop_snapshot_stage.tier='lz_winner' OR EXCLUDED.tier='lz_winner' THEN 'lz_winner'
         ELSE 'lz_user_5tx'
       END,
       tx_count = CASE
         WHEN _airdrop_snapshot_stage.tx_count IS NULL AND EXCLUDED.tx_count IS NULL THEN NULL
         ELSE GREATEST(COALESCE(_airdrop_snapshot_stage.tx_count, 0), COALESCE(EXCLUDED.tx_count, 0))
       END`,
    [rows.map(r => r.wallet), rows.map(r => r.tier), rows.map(r => r.txCount ?? null)],
  );
  batch.clear();
}

async function streamImportToPostgres(
  client: PoolClient,
  options: ImportSnapshotFilesOptions,
  batchSize: number,
): Promise<ImportSnapshotFilesResult> {
  await client.query('BEGIN');
  try {
    await client.query(
      "INSERT INTO oneshot_airdrop_campaign(id,value) VALUES('airdrop',$1) ON CONFLICT DO NOTHING",
      [JSON.stringify(airdropCampaignSchema.parse({}))],
    );
    const locked = await client.query("SELECT value FROM oneshot_airdrop_campaign WHERE id='airdrop' FOR UPDATE");
    const campaign = airdropCampaignSchema.parse(locked.rows[0].value);

    if (options.mode === 'replace') {
      const merkle = await client.query("SELECT 1 FROM oneshot_airdrop_merkle WHERE id='published'");
      if (campaign.claimingOpen || (merkle.rowCount ?? 0) > 0) {
        throw new Error('AIRDROP_CLAIMS_FROZEN: Cannot replace snapshot after final airdrop allocations are published.');
      }
    }

    await client.query(
      `CREATE TEMP TABLE _airdrop_snapshot_stage (
        wallet TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        tx_count INTEGER
      ) ON COMMIT DROP`,
    );

    const pending = new Map<string, SnapshotBatchRow>();
    let processedLines = 0;
    let acceptedRows = 0;
    let skippedRows = 0;
    let batches = 0;

    for (const filePath of options.files) {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let inspectedFirstLine = false;
      let columns: SnapshotCsvColumnMap | null = null;
      let lineNumber = 0;

      try {
        for await (const rawLine of rl) {
          lineNumber++;
          processedLines++;
          const clean = rawLine.replace(/^\uFEFF/, '').trim();
          if (!clean || clean.startsWith('#')) continue;

          if (!inspectedFirstLine) {
            inspectedFirstLine = true;
            columns = detectSnapshotCsvHeader(clean);
            if (columns) continue;
          }

          let parsed;
          try {
            parsed = parseSnapshotCsvRow(clean, lineNumber, columns, {
              ...(options.defaultTier ? { defaultTier: options.defaultTier } : {}),
              ...(options.minTxCount !== undefined ? { minTxCount: options.minTxCount } : {}),
            });
          } catch (error) {
            throw new Error(`${path.basename(filePath)}: ${(error as Error).message}`);
          }

          if (parsed.status === 'skip') {
            skippedRows++;
            continue;
          }

          acceptedRows++;
          mergeBatchRow(pending, parsed.entry);

          if (pending.size >= batchSize) {
            await flushBatchToStage(client, pending);
            batches++;
          }
        }
      } finally {
        rl.close();
        stream.destroy();
      }
    }

    if (pending.size > 0) {
      await flushBatchToStage(client, pending);
      batches++;
    }

    if (acceptedRows === 0) {
      throw new Error('Snapshot files contained no valid eligible wallet rows.');
    }

    if (options.mode === 'replace') {
      await client.query('TRUNCATE oneshot_airdrop_snapshot');
    }

    const importedAt = new Date((options.now || Date.now)()).toISOString();
    await client.query(
      `INSERT INTO oneshot_airdrop_snapshot(wallet, tier, tx_count, imported_at)
       SELECT wallet, tier, tx_count, $1::timestamptz
       FROM _airdrop_snapshot_stage
       ON CONFLICT(wallet) DO UPDATE SET
         tier = CASE
           WHEN oneshot_airdrop_snapshot.tier='lz_winner' OR EXCLUDED.tier='lz_winner' THEN 'lz_winner'
           ELSE 'lz_user_5tx'
         END,
         tx_count = CASE
           WHEN oneshot_airdrop_snapshot.tx_count IS NULL AND EXCLUDED.tx_count IS NULL THEN NULL
           ELSE GREATEST(COALESCE(oneshot_airdrop_snapshot.tx_count, 0), COALESCE(EXCLUDED.tx_count, 0))
         END,
         imported_at = EXCLUDED.imported_at`,
      [importedAt],
    );

    const stagedCount = Number(
      (await client.query('SELECT count(*)::int AS c FROM _airdrop_snapshot_stage')).rows[0]?.c || 0,
    );
    const statsRow = (
      await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE tier='lz_winner')::int AS winners,
                count(*) FILTER (WHERE tier='lz_user_5tx')::int AS five_tx
         FROM oneshot_airdrop_snapshot`,
      )
    ).rows[0];

    const stats = {
      total: Number(statsRow?.total || 0),
      winners: Number(statsRow?.winners || 0),
      fiveTx: Number(statsRow?.five_tx || 0),
    };

    await client.query('INSERT INTO oneshot_airdrop_audit(id, value) VALUES($1, $2)', [
      randomUUID(),
      JSON.stringify({
        at: importedAt,
        actor: options.actor || 'cli:import-snapshot',
        action: 'import_snapshot_files',
        details: {
          mode: options.mode,
          files: options.files.map(file => path.basename(file)),
          processedLines,
          acceptedRows,
          skippedRows,
          uniqueImported: stagedCount,
          ...stats,
        },
      }),
    ]);

    await client.query('COMMIT');
    return {
      dryRun: false,
      mode: options.mode,
      files: [...options.files],
      processedLines,
      acceptedRows,
      skippedRows,
      batches,
      uniqueImported: stagedCount,
      ...stats,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function importSnapshotFiles(options: ImportSnapshotFilesOptions): Promise<ImportSnapshotFilesResult> {
  if (!options.files.length) {
    throw new Error('Specify at least one snapshot CSV or TXT file.');
  }
  const batchSize = options.batchSize ?? 10_000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50_000) {
    throw new Error('batchSize must be an integer between 1 and 50,000.');
  }

  if (options.dryRun) {
    const pending = new Map<string, SnapshotBatchRow>();
    let processedLines = 0;
    let acceptedRows = 0;
    let skippedRows = 0;
    let batches = 0;

    for (const filePath of options.files) {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let inspectedFirstLine = false;
      let columns: SnapshotCsvColumnMap | null = null;
      let lineNumber = 0;

      try {
        for await (const rawLine of rl) {
          lineNumber++;
          processedLines++;
          const clean = rawLine.replace(/^\uFEFF/, '').trim();
          if (!clean || clean.startsWith('#')) continue;

          if (!inspectedFirstLine) {
            inspectedFirstLine = true;
            columns = detectSnapshotCsvHeader(clean);
            if (columns) continue;
          }

          let parsed;
          try {
            parsed = parseSnapshotCsvRow(clean, lineNumber, columns, {
              ...(options.defaultTier ? { defaultTier: options.defaultTier } : {}),
              ...(options.minTxCount !== undefined ? { minTxCount: options.minTxCount } : {}),
            });
          } catch (error) {
            throw new Error(`${path.basename(filePath)}: ${(error as Error).message}`);
          }

          if (parsed.status === 'skip') {
            skippedRows++;
            continue;
          }

          acceptedRows++;
          mergeBatchRow(pending, parsed.entry);
          if (pending.size >= batchSize) {
            pending.clear();
            batches++;
          }
        }
      } finally {
        rl.close();
        stream.destroy();
      }
    }

    if (pending.size > 0) {
      pending.clear();
      batches++;
    }
    if (acceptedRows === 0) {
      throw new Error('Snapshot files contained no valid eligible wallet rows.');
    }

    return {
      dryRun: true,
      mode: options.mode,
      files: [...options.files],
      processedLines,
      acceptedRows,
      skippedRows,
      batches,
    };
  }

  if (!options.pool) {
    throw new Error('DATABASE_URL is required unless --dry-run is specified.');
  }

  const client = await options.pool.connect();
  try {
    return await streamImportToPostgres(client, options, batchSize);
  } finally {
    client.release();
  }
}
