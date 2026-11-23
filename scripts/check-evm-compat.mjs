import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const contractsRoot = path.join(root, 'contracts-evm');
const forge = process.env.ONESHOT_FORGE_BIN ?? (process.platform === 'win32' ? 'forge.exe' : 'forge');
const EIP170_LIMIT = 24_576;
const EIP3860_LIMIT = 49_152;

const DEPLOYMENT_CONTRACTS = new Set([
  'OneshotNFTFactory',
  'OneshotCollection',
  'OneshotEdition1155Factory',
  'OneshotEdition1155',
  'OneshotGuardedMarketplace',
  'OneshotGuardedMarketplaceV3',
  'OneshotReviewedCollectionRegistry',
  'OneshotReviewedMarketplace',
  'OneshotMarketToken',
  'OneshotV4Oracle',
  'OneshotV4OracleDeployer',
  'OneshotV4Market',
  'OneshotV4MarketFactory',
  'OneshotV4Quoter',
  'OneshotToken',
  'OneshotTeamVesting',
  'OneshotAirdropDistributor',
  'OneshotPlatformV4Market',
]);

function collectArtifacts(directory, results = []) {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      collectArtifacts(full, results);
    } else if (entry.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

function scanRuntimeOpcodes(hex) {
  let bytes = Buffer.from(hex.slice(2), 'hex');
  if (bytes.length >= 2) {
    const metaLength = bytes.readUInt16BE(bytes.length - 2);
    const metaStart = bytes.length - 2 - metaLength;
    if (metaStart > 0 && bytes[metaStart] >= 0xa0 && bytes[metaStart] <= 0xbf) {
      bytes = bytes.subarray(0, metaStart);
    }
  }
  const cancun = new Set();
  let usesPush0 = false;
  for (let pc = 0; pc < bytes.length; pc += 1) {
    const op = bytes[pc];
    if (op >= 0x60 && op <= 0x7f) {
      pc += op - 0x5f;
      continue;
    }
    if (op === 0x5f) usesPush0 = true;
    else if (op === 0x5c) cancun.add('TLOAD');
    else if (op === 0x5d) cancun.add('TSTORE');
    else if (op === 0x5e) cancun.add('MCOPY');
    else if (op === 0x49) cancun.add('BLOBHASH');
    else if (op === 0x4a) cancun.add('BLOBBASEFEE');
  }
  return { cancunOpcodes: [...cancun].sort(), usesPush0 };
}

const build = spawnSync(forge, ['build', '--root', contractsRoot], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, FOUNDRY_PROFILE: 'default' },
  windowsHide: true,
});
if (build.status !== 0) {
  throw new Error(`FORGE_BUILD_FAILED: ${build.stderr || build.stdout}`);
}

const outDir = path.join(contractsRoot, 'out');
if (!existsSync(outDir)) {
  throw new Error('OUT_DIRECTORY_MISSING');
}

const checked = [];
for (const file of collectArtifacts(outDir)) {
  const name = path.basename(file, '.json');
  if (!DEPLOYMENT_CONTRACTS.has(name)) continue;
  const artifact = JSON.parse(readFileSync(file, 'utf8'));
  const initHex = artifact?.bytecode?.object;
  const runtimeHex = artifact?.deployedBytecode?.object;
  const evmVersion = artifact?.metadata?.settings?.evmVersion;
  if (typeof initHex !== 'string' || typeof runtimeHex !== 'string' || !initHex.startsWith('0x') || !runtimeHex.startsWith('0x')) {
    throw new Error(`INVALID_ARTIFACT_${name}`);
  }
  if (evmVersion !== 'cancun') {
    throw new Error(`EVM_VERSION_MISMATCH_${name}:${evmVersion}`);
  }
  const initBytes = (initHex.length - 2) / 2;
  const runtimeBytes = (runtimeHex.length - 2) / 2;
  if (runtimeBytes > EIP170_LIMIT) {
    throw new Error(`EIP170_RUNTIME_LIMIT_${name}:${runtimeBytes}`);
  }
  if (initBytes >= EIP3860_LIMIT) {
    throw new Error(`EIP3860_INITCODE_LIMIT_${name}:${initBytes}`);
  }
  const { cancunOpcodes, usesPush0 } = scanRuntimeOpcodes(runtimeHex);
  if (cancunOpcodes.includes('BLOBHASH') || cancunOpcodes.includes('BLOBBASEFEE')) {
    throw new Error(`UNSUPPORTED_BLOB_OPCODE_${name}`);
  }
  checked.push({ contract: name, evmVersion, initBytes, runtimeBytes, cancunOpcodes, usesPush0 });
}

if (checked.length < DEPLOYMENT_CONTRACTS.size) {
  throw new Error(`MISSING_DEPLOYMENT_CONTRACTS:${checked.length}/${DEPLOYMENT_CONTRACTS.size}`);
}

checked.sort((a, b) => a.contract.localeCompare(b.contract));
console.log(
  JSON.stringify(
    {
      status: 'passed',
      minimumEvmTarget: 'cancun',
      limits: { eip170RuntimeMaxBytes: EIP170_LIMIT, eip3860InitMaxBytes: EIP3860_LIMIT },
      contracts: checked,
      zeroCompatibilityNote:
        'OpenZeppelin 5.6.1 compiles with MCOPY (Cancun); Uniswap v4 contracts require TLOAD/TSTORE (Cancun). Verify Cancun opcode support on Zero Testnet/Mainnet prior to deployment.',
    },
    null,
    2,
  ),
);
