import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import {
  createWalletClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createVerifiedRpc,
  networkConfig,
  parseAssetAmount,
  TOKEN_MAINTENANCE_LIFETIME_SECONDS,
  TOKEN_MARKET_ABI,
  TOKEN_MARKET_FACTORY_ABI,
  type NetworkConfig,
  type RpcReadMethod,
  type RpcVerification,
} from '@oneshot/evm';
import { loadTokenManifestFile } from '../../apps/api/lib/server/indexed-tokens';
import type { TokenManifest } from '../../apps/indexer/src/token-manifest';
import { VerifiedTokenSource } from '../../apps/indexer/src/token-source';

export class MaintenanceWorkerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MaintenanceWorkerError';
  }
}

export type MaintenanceWorkerOptions = {
  manifest: string;
  envFile?: string;
  maxNativeBudget: string;
  maxTokenBudget: string;
  maxMarkets: number;
  market?: Address;
  execute: boolean;
};

export type MaintenanceMarketCandidate = {
  market: Address;
  pendingLpNativeRaw: string;
  pendingLpTokenRaw: string;
  pendingLiquidityNativeRaw: string;
  pendingLiquidityTokenRaw: string;
  pendingBurnNativeRaw: string;
  totalPendingUnits: string;
  ready: boolean;
  reason?: string;
  txHash?: Hex;
};

export type MaintenanceWorkerResult = {
  status: 'completed';
  dryRun: boolean;
  network: string;
  chainId: number;
  blockNumber: string;
  blockHash: Hex;
  checked: number;
  ready: number;
  executed: number;
  markets: MaintenanceMarketCandidate[];
};

export type MaintenanceRpc = {
  verification: RpcVerification;
  readRpc: (method: RpcReadMethod, params?: readonly unknown[]) => Promise<unknown>;
};

export type MaintenanceDependencies = {
  loadManifest?: (path: string) => Promise<TokenManifest>;
  createRpc?: (config: NetworkConfig) => Promise<MaintenanceRpc>;
  submitTransaction?: (input: {
    config: NetworkConfig;
    verification: RpcVerification;
    to: Address;
    data: Hex;
    privateKey: Hex;
  }) => Promise<Hex>;
};

const ADDRESS_PATTERN = /^0x[\da-f]{40}$/i;
const PRIVATE_KEY_PATTERN = /^0x[\da-f]{64}$/i;
const MAX_MARKETS_CAP = 32;

export function parseMaintenanceArgs(args: readonly string[]): MaintenanceWorkerOptions {
  const values = new Map<string, string>();
  let execute = false;
  const valueFlags = new Set(['--manifest', '--env-file', '--max-native', '--max-token', '--max-markets', '--market']);

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--execute') {
      if (execute) throw new MaintenanceWorkerError('CLI_ARGUMENTS_INVALID', 'Duplicate --execute flag.');
      execute = true;
      continue;
    }
    if (!valueFlags.has(flag)) {
      throw new MaintenanceWorkerError('CLI_ARGUMENTS_INVALID', `Unsupported maintenance flag: ${flag}`);
    }
    const value = args[index + 1];
    if (values.has(flag) || !value?.trim() || value.startsWith('--')) {
      throw new MaintenanceWorkerError('CLI_ARGUMENTS_INVALID', `Missing or duplicate value for ${flag}.`);
    }
    values.set(flag, value.trim());
    index += 1;
  }

  const manifest = values.get('--manifest');
  if (!manifest) {
    throw new MaintenanceWorkerError('CLI_ARGUMENTS_INVALID', 'Missing required --manifest path.');
  }

  const maxNativeBudget = values.get('--max-native') ?? '1';
  const maxTokenBudget = values.get('--max-token') ?? '10000000';
  try {
    if (parseAssetAmount(maxNativeBudget, 18) <= 0n || parseAssetAmount(maxTokenBudget, 8) <= 0n) {
      throw new Error('non-positive');
    }
  } catch {
    throw new MaintenanceWorkerError('CLI_ARGUMENTS_INVALID', 'Budgets must be positive decimals.');
  }

  const maxMarketsRaw = values.get('--max-markets') ?? '8';
  if (!/^\d+$/.test(maxMarketsRaw)) {
    throw new MaintenanceWorkerError('CLI_ARGUMENTS_INVALID', 'Invalid --max-markets value.');
  }
  const maxMarkets = Number(maxMarketsRaw);
  if (!Number.isInteger(maxMarkets) || maxMarkets < 1 || maxMarkets > MAX_MARKETS_CAP) {
    throw new MaintenanceWorkerError('CLI_ARGUMENTS_INVALID', `--max-markets must be between 1 and ${MAX_MARKETS_CAP}.`);
  }

  const marketRaw = values.get('--market');
  let market: Address | undefined;
  if (marketRaw !== undefined) {
    if (!ADDRESS_PATTERN.test(marketRaw) || marketRaw.toLowerCase() === zeroAddress) {
      throw new MaintenanceWorkerError('CLI_ARGUMENTS_INVALID', 'Invalid --market address.');
    }
    market = marketRaw.toLowerCase() as Address;
  }

  return {
    manifest,
    envFile: values.get('--env-file'),
    maxNativeBudget,
    maxTokenBudget,
    maxMarkets,
    market,
    execute,
  };
}

