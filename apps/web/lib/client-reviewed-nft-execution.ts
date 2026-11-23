import { z } from 'zod';
import { encodeAbiParameters, encodeFunctionData, hashTypedData, parseAbi, parseAbiParameters, sha256, stringToHex, type Hex } from 'viem';
import { parseAssetAmount } from '@oneshot/evm';
import { REVIEWED_NFT_MARKETPLACE_ABI } from '../../../packages/evm/src/reviewed-nft-abi';
import { reviewedNftExecutionHistorySchema, reviewedNftExecutionInputSchema, reviewedNftExecutionRecordSchema, reviewedNftExecutionReviewSchema, reviewedNftExecutionStatusSchema, type ReviewedNftExecutionInput, type ReviewedNftExecutionRecord, type ReviewedNftExecutionReview, type ReviewedNftExecutionStatus } from './reviewed-nft-execution';
import type { ReviewedListing } from './reviewed-nft-data';
import type { EvmWalletTransaction } from './client-nft-launch';
import { apiUrl } from './api-url';
import { customerErrorDetails, customerFetch } from './customer-http';

export class ReviewedNftExecutionError extends Error {
  constructor(message: string, readonly code = 'REVIEWED_EXECUTION_FAILED', readonly status?: number) { super(message); this.name = 'ReviewedNftExecutionError'; }
}
const address = z.string().regex(/^0x[\da-f]{40}$/).refine(value => !/^0x0{40}$/.test(value));
const hash = z.string().regex(/^0x[\da-f]{64}$/).refine(value => !/^0x0{64}$/.test(value));
const digest = z.string().regex(/^[a-f\d]{64}$/);
const pendingReferenceSchema = z.object({
  reviewId: z.string().uuid(), hash, from: address, chainId: z.union([z.literal(31337), z.literal(84532)]),
  deploymentId: digest, createdAt: z.string().datetime(),
}).strict();
export type ReviewedNftPendingReference = z.infer<typeof pendingReferenceSchema>;
type PendingStorage = Pick<Storage, 'getItem' | 'setItem'>;
const pendingSchema = z.object({ version: z.literal(1), references: z.array(pendingReferenceSchema).max(100) }).strict()
  .refine(value => new Set(value.references.map(reference => reference.reviewId)).size === value.references.length);
function browserStorage(): PendingStorage | null { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } }
function ownerKey(userId: string) {
  if (!userId || userId.length > 256) throw new Error('Invalid recovery owner');
  return `oneshot.reviewed-nft.pending.v1.${sha256(stringToHex(userId)).slice(2)}`;
}

/** Only non-secret recovery references are persisted, under a separate account key.
 * Pending references do not expire merely because the signing review has expired.
 */
export function createReviewedNftPendingStore(storage: PendingStorage | null = browserStorage(), now: () => number = Date.now) {
  let warning: string | null = null;
  function read(userId: string) {
    const key = ownerKey(userId); if (!storage) throw new Error();
    const raw = storage.getItem(key);
    if (raw === null) return { key, raw, references: [] as ReviewedNftPendingReference[] };
    if (new TextEncoder().encode(raw).length > 131072) throw new Error();
    const value = pendingSchema.parse(JSON.parse(raw));
    return { key, raw, references: value.references };
  }
  function update(userId: string, change: (references: ReviewedNftPendingReference[]) => ReviewedNftPendingReference[]) {
    try {
      const previous = read(userId), next = pendingSchema.parse({ version: 1, references: change(previous.references) });
      if (storage!.getItem(previous.key) !== previous.raw) throw new Error();
      storage!.setItem(previous.key, JSON.stringify(next)); warning = null; return true;
    } catch { warning = 'This transaction reference could not be saved on this device. Keep its review ID and transaction hash before leaving.'; return false; }
  }
  return {
    warning: () => warning,
    list(userId: string, filter: { from?: string; chainId?: number; deploymentId?: string } = {}) {
      try {
        const items = read(userId).references.filter(item => (!filter.from || item.from === filter.from.toLowerCase()) && (filter.chainId === undefined || item.chainId === filter.chainId) && (!filter.deploymentId || item.deploymentId === filter.deploymentId));
        warning = null; return items;
      } catch { warning = 'Saved transaction references could not be opened. Use the review ID and transaction hash to check your transaction.'; return []; }
    },
    remember(userId: string, input: ReviewedNftPendingReference) {
      const parsed = pendingReferenceSchema.safeParse(input);
      if (!parsed.success || Date.parse(parsed.data.createdAt) > now() + 60_000) { warning = 'The transaction reference could not be saved. Keep its review ID and transaction hash.'; return false; }
      return update(userId, previous => {
        if (previous.some(item => item.reviewId === input.reviewId && (item.hash !== input.hash || item.from !== input.from || item.chainId !== input.chainId || item.deploymentId !== input.deploymentId))) throw new Error();
        if (previous.some(item => item.reviewId !== input.reviewId && item.deploymentId === input.deploymentId && item.hash === input.hash)) throw new Error();
        return [...previous.filter(item => item.reviewId !== input.reviewId), parsed.data];
      });
    },
    forget(userId: string, reviewId: string) { return update(userId, previous => previous.filter(item => item.reviewId !== reviewId)); },
  };
}

