import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, hashTypedData, parseAbi, parseAbiParameters, zeroAddress, type Abi, type AbiEvent, type Hex } from 'viem';
import { rManifest as manifest, ra, rh } from '../../../indexer/test/reviewed-nft-fixture';
import { reviewedNftManifestId } from '../../../../packages/evm/src/reviewed-nft';
import { REVIEWED_NFT_MARKETPLACE_ABI as marketAbi, REVIEWED_NFT_REGISTRY_ABI as registryAbi } from '../../../../packages/evm/src/reviewed-nft-abi';
import type { OneshotSession } from './oneshot-auth';
import { createReviewedNftExecutionService } from './reviewed-nft-execution-service';
import { createReviewedNftExecutionStore } from './reviewed-nft-execution-store';
import type { ReviewedNftExecutionConnection } from './reviewed-nft-execution-connection';
import type { ReviewedNftExecutionInput, ReviewedNftExecutionReview } from '../../../web/lib/reviewed-nft-execution';

const root = path.resolve('.local/reviewed-execution-service-tests'), dep = reviewedNftManifestId(manifest), nft = ra(10), holder = ra(4), recipient = ra(7);
const nftAbi = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)', 'function royaltyInfo(uint256 tokenId,uint256 salePrice) view returns (address,uint256)']);
const intentParameters = parseAbiParameters('address seller,address collection,uint256 tokenId,uint256 totalPrice,address royaltyRecipient,uint256 royaltyAmount,uint256 reviewVersion,uint256 nonce,uint256 deadline,uint256 chainId,address marketplace,bytes32 deploymentSalt');
const intentTypes = { ListingIntent: intentParameters.map(field => ({ name: field.name!, type: field.type })) };
let directory: string, time: number;
beforeEach(async () => { time = 1_800_000_000_000; await mkdir(root, { recursive: true }); directory = await mkdtemp(path.join(root, 'case-')); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('ONESHOT_DATA_DIR', directory); });
afterEach(async () => { vi.unstubAllEnvs(); const target = path.resolve(directory); if (!target.startsWith(root + path.sep)) throw Error('Unsafe test cleanup'); await rm(target, { recursive: true, force: true }); });
const session: OneshotSession = { provider: 'privy', userId: 'did:privy:alice', sessionId: 'session', expiresAt: 9_999_999_999, linkedAddresses: [holder, ra(6)] };
const base = { from: holder, expectedChainId: 31337 as const, expectedDeploymentId: dep, testEthAcknowledged: true as const };
const listInput = (): ReviewedNftExecutionInput => ({ ...base, action: 'list', collection: nft, tokenId: '0', price: '0.000000000000010001' });
const buyInput = (): ReviewedNftExecutionInput => ({ ...base, from: ra(6), action: 'buy', collection: nft, tokenId: '0', listingId: '2', recipient, expectedTotalPriceRaw: '10001' });
const cancelInput = (): ReviewedNftExecutionInput => ({ ...base, action: 'cancel', collection: nft, tokenId: '0', listingId: '2', recipient });
const claimInput = (): ReviewedNftExecutionInput => ({ ...base, action: 'claim', recipient });
function fixture() {
  const state = { enabled: true, trading: true, market: true, pendingNonce: 17n, listingNonce: 3n, owner: holder, activeListing: 0n, admitted: true, version: 1n, royalty: 500n, royaltyRecipient: ra(5), price: 10001n, listingActive: true, pending: 1000n,
    canonical: rh(110), receiptCanonical: rh(111), badSimulation: false, gas: '200000', afterSimulation: () => {}, transaction: null as unknown, receipt: null as unknown };
  const calls: { method: string; params: readonly unknown[] }[] = [], views: string[] = [];
  const readRpc = vi.fn(async (method: string, params: readonly unknown[]) => {
    calls.push({ method, params });
    if (method === 'eth_getTransactionCount') return `0x${state.pendingNonce.toString(16)}`;
    if (method === 'eth_getTransactionByHash') return state.transaction;
    if (method === 'eth_getTransactionReceipt') return state.receipt;
    if (method === 'eth_getBlockByNumber') return { number: params[0], hash: params[0] === '0xb' ? state.receiptCanonical : state.canonical };
    if (method === 'eth_call') {
      const request = params[0] as { to: string; data: Hex };
      const abi: Abi = request.to === nft ? nftAbi : request.to === manifest.registry.address ? registryAbi : marketAbi;
      const decoded = decodeFunctionData({ abi, data: request.data }), name = decoded.functionName, args = decoded.args ?? []; views.push(`${request.to}:${name}`);
      let result: unknown;
      if (name === 'ownerOf') result = state.owner;
      else if (name === 'royaltyInfo') result = [state.royaltyRecipient, state.royalty];
      else if (name === 'activeListing') result = state.activeListing;
      else if (name === 'listingNonces') result = state.listingNonce;
      else if (name === 'reviews') result = [rh(500), state.version, state.admitted];
      else if (name === 'requireActiveReview') { if (!state.admitted || args[1] !== state.version) throw Error('Revoked'); result = rh(500); }
      else if (name === 'listings') result = [nft, holder, 0n, state.price, state.royaltyRecipient, 500n, 1n, rh(500), state.listingActive];
      else if (name === 'pending') result = state.pending;
      else if (name === 'listingIntentHash') result = hashTypedData({ domain: { name: 'OneshotReviewedMarketplace', version: '1', chainId: 31337, verifyingContract: manifest.marketplace.address }, primaryType: 'ListingIntent', types: intentTypes, message: args[0] as never });
      else throw Error(`Unexpected view ${name}`);
      return encodeFunctionResult({ abi, functionName: name, result });
    }
    throw Error(`Unexpected RPC ${method}`);
  });
  const simulateCall = vi.fn(async () => { state.afterSimulation(); if (state.badSimulation) throw Error('private RPC credentials'); return { result: '0x' as Hex, gasEstimate: state.gas }; });
  const c = { manifest, manifestId: dep, block: { number: 10n, hash: rh(110), parentHash: rh(109), timestamp: BigInt(time / 1000) }, rpc: { readRpc, simulateCall } } as unknown as ReviewedNftExecutionConnection;
  const connector = { enabled: () => state.enabled, connect: vi.fn(async (options: { recoveryOnly?: boolean; allowDisabled?: boolean; deploymentId?: string } = {}) => {
    if (!state.enabled && !(options.allowDisabled && options.recoveryOnly) || !state.market || !options.recoveryOnly && !state.trading || options.deploymentId && options.deploymentId !== dep) throw Error('unavailable'); return c;
  }) };
  const store = createReviewedNftExecutionStore({ pool: () => null, now: () => time });
  const service = createReviewedNftExecutionService({ connector, store, now: () => time });
  return { state, calls, views, c, connector, store, service, simulateCall };
}
function claimReceipt(review: ReviewedNftExecutionReview, amount = 1005n, status = '0x1') {
  const tx = { hash: rh(999), from: review.from, to: review.to, input: review.data, value: '0x0', nonce: '0x11', chainId: '0x7a69', blockNumber: '0xb', blockHash: rh(111), transactionIndex: '0x0' };
  const definition = marketAbi.find(value => value.type === 'event' && value.name === 'Claimed') as AbiEvent, args = { account: review.from, recipient, amount };
  const log = { address: manifest.marketplace.address, data: encodeAbiParameters(definition.inputs.filter(field => !field.indexed), [amount]), topics: encodeEventTopics({ abi: [definition], eventName: 'Claimed', args }), blockNumber: '0xb', blockHash: rh(111), transactionHash: rh(999), transactionIndex: '0x0', logIndex: '0x0', removed: false };
  return { transaction: tx, receipt: { from: review.from, to: review.to, transactionHash: rh(999), blockNumber: '0xb', blockHash: rh(111), transactionIndex: '0x0', contractAddress: null, status, logs: status === '0x0' ? [] : [log] } };
}

