import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, Hex } from 'viem';
import type { DeploymentArtifact } from './lib/base-sepolia-plan';
import { buildZeroPlan, type ZeroPlanArtifacts, type ZeroPlanContract } from './lib/zero-plan';

const root = fileURLToPath(new URL('../', import.meta.url));

if (process.argv.length === 3 && process.argv[2] === '--help') {
  console.log(
    'Usage: npm run contracts:plan:zero -- --mode zero-testnet|zero-mainnet --chain-id ID --genesis-hash HASH --deployer ADDRESS --nonce DECIMAL --platform ADDRESS --listing-authority ADDRESS --deployment-salt NONZERO_BYTES32 [--pool-manager ADDRESS] [--min-processing-native WEI] [--confirm-mainnet] [--output .local/qa/NAME.json]\n' +
      'Offline only. Rebuilds contracts and prepares unsigned Zero wallet calls. Rejects Zerion 543210 and reserved EVM chains. Mainnet mode requires --confirm-mainnet. No key, RPC, or broadcast.',
  );
  process.exit(0);
}

const values = new Map<string, string>();
let confirmMainnet = false;
const valueFlags = new Set([
  '--mode',
  '--chain-id',
  '--genesis-hash',
  '--deployer',
  '--nonce',
  '--platform',
  '--listing-authority',
  '--deployment-salt',
  '--pool-manager',
  '--min-processing-native',
  '--output',
]);

for (let i = 2; i < process.argv.length; i += 1) {
  const flag = process.argv[i];
  if (flag === '--confirm-mainnet') {
    if (confirmMainnet) throw new Error('DUPLICATE_CONFIRM_MAINNET');
    confirmMainnet = true;
    continue;
  }
  const value = process.argv[i + 1];
  if (!valueFlags.has(flag) || !value || value.startsWith('--') || values.has(flag)) {
    throw new Error('INVALID_PLAN_ARGUMENTS');
  }
  values.set(flag, value);
  i += 1;
}

for (const required of [
  '--mode',
  '--chain-id',
  '--genesis-hash',
  '--deployer',
  '--nonce',
  '--platform',
  '--listing-authority',
  '--deployment-salt',
]) {
  if (!values.has(required)) throw new Error(`MISSING_PLAN_ARGUMENT ${required}`);
}

const mode = values.get('--mode')!;
if (mode !== 'zero-testnet' && mode !== 'zero-mainnet') throw new Error('INVALID_ZERO_MODE');
const chainIdRaw = values.get('--chain-id')!;
if (!/^[1-9]\d*$/.test(chainIdRaw) || !Number.isSafeInteger(Number(chainIdRaw))) throw new Error('INVALID_CHAIN_ID');
if (!/^\d+$/.test(values.get('--nonce')!)) throw new Error('INVALID_DEPLOYER_NONCE');

const minProcessingRaw = values.get('--min-processing-native');
if (minProcessingRaw !== undefined && !/^[1-9]\d*$/.test(minProcessingRaw)) {
  throw new Error('INVALID_MIN_PROCESSING_NATIVE');
}

const forge = process.env.ONESHOT_FORGE_BIN ?? (process.platform === 'win32' ? 'forge.exe' : 'forge');
const version = spawnSync(forge, ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (version.status !== 0 || !/forge Version: 1\.7\.1\b/.test(version.stdout)) throw new Error('FOUNDRY_1_7_1_REQUIRED');

const poolManager = values.get('--pool-manager') as Address | undefined;
const build = spawnSync(forge, ['build', '--root', path.join(root, 'contracts-evm')], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, FOUNDRY_PROFILE: 'default' },
  windowsHide: true,
});
if (build.status !== 0) throw new Error('CONTRACT_BUILD_FAILED');

const sources: Record<ZeroPlanContract, string> = {
  OneshotNFTFactory: 'OneshotNFTFactory',
  OneshotGuardedMarketplaceV3: 'OneshotGuardedMarketplaceV3',
  OneshotReviewedCollectionRegistry: 'OneshotReviewedCollectionRegistry',
  OneshotReviewedMarketplace: 'OneshotReviewedMarketplace',
  OneshotV4OracleDeployer: 'OneshotV4Oracle',
  OneshotV4Oracle: 'OneshotV4Oracle',
  OneshotV4MarketFactory: 'OneshotV4Market',
  OneshotV4Market: 'OneshotV4Market',
  OneshotV4Quoter: 'OneshotV4Quoter',
};

const artifacts: ZeroPlanArtifacts = {} as ZeroPlanArtifacts;
const contractsToLoad: ZeroPlanContract[] = poolManager
  ? (Object.keys(sources) as ZeroPlanContract[])
  : [
      'OneshotNFTFactory',
      'OneshotGuardedMarketplaceV3',
      'OneshotReviewedCollectionRegistry',
      'OneshotReviewedMarketplace',
    ];

for (const name of contractsToLoad) {
  const source = sources[name];
  artifacts[name] = JSON.parse(
    await readFile(path.join(root, 'contracts-evm', 'out', `${source}.sol`, `${name}.json`), 'utf8'),
  ) as DeploymentArtifact;
}

const plan = buildZeroPlan(artifacts, {
  mode,
  chainId: Number(chainIdRaw),
  genesisHash: values.get('--genesis-hash') as Hex,
  deployer: values.get('--deployer') as Address,
  nonce: BigInt(values.get('--nonce')!),
  platform: values.get('--platform') as Address,
  listingAuthority: values.get('--listing-authority') as Address,
  deploymentSalt: values.get('--deployment-salt') as Hex,
  ...(poolManager ? { poolManager } : {}),
  ...(minProcessingRaw ? { minProcessingNative: BigInt(minProcessingRaw) } : {}),
  mainnetConfirmed: confirmMainnet,
});

const qa = path.join(root, '.local', 'qa');
await mkdir(qa, { recursive: true });
const output = values.get('--output')
  ? path.resolve(root, values.get('--output')!)
  : path.join(qa, `zero-${mode}-unsigned-${randomUUID()}.json`);
const actualQa = await realpath(qa);
const actualParent = await realpath(path.dirname(output));
const relative = path.relative(actualQa, actualParent);
if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA_OUTPUT_DIRECTORY_REQUIRED');

await writeFile(
  path.join(actualParent, path.basename(output)),
  JSON.stringify(
    {
      ...plan,
      preparedAt: new Date().toISOString(),
      toolchain: {
        forge: version.stdout.trim(),
        solidity: '0.8.30',
        evmVersion: 'cancun',
      },
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);

console.log(
  JSON.stringify({
    status: 'unsigned-plan-prepared',
    verifiedDeployment: false,
    mode,
    chainId: plan.network.chainId,
    tokenV4Included: plan.tokenV4Included,
    transactions: plan.transactions.length,
    predicted: plan.predicted,
    output: path.relative(root, output),
  }),
);
