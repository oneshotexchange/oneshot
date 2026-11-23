import { encodeDeployData, encodeFunctionData, getAddress, getContractAddress, isAddress, keccak256, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { isValidZeroChainId, ZERION_ZERO_CHAIN_ID } from '@oneshot/evm';
import { mineObservationHook, type DeploymentArtifact } from './base-sepolia-plan';

export const DEFAULT_ZERO_MIN_PROCESSING_NATIVE = 1_000_000_000_000_000_000n; // 1 ZRO

export type ZeroPlanNftContract =
  | 'OneshotNFTFactory'
  | 'OneshotGuardedMarketplaceV3'
  | 'OneshotReviewedCollectionRegistry'
  | 'OneshotReviewedMarketplace';

export type ZeroPlanV4Contract =
  | 'OneshotV4OracleDeployer'
  | 'OneshotV4Oracle'
  | 'OneshotV4MarketFactory'
  | 'OneshotV4Market'
  | 'OneshotV4Quoter';

export type ZeroPlanContract = ZeroPlanNftContract | ZeroPlanV4Contract;

export type ZeroPlanInputs = {
  mode: 'zero-testnet' | 'zero-mainnet';
  chainId: number;
  genesisHash: Hex;
  deployer: Address;
  nonce: bigint;
  platform: Address;
  listingAuthority: Address;
  deploymentSalt: Hex;
  poolManager?: Address;
  minProcessingNative?: bigint;
  mainnetConfirmed?: boolean;
};

export type ZeroPlanArtifacts = Record<ZeroPlanNftContract, DeploymentArtifact> & Partial<Record<ZeroPlanV4Contract, DeploymentArtifact>>;

function requireNonzeroAddress(value: Address): Address {
  if (!isAddress(value, { strict: false }) || value.toLowerCase() === zeroAddress) {
    throw new Error('NONZERO_ADDRESS_REQUIRED');
  }
  return getAddress(value);
}

function requireNonzeroHash(value: Hex, errorCode: string): Hex {
  if (!/^0x[\da-fA-F]{64}$/.test(value) || value.toLowerCase() === zeroHash) {
    throw new Error(errorCode);
  }
  return value.toLowerCase() as Hex;
}

const V4_CONTRACTS = new Set<string>([
  'OneshotV4OracleDeployer',
  'OneshotV4Oracle',
  'OneshotV4MarketFactory',
  'OneshotV4Market',
  'OneshotV4Quoter',
]);

export function buildZeroPlan(artifacts: ZeroPlanArtifacts, inputs: ZeroPlanInputs) {
  if (inputs.mode !== 'zero-testnet' && inputs.mode !== 'zero-mainnet') {
    throw new Error('INVALID_ZERO_MODE');
  }
  if (inputs.mode === 'zero-mainnet' && inputs.mainnetConfirmed !== true) {
    throw new Error('MAINNET_CONFIRMATION_REQUIRED');
  }
  if (!isValidZeroChainId(inputs.chainId)) {
    throw new Error(inputs.chainId === ZERION_ZERO_CHAIN_ID ? 'ZERION_CHAIN_ID_REJECTED' : 'RESERVED_NON_ZERO_CHAIN_ID');
  }

  const genesisHash = requireNonzeroHash(inputs.genesisHash, 'NONZERO_GENESIS_HASH_REQUIRED');
  const deploymentSalt = requireNonzeroHash(inputs.deploymentSalt, 'NONZERO_DEPLOYMENT_SALT_REQUIRED');
  const deployer = requireNonzeroAddress(inputs.deployer);
  const platform = requireNonzeroAddress(inputs.platform);
  const listingAuthority = requireNonzeroAddress(inputs.listingAuthority);
  const poolManager = inputs.poolManager !== undefined ? requireNonzeroAddress(inputs.poolManager) : null;

  if (inputs.nonce < 0n || inputs.nonce > (1n << 64n) - 10n) {
    throw new Error('INVALID_DEPLOYER_NONCE');
  }
  const minProcessingNative = inputs.minProcessingNative ?? DEFAULT_ZERO_MIN_PROCESSING_NATIVE;
  if (minProcessingNative <= 0n || minProcessingNative > 1_000_000n * 10n ** 18n) {
    throw new Error('INVALID_MIN_PROCESSING_NATIVE');
  }

  const nftContracts: ZeroPlanNftContract[] = [
    'OneshotNFTFactory',
    'OneshotGuardedMarketplaceV3',
    'OneshotReviewedCollectionRegistry',
    'OneshotReviewedMarketplace',
  ];
  const v4Contracts: ZeroPlanV4Contract[] = [
    'OneshotV4OracleDeployer',
    'OneshotV4Oracle',
    'OneshotV4MarketFactory',
    'OneshotV4Market',
    'OneshotV4Quoter',
  ];
  for (const name of nftContracts) {
    if (!artifacts[name]) throw new Error(`MISSING_ARTIFACT_${name}`);
  }
  if (poolManager) {
    for (const name of v4Contracts) {
      if (!artifacts[name]) throw new Error(`MISSING_ARTIFACT_${name}`);
    }
  }

  const artifactEvidence: Record<string, { compiler: string; evmVersion: string; creationBytes: number; runtimeBytes: number; creationCodeHash: Hex }> = {};
  for (const [name, artifact] of Object.entries(artifacts)) {
    if (!artifact) continue;
    if (!artifact.metadata.compiler.version.startsWith('0.8.30+')) {
      throw new Error('UNEXPECTED_CONTRACT_COMPILER');
    }
    const evmVersion = artifact.metadata.settings.evmVersion;
    if (evmVersion !== 'cancun') {
      throw new Error(V4_CONTRACTS.has(name) ? 'UNEXPECTED_V4_EVM_VERSION' : 'UNEXPECTED_CONTRACT_COMPILER');
    }
    if (!/^0x(?:[\da-fA-F]{2})+$/.test(artifact.bytecode.object) || !/^0x(?:[\da-fA-F]{2})+$/.test(artifact.deployedBytecode.object)) {
      throw new Error('INVALID_ARTIFACT_BYTECODE');
    }
    const runtimeBytes = (artifact.deployedBytecode.object.length - 2) / 2;
    const creationBytes = (artifact.bytecode.object.length - 2) / 2;
    if (runtimeBytes > 24_576 || creationBytes >= 49_152) {
      throw new Error('CONTRACT_SIZE_LIMIT');
    }
    artifactEvidence[name] = {
      compiler: artifact.metadata.compiler.version,
      evmVersion,
      creationBytes,
      runtimeBytes,
      creationCodeHash: keccak256(artifact.bytecode.object),
    };
  }

  const predictedAddress = (offset: bigint) => getContractAddress({ from: deployer, nonce: inputs.nonce + offset });
  const nftFactory = predictedAddress(0n);
  const nftMarketplace = predictedAddress(1n);
  const reviewedRegistry = predictedAddress(2n);
  const reviewedMarketplace = predictedAddress(3n);

  const transactions: {
    action: string;
    nonce: string;
    from: Address;
    chainId: number;
    to: Address | null;
    value: '0x0';
    data: Hex;
    expectedContract: Address;
    initCodeHash: Hex;
  }[] = [];

  function addDeploy(action: string, offset: bigint, name: ZeroPlanContract, args: readonly unknown[], expectedContract: Address) {
    const artifact = artifacts[name]!;
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
    if ((data.length - 2) / 2 > 49_152) throw new Error('INITIALIZATION_SIZE_LIMIT');
    transactions.push({
      action,
      nonce: (inputs.nonce + offset).toString(),
      from: deployer,
      chainId: inputs.chainId,
      to: null,
      value: '0x0',
      data,
      expectedContract,
      initCodeHash: keccak256(data),
    });
  }

  addDeploy('Deploy NFT factory', 0n, 'OneshotNFTFactory', [platform], nftFactory);
  addDeploy(
    'Deploy guarded NFT marketplace v3 with funded offers and batch purchases',
    1n,
    'OneshotGuardedMarketplaceV3',
    [nftFactory, listingAuthority, deploymentSalt],
    nftMarketplace,
  );
  addDeploy(
    'Deploy reviewed ERC-721 collection registry',
    2n,
    'OneshotReviewedCollectionRegistry',
    [nftFactory, listingAuthority, deploymentSalt],
    reviewedRegistry,
  );
  addDeploy(
    'Deploy reviewed ERC-721 marketplace',
    3n,
    'OneshotReviewedMarketplace',
    [reviewedRegistry, deploymentSalt],
    reviewedMarketplace,
  );

  let oracleDeployer: Address | null = null;
  let oracle: Address | null = null;
  let oracleSalt: Hex | null = null;
  let oracleInitHash: Hex | null = null;
  let tokenFactory: Address | null = null;
  let quoter: Address | null = null;
  let expectedCreationCode: {
    length: number;
    first: { address: Address; codeHash: Hex };
    second: { address: Address; codeHash: Hex };
  } | null = null;

  if (poolManager) {
    oracleDeployer = predictedAddress(4n);
    tokenFactory = predictedAddress(6n);
    quoter = predictedAddress(7n);

    const oracleArtifact = artifacts.OneshotV4Oracle!;
    const oracleInit = encodeDeployData({ abi: oracleArtifact.abi, bytecode: oracleArtifact.bytecode.object, args: [poolManager] });
    oracleInitHash = keccak256(oracleInit);
    const mined = mineObservationHook(oracleDeployer, oracleInitHash);
    oracle = mined.address;
    oracleSalt = mined.salt;

    const marketCode = artifacts.OneshotV4Market!.bytecode.object;
    const firstBytes = Math.floor((marketCode.length - 2) / 4);
    expectedCreationCode = {
      length: (marketCode.length - 2) / 2,
      first: { address: getContractAddress({ from: tokenFactory, nonce: 1n }), codeHash: keccak256(`0x00${marketCode.slice(2, 2 + firstBytes * 2)}`) },
      second: { address: getContractAddress({ from: tokenFactory, nonce: 2n }), codeHash: keccak256(`0x00${marketCode.slice(2 + firstBytes * 2)}`) },
    };

    addDeploy('Deploy immutable oracle deployer', 4n, 'OneshotV4OracleDeployer', [], oracleDeployer);
    transactions.push({
      action: 'Deploy observation hook with mined CREATE2 salt',
      nonce: (inputs.nonce + 5n).toString(),
      from: deployer,
      chainId: inputs.chainId,
      to: oracleDeployer,
      value: '0x0',
      data: encodeFunctionData({
        abi: artifacts.OneshotV4OracleDeployer!.abi,
        functionName: 'deploy',
        args: [poolManager, oracleSalt],
      }),
      expectedContract: oracle,
      initCodeHash: oracleInitHash,
    });
    addDeploy(
      'Deploy token market factory with Zero processing minimum',
      6n,
      'OneshotV4MarketFactory',
      [poolManager, oracle, platform, minProcessingNative],
      tokenFactory,
    );
    addDeploy('Deploy exact-input token quoter', 7n, 'OneshotV4Quoter', [tokenFactory], quoter);
  }

  return {
    schemaVersion: 1,
    kind: 'oneshot-zero-unsigned-plan',
    verifiedDeployment: false,
    network: {
      mode: inputs.mode,
      isTestnet: inputs.mode === 'zero-testnet',
      chainId: inputs.chainId,
      expectedGenesisHash: genesisHash,
      nativeSymbol: 'ZRO' as const,
      rpcIdentityVerified: false,
      poolManager,
      poolManagerCodeHash: null,
      minProcessingNativeRaw: poolManager ? minProcessingNative.toString() : null,
    },
    tokenV4Included: Boolean(poolManager),
    tokenV4SkippedReason: poolManager ? null : 'Token V4 deployment skipped until a canonical Zero PoolManager address is verified.',
    inputs: {
      deployer,
      firstNonce: inputs.nonce.toString(),
      platform,
      listingAuthority,
      deploymentSalt,
      poolManager,
      minProcessingNativeRaw: minProcessingNative.toString(),
    },
    predicted: {
      nftFactory,
      nftMarketplace,
      reviewedRegistry,
      reviewedMarketplace,
      oracleDeployer,
      oracle,
      tokenFactory,
      quoter,
    },
    expectedCreationCode,
    hook: oracle && oracleSalt && oracleInitHash ? { flags: '0x1040', salt: oracleSalt, initCodeHash: oracleInitHash } : null,
    artifacts: artifactEvidence,
    transactions,
    manifestPreparation: {
      nft: {
        schemaVersion: 1,
        deploymentVersion: 'oneshot-nft-v3',
        mode: inputs.mode,
        chainId: inputs.chainId,
        genesisHash,
        startBlock: null,
        anchorHash: null,
        factory: { address: nftFactory, codeHash: null },
        marketplace: { address: nftMarketplace, codeHash: null },
        reviewedRegistry: { address: reviewedRegistry, codeHash: null },
        reviewedMarketplace: { address: reviewedMarketplace, codeHash: null },
        listingAuthorization: { authority: listingAuthority, salt: deploymentSalt },
      },
      token: poolManager
        ? {
            schemaVersion: 1,
            deploymentVersion: 'oneshot-v4-market-v1',
            mode: inputs.mode,
            chainId: inputs.chainId,
            genesisHash,
            startBlock: null,
            anchorHash: null,
            factory: { address: tokenFactory, codeHash: null },
            poolManager: { address: poolManager, codeHash: null },
            oracle: { address: oracle, codeHash: null },
            quoter: { address: quoter, codeHash: null },
          }
        : null,
    },
    requiredPostDeploymentEvidence: [
      `Verify chain ${inputs.chainId} and official genesis ${genesisHash} using the intended Zero RPC before broadcasting.`,
      'Verify Zero EVM supports Cancun opcodes (MCOPY for OZ 5.6.1 contracts; TLOAD/TSTORE if deploying Uniswap v4 PoolManager).',
      'Confirm each successful canonical receipt and record exact runtime code hashes after immutable constructor substitution.',
      'Set startBlock to the first applicable deployment block and anchorHash to its canonical parent block hash.',
      ...(poolManager
        ? ['Verify canonical Zero PoolManager code hash, mined hook flags (0x1040), minProcessingNative, and token creationCode chunks before enabling token execution.']
        : ['Verify canonical Zero PoolManager address before planning token V4 deployment.']),
    ],
    limitations: [
      'Unsigned preparation only. No RPC requests, wallet calls, signing, broadcasting or deployment are performed.',
      'Predictions require the supplied deployer nonce and exact transaction order.',
      'Manifest templates contain null anchors and runtime hashes and fail closed until populated from verified canonical receipts.',
      ...(poolManager ? [] : ['Token V4 deployment skipped until a canonical Zero PoolManager address is verified.']),
    ],
  };
}
