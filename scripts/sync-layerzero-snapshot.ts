import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { Pool } from 'pg';
import { syncLayerZeroSnapshot } from './lib/layerzero-sync';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(
    'Usage: npm run airdrop:sync-layerzero -- [--from-block N] [--to-block N] [--chunk-size N] [--max-wallets N] [--max-scan-wallets N] [--rpc-url URL] [--scan-url URL] [--cutoff ISO] [--include-scan] [--dry-run] [--actor NAME] [--env-file PATH]\n' +
      'Fetches historical LayerZero ZRO claimers from Arbitrum One (0xd6b6...94db) and optionally 5+ tx users from LayerZero Scan into PostgreSQL.',
  );
  process.exit(0);
}

let fromBlock: number | undefined;
let toBlock: number | undefined;
let chunkSize: number | undefined;
let maxWallets: number | undefined;
let maxScanWallets: number | undefined;
let rpcUrl: string | undefined;
let scanApiUrl: string | undefined;
let cutoffAt: string | undefined;
let includeScan = false;
let dryRun = false;
let actor = 'cli:sync-layerzero';

for (let i = 0; i < args.length; i++) {
  const flag = args[i]!;
  if (flag === '--include-scan') {
    includeScan = true;
    continue;
  }
  if (flag === '--dry-run') {
    dryRun = true;
    continue;
  }
  const value = args[i + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  if (flag === '--from-block') {
    if (!/^\d+$/.test(value)) throw new Error('Invalid --from-block value.');
    fromBlock = Number(value);
  } else if (flag === '--to-block') {
    if (!/^\d+$/.test(value)) throw new Error('Invalid --to-block value.');
    toBlock = Number(value);
  } else if (flag === '--chunk-size') {
    if (!/^\d+$/.test(value)) throw new Error('Invalid --chunk-size value.');
    chunkSize = Number(value);
  } else if (flag === '--max-wallets') {
    if (!/^\d+$/.test(value)) throw new Error('Invalid --max-wallets value.');
    maxWallets = Number(value);
  } else if (flag === '--max-scan-wallets') {
    if (!/^\d+$/.test(value)) throw new Error('Invalid --max-scan-wallets value.');
    maxScanWallets = Number(value);
  } else if (flag === '--rpc-url') {
    rpcUrl = value;
  } else if (flag === '--scan-url') {
    scanApiUrl = value;
  } else if (flag === '--cutoff') {
    cutoffAt = value;
  } else if (flag === '--actor') {
    actor = value;
  } else if (flag === '--env-file') {
    loadEnvFile(path.resolve(process.cwd(), value));
  } else {
    throw new Error(`Unknown flag ${flag}`);
  }
  i++;
}

let pool: Pool | null = null;
if (!dryRun) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required unless --dry-run is specified.');
  }
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
}

try {
  const summary = await syncLayerZeroSnapshot({
    ...(fromBlock !== undefined ? { fromBlock } : {}),
    ...(toBlock !== undefined ? { toBlock } : {}),
    ...(chunkSize !== undefined ? { chunkSize } : {}),
    ...(maxWallets !== undefined ? { maxWallets } : {}),
    ...(maxScanWallets !== undefined ? { maxScanWallets } : {}),
    ...(rpcUrl ? { rpcUrl } : {}),
    ...(scanApiUrl ? { scanApiUrl } : {}),
    ...(cutoffAt ? { cutoffAt } : {}),
    includeScan,
    dryRun,
    actor,
    pool,
  });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await pool?.end();
}
