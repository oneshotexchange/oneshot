import { describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import {
  BASE_SEPOLIA_GENESIS_HASH,
  BASE_SEPOLIA_POOL_MANAGER,
  TOKEN_MAINTENANCE_LIFETIME_SECONDS,
  TOKEN_MARKET_ABI,
  TOKEN_MARKET_FACTORY_ABI,
  type NetworkConfig,
} from '@oneshot/evm';
import { tokenManifestJson, parseTokenManifest } from '../apps/indexer/src/token-manifest';
import {
  MaintenanceWorkerError,
  parseMaintenanceArgs,
  runTokenMaintenance,
  type MaintenanceRpc,
} from './lib/token-maintenance';

const FACTORY = '0x1111111111111111111111111111111111111111' as Address;
const ORACLE = '0x2222222222222222222222222222222222221040' as Address; // (1<<12)|(1<<6) = 0x1040 flags
const QUOTER = '0x3333333333333333333333333333333333333333' as Address;
const PLATFORM = '0x4444444444444444444444444444444444444444' as Address;
const MARKET_ONE = '0x5555555555555555555555555555555555555555' as Address;
const MARKET_TWO = '0x6666666666666666666666666666666666666666' as Address;
const CODE = '0x6080604052' as Hex;
const CODE_HASH = keccak256(CODE);
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as Hex;
const ANCHOR_HASH = `0x${'cd'.repeat(32)}` as Hex;

function sampleManifest() {
  return parseTokenManifest(
    tokenManifestJson({
      schemaVersion: 1,
      deploymentVersion: 'oneshot-v4-market-v1',
      mode: 'base-sepolia',
      chainId: 84532,
      genesisHash: BASE_SEPOLIA_GENESIS_HASH,
      startBlock: 100n,
      anchorHash: ANCHOR_HASH,
      factory: { address: FACTORY, codeHash: CODE_HASH },
      poolManager: { address: BASE_SEPOLIA_POOL_MANAGER.toLowerCase() as Address, codeHash: CODE_HASH },
      oracle: { address: ORACLE, codeHash: CODE_HASH },
      quoter: { address: QUOTER, codeHash: CODE_HASH },
    }),
  );
}

function fakeRpc(options: { marketReady?: Record<string, boolean> } = {}): MaintenanceRpc {
  const blockTimestamp = 1700000100n;
  const blockNumber = 120n;
  const marketReady = options.marketReady ?? { [MARKET_ONE]: true, [MARKET_TWO]: false };
  const markets = [MARKET_ONE, MARKET_TWO];

  return {
    verification: {
      mode: 'base-sepolia',
      chainId: 84532,
      genesisHash: BASE_SEPOLIA_GENESIS_HASH,
      latestBlock: blockNumber,
      checkedAt: '2026-11-22T00:00:00.000Z',
      provider: { label: 'custom', verifiedSupport: false },
      genesisMatched: true,
    },
    readRpc: async (method, params = []) => {
      if (method === 'eth_blockNumber') return `0x${blockNumber.toString(16)}`;
      if (method === 'eth_getBlockByNumber') {
        const tag = String(params[0]).toLowerCase();
        if (tag === '0x0') {
          return {
            number: '0x0',
            hash: BASE_SEPOLIA_GENESIS_HASH,
            parentHash: `0x${'00'.repeat(32)}`,
            timestamp: '0x65000000',
          };
        }
        if (tag === '0x63') {
          return {
            number: '0x63',
            hash: ANCHOR_HASH,
            parentHash: `0x${'ee'.repeat(32)}`,
            timestamp: '0x65000010',
          };
        }
        return {
          number: `0x${blockNumber.toString(16)}`,
          hash: BLOCK_HASH,
          parentHash: `0x${'ff'.repeat(32)}`,
          timestamp: `0x${blockTimestamp.toString(16)}`,
        };
      }
      if (method === 'eth_getCode') return CODE;
      if (method === 'eth_call') {
        const call = params[0] as { to: Address; data: Hex };
        const to = call.to.toLowerCase() as Address;
        if (to === FACTORY) {
          const decoded = decodeFunctionData({ abi: TOKEN_MARKET_FACTORY_ABI, data: call.data });
          if (decoded.functionName === 'poolManager') {
            return encodeFunctionResult({
              abi: TOKEN_MARKET_FACTORY_ABI,
              functionName: 'poolManager',
              result: BASE_SEPOLIA_POOL_MANAGER,
            });
          }
          if (decoded.functionName === 'oracle') {
            return encodeFunctionResult({ abi: TOKEN_MARKET_FACTORY_ABI, functionName: 'oracle', result: ORACLE });
          }
          if (decoded.functionName === 'platformRecipient') {
            return encodeFunctionResult({
              abi: TOKEN_MARKET_FACTORY_ABI,
              functionName: 'platformRecipient',
              result: PLATFORM,
            });
          }
          if (decoded.functionName === 'marketCount') {
            return encodeFunctionResult({
              abi: TOKEN_MARKET_FACTORY_ABI,
              functionName: 'marketCount',
              result: BigInt(markets.length),
            });
          }
          if (decoded.functionName === 'markets') {
            const index = Number(decoded.args[0]);
            return encodeFunctionResult({
              abi: TOKEN_MARKET_FACTORY_ABI,
              functionName: 'markets',
              result: markets[index] ?? zeroAddress,
            });
          }
          if (decoded.functionName === 'isMarket') {
            return encodeFunctionResult({
              abi: TOKEN_MARKET_FACTORY_ABI,
              functionName: 'isMarket',
              result: markets.includes((decoded.args[0] as Address).toLowerCase() as Address),
            });
          }
        }
        if (to === ORACLE) {
          return encodeAbiParameters([{ type: 'address' }], [BASE_SEPOLIA_POOL_MANAGER]);
        }
        if (to === QUOTER) {
          const selector = call.data.slice(0, 10);
          // factory() = 0xc45a0155, poolManager() = 0xdc4c90d3
          if (selector === '0xc45a0155') return encodeAbiParameters([{ type: 'address' }], [FACTORY]);
          return encodeAbiParameters([{ type: 'address' }], [BASE_SEPOLIA_POOL_MANAGER]);
        }
        if (markets.includes(to)) {
          const decoded = decodeFunctionData({ abi: TOKEN_MARKET_ABI, data: call.data });
          if (decoded.functionName === 'pendingLpNative') {
            return encodeFunctionResult({
              abi: TOKEN_MARKET_ABI,
              functionName: 'pendingLpNative',
              result: to === MARKET_ONE ? 20_000_000_000_000_000n : 1_000_000n,
            });
          }
          if (
            decoded.functionName === 'pendingLpToken' ||
            decoded.functionName === 'pendingLiquidityNative' ||
            decoded.functionName === 'pendingLiquidityToken' ||
            decoded.functionName === 'pendingBurnNative'
          ) {
            return encodeFunctionResult({ abi: TOKEN_MARKET_ABI, functionName: decoded.functionName, result: 0n });
          }
          if (decoded.functionName === 'process') {
            if (!marketReady[to]) throw new Error('execution reverted');
            return '0x';
          }
        }
      }
      throw new Error(`Unexpected RPC call: ${method}`);
    },
  };
}

describe('token maintenance keeper arguments and execution', () => {
  it('parses bounded dry-run arguments and rejects invalid flags or secrets in CLI args', () => {
    const parsed = parseMaintenanceArgs(['--manifest', '.local/qa/token-manifest.json']);
    expect(parsed.execute).toBe(false);
    expect(parsed.maxNativeBudget).toBe('1');
    expect(parsed.maxTokenBudget).toBe('10000000');
    expect(parsed.maxMarkets).toBe(8);

    expect(() => parseMaintenanceArgs([])).toThrow(MaintenanceWorkerError);
    expect(() => parseMaintenanceArgs(['--manifest', 'm.json', '--private-key', '0x12'])).toThrow(
      MaintenanceWorkerError,
    );
    expect(() => parseMaintenanceArgs(['--manifest', 'm.json', '--max-markets', '99'])).toThrow(
      MaintenanceWorkerError,
    );
    expect(() => parseMaintenanceArgs(['--manifest', 'm.json', '--max-native', '0'])).toThrow(
      MaintenanceWorkerError,
    );
  });

  it('runs in dry-run mode without requiring a key and simulates readiness on verified markets', async () => {
    const submitTransaction = vi.fn();
    const env = {
      ONESHOT_NETWORK: 'base-sepolia',
      ONESHOT_RPC_URL: 'https://sepolia.base.org',
    };
    const result = await runTokenMaintenance(
      parseMaintenanceArgs(['--manifest', 'manifest.json', '--max-markets', '4']),
      env,
      {
        loadManifest: async () => sampleManifest(),
        createRpc: async (_config: NetworkConfig) => fakeRpc(),
        submitTransaction,
      },
    );

    expect(result.dryRun).toBe(true);
    expect(result.checked).toBe(2);
    expect(result.ready).toBe(1);
    expect(result.executed).toBe(0);
    expect(result.markets[0]).toMatchObject({ market: MARKET_ONE, ready: true });
    expect(result.markets[1]).toMatchObject({ market: MARKET_TWO, ready: false });
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('requires ONESHOT_KEEPER_PRIVATE_KEY from env in --execute mode and submits only ready markets', async () => {
    await expect(
      runTokenMaintenance(
        parseMaintenanceArgs(['--manifest', 'manifest.json', '--execute']),
        { ONESHOT_NETWORK: 'base-sepolia', ONESHOT_RPC_URL: 'https://sepolia.base.org' },
        {
          loadManifest: async () => sampleManifest(),
          createRpc: async () => fakeRpc(),
        },
      ),
    ).rejects.toThrow(/ONESHOT_KEEPER_PRIVATE_KEY/);

    const submitted: { to: Address; data: Hex }[] = [];
    const secretKey = `0x${'11'.repeat(32)}`;
    const result = await runTokenMaintenance(
      parseMaintenanceArgs(['--manifest', 'manifest.json', '--execute', '--max-markets', '1']),
      {
        ONESHOT_NETWORK: 'base-sepolia',
        ONESHOT_RPC_URL: 'https://sepolia.base.org',
        ONESHOT_KEEPER_PRIVATE_KEY: secretKey,
      },
      {
        loadManifest: async () => sampleManifest(),
        createRpc: async () => fakeRpc(),
        submitTransaction: async (tx) => {
          submitted.push({ to: tx.to, data: tx.data });
          return `0x${'99'.repeat(32)}` as Hex;
        },
      },
    );

    expect(result.dryRun).toBe(false);
    expect(result.checked).toBe(1);
    expect(result.ready).toBe(1);
    expect(result.executed).toBe(1);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.to).toBe(MARKET_ONE);
    const decoded = decodeFunctionData({ abi: TOKEN_MARKET_ABI, data: submitted[0]!.data });
    expect(decoded.functionName).toBe('process');
    expect(decoded.args[2]).toBe(1700000100n + TOKEN_MAINTENANCE_LIFETIME_SECONDS);
    expect(JSON.stringify(result)).not.toContain(secretKey);
  });
});