/** PostgreSQL jsonb key order cannot change the meaning of an immutable review. */
export function canonicalReviewedNftValue(value: unknown): string {
  function sorted(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sorted);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([key, field]) => [key, sorted(field)]));
    return input;
  }
  return JSON.stringify(sorted(value));
}

const invalid = () => new ReviewedNftExecutionError('This NFT transaction response could not be verified. Prepare a fresh review.', 'INVALID_RESPONSE');
const changed = () => new ReviewedNftExecutionError('Your account, wallet, network or NFT selection changed. Prepare a fresh review.', 'CONTEXT_CHANGED');
const sameAddress = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
export function validateReviewedNftExecutionReview(value: unknown): ReviewedNftExecutionReview {
  const parsed = reviewedNftExecutionReviewSchema.safeParse(value); if (!parsed.success) throw invalid();
  const { reviewHash, ...body } = parsed.data;
  if (sha256(stringToHex(canonicalReviewedNftValue(body))).slice(2) !== reviewHash) throw invalid();
  return parsed.data;
}
export function validateReviewedNftExecutionRecord(value: unknown, reviewId?: string, transactionHash?: string): ReviewedNftExecutionRecord {
  const parsed = reviewedNftExecutionRecordSchema.safeParse(value); if (!parsed.success) throw invalid();
  const record = parsed.data; validateReviewedNftExecutionReview(record.review);
  if (reviewId && record.review.id !== reviewId || transactionHash && record.transactionHash !== transactionHash) throw invalid();
  return record;
}
export function validateReviewedNftExecutionStatus(value: unknown): ReviewedNftExecutionStatus {
  const parsed = reviewedNftExecutionStatusSchema.safeParse(value); if (!parsed.success) throw invalid();
  return { ...parsed.data, reason: parsed.data.enabled ? null : 'NFT transactions are currently unavailable. You can still browse collection records and check saved transactions.' };
}
const executionMessages: Record<string, string> = {
  REVIEWED_NFT_APPROVAL_REQUIRED: 'This NFT cannot be transferred by the selected wallet. Check the current owner and try again.',
  REVIEWED_NFT_NOT_OWNER: 'Select the wallet that currently owns this NFT.', REVIEWED_NFT_NOT_SELLER: 'Select the wallet that created this listing.',
  REVIEWED_NFT_NOTHING_TO_CLAIM: 'This wallet has no available payouts to claim.', REVIEWED_NFT_LISTING_CHANGED: 'This listing changed. Refresh its terms before preparing a review.',
  REVIEWED_NFT_REVIEW_EXPIRED: 'This review expired. Prepare a fresh review.', REVIEWED_NFT_REVIEW_CHANGED: 'The current NFT or wallet terms changed. Prepare a fresh review.',
  REVIEWED_NFT_TRANSACTION_CHANGED: 'This review is already tracking another transaction. Reload its saved status.',
  REVIEWED_NFT_TRANSACTION_MISMATCH: 'The transaction does not match this review. Keep its hash and check the transaction in your wallet.',
  REVIEWED_NFT_TRANSACTION_PREDATES_REVIEW: 'This transaction was included before this review. Use the transaction submitted for this review.',
  REVIEWED_NFT_REVIEW_NOT_FOUND: 'This review was not found in your account. Sign in with the account that created it.',
  REVIEWED_NFT_REVIEW_LIMIT: 'Check your submitted transactions or wait for an existing review to expire before preparing another.',
  WALLET_NOT_LINKED: 'Select a connected wallet linked to your signed-in account.',
};
async function boundedExecutionJson(response: Response, signal: AbortSignal, assertIdentity: () => void) {
  const maximum = 2 * 1024 * 1024, length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(maximum)) throw invalid();
  const reader = (() => { try { return response.body?.getReader(); } catch { throw invalid(); } })(); if (!reader) throw invalid();
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = []; let bytes = 0, complete = false;
  try {
    for (;;) { signal.throwIfAborted(); assertIdentity(); const part = await reader.read(); signal.throwIfAborted(); assertIdentity(); if (part.done) { complete = true; break; } bytes += part.value.byteLength; if (bytes > maximum) throw invalid(); chunks.push(part.value); }
    const data = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as unknown; } catch { if (!response.ok) return null; throw invalid(); }
  } catch (error) { signal.throwIfAborted(); if (error instanceof ReviewedNftExecutionError) throw error; throw invalid(); }
  finally { signal.removeEventListener('abort', cancel); if (!complete) cancel(); reader.releaseLock(); }
}
export function createReviewedNftExecutionApi(options: { identityScope(): string | null; getAccessToken(): Promise<string | null>; fetcher?: typeof fetch }) {
  async function request<T>(endpoint: string, body: unknown | undefined, parse: (value: unknown) => T, signal?: AbortSignal, publicRead = false): Promise<T> {
    const scope = options.identityScope(), timeout = AbortSignal.timeout(90_000), deadline = signal ? AbortSignal.any([signal, timeout]) : timeout, headers = new Headers();
    const assertIdentity = () => { if (!publicRead && (!scope || options.identityScope() !== scope)) throw changed(); };
    let response: Response | undefined;
    try {
      deadline.throwIfAborted(); assertIdentity();
      if (!publicRead) { const token = await options.getAccessToken(); assertIdentity(); deadline.throwIfAborted(); if (!token) throw new ReviewedNftExecutionError('Your session expired. Sign in again.', 'AUTH_REQUIRED', 401); headers.set('Authorization', `Bearer ${token}`); }
      if (body !== undefined) headers.set('Content-Type', 'application/json');
      response = await customerFetch(apiUrl(`/api/oneshot/reviewed-execution/${endpoint}`), { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: deadline, credentials: 'omit', redirect: 'error', cache: 'no-store' }, options.fetcher);
      assertIdentity(); deadline.throwIfAborted(); const value = await boundedExecutionJson(response, deadline, assertIdentity); assertIdentity(); deadline.throwIfAborted();
      if (!response.ok) {
        const { code } = customerErrorDetails(value), mapped = code && Object.prototype.hasOwnProperty.call(executionMessages, code) ? executionMessages[code] : null;
        throw new ReviewedNftExecutionError(mapped || (response.status === 401 ? 'Sign in again to manage this transaction.' : response.status === 429 ? 'Too many requests. Wait a moment and try again.' : 'This NFT transaction request is unavailable. Refresh its saved status before trying again.'), code || 'REQUEST_FAILED', response.status);
      }
      return parse(value);
    } catch (error) {
      void response?.body?.cancel().catch(() => {}); signal?.throwIfAborted();
      if (deadline.aborted) throw new ReviewedNftExecutionError('This request took too long. Check the saved review and transaction hash before trying again.', 'REQUEST_TIMEOUT');
      throw error;
    }
  }
  const parseReview = (value: unknown) => { const parsed = z.object({ review: reviewedNftExecutionReviewSchema }).strict().safeParse(value); if (!parsed.success) throw invalid(); return validateReviewedNftExecutionReview(parsed.data.review); };
  const reviewId = (value: string) => { if (!z.string().uuid().safeParse(value).success) throw invalid(); return encodeURIComponent(value); };
  return {
    status: (signal?: AbortSignal) => request('status', undefined, validateReviewedNftExecutionStatus, signal, true),
    review: (input: ReviewedNftExecutionInput, signal?: AbortSignal) => { const parsed = reviewedNftExecutionInputSchema.safeParse(input); if (!parsed.success) throw new ReviewedNftExecutionError('Check the NFT, recipient and test ETH amount.', 'INVALID_INPUT'); return request('reviews', parsed.data, parseReview, signal); },
    revalidate: (id: string, reviewHash: string, signal?: AbortSignal) => { if (!digest.safeParse(reviewHash).success) throw invalid(); return request(`reviews/${reviewId(id)}/revalidate`, { reviewHash }, parseReview, signal); },
    submit: (id: string, reviewHash: string, transactionHash: string, signal?: AbortSignal) => { if (!digest.safeParse(reviewHash).success || !hash.safeParse(transactionHash).success) throw invalid(); return request(`reviews/${reviewId(id)}/submit`, { reviewHash, transactionHash }, value => validateReviewedNftExecutionRecord(value, id, transactionHash), signal); },
    recover: (id: string, signal?: AbortSignal) => request(`reviews/${reviewId(id)}`, undefined, value => validateReviewedNftExecutionRecord(value, id), signal),
    history: (wallet: string, cursor?: string, signal?: AbortSignal) => {
      if (!address.safeParse(wallet.toLowerCase()).success || cursor !== undefined && (!/^[\w-]+$/.test(cursor) || cursor.length > 2048)) throw invalid();
      const query = new URLSearchParams({ wallet: wallet.toLowerCase(), limit: '20' }); if (cursor) query.set('cursor', cursor);
      return request(`transactions?${query}`, undefined, value => {
        const parsed = reviewedNftExecutionHistorySchema.safeParse(value); if (!parsed.success || parsed.data.items.length > 20 || parsed.data.nextCursor && !parsed.data.items.length) throw invalid();
        const items = parsed.data.items.map(record => validateReviewedNftExecutionRecord(record));
        if (new Set(items.map(item => item.review.id)).size !== items.length || items.some(item => !sameAddress(item.review.from, wallet))) throw invalid();
        return { ...parsed.data, items };
      }, signal);
    },
  };
}
export type ReviewedNftExecutionApi = ReturnType<typeof createReviewedNftExecutionApi>;

