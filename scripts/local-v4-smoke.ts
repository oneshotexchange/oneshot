import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, decodeEventLog, encodeDeployData, encodeEventTopics, http, keccak256, type Abi, type Address, type Hex } from 'viem';
import { anvil } from 'viem/chains';
import { createVerifiedRpc, networkConfig, MARKET_TOKEN_ABI, TOKEN_MARKET_ABI, TOKEN_MARKET_FACTORY_ABI, TOKEN_MARKET_QUOTER_ABI } from '@oneshot/evm';
import { parseTokenManifest, tokenManifestJson } from '../apps/indexer/src/token-manifest';
import { VerifiedTokenSource } from '../apps/indexer/src/token-source';
import { VerifiedTokenEventSource } from '../apps/indexer/src/token-event-source';
import { normalizeTokenRegistration, TOKEN_POOL_EVENTS } from '../apps/indexer/src/token-event-projector';
import type { VerifiedTokenRegistration } from '../apps/indexer/src/token-event-types';
import { mineObservationHook } from './lib/base-sepolia-plan';
import { runLocalTokenApiRehearsal } from './lib/token-api-rehearsal';
import { collectTokenEventBlock, collectTokenEventRange, type TokenTransactionEvidence } from './lib/token-event-evidence';

// Owned disposable chain only. No configured RPC, signing key, Base account or
// application deployment manifest is read. Unlocked Anvil accounts stay local.
const root = fileURLToPath(new URL('../', import.meta.url));
const forge = process.env.ONESHOT_FORGE_BIN ?? (process.platform === 'win32' ? 'forge.exe' : 'forge');
const anvilBin = process.env.ONESHOT_ANVIL_BIN ?? (process.platform === 'win32' ? 'anvil.exe' : 'anvil');
for (const [tool, name] of [[forge, 'forge'], [anvilBin, 'anvil']]) {
  const version = spawnSync(tool, ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (version.status !== 0 || !version.stdout.includes(`${name} Version: 1.7.1`)) throw new Error('FOUNDRY_1_7_1_REQUIRED');
}
for (const profile of ['v4_core', 'default']) {
  const build = spawnSync(forge, ['build', '--root', path.join(root, 'contracts-evm')], { cwd: root, env: { ...process.env, FOUNDRY_PROFILE: profile }, encoding: 'utf8', windowsHide: true });
  if (build.status !== 0) throw new Error('CONTRACT_BUILD_FAILED');
}
const listener = createServer();
await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
const port = (listener.address() as { port: number }).port;
await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
const url = `http://127.0.0.1:${port}`;
const child = spawn(anvilBin, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--hardfork', 'cancun', '--silent'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
let processError: Error | undefined; child.once('error', error => { processError = error; });
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
  const body = await response.json() as { result?: T; error?: unknown };
  if (!response.ok || body.error || !Object.hasOwn(body, 'result')) throw new Error('LOCAL_RPC_FAILED');
  return body.result as T;
}
type Artifact = { abi: Abi; bytecode: { object: Hex } };
const artifact = async (name: string, source = name, output = 'out'): Promise<Artifact> => JSON.parse(await readFile(path.join(root, 'contracts-evm', output, `${source}.sol`, `${name}.json`), 'utf8'));
const receipts: { action: string; hash: Hex; blockNumber: string; blockHash: Hex; gasUsed: string; canonicalAtEnd?: boolean }[] = [];
let report: Record<string, unknown> | undefined;
let output: string | undefined;
function checkSharedAbi(expected: Abi, actual: Abi) {
  const parameter = (value: { type: string; components?: readonly { type: string }[] }): string => value.type.startsWith('tuple') ? `(${value.components?.map(parameter).join(',')})${value.type.slice(5)}` : value.type;
  const signature = (item: Abi[number]): string => {
    if (item.type === 'function' || item.type === 'event' || item.type === 'error') return `${item.type}:${item.name}(${item.inputs.map(parameter).join(',')})${item.type === 'function' ? `:${item.outputs.map(parameter).join(',')}:${item.stateMutability}` : item.type === 'event' ? `:${item.inputs.map(value => Boolean(value.indexed)).join(',')}` : ''}`;
    if (item.type === 'constructor') return `constructor(${item.inputs.map(parameter).join(',')})`;
    return item.type;
  };
  const signatures = new Set(actual.map(signature));
  for (const item of expected) assert(signatures.has(signature(item)), `Shared token ABI must match compiled contract: ${signature(item)}`);
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (processError || child.exitCode !== null) throw new Error('LOCAL_ANVIL_UNAVAILABLE');
    try { ready = await rpc<string>('eth_chainId') === '0x7a69'; if (ready) break; } catch { /* Await this owned process only. */ }
    await pause(100);
  }
  assert(ready, 'Owned local Anvil must start');
  const [creator, trader, platform] = await rpc<Address[]>('eth_accounts'); assert(creator && trader && platform);
  const client = createPublicClient({ chain: anvil, transport: http(url, { retryCount: 0, timeout: 5000 }) });
  const wallet = createWalletClient({ chain: anvil, transport: http(url, { retryCount: 0, timeout: 5000 }) });
  const coreArtifact = await artifact('PoolManager', 'PoolManager', 'core-out');
  const oracleDeployerArtifact = await artifact('OneshotV4OracleDeployer', 'OneshotV4Oracle');
  const oracleArtifact = await artifact('OneshotV4Oracle');
  const factoryArtifact = await artifact('OneshotV4MarketFactory', 'OneshotV4Market');
  const marketArtifact = await artifact('OneshotV4Market');
  const tokenArtifact = await artifact('OneshotMarketToken');
  const quoterArtifact = await artifact('OneshotV4Quoter');
  checkSharedAbi(TOKEN_MARKET_FACTORY_ABI, factoryArtifact.abi); checkSharedAbi(TOKEN_MARKET_ABI, marketArtifact.abi);
  checkSharedAbi(MARKET_TOKEN_ABI, tokenArtifact.abi); checkSharedAbi(TOKEN_MARKET_QUOTER_ABI, quoterArtifact.abi);
  async function receipt(action: string, hash: Hex) {
    const result = await client.waitForTransactionReceipt({ hash });
    if (result.status !== 'success') {
      const transaction = await client.getTransaction({ hash });
      const trace = await rpc<{ failed: boolean; gas: number; returnValue: string }>('debug_traceTransaction', [hash, { disableMemory: true, disableStorage: true, disableStack: true }]);
      console.error(JSON.stringify({ action, localFailure: { gasUsed: result.gasUsed.toString(), gasLimit: transaction.gas.toString(), returnValue: trace.returnValue, failed: trace.failed } }));
    }
    assert.equal(result.status, 'success', action);
    receipts.push({ action, hash, blockNumber: result.blockNumber.toString(), blockHash: result.blockHash, gasUsed: result.gasUsed.toString() }); return result;
  }
  async function deploy(action: string, data: Artifact, args: readonly unknown[]) {
    const result = await receipt(action, await wallet.deployContract({ account: creator, abi: data.abi, bytecode: data.bytecode.object, args }));
    assert(result.contractAddress); return result.contractAddress;
  }
  const poolManager = await deploy('Deploy untouched canonical v4 core 1.0.2', coreArtifact, [creator]);
  const oracleDeployer = await deploy('Deploy observation hook deployer', oracleDeployerArtifact, []);
  const hook = mineObservationHook(oracleDeployer, keccak256(encodeDeployData({ abi: oracleArtifact.abi, bytecode: oracleArtifact.bytecode.object, args: [poolManager] })));
  await receipt('Deploy observation-only hook', await wallet.writeContract({ account: creator, address: oracleDeployer, abi: oracleDeployerArtifact.abi, functionName: 'deploy', args: [poolManager, hook.salt] }));
  const oracle = hook.address; assert(await client.getCode({ address: oracle }));
  const factory = await deploy('Deploy token market factory', factoryArtifact, [poolManager, oracle, platform, 10_000_000_000_000_000n]);
  const quoter = await deploy('Deploy exact-input quoter', quoterArtifact, [factory]);
  const created = await receipt('Launch fixed-supply token-only locked position', await wallet.writeContract({ account: creator, address: factory, abi: factoryArtifact.abi, functionName: 'createMarket', args: ['Local v4 token', 'V4TEST', 300, true, 1000n * 10n ** 18n] }));
  const event = created.logs.map(log => { try { return decodeEventLog({ abi: factoryArtifact.abi, data: log.data, topics: log.topics }); } catch { return null; } }).find(value => value?.eventName === 'MarketCreated');
  assert(event); const args = event.args as unknown as { market: Address; token: Address; creator: Address; poolId: Hex };
  const { market, token, poolId } = args;
  const read = (functionName: string, args: readonly unknown[] = []) => client.readContract({ address: market, abi: marketArtifact.abi, functionName, args });
  const tokenRead = (functionName: string, args: readonly unknown[] = []) => client.readContract({ address: token, abi: tokenArtifact.abi, functionName, args });
  const supply = 1_000_000_000n * 10n ** 8n;
  const initialLiquidity = await read('lockedLiquidity') as bigint;
  assert.equal(await tokenRead('totalSupply'), supply); assert.equal(await tokenRead('decimals'), 8);
  assert.equal(await read('isMarketLaunch'), true); assert.equal(await tokenRead('balanceOf', [creator]), 0n);
  assert.equal(await client.getBalance({ address: market }), 0n);
  const quote = async (buy: boolean, amount: bigint) => (await client.simulateContract({ account: trader, address: quoter, abi: quoterArtifact.abi, functionName: 'quoteSwap', args: [market, buy, amount, 0n] })).result as bigint;
  const buyQuote = await quote(true, 970_000_000_000_000_000n);
  let block = await client.getBlock();
  await receipt('Buy with inclusive three percent execution fee', await wallet.writeContract({ account: trader, address: market, abi: marketArtifact.abi, functionName: 'buy', args: [buyQuote, trader, block.timestamp + 60n, 0n], value: 10n ** 18n }));
  assert.equal(await tokenRead('balanceOf', [trader]), buyQuote);
  assert.equal(await read('pending', [platform]), 6_000_000_000_000_000n);
  assert.equal(await read('pendingLiquidityNative'), 18_000_000_000_000_000n);
  assert.equal(await read('pendingBurnNative'), 6_000_000_000_000_000n);
  const sellAmount = buyQuote / 2n; const gross = await quote(false, sellAmount); const sellFee = gross * 300n / 10_000n;
  await receipt('Approve exact token sell amount', await wallet.writeContract({ account: trader, address: token, abi: tokenArtifact.abi, functionName: 'approve', args: [market, sellAmount] }));
  block = await client.getBlock();
  const sell = await client.simulateContract({ account: trader, address: market, abi: marketArtifact.abi, functionName: 'sell', args: [sellAmount, gross - sellFee, trader, block.timestamp + 60n, 0n] });
  assert.equal(sell.result, gross - sellFee);
  await receipt('Sell with actual gross-native fee calculation', await wallet.writeContract({ ...sell.request, gas: 1_000_000n }));
  assert.equal(await tokenRead('allowance', [trader, market]), 0n);
  assert.equal(await tokenRead('balanceOf', [trader]), buyQuote - sellAmount);
  await receipt('Collect both LP fee currencies without principal removal', await wallet.writeContract({ account: trader, address: market, abi: marketArtifact.abi, functionName: 'collectFees' }));
  assert((await read('pendingLpToken') as bigint) > 0n && (await read('pendingLpNative') as bigint) > 0n);
  const tokenFeesBeforeProcessing = await read('pendingLpToken') as bigint;
  block = await client.getBlock();
  await assert.rejects(() => client.simulateContract({ account: trader, address: market, abi: marketArtifact.abi, functionName: 'process', args: [10n ** 18n, supply, block.timestamp + 60n] }));
  await rpc('evm_increaseTime', [301]); await rpc('evm_mine'); block = await client.getBlock();
  await receipt('Process guarded LP conversion, reinvestment and holder burn', await wallet.writeContract({ account: trader, address: market, abi: marketArtifact.abi, functionName: 'process', args: [10n ** 18n, supply, block.timestamp + 60n], gas: 2_000_000n }));
  assert((await read('lockedLiquidity') as bigint) > initialLiquidity);
  assert((await tokenRead('totalSupply') as bigint) < supply);
  // The conversion itself earns fresh LP token fees. The following positive
  // liquidity addition collects them into a new pending cycle, without another
  // execution fee or silently treating those assets as principal/dust.
  assert((await read('pendingLpToken') as bigint) < tokenFeesBeforeProcessing);
  assert.equal(await read('pendingBurnNative'), 0n);
  assert.equal(await read('pending', [creator]), 0n);
  await receipt('Claim platform revenue', await wallet.writeContract({ account: platform, address: market, abi: marketArtifact.abi, functionName: 'claimTo', args: [platform] }));
  assert.equal(await read('totalPending'), 0n);
  const liability = (await read('pendingLpNative') as bigint) + (await read('pendingLiquidityNative') as bigint) + (await read('pendingBurnNative') as bigint);
  assert((await client.getBalance({ address: market })) >= liability);
  const genesis = await client.getBlock({ blockNumber: 0n });
  const startBlock = BigInt(receipts.find(value => value.action === 'Deploy token market factory')!.blockNumber);
  const anchor = await client.getBlock({ blockNumber: startBlock - 1n });
  const entry = async (address: Address) => { const code = await client.getCode({ address }); assert(code && code !== '0x'); return { address, codeHash: keccak256(code) }; };
  const manifest = parseTokenManifest({ schemaVersion: 1, deploymentVersion: 'oneshot-v4-market-v1', mode: 'local', chainId: 31337, genesisHash: genesis.hash, startBlock: startBlock.toString(), anchorHash: anchor.hash, factory: await entry(factory), poolManager: await entry(poolManager), oracle: await entry(oracle), quoter: await entry(quoter) });
  const apiRehearsal = await runLocalTokenApiRehearsal({ rpcUrl: url, manifest, market, trader, platform, creator });
  await receipt('Direct holder transfer', await wallet.writeContract({ account: trader, address: token, abi: tokenArtifact.abi, functionName: 'transfer', args: [creator, 100_000_000n] }));
  await receipt('Holder self transfer', await wallet.writeContract({ account: creator, address: token, abi: tokenArtifact.abi, functionName: 'transfer', args: [creator, 100_000_000n] }));
  await receipt('Direct holder true burn', await wallet.writeContract({ account: creator, address: token, abi: tokenArtifact.abi, functionName: 'burn', args: [40_000_000n] }));
  const verified = await createVerifiedRpc(networkConfig({ ONESHOT_NETWORK: 'local', ONESHOT_RPC_URL: url }));
  const source = new VerifiedTokenSource(verified);
  const discovered = await source.snapshot(manifest, 25);
  assert.equal(discovered.markets.length, 2);
  const eventAddresses = [factory, poolManager, ...discovered.markets.flatMap(value => [value.market, value.token])] as Address[];
  const snapshotId = await rpc<string>('evm_snapshot');
  const commonAncestor = await client.getBlock();
  const orphanReceipt = await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: trader, address: market, abi: marketArtifact.abi, functionName: 'buy', args: [1n, trader, commonAncestor.timestamp + 60n, 0n], value: 20_000_000_000_000_000n, gas: 1_000_000n }) });
  assert.equal(orphanReceipt.status, 'success');
  const transactionEvidence: TokenTransactionEvidence = {};
  const orphanBlock = await collectTokenEventBlock(rpc, orphanReceipt.blockNumber, eventAddresses, transactionEvidence);
  assert.equal(await rpc<boolean>('evm_revert', [snapshotId]), true);
  await rpc('evm_setNextBlockTimestamp', [Number(commonAncestor.timestamp + 2n)]);
  const replacementReceipt = await receipt('Canonical replacement buy after orphan rollback', await wallet.writeContract({ account: trader, address: market, abi: marketArtifact.abi, functionName: 'buy', args: [1n, trader, commonAncestor.timestamp + 60n, 0n], value: 30_000_000_000_000_000n, gas: 1_000_000n }));
  assert.equal(replacementReceipt.blockNumber, orphanReceipt.blockNumber);
  assert.notEqual(replacementReceipt.blockHash, orphanReceipt.blockHash);
  const blocks = await collectTokenEventRange(rpc, manifest.startBlock, replacementReceipt.blockNumber, eventAddresses, transactionEvidence);
  const replacementBlock = blocks[blocks.length - 1]!;
  assert.equal(replacementBlock.hash, replacementReceipt.blockHash);
  // Exercise the production read adapter against real local JSON-RPC selectors
  // and filters; compare it with the independent, broader raw event export.
  const eventSource = new VerifiedTokenEventSource(verified);
  const canonicalBlock = (value: typeof blocks[number]) => ({ number: BigInt(value.number), hash: value.hash, parentHash: value.parentHash, timestamp: BigInt(value.timestamp) });
  const target = canonicalBlock(replacementBlock); await eventSource.verify(manifest, target);
  const marketAddresses = new Set(discovered.markets.flatMap(value => [value.market, value.token]));
  const pools = new Set(discovered.markets.map(value => value.poolId));
  const poolTopics = new Set(TOKEN_POOL_EVENTS.map(value => encodeEventTopics({ abi: [value], eventName: value.name })[0]));
  const factoryTopic = encodeEventTopics({ abi: TOKEN_MARKET_FACTORY_ABI, eventName: 'MarketCreated' })[0];
  const expectedRegistrations = new Map(discovered.markets.map(value => [value.market, normalizeTokenRegistration(value)]));
  const known: VerifiedTokenRegistration[] = [];
  const verifiedEventCapture: { number: string; hash: Hex; logs: number; registrations: Address[]; reads: number }[] = [];
  for (const selected of blocks) {
    const captured = await eventSource.capture(manifest, canonicalBlock(selected), known, target);
    const relevant = selected.logs.filter(log => marketAddresses.has(log.address)
      || log.address === manifest.factory.address && log.topics[0] === factoryTopic
      || log.address === manifest.poolManager.address && poolTopics.has(log.topics[0]) && pools.has(log.topics[1]));
    const expectedLogs = relevant.map(({ removed: _removed, ...log }) => ({ ...log, blockNumber: BigInt(log.blockNumber) }));
    assert.deepEqual(captured.logs, expectedLogs, `Verified event capture must match raw journal block ${selected.number}`);
    for (const registration of captured.registrations) assert.deepEqual(registration, expectedRegistrations.get(registration.market));
    known.push(...captured.registrations);
    verifiedEventCapture.push({ number: selected.number, hash: selected.hash, logs: captured.logs.length, registrations: captured.registrations.map(value => value.market), reads: captured.reads });
  }
  assert.equal(known.length, discovered.markets.length);
  const eventJournal = { schemaVersion: 1, manifest: tokenManifestJson(manifest), registrations: discovered.markets, blocks,
    orphanBranch: [orphanBlock], replacementBranch: [replacementBlock], commonAncestor: { number: commonAncestor.number.toString(), hash: commonAncestor.hash }, transactionEvidence };
  for (const item of receipts) item.canonicalAtEnd = (await client.getBlock({ blockNumber: BigInt(item.blockNumber) })).hash === item.blockHash;
  assert(receipts.every(value => value.canonicalAtEnd));
  const directory = path.join(root, '.local', 'qa'); await mkdir(directory, { recursive: true });
  output = path.join(directory, `local-v4-smoke-${randomUUID()}.json`);
  const assertions = ['Untouched canonical v4 core, compiler 0.8.26, local chain 31337', '1B eight-decimal token-only principal launch', 'Exact quote equals inclusive buy and sell execution', 'Twenty/eighty and optional seventy-five/twenty-five fees', 'Approval fully consumed', 'Both LP fee currencies collected without principal removal', 'Maintenance unavailable without 300-second oracle history', 'Permissionless bounded conversion and positive liquidity addition', 'True holder burn reduces total supply', 'Platform claim liabilities reconcile', 'Canonical local receipt and immutable runtime-hash evidence'];
  assertions.push('Production verified event source exactly matches independently captured canonical logs and registrations');
  report = { schemaVersion: 1, status: 'passed', scope: 'ephemeral-loopback-v4', chainId: 31337, nativeSymbol: 'ETH', contracts: { poolManager, oracleDeployer, oracle, factory, quoter, market, token, poolId }, manifest: tokenManifestJson(manifest), assertions, receipts, apiRehearsal, eventJournal, verifiedEventCapture, limitations: ['Ephemeral local chain only; all addresses cease to be a running deployment after this runner stops.', 'No Base RPC identity, public deployment, wallet session or hosted storage is verified.', 'This local runtime hash evidence cannot enable Base Sepolia.'] };
} finally {
  if (child.exitCode === null) child.kill();
  await new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || processError) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('OWNED_ANVIL_CLEANUP_FAILED')), 3000); timer.unref();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
if (report && output) {
  await writeFile(output, JSON.stringify({ ...report, stoppedAfterRun: true }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'passed', scope: 'ephemeral-loopback-v4', chainId: 31337, transactions: receipts.length, assertions: report.assertions, evidence: path.relative(root, output) }));
}