describe('reviewed NFT transaction reviews and recovery', () => {
  it('separates its execution flag and advertises recovery when admission proof fails', async () => {
    const f = fixture(); f.state.enabled = false; expect((await f.service.status()).enabled).toBe(false); expect(f.connector.connect).not.toHaveBeenCalled();
    f.state.enabled = true; expect((await f.service.status()).capabilities).toEqual({ list: true, buy: true, cancel: true, claim: true });
    f.state.trading = false; expect((await f.service.status()).capabilities).toEqual({ list: false, buy: false, cancel: true, claim: true });
    f.state.market = false; expect((await f.service.status()).enabled).toBe(false);
  });
  it('lists token zero with exact whole-price economics and independent intent/EOA nonces', async () => {
    const f = fixture(), { review } = await f.service.review(listInput(), session); if (review.action !== 'list') throw Error('list');
    expect(review.nonce).toBe('17'); expect(review.terms.intent.nonce).toBe('3'); expect(review.value).toBe('0'); expect(review.to).toBe(nft);
    expect(review.terms).toMatchObject({ totalPriceRaw: '10001', platformFeeRaw: '200', royaltyRaw: '500', sellerProceedsRaw: '9301', tokenId: '0' });
    expect(f.simulateCall).toHaveBeenCalledWith({ from: holder, to: nft, data: review.data, value: '0x0' }, { number: '0xa', hash: rh(110) });
    expect(f.views.some(value => /approve/i.test(value))).toBe(false);
    time += 1000; const original = structuredClone(review); expect((await f.service.revalidate(review.id, review.reviewHash, session)).review).toEqual(original);
    expect((await f.store.get(review.id, session.userId)).review).toEqual(original);
  });
  it('binds a buy to the selected listing, total price and exact recipient', async () => {
    const f = fixture(), { review } = await f.service.review(buyInput(), session); expect(review.action).toBe('buy'); expect(review.value).toBe('10001');
    expect(review.terms).toMatchObject({ recipient, listingId: '2', royaltyRaw: '500', platformFeeRaw: '200', sellerProceedsRaw: '9301' });
    await expect(f.service.review({ ...buyInput(), expectedTotalPriceRaw: '10000' }, session)).rejects.toBeDefined();
    f.state.royalty = 501n; await expect(f.service.review(buyInput(), session)).rejects.toBeDefined();
  });
  it.each(['cancel', 'claim'] as const)('keeps %s independent of registry and royalty reads', async action => {
    const f = fixture(); f.state.trading = false; f.state.admitted = false; f.state.royalty = 99999999n;
    const { review } = await f.service.review(action === 'cancel' ? cancelInput() : claimInput(), session); expect(review.action).toBe(action);
    expect(f.connector.connect).toHaveBeenLastCalledWith({ deploymentId: dep, recoveryOnly: true });
    expect(f.views.every(value => value.startsWith(manifest.marketplace.address))).toBe(true);
    await f.service.revalidate(review.id, review.reviewHash, session);
  });
  it.each(['owner', 'active', 'revoked', 'royalty-cap', 'royalty-zero-recipient', 'nonce-overflow', 'zero-price'] as const)('rejects unsafe list state: %s', async reason => {
    const f = fixture(); let input = listInput();
    if (reason === 'owner') f.state.owner = ra(99); if (reason === 'active') f.state.activeListing = 2n; if (reason === 'revoked') f.state.admitted = false;
    if (reason === 'royalty-cap') f.state.royalty = 1001n; if (reason === 'royalty-zero-recipient') f.state.royaltyRecipient = zeroAddress;
    if (reason === 'nonce-overflow') f.state.pendingNonce = 2n ** 64n; if (reason === 'zero-price') input = { ...input, price: '0' } as ReviewedNftExecutionInput;
    await expect(f.service.review(input, session)).rejects.toBeDefined(); expect((await f.store.list(session.userId)).items).toEqual([]);
  });
  it.each(['nonce', 'intent-nonce', 'royalty', 'owner', 'expiry', 'admission', 'wrong-hash', 'wallet-unlinked', 'already-submitted'] as const)('rejects changed revalidation: %s', async reason => {
    const f = fixture(), { review } = await f.service.review(listInput(), session); let who = session, digest = review.reviewHash;
    if (reason === 'nonce') f.state.pendingNonce++; if (reason === 'intent-nonce') f.state.listingNonce++; if (reason === 'royalty') f.state.royalty++;
    if (reason === 'owner') f.state.owner = ra(99); if (reason === 'expiry') time += 120000; if (reason === 'admission') f.state.admitted = false;
    if (reason === 'wrong-hash') digest = 'f'.repeat(64); if (reason === 'wallet-unlinked') who = { ...session, linkedAddresses: [] };
    if (reason === 'already-submitted') await f.store.attach(review.id, session.userId, rh(999));
    await expect(f.service.revalidate(review.id, digest, who)).rejects.toBeDefined();
  });
  it.each(['nonce', 'fork', 'gas', 'simulation'] as const)('does not save a review when %s changes during simulation', async reason => {
    const f = fixture(); if (reason === 'nonce') f.state.afterSimulation = () => { f.state.pendingNonce++; }; if (reason === 'fork') f.state.afterSimulation = () => { f.state.canonical = rh(666); };
    if (reason === 'gas') f.state.gas = '8000001'; if (reason === 'simulation') f.state.badSimulation = true;
    await expect(f.service.review(claimInput(), session)).rejects.toBeDefined(); expect((await f.store.list(session.userId)).items).toEqual([]);
  });
  it('requires a current linked wallet for new reviews and keeps the namespace account-private', async () => {
    const f = fixture(); await expect(f.service.review(claimInput(), { ...session, linkedAddresses: [] })).rejects.toMatchObject({ code: 'WALLET_NOT_LINKED' });
    const { review } = await f.service.review(claimInput(), session);
    await expect(f.service.recover(review.id, { ...session, userId: 'did:privy:bob' })).rejects.toMatchObject({ status: 404 });
    expect((await f.service.transactions({ ...session, userId: 'did:privy:bob' })).items).toEqual([]);
    const record = await f.service.recover(review.id, session); expect(Object.keys(record).sort()).toEqual(['canonicalReceipt', 'outcome', 'review', 'transactionHash', 'updatedAt']);
  });
  it('saves a broadcast reference before a provider outage and recovers after pause/unlink', async () => {
    const f = fixture(), { review } = await f.service.review(claimInput(), session); f.state.market = false;
    await expect(f.service.submit(review.id, review.reviewHash, rh(999), session)).rejects.toBeDefined();
    expect((await f.store.get(review.id, session.userId)).transactionHash).toBe(rh(999));
    f.state.market = true; f.state.enabled = false; time += 130000;
    expect((await f.service.recover(review.id, { ...session, linkedAddresses: [] })).outcome).toBe('submitted');
    expect(f.connector.connect).toHaveBeenLastCalledWith({ deploymentId: dep, recoveryOnly: true, allowDisabled: true });
  });
  it.each(['confirmed', 'reverted'] as const)('proves %s from canonical exact transaction evidence and ignores claim observation changes', async outcome => {
    const f = fixture(), { review } = await f.service.review(claimInput(), session), receipt = claimReceipt(review, 2222n, outcome === 'reverted' ? '0x0' : '0x1');
    f.state.transaction = receipt.transaction; f.state.receipt = receipt.receipt;
    const record = await f.service.submit(review.id, review.reviewHash, rh(999), session); expect(record.outcome).toBe(outcome); expect(record.canonicalReceipt).toEqual({ blockNumber: '11', blockHash: rh(111) });
    expect((await f.service.recover(review.id, session)).outcome).toBe(outcome);
  });
  it('resets an orphaned saved receipt and accepts a later canonical replacement', async () => {
    const f = fixture(), { review } = await f.service.review(claimInput(), session), mined = claimReceipt(review);
    f.state.transaction = mined.transaction; f.state.receipt = mined.receipt; await f.service.submit(review.id, review.reviewHash, rh(999), session);
    f.state.receiptCanonical = rh(211); f.state.transaction = null; f.state.receipt = null;
    expect((await f.service.recover(review.id, session)).outcome).toBe('submitted'); expect((await f.store.get(review.id, session.userId)).canonicalReceipt).toBeNull();
    mined.transaction.blockHash = rh(211); mined.receipt.blockHash = rh(211); for (const log of mined.receipt.logs) log.blockHash = rh(211);
    f.state.transaction = mined.transaction; f.state.receipt = mined.receipt; expect((await f.service.recover(review.id, session)).outcome).toBe('confirmed');
  });
  it('never confirms an orphan receipt or a mismatched call and retains its recovery reference', async () => {
    const f = fixture(), { review } = await f.service.review(claimInput(), session), mined = claimReceipt(review); f.state.transaction = mined.transaction; f.state.receipt = mined.receipt; f.state.receiptCanonical = rh(211);
    expect((await f.service.submit(review.id, review.reviewHash, rh(999), session)).outcome).toBe('submitted');
    f.state.transaction = { ...mined.transaction, nonce: '0x12' }; await expect(f.service.recover(review.id, session)).rejects.toMatchObject({ code: 'REVIEWED_NFT_TRANSACTION_MISMATCH' });
    expect((await f.store.get(review.id, session.userId)).transactionHash).toBe(rh(999));
  });
  it('does not return cached confirmation if provider receipt disappears while its block stays canonical', async () => {
    const f = fixture(), { review } = await f.service.review(claimInput(), session), mined = claimReceipt(review); f.state.transaction = mined.transaction; f.state.receipt = mined.receipt;
    await f.service.submit(review.id, review.reviewHash, rh(999), session); f.state.transaction = null; f.state.receipt = null;
    await expect(f.service.recover(review.id, session)).rejects.toMatchObject({ status: 503 });
    expect((await f.service.transactions(session)).items[0].outcome).toBe('confirmed'); // history is explicitly last saved, not a fresh chain check
  });
});
