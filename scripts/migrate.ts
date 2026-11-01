import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { INDEXING_SCHEMA_SQL } from '../apps/worker/src/schema';
const args = process.argv.slice(2);
if (args.length === 2 && args[0] === '--env-file' && args[1]) {
  try { loadEnvFile(resolve(args[1])); }
  catch { throw new Error('The explicitly specified environment file could not be loaded.'); }
} else if (args.length) throw new Error('Usage: npm run db:migrate [-- --env-file PATH]');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Local development storage needs no migration.');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await db.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await db.query(INDEXING_SCHEMA_SQL);
  console.log('Application records and retained legacy indexer schemas migrated. No chain worker was started.');
} finally { await db.end(); }
