import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, stringToHex, zeroHash, type Abi, type Address, type Hex } from 'viem';
import { anvil } from 'viem/chains';
import { createVerifiedRpc, networkConfig, splitNftSettlement, TOKEN_SUPPLY_RAW } from '@oneshot/evm';
import { syncIndexer } from '../apps/indexer/src/engine';
import { manifestJson, parseManifest } from '../apps/indexer/src/manifest';
import { VerifiedRpcSource } from '../apps/indexer/src/rpc-source';
import { MemoryIndexerStore } from '../apps/indexer/src/store';

// Ephemeral, loopback-only chain. Uses Anvil's unlocked accounts; no signing keys are saved.
const root = fileURLToPath(new URL('../', import.meta.url));
const contractRoot = path.join(root, 'contracts-evm');
const forge = process.env.ONESHOT_FORGE_BIN || (process.platform === 'win32' ? 'forge.exe' : 'forge');
const anvilBin = process.env.ONESHOT_ANVIL_BIN || (process.platform === 'win32' ? 'anvil.exe' : 'anvil');
const build = spawnSync(forge, ['build', '--root', contractRoot], { cwd: root, encoding: 'utf8', windowsHide: true });
if (build.status !== 0) throw new Error(`Contract build failed: ${build.error?.message || build.stderr || build.stdout}`);
const server = createServer();
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = (server.address() as { port: number }).port;
await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const url = `http://127.0.0.1:${port}`;
const child = spawn(anvilBin, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let childError: Error | undefined;
child.once('error', error => { childError = error; });
let stderr = ''; child.stderr?.on('data', buffer => { stderr = (stderr + buffer.toString()).slice(-2000); });
const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(2500) });
  const body = await response.json() as { result?: T; error?: { message: string } };
  if (!response.ok || body.error) throw new Error(body.error?.message || `RPC HTTP ${response.status}`);
  return body.result as T;
};
type Artifact = { abi: Abi; bytecode: { object: Hex } };
const artifact = async (name: string): Promise<Artifact> => JSON.parse(await readFile(path.join(contractRoot, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
const receipts: { action: string; hash: Hex; blockNumber: string; blockHash: Hex; gasUsed: string; canonicalAtEnd?: boolean }[] = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (childError || child.exitCode !== null) throw childError || new Error(`Local Anvil stopped: ${stderr}`);
    try { ready = await rpc<string>('eth_chainId') === '0x7a69'; if (ready) break; } catch { /* process is starting */ }
    await pause(100);
  }
  assert(ready, 'Local Anvil did not start');
  const verifiedRpc = await createVerifiedRpc(networkConfig({ ONESHOT_NETWORK: 'local', ONESHOT_RPC_URL: url }));
  assert.equal(verifiedRpc.verification.chainId, 31337);
  assert.equal(verifiedRpc.verification.genesisMatched, null);
  const accounts = await rpc<Address[]>('eth_accounts');
  const [creator, minter, buyer, treasury] = accounts;
  assert(creator && minter && buyer && treasury);
  const client = createPublicClient({ chain: anvil, transport: http(url, { retryCount: 0, timeout: 5000 }) });
  const wallet = createWalletClient({ chain: anvil, transport: http(url, { retryCount: 0, timeout: 5000 }) });
  const factoryArtifact = await artifact('OneshotNFTFactory');
  const collectionArtifact = await artifact('OneshotCollection');
  const marketArtifact = await artifact('OneshotMarketplace');
  const foundationFactoryArtifact = await artifact('OneshotTokenFoundationFactory');
  const foundationArtifact = await artifact('OneshotTokenFoundation');
  const tokenArtifact = await artifact('OneshotFixedSupplyToken');
  async function receipt(action: string, hash: Hex) {
    const value = await client.waitForTransactionReceipt({ hash });
    assert.equal(value.status, 'success', action);
    receipts.push({ action, hash, blockNumber: value.blockNumber.toString(), blockHash: value.blockHash, gasUsed: value.gasUsed.toString() });
    return value;
  }
  async function deploy(name: string, data: Artifact, args: readonly unknown[]) {
    const result = await receipt(name, await wallet.deployContract({ account: creator, abi: data.abi, bytecode: data.bytecode.object, args }));
    assert(result.contractAddress); return result.contractAddress;
  }
  const factory = await deploy('Deploy NFT factory', factoryArtifact, [treasury]);
  const market = await deploy('Deploy marketplace', marketArtifact, [factory]);
  await receipt('Create collection', await wallet.writeContract({ account: creator, address: factory, abi: factoryArtifact.abi, functionName: 'createCollection', args: ['oneshot local originals', 'SHOT'] }));
  const collection = await client.readContract({ address: factory, abi: factoryArtifact.abi, functionName: 'collections', args: [0n] }) as Address;
  assert.equal(await client.readContract({ address: factory, abi: factoryArtifact.abi, functionName: 'isCollection', args: [collection] }), true);
  const latest = await client.getBlock(); const start = latest.timestamp + 30n;
  const unitPrice = 1000000000000000n; // Local Anvil ETH only, not a ZRO assumption.
  const terms = { maxSupply: 10n, royaltyBps: 500, allowlistRoot: zeroHash, contentHash: keccak256(stringToHex('oneshot-local-smoke-content')), metadataBaseURI: 'ipfs://oneshot-local-content/', collectionURI: 'ipfs://oneshot-local-collection', allowlist: { start: 0n, end: 0n, walletLimit: 0n, price: 0n }, publicMint: { start, end: start + 3600n, walletLimit: 5n, price: unitPrice } };
  await receipt('Configure terms', await wallet.writeContract({ account: creator, address: collection, abi: collectionArtifact.abi, functionName: 'configure', args: [terms] }));
  await receipt('Open and freeze', await wallet.writeContract({ account: creator, address: collection, abi: collectionArtifact.abi, functionName: 'open' }));
  await rpc('evm_setNextBlockTimestamp', [Number(start)]); await rpc('evm_mine');
  await receipt('Paid public mint', await wallet.writeContract({ account: minter, address: collection, abi: collectionArtifact.abi, functionName: 'mint', args: [2n, minter, unitPrice * 2n, []], value: unitPrice * 2n }));
  assert.equal((await client.readContract({ address: collection, abi: collectionArtifact.abi, functionName: 'ownerOf', args: [1n] }) as Address).toLowerCase(), minter.toLowerCase());
  assert.equal(await client.readContract({ address: collection, abi: collectionArtifact.abi, functionName: 'totalMinted' }), 2n);
  assert.equal(await client.readContract({ address: collection, abi: collectionArtifact.abi, functionName: 'pending', args: [treasury] }), unitPrice * 2n * 200n / 10000n);
  await assert.rejects(() => client.simulateContract({ account: creator, address: collection, abi: collectionArtifact.abi, functionName: 'configure', args: [terms] }));
  await receipt('Approve resale', await wallet.writeContract({ account: minter, address: collection, abi: collectionArtifact.abi, functionName: 'approve', args: [market, 1n] }));
  const resalePrice = unitPrice * 3n;
  const listed = await receipt('List resale', await wallet.writeContract({ account: minter, address: market, abi: marketArtifact.abi, functionName: 'list', args: [collection, 1n, resalePrice] }));
  const listingEvent = listed.logs.map(log => { try { return decodeEventLog({ abi: marketArtifact.abi, data: log.data, topics: log.topics }); } catch { return null; } }).find(event => event?.eventName === 'Listed');
  assert(listingEvent); const listingId = (listingEvent.args as unknown as Record<string, unknown>).listingId;
  assert(typeof listingId === 'bigint');
  await receipt('Buy resale', await wallet.writeContract({ account: buyer, address: market, abi: marketArtifact.abi, functionName: 'buy', args: [listingId, resalePrice, buyer], value: resalePrice }));
  assert.equal((await client.readContract({ address: collection, abi: collectionArtifact.abi, functionName: 'ownerOf', args: [1n] }) as Address).toLowerCase(), buyer.toLowerCase());
  const split = splitNftSettlement(resalePrice, 500);
  for (const [account, expected] of [[treasury, split.platform], [creator, split.royalty], [minter, split.seller]] as const) assert.equal(await client.readContract({ address: market, abi: marketArtifact.abi, functionName: 'pending', args: [account] }), expected);
  await assert.rejects(() => client.simulateContract({ account: buyer, address: market, abi: marketArtifact.abi, functionName: 'buy', args: [listingId, resalePrice, buyer], value: resalePrice }));
  for (const account of [treasury, creator, minter]) await receipt('Claim resale proceeds', await wallet.writeContract({ account, address: market, abi: marketArtifact.abi, functionName: 'claimTo', args: [account] }));
  assert.equal(await client.readContract({ address: market, abi: marketArtifact.abi, functionName: 'totalPending' }), 0n);
  assert.equal(await client.getBalance({ address: market }), 0n);
  for (const account of [treasury, creator]) await receipt('Claim primary proceeds', await wallet.writeContract({ account, address: collection, abi: collectionArtifact.abi, functionName: 'claimTo', args: [account] }));
  assert.equal(await client.getBalance({ address: collection }), 0n);
  const foundationFactory = await deploy('Deploy local-only token foundation factory', foundationFactoryArtifact, [treasury]);
  const created = await receipt('Create local allocation demonstrator', await wallet.writeContract({ account: creator, address: foundationFactory, abi: foundationFactoryArtifact.abi, functionName: 'createFoundation', args: ['Local token foundation', 'LOCAL', 125, 1, 123456789n] }));
  const foundationEvent = created.logs.map(log => { try { return decodeEventLog({ abi: foundationFactoryArtifact.abi, data: log.data, topics: log.topics }); } catch { return null; } }).find(event => event?.eventName === 'TokenFoundationCreated');
  assert(foundationEvent); const foundationValue = (foundationEvent.args as unknown as Record<string, unknown>).foundation;
  assert(typeof foundationValue === 'string' && /^0x[\da-fA-F]{40}$/.test(foundationValue));
  const foundation = foundationValue as Address;
  const token = await client.readContract({ address: foundation, abi: foundationArtifact.abi, functionName: 'token' }) as Address;
  assert.equal(await client.readContract({ address: foundation, abi: foundationArtifact.abi, functionName: 'isMarketLaunch' }), false);
  assert.equal(await client.readContract({ address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [foundation] }), TOKEN_SUPPLY_RAW);
  const genesis = await client.getBlock({ blockNumber: 0n });
  assert.equal(verifiedRpc.verification.genesisHash, genesis.hash);
  const verifiedBlock = await verifiedRpc.readRpc('eth_blockNumber', []);
  assert.equal(BigInt(verifiedBlock as string), await client.getBlockNumber({ cacheTime: 0 }));
  const startBlock = BigInt(receipts.find(value => value.action === 'Deploy NFT factory')!.blockNumber);
  const anchor = await client.getBlock({ blockNumber: startBlock - 1n });
  const manifest = parseManifest({ schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', mode: 'local', chainId: 31337,
    genesisHash: genesis.hash, startBlock: startBlock.toString(), anchorHash: anchor.hash,
    factory: { address: factory, codeHash: keccak256((await client.getCode({ address: factory }))!) },
    marketplace: { address: market, codeHash: keccak256((await client.getCode({ address: market }))!) } });
  const source = new VerifiedRpcSource(verifiedRpc);
  const indexer = new MemoryIndexerStore();
  const initialIndex = await syncIndexer(source, indexer, manifest);
  assert(initialIndex.caughtUp);
  const collectionId = collection.toLowerCase(), itemKey = `${collectionId}:2`;
  const firstIndex = await indexer.snapshot();
  assert.equal(firstIndex.projection.collections[collectionId].totalMinted, '2');
  assert.equal(firstIndex.projection.collections[collectionId].opened, true);
  assert.equal(firstIndex.projection.items[`${collectionId}:1`].owner, buyer.toLowerCase());
  assert.equal(firstIndex.projection.listings[String(listingId)].status, 'sold');
  assert.equal(Object.keys(firstIndex.projection.claims).length, 5);
  assert.equal((await syncIndexer(source, indexer, manifest)).processed, 0);
  assert.deepEqual(await indexer.snapshot(), firstIndex, 'Replay must not duplicate activity or receipts');
  await receipt('External NFT transfer', await wallet.writeContract({ account: minter, address: collection, abi: collectionArtifact.abi, functionName: 'transferFrom', args: [minter, buyer, 2n] }));
  await syncIndexer(source, indexer, manifest);
  assert.equal((await indexer.snapshot()).projection.items[itemKey].owner, buyer.toLowerCase());
  const snapshotId = await rpc<string>('evm_snapshot');
  const orphan = await receipt('Transfer on subsequently orphaned branch', await wallet.writeContract({ account: buyer, address: collection, abi: collectionArtifact.abi, functionName: 'transferFrom', args: [buyer, creator, 2n] }));
  await syncIndexer(source, indexer, manifest);
  assert.equal((await indexer.snapshot()).projection.items[itemKey].owner, creator.toLowerCase());
  assert.equal(await rpc<boolean>('evm_revert', [snapshotId]), true);
  await receipt('Replacement canonical NFT transfer', await wallet.writeContract({ account: buyer, address: collection, abi: collectionArtifact.abi, functionName: 'transferFrom', args: [buyer, treasury, 2n] }));
  const forkIndex = await syncIndexer(source, indexer, manifest);
  assert.equal(forkIndex.rolledBack, 1);
  const afterFork = await indexer.snapshot();
  assert.equal(afterFork.projection.items[itemKey].owner, treasury.toLowerCase());
  assert(!afterFork.blocks.some(value => value.block.hash === orphan.blockHash));
  assert(!Object.values(afterFork.projection.activity).some(value => value.transactionHash === orphan.transactionHash));
  await receipt('Approve cancellation resale', await wallet.writeContract({ account: treasury, address: collection, abi: collectionArtifact.abi, functionName: 'approve', args: [market, 2n] }));
  await receipt('List cancellation resale', await wallet.writeContract({ account: treasury, address: market, abi: marketArtifact.abi, functionName: 'list', args: [collection, 2n, resalePrice] }));
  await receipt('Cancel resale to another recipient', await wallet.writeContract({ account: treasury, address: market, abi: marketArtifact.abi, functionName: 'cancelTo', args: [2n, minter] }));
  await syncIndexer(source, indexer, manifest);
  const indexed = await indexer.snapshot();
  assert.equal(indexed.projection.listings['2'].status, 'cancelled');
  assert.equal(indexed.projection.items[itemKey].owner, minter.toLowerCase());
  for (const value of receipts) value.canonicalAtEnd = (await client.getBlock({ blockNumber: BigInt(value.blockNumber) })).hash === value.blockHash;
  const indexerEvidence = { manifest: manifestJson(manifest), processedInitialBlocks: initialIndex.processed,
    canonicalBlocks: indexed.blocks.length, rawLogs: indexed.blocks.reduce((total, value) => total + value.logs.length, 0),
    activity: Object.keys(indexed.projection.activity).length, reorgRolledBack: forkIndex.rolledBack,
    orphanBlockHash: orphan.blockHash, collections: indexed.projection.collections, items: indexed.projection.items,
    listings: indexed.projection.listings, claims: indexed.projection.claims,
    store: 'In-memory reference; hosted PostgreSQL verification is separate', finality: 'Not asserted' };
  await indexer.close();
  const result = { network: 'Ephemeral local Anvil; not Zero', chainId: 31337, genesisHash: genesis.hash, nativeSymbol: 'ETH', nativeDecimals: 18, rpcVerification: { ...verifiedRpc.verification, latestBlock: verifiedRpc.verification.latestBlock.toString() }, contracts: { factory, market, collection, foundationFactory, foundation, token }, assertions: ['RPC identity verified against local chain; read identity rechecked', 'registered collection', 'irreversible terms', 'paid mint and ownership', 'primary fee conservation', 'escrow resale and royalty conservation', 'stale purchase rejection', 'pull claims fully reconciled', 'local-only fixed supply allocation; no market', 'canonical NFT logs and exact projections', 'idempotent index replay', 'external ERC721 ownership transfer', 'orphaned block rollback and replacement replay', 'escrow cancellation ownership'], indexer: indexerEvidence, receipts };
  await mkdir(path.join(root, '.local', 'oneshot'), { recursive: true });
  await writeFile(path.join(root, '.local', 'oneshot', 'smoke-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', network: result.network, transactions: receipts.length,
    canonicalTransactions: receipts.filter(value => value.canonicalAtEnd).length,
    indexedLogs: indexerEvidence.rawLogs, reorgRolledBack: indexerEvidence.reorgRolledBack,
    assertions: result.assertions, evidence: '.local/oneshot/smoke-result.json' }, null, 2));
} finally {
  if (child.exitCode === null) child.kill();
  await new Promise<void>(resolve => { if (child.exitCode !== null || childError) resolve(); else { child.once('exit', () => resolve()); setTimeout(resolve, 2000).unref(); } });
}
