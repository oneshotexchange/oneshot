import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Pool } from 'pg';
import { createPublicClient, createWalletClient, http, keccak256, stringToHex, zeroHash, type Abi, type Address, type Hex } from 'viem';
import { anvil } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createVerifiedRpc, guardedListingPermitTypedData, networkConfig } from '@oneshot/evm';
import { syncIndexer } from '../apps/indexer/src/engine';
import { manifestId, manifestJson, parseManifest } from '../apps/indexer/src/manifest';
import { VerifiedRpcSource } from '../apps/indexer/src/rpc-source';
import { INDEXER_SCHEMA_SQL, PostgresIndexerStore } from '../apps/indexer/src/store';

// Disposable, real local chain data for read-only API/browser QA. Never a public deployment.
const root = fileURLToPath(new URL('../', import.meta.url));
const contractRoot = path.join(root, 'contracts-evm');
class FixtureError extends Error {
  constructor(public readonly code: string) { super(code); }
}
let child: ChildProcess | undefined;
let childError = false;
let pool: Pool | undefined;
let store: PostgresIndexerStore | undefined;
let ownedManifestId: string | undefined;
let publishedManifestPath: string | undefined;
let publishedStateOwned = false;
let ownedPrivateEnvPath: string | undefined;
let closing = false;
let stopped = false;
let ready = false;
let stage = 'arguments';
let stopResolve!: () => void;
const stop = new Promise<void>(resolve => { stopResolve = resolve; });
function requestStop() { stopped = true; stopResolve(); }
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);
process.stdin.once('end', requestStop);
process.stdin.once('close', requestStop);
process.stdin.resume();
function checkStop() { if (stopped) throw new FixtureError('STOP_REQUESTED'); }