async function readContract<T>(
  rpc: MaintenanceRpc,
  blockHash: Hex,
  to: Address,
  abi: typeof TOKEN_MARKET_FACTORY_ABI | typeof TOKEN_MARKET_ABI,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  const data = encodeFunctionData({ abi: abi as Abi, functionName, args });
  const raw = await rpc.readRpc('eth_call', [{ to, data }, { blockHash, requireCanonical: true }]);
  if (typeof raw !== 'string' || !/^0x[\da-f]*$/i.test(raw)) {
    throw new MaintenanceWorkerError('RPC_RESPONSE_INVALID', `Invalid contract call response for ${functionName}.`);
  }
  return decodeFunctionResult({ abi: abi as Abi, functionName, data: raw as Hex }) as T;
}

async function defaultSubmitTransaction(input: {
  config: NetworkConfig;
  verification: RpcVerification;
  to: Address;
  data: Hex;
  privateKey: Hex;
}): Promise<Hex> {
  const rpcUrl = (input.config as { rpcUrl?: string }).rpcUrl;
  if (!rpcUrl) {
    throw new MaintenanceWorkerError('RPC_URL_MISSING', 'RPC URL is required to submit maintenance transactions.');
  }
  const account = privateKeyToAccount(input.privateKey);
  const client = createWalletClient({
    account,
    transport: http(rpcUrl),
  });
  return client.sendTransaction({
    account,
    chain: null,
    to: input.to,
    data: input.data,
    value: 0n,
  });
}

