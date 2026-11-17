import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, Hex } from 'viem';
import { buildBaseSepoliaPlan, type DeploymentArtifact, type PlanContract } from './lib/base-sepolia-plan';

const root = fileURLToPath(new URL('../', import.meta.url));
if(process.argv.length===3&&process.argv[2]==='--help'){
  console.log('Usage: npm run contracts:plan:base -- --deployer ADDRESS --nonce DECIMAL --platform ADDRESS --listing-authority ADDRESS --deployment-salt NONZERO_BYTES32 [--output .local/qa/NAME.json]\nOffline only. Rebuilds pinned contracts and prepares six unsigned Base Sepolia wallet calls. No key, RPC, deployment or broadcast. Requires Foundry 1.7.1.');
  process.exit(0);
}
const values = new Map<string, string>();
const allowed = new Set(['--deployer', '--nonce', '--platform', '--listing-authority', '--deployment-salt', '--output']);
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i], value = process.argv[i + 1];
  if (!allowed.has(flag) || !value || value.startsWith('--') || values.has(flag)) throw new Error('INVALID_PLAN_ARGUMENTS');
  values.set(flag, value);
}
for (const flag of allowed) if (flag !== '--output' && !values.has(flag)) throw new Error(`MISSING_PLAN_ARGUMENT ${flag}`);
if (!/^\d+$/.test(values.get('--nonce')!)) throw new Error('INVALID_DEPLOYER_NONCE');
const forge = process.env.ONESHOT_FORGE_BIN ?? (process.platform === 'win32' ? 'forge.exe' : 'forge');
const version = spawnSync(forge, ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (version.status !== 0 || !/forge Version: 1\.7\.1\b/.test(version.stdout)) throw new Error('FOUNDRY_1_7_1_REQUIRED');
const build = spawnSync(forge, ['build', '--root', path.join(root, 'contracts-evm')], { cwd: root, encoding: 'utf8', env: { ...process.env, FOUNDRY_PROFILE: 'default' }, windowsHide: true });
if (build.status !== 0) throw new Error('CONTRACT_BUILD_FAILED');
const sources: Record<PlanContract, string> = { OneshotNFTFactory: 'OneshotNFTFactory', OneshotGuardedMarketplace: 'OneshotGuardedMarketplace', OneshotV4OracleDeployer: 'OneshotV4Oracle', OneshotV4Oracle: 'OneshotV4Oracle', OneshotV4MarketFactory: 'OneshotV4Market', OneshotV4Market: 'OneshotV4Market', OneshotV4Quoter: 'OneshotV4Quoter' };
const artifacts = {} as Record<PlanContract, DeploymentArtifact>;
for (const [name, source] of Object.entries(sources)) artifacts[name as PlanContract] = JSON.parse(await readFile(path.join(root, 'contracts-evm', 'out', `${source}.sol`, `${name}.json`), 'utf8'));
const plan = buildBaseSepoliaPlan(artifacts, { deployer: values.get('--deployer') as Address, nonce: BigInt(values.get('--nonce')!), platform: values.get('--platform') as Address, listingAuthority: values.get('--listing-authority') as Address, deploymentSalt: values.get('--deployment-salt') as Hex });
const qa = path.join(root, '.local', 'qa'); await mkdir(qa, { recursive: true });
const output = values.get('--output') ? path.resolve(root, values.get('--output')!) : path.join(qa, `base-sepolia-unsigned-${randomUUID()}.json`);
// Restrict evidence to the local QA directory, including symlink/junction resolution.
const actualQa = await realpath(qa), actualParent = await realpath(path.dirname(output));
const relative = path.relative(actualQa, actualParent);
if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('QA_OUTPUT_DIRECTORY_REQUIRED');
await writeFile(path.join(actualParent, path.basename(output)), JSON.stringify({ ...plan, preparedAt: new Date().toISOString(), toolchain: { forge: version.stdout.trim(), solidity: '0.8.30', evmVersion: 'cancun', core: '1.0.2', periphery: '1.0.3' } }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: 'unsigned-plan-prepared', verifiedDeployment: false, network: 'Base Sepolia', chainId: 84532, transactions: plan.transactions.length, predicted: plan.predicted, output: path.relative(root, output) }));
