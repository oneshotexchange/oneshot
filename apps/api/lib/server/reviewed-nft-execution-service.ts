import { randomUUID } from 'node:crypto';
import { encodeAbiParameters, encodeFunctionData, hashTypedData, parseAbi, parseAbiParameters, zeroAddress, type Address, type Hex } from 'viem';
import { parseAssetAmount } from '@oneshot/evm';
import { REVIEWED_NFT_MARKETPLACE_ABI as marketAbi, REVIEWED_NFT_REGISTRY_ABI as registryAbi } from '../../../../packages/evm/src/reviewed-nft-abi';
import { reviewedNftExecutionInputSchema, reviewedNftExecutionReviewSchema, reviewedNftExecutionRecordSchema, reviewedNftExecutionStatusSchema, type ReviewedNftExecutionInput, type ReviewedNftExecutionReview } from '../../../web/lib/reviewed-nft-execution';
import { reviewedNftExecutionConnector, reviewedExecutionUnavailable, reviewedRpcQuantity, type ReviewedNftExecutionConnection } from './reviewed-nft-execution-connection';
import { reviewedNftRead, recheckReviewedNftBlock } from './reviewed-nft-gateway';
import { reviewedNftExecutionStore, reviewedNftReviewHash, type StoredReviewedNftExecution } from './reviewed-nft-execution-store';
import { matchesReviewedNftReceipt } from './reviewed-nft-receipt';
import { assertLinkedEvmAddress, type OneshotSession } from './oneshot-auth';
import { stableJson } from './media';
import { ApiError } from './errors';

const nftAbi = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)', 'function royaltyInfo(uint256 tokenId,uint256 salePrice) view returns (address,uint256)', 'function safeTransferFrom(address from,address to,uint256 tokenId,bytes data)']);
const intentParameters = parseAbiParameters('address seller,address collection,uint256 tokenId,uint256 totalPrice,address royaltyRecipient,uint256 royaltyAmount,uint256 reviewVersion,uint256 nonce,uint256 deadline,uint256 chainId,address marketplace,bytes32 deploymentSalt');
const intentTypes = { ListingIntent: intentParameters.map(field => ({ name: field.name!, type: field.type })) } as const;
const quantity = (value: bigint) => `0x${value.toString(16)}` as Hex;
const equal = (left: unknown, right: unknown) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const changed = () => new ApiError(409, 'REVIEWED_NFT_REVIEW_CHANGED', 'The NFT or wallet terms changed. Prepare a fresh review.');
const expired = () => new ApiError(409, 'REVIEWED_NFT_REVIEW_EXPIRED', 'This transaction review expired. Prepare a fresh review.');
const mismatch = () => new ApiError(409, 'REVIEWED_NFT_TRANSACTION_MISMATCH', 'The transaction does not match this review. Check its hash in your wallet.');
const network = (c: ReviewedNftExecutionConnection) => ({ mode: c.manifest.mode, chainId: c.manifest.chainId, name: c.manifest.mode === 'base-sepolia' ? 'Base Sepolia' : 'Local EVM', nativeSymbol: 'ETH', nativeDecimals: 18 });
type Plan = { action: ReviewedNftExecutionInput['action']; to: Address; data: Hex; value: string; terms: unknown };
type Listing = readonly [Address, Address, bigint, bigint, Address, bigint, bigint, Hex, boolean];