export async function runTokenMaintenance(
  options: MaintenanceWorkerOptions,
  env: Record<string, string | undefined> = process.env,
  deps: MaintenanceDependencies = {},
): Promise<MaintenanceWorkerResult> {
  if (options.envFile) {
    loadEnvFile(resolve(options.envFile));
  }

  let privateKey: Hex | undefined;
  if (options.execute) {
    const rawKey = env.ONESHOT_KEEPER_PRIVATE_KEY?.trim();
    if (!rawKey || !PRIVATE_KEY_PATTERN.test(rawKey) || /^0x0+$/.test(rawKey)) {
      throw new MaintenanceWorkerError(
        'KEEPER_KEY_REQUIRED',
        'Set ONESHOT_KEEPER_PRIVATE_KEY in the environment before running with --execute.',
      );
    }
    privateKey = rawKey as Hex;
  }

  const config = networkConfig(env);
  if (!config.rpcUrl || !config.configurationReady) {
    throw new MaintenanceWorkerError('NETWORK_NOT_CONFIGURED', 'Configured network profile and RPC URL are required.');
  }

  const loadManifest = deps.loadManifest ?? loadTokenManifestFile;
  const manifest = await loadManifest(options.manifest);
  if (manifest.mode !== config.mode || manifest.chainId !== config.chainId) {
    throw new MaintenanceWorkerError('MANIFEST_NETWORK_MISMATCH', 'Token manifest does not match active network.');
  }

  const rpc = await (deps.createRpc ?? createVerifiedRpc)(config);
  const source = new VerifiedTokenSource(rpc);
  const verified = await source.verify(manifest);

  let targetMarkets: Address[] = [];
  if (options.market) {
    const registered = await readContract<boolean>(
      rpc,
      verified.block.hash,
      manifest.factory.address,
      TOKEN_MARKET_FACTORY_ABI,
      'isMarket',
      [options.market],
    );
    if (!registered) {
      throw new MaintenanceWorkerError('MARKET_NOT_FOUND', `Market ${options.market} is not registered in factory.`);
    }
    targetMarkets = [options.market];
  } else {
    const count = await readContract<bigint>(
      rpc,
      verified.block.hash,
      manifest.factory.address,
      TOKEN_MARKET_FACTORY_ABI,
      'marketCount',
    );
    const boundedCount = Number(count < BigInt(options.maxMarkets) ? count : BigInt(options.maxMarkets));
    for (let index = 0; index < boundedCount; index += 1) {
      const address = await readContract<Address>(
        rpc,
        verified.block.hash,
        manifest.factory.address,
        TOKEN_MARKET_FACTORY_ABI,
        'markets',
        [BigInt(index)],
      );
      targetMarkets.push(address.toLowerCase() as Address);
    }
  }

  const nativeDecimals = 'nativeDecimals' in rpc.verification ? 18 : 18;
  const maxNativeRaw = parseAssetAmount(options.maxNativeBudget, nativeDecimals);
  const maxTokenRaw = parseAssetAmount(options.maxTokenBudget, 8);
  const deadline = verified.block.timestamp + TOKEN_MAINTENANCE_LIFETIME_SECONDS;
  const submitTransaction = deps.submitTransaction ?? defaultSubmitTransaction;

  const results: MaintenanceMarketCandidate[] = [];
  let readyCount = 0;
  let executedCount = 0;

  for (const market of targetMarkets) {
    const [pendingLpNative, pendingLpToken, pendingLiquidityNative, pendingLiquidityToken, pendingBurnNative] =
      await Promise.all([
        readContract<bigint>(rpc, verified.block.hash, market, TOKEN_MARKET_ABI, 'pendingLpNative'),
        readContract<bigint>(rpc, verified.block.hash, market, TOKEN_MARKET_ABI, 'pendingLpToken'),
        readContract<bigint>(rpc, verified.block.hash, market, TOKEN_MARKET_ABI, 'pendingLiquidityNative'),
        readContract<bigint>(rpc, verified.block.hash, market, TOKEN_MARKET_ABI, 'pendingLiquidityToken'),
        readContract<bigint>(rpc, verified.block.hash, market, TOKEN_MARKET_ABI, 'pendingBurnNative'),
      ]);

    const totalPendingUnits =
      pendingLpNative + pendingLpToken + pendingLiquidityNative + pendingLiquidityToken + pendingBurnNative;

    let ready = false;
    let reason: string | undefined;
    let callData: Hex | undefined;

    if (totalPendingUnits === 0n) {
      reason = 'No pending fees or maintenance balances.';
    } else {
      callData = encodeFunctionData({
        abi: TOKEN_MARKET_ABI,
        functionName: 'process',
        args: [maxNativeRaw, maxTokenRaw, deadline],
      });
      try {
        const simulation = await rpc.readRpc('eth_call', [
          { to: market, data: callData },
          { blockHash: verified.block.hash, requireCanonical: true },
        ]);
        if (simulation === '0x') {
          ready = true;
        } else {
          reason = 'Maintenance simulation did not confirm readiness.';
        }
      } catch {
        reason = 'Below processing threshold or cooldown active.';
      }
    }

    if (ready) readyCount += 1;

    let txHash: Hex | undefined;
    if (ready && options.execute && privateKey && callData) {
      txHash = await submitTransaction({
        config,
        verification: rpc.verification,
        to: market,
        data: callData,
        privateKey,
      });
      executedCount += 1;
    }

    results.push({
      market,
      pendingLpNativeRaw: pendingLpNative.toString(),
      pendingLpTokenRaw: pendingLpToken.toString(),
      pendingLiquidityNativeRaw: pendingLiquidityNative.toString(),
      pendingLiquidityTokenRaw: pendingLiquidityToken.toString(),
      pendingBurnNativeRaw: pendingBurnNative.toString(),
      totalPendingUnits: totalPendingUnits.toString(),
      ready,
      ...(reason ? { reason } : {}),
      ...(txHash ? { txHash } : {}),
    });
  }

  return {
    status: 'completed',
    dryRun: !options.execute,
    network: config.mode,
    chainId: config.chainId,
    blockNumber: verified.block.number.toString(),
    blockHash: verified.block.hash,
    checked: results.length,
    ready: readyCount,
    executed: executedCount,
    markets: results,
  };
}
