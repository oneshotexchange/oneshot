import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { Pool } from 'pg';
import { airdropSnapshotTierSchema, type AirdropSnapshotTier } from '../apps/web/lib/airdrop-schema';
import { importSnapshotFiles } from './lib/airdrop-snapshot-import';

const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
  console.log(
    'Usage: npm run airdrop:import-snapshot -- --file PATH [--file PATH2 ...] [--tier auto|lz_winner|lz_user_5tx] [--min-tx N] [--mode merge|replace] [--batch-size N] [--dry-run] [--actor NAME] [--env-file PATH]\n' +
      'Streams multi-million-row LayerZero winner / Dune 5+ tx snapshot CSVs into PostgreSQL in bounded memory.',
  );
  process.exit(0);
}

const files: string[] = [];
let tierArg: string | undefined;
let minTxCount: number | undefined;
let mode: 'merge' | 'replace' = 'merge';
let batchSize = 10_000;
let dryRun = false;
let actor = 'cli:import-snapshot';

for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--dry-run') {
    dryRun = true;
    continue;
  }
  const value = args[i + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  if (flag === '--file') {
    files.push(path.resolve(process.cwd(), value));
  } else if (flag === '--tier') {
    tierArg = value;
  } else if (flag === '--min-tx') {
    if (!/^\d+$/.test(value)) throw new Error('Invalid --min-tx value.');
    minTxCount = Number(value);
  } else if (flag === '--mode') {
    if (value !== 'merge' && value !== 'replace') throw new Error('--mode must be merge or replace.');
    mode = value;
  } else if (flag === '--batch-size') {
    if (!/^\d+$/.test(value)) throw new Error('Invalid --batch-size value.');
    batchSize = Number(value);
  } else if (flag === '--actor') {
    actor = value;
  } else if (flag === '--env-file') {
    loadEnvFile(path.resolve(process.cwd(), value));
  } else {
    throw new Error(`Unknown flag ${flag}`);
  }
  i++;
}

let defaultTier: AirdropSnapshotTier | undefined;
if (tierArg && tierArg !== 'auto') {
  defaultTier = airdropSnapshotTierSchema.parse(tierArg);
}

let pool: Pool | null = null;
if (!dryRun) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required unless --dry-run is set.');
  }
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
}

try {
  const result = await importSnapshotFiles({
    files,
    mode,
    ...(defaultTier ? { defaultTier } : {}),
    ...(minTxCount !== undefined ? { minTxCount } : {}),
    batchSize,
    dryRun,
    actor,
    pool,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool?.end();
}
