import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getContractAddress, parseAbi, toHex, zeroAddress, zeroHash, type Address } from 'viem';
import { parseManifest } from '../apps/indexer/src/manifest';
import { parseTokenManifest } from '../apps/indexer/src/token-manifest';
import { BASE_PLAN_GENESIS, BASE_PLAN_POOL_MANAGER, buildBaseSepoliaPlan, type BasePlanInputs, type DeploymentArtifact, type PlanContract } from './lib/base-sepolia-plan';

function artifact(lines: string[]): DeploymentArtifact {
  return { abi: parseAbi(lines), bytecode: { object: '0x60016000' }, deployedBytecode: { object: '0x00' }, metadata: { compiler: { version: '0.8.30+commit.73712a01' }, settings: { evmVersion: 'cancun' } } };
}
function artifacts(): Record<PlanContract, DeploymentArtifact> {
  return {
    OneshotNFTFactory: artifact(['constructor(address platform)']),
    OneshotGuardedMarketplaceV3: artifact(['constructor(address factory,address authority,bytes32 salt)']),
    OneshotV4OracleDeployer: artifact(['function deploy(address manager,bytes32 salt) returns (address)']),
    OneshotV4Oracle: artifact(['constructor(address manager)']),
    OneshotV4MarketFactory: artifact(['constructor(address manager,address oracle,address platform,uint256 minProcessingNative)']),
    OneshotV4Market: artifact([]), OneshotV4Quoter: artifact(['constructor(address factory)']),
  };
}
const inputs: BasePlanInputs = { deployer: '0x1111111111111111111111111111111111111111', platform: '0x2222222222222222222222222222222222222222', listingAuthority: '0x3333333333333333333333333333333333333333', nonce: 10n, deploymentSalt: toHex(1, { size: 32 }) };

describe('unsigned Base Sepolia contract preparation', () => {
  it('mines the required hook flags, preserves EOA nonces, and cannot be accepted as deployed manifests', () => {
    const values = artifacts(); const plan = buildBaseSepoliaPlan(values, inputs);
    expect(plan.verifiedDeployment).toBe(false);
    expect(plan.network).toMatchObject({ chainId: 84532, expectedGenesisHash: BASE_PLAN_GENESIS, poolManager: BASE_PLAN_POOL_MANAGER, rpcIdentityVerified: false, poolManagerCodeHash: null });
    expect(plan.transactions.map(value => value.nonce)).toEqual(['10', '11', '12', '13', '14', '15']);
    expect(plan.transactions.every(value => value.chainId === 84532 && value.from === inputs.deployer && value.value === '0x0')).toBe(true);
    expect(plan.transactions.filter(value => value.to !== null)).toHaveLength(1);
    expect(plan.predicted.oracleDeployer).toBe(getContractAddress({ from: inputs.deployer, nonce: 12n }));
    expect(plan.predicted.tokenFactory).toBe(getContractAddress({ from: inputs.deployer, nonce: 14n }));
    expect(plan.expectedCreationCode.first.address).toBe(getContractAddress({ from: plan.predicted.tokenFactory, nonce: 1n }));
    expect(plan.expectedCreationCode.second.address).toBe(getContractAddress({ from: plan.predicted.tokenFactory, nonce: 2n }));
    expect(BigInt(plan.predicted.oracle) & 0x3fffn).toBe(0x1040n);
    const hookCall = plan.transactions[3];
    expect(hookCall.to).toBe(plan.predicted.oracleDeployer);
    expect(decodeFunctionData({ abi: values.OneshotV4OracleDeployer.abi, data: hookCall.data }).args).toEqual([BASE_PLAN_POOL_MANAGER, plan.hook.salt]);
    expect(() => parseManifest(plan.manifestPreparation.nft)).toThrow();
    expect(() => parseTokenManifest(plan.manifestPreparation.token)).toThrow();
    expect(plan.manifestPreparation.nft.listingAuthorization.salt).toBe(inputs.deploymentSalt);
    expect(plan.manifestPreparation.nft.deploymentVersion).toBe('oneshot-nft-v3');
    expect(plan.transactions[1].action).toContain('marketplace v3');
    expect(plan.artifacts).toHaveProperty('OneshotGuardedMarketplaceV3');
    expect(plan.requiredPostDeploymentEvidence.some(value => value.includes('MARKETPLACE_VERSION() is 3'))).toBe(true);
    expect(plan.manifestPreparation.token.quoter).toEqual({ address: plan.predicted.quoter, codeHash: null });
  });

  it('rejects missing addresses, unsafe nonce bounds, and empty authorization salts', () => {
    for (const key of ['deployer', 'platform', 'listingAuthority'] as const) {
      expect(() => buildBaseSepoliaPlan(artifacts(), { ...inputs, [key]: zeroAddress })).toThrow('NONZERO_ADDRESS_REQUIRED');
      expect(() => buildBaseSepoliaPlan(artifacts(), { ...inputs, [key]: 'invalid' as Address })).toThrow('NONZERO_ADDRESS_REQUIRED');
    }
    for (const nonce of [-1n, (1n << 64n) - 6n]) expect(() => buildBaseSepoliaPlan(artifacts(), { ...inputs, nonce })).toThrow('INVALID_DEPLOYER_NONCE');
    expect(() => buildBaseSepoliaPlan(artifacts(), { ...inputs, deploymentSalt: zeroHash })).toThrow('NONZERO_DEPLOYMENT_SALT_REQUIRED');
  });

  it('rejects unexpected toolchain bytecode and protocol size violations', () => {
    const oldCompiler = artifacts(); oldCompiler.OneshotV4Oracle.metadata.compiler.version = '0.8.26';
    expect(() => buildBaseSepoliaPlan(oldCompiler, inputs)).toThrow('UNEXPECTED_CONTRACT_COMPILER');
    const oldEvm = artifacts(); oldEvm.OneshotV4Oracle.metadata.settings.evmVersion = 'paris';
    expect(() => buildBaseSepoliaPlan(oldEvm, inputs)).toThrow('UNEXPECTED_CONTRACT_COMPILER');
    const oversized = artifacts(); oversized.OneshotV4MarketFactory.deployedBytecode.object = `0x${'00'.repeat(24_577)}`;
    expect(() => buildBaseSepoliaPlan(oversized, inputs)).toThrow('CONTRACT_SIZE_LIMIT');
    const empty = artifacts(); empty.OneshotV4Oracle.bytecode.object = '0x';
    expect(() => buildBaseSepoliaPlan(empty, inputs)).toThrow('INVALID_ARTIFACT_BYTECODE');
  });
});
