/** Read-only Zero/local identity probe. Never signs, funds or broadcasts a transaction. */
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { networkConfig } from '@oneshot/evm';
import { RpcError, verifyRpcNetwork, type RpcProviderLabel } from '../packages/evm/src/rpc';

export async function verifyConfiguredNetwork(env: Record<string, string | undefined>) {
  let config: ReturnType<typeof networkConfig>;
  try { config = networkConfig(env); }
  catch { throw new RpcError('CONFIG_INVALID'); }
  const provider = (env.ONESHOT_RPC_PROVIDER || 'custom') as RpcProviderLabel;
  const result = await verifyRpcNetwork(config, { provider });
  return {
    status: 'verified', mode: result.mode,
    note: result.mode === 'local' ? 'Local Anvil verification; this is not Zero.' : 'RPC identity matches configured chain and genesis.',
    chainId: result.chainId, genesisHash: result.genesisHash, genesisMatched: result.genesisMatched,
    latestBlock: result.latestBlock.toString(), checkedAt: result.checkedAt, provider: result.provider,
    nativeSymbol: config.nativeSymbol, nativeDecimals: config.nativeDecimals,
    nativePrecisionSource: result.mode === 'local' ? 'local Anvil profile' : 'configuration; not independently proved by RPC',
  };
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: npm run verify:network [-- --env-file PATH]\nReads process.env unless an environment file is explicitly specified. Zero requires verified official configuration. ONESHOT_NETWORK=local selects Anvil 31337/ETH18. No signing or broadcasting.');
    return;
  }
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--env-file' && args[1])) {
    console.error(JSON.stringify({ status: 'failed', code: 'INVALID_ARGUMENTS', message: 'Use --help for the supported arguments.' }));
    process.exitCode = 1;
    return;
  }
  if (args.length === 2) {
    try { loadEnvFile(resolve(args[1])); }
    catch {
      console.error(JSON.stringify({ status: 'failed', code: 'ENV_FILE_UNAVAILABLE', message: 'The explicitly specified environment file could not be loaded.' }));
      process.exitCode = 1;
      return;
    }
  }
  try { console.log(JSON.stringify(await verifyConfiguredNetwork(process.env), null, 2)); }
  catch (error) {
    // Never print thrown URL parser, fetch, response or environment-file details.
    const safe = error instanceof RpcError ? error : new RpcError('RPC_UNAVAILABLE');
    console.error(JSON.stringify({ status: 'failed', code: safe.code, message: safe.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main(process.argv.slice(2));