const safeTransferAbi = parseAbi(['function safeTransferFrom(address from,address to,uint256 tokenId,bytes data)']);
const listingIntentParameters = parseAbiParameters('address seller,address collection,uint256 tokenId,uint256 totalPrice,address royaltyRecipient,uint256 royaltyAmount,uint256 reviewVersion,uint256 nonce,uint256 deadline,uint256 chainId,address marketplace,bytes32 deploymentSalt');
const listingIntentTypes = { ListingIntent: listingIntentParameters.map(field => ({ name: field.name!, type: field.type })) } as const;
export type ReviewedNftExecutionContext = { identityScope: string | null; userId: string | null; from: string | null; chainId: number | null; status: ReviewedNftExecutionStatus | null; ready: boolean; selection: string; collection?: string; tokenId?: string; listing?: ReviewedListing | null };
export function reviewedNftActionAvailable(status: ReviewedNftExecutionStatus | null, action: ReviewedNftExecutionInput['action']) {
  const capabilities = status && 'capabilities' in status ? status.capabilities as Record<string, unknown> : null;
  return Boolean(status?.enabled && capabilities?.[action] === true);
}
export function assertReviewedNftExecutionReview(value: unknown, context: ReviewedNftExecutionContext, now: number, input?: ReviewedNftExecutionInput, recovery = false) {
  const review = validateReviewedNftExecutionReview(value), status = context.status;
  if (!context.identityScope || !context.userId || !context.from || !sameAddress(context.from, review.from)) throw changed();
  if (!recovery && (!context.ready || !status?.enabled || !reviewedNftActionAvailable(status, review.action) || status.deploymentId !== review.deploymentId || status.network?.chainId !== review.chainId
    || context.chainId !== review.chainId || status.registry !== review.registry || status.marketplace !== review.marketplace)) throw changed();
  if (!recovery && (Date.parse(review.expiresAt) <= now || Date.parse(review.expiresAt) > now + 120_000)) throw new ReviewedNftExecutionError('This review expired. Prepare a fresh review.', 'REVIEW_EXPIRED');
  if (input && (review.action !== input.action || review.from !== input.from || review.chainId !== input.expectedChainId || review.deploymentId !== input.expectedDeploymentId || input.testEthAcknowledged !== true)) throw invalid();
  if (input && input.action !== 'claim' && (review.action === 'claim' || review.terms.collection !== input.collection || review.terms.tokenId !== input.tokenId || input.collection !== context.collection || input.tokenId !== context.tokenId)) throw changed();
  let expectedData: Hex;
  if (review.action === 'list') {
    const t = review.terms, i = t.intent;
    if (input?.action === 'list' && parseAssetAmount(input.price, 18).toString() !== t.totalPriceRaw) throw invalid();
    const intentData = encodeAbiParameters(listingIntentParameters, [i.seller, i.collection, BigInt(i.tokenId), BigInt(i.totalPrice), i.royaltyRecipient, BigInt(i.royaltyAmount), BigInt(i.reviewVersion), BigInt(i.nonce), BigInt(i.deadline), BigInt(i.chainId), i.marketplace, i.deploymentSalt]);
    expectedData = encodeFunctionData({ abi: safeTransferAbi, functionName: 'safeTransferFrom', args: [review.from, review.marketplace, BigInt(t.tokenId), intentData] });
    const intentHash = hashTypedData({ domain: { name: 'OneshotReviewedMarketplace', version: '1', chainId: review.chainId, verifyingContract: review.marketplace }, primaryType: 'ListingIntent', types: listingIntentTypes,
      message: { ...i, tokenId: BigInt(i.tokenId), totalPrice: BigInt(i.totalPrice), royaltyAmount: BigInt(i.royaltyAmount), reviewVersion: BigInt(i.reviewVersion), nonce: BigInt(i.nonce), deadline: BigInt(i.deadline), chainId: BigInt(i.chainId) } });
    if (t.intentHash !== intentHash || BigInt(i.deadline) < BigInt(Math.floor(Date.parse(review.expiresAt) / 1000))) throw invalid();
  } else if (review.action === 'buy') {
    const t = review.terms;
    if (input?.action === 'buy' && (t.listingId !== input.listingId || t.totalPriceRaw !== input.expectedTotalPriceRaw || t.recipient !== input.recipient)) throw invalid();
    expectedData = encodeFunctionData({ abi: REVIEWED_NFT_MARKETPLACE_ABI, functionName: 'buy', args: [BigInt(t.listingId), BigInt(t.totalPriceRaw), t.recipient] });
  } else if (review.action === 'cancel') {
    const t = review.terms;
    if (input?.action === 'cancel' && (t.listingId !== input.listingId || t.recipient !== input.recipient)) throw invalid();
    expectedData = encodeFunctionData({ abi: REVIEWED_NFT_MARKETPLACE_ABI, functionName: 'cancelTo', args: [BigInt(t.listingId), t.recipient] });
    if (sameAddress(t.recipient, review.from) && review.data === encodeFunctionData({ abi: REVIEWED_NFT_MARKETPLACE_ABI, functionName: 'cancel', args: [BigInt(t.listingId)] })) expectedData = review.data;
  } else {
    if (input?.action === 'claim' && review.terms.recipient !== input.recipient) throw invalid();
    expectedData = encodeFunctionData({ abi: REVIEWED_NFT_MARKETPLACE_ABI, functionName: 'claimTo', args: [review.terms.recipient] });
  }
  if (review.data !== expectedData.toLowerCase()) throw invalid();
  if (input && (input.action === 'buy' || input.action === 'cancel')) {
    const listing = context.listing;
    if (!listing || listing.status !== 'active' || listing.listingId !== input.listingId || listing.collection !== input.collection || listing.tokenId !== input.tokenId || listing.marketplace !== review.marketplace) throw changed();
    if (review.action === 'buy' && (listing.seller !== review.terms.seller || listing.totalPriceRaw !== review.terms.totalPriceRaw || listing.royaltyRaw !== review.terms.royaltyRaw || listing.royaltyRecipient !== review.terms.royaltyRecipient || listing.runtimeCodeHash !== review.terms.runtimeCodeHash || listing.reviewVersion !== review.terms.reviewVersion)) throw changed();
  }
  return review;
}

