import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { createPublicClient, createWalletClient, http, keccak256, type Abi, type Address, type Hex } from 'viem';
import { anvil } from 'viem/chains';
import { describe, expect, it, vi } from 'vitest';
import { createVerifiedRpc, networkConfig, NFT_COLLECTION_ABI } from '@oneshot/evm';
import { createNftLaunchService } from './nft-launch';
import { archiveOneshotDraft, createOneshotDraft, getOneshotDraft, prepareOneshotDraft, readOneshotMetadata } from './oneshot-drafts';
import { readMedia, storeImage } from './media';
import type { OneshotSession } from './oneshot-auth';
import { createIndexedNftReader } from './indexed-nfts';
import { manifestId, parseManifest } from '../../../indexer/src/manifest';
import { VerifiedRpcSource } from '../../../indexer/src/rpc-source';
import { PostgresIndexerStore } from '../../../indexer/src/store';
import { syncIndexer } from '../../../indexer/src/engine';
import { createNftLaunchController, sendReviewedEvmTransaction, type NftLaunchContext, type NftLaunchRequest } from '../../../web/lib/client-nft-launch';

// The DNS fixture only allows preparing our locally uploaded image under an HTTPS
// publication origin. No remote art, metadata fetch, Privy login or real user is used.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }));
const enabled = process.env.ONESHOT_RUN_NFT_LAUNCH_INTEGRATION === 'true';
const databaseUrl = process.env.ONESHOT_INDEXER_TEST_DATABASE_URL;
const root = path.resolve('.');
const testRoot = path.join(root, '.local', 'nft-launch-integration-tests');
type Artifact = { abi: Abi; bytecode: { object: Hex } };

