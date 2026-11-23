import { concatHex, encodeDeployData, encodeFunctionData, getAddress, getContractAddress, isAddress, keccak256, toHex, zeroAddress, zeroHash, type Abi, type Address, type Hex } from 'viem';

export const BASE_PLAN_CHAIN_ID = 84532;
export const BASE_PLAN_POOL_MANAGER = '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408' as Address;
export const BASE_PLAN_GENESIS = '0x0dcc9e089e30b90ddfc55be9a37dd15bc551aeee999d2e2b51414c54eaf934e4' as Hex;
export type PlanContract = 'OneshotNFTFactory' | 'OneshotGuardedMarketplaceV3' | 'OneshotV4OracleDeployer' | 'OneshotV4Oracle' | 'OneshotV4MarketFactory' | 'OneshotV4Market' | 'OneshotV4Quoter';
export type DeploymentArtifact = { abi: Abi; bytecode: { object: Hex }; deployedBytecode: { object: Hex }; metadata: { compiler: { version: string }; settings: { evmVersion: string } } };
export type BasePlanInputs = { deployer: Address; nonce: bigint; platform: Address; listingAuthority: Address; deploymentSalt: Hex };

export function mineObservationHook(deployer: Address, initializationHash: Hex) {
  for (let candidate = 0n; candidate < 1_000_000n; candidate++) {
    const salt = toHex(candidate, { size: 32 });
    const hash = keccak256(concatHex(['0xff', deployer, salt, initializationHash]));
    const next = getAddress(`0x${hash.slice(-40)}`);
    if ((BigInt(next) & 0x3fffn) === 0x1040n) return { salt, address: next };
  }
  throw new Error('HOOK_SALT_SEARCH_EXHAUSTED');
}

function address(value: Address): Address {
  if (!isAddress(value, { strict: false }) || value.toLowerCase() === zeroAddress) throw new Error('NONZERO_ADDRESS_REQUIRED');
  return getAddress(value);
}