export type ReviewedNftExecutionState = {
  phase: 'idle' | 'reviewing' | 'review' | 'revalidating' | 'signing' | 'submitted' | 'checking' | 'confirmed' | 'reverted' | 'rejected' | 'invalidated' | 'error';
  review: ReviewedNftExecutionReview | null; hash: string | null; record: ReviewedNftExecutionRecord | null; message: string | null; storageWarning: string | null;
};
export type ReviewedWalletTransaction = EvmWalletTransaction & { nonce: string };
const rejected = (error: unknown): boolean => Boolean(error && typeof error === 'object' && ('code' in error && [4001, '4001', 'ACTION_REJECTED'].includes(error.code as string) || 'cause' in error && rejected(error.cause)));
const errorText = (error: unknown) => error instanceof ReviewedNftExecutionError ? error.message : rejected(error) ? 'You declined the wallet request. No new transaction was submitted.' : 'The request could not be completed. Check your wallet and the saved transaction before trying again.';
const identity = (context: ReviewedNftExecutionContext) => canonicalReviewedNftValue([context.identityScope, context.userId, context.from?.toLowerCase(), context.chainId]);
export const reviewedNftUnresolved = (state: ReviewedNftExecutionState) => Boolean(state.hash && (!state.record || state.record.outcome === 'submitted'));
export const reviewedNftExecutionBusy = (state: ReviewedNftExecutionState) => ['reviewing', 'revalidating', 'signing', 'checking'].includes(state.phase);

