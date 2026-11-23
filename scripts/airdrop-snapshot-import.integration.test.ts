import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { importSnapshotFiles } from './lib/airdrop-snapshot-import';
import { airdropCampaignSchema } from '../apps/web/lib/airdrop-schema';

// Dedicated opt-in test DB only. Each run owns a separate temporary schema.
const connectionString = process.env.ONESHOT_API_TEST_DATABASE_URL;

describe.skipIf(!connectionString)('Streaming LayerZero snapshot CLI importer on PostgreSQL', () => {
  it('streams multiple CSV formats atomically, promotes duplicate higher tiers, and blocks replace after Merkle publish', async () => {
    const target = new URL(connectionString!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
      throw new Error('Snapshot importer integration checks require an explicitly local test database.');
    }

    const schema = 'airdrop_cli_' + randomUUID().replaceAll('-', '');
    const manager = new Pool({ connectionString, max: 1 });
    let pool: Pool | undefined;
    const tempDir = await mkdtemp(path.join(tmpdir(), 'oneshot-lz-import-'));

    try {
      await manager.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` });
      await pool.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));

      const w1 = '0x1111111111111111111111111111111111111111';
      const w2 = '0x2222222222222222222222222222222222222222';
      const w3 = '0x3333333333333333333333333333333333333333';
      const w4 = '0x4444444444444444444444444444444444444444';
      const w5 = '0x5555555555555555555555555555555555555555';

      const winnersCsv = path.join(tempDir, 'lz-winners.csv');
      const duneCsv = path.join(tempDir, 'dune-txs.csv');
      const listCsv = path.join(tempDir, 'extra-winners.txt');

      await writeFile(
        winnersCsv,
        [
          'address,isEligible,zroAllocation',
          `${w1},true,"1,200.5"`,
          `${w2},false,500`,
          `${w3},true,0`,
        ].join('\n'),
      );
      await writeFile(
        duneCsv,
        [
          'user_address,tx_count',
          `0x${w1.slice(2).toUpperCase()},9`,
          `${w4},7`,
          `${w3},3`,
        ].join('\n'),
      );
      await writeFile(listCsv, `${w5}\n`);

      // 1. Dry-run validates without mutating DB
      const dry = await importSnapshotFiles({
        files: [winnersCsv, duneCsv],
        mode: 'replace',
        batchSize: 2,
        dryRun: true,
        pool,
      });
      expect(dry).toMatchObject({ dryRun: true, acceptedRows: 3, skippedRows: 3 });
      expect((await pool.query('SELECT count(*)::int AS c FROM oneshot_airdrop_snapshot')).rows[0].c).toBe(0);

      // 2. Replace import streams across batches and promotes w1 to lz_winner with tx_count 9
      const imported = await importSnapshotFiles({
        files: [winnersCsv, duneCsv],
        mode: 'replace',
        batchSize: 1,
        pool,
        actor: 'cli:test',
      });
      expect(imported).toMatchObject({
        dryRun: false,
        uniqueImported: 2,
        total: 2,
        winners: 1,
        fiveTx: 1,
      });

      const w1Row = (
        await pool.query('SELECT tier, tx_count FROM oneshot_airdrop_snapshot WHERE wallet=$1', [w1])
      ).rows[0];
      expect(w1Row).toEqual({ tier: 'lz_winner', tx_count: 9 });

      // 3. Merge single-column winner list
      const merged = await importSnapshotFiles({
        files: [listCsv],
        mode: 'merge',
        defaultTier: 'lz_winner',
        pool,
      });
      expect(merged).toMatchObject({ total: 3, winners: 2, fiveTx: 1 });

      // 4. Block replace once final Merkle root is published
      await pool.query(
        "INSERT INTO oneshot_airdrop_campaign(id, value) VALUES('airdrop', $1) ON CONFLICT DO NOTHING",
        [JSON.stringify(airdropCampaignSchema.parse({}))],
      );
      await pool.query("INSERT INTO oneshot_airdrop_merkle(id, value) VALUES('published', '{}'::jsonb)");
      await expect(
        importSnapshotFiles({ files: [listCsv], mode: 'replace', defaultTier: 'lz_winner', pool }),
      ).rejects.toThrow(/AIRDROP_CLAIMS_FROZEN/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await pool?.end();
      await manager.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await manager.end();
    }
  }, 30_000);
});
