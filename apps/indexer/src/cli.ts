import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createVerifiedRpc, networkConfig, RpcError } from '@oneshot/evm';
import { syncIndexer } from './engine';
import { manifestId, parseManifest } from './manifest';
import { VerifiedRpcSource } from './rpc-source';
import { PostgresIndexerStore } from './store';
import { IndexerError } from './types';
import { assertLocalWatchDatabase, parseIndexerArguments } from './cli-options';
import { watchIndexer } from './watch';
import { acquireIndexerWatchLease } from './watch-lease';
import { isManagedLocalDatabase, startLocalDatabaseKeeper } from '../../../deploy/local/local-runtime.mjs';

// Explicit local tool, separate from the still-disabled Zero worker.
let store: PostgresIndexerStore | undefined;
let pool: Pool | undefined;
let keeper: Awaited<ReturnType<typeof startLocalDatabaseKeeper>> | undefined;
let lease: Awaited<ReturnType<typeof acquireIndexerWatchLease>> | undefined;
const controller = new AbortController();
let shutdownCode: number | undefined;
const stop = (signal: 'SIGINT' | 'SIGTERM') => { shutdownCode ??= signal === 'SIGINT' ? 130 : 143; controller.abort(); };
const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
const connectionLost = () => { shutdownCode = 1; controller.abort(); };
try {
  const options = parseIndexerArguments(process.argv.slice(2));
  if (options.envFile) loadEnvFile(resolve(options.envFile));
  if (process.env.ONESHOT_NETWORK !== 'local') throw new IndexerError('LOCAL_PROFILE_REQUIRED');
  if (options.watch) assertLocalWatchDatabase(process.env.DATABASE_URL);
  if (!process.env.DATABASE_URL) throw new IndexerError('DATABASE_REQUIRED');
  const file = await readFile(resolve(options.manifest));
  if (file.length > 16_384) throw new IndexerError('MANIFEST_INVALID');
  const manifest = parseManifest(JSON.parse(file.toString('utf8')));
  const source = new VerifiedRpcSource(await createVerifiedRpc(networkConfig(process.env)));
  if (isManagedLocalDatabase(process.env.DATABASE_URL)) keeper = await startLocalDatabaseKeeper({ onUnexpectedExit: connectionLost });
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: options.watch ? 3 : 2,
    idleTimeoutMillis: 10_000, connectionTimeoutMillis: 8000, statement_timeout: 8000, query_timeout: 8000, lock_timeout: 8000 });
  // pg can emit an idle-connection error; keep diagnostics credential-free.
  pool.on('error', () => { connectionLost(); console.error(JSON.stringify({ service: 'oneshot-local-indexer', error: 'DATABASE_CONNECTION_LOST' })); });
  store = new PostgresIndexerStore(pool);
  if (options.watch) {
    lease = await acquireIndexerWatchLease(pool, manifestId(manifest), connectionLost);
    await watchIndexer(source, store, manifest, { ...options, signal: controller.signal,
      onEvent: event => console.log(JSON.stringify({ service: 'oneshot-local-indexer', network: 'Local Anvil (not Zero)', ...event })) });
    process.exitCode = shutdownCode ?? 0;
  } else {
    const result = await syncIndexer(source, store, manifest, {
      maxBlocks: options.maxBlocks, confirmationDepth: options.confirmationDepth, maxReorgDepth: options.maxReorgDepth,
    });
    const counts = await store.transaction(async tx => ({
      collections: Object.keys(await tx.list('collections')).length,
      items: Object.keys(await tx.list('items')).length,
      listings: Object.keys(await tx.list('listings')).length,
    }));
    console.log(JSON.stringify({ service: 'oneshot-local-indexer', network: 'Local Anvil (not Zero)',
      processed: result.processed, rolledBack: result.rolledBack, caughtUp: result.caughtUp,
      head: result.head ? { number: result.head.number.toString(), hash: result.head.hash } : null,
      target: result.target.toString(), counts, finality: 'Not asserted; local confirmation depth only' }, null, 2));
    if (shutdownCode !== undefined) process.exitCode = shutdownCode;
  }
} catch (error) {
  const code = error instanceof IndexerError || error instanceof RpcError ? error.code : 'INDEXER_FAILED';
  console.error(JSON.stringify({ service: 'oneshot-local-indexer', status: 'stopped', error: code,
    message: 'No transactions were submitted. The last committed checkpoint is retained; inspect local configuration and manifest.' }));
  process.exitCode = 1;
} finally {
  // The pass has drained before its exclusive lease or database connections close.
  await lease?.release().catch(() => { process.exitCode = 1; });
  if (store) await store.close().catch(() => undefined);
  else await pool?.end().catch(() => undefined);
  await keeper?.stop().catch(() => { process.exitCode = 1; });
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
}