try {
  const args = process.argv.slice(2), flags = new Map<string, string>();
  let once = false, guarded = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--once') {
      if (once) throw new FixtureError('ARGUMENTS_INVALID');
      once = true; continue;
    }
    if (flag === '--guarded') {
      if (guarded) throw new FixtureError('ARGUMENTS_INVALID');
      guarded = true; continue;
    }
    if (!['--env-file', '--database-url', '--manifest'].includes(flag) || flags.has(flag)
      || !args[index + 1] || args[index + 1].startsWith('--')) throw new FixtureError('ARGUMENTS_INVALID');
    flags.set(flag, args[++index]);
  }
  if (flags.has('--env-file') === flags.has('--database-url')) throw new FixtureError('EXPLICIT_DATABASE_REQUIRED');
  let connectionString: string | undefined = flags.get('--database-url');
  if (flags.has('--env-file')) {
    const file = await readFile(path.resolve(root, flags.get('--env-file')!));
    if (file.length > 65_536) throw new FixtureError('ENV_FILE_INVALID');
    // Read only the explicitly selected file's URL; ambient production URLs never win.
    connectionString = parseEnv(file.toString('utf8')).DATABASE_URL;
  }
  if (!connectionString) throw new FixtureError('EXPLICIT_DATABASE_REQUIRED');
  let databaseUrl: URL;
  try { databaseUrl = new URL(connectionString); } catch { throw new FixtureError('LOCAL_DATABASE_REQUIRED'); }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname)
    || !['/oneshot_dev', '/oneshot_indexer_test'].includes(databaseUrl.pathname)
    || databaseUrl.hash || databaseUrl.search) throw new FixtureError('LOCAL_DATABASE_REQUIRED');
  const manifestPath = path.resolve(root, flags.get('--manifest') || '.local/qa/indexed-preview-manifest.json');
  const localRoot = path.resolve(root, '.local'), relative = path.relative(localRoot, manifestPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
    || path.extname(manifestPath) !== '.json') throw new FixtureError('LOCAL_MANIFEST_PATH_REQUIRED');

  stage = 'contract-build';
  const forge = process.env.ONESHOT_FORGE_BIN || (process.platform === 'win32' ? 'forge.exe' : 'forge');
  const binary = process.env.ONESHOT_ANVIL_BIN || (process.platform === 'win32' ? 'anvil.exe' : 'anvil');
  const build = spawnSync(forge, ['build', '--root', contractRoot], { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (build.status !== 0) throw new FixtureError('CONTRACT_BUILD_FAILED');
  checkStop();

  stage = 'local-chain';
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const rpcUrl = `http://127.0.0.1:${port}`;
  child = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', () => undefined);
  child.once('error', () => { childError = true; requestStop(); });
  child.once('exit', () => {
    if (!closing) { childError = true; requestStop(); }
  });
  const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(2500) });
    } catch (error) {
      if ((error as { cause?: { code?: string } }).cause?.code === 'EACCES') throw new FixtureError('LOCAL_RPC_BLOCKED');
      throw new FixtureError('LOCAL_RPC_UNAVAILABLE');
    }
    const body = await response.json() as { result?: T; error?: unknown };
    if (!response.ok || body.error) throw new FixtureError('LOCAL_RPC_FAILED');
    return body.result as T;
  };
  let chainReady = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (childError || child.exitCode !== null) throw new FixtureError('LOCAL_CHAIN_STOPPED');
    checkStop();
    try { chainReady = await rpc<string>('eth_chainId') === '0x7a69'; if (chainReady) break; }
    catch (error) { if (error instanceof FixtureError && error.code === 'LOCAL_RPC_BLOCKED') throw error; }
    await pause(100);
  }
  if (!chainReady) throw new FixtureError('LOCAL_CHAIN_NOT_READY');
  const verifiedRpc = await createVerifiedRpc(networkConfig({ ONESHOT_NETWORK: 'local', ONESHOT_RPC_URL: rpcUrl }));
  const client = createPublicClient({ chain: anvil, transport: http(rpcUrl, { retryCount: 0, timeout: 5000 }) });
  const wallet = createWalletClient({ chain: anvil, transport: http(rpcUrl, { retryCount: 0, timeout: 5000 }) });
  const accounts = await rpc<Address[]>('eth_accounts');
  const [creator, minter, buyer, treasury] = accounts;
  assert(creator && minter && buyer && treasury);
  type Artifact = { abi: Abi; bytecode: { object: Hex } };
  const artifact = async (name: string): Promise<Artifact> => JSON.parse(await readFile(path.join(contractRoot, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
  const factoryArtifact = await artifact('OneshotNFTFactory');
  const marketArtifact = await artifact(guarded ? 'OneshotGuardedMarketplace' : 'OneshotMarketplace');
  const collectionArtifact = await artifact('OneshotCollection');
  const authorityKey = guarded ? generatePrivateKey() : undefined;
  const authority = authorityKey ? privateKeyToAccount(authorityKey) : undefined;
  const deploymentSalt = guarded ? `0x${randomBytes(32).toString('hex')}` as Hex : undefined;
  let transactions = 0;
  async function receipt(hash: Hex) {
    checkStop();
    const result = await client.waitForTransactionReceipt({ hash, timeout: 10_000 });
    if (result.status !== 'success') throw new FixtureError('LOCAL_TRANSACTION_REVERTED');
    transactions++; return result;
  }
  async function deploy(data: Artifact, args: readonly unknown[]) {
    const result = await receipt(await wallet.deployContract({ account: creator, abi: data.abi, bytecode: data.bytecode.object, args }));
    if (!result.contractAddress) throw new FixtureError('LOCAL_DEPLOYMENT_FAILED');
    return { address: result.contractAddress, block: result.blockNumber };
  }
  stage = 'local-transactions';
  const factory = await deploy(factoryArtifact, [treasury]);
  const market = await deploy(marketArtifact, guarded ? [factory.address, authority!.address, deploymentSalt!] : [factory.address]);
  await receipt(await wallet.writeContract({ account: creator, address: factory.address, abi: factoryArtifact.abi, functionName: 'createCollection', args: ['oneshot local originals', 'SHOT'] }));
  const collection = await client.readContract({ address: factory.address, abi: factoryArtifact.abi, functionName: 'collections', args: [0n] }) as Address;
  const start = (await client.getBlock()).timestamp + 30n;
  const price = 1_000_000_000_000_000n;
  const terms = { maxSupply: 10n, royaltyBps: 500, allowlistRoot: zeroHash,
    contentHash: keccak256(stringToHex('oneshot-local-indexed-preview')),
    metadataBaseURI: 'ipfs://oneshot-local-preview/', collectionURI: 'ipfs://oneshot-local-preview-collection',
    allowlist: { start: 0n, end: 0n, walletLimit: 0n, price: 0n },
    publicMint: { start, end: start + 3600n, walletLimit: 5n, price } };
  await receipt(await wallet.writeContract({ account: creator, address: collection, abi: collectionArtifact.abi, functionName: 'configure', args: [terms] }));
  await receipt(await wallet.writeContract({ account: creator, address: collection, abi: collectionArtifact.abi, functionName: 'open' }));
  await rpc('evm_setNextBlockTimestamp', [Number(start)]); await rpc('evm_mine');
  await receipt(await wallet.writeContract({ account: minter, address: collection, abi: collectionArtifact.abi, functionName: 'mint', args: [4n, minter, price * 4n, []], value: price * 4n }));
  const writeMarket = async (account: Address, functionName: string, args: readonly unknown[], value?: bigint) =>
    receipt(await wallet.writeContract({ account, address: market.address, abi: marketArtifact.abi, functionName, args, value }));
  const approve = async (tokenId: bigint) => receipt(await wallet.writeContract({ account: minter, address: collection, abi: collectionArtifact.abi, functionName: 'approve', args: [market.address, tokenId] }));
  const list = async (tokenId: bigint, totalPrice: bigint) => {
    if (!guarded) return writeMarket(minter, 'list', [collection, tokenId, totalPrice]);
    const nonce = await client.readContract({ address: market.address, abi: marketArtifact.abi, functionName: 'listingNonces', args: [minter] }) as bigint;
    const deadline = (await client.getBlock()).timestamp + 120n;
    const signature = await authority!.signTypedData(guardedListingPermitTypedData({ chainId: 31337, verifyingContract: market.address }, {
      seller: minter, collection, tokenId, totalPrice, nonce, policyCommitment: zeroHash, deadline, deploymentSalt: deploymentSalt!,
    }));
    return writeMarket(minter, 'listAuthorized', [collection, tokenId, totalPrice, nonce, zeroHash, deadline, signature]);
  };
  await approve(1n); await list(1n, price * 3n);
  await writeMarket(buyer, 'buy', [1n, price * 3n, buyer], price * 3n);
  await approve(2n); await list(2n, price * 2n);
  await approve(3n); await list(3n, price * 4n);
  await writeMarket(minter, 'cancelTo', [3n, minter]);
  await receipt(await wallet.writeContract({ account: minter, address: collection, abi: collectionArtifact.abi, functionName: 'transferFrom', args: [minter, creator, 4n] }));
  for (const account of [treasury, creator, minter]) await writeMarket(account, 'claimTo', [account]);
  for (const account of [treasury, creator]) await receipt(await wallet.writeContract({ account, address: collection, abi: collectionArtifact.abi, functionName: 'claimTo', args: [account] }));
  await receipt(await wallet.writeContract({ account: creator, address: factory.address, abi: factoryArtifact.abi, functionName: 'createCollection', args: ['Unopened local study', 'STUDY'] }));
  const unopenedCollection = await client.readContract({ address: factory.address, abi: factoryArtifact.abi, functionName: 'collections', args: [1n] }) as Address;
  const genesis = await client.getBlock({ blockNumber: 0n });
  const anchor = await client.getBlock({ blockNumber: factory.block - 1n });
  const manifest = parseManifest({ schemaVersion: 1, deploymentVersion: guarded ? 'oneshot-nft-v2' : 'oneshot-nft-v1', mode: 'local', chainId: 31337,
    genesisHash: genesis.hash, startBlock: factory.block.toString(), anchorHash: anchor.hash,
    factory: { address: factory.address, codeHash: keccak256((await client.getCode({ address: factory.address }))!) },
    marketplace: { address: market.address, codeHash: keccak256((await client.getCode({ address: market.address }))!) },
    ...(guarded ? { listingAuthorization: { authority: authority!.address, salt: deploymentSalt! } } : {}) });
  const id = manifestId(manifest);

  stage = 'local-database';
  pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 8000, idleTimeoutMillis: 10_000 });
  pool.on('error', () => { childError = true; requestStop(); });
  const claim = await pool.connect();
  try {
    await claim.query('BEGIN');
    await claim.query("SELECT pg_advisory_xact_lock(hashtext('oneshot_evm_indexer'), hashtext($1))", [id]);
    await claim.query("SELECT pg_advisory_xact_lock(hashtext('oneshot_evm_schema'), 0)");
    await claim.query(INDEXER_SCHEMA_SQL);
    const claimed = await claim.query('INSERT INTO oneshot_evm_deployments(manifest_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING manifest_id', [id]);
    if (claimed.rowCount !== 1) throw new FixtureError('DEPLOYMENT_ALREADY_EXISTS');
    await claim.query('COMMIT');
    ownedManifestId = id;
  } catch (error) { await claim.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { claim.release(); }
  store = new PostgresIndexerStore(pool);
  const indexed = await syncIndexer(new VerifiedRpcSource(verifiedRpc), store, manifest);
  assert(indexed.caughtUp);
  const counts = await store.transaction(async tx => ({
    collections: Object.keys(await tx.list('collections')).length,
    items: Object.keys(await tx.list('items')).length,
    listings: Object.keys(await tx.list('listings')).length,
    claims: Object.keys(await tx.list('claims')).length,
    activity: Object.keys(await tx.list('activity')).length,
  }));
  assert.deepEqual({ collections: counts.collections, items: counts.items, listings: counts.listings, claims: counts.claims },
    { collections: 2, items: 4, listings: 3, claims: 5 });
  const rawLogs = await pool.query('SELECT count(*)::int AS count FROM oneshot_evm_logs WHERE manifest_id=$1', [id]);
  checkStop();
  stage = 'publish-manifest';
  await mkdir(path.dirname(manifestPath), { recursive: true });
  // Never overwrite another active fixture's manifest. Choose a new --manifest path to rerun.
  await writeFile(manifestPath, JSON.stringify(manifestJson(manifest), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  publishedManifestPath = manifestPath;
  if (guarded) {
    const privateEnvPath = `${manifestPath}.guarded.env`;
    const privateConfiguration = {
      ONESHOT_NETWORK: 'local', ONESHOT_RPC_URL: rpcUrl, ONESHOT_INDEXER_READS_ENABLED: 'true',
      ONESHOT_INDEXER_MANIFEST_PATH: manifestPath.replaceAll('\\', '/'), ONESHOT_LOCAL_NFT_EXECUTION_ENABLED: 'true',
      ONESHOT_LISTING_AUTHORITY_PRIVATE_KEY: authorityKey!, ONESHOT_FLOOR_CREATORS: creator.toLowerCase(),
    };
    // This ignored local file is the only persisted signing-key copy. Never include its contents in output/state JSON.
    await writeFile(privateEnvPath, Object.entries(privateConfiguration).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    ownedPrivateEnvPath = privateEnvPath;
  }
  const result = { service: 'oneshot-local-indexed-fixture', status: 'ready', network: 'Local Anvil (not Zero)',
    rpcUrl, manifestPath, manifestId: id, collection: collection.toLowerCase(), unopenedCollection: unopenedCollection.toLowerCase(),
    wallets: { creator: creator.toLowerCase(), minter: minter.toLowerCase(), buyer: buyer.toLowerCase(), treasury: treasury.toLowerCase() },
    transactions, rawLogs: rawLogs.rows[0].count, counts,
    apiEnvironment: { ONESHOT_NETWORK: 'local', ONESHOT_RPC_URL: rpcUrl, ONESHOT_INDEXER_READS_ENABLED: 'true', ONESHOT_INDEXER_MANIFEST_PATH: manifestPath },
    ...(ownedPrivateEnvPath ? { privateEnvironmentPath: ownedPrivateEnvPath, marketplaceVersion: 'oneshot-nft-v2',
      settings: 'Load the private environment file in the local API process; the creator can enable protection in private collection settings.' } : {}),
    persistence: 'Temporary fixture rows are removed on orderly shutdown; unrelated records remain.',
    stop: '--once exits immediately; otherwise send SIGINT/SIGTERM or close stdin.' };
  await writeFile(`${manifestPath}.state.json`, JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  publishedStateOwned = true;
  ready = true;
  console.log(JSON.stringify(result, null, 2));
  stage = 'holding';
  if (!once) await stop;
  if (childError) throw new FixtureError('LOCAL_SERVICE_STOPPED');
} catch (error) {
  if (!(error instanceof FixtureError && error.code === 'STOP_REQUESTED')) {
    const code = error instanceof FixtureError ? error.code : (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'MANIFEST_EXISTS' : 'FIXTURE_FAILED';
    console.error(JSON.stringify({ service: 'oneshot-local-indexed-fixture', status: 'failed', stage, error: code }));
    process.exitCode = 1;
  }
} finally {
  closing = true;
  let cleanupSucceeded = true;
  if (pool && ownedManifestId) {
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('oneshot_evm_indexer'), hashtext($1))", [ownedManifestId]);
        for (const table of ['oneshot_evm_projections', 'oneshot_evm_logs', 'oneshot_evm_journal', 'oneshot_evm_deployments']) {
          await client.query(`DELETE FROM ${table} WHERE manifest_id=$1`, [ownedManifestId]);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      finally { client.release(); }
    } catch {
      cleanupSucceeded = false; process.exitCode = 1;
      console.error(JSON.stringify({ service: 'oneshot-local-indexed-fixture', status: 'cleanup-pending', manifestId: ownedManifestId, error: 'SCOPED_DATABASE_CLEANUP_FAILED' }));
    }
  }
  if (store) await store.close().catch(() => { cleanupSucceeded = false; process.exitCode = 1; });
  else await pool?.end().catch(() => { cleanupSucceeded = false; process.exitCode = 1; });
  let chainStopped = !child || child.exitCode !== null || child.signalCode !== null || !child.pid;
  if (child && !chainStopped) child.kill();
  if (child) {
    chainStopped = await new Promise<boolean>(resolve => {
      if (child!.exitCode !== null || child!.signalCode !== null || !child!.pid) resolve(true);
      else { child!.once('exit', () => resolve(true)); setTimeout(() => resolve(false), 2000).unref(); }
    });
  }
  if (!chainStopped) { cleanupSucceeded = false; process.exitCode = 1; }
  if (publishedManifestPath && publishedStateOwned) {
    await writeFile(`${publishedManifestPath}.state.json`, JSON.stringify({ service: 'oneshot-local-indexed-fixture', status: 'stopped',
      chainStopped, cleanupSucceeded, manifestId: ownedManifestId, stoppedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 }).catch(() => { process.exitCode = 1; });
  }
  if (ownedPrivateEnvPath) await unlink(ownedPrivateEnvPath).catch(() => { process.exitCode = 1; });
  if (ready) console.log(JSON.stringify({ service: 'oneshot-local-indexed-fixture', status: 'stopped', cleanupSucceeded }));
  process.stdin.pause();
}
