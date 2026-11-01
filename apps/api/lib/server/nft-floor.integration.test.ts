import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { createPublicClient, createWalletClient, decodeFunctionData, encodeFunctionData, http, keccak256, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { describe, expect, it, vi } from 'vitest';
import { createVerifiedRpc, networkConfig, GUARDED_MARKETPLACE_ABI, NFT_COLLECTION_ABI, NFT_MARKETPLACE_ABI } from '@oneshot/evm';
import { createNftLaunchService, type NftReviewInput } from './nft-launch';
import { createNftLaunchRepository } from './nft-launch-store';
import { createOneshotDraft, prepareOneshotDraft } from './oneshot-drafts';
import { storeImage } from './media';
import type { OneshotSession } from './oneshot-auth';
import { createIndexedNftReader } from './indexed-nfts';
import { manifestId, parseManifest } from '../../../indexer/src/manifest';
import { VerifiedRpcSource } from '../../../indexer/src/rpc-source';
import { PostgresIndexerStore } from '../../../indexer/src/store';
import { syncIndexer } from '../../../indexer/src/engine';
import { sendReviewedEvmTransaction } from '../../../web/lib/client-nft-launch';

// DNS is a fixture only for the uploaded metadata origin. All contract calls,
// permits, review records, policy persistence and indexed reads are real.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }));
const enabled = process.env.ONESHOT_RUN_NFT_LAUNCH_INTEGRATION === 'true';
const databaseUrl = process.env.ONESHOT_INDEXER_TEST_DATABASE_URL;
const root = path.resolve('.');
const testRoot = path.join(root, '.local', 'nft-floor-integration-tests');
type Artifact = { abi: Abi; bytecode: { object: Hex } };

describe.skipIf(!enabled)('actual private guarded NFT listing policy', () => {
  it('persists private policy and exact reviewed prices through on-chain settlement and service restart', async () => {
    if (!databaseUrl) throw new Error('Set the dedicated ONESHOT_INDEXER_TEST_DATABASE_URL; ambient DATABASE_URL is never selected.');
    const database = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
      || !database.pathname.endsWith('_test') || database.search || database.hash) throw new Error('A dedicated loopback PostgreSQL test database is required.');
    const contractRoot = path.join(root, 'contracts-evm');
    const forge = process.env.ONESHOT_FORGE_BIN || (process.platform === 'win32' ? 'forge.exe' : 'forge');
    const anvilBin = process.env.ONESHOT_ANVIL_BIN || (process.platform === 'win32' ? 'anvil.exe' : 'anvil');
    const build = spawnSync(forge, ['build', '--root', contractRoot], { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (build.status !== 0) throw new Error(`Local contract build failed: ${build.error?.message || build.stderr || build.stdout}`);
    await mkdir(testRoot, { recursive: true }); const directory = await mkdtemp(path.join(testRoot, 'case-'));
    let child: ChildProcess | undefined; let pool: Pool | undefined; let store: PostgresIndexerStore | undefined;
    let ownedDeploymentId: string | undefined; let ownedManifestId: string | undefined;
    const ownedUsers: string[] = []; const previousGlobalPool = globalThis.b20Pool;
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
        try { chainReady = await rpc('eth_chainId') === '0x7a69'; if (chainReady) break; } catch { /* Retry only this owned process startup. */ }
        await pause(100);
      }
      if (!chainReady) throw new Error('Disposable Anvil did not become ready.');
      const accounts = (await rpc<Address[]>('eth_accounts')).map(value => value.toLowerCase() as Address);
      const [creator, seller, buyer, treasury, intruder] = accounts; expect(accounts.length).toBeGreaterThanOrEqual(5);
      // Disposable permit signer; no production key or funded account is used.
      const authorityKey = `0x${randomBytes(32).toString('hex')}` as Hex;
      const authority = privateKeyToAccount(authorityKey), salt = `0x${randomBytes(32).toString('hex')}` as Hex;
      const client = createPublicClient({ chain: anvil, transport: http(rpcUrl, { retryCount: 0, timeout: 5000 }) });
      const wallet = createWalletClient({ chain: anvil, transport: http(rpcUrl, { retryCount: 0, timeout: 5000 }) });
      const artifact = async (name: string): Promise<Artifact> => JSON.parse(await readFile(path.join(contractRoot, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
      const deploy = async (name: string, args: readonly unknown[]) => {
        const data = await artifact(name);
        const receipt = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ account: creator, abi: data.abi, bytecode: data.bytecode.object, args }), timeout: 5000 });
        expect(receipt.status).toBe('success'); expect(receipt.contractAddress).toBeTruthy();
        return { address: receipt.contractAddress!.toLowerCase() as Address, block: receipt.blockNumber };
      };
      const factory = await deploy('OneshotNFTFactory', [treasury]);
      const market = await deploy('OneshotGuardedMarketplace', [factory.address, authority.address, salt]);
      const manifest = parseManifest({ schemaVersion: 1, deploymentVersion: 'oneshot-nft-v2', mode: 'local', chainId: 31337,
        genesisHash: (await client.getBlock({ blockNumber: 0n })).hash, startBlock: factory.block.toString(), anchorHash: (await client.getBlock({ blockNumber: factory.block - 1n })).hash,
        factory: { address: factory.address, codeHash: keccak256((await client.getCode({ address: factory.address }))!) },
        marketplace: { address: market.address, codeHash: keccak256((await client.getCode({ address: market.address }))!) },
        listingAuthorization: { authority: authority.address, salt } });
      const deploymentId = manifestId(manifest); ownedDeploymentId = deploymentId;
      const env: Record<string, string | undefined> = { ONESHOT_LOCAL_NFT_EXECUTION_ENABLED: 'true', ONESHOT_NETWORK: 'local', ONESHOT_RPC_URL: rpcUrl,
        ONESHOT_INDEXER_MANIFEST_PATH: 'injected-disposable-v2-manifest.json', ONESHOT_INDEXER_READS_ENABLED: 'true', DATABASE_URL: databaseUrl,
        ONESHOT_FLOOR_CREATORS: creator, ONESHOT_LISTING_AUTHORITY_PRIVATE_KEY: authorityKey };
      pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000 });
      await pool.query(await readFile(path.join(root, 'db', 'schema.sql'), 'utf8'));
      const repository = () => createNftLaunchRepository({ database: () => pool! }); let wallClock = Date.now();
      const newService = () => createNftLaunchService({ environment: () => env, loadManifest: async () => manifest, repository: repository(), now: () => wallClock });
      let service = newService();
      const source = new VerifiedRpcSource(await createVerifiedRpc(networkConfig(env)));
      expect(await service.status()).toMatchObject({ enabled: true, deploymentId });
      function identity(address: Address): OneshotSession {
        const userId = `did:privy:guarded-floor-${randomUUID()}`; ownedUsers.push(userId);
        return { provider: 'privy', userId, sessionId: randomUUID(), expiresAt: Math.floor(wallClock / 1000) + 3600, linkedAddresses: [address] };
      }
      const creatorSession = identity(creator), sellerSession = identity(seller), buyerSession = identity(buyer), treasurySession = identity(treasury), intruderSession = identity(intruder);
      const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 87, g: 230, b: 193, alpha: 1 } } }).png().toBuffer();
      const uploaded = await storeImage(png, creatorSession.userId, 'https://art.oneshot.app');
      const publicStart = (await client.getBlock()).timestamp + 300n;
      const iso = (seconds: bigint) => new Date(Number(seconds * 1000n)).toISOString();
      const draft = await prepareOneshotDraft((await createOneshotDraft({ name: 'Guarded local originals', symbol: 'GUARD', description: 'Private creator listing settings.',
        maxSupply: 10, royaltyBps: 500, publicPrice: '0.001', perWalletLimit: 8,
        publicStart: iso(publicStart), publicEnd: iso(publicStart + 3600n), allowlistAddresses: [], creatorWallet: creator,
        metadataMode: 'upload', imageUrl: `/api/media/${uploaded.hash}.webp` }, creatorSession)).id, 1, creatorSession, 'https://art.oneshot.app');
      let collection: Address | undefined; let sends = 0;
      const submit = async (review: Awaited<ReturnType<typeof service.review>>, session: OneshotSession) => {
        const fresh = await service.validate(review.id, review.reviewHash, session);
        expect(fresh.data).toBe(review.data); expect(fresh.value).toBe(review.value); expect(fresh.reviewHash).toBe(review.reviewHash);
        const scope = JSON.stringify([session.userId, review.from, 31337]), before = sends;
        const hash = await sendReviewedEvmTransaction({ transaction: { from: fresh.from, to: fresh.to, data: fresh.data, value: fresh.value,
          chainId: 31337, expectedIdentityScope: scope, expiresAt: fresh.expiresAt }, identityScope: () => scope, now: () => wallClock,
          getProvider: async () => ({ request: async input => { if (input.method === 'eth_sendTransaction') sends += 1; return rpc(input.method, input.params); } }) }) as Hex;
        expect(sends).toBe(before + 1);
        expect(await service.submitted(review.id, review.reviewHash, hash, session)).toMatchObject({ transactionHash: hash, outcome: 'submitted', review: { id: review.id, data: review.data } });
        return hash;
      };
      async function act(session: OneshotSession, action: NftReviewInput['action'], fields: Partial<NftReviewInput> = {}) {
        const creatorAction = ['create', 'configure', 'open'].includes(action);
        const review = await service.review({ from: session.linkedAddresses[0], action, localEthAcknowledged: true,
          ...(creatorAction ? { draftId: draft.id, expectedRevision: draft.revision } : {}), ...(action === 'create' ? {} : { collection }), ...fields }, session);
        const hash = await submit(review, session), receipt = await service.receipt(review.id, hash, session);
        expect(receipt).toMatchObject({ status: 'confirmed', hash });
        if (receipt.status !== 'confirmed') throw new Error(`${action} did not confirm.`);
        return { review, hash, receipt };
      }
      const created = await act(creatorSession, 'create'); collection = created.receipt.collection as Address;
      await act(creatorSession, 'configure'); await act(creatorSession, 'open');
      // Only after local uploaded metadata is committed do policy writes use PG.
      // The shared store is explicitly bound to this validated, owned test pool.
      vi.stubEnv('DATABASE_URL', databaseUrl); globalThis.b20Pool = pool;
      await expect(service.floor(collection, intruder, intruderSession)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      env.ONESHOT_FLOOR_CREATORS = '';
      await expect(service.floor(collection, creator, creatorSession)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      await expect(service.review({ from: creator, collection, action: 'policy', floorEnabled: true, floorPrice: '5', localEthAcknowledged: true }, creatorSession)).rejects.toMatchObject({ status: 404 });
      env.ONESHOT_FLOOR_CREATORS = creator;
      const firstPolicy = await act(creatorSession, 'policy', { floorEnabled: true, floorPrice: '5' });
      expect(firstPolicy.review.summary).toMatchObject({ floorEnabled: 'true', floorPriceRaw: '5000000000000000000' });
      const firstCommitment = firstPolicy.review.summary.policyCommitment;
      const policyCall = decodeFunctionData({ abi: GUARDED_MARKETPLACE_ABI, data: firstPolicy.review.data });
      expect(policyCall.functionName).toBe('setPolicyCommitment');
      expect(await service.floor(collection, creator, creatorSession)).toMatchObject({ eligible: true, enabled: true, floorRaw: '5000000000000000000', policyCommitment: firstCommitment });
      expect((await pool.query("SELECT value->>'floorRaw' AS floor FROM b20_app_records WHERE namespace='oneshot_floor_policies' AND value->>'deploymentId'=$1", [deploymentId])).rows).toEqual([{ floor: '5000000000000000000' }]);
      await expect(service.review({ from: seller, collection, action: 'policy', floorEnabled: false, floorPrice: '0', localEthAcknowledged: true }, sellerSession)).rejects.toMatchObject({ status: 404 });
      await rpc('evm_setNextBlockTimestamp', [Number(publicStart)]); await rpc('evm_mine');
      await act(sellerSession, 'mint', { quantity: '4' });
      for (const tokenId of ['1', '2', '3', '4']) await act(sellerSession, 'approve', { tokenId });
      const listingReview = (tokenId: string, price: string) => service.review({ from: seller, collection, action: 'list', tokenId, price, localEthAcknowledged: true }, sellerSession);
      const equal = await listingReview('2', '5'), above = await listingReview('3', '6');
      expect(equal.summary).toMatchObject({ enteredPriceRaw: '5000000000000000000', priceRaw: '5000000000000000000' });
      expect(above.summary).toMatchObject({ enteredPriceRaw: '6000000000000000000', priceRaw: '6000000000000000000' });
      const listed = await act(sellerSession, 'list', { tokenId: '1', price: '4' });
      expect(listed.review.summary).toMatchObject({ enteredPriceRaw: '4000000000000000000', floorPriceRaw: '5000000000000000000', priceRaw: '9000000000000000000' });
      const signed = decodeFunctionData({ abi: GUARDED_MARKETPLACE_ABI, data: listed.review.data });
      expect(signed.functionName).toBe('listAuthorized'); expect(signed.args?.[2]).toBe(9n * 10n ** 18n);
      const unguarded = encodeFunctionData({ abi: NFT_MARKETPLACE_ABI, functionName: 'list', args: [collection, 2n, 4n * 10n ** 18n] });
      await expect(rpc('eth_call', [{ from: seller, to: market.address, data: unguarded }, 'latest'])).rejects.toThrow();
      const stale = await listingReview('2', '4');
      const changedPolicy = await act(creatorSession, 'policy', { floorEnabled: true, floorPrice: '10' });
      expect(changedPolicy.review.summary.policyCommitment).not.toBe(firstCommitment);
      await expect(service.validate(stale.id, stale.reviewHash, sellerSession)).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
      await expect(rpc('eth_call', [{ from: seller, to: market.address, data: stale.data }, 'latest'])).rejects.toThrow();
      const oldOrder = await client.readContract({ address: market.address, abi: GUARDED_MARKETPLACE_ABI, functionName: 'listings', args: [1n] });
      expect(oldOrder[3]).toBe(9n * 10n ** 18n);
      expect((await listingReview('2', '4')).summary.priceRaw).toBe('14000000000000000000');
      const publicInfo = await service.collection(collection);
      for (const secret of ['floorRaw', 'floorEnabled', 'policyCommitment', firstCommitment, changedPolicy.review.summary.policyCommitment, authorityKey]) expect(JSON.stringify(publicInfo)).not.toContain(secret);

      // Buying and claims keep working with the permit authority unavailable.
      env.ONESHOT_LISTING_AUTHORITY_PRIVATE_KEY = undefined;
      const buyReview = await service.review({ from: buyer, collection, action: 'buy', listingId: '1', localEthAcknowledged: true }, buyerSession);
      expect(buyReview).toMatchObject({ value: '9000000000000000000', summary: { priceRaw: '9000000000000000000', platformFeeRaw: '180000000000000000', royaltyRaw: '450000000000000000', sellerProceedsRaw: '8370000000000000000' } });
      const buyHash = await submit(buyReview, buyerSession), beforeRestart = sends;
      await pool.end(); pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000 });
      globalThis.b20Pool = pool; service = newService(); wallClock += 120_001;
      const renewedBuyer = { ...buyerSession, sessionId: randomUUID() };
      const recovered = await service.recover(buyReview.id, renewedBuyer);
      expect(recovered).toMatchObject({ transactionHash: buyHash, outcome: 'submitted', review: { data: buyReview.data, value: '9000000000000000000', summary: { priceRaw: '9000000000000000000' } } });
      expect(await service.receipt(buyReview.id, buyHash, renewedBuyer)).toMatchObject({ status: 'confirmed', hash: buyHash });
      expect(await service.recover(buyReview.id, renewedBuyer)).toMatchObject({ outcome: 'confirmed' }); expect(sends).toBe(beforeRestart);
      await expect(service.recover(buyReview.id, intruderSession)).rejects.toMatchObject({ status: 404 });
      expect(await service.floor(collection, creator, creatorSession)).toMatchObject({ floorRaw: '10000000000000000000', policyCommitment: changedPolicy.review.summary.policyCommitment });
      expect(await client.readContract({ address: collection, abi: NFT_COLLECTION_ABI, functionName: 'ownerOf', args: [1n] })).toMatch(new RegExp(`^${buyer}$`, 'i'));
      const pending = async (account: Address) => client.readContract({ address: market.address, abi: GUARDED_MARKETPLACE_ABI, functionName: 'pending', args: [account] });
      expect(await pending(seller)).toBe(8370000000000000000n); expect(await pending(creator)).toBe(450000000000000000n); expect(await pending(treasury)).toBe(180000000000000000n);
      await act(sellerSession, 'claim'); await act(creatorSession, 'claim'); await act(treasurySession, 'claim');
      expect(await pending(seller)).toBe(0n); expect(await pending(creator)).toBe(0n); expect(await pending(treasury)).toBe(0n);

      store = new PostgresIndexerStore({ connect: () => pool!.connect() }); await store.initialize(deploymentId); ownedManifestId = deploymentId;
      expect((await syncIndexer(source, store, manifest)).caughtUp).toBe(true);
      const reader = createIndexedNftReader({ env: () => env, pool: () => pool!, loadManifest: async () => manifest, source: async () => source });
      const read = async (suffix: string) => { const response = await reader(new NextRequest(`http://localhost/api/oneshot/indexed${suffix}`)); expect(response.status).toBe(200); return response.json(); };
      expect((await read('/listings?status=sold')).items).toEqual([expect.objectContaining({ id: '1', seller, buyer, totalPriceRaw: '9000000000000000000' })]);
      expect((await read(`/collections/${collection}/items/1`)).item).toMatchObject({ owner: buyer, listing: null });
      const activity = (await read(`/activity?collection=${collection}&limit=50`)).items;
      expect(activity.some((item: { eventName: string }) => item.eventName === 'Sold')).toBe(true);
      expect(activity.some((item: { eventName: string }) => item.eventName === 'PolicyCommitted')).toBe(false);
      for (const secret of ['floorRaw', 'floorEnabled', 'policyCommitment', firstCommitment, changedPolicy.review.summary.policyCommitment]) expect(JSON.stringify(activity)).not.toContain(secret);
    } finally {
      try {
        if (pool) {
          const connection = await pool.connect();
          try {
            await connection.query('BEGIN');
            if (ownedManifestId) {
              await connection.query("SELECT pg_advisory_xact_lock(hashtext('oneshot_evm_indexer'), hashtext($1))", [ownedManifestId]);
              for (const table of ['oneshot_evm_logs', 'oneshot_evm_journal', 'oneshot_evm_projections', 'oneshot_evm_deployments']) await connection.query(`DELETE FROM ${table} WHERE manifest_id=$1`, [ownedManifestId]);
            }
            if (ownedUsers.length) await connection.query("DELETE FROM b20_app_records WHERE namespace='oneshot_nft_reviews' AND value->>'owner'=ANY($1::text[])", [ownedUsers]);
            if (ownedDeploymentId) await connection.query("DELETE FROM b20_app_records WHERE namespace IN ('oneshot_nft_publications','oneshot_floor_policies','oneshot_nft_launches') AND value->>'deploymentId'=$1", [ownedDeploymentId]);
            await connection.query('COMMIT');
          } catch (error) { await connection.query('ROLLBACK').catch(() => {}); throw error; } finally { connection.release(); }
        }
      } finally {
        try { await store?.close(); } finally {
          try { await pool?.end(); } finally {
            globalThis.b20Pool = previousGlobalPool;
            if (child && child.exitCode === null && child.signalCode === null) {
              const exited = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill(); await Promise.race([exited, pause(2000)]);
            }
            vi.unstubAllEnvs(); const target = path.resolve(directory);
            if (!target.startsWith(testRoot + path.sep)) throw new Error('Unsafe integration cleanup path.');
            await rm(target, { recursive: true, force: true });
          }
        }
      }
    }
  }, 90_000);
});