export function buildBaseSepoliaPlan(artifacts: Record<PlanContract, DeploymentArtifact>, inputs: BasePlanInputs) {
  const deployer = address(inputs.deployer), platform = address(inputs.platform), listingAuthority = address(inputs.listingAuthority);
  if (inputs.nonce < 0n || inputs.nonce > (1n << 64n) - 7n) throw new Error('INVALID_DEPLOYER_NONCE');
  if (!/^0x[\da-fA-F]{64}$/.test(inputs.deploymentSalt) || inputs.deploymentSalt.toLowerCase() === zeroHash) throw new Error('NONZERO_DEPLOYMENT_SALT_REQUIRED');
  const artifactEvidence = Object.fromEntries(Object.entries(artifacts).map(([name, artifact]) => {
    if (!artifact.metadata.compiler.version.startsWith('0.8.30+') || artifact.metadata.settings.evmVersion !== 'cancun') throw new Error('UNEXPECTED_CONTRACT_COMPILER');
    if (!/^0x(?:[\da-fA-F]{2})+$/.test(artifact.bytecode.object) || !/^0x(?:[\da-fA-F]{2})+$/.test(artifact.deployedBytecode.object)) throw new Error('INVALID_ARTIFACT_BYTECODE');
    const runtimeBytes = (artifact.deployedBytecode.object.length - 2) / 2, creationBytes = (artifact.bytecode.object.length - 2) / 2;
    if (runtimeBytes > 24_576 || creationBytes >= 49_152) throw new Error('CONTRACT_SIZE_LIMIT');
    return [name, { compiler: artifact.metadata.compiler.version, evmVersion: 'cancun', creationBytes, runtimeBytes, creationCodeHash: keccak256(artifact.bytecode.object) }];
  }));
  const predicted = (offset: bigint) => getContractAddress({ from: deployer, nonce: inputs.nonce + offset });
  const nftFactory = predicted(0n), nftMarketplace = predicted(1n), oracleDeployer = predicted(2n), tokenFactory = predicted(4n), quoter = predicted(5n);
  const marketCode = artifacts.OneshotV4Market.bytecode.object;
  const firstBytes = Math.floor((marketCode.length - 2) / 4);
  const expectedCreationCode = {
    length: (marketCode.length - 2) / 2,
    first: { address: getContractAddress({ from: tokenFactory, nonce: 1n }), codeHash: keccak256(`0x00${marketCode.slice(2, 2 + firstBytes * 2)}`) },
    second: { address: getContractAddress({ from: tokenFactory, nonce: 2n }), codeHash: keccak256(`0x00${marketCode.slice(2 + firstBytes * 2)}`) },
  };
  const oracleInit = encodeDeployData({ abi: artifacts.OneshotV4Oracle.abi, bytecode: artifacts.OneshotV4Oracle.bytecode.object, args: [BASE_PLAN_POOL_MANAGER] });
  const oracleInitHash = keccak256(oracleInit);
  const { salt: oracleSalt, address: oracle } = mineObservationHook(oracleDeployer, oracleInitHash);
  const transactions: { action: string; nonce: string; from: Address; chainId: number; to: Address | null; value: '0x0'; data: Hex; expectedContract: Address; initCodeHash?: Hex }[] = [];
  function deploy(action: string, offset: bigint, name: PlanContract, args: readonly unknown[], expectedContract: Address) {
    const data = encodeDeployData({ abi: artifacts[name].abi, bytecode: artifacts[name].bytecode.object, args });
    if ((data.length - 2) / 2 > 49_152) throw new Error('INITIALIZATION_SIZE_LIMIT');
    transactions.push({ action, nonce: (inputs.nonce + offset).toString(), from: deployer, chainId: BASE_PLAN_CHAIN_ID, to: null, value: '0x0', data, expectedContract, initCodeHash: keccak256(data) });
  }
  deploy('Deploy NFT factory', 0n, 'OneshotNFTFactory', [platform], nftFactory);
  deploy('Deploy guarded NFT marketplace v3 with funded offers and batch purchases', 1n, 'OneshotGuardedMarketplaceV3', [nftFactory, listingAuthority, inputs.deploymentSalt], nftMarketplace);
  deploy('Deploy immutable oracle deployer', 2n, 'OneshotV4OracleDeployer', [], oracleDeployer);
  transactions.push({ action: 'Deploy observation hook with mined CREATE2 salt', nonce: (inputs.nonce + 3n).toString(), from: deployer, chainId: BASE_PLAN_CHAIN_ID, to: oracleDeployer, value: '0x0', data: encodeFunctionData({ abi: artifacts.OneshotV4OracleDeployer.abi, functionName: 'deploy', args: [BASE_PLAN_POOL_MANAGER, oracleSalt] }), expectedContract: oracle, initCodeHash: oracleInitHash });
  deploy('Deploy token market factory', 4n, 'OneshotV4MarketFactory', [BASE_PLAN_POOL_MANAGER, oracle, platform, 10_000_000_000_000_000n], tokenFactory);
  deploy('Deploy exact-input token quoter', 5n, 'OneshotV4Quoter', [tokenFactory], quoter);
  return {
    schemaVersion: 1, kind: 'oneshot-base-sepolia-unsigned-plan', verifiedDeployment: false, network: { mode: 'base-sepolia', chainId: BASE_PLAN_CHAIN_ID, expectedGenesisHash: BASE_PLAN_GENESIS, rpcIdentityVerified: false, poolManager: BASE_PLAN_POOL_MANAGER, poolManagerCodeHash: null },
    inputs: { deployer, firstNonce: inputs.nonce.toString(), platform, listingAuthority, deploymentSalt: inputs.deploymentSalt },
    predicted: { nftFactory, nftMarketplace, oracleDeployer, oracle, tokenFactory, quoter }, expectedCreationCode, hook: { flags: '0x1040', salt: oracleSalt, initCodeHash: oracleInitHash }, artifacts: artifactEvidence, transactions,
    manifestPreparation: {
      nft: { schemaVersion: 1, deploymentVersion: 'oneshot-nft-v3', mode: 'base-sepolia', chainId: BASE_PLAN_CHAIN_ID, genesisHash: BASE_PLAN_GENESIS, startBlock: null, anchorHash: null, factory: { address: nftFactory, codeHash: null }, marketplace: { address: nftMarketplace, codeHash: null }, listingAuthorization: { authority: listingAuthority, salt: inputs.deploymentSalt } },
      token: { schemaVersion: 1, deploymentVersion: 'oneshot-v4-market-v1', mode: 'base-sepolia', chainId: BASE_PLAN_CHAIN_ID, genesisHash: BASE_PLAN_GENESIS, startBlock: null, anchorHash: null, factory: { address: tokenFactory, codeHash: null }, poolManager: { address: BASE_PLAN_POOL_MANAGER, codeHash: null }, oracle: { address: oracle, codeHash: null }, quoter: { address: quoter, codeHash: null } },
    },
    requiredPostDeploymentEvidence: ['Verify chain 84532 and pinned genesis using the intended RPC.', 'Confirm each successful canonical receipt and its exact contract address, deployment block and block hash.', 'Read actual deployed runtime code after immutable constructor substitution; hash that code for each manifest entry.', 'Verify NFT marketplace MARKETPLACE_VERSION() is 3, and read the actual offer/batch limits before exposing those capabilities.', 'Verify token factory creationCodeFirst/Second addresses, length and each STOP-prefixed runtime hash against expectedCreationCode.', 'Set startBlock to the first applicable successful deployment block and anchorHash to its canonical parent block hash.', 'Verify immutable factory, oracle, quoter, authority, salt, platform and canonical PoolManager getters before enabling transactions.'],
    limitations: ['Unsigned preparation only. No RPC requests, wallet calls, signing, broadcasting or deployment are performed.', 'Predictions require the supplied deployer nonce and this exact transaction order. No unrelated transaction may consume one of these nonces.', 'Manifest preparations contain null anchors and runtime hashes and cannot enable the product.', 'Local 31337 rehearsal runtime hashes do not prove Base 84532 code identity.', 'Existing permanently locked local foundation allocations are excluded and cannot be migrated or rescued.'],
  };
}
