import { describe, expect, it } from 'vitest';
import { decodeDeployData, getContractAddress, parseAbi, toHex, zeroHash, type Address, type Hex } from 'viem';
import type { DeploymentArtifact } from './lib/base-sepolia-plan';
import { buildZeroPlan, DEFAULT_ZERO_MIN_PROCESSING_NATIVE, type ZeroPlanArtifacts } from './lib/zero-plan';

function makeArtifact(lines: string[], evmVersion: 'cancun' = 'cancun'): DeploymentArtifact {
  return {
    abi: parseAbi(lines),
    bytecode: { object: '0x60016000' },
    deployedBytecode: { object: '0x00' },
    metadata: { compiler: { version: '0.8.30+commit.73712a01' }, settings: { evmVersion } },
  };
}

function makeArtifacts(includeV4 = false): ZeroPlanArtifacts {
  const nft: ZeroPlanArtifacts = {
    OneshotNFTFactory: makeArtifact(['constructor(address platform)'], 'cancun'),
    OneshotGuardedMarketplaceV3: makeArtifact(['constructor(address factory,address authority,bytes32 salt)'], 'cancun'),
    OneshotReviewedCollectionRegistry: makeArtifact(['constructor(address factory,address authority,bytes32 salt)'], 'cancun'),
    OneshotReviewedMarketplace: makeArtifact(['constructor(address registry,bytes32 salt)'], 'cancun'),
  };
  if (!includeV4) return nft;
  return {
    ...nft,
    OneshotV4OracleDeployer: makeArtifact(['function deploy(address manager,bytes32 salt) returns (address)'], 'cancun'),
    OneshotV4Oracle: makeArtifact(['constructor(address manager)'], 'cancun'),
    OneshotV4MarketFactory: makeArtifact(['constructor(address manager,address oracle,address platform,uint256 minProcessingNative)'], 'cancun'),
    OneshotV4Market: makeArtifact([], 'cancun'),
    OneshotV4Quoter: makeArtifact(['constructor(address factory)'], 'cancun'),
  };
}

const BASE_INPUTS = {
  mode: 'zero-testnet' as const,
  chainId: 33001,
  genesisHash: `0x${'ab'.repeat(32)}` as Hex,
  deployer: '0x1111111111111111111111111111111111111111' as Address,
  platform: '0x2222222222222222222222222222222222222222' as Address,
  listingAuthority: '0x3333333333333333333333333333333333333333' as Address,
  nonce: 5n,
  deploymentSalt: toHex(1, { size: 32 }),
};

describe('offline unsigned Zero contract preparation', () => {
  it('prepares NFT-only Zero Testnet transactions when poolManager is omitted', () => {
    const plan = buildZeroPlan(makeArtifacts(false), BASE_INPUTS);
    expect(plan.verifiedDeployment).toBe(false);
    expect(plan.network).toMatchObject({ mode: 'zero-testnet', isTestnet: true, chainId: 33001, nativeSymbol: 'ZRO', poolManager: null });
    expect(plan.tokenV4Included).toBe(false);
    expect(plan.tokenV4SkippedReason).toContain('PoolManager');
    expect(plan.transactions).toHaveLength(4);
    expect(plan.transactions.map(tx => tx.nonce)).toEqual(['5', '6', '7', '8']);
    expect(plan.predicted.reviewedMarketplace).toBe(getContractAddress({ from: BASE_INPUTS.deployer, nonce: 8n }));
    expect(plan.manifestPreparation.token).toBeNull();
  });

  it('includes Token V4 deployment with custom PoolManager and ZRO minProcessingNative threshold', () => {
    const poolManager = '0x4444444444444444444444444444444444444444' as Address;
    const minProcessingNative = 2_500_000_000_000_000_000n;
    const artifacts = makeArtifacts(true);
    const plan = buildZeroPlan(artifacts, { ...BASE_INPUTS, poolManager, minProcessingNative });

    expect(plan.tokenV4Included).toBe(true);
    expect(plan.transactions).toHaveLength(8);
    expect(plan.transactions.map(tx => tx.nonce)).toEqual(['5', '6', '7', '8', '9', '10', '11', '12']);
    expect(BigInt(plan.predicted.oracle!) & 0x3fffn).toBe(0x1040n);
    expect(plan.network.minProcessingNativeRaw).toBe(minProcessingNative.toString());

    const factoryDeploy = plan.transactions[6]!;
    const decoded = decodeDeployData({ abi: artifacts.OneshotV4MarketFactory!.abi, bytecode: artifacts.OneshotV4MarketFactory!.bytecode.object, data: factoryDeploy.data });
    expect(decoded.args).toEqual([poolManager, plan.predicted.oracle, BASE_INPUTS.platform, minProcessingNative]);

    const defaultPlan = buildZeroPlan(artifacts, { ...BASE_INPUTS, poolManager });
    expect(defaultPlan.network.minProcessingNativeRaw).toBe(DEFAULT_ZERO_MIN_PROCESSING_NATIVE.toString());
  });

  it('rejects Zerion 543210, Base/Ethereum reserved chains, zero genesis, and unconfirmed mainnet', () => {
    const artifacts = makeArtifacts(false);
    expect(() => buildZeroPlan(artifacts, { ...BASE_INPUTS, chainId: 543210 })).toThrow('ZERION_CHAIN_ID_REJECTED');
    for (const chainId of [0, 1, 31337, 8453, 84532]) {
      expect(() => buildZeroPlan(artifacts, { ...BASE_INPUTS, chainId })).toThrow('RESERVED_NON_ZERO_CHAIN_ID');
    }
    expect(() => buildZeroPlan(artifacts, { ...BASE_INPUTS, genesisHash: zeroHash })).toThrow('NONZERO_GENESIS_HASH_REQUIRED');
    expect(() => buildZeroPlan(artifacts, { ...BASE_INPUTS, mode: 'zero-mainnet', mainnetConfirmed: false })).toThrow('MAINNET_CONFIRMATION_REQUIRED');
    expect(() => buildZeroPlan(artifacts, { ...BASE_INPUTS, mode: 'zero-mainnet', mainnetConfirmed: true })).not.toThrow();
  });
});