/** Preparation and recovery never prompt a wallet. Only approve() can send, after exact revalidation. */
export function createReviewedNftExecutionController(options: {
  api: Pick<ReviewedNftExecutionApi, 'review' | 'revalidate' | 'submit' | 'recover'>; context(): ReviewedNftExecutionContext;
  sendEvmTransaction(transaction: ReviewedWalletTransaction): Promise<string>; now?: () => number; pending?: ReturnType<typeof createReviewedNftPendingStore>;
}) {
  const now = options.now || Date.now, pending = options.pending || createReviewedNftPendingStore();
  let epoch = 0, stamp = canonicalReviewedNftValue(options.context()), identityStamp = identity(options.context()), intent: ReviewedNftExecutionInput | null = null;
  let walletInFlight = false;
  let state: ReviewedNftExecutionState = { phase: 'idle', review: null, hash: null, record: null, message: null, storageWarning: null };
  const listeners = new Set<() => void>(), publish = (next: ReviewedNftExecutionState) => { state = next; for (const listener of listeners) listener(); };
  function invalidate(message = 'Your account, wallet, network or NFT selection changed. Prepare a fresh review.') {
    const context = options.context(), sameIdentity = identity(context) === identityStamp;
    const hadReview = Boolean(state.review) || reviewedNftExecutionBusy(state);
    epoch++; stamp = canonicalReviewedNftValue(context); identityStamp = identity(context); intent = null;
    if (walletInFlight && sameIdentity) { publish({ ...state, phase: 'signing', message: 'A wallet request is still open. Finish or decline it before preparing another review.' }); return; }
    if (reviewedNftUnresolved(state) && sameIdentity) { publish({ ...state, phase: 'submitted', message: 'A transaction was already sent. Check its receipt before preparing another review.' }); return; }
    publish({ phase: hadReview ? 'invalidated' : 'idle', review: null, hash: null, record: null, message: hadReview ? message : null, storageWarning: null });
  }
  function syncContext() { if (stamp !== canonicalReviewedNftValue(options.context())) invalidate(); }
  function active(ticket: number, captured: string) { if (ticket !== epoch) return false; if (captured !== canonicalReviewedNftValue(options.context())) { invalidate(); return false; } return true; }
  function fail(error: unknown) { publish({ ...state, phase: reviewedNftUnresolved(state) ? 'submitted' : rejected(error) ? 'rejected' : 'error', message: `${reviewedNftUnresolved(state) ? 'Your transaction was sent. ' : ''}${errorText(error)}` }); }
  function remember(context: ReviewedNftExecutionContext, review: ReviewedNftExecutionReview, transactionHash: string) {
    if (context.userId) pending.remember(context.userId, { reviewId: review.id, hash: transactionHash, from: review.from, chainId: review.chainId, deploymentId: review.deploymentId, createdAt: new Date(now()).toISOString() });
    return pending.warning();
  }
  function acceptRecord(value: unknown, context: ReviewedNftExecutionContext, expectedReview: ReviewedNftExecutionReview, transactionHash: string) {
    const record = validateReviewedNftExecutionRecord(value, expectedReview.id, transactionHash);
    if (canonicalReviewedNftValue(record.review) !== canonicalReviewedNftValue(expectedReview)) throw invalid();
    assertReviewedNftExecutionReview(record.review, context, now(), undefined, true);
    if (record.outcome === 'review') throw invalid();
    if (record.outcome === 'submitted') remember(context, record.review, transactionHash); else if (context.userId) pending.forget(context.userId, record.review.id);
    publish({ phase: record.outcome, review: record.review, hash: transactionHash, record, storageWarning: pending.warning(), message: record.outcome === 'submitted' ? 'Waiting for confirmation. Check the receipt again shortly.' : record.outcome === 'confirmed' ? 'Transaction confirmed. Recent confirmations can change.' : 'The transaction reverted. Network gas may still have been spent.' });
  }
  return {
    snapshot: () => state, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, invalidate, syncContext,
    async prepare(input: ReviewedNftExecutionInput) {
      if (walletInFlight || reviewedNftExecutionBusy(state) || reviewedNftUnresolved(state)) return;
      syncContext(); const ticket = ++epoch, context = structuredClone(options.context()), captured = canonicalReviewedNftValue(context); stamp = captured; identityStamp = identity(context);
      publish({ phase: 'reviewing', review: null, hash: null, record: null, message: null, storageWarning: null });
      try {
        const parsed = reviewedNftExecutionInputSchema.safeParse(input);
        if (!parsed.success || !context.ready || !context.status?.enabled || !reviewedNftActionAvailable(context.status, input.action) || input.from !== context.from?.toLowerCase() || input.expectedChainId !== context.chainId || input.expectedDeploymentId !== context.status.deploymentId) throw changed();
        intent = structuredClone(parsed.data);
        const review = await options.api.review(parsed.data); if (!active(ticket, captured)) return;
        assertReviewedNftExecutionReview(review, context, now(), intent);
        publish({ phase: 'review', review, hash: null, record: null, message: null, storageWarning: null });
      } catch (error) { if (active(ticket, captured)) fail(error); }
    },
    async approve() {
      if (walletInFlight || state.phase !== 'review' || !state.review || !intent) return;
      const original = state.review, selected = intent, context = structuredClone(options.context()), captured = stamp, capturedIdentity = identity(context), ticket = epoch;
      try {
        if (!active(ticket, captured)) return;
        assertReviewedNftExecutionReview(original, context, now(), selected);
        publish({ ...state, phase: 'revalidating', message: null });
        const fresh = await options.api.revalidate(original.id, original.reviewHash); if (!active(ticket, captured)) return;
        assertReviewedNftExecutionReview(fresh, context, now(), selected);
        if (canonicalReviewedNftValue(fresh) !== canonicalReviewedNftValue(original)) throw invalid();
        publish({ ...state, phase: 'signing' });
        walletInFlight = true;
        let walletHash: string;
        try { walletHash = await options.sendEvmTransaction({ chainId: fresh.chainId, from: fresh.from, to: fresh.to, data: fresh.data, value: fresh.value, nonce: fresh.nonce, expectedIdentityScope: context.identityScope!, expiresAt: fresh.expiresAt }); }
        finally { walletInFlight = false; }
        const transactionHash = typeof walletHash === 'string' ? walletHash.toLowerCase() : walletHash;
        if (!hash.safeParse(transactionHash).success) throw invalid();
        const storageWarning = remember(context, fresh, transactionHash);
        if (!active(ticket, captured)) {
          // A wallet prompt can finish after a same-account form refresh. Keep the
          // broadcast visible, without authorizing any new review or submission.
          if (identity(options.context()) === capturedIdentity) publish({ phase: 'submitted', review: fresh, hash: transactionHash, record: null, storageWarning, message: 'Your transaction was sent. The NFT selection changed; check the receipt to continue.' });
          return;
        }
        publish({ phase: 'submitted', review: fresh, hash: transactionHash, record: null, storageWarning, message: 'Your transaction was sent. Checking its receipt.' });
        const record = await options.api.submit(fresh.id, fresh.reviewHash, transactionHash); if (!active(ticket, captured)) return;
        acceptRecord(record, context, fresh, transactionHash);
      } catch (error) {
        if (active(ticket, captured)) fail(error);
        else if (identity(options.context()) === capturedIdentity && ['signing'].includes(state.phase)) publish({ phase: 'invalidated', review: null, hash: null, record: null, storageWarning: null, message: errorText(error) });
      }
    },
    async recover(reviewId: string, knownHash?: string) {
      if (walletInFlight || reviewedNftExecutionBusy(state)) return;
      if (reviewedNftUnresolved(state) && state.review?.id !== reviewId) { publish({ ...state, message: 'Check this submitted transaction before opening another saved review.' }); return; }
      syncContext(); const ticket = ++epoch, context = structuredClone(options.context()), captured = canonicalReviewedNftValue(context); stamp = captured; identityStamp = identity(context); intent = null;
      try {
        if (!context.identityScope || !context.userId || !context.from || knownHash !== undefined && !hash.safeParse(knownHash).success) throw changed();
        publish({ ...state, phase: 'checking', message: 'Checking the saved transaction. No wallet approval will be requested.' });
        const saved = validateReviewedNftExecutionRecord(await options.api.recover(reviewId), reviewId); if (!active(ticket, captured)) return;
        assertReviewedNftExecutionReview(saved.review, context, now(), undefined, true);
        if (saved.transactionHash && knownHash && saved.transactionHash !== knownHash) throw invalid();
        const transactionHash = saved.transactionHash || knownHash;
        if (!transactionHash) throw new ReviewedNftExecutionError('No submitted transaction is saved for this review. Enter its transaction hash from your wallet to check it.', 'HASH_REQUIRED');
        const storageWarning = remember(context, saved.review, transactionHash);
        publish({ phase: 'checking', review: saved.review, hash: transactionHash, record: null, storageWarning, message: 'Checking the transaction receipt.' });
        if (saved.transactionHash) acceptRecord(saved, context, saved.review, transactionHash);
        else { const attached = await options.api.submit(saved.review.id, saved.review.reviewHash, transactionHash); if (!active(ticket, captured)) return; acceptRecord(attached, context, saved.review, transactionHash); }
      } catch (error) { if (active(ticket, captured)) fail(error); }
    },
    async checkReceipt() { if (state.review && state.hash && !reviewedNftExecutionBusy(state)) await this.recover(state.review.id, state.hash); },
  };
}