/** Exact calls are constructed on the server; neither requests nor saved hashes authorize a transfer. */
export function createReviewedNftExecutionService(dependencies: {
  connector?: typeof reviewedNftExecutionConnector; store?: typeof reviewedNftExecutionStore; now?: () => number; uuid?: () => string;
} = {}) {
  const connector = dependencies.connector ?? reviewedNftExecutionConnector, store = dependencies.store ?? reviewedNftExecutionStore, now = dependencies.now ?? Date.now;
  const publicRecord = (record: StoredReviewedNftExecution) => reviewedNftExecutionRecordSchema.parse({ review: record.review, transactionHash: record.transactionHash, outcome: record.outcome, updatedAt: record.updatedAt, canonicalReceipt: record.canonicalReceipt });
  function fresh(review: ReviewedNftExecutionReview, c?: ReviewedNftExecutionConnection) {
    if (Date.parse(review.expiresAt) <= now() || c && BigInt(Math.floor(Date.parse(review.expiresAt) / 1000)) <= c.block.timestamp) throw expired();
  }
  async function nonce(c: ReviewedNftExecutionConnection, from: Address) {
    const value = reviewedRpcQuantity(await c.rpc.readRpc('eth_getTransactionCount', [from, 'pending']));
    if (value >= 2n ** 64n) throw reviewedExecutionUnavailable(); return value.toString();
  }
  async function admission(c: ReviewedNftExecutionConnection, collection: Address, version: bigint, codeHash: Hex) {
    const current = await reviewedNftRead<Hex>(c, c.manifest.registry.address, registryAbi, 'requireActiveReview', [collection, version]);
    if (!equal(current, codeHash)) throw changed();
  }
  async function royalty(c: ReviewedNftExecutionConnection, collection: Address, tokenId: bigint, price: bigint) {
    const [recipient, amount] = await reviewedNftRead<readonly [Address, bigint]>(c, collection, nftAbi, 'royaltyInfo', [tokenId, price]);
    if (amount > price / 10n || amount > 0n && (equal(recipient, zeroAddress) || equal(recipient, c.manifest.marketplace.address))) throw changed();
    return [recipient.toLowerCase() as Address, amount] as const;
  }
  async function plan(c: ReviewedNftExecutionConnection, input: ReviewedNftExecutionInput, expiresAt: string): Promise<Plan> {
    const market = c.manifest.marketplace.address, readMarket = <T>(name: string, args: readonly unknown[] = []) => reviewedNftRead<T>(c, market, marketAbi, name, args);
    if (input.expectedChainId !== c.manifest.chainId || input.expectedDeploymentId !== c.manifestId) throw changed();
    if (input.action === 'claim') {
      if (input.recipient === market) throw changed();
      const amount = await readMarket<bigint>('pending', [input.from]);
      if (amount <= 0n) throw new ApiError(409, 'REVIEWED_NFT_NOTHING_TO_CLAIM', 'This wallet has no available payouts.');
      return { action: 'claim', to: market, value: '0', data: encodeFunctionData({ abi: marketAbi, functionName: 'claimTo', args: [input.recipient] }), terms: { account: input.from, recipient: input.recipient, amountRaw: amount.toString(), allPending: true } };
    }
    const tokenId = BigInt(input.tokenId);
    if (input.action === 'list') {
      const price = parseAssetAmount(input.price, 18);
      if (price <= 0n || price >= 2n ** 256n) throw new ApiError(400, 'REVIEWED_NFT_PRICE_INVALID', 'Enter a positive test ETH price with up to 18 decimals.');
      const [owner, active, listingNonce, review] = await Promise.all([
        reviewedNftRead<Address>(c, input.collection, nftAbi, 'ownerOf', [tokenId]), readMarket<bigint>('activeListing', [input.collection, tokenId]),
        readMarket<bigint>('listingNonces', [input.from]), reviewedNftRead<readonly [Hex, bigint, boolean]>(c, c.manifest.registry.address, registryAbi, 'reviews', [input.collection]),
      ]);
      if (!equal(owner, input.from)) throw new ApiError(409, 'REVIEWED_NFT_NOT_OWNER', 'Select the wallet that owns this NFT.');
      if (active !== 0n || !review[2] || review[1] <= 0n || listingNonce >= 2n ** 256n - 1n) throw changed();
      await admission(c, input.collection, review[1], review[0]);
      const [recipient, amount] = await royalty(c, input.collection, tokenId, price), fee = price * 200n / 10_000n;
      const intent = { seller: input.from, collection: input.collection, tokenId: input.tokenId, totalPrice: price.toString(), royaltyRecipient: recipient,
        royaltyAmount: amount.toString(), reviewVersion: review[1].toString(), nonce: listingNonce.toString(), deadline: Math.floor(Date.parse(expiresAt) / 1000).toString(), chainId: c.manifest.chainId, marketplace: market, deploymentSalt: c.manifest.marketplaceSalt };
      const encoded = encodeAbiParameters(intentParameters, [intent.seller, intent.collection, tokenId, price, recipient, amount, review[1], listingNonce, BigInt(intent.deadline), BigInt(intent.chainId), market, intent.deploymentSalt]);
      const message = { ...intent, tokenId, totalPrice: price, royaltyAmount: amount, reviewVersion: review[1], nonce: listingNonce, deadline: BigInt(intent.deadline), chainId: BigInt(intent.chainId) };
      const intentHash = hashTypedData({ domain: { name: 'OneshotReviewedMarketplace', version: '1', chainId: c.manifest.chainId, verifyingContract: market }, primaryType: 'ListingIntent', types: intentTypes, message });
      if (!equal(await readMarket<Hex>('listingIntentHash', [message]), intentHash)) throw changed();
      return { action: 'list', to: input.collection, value: '0', data: encodeFunctionData({ abi: nftAbi, functionName: 'safeTransferFrom', args: [input.from, market, tokenId, encoded] }),
        terms: { collection: input.collection, tokenId: input.tokenId, seller: input.from, totalPriceRaw: price.toString(), platformFeeRaw: fee.toString(), royaltyRecipient: recipient, royaltyRaw: amount.toString(), sellerProceedsRaw: (price - fee - amount).toString(), reviewVersion: review[1].toString(), runtimeCodeHash: review[0], intent, intentHash } };
    }
    const listing = await readMarket<Listing>('listings', [BigInt(input.listingId)]);
    if (!listing[8] || !equal(listing[0], input.collection) || listing[2] !== tokenId) throw new ApiError(409, 'REVIEWED_NFT_LISTING_CHANGED', 'This listing changed. Refresh its terms.');
    if (input.recipient === market) throw changed();
    const seller = listing[1].toLowerCase() as Address;
    if (input.action === 'cancel') {
      if (seller !== input.from) throw new ApiError(409, 'REVIEWED_NFT_NOT_SELLER', 'Select the wallet that created this listing.');
      // Deliberately no admission, royalty or NFT view calls: cancellation survives revocation.
      return { action: 'cancel', to: market, value: '0', data: encodeFunctionData({ abi: marketAbi, functionName: 'cancelTo', args: [BigInt(input.listingId), input.recipient] }), terms: { collection: input.collection, tokenId: input.tokenId, listingId: input.listingId, seller, recipient: input.recipient } };
    }
    if (seller === input.from || listing[3].toString() !== input.expectedTotalPriceRaw) throw changed();
    await admission(c, input.collection, listing[6], listing[7]);
    const [recipient, amount] = await royalty(c, input.collection, tokenId, listing[3]);
    if (!equal(recipient, listing[4]) || amount !== listing[5]) throw changed();
    const fee = listing[3] * 200n / 10_000n;
    return { action: 'buy', to: market, value: listing[3].toString(), data: encodeFunctionData({ abi: marketAbi, functionName: 'buy', args: [BigInt(input.listingId), listing[3], input.recipient] }),
      terms: { collection: input.collection, tokenId: input.tokenId, listingId: input.listingId, recipient: input.recipient, seller, totalPriceRaw: listing[3].toString(), platformFeeRaw: fee.toString(), royaltyRecipient: recipient, royaltyRaw: amount.toString(), sellerProceedsRaw: (listing[3] - fee - amount).toString(), reviewVersion: listing[6].toString(), runtimeCodeHash: listing[7] } };
  }
  async function simulated(c: ReviewedNftExecutionConnection, p: Plan, from: Address) {
    try {
      const result = await c.rpc.simulateCall({ from, to: p.to, data: p.data, value: quantity(BigInt(p.value)) }, { number: quantity(c.block.number), hash: c.block.hash });
      if (result.result !== '0x' || !/^[1-9]\d{0,8}$/.test(result.gasEstimate) || BigInt(result.gasEstimate) > 8_000_000n) throw changed();
      return { blockNumber: c.block.number.toString(), blockHash: c.block.hash, blockTimestamp: c.block.timestamp.toString(), gasEstimate: result.gasEstimate };
    } catch (error) { if (error instanceof ApiError) throw error; throw changed(); }
  }
  async function status() {
    const disabled = () => reviewedNftExecutionStatusSchema.parse({ enabled: false, reason: 'NFT transactions are currently unavailable. You can still browse records and check saved transactions.', network: null, deploymentId: null, marketplace: null, registry: null, capabilities: { list: false, buy: false, cancel: false, claim: false } });
    if (!connector.enabled()) return disabled();
    let c: ReviewedNftExecutionConnection, trading = true;
    try { c = await connector.connect(); }
    catch { trading = false; try { c = await connector.connect({ recoveryOnly: true }); } catch { return disabled(); } }
    return reviewedNftExecutionStatusSchema.parse({ enabled: true, reason: null, network: network(c), deploymentId: c.manifestId, marketplace: c.manifest.marketplace.address, registry: c.manifest.registry.address, capabilities: { list: trading, buy: trading, cancel: true, claim: true } });
  }
  async function review(raw: unknown, session: OneshotSession) {
    const input = reviewedNftExecutionInputSchema.parse(raw); assertLinkedEvmAddress(session, input.from);
    const createdAt = now(), expiresAt = new Date(createdAt + 120_000).toISOString();
    const c = await connector.connect({ deploymentId: input.expectedDeploymentId, recoveryOnly: input.action === 'cancel' || input.action === 'claim' });
    const txNonce = await nonce(c, input.from), p = await plan(c, input, expiresAt), simulation = await simulated(c, p, input.from);
    const unsigned = { schemaVersion: 1, kind: 'reviewed-external-nft-execution', id: (dependencies.uuid ?? randomUUID)(), deploymentId: c.manifestId, chainId: c.manifest.chainId, network: network(c), marketplace: c.manifest.marketplace.address, registry: c.manifest.registry.address,
      from: input.from, ...p, nonce: txNonce, expiresAt, simulation };
    // Parse first, so hashing is stable across JSONB and browser object ordering.
    const parsed = reviewedNftExecutionReviewSchema.parse({ ...unsigned, reviewHash: '0'.repeat(64) }), { reviewHash: _, ...body } = parsed;
    const prepared = reviewedNftExecutionReviewSchema.parse({ ...body, reviewHash: reviewedNftReviewHash(body) });
    await recheckReviewedNftBlock(c); if (txNonce !== await nonce(c, input.from)) throw changed(); fresh(prepared, c);
    await store.save({ schemaVersion: 1, owner: session.userId, session: session.sessionId, createdAt, input, review: prepared, transactionHash: null, outcome: 'review', updatedAt: new Date(now()).toISOString(), canonicalReceipt: null });
    return { review: prepared };
  }
  async function revalidate(id: string, reviewHash: string, session: OneshotSession) {
    const saved = await store.get(id, session.userId), original = saved.review;
    if (original.reviewHash !== reviewHash || saved.transactionHash) throw changed();
    assertLinkedEvmAddress(session, original.from); fresh(original);
    const c = await connector.connect({ deploymentId: original.deploymentId, recoveryOnly: original.action === 'cancel' || original.action === 'claim' }); fresh(original, c);
    if (await nonce(c, original.from) !== original.nonce) throw changed();
    const p = await plan(c, saved.input, original.expiresAt);
    if (stableJson(p) !== stableJson({ action: original.action, to: original.to, data: original.data, value: original.value, terms: original.terms })) throw changed();
    await simulated(c, p, original.from); await recheckReviewedNftBlock(c);
    if (await nonce(c, original.from) !== original.nonce) throw changed(); fresh(original, c);
    return { review: original };
  }
  function exactTransaction(raw: unknown, hash: Hex, r: ReviewedNftExecutionReview) {
    if (!object(raw) || !equal(raw.hash, hash) || !equal(raw.from, r.from) || !equal(raw.to, r.to) || !equal(raw.input, r.data)) return false;
    try { return reviewedRpcQuantity(raw.nonce) === BigInt(r.nonce) && reviewedRpcQuantity(raw.value) === BigInt(r.value) && reviewedRpcQuantity(raw.chainId) === BigInt(r.chainId); } catch { return false; }
  }
  async function checked(record: StoredReviewedNftExecution, session: OneshotSession) {
    if (!record.transactionHash) return publicRecord(record);
    const hash = record.transactionHash, r = record.review;
    const c = await connector.connect({ deploymentId: r.deploymentId, recoveryOnly: true, allowDisabled: true });
    // A saved success is an observation. Re-prove its block before reporting it again.
    if (record.canonicalReceipt) {
      const previous = await c.rpc.readRpc('eth_getBlockByNumber', [quantity(BigInt(record.canonicalReceipt.blockNumber)), false]);
      if (!object(previous) || !equal(previous.hash, record.canonicalReceipt.blockHash)) {
        if (previous !== null && (!object(previous) || reviewedRpcQuantity(previous.number) !== BigInt(record.canonicalReceipt.blockNumber))) throw reviewedExecutionUnavailable();
        record = await store.settle(r.id, session.userId, hash, 'submitted', undefined, null);
      }
    }
    const [transaction, receipt] = await Promise.all([c.rpc.readRpc('eth_getTransactionByHash', [hash]), c.rpc.readRpc('eth_getTransactionReceipt', [hash])]);
    if (transaction === null && receipt === null) {
      // Provider disappearance cannot erase an otherwise canonical terminal observation.
      if (record.canonicalReceipt) throw reviewedExecutionUnavailable();
      return publicRecord(await store.settle(r.id, session.userId, hash, 'submitted'));
    }
    if (!exactTransaction(transaction, hash, r)) throw mismatch();
    if (receipt === null) { if (record.canonicalReceipt) throw reviewedExecutionUnavailable(); return publicRecord(record); }
    const evidence = matchesReviewedNftReceipt({ review: r, manifest: c.manifest, transaction, receipt });
    if (!evidence) throw mismatch();
    const block = await c.rpc.readRpc('eth_getBlockByNumber', [quantity(BigInt(evidence.blockNumber)), false]);
    if (!object(block) || reviewedRpcQuantity(block.number) !== BigInt(evidence.blockNumber)) throw reviewedExecutionUnavailable();
    if (!equal(block.hash, evidence.blockHash)) {
      if (record.canonicalReceipt) throw reviewedExecutionUnavailable();
      return publicRecord(record); // orphaned receipt is never a confirmation
    }
    if (BigInt(evidence.blockNumber) < BigInt(r.simulation.blockNumber)) throw new ApiError(409, 'REVIEWED_NFT_TRANSACTION_PREDATES_REVIEW', 'This transaction was included before this review.');
    await recheckReviewedNftBlock({ ...c, block: { ...c.block, number: BigInt(evidence.blockNumber), hash: evidence.blockHash } });
    if (record.canonicalReceipt && !equal(record.canonicalReceipt.blockHash, evidence.blockHash)) throw reviewedExecutionUnavailable();
    record = await store.settle(r.id, session.userId, hash, evidence.status, undefined, { blockNumber: evidence.blockNumber, blockHash: evidence.blockHash });
    // No cached success is returned if the chain changes while persistence completes.
    await recheckReviewedNftBlock({ ...c, block: { ...c.block, number: BigInt(evidence.blockNumber), hash: evidence.blockHash } });
    return publicRecord(record);
  }
  async function recover(id: string, session: OneshotSession) { return checked(await store.get(id, session.userId), session); }
  async function submit(id: string, reviewHash: string, hash: Hex, session: OneshotSession) {
    const saved = await store.get(id, session.userId); if (saved.review.reviewHash !== reviewHash) throw changed();
    // Save the wallet-reported reference before network reads. It is not receipt evidence.
    const attached = await store.attach(id, session.userId, hash); return checked(attached, session);
  }
  async function transactions(session: OneshotSession, options: { wallet?: string; limit?: number; cursor?: string } = {}) {
    const result = await store.list(session.userId, options); return { items: result.items.map(publicRecord), nextCursor: result.nextCursor };
  }
  return { status, review, revalidate, submit, recover, transactions };
}
export const reviewedNftExecutionService = createReviewedNftExecutionService();
