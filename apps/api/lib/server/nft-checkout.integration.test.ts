import { randomInt, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { createPublicClient, createWalletClient, decodeFunctionData, http, keccak256, type Abi, type Address, type Hex } from 'viem';
import { anvil } from 'viem/chains';
import { describe, expect, it, vi } from 'vitest';
import { createVerifiedRpc, networkConfig, NFT_COLLECTION_ABI, prepareNftTerms } from '@oneshot/evm';
import { createNftLaunchService, type NftReviewInput } from './nft-launch';
import { createNftLaunchRepository } from './nft-launch-store';
import { archiveOneshotDraft, createOneshotDraft, getOneshotDraft, prepareOneshotDraft } from './oneshot-drafts';
import { storeImage } from './media';
import type { OneshotSession } from './oneshot-auth';
import { createIndexedNftReader } from './indexed-nfts';
import { manifestId, parseManifest } from '../../../indexer/src/manifest';
import { VerifiedRpcSource } from '../../../indexer/src/rpc-source';
import { PostgresIndexerStore } from '../../../indexer/src/store';
import { syncIndexer } from '../../../indexer/src/engine';
import { createNftLaunchController, sendReviewedEvmTransaction } from '../../../web/lib/client-nft-launch';

// Fixture identity and DNS responses are explicit. Contracts, RPC calls, uploaded
// bytes, review persistence and indexed reads are real; no hosted service is used.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }));
const enabled = process.env.ONESHOT_RUN_NFT_LAUNCH_INTEGRATION === 'true';
const databaseUrl = process.env.ONESHOT_INDEXER_TEST_DATABASE_URL;
const root = path.resolve('.');
const testRoot = path.join(root, '.local', 'nft-checkout-integration-tests');
type Artifact = { abi: Abi; bytecode: { object: Hex } };

describe.skipIf(!enabled)('actual public NFT checkout and persistent recovery', () => {
  it('trades across unrelated users, restores reviews after restart and reverses orphaned confirmations', async () => {
    if (!databaseUrl) throw new Error('Set the dedicated ONESHOT_INDEXER_TEST_DATABASE_URL. This suite never selects an ambient DATABASE_URL.');
    const database = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
      || !database.pathname.endsWith('_test') || database.search || database.hash) throw new Error('A dedicated loopback PostgreSQL test database is required.');
    const contractRoot = path.join(root, 'contracts-evm');
    const forge = process.env.ONESHOT_FORGE_BIN || (process.platform === 'win32' ? 'forge.exe' : 'forge');
    const anvilBin = process.env.ONESHOT_ANVIL_BIN || (process.platform === 'win32' ? 'anvil.exe' : 'anvil');
    const build = spawnSync(forge, ['build', '--root', contractRoot], { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (build.status !== 0) throw new Error(`Local contract build failed: ${build.error?.message || build.stderr || build.stdout}`);
    await mkdir(testRoot, { recursive: true });
    const directory = await mkdtemp(path.join(testRoot, 'case-'));
    let child: ChildProcess | undefined; let pool: Pool | undefined; let store: PostgresIndexerStore | undefined;
    let ownedManifestId: string | undefined; let ownedDeploymentId: string | undefined;
    const ownedUsers: string[] = [];
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('S3_BUCKET', '');
    vi.stubEnv('ONESHOT_DATA_DIR', directory); vi.stubEnv('ONESHOT_MEDIA_QUOTA_BYTES', '10485760');
    try {
      const listener = createServer();
      await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
      const port = (listener.address() as { port: number }).port;
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      const rpcUrl = `http://127.0.0.1:${port}`;
      child = spawn(anvilBin, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--timestamp', String(Math.floor(Date.now() / 1000) + randomInt(1, 86_400)), '--silent'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let childError: string | null = null; let stderr = ''; let requestId = 0;
      child.once('error', error => { childError = error.message; });
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); }); child.stdout?.on('data', () => {});
      async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
        const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }), signal: AbortSignal.timeout(2500) });
        const body = await response.json();
        if (!response.ok || body.error) throw new Error(`${method}: ${body.error?.message || response.status}`);
        return body.result as T;
      }
      let chainReady = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (childError || child.exitCode !== null) throw new Error(`Disposable Anvil stopped: ${childError || stderr}`);
        try { chainReady = await rpc('eth_chainId') === '0x7a69'; if (chainReady) break; } catch { /* Only this newly spawned process is retried. */ }
        await pause(100);
      }
      if (!chainReady) throw new Error('Disposable Anvil did not become ready.');
      const accounts = (await rpc<Address[]>('eth_accounts')).map(value => value.toLowerCase() as Address);
      const [creator, minter, buyer, treasury, intruder] = accounts;
      expect(accounts.length).toBeGreaterThanOrEqual(5);
      const client = createPublicClient({ chain: anvil, transport: http(rpcUrl, { retryCount: 0, timeout: 5000 }) });
      const wallet = createWalletClient({ chain: anvil, transport: http(rpcUrl, { retryCount: 0, timeout: 5000 }) });
      const artifact = async (name: string): Promise<Artifact> => JSON.parse(await readFile(path.join(contractRoot, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
      const deploy = async (name: string, args: readonly unknown[]) => {
        const data = await artifact(name);
        const receipt = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ account: creator, abi: data.abi, bytecode: data.bytecode.object, args }), timeout: 5000 });
        expect(receipt.status).toBe('success'); expect(receipt.contractAddress).toBeTruthy();
        return { address: receipt.contractAddress!.toLowerCase() as Address, block: receipt.blockNumber };
      };
      const factory = await deploy('OneshotNFTFactory', [treasury]); const market = await deploy('OneshotMarketplace', [factory.address]);
      const manifest = parseManifest({ schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', mode: 'local', chainId: 31337,
        genesisHash: (await client.getBlock({ blockNumber: 0n })).hash, startBlock: factory.block.toString(), anchorHash: (await client.getBlock({ blockNumber: factory.block - 1n })).hash,
        factory: { address: factory.address, codeHash: keccak256((await client.getCode({ address: factory.address }))!) },
        marketplace: { address: market.address, codeHash: keccak256((await client.getCode({ address: market.address }))!) } });
      const deploymentId = manifestId(manifest);
      ownedDeploymentId = deploymentId;
      const env = { ONESHOT_LOCAL_NFT_EXECUTION_ENABLED: 'true', ONESHOT_NETWORK: 'local', ONESHOT_RPC_URL: rpcUrl,
        ONESHOT_INDEXER_MANIFEST_PATH: 'injected-disposable-manifest.json', ONESHOT_INDEXER_READS_ENABLED: 'true', DATABASE_URL: databaseUrl };
      pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000 });
      await pool.query(await readFile(path.join(root, 'db', 'schema.sql'), 'utf8'));
      const repository = () => createNftLaunchRepository({ database: () => pool! });
      let wallClock = Date.now();
      const newService = () => createNftLaunchService({ environment: () => env, loadManifest: async () => manifest, repository: repository(), now: () => wallClock });
      let service = newService();
      const verifiedRpc = await createVerifiedRpc(networkConfig(env)); const source = new VerifiedRpcSource(verifiedRpc);
      expect(await service.status()).toMatchObject({ enabled: true, deploymentId });
      function identity(address: Address): OneshotSession {
        const userId = `did:privy:public-checkout-${randomUUID()}`; ownedUsers.push(userId);
        return { provider: 'privy', userId, sessionId: randomUUID(), expiresAt: Math.floor(wallClock / 1000) + 3600, linkedAddresses: [address] };
      }
      const creatorSession = identity(creator), minterSession = identity(minter), buyerSession = identity(buyer), treasurySession = identity(treasury), intruderSession = identity(intruder);
      const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 87, g: 230, b: 193, alpha: 1 } } }).png().toBuffer();
      const uploaded = await storeImage(png, creatorSession.userId, 'https://art.oneshot.app');
      const firstStage = (await client.getBlock()).timestamp + 300n, publicStage = firstStage + 300n;
      const iso = (seconds: bigint) => new Date(Number(seconds * 1000n)).toISOString();
      const draftInput = { name: 'Public local originals', symbol: 'OPEN', description: 'Unrelated users transact without access to creator drafts.',
        maxSupply: 8, royaltyBps: 500, publicPrice: '0.002345678901234567', allowlistPrice: '0.001234567890123456', perWalletLimit: 3,
        allowlistStart: iso(firstStage), allowlistEnd: iso(publicStage), publicStart: iso(publicStage), publicEnd: iso(publicStage + 3600n), allowlistAddresses: [minter, treasury],
        creatorWallet: creator, metadataMode: 'upload' as const, imageUrl: `/api/media/${uploaded.hash}.webp` };
      const draft = await prepareOneshotDraft((await createOneshotDraft(draftInput, creatorSession)).id, 1, creatorSession, 'https://art.oneshot.app');
      await expect(getOneshotDraft(draft.id, minterSession)).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
      let collection: Address | undefined;
      let sends = 0;
      const submit = async (review: Awaited<ReturnType<typeof service.review>>, session: OneshotSession) => {
        const fresh = await service.validate(review.id, review.reviewHash, session);
        expect(fresh.data).toBe(review.data); expect(fresh.value).toBe(review.value); expect(fresh.reviewHash).toBe(review.reviewHash);
        const scope = JSON.stringify([session.userId, review.from, 31337]);
        const before = sends;
        const hash = await sendReviewedEvmTransaction({ transaction: { from: fresh.from, to: fresh.to, data: fresh.data, value: fresh.value,
          chainId: 31337, expectedIdentityScope: scope, expiresAt: fresh.expiresAt }, identityScope: () => scope, now: () => wallClock,
          getProvider: async () => ({ request: async input => { if (input.method === 'eth_sendTransaction') sends += 1; return rpc(input.method, input.params); } }) }) as Hex;
        expect(sends).toBe(before + 1);
        const retained = await service.submitted(review.id, review.reviewHash, hash, session);
        expect(retained).toMatchObject({ transactionHash: hash, outcome: 'submitted', review: { id: review.id, data: review.data, value: review.value } });
        return hash;
      };
      async function act(session: OneshotSession, action: NftReviewInput['action'], fields: Partial<NftReviewInput> = {}) {
        const creatorAction = ['create', 'configure', 'open'].includes(action);
        const review = await service.review({ from: session.linkedAddresses[0], action, localEthAcknowledged: true,
          ...(creatorAction ? { draftId: draft.id, expectedRevision: draft.revision } : {}), ...(action === 'create' ? {} : { collection }), ...fields }, session);
        const hash = await submit(review, session);
        const receipt = await service.receipt(review.id, hash, session);
        expect(receipt).toMatchObject({ status: 'confirmed', hash });
        if (receipt.status !== 'confirmed') throw new Error(`${action} did not confirm.`);
        return { review, hash, receipt };
      }
      const created = await act(creatorSession, 'create'); collection = created.receipt.collection as Address;
      expect(collection).toMatch(/^0x[\da-f]{40}$/); await act(creatorSession, 'configure'); await act(creatorSession, 'open');
      const otherDraft = await prepareOneshotDraft((await createOneshotDraft({ ...draftInput, name: 'Other local originals', symbol: 'OTHER' }, creatorSession)).id, 1, creatorSession, 'https://art.oneshot.app');
      const otherCreated = await act(creatorSession, 'create', { draftId: otherDraft.id, expectedRevision: otherDraft.revision });
      const otherCollection = otherCreated.receipt.collection as Address;
      await act(creatorSession, 'configure', { draftId: otherDraft.id, expectedRevision: otherDraft.revision, collection: otherCollection });
      await act(creatorSession, 'open', { draftId: otherDraft.id, expectedRevision: otherDraft.revision, collection: otherCollection });
      // Checkout relies on the immutable opening publication, even after the
      // creator archives the private account draft used to prepare that launch.
      expect(await archiveOneshotDraft(draft.id,draft.revision,creatorSession)).toMatchObject({archived:true});
      await expect(getOneshotDraft(draft.id,creatorSession)).rejects.toMatchObject({code:'DRAFT_NOT_FOUND'});
      await expect(getOneshotDraft(draft.id,minterSession)).rejects.toMatchObject({code:'DRAFT_NOT_FOUND'});
      const publicInfo = await service.collection(collection);
      expect(publicInfo).toMatchObject({ collection, creator, name: draft.name, symbol: 'OPEN', opened: true, deploymentId,
        terms: { maxSupplyRaw: '8', royaltyBps: 500, publicMint: { priceRaw: '2345678901234567' } } });
      for (const secret of [draft.id, creatorSession.userId, minter, treasury]) expect(JSON.stringify(publicInfo)).not.toContain(secret);
      expect(JSON.stringify(publicInfo)).not.toContain('allowlistAddresses');
      await rpc('evm_setNextBlockTimestamp', [Number(firstStage)]); await rpc('evm_mine');
      await expect(service.review({ from: buyer, collection, action: 'mint', quantity: '1', localEthAcknowledged: true }, buyerSession)).rejects.toMatchObject({ code: 'NOT_ALLOWLISTED' });
      await expect(service.review({ from: minter, collection, action: 'mint', quantity: '1', localEthAcknowledged: true }, buyerSession)).rejects.toMatchObject({ code: 'WALLET_NOT_LINKED' });
      const allowMint = await act(minterSession, 'mint', { quantity: '2' });
      expect(allowMint.review).toMatchObject({ scope: 'public', draftId: collection, revision: 0, value: '2469135780246912' });
      const call = decodeFunctionData({ abi: NFT_COLLECTION_ABI, data: allowMint.review.data });
      expect(call.functionName).toBe('mint');
      const plan = prepareNftTerms(draft, { chainId: 31337, nativeDecimals: 18, collection, nowSeconds: 0n });
      expect(call.args?.[3]).toEqual(plan.allowlist.proofs[minter]); expect(plan.allowlist.proofs[minter]).toHaveLength(1);
      // Reusing this exact wallet proof at another opened collection must revert.
      await expect(rpc('eth_call', [{ from: minter, to: otherCollection, data: allowMint.review.data, value: `0x${BigInt(allowMint.review.value).toString(16)}` }, 'latest'])).rejects.toThrow();
      await rpc('evm_setNextBlockTimestamp', [Number(publicStage)]); await rpc('evm_mine');
      await act(buyerSession, 'mint', { quantity: '1' });
      await act(minterSession, 'approve', { tokenId: '1' }); await act(minterSession, 'list', { tokenId: '1', price: '0.019876543210987654' });

      // Persist the broadcast before requesting a receipt, then discard all service
      // instances and pools. The next request must recover from PostgreSQL alone.
      const buyReview = await service.review({ from: buyer, collection, action: 'buy', listingId: '1', localEthAcknowledged: true }, buyerSession);
      const boughtHash = await submit(buyReview, buyerSession);
      const beforeRecovery = sends;
      await pool.end();
      pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000 });
      service = newService();
      wallClock += 120_001; // Receipt recovery remains available after signing expiry.
      const renewedBuyer = { ...buyerSession, sessionId: randomUUID() };
      const recovered = await service.recover(buyReview.id, renewedBuyer);
      expect(recovered).toMatchObject({ transactionHash: boughtHash, outcome: 'submitted', review: { id: buyReview.id, data: buyReview.data, value: buyReview.value } });
      expect((await service.transactions(renewedBuyer, { wallet: buyer, limit: 50 })).items.some(item => item.review.id === buyReview.id)).toBe(true);
      expect((await service.transactions(intruderSession, { limit: 50 })).items).toEqual([]);
      await expect(service.recover(buyReview.id, intruderSession)).rejects.toMatchObject({ status: 404 });
      await expect(service.validate(buyReview.id, buyReview.reviewHash, renewedBuyer)).rejects.toMatchObject({ status: 404 });
      const validateAgain = vi.fn((input: {reviewId:string;reviewHash:string}) => service.validate(input.reviewId,input.reviewHash,renewedBuyer));
      const sendAgain = vi.fn(async () => { throw new Error('Recovery must never request another wallet transaction.'); });
      const recoveryController = createNftLaunchController({ context: () => ({scope:'public',draftId:collection!,revision:0,prepared:true,
        userId:renewedBuyer.userId,identityScope:JSON.stringify([renewedBuyer.userId,buyer,31337]),address:buyer,chainId:31337,deploymentId}),
        api: {status:service.status,review:input=>service.review(input,renewedBuyer),validate:validateAgain,
          receipt:input=>service.receipt(input.reviewId,input.hash as Hex,renewedBuyer),submitted:input=>service.submitted(input.reviewId,input.reviewHash,input.hash as Hex,renewedBuyer)},
        sendEvmTransaction:sendAgain,now:()=>wallClock,pause:()=>pause(50),receiptAttempts:1});
      await recoveryController.recover(recovered);
      expect(recoveryController.getSnapshot()).toMatchObject({phase:'success',hash:boughtHash,receipt:{status:'confirmed'}});
      expect(validateAgain).not.toHaveBeenCalled(); expect(sendAgain).not.toHaveBeenCalled();
      expect(sends).toBe(beforeRecovery);
      expect(await service.recover(buyReview.id, renewedBuyer)).toMatchObject({ outcome: 'confirmed', transactionHash: boughtHash });

      const expired = await service.review({ from: minter, collection, action: 'approve', tokenId: '2', localEthAcknowledged: true }, minterSession);
      wallClock += 120_001;
      service = newService();
      await expect(service.validate(expired.id, expired.reviewHash, minterSession)).rejects.toMatchObject({ code: 'REVIEW_EXPIRED' });
      expect(sends).toBe(beforeRecovery);
      await act(minterSession, 'approve', { tokenId: '2' }); await act(minterSession, 'list', { tokenId: '2', price: '0.01' }); await act(minterSession, 'cancel', { listingId: '2' });
      await act(minterSession, 'claim'); await act(creatorSession, 'claim'); await act(treasurySession, 'claim');
      await act(creatorSession, 'claim', { contract: collection }); await act(treasurySession, 'claim', { contract: collection });

      store = new PostgresIndexerStore({ connect: () => pool!.connect() }); await store.initialize(deploymentId); ownedManifestId = deploymentId;
      const synchronize = async () => { expect((await syncIndexer(source, store!, manifest)).caughtUp).toBe(true); };
      const reader = createIndexedNftReader({ env: () => env, pool: () => pool!, loadManifest: async () => manifest, source: async () => source });
      const read = async (suffix: string) => { const response = await reader(new NextRequest(`http://localhost/api/oneshot/indexed${suffix}`)); expect(response.status).toBe(200); return response.json(); };
      await synchronize();
      expect((await read(`/collections/${collection}/items/1`)).item).toMatchObject({ owner: buyer, listing: null });
      expect((await read(`/collections/${collection}/items/2`)).item).toMatchObject({ owner: minter, listing: null });
      expect((await read('/listings?status=sold')).items).toEqual([expect.objectContaining({id:'1',seller:minter,buyer,totalPriceRaw:'19876543210987654'})]);
      expect((await read('/listings?status=cancelled')).items).toEqual([expect.objectContaining({id:'2',seller:minter,status:'cancelled'})]);
      expect((await read(`/wallets/${buyer}/items`)).items).toHaveLength(2);
      const activity = (await read(`/activity?collection=${collection}&limit=50`)).items;
      for (const event of ['CollectionCreated', 'TermsConfigured', 'CollectionOpened', 'Minted', 'Approval', 'Listed', 'Sold', 'Cancelled', 'Claimed']) expect(activity.some((entry: { eventName: string }) => entry.eventName === event)).toBe(true);
      expect((await read(`/wallets/${minter}/claims`)).items).toHaveLength(1);

      const snapshot = await rpc<string>('evm_snapshot');
      await act(buyerSession, 'approve', { tokenId: '1' }); const orphan = await act(buyerSession, 'list', { tokenId: '1', price: '0.03' });
      await synchronize(); expect((await read('/listings?status=active')).items).toHaveLength(1);
      expect(await rpc('evm_revert', [snapshot])).toBe(true);
      service = newService();
      expect(await service.receipt(orphan.review.id, orphan.hash, renewedBuyer)).toMatchObject({ status: 'pending', hash: orphan.hash });
      expect(await service.recover(orphan.review.id, renewedBuyer)).toMatchObject({ outcome: 'submitted', transactionHash: orphan.hash });
      await expect(reader(new NextRequest(`http://localhost/api/oneshot/indexed/collections/${collection}/items/1`))).rejects.toMatchObject({ code: 'INDEXER_CHAIN_MOVED' });
      await synchronize();
      expect((await read(`/collections/${collection}/items/1`)).item).toMatchObject({ owner: buyer, listing: null });
      expect((await read('/listings?status=active')).items).toEqual([]);
    } finally {
      try {
        if (pool) {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            if (ownedManifestId) {
              await client.query("SELECT pg_advisory_xact_lock(hashtext('oneshot_evm_indexer'), hashtext($1))", [ownedManifestId]);
              for (const table of ['oneshot_evm_logs', 'oneshot_evm_journal', 'oneshot_evm_projections', 'oneshot_evm_deployments']) await client.query(`DELETE FROM ${table} WHERE manifest_id=$1`, [ownedManifestId]);
            }
            if (ownedUsers.length) await client.query("DELETE FROM b20_app_records WHERE namespace='oneshot_nft_reviews' AND value->>'owner'=ANY($1::text[])", [ownedUsers]);
            // Publication cleanup is scoped to the new disposable manifest, even if
            // execution failed before the indexer's first transaction.
            if (ownedDeploymentId) await client.query("DELETE FROM b20_app_records WHERE namespace IN ('oneshot_nft_publications','oneshot_nft_launches') AND value->>'deploymentId'=$1", [ownedDeploymentId]);
            await client.query('COMMIT');
          } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
        }
      } finally {
        try { await store?.close(); } finally {
          try { await pool?.end(); } finally {
            if (child && child.exitCode === null && child.signalCode === null) {
              const exited = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill(); await Promise.race([exited, pause(2000)]);
            }
            vi.unstubAllEnvs();
            const target = path.resolve(directory);
            if (!target.startsWith(testRoot + path.sep)) throw new Error('Unsafe integration cleanup path.');
            await rm(target, { recursive: true, force: true });
          }
        }
      }
    }
  }, 90_000);
});
