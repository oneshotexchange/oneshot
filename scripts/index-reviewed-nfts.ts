/** One bounded external ERC-721 journal pass. No wallet, authority key or broadcast. */
import { loadEnvFile } from 'node:process';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createVerifiedRpc, networkConfig, RpcError } from '@oneshot/evm';
import { parseReviewedNftManifest } from '../packages/evm/src/reviewed-nft';
import { assertLocalWatchDatabase } from '../apps/indexer/src/cli-options';
import { VerifiedReviewedNftJournalSource } from '../apps/indexer/src/reviewed-nft-source';
import { syncReviewedNftIndexer } from '../apps/indexer/src/reviewed-nft-engine';
import { PostgresIndexerStore } from '../apps/indexer/src/store';
import { IndexerError } from '../apps/indexer/src/types';
import { isManagedLocalDatabase, startLocalDatabaseKeeper } from '../deploy/local/local-runtime.mjs';

export function parseReviewedNftArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) { const key = args[i], value = args[i + 1]; if (!['--manifest', '--env-file', '--max-blocks', '--confirmations'].includes(key) || values.has(key) || !value?.trim() || value.startsWith('--')) throw new IndexerError('CLI_ARGUMENTS_INVALID'); values.set(key, value); }
  const manifest = values.get('--manifest'), blocks = values.get('--max-blocks') ?? '8', confirmations = values.get('--confirmations') ?? '2';
  if (!manifest || !/^(?:[1-9]|[12]\d|3[0-2])$/.test(blocks) || !/^(?:0|[1-9]|[1-5]\d|6[0-4])$/.test(confirmations)) throw new IndexerError('CLI_ARGUMENTS_INVALID');
  return { manifest, envFile: values.get('--env-file'), maxBlocks: Number(blocks), confirmationDepth: Number(confirmations) };
}
async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--help') { console.log('Usage: npm run indexer:reviewed-nfts -- --manifest PATH [--env-file PATH] [--max-blocks 1..32] [--confirmations 0..64]\nOne bounded, atomic-per-block canonical external ERC-721 journal pass. Local/Base Sepolia only; explicit loopback PostgreSQL required. Independent reviewed manifest; preserves registry-first deployment and observed history after revocation. Up to1024 collections,10000 logs/block,8 addresses/RPCbatch. Confirmations do not imply finality. No signing/submission.'); return; }
  let pool: Pool | undefined, keeper: Awaited<ReturnType<typeof startLocalDatabaseKeeper>> | undefined;
  const stop = new AbortController(), interrupt = () => stop.abort(); process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    const options = parseReviewedNftArguments(args); if (options.envFile) loadEnvFile(resolve(options.envFile));
    if (!['local', 'base-sepolia'].includes(process.env.ONESHOT_NETWORK ?? '')) throw new IndexerError('TEST_PROFILE_REQUIRED');
    assertLocalWatchDatabase(process.env.DATABASE_URL);
    const file = await open(resolve(options.manifest), 'r'); let manifest;
    try { if (!(await file.stat()).isFile() || (await file.stat()).size > 16_384) throw new IndexerError('MANIFEST_INVALID'); const bytes = Buffer.alloc(16_385), { bytesRead } = await file.read(bytes, 0, bytes.length, 0); if (bytesRead > 16_384) throw new IndexerError('MANIFEST_INVALID'); manifest = parseReviewedNftManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)))); } finally { await file.close(); }
    if (manifest.mode !== process.env.ONESHOT_NETWORK) throw new IndexerError('CHAIN_IDENTITY_MISMATCH');
    const source = new VerifiedReviewedNftJournalSource(await createVerifiedRpc(networkConfig(process.env)));
    if (isManagedLocalDatabase(process.env.DATABASE_URL)) keeper = await startLocalDatabaseKeeper();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 8000, query_timeout: 8000, idleTimeoutMillis: 1000 }); pool.on('error', () => stop.abort());
    const result = await syncReviewedNftIndexer(source, new PostgresIndexerStore(pool), manifest, { ...options, signal: stop.signal });
    console.log(JSON.stringify({ service: 'reviewed-nft-journal', ...result }, (_key, value) => typeof value === 'bigint' ? value.toString() : value)); if (stop.signal.aborted) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ service: 'reviewed-nft-journal', status: 'failed', code: error instanceof IndexerError || error instanceof RpcError ? error.code : 'REVIEWED_NFT_INDEXER_FAILED' })); process.exitCode = 1; }
  finally { await pool?.end().catch(() => undefined); await keeper?.stop(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main(process.argv.slice(2));
