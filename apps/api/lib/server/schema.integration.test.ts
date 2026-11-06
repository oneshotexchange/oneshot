import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

const connectionString = process.env.ONESHOT_API_TEST_DATABASE_URL;

describe.skipIf(!connectionString)('concurrent PostgreSQL schema initialization', () => {
  it('initializes a fresh schema concurrently and preserves existing records on rerun', async () => {
    const target = new URL(connectionString!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      || target.pathname !== '/oneshot_indexer_test') {
      throw new Error('Schema checks require the dedicated local test database.');
    }
    const schema = `schema_test_${randomUUID().replaceAll('-', '')}`;
    const manager = new Pool({ connectionString, max: 1 });
    let pool: Pool | undefined;
    try {
      await manager.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString, max: 6, options: `-c search_path=${schema}`, statement_timeout: 10_000 });
      const sql = await readFile(new URL('../../../../db/schema.sql', import.meta.url), 'utf8');
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => pool!.query(sql)));
      expect(results.map(result => result.status)).toEqual(Array(6).fill('fulfilled'));
      await pool.query("INSERT INTO b20_app_records (namespace,id,value) VALUES ('schema_test','retained','{\"retained\":true}')");
      await pool.query(sql);
      const retained = await pool.query("SELECT value FROM b20_app_records WHERE namespace='schema_test' AND id='retained'");
      expect(retained.rows).toEqual([{ value: { retained: true } }]);
      const tables = await pool.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [schema]);
      expect(tables.rows.map(row => row.tablename)).toEqual(expect.arrayContaining([
        'b20_app_records', 'oneshot_genesis_identities', 'oneshot_genesis_applications', 'oneshot_genesis_jobs',
      ]));
    } finally {
      await pool?.end();
      await manager.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await manager.end();
    }
  }, 30_000);
});
