/** Bounded token market maintenance keeper. Dry-run by default; requires --execute and env private key to submit. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RpcError } from '@oneshot/evm';
import { IndexerError } from '../apps/indexer/src/types';
import {
  MaintenanceWorkerError,
  parseMaintenanceArgs,
  runTokenMaintenance,
} from './lib/token-maintenance';

async function main(args: readonly string[]) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: npm run token:maintenance -- --manifest PATH [--env-file PATH] [--max-native 1] [--max-token 10000000] [--max-markets 1..32] [--market ADDRESS] [--execute]\n' +
        'Bounded token maintenance keeper. Dry-run by default (simulates process() without signing). ' +
        'Passing --execute reads ONESHOT_KEEPER_PRIVATE_KEY from the environment only.',
    );
    return;
  }

  try {
    const options = parseMaintenanceArgs(args);
    const result = await runTokenMaintenance(options);
    console.log(JSON.stringify(result));
  } catch (error) {
    const code =
      error instanceof MaintenanceWorkerError || error instanceof RpcError || error instanceof IndexerError
        ? error.code
        : 'TOKEN_MAINTENANCE_FAILED';
    const message = error instanceof MaintenanceWorkerError ? error.message : 'Token maintenance failed.';
    console.error(JSON.stringify({ status: 'failed', code, message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2));
}