describe.skipIf(!enabled)('actual local NFT launch through controller, contracts, PostgreSQL and indexed reads', () => {
  it('binds public art to a canonical opening through mint, resale, archival and real fork removal', async () => {
    if (!databaseUrl) throw new Error('Set ONESHOT_INDEXER_TEST_DATABASE_URL to a dedicated local test database. This suite never selects an ambient DATABASE_URL.');
    const database = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) || !database.pathname.endsWith('_test')) throw new Error('A dedicated loopback PostgreSQL database ending in _test is required.');
    const forge = process.env.ONESHOT_FORGE_BIN || (process.platform === 'win32' ? 'forge.exe' : 'forge');
    const anvilBin = process.env.ONESHOT_ANVIL_BIN || (process.platform === 'win32' ? 'anvil.exe' : 'anvil');
    const contractRoot = path.join(root, 'contracts-evm');
    const build = spawnSync(forge, ['build', '--root', contractRoot], { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (build.status !== 0) throw new Error(`Build local contracts before running this test: ${build.error?.message || build.stderr || build.stdout}`);
    await mkdir(testRoot, { recursive: true });
    const directory = await mkdtemp(path.join(testRoot, 'case-'));
    let child: ChildProcess | undefined; let pool: Pool | undefined; let store: PostgresIndexerStore | undefined;
    let ownedManifestId: string | undefined;
    let ownedUserId: string | undefined, ownedSnapshotId: string | undefined, schemaReady = false;
    const previousGlobalPool = globalThis.b20Pool;
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_URL', databaseUrl); vi.stubEnv('S3_BUCKET', '');
    vi.stubEnv('ONESHOT_DATA_DIR', directory); vi.stubEnv('ONESHOT_MEDIA_QUOTA_BYTES', '10485760');
    try {
      // Public presentation resolves snapshot/media records through the indexed
      // reader's held SQL client. Prepare those real records in the same database;
      // only sanitized object bytes use the isolated local-file storage fixture.
      pool = new Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000 });
      await pool.query(await readFile(path.join(root, 'db', 'schema.sql'), 'utf8'));
      schemaReady = true;
      globalThis.b20Pool = pool;
      const listener = createServer();
      await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
      const port = (listener.address() as { port: number }).port;
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      const rpcUrl = `http://127.0.0.1:${port}`;
      // A unique genesis timestamp keeps cleanup independent from other fixtures.
      child = spawn(anvilBin, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--timestamp', String(Math.floor(Date.now() / 1000) + randomInt(1, 86_400)), '--silent'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let childError: string | null = null; let stderr = '';
      child.once('error', error => { childError = error.message; }); child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); }); child.stdout?.on('data', () => {});
      let requestId = 0;
      async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
        const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }), signal: AbortSignal.timeout(2500) });
        const body = await response.json();
        if (!response.ok || body.error) throw new Error(`${method}: ${body.error?.message || response.status}`);
        return body.result as T;
      }
      let chainReady = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (childError || child.exitCode !== null) throw new Error(`Disposable Anvil stopped: ${childError || stderr}`);
        try { chainReady = await rpc('eth_chainId') === '0x7a69'; if (chainReady) break; } catch { /* Wait only for this newly spawned process. */ }
        await pause(100);
      }
      if (!chainReady) throw new Error('Disposable Anvil did not become ready.');
      const accounts = (await rpc<Address[]>('eth_accounts')).map(value => value.toLowerCase() as Address);
      const [creator, minter, buyer, treasury] = accounts;
      expect(accounts.length).toBeGreaterThanOrEqual(4);
      const client = createPublicClient({ chain: anvil, transport: http(rpcUrl, { retryCount: 0, timeout: 5000 }) });
      const wallet = createWalletClient({ chain: anvil, transport: http(rpcUrl, { retryCount: 0, timeout: 5000 }) });
      const artifact = async (name: string): Promise<Artifact> => JSON.parse(await readFile(path.join(contractRoot, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
      const deploy = async (name: string, args: readonly unknown[]) => {
        const data = await artifact(name);
        const result = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ account: creator, abi: data.abi, bytecode: data.bytecode.object, args }), timeout: 5000 });
        expect(result.status).toBe('success'); expect(result.contractAddress).toBeTruthy();
        return { address: result.contractAddress!.toLowerCase() as Address, block: result.blockNumber };
      };
      const factory = await deploy('OneshotNFTFactory', [treasury]); const market = await deploy('OneshotMarketplace', [factory.address]);
      const manifest = parseManifest({ schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', mode: 'local', chainId: 31337,
        genesisHash: (await client.getBlock({ blockNumber: 0n })).hash, startBlock: factory.block.toString(), anchorHash: (await client.getBlock({ blockNumber: factory.block - 1n })).hash,
        factory: { address: factory.address, codeHash: keccak256((await client.getCode({ address: factory.address }))!) },
        marketplace: { address: market.address, codeHash: keccak256((await client.getCode({ address: market.address }))!) } });
      const deploymentId = manifestId(manifest);
      const env = { ONESHOT_LOCAL_NFT_EXECUTION_ENABLED: 'true', ONESHOT_NETWORK: 'local', ONESHOT_RPC_URL: rpcUrl, ONESHOT_INDEXER_MANIFEST_PATH: 'injected-disposable-manifest.json', ONESHOT_INDEXER_READS_ENABLED: 'true', DATABASE_URL: databaseUrl };
      let service = createNftLaunchService({ environment: () => env, loadManifest: async () => manifest });
      const verifiedRpc = await createVerifiedRpc(networkConfig(env)); const source = new VerifiedRpcSource(verifiedRpc);
      expect(await service.status()).toMatchObject({ enabled: true, deploymentId, network: { chainId: 31337, nativeSymbol: 'ETH', nativeDecimals: 18 } });

      // Explicit fixture authentication: exercises ownership and linked-wallet checks,
      // and makes no claim to verify a production Privy access token.
      const session: OneshotSession = { provider: 'privy', userId: `did:privy:local-test-${randomUUID()}`, sessionId: randomUUID(), expiresAt: Math.floor(Date.now() / 1000) + 3600, linkedAddresses: [creator, minter, buyer, treasury] };
      ownedUserId = session.userId;
      const fixtureContentId = randomUUID();
      const png = await sharp(randomBytes(8 * 8 * 3), { raw: { width: 8, height: 8, channels: 3 } }).png().toBuffer();
      const uploaded = await storeImage(png, session.userId, 'https://art.oneshot.app');
      const firstStage = (await client.getBlock()).timestamp + 300n; const publicStage = firstStage + 300n;
      const iso = (seconds: bigint) => new Date(Number(seconds * 1000n)).toISOString();
      const imagePath = `/api/media/${uploaded.hash}.webp`;
      const metadataItems = Array.from({ length: 6 }, (_, index) => ({ name: `Committed original ${index + 1}`,
        description: `Public art ${index + 1} from frozen snapshot ${fixtureContentId}.`, image: imagePath,
        attributes: [{ trait_type: 'Edition', value: index + 1 }, { trait_type: 'Palette', value: 'Mint' }] }));
      const initial = await createOneshotDraft({ name: 'Actual local originals', symbol: 'LOCAL', description: 'Uploaded, frozen and executed on a disposable chain.', maxSupply: 6, royaltyBps: 500, publicPrice: '0.002345678901234567', allowlistPrice: '0.001234567890123456', perWalletLimit: 3,
        allowlistStart: iso(firstStage), allowlistEnd: iso(publicStage), publicStart: iso(publicStage), publicEnd: iso(publicStage + 3600n), allowlistAddresses: [minter], creatorWallet: creator, metadataMode: 'upload', manifest: { items: metadataItems } }, session);
      const draft = await prepareOneshotDraft(initial.id, initial.revision, session, 'https://art.oneshot.app');
      ownedSnapshotId = draft.snapshot?.manifestHash;
      expect(draft).toMatchObject({ status: 'prepared', revision: 2, snapshot: { itemCount: 6 } });
      const presentation = (tokenId: number) => ({ manifestHash: draft.snapshot!.manifestHash, tokenId: String(tokenId),
        name: metadataItems[tokenId - 1].name, description: metadataItems[tokenId - 1].description, imagePath,
        metadataPath: `/api/oneshot/metadata/${draft.snapshot!.manifestHash}/${tokenId}`, attributes: metadataItems[tokenId - 1].attributes });
      const assertPublicContent = (response: unknown) => {
        const serialized = JSON.stringify(response);
        expect(serialized).not.toMatch(/ownerUserId|creatorUserId|allowlistAddresses|allowlistRoot|publicationDraft|floorRaw|floorEnabled|policyCommitment|sessionId|reviewId/);
        for (const privateValue of [session.userId, session.sessionId, draft.id]) expect(serialized).not.toContain(privateValue);
      };
      let context: NftLaunchContext = { identityScope: JSON.stringify([session.userId, creator, 31337]), address: creator, chainId: 31337, draftId: draft.id, revision: draft.revision, prepared: true, deploymentId };
      const walletRequests: { method: string; params?: unknown[] }[] = [];
      const controller = createNftLaunchController({ context: () => context,
        api: { status: service.status, review: input => service.review(input, session), validate: input => service.validate(input.reviewId, input.reviewHash, session), receipt: input => service.receipt(input.reviewId, input.hash as Hex, session) },
        sendEvmTransaction: transaction => sendReviewedEvmTransaction({ transaction, identityScope: () => context.identityScope,
          getProvider: async () => ({ request: async input => { walletRequests.push(input); return rpc(input.method, input.params); } }) }),
        pause: () => pause(50), receiptAttempts: 3,
      });
      let collection: string | undefined;
      async function act(action: NftLaunchRequest['action'], from: Address, fields: Partial<NftLaunchRequest> = {}) {
        context = { ...context, address: from, identityScope: JSON.stringify([session.userId, from, 31337]) }; controller.syncContext();
        const before = walletRequests.filter(item => item.method === 'eth_sendTransaction').length;
        await controller.prepare({ draftId: draft.id, expectedRevision: draft.revision, from, action, localEthAcknowledged: true, ...(action === 'create' ? {} : { collection }), ...fields });
        expect(controller.getSnapshot(), `${action} must produce a simulated review`).toMatchObject({ phase: 'review' });
        const reviewed = controller.getSnapshot().review!;
        expect(walletRequests.filter(item => item.method === 'eth_sendTransaction')).toHaveLength(before);
        // This explicit call represents the separate Approve in wallet user action.
        await controller.approve();
        const result = controller.getSnapshot();
        expect(result, `${action} must confirm an exact canonical receipt`).toMatchObject({ phase: 'success', receipt: { status: 'confirmed' } });
        const sent = walletRequests.filter(item => item.method === 'eth_sendTransaction').at(-1)!;
        expect(sent.params).toEqual([{ from: reviewed.from, to: reviewed.to, data: reviewed.data, value: `0x${BigInt(reviewed.value).toString(16)}`, chainId: '0x7a69' }]);
        expect(walletRequests.filter(item => item.method === 'eth_sendTransaction')).toHaveLength(before + 1);
        return { review: reviewed, hash: result.hash! as Hex, receipt: result.receipt! };
      }
      const created = await act('create', creator); collection = created.receipt.collection!;
      expect(collection).toMatch(/^0x[\da-f]{40}$/);
      const progressQuery = { expectedRevision: draft.revision, from: creator, launchId: created.review.id };
      const sendsBeforeResume = walletRequests.filter(item => item.method === 'eth_sendTransaction').length;
      // Reopening the account on a new API instance and SQL pool must recover
      // its exact collection association without asking the wallet to resend.
      await pool.end();
      pool = new Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000 });
      globalThis.b20Pool = pool;
      service = createNftLaunchService({ environment: () => env, loadManifest: async () => manifest });
      const resumed = await service.progress(draft.id, progressQuery, session);
      expect(resumed).toMatchObject({ draftId: draft.id, revision: draft.revision, deploymentId, from: creator,
        items: [{ id: created.review.id, collection, createHash: created.hash }],
        selected: { id: created.review.id, collection, phase: 'created', nextAction: 'configure', termsMatch: false } });
      expect(walletRequests.filter(item => item.method === 'eth_sendTransaction')).toHaveLength(sendsBeforeResume);
      await act('configure', creator);
      expect((await service.progress(draft.id, progressQuery, session)).selected).toMatchObject({ collection, phase: 'configured', nextAction: 'open', termsMatch: true });
      // Retain the configured-but-unopened branch, so the final reorganization
      // removes the metadata admission event as well as all subsequent mints.
      const beforeOpening = await rpc<string>('evm_snapshot');
      await act('open', creator);
      expect((await service.progress(draft.id, progressQuery, session)).selected).toMatchObject({ collection, phase: 'opened', nextAction: null, termsMatch: true });
      await rpc('evm_setNextBlockTimestamp', [Number(firstStage)]); await rpc('evm_mine');
      await expect(service.review({ draftId: draft.id, expectedRevision: draft.revision, from: buyer, collection, action: 'mint', quantity: '1', localEthAcknowledged: true }, session)).rejects.toMatchObject({ code: 'NOT_ALLOWLISTED' });
      const allowMint = await act('mint', minter, { quantity: '2' });
      expect(allowMint.review.summary).toMatchObject({ stage: 'allowlist', totalPriceRaw: '2469135780246912' });
      expect(allowMint.review.data.length).toBeGreaterThan(10); // Includes the actual address/chain-bound proof.
      await rpc('evm_setNextBlockTimestamp', [Number(publicStage)]); await rpc('evm_mine');
      const publicMint = await act('mint', buyer, { quantity: '1' }); expect(publicMint.review.summary.stage).toBe('public');
      const primaryTotal = 2_469_135_780_246_912n + 2_345_678_901_234_567n;
      const readCollection = (functionName: string, args: readonly unknown[] = []) => client.readContract({ address: collection as Address, abi: NFT_COLLECTION_ABI as Abi, functionName, args });
      expect(await readCollection('totalMinted')).toBe(3n); expect(String(await readCollection('ownerOf', [1n])).toLowerCase()).toBe(minter);
      expect(await readCollection('allowlistMinted', [minter])).toBe(2n); expect(await readCollection('publicMinted', [buyer])).toBe(1n);
      expect(await readCollection('tokenURI', [1n])).toBe(`${draft.snapshot!.baseUri}1`);

      // Claim only this unique manifest, and never clear another fixture's rows.
      const existing = await pool.query("SELECT to_regclass('oneshot_evm_deployments') AS table_name");
      if (existing.rows[0].table_name) expect((await pool.query('SELECT 1 FROM oneshot_evm_deployments WHERE manifest_id=$1', [deploymentId])).rowCount).toBe(0);
      store = new PostgresIndexerStore({ connect: () => pool!.connect() }); await store.initialize(deploymentId); ownedManifestId = deploymentId;
      const synchronize = async () => { expect((await syncIndexer(source, store!, manifest)).caughtUp).toBe(true); };
      const reader = createIndexedNftReader({ env: () => env, pool: () => pool!, loadManifest: async () => manifest, source: async () => source });
      const read = async (suffix: string) => { const response = await reader(new NextRequest(`http://localhost/api/oneshot/indexed${suffix}`)); expect(response.status).toBe(200); return response.json(); };
      await synchronize();
      const discovered = await read('/collections');
      const collectionDetail = await read(`/collections/${collection}`);
      const itemList = await read(`/collections/${collection}/items`);
      const itemDetail = await read(`/collections/${collection}/items/2`);
      const walletItems = await read(`/wallets/${minter}/items`);
      // Collection artwork is a sample from the first committed ITEM; the
      // separately stored collection JSON has a different name/description.
      expect(collectionDetail.collection).toMatchObject({ name: draft.name, opened: true, contentHash: draft.snapshot!.contentHash });
      expect(collectionDetail.collection.presentation).toEqual(presentation(1));
      expect(discovered.items.find((item: { address: string }) => item.address === collection).presentation).toEqual(presentation(1));
      expect(itemList.items.map((item: { presentation: unknown }) => item.presentation)).toEqual([presentation(1), presentation(2), presentation(3)]);
      expect(itemDetail.item.presentation).toEqual(presentation(2));
      expect(walletItems.items.map((item: { presentation: unknown }) => item.presentation)).toEqual([presentation(1), presentation(2)]);
      for (const response of [discovered, collectionDetail, itemList, itemDetail, walletItems]) assertPublicContent(response);
      const committedMetadata = await readOneshotMetadata(draft.snapshot!.manifestHash, '2');
      expect(JSON.parse(committedMetadata.buffer.toString('utf8'))).toEqual({ ...metadataItems[1], image: `https://art.oneshot.app${imagePath}` });
      const committedArt = await readMedia(`${uploaded.hash}.webp`);
      expect(committedArt.mimeType).toBe('image/webp');
      expect(createHash('sha256').update(committedArt.buffer).digest('hex')).toBe(uploaded.hash);
      expect(await sharp(committedArt.buffer).metadata()).toMatchObject({ format: 'webp', width: 8, height: 8 });
      await act('approve', minter, { tokenId: '1' }); const listed = await act('list', minter, { tokenId: '1', price: '0.019876543210987654' });
      await synchronize();
      const escrow = await read(`/collections/${collection}/items/1`); expect(escrow.item).toMatchObject({ owner: market.address, listing: { id: '1', status: 'active' } });
      expect((await read(`/wallets/${minter}/items`)).items.map((item: { tokenId: string }) => item.tokenId)).toEqual(['2']);
      expect(listed.review.summary.priceRaw).toBe('19876543210987654');
      await act('buy', buyer, { listingId: '1' });
      await act('approve', minter, { tokenId: '2' }); await act('list', minter, { tokenId: '2', price: '0.01' }); await act('cancel', minter, { listingId: '2' });
      const resale = 19_876_543_210_987_654n, fee = resale * 200n / 10_000n, royalty = resale * 500n / 10_000n, sellerProceeds = resale - fee - royalty;
      await synchronize();
      const sold = (await read('/listings?status=sold')).items;
      expect(sold).toEqual([expect.objectContaining({ id: '1', seller: minter, buyer, totalPriceRaw: resale.toString(), platformFeeRaw: fee.toString(), royaltyRaw: royalty.toString(), sellerProceedsRaw: sellerProceeds.toString() })]);
      expect((await read('/listings?status=cancelled')).items).toEqual([expect.objectContaining({ id: '2', status: 'cancelled' })]);
      expect((await read(`/collections/${collection}`)).collection).toMatchObject({ totalMinted: '3', primaryTotalPriceRaw: primaryTotal.toString() });
      const sellerEarnings = await service.earnings({ from: minter }, session);
      expect(sellerEarnings).toMatchObject({ wallet: minter, deploymentId, marketplace: { contract: market.address, amountRaw: sellerProceeds.toString() }, scannedCount: 1, totalCollectionsRaw: '1', nextCursor: null });
      expect(sellerEarnings.collections).toEqual([expect.objectContaining({ contract: collection, amountRaw: '0' })]);
      const creatorEarnings = await service.earnings({ from: creator }, session);
      const treasuryEarnings = await service.earnings({ from: treasury }, session);
      expect(creatorEarnings.marketplace.amountRaw).toBe(royalty.toString());
      expect(treasuryEarnings.marketplace.amountRaw).toBe(fee.toString());
      expect(creatorEarnings.collections[0].amountRaw).toBe(String(await readCollection('pending', [creator])));
      expect(treasuryEarnings.collections[0].amountRaw).toBe(String(await readCollection('pending', [treasury])));
      expect(BigInt(treasuryEarnings.collections[0].amountRaw)).toBeGreaterThan(0n);
      // The aggregate resale claim needs no unrelated collection or creator draft.
      const claimContext: NftLaunchContext = { identityScope: JSON.stringify([session.userId, minter, 31337]), address: minter, chainId: 31337, draftId: market.address, revision: 0, prepared: true, deploymentId, scope: 'public', userId: session.userId };
      const directClaim = createNftLaunchController({ context: () => claimContext,
        api: { status: service.status, review: input => service.review(input, session), validate: input => service.validate(input.reviewId, input.reviewHash, session), receipt: input => service.receipt(input.reviewId, input.hash as Hex, session) },
        sendEvmTransaction: transaction => sendReviewedEvmTransaction({ transaction, identityScope: () => claimContext.identityScope, getProvider: async () => ({ request: async input => { walletRequests.push(input); return rpc(input.method, input.params); } }) }), pause: () => pause(50), receiptAttempts: 3 });
      await directClaim.prepare({ action: 'claim', from: minter, contract: market.address, localEthAcknowledged: true });
      expect(directClaim.getSnapshot()).toMatchObject({ phase: 'review', review: { draftId: market.address, scope: 'public', summary: { claimAmountRaw: sellerProceeds.toString() } } });
      await directClaim.approve(); expect(directClaim.getSnapshot()).toMatchObject({ phase: 'success', receipt: { status: 'confirmed' } });
      expect((await service.earnings({ from: minter }, session)).marketplace.amountRaw).toBe('0');
      await act('claim', creator); await act('claim', treasury);
      await act('claim', creator, { contract: collection }); await act('claim', treasury, { contract: collection });
      await expect(service.review({ draftId: draft.id, expectedRevision: draft.revision, from: minter, collection, action: 'claim', localEthAcknowledged: true }, session)).rejects.toMatchObject({ code: 'NOTHING_TO_CLAIM' });
      await synchronize();
      expect((await read(`/wallets/${minter}/claims`)).items).toEqual([expect.objectContaining({ contract: market.address, beneficiary: minter, totalClaimedRaw: sellerProceeds.toString() })]);
      expect((await read(`/wallets/${creator}/claims`)).items).toHaveLength(2);
      const activity = (await read(`/activity?collection=${collection}&limit=50`)).items;
      for (const event of ['CollectionCreated', 'TermsConfigured', 'CollectionOpened', 'Minted', 'Approval', 'Listed', 'Sold', 'Cancelled', 'Claimed']) expect(activity.some((entry: { eventName: string }) => entry.eventName === event)).toBe(true);

      // A real fork removal must never keep a previously confirmed success visible.
      const snapshot = await rpc<string>('evm_snapshot');
      await act('approve', buyer, { tokenId: '1' }); const orphan = await act('list', buyer, { tokenId: '1', price: '0.03' });
      await synchronize(); expect((await read('/listings?status=active')).items).toHaveLength(1);
      expect(await rpc('evm_revert', [snapshot])).toBe(true);
      expect(await service.receipt(orphan.review.id, orphan.hash, session)).toMatchObject({ status: 'pending' });
      await expect(reader(new NextRequest(`http://localhost/api/oneshot/indexed/collections/${collection}/items/1`))).rejects.toMatchObject({ code: 'INDEXER_CHAIN_MOVED' });
      await synchronize();
      expect((await read(`/collections/${collection}/items/1`)).item).toMatchObject({ owner: buyer, listing: null });
      expect((await read('/listings?status=active')).items).toEqual([]);

      const renewedSession = { ...session, sessionId: randomUUID() };
      expect((await service.progress(draft.id, progressQuery, renewedSession)).selected).toMatchObject({ collection, phase: 'opened', nextAction: null });
      await expect(service.progress(draft.id, progressQuery, { ...renewedSession, userId: `did:privy:foreign-${randomUUID()}` })).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });

      // The valid snapshot bytes remain in storage, but an orphaned opening must
      // not admit them into public browsing on the surviving unopened branch.
      expect(await rpc('evm_revert', [beforeOpening])).toBe(true);
      await expect(reader(new NextRequest(`http://localhost/api/oneshot/indexed/collections/${collection}`))).rejects.toMatchObject({ code: 'INDEXER_CHAIN_MOVED' });
      await synchronize();
      const reopenedHistory = await read(`/collections/${collection}`);
      expect(reopenedHistory.collection).toMatchObject({ configured: true, opened: false, totalMinted: '0', contentHash: null, presentation: null });
      expect((await read('/collections')).items.find((item: { address: string }) => item.address === collection).presentation).toBeNull();
      expect((await read(`/collections/${collection}/items`)).items).toEqual([]);
      expect((await read(`/wallets/${minter}/items`)).items).toEqual([]);
      await expect(reader(new NextRequest(`http://localhost/api/oneshot/indexed/collections/${collection}/items/2`))).rejects.toMatchObject({ code: 'INDEXED_RECORD_NOT_FOUND' });
      assertPublicContent(reopenedHistory);
      expect((await service.progress(draft.id, progressQuery, renewedSession)).selected).toMatchObject({ collection, phase: 'configured', nextAction: 'open', termsMatch: true });

      // Continue only through fresh explicit reviews after the fork reversal.
      // This restores a canonical opening for the independent archival check.
      await act('open', creator);
      await rpc('evm_setNextBlockTimestamp', [Number(firstStage)]); await rpc('evm_mine');
      await act('mint', minter, { quantity: '2' });
      await synchronize();
      expect((await service.progress(draft.id, progressQuery, renewedSession)).selected).toMatchObject({ collection, phase: 'opened', nextAction: null });
      // Private account lifecycle never removes content admitted by the frozen
      // canonical collection. Public reads below have no authenticated session.
      expect(await archiveOneshotDraft(draft.id, draft.revision, session)).toEqual({ id: draft.id, archived: true });
      await expect(getOneshotDraft(draft.id, session)).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
      await expect(service.progress(draft.id, progressQuery, renewedSession)).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
      expect((await read(`/collections/${collection}`)).collection.presentation).toEqual(presentation(1));
      expect((await read(`/collections/${collection}/items/2`)).item.presentation).toEqual(presentation(2));
      expect((await readOneshotMetadata(draft.snapshot!.manifestHash, '2')).buffer).toEqual(committedMetadata.buffer);
      expect((await readMedia(`${uploaded.hash}.webp`)).buffer).toEqual(committedArt.buffer);
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
            if (schemaReady && ownedUserId) {
              await client.query("DELETE FROM b20_app_records WHERE namespace='oneshot_drafts' AND value->>'ownerUserId'=$1", [ownedUserId]);
              await client.query("DELETE FROM b20_app_records WHERE namespace='oneshot_nft_reviews' AND value->>'owner'=$1", [ownedUserId]);
              await client.query("DELETE FROM b20_app_records WHERE namespace='oneshot_nft_launches' AND value->>'owner'=$1", [ownedUserId]);
              await client.query("DELETE FROM b20_app_records WHERE namespace='oneshot_nft_publications' AND value->>'creatorUserId'=$1", [ownedUserId]);
              await client.query("DELETE FROM b20_app_records WHERE namespace='media' AND value->>'owner'=$1", [ownedUserId]);
              if (ownedSnapshotId) await client.query("DELETE FROM b20_app_records WHERE namespace='oneshot_snapshots' AND id=$1", [ownedSnapshotId]);
            }
            await client.query('COMMIT');
          } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
        }
      } finally {
        try { await store?.close(); } finally {
          try { await pool?.end(); } finally {
            globalThis.b20Pool = previousGlobalPool;
            if (child && child.exitCode === null && child.signalCode === null) {
              const exited = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill(); await Promise.race([exited, pause(2000)]);
            }
            vi.unstubAllEnvs();
            const target = path.resolve(directory);
            if (!target.startsWith(testRoot + path.sep)) throw new Error('Unsafe integration test cleanup path.');
            await rm(target, { recursive: true, force: true });
          }
        }
      }
    }
  }, 60_000);
});
