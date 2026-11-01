import { serviceMessage } from './service-message';
import { apiUrl } from './api-url';
import { customerErrorDetails, customerFetch, customerResponseJson } from './customer-http';
import { createNftPendingStore } from './client-nft-recovery';
import type { NftCreatorWorkspace, NftEarningsPage } from '@oneshot/evm';

export type NftLaunchAction = 'create' | 'configure' | 'open' | 'mint' | 'approve' | 'list' | 'buy' | 'cancel' | 'claim' | 'policy';
export type LocalLaunchNetwork = { chainId: 31337; nativeSymbol: 'ETH'; nativeDecimals: 18; name?: string };
export type NftLaunchStatus = { enabled: boolean; reason: string | null; network: LocalLaunchNetwork | null; deploymentId: string | null };
export type NftLaunchRequest = {
  draftId?: string; expectedRevision?: number; from: string; action: NftLaunchAction; localEthAcknowledged: true;
  collection?: string; tokenId?: string; listingId?: string; quantity?: string; recipient?: string; price?: string; contract?: string;
  floorEnabled?: boolean; floorPrice?: string;
};
export type NftLaunchReview = {
  id: string; reviewHash: string; expiresAt: string; chainId: 31337; from: string; to: string; data: string; value: string;
  action: NftLaunchAction; network: LocalLaunchNetwork; summary: Record<string, string>; deploymentId: string; draftId: string; revision: number;
  simulation: { blockNumber: string; blockHash: string; gasEstimate: string };
  scope?: 'draft' | 'public';
};
export type NftTransactionRecord = { review: NftLaunchReview; transactionHash: string | null; outcome: 'review' | 'submitted' | 'confirmed' | 'reverted'; updatedAt: string };
export type PublicNftStage = { start: string; end: string; walletLimitRaw: string; priceRaw: string };
export type PublicNftCollection = {
  network: LocalLaunchNetwork; deploymentId: string; collection: string; creator: string; name: string; symbol: string;
  opened: boolean; totalMintedRaw: string; termsHash: string; blockNumber: string; blockHash: string; blockTimestamp: string;
  terms: {maxSupplyRaw:string;royaltyBps:number;allowlistRoot:string;contentHash:string;metadataBaseURI:string;collectionURI:string;allowlist:PublicNftStage;publicMint:PublicNftStage};
};
export type NftLaunchReceipt = { status: 'pending' | 'confirmed' | 'reverted'; collection?: string; hash?: string; blockNumber?: string; [key: string]: unknown };
export type EvmWalletTransaction = {
  chainId: 31337; from: string; to: string; data: string; value: string; expectedIdentityScope: string; expiresAt: string;
};
export type NftLaunchContext = { identityScope: string | null; address: string | null; chainId: number | null; draftId: string; revision: number; prepared: boolean; deploymentId?: string | null; scope?: 'draft'|'public'; userId?: string | null; selectionKey?: string; termsHash?: string | null };
export type NftLaunchState = {
  phase: 'idle' | 'reviewing' | 'review' | 'validating' | 'signing' | 'submitted' | 'confirming' | 'success' | 'reverted' | 'rejected' | 'invalidated' | 'error';
  review: NftLaunchReview | null; hash: string | null; receipt: NftLaunchReceipt | null; message: string | null;
};
export class NftLaunchError extends Error {
  constructor(message: string, readonly code = 'LAUNCH_ERROR', readonly status?: number) { super(message); this.name = 'NftLaunchError'; }
}
export function createNftLaunchApi(options: { identityScope(): string | null; getAccessToken(): Promise<string | null>; fetcher?: typeof fetch }) {
  const fetcher = options.fetcher || fetch;
  async function request<T>(endpoint: string, body?: unknown, isPublic = false, signal?:AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const headers = new Headers(); const scope = options.identityScope();
    if (!isPublic) {
      if (!scope) throw new NftLaunchError('Sign in and select a linked wallet.', 'IDENTITY_CHANGED');
      const token = await options.getAccessToken();
      if (options.identityScope() !== scope) throw new NftLaunchError('Your account or wallet changed. Prepare a new review.', 'IDENTITY_CHANGED');
      if (!token) throw new NftLaunchError('Your session expired. Sign in again.', 'IDENTITY_CHANGED');
      headers.set('Authorization', `Bearer ${token}`);
    }
    signal?.throwIfAborted();
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await customerFetch(apiUrl(`/api/oneshot/launch/${endpoint}`), { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'omit', redirect: 'error', cache: 'no-store',...(signal?{signal}:{}) }, fetcher);
    const result = await customerResponseJson(response, { signal, invalidResponse: () => new NftLaunchError('The transaction response could not be verified. Please try again.', 'INVALID_RESPONSE', response.status) });
    if (!isPublic && options.identityScope() !== scope) throw new NftLaunchError('Your account or wallet changed. Prepare a new review.', 'IDENTITY_CHANGED');
    const error = customerErrorDetails(result);
    if (!response.ok) throw new NftLaunchError(serviceMessage(error.code, error.message, 'The transaction request could not be completed. Please try again.'), error.code || 'LAUNCH_ERROR', response.status);
    return result as T;
  }
  return {
    status: (signal?: AbortSignal) => request<NftLaunchStatus>('status',undefined,true,signal),
    collection: (address: string) => {
      if (!/^0x[\da-f]{40}$/i.test(address)) throw new NftLaunchError('Choose a valid collection address.','INVALID_REQUEST');
      return request<PublicNftCollection>(`collections/${address.toLowerCase()}`,undefined,true).then(value => validatePublicNftCollection(value,address));
    },
    review: (input: NftLaunchRequest) => request<NftLaunchReview>('review', input),
    validate: (input: { reviewId: string; reviewHash: string }) => request<NftLaunchReview>('validate', input),
    receipt: (input: { reviewId: string; hash: string }, signal?:AbortSignal) => request<NftLaunchReceipt>('receipt', input, false, signal),
    submitted: (input: {reviewId:string;reviewHash:string;hash:string}) => request<NftTransactionRecord>('submitted',input),
    reviewRecord: (id: string) => request<NftTransactionRecord>(`reviews/${encodeURIComponent(id)}`),
    progress: (input: { draftId: string; expectedRevision: number; from: string; launchId?: string; cursor?: string }, signal?: AbortSignal) => {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.draftId)
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !/^0x[\da-f]{40}$/i.test(input.from)
        || input.launchId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.launchId)
        || input.cursor && (input.launchId || input.cursor.length > 4096)) throw new NftLaunchError('Reopen your saved draft and select its creator wallet.', 'INVALID_REQUEST');
      const query = new URLSearchParams({ wallet: input.from.toLowerCase(), revision: String(input.expectedRevision) });
      if (input.launchId) query.set('launchId', input.launchId); if (input.cursor) query.set('cursor', input.cursor);
      return request<NftCreatorWorkspace>(`drafts/${encodeURIComponent(input.draftId)}?${query}`, undefined, false, signal);
    },
    earnings: (input: { wallet: string; cursor?: string }, signal?: AbortSignal) => {
      if (!/^0x[\da-f]{40}$/i.test(input.wallet) || input.cursor !== undefined && (!input.cursor || input.cursor.length > 2048)) {
        throw new NftLaunchError('Select your linked wallet and refresh its earnings.', 'INVALID_REQUEST');
      }
      const query = new URLSearchParams({ wallet: input.wallet.toLowerCase() });
      if (input.cursor) query.set('cursor', input.cursor);
      return request<NftEarningsPage>(`earnings?${query}`, undefined, false, signal);
    },
    transactions: (input: {wallet?:string;limit?:number;cursor?:string} = {}) => {
      const query = new URLSearchParams({limit:String(input.limit ?? 20)});
      if (input.wallet) query.set('wallet',input.wallet.toLowerCase()); if (input.cursor) query.set('cursor',input.cursor);
      return request<{items:NftTransactionRecord[];nextCursor?:string|null}>(`transactions?${query}`);
    },
  };
}
export type NftLaunchApi = ReturnType<typeof createNftLaunchApi>;
const addressPattern = /^0x[\da-f]{40}$/i;
const hashPattern = /^0x[\da-f]{64}$/i;
const unsignedPattern = /^(0|[1-9]\d*)$/;
export function validatePublicNftCollection(value: PublicNftCollection, collection: string): PublicNftCollection {
  const raw = (input: unknown) => typeof input === 'string' && input.length <= 78 && unsignedPattern.test(input) && BigInt(input) < (1n << 256n);
  const stage = (input: PublicNftStage) => input && raw(input.start) && raw(input.end) && raw(input.walletLimitRaw) && raw(input.priceRaw);
  if (!value || value.network?.chainId !== 31337 || value.network?.nativeSymbol !== 'ETH' || value.network.nativeDecimals !== 18
    || !value.deploymentId || !addressPattern.test(value.collection) || value.collection.toLowerCase() !== collection.toLowerCase() || !addressPattern.test(value.creator)
    || typeof value.name !== 'string' || typeof value.symbol !== 'string' || typeof value.opened !== 'boolean'
    || !raw(value.totalMintedRaw) || !raw(value.blockNumber) || !raw(value.blockTimestamp) || !hashPattern.test(value.blockHash) || !hashPattern.test(value.termsHash)
    || !value.terms || !raw(value.terms.maxSupplyRaw) || !Number.isInteger(value.terms.royaltyBps) || value.terms.royaltyBps < 0 || value.terms.royaltyBps > 1000
    || !hashPattern.test(value.terms.contentHash) || !hashPattern.test(value.terms.allowlistRoot) || typeof value.terms.metadataBaseURI !== 'string' || typeof value.terms.collectionURI !== 'string'
    || !stage(value.terms.allowlist) || !stage(value.terms.publicMint)) throw new NftLaunchError('The current collection terms are unavailable. Refresh before reviewing a transaction.','INVALID_COLLECTION');
  return value;
}
function stamp(context: NftLaunchContext) { return JSON.stringify(context); }
function message(error: unknown) { return error instanceof Error ? error.message : 'The transaction could not be completed.'; }
function isRejection(error: unknown): boolean {
  const value = error as { code?: unknown; cause?: unknown; message?: string } | null;
  return value?.code === 4001 || value?.code === '4001' || value?.code === 'ACTION_REJECTED' || /user (rejected|denied)|request rejected/i.test(value?.message || '') || Boolean(value?.cause && isRejection(value.cause));
}
function assertReview(review: NftLaunchReview, context: NftLaunchContext, now: number, recovery = false) {
  if (!review || !review.id || !hashPattern.test(review.reviewHash) || !review.deploymentId || review.chainId !== 31337 || review.network?.chainId !== 31337 || review.network.nativeSymbol !== 'ETH' || review.network.nativeDecimals !== 18) throw new NftLaunchError('This review is not for a supported test ETH transaction.', 'INVALID_REVIEW');
  if (!review.summary || typeof review.summary !== 'object' || Array.isArray(review.summary) || Object.values(review.summary).some(value => typeof value !== 'string')) throw new NftLaunchError('The transaction summary could not be verified. Prepare a new review.', 'INVALID_REVIEW');
  if (!addressPattern.test(review.from) || review.from.toLowerCase() !== context.address?.toLowerCase() || !addressPattern.test(review.to) || !/^0x(?:[\da-f]{2})*$/i.test(review.data) || !unsignedPattern.test(review.value) || BigInt(review.value) >= 2n ** 256n || !unsignedPattern.test(review.simulation?.gasEstimate || '') || !hashPattern.test(review.simulation?.blockHash || '')) throw new NftLaunchError('The wallet, transaction details or gas estimate could not be verified. Prepare a new review.', 'INVALID_REVIEW');
  if (!recovery && (review.draftId !== context.draftId || review.revision !== context.revision || (review.scope || 'draft') !== (context.scope || 'draft'))) throw new NftLaunchError('This draft or collection changed. Prepare a new review.', 'IDENTITY_CHANGED');
  if (context.deploymentId && review.deploymentId !== context.deploymentId) throw new NftLaunchError('The test network changed. Prepare a new review.', 'DEPLOYMENT_CHANGED');
  if (!recovery && (!Number.isFinite(Date.parse(review.expiresAt)) || Date.parse(review.expiresAt) <= now)) throw new NftLaunchError('This review expired. Prepare a new review.', 'REVIEW_EXPIRED');
}
function sameCall(a: NftLaunchReview, b: NftLaunchReview) {
  const summary = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  return ['id', 'reviewHash', 'expiresAt', 'chainId', 'from', 'to', 'data', 'value', 'action', 'deploymentId', 'draftId', 'revision'].every(key => a[key as keyof NftLaunchReview] === b[key as keyof NftLaunchReview]) && (a.scope || 'draft') === (b.scope || 'draft') && summary(a.summary) === summary(b.summary);
}

/** No provider action occurs during prepare. approve must be called by a separate user click. */
export function createNftLaunchController(options: {
  api: Pick<NftLaunchApi,'status'|'review'|'validate'|'receipt'> & Partial<Pick<NftLaunchApi,'submitted'>>; context(): NftLaunchContext; sendEvmTransaction(transaction: EvmWalletTransaction): Promise<string>;
  now?: () => number; pause?: (milliseconds: number) => Promise<void>; receiptAttempts?: number;
  pendingStore?: ReturnType<typeof createNftPendingStore>;
}) {
  let state: NftLaunchState = { phase: 'idle', review: null, hash: null, receipt: null, message: null };
  let epoch = 0; let contextStamp = stamp(options.context());
  const listeners = new Set<() => void>(); const now = options.now || Date.now;
  const pending = options.pendingStore ?? createNftPendingStore(undefined,now);
  const pause = options.pause || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  function set(next: NftLaunchState) { state = next; listeners.forEach(listener => listener()); }
  function invalidate(reason = 'Your account, wallet, network or draft changed. Prepare a new review.') {
    epoch += 1; contextStamp = stamp(options.context());
    set({ phase: 'invalidated', review: null, hash: null, receipt: null, message: reason });
  }
  function syncContext() {
    if (stamp(options.context()) === contextStamp) return;
    if (state.phase === 'idle') { contextStamp = stamp(options.context()); epoch += 1; }
    else invalidate();
  }
  function active(ticket: number, captured: string) {
    if (ticket !== epoch) return false;
    if (stamp(options.context()) !== captured) { invalidate(); return false; }
    return true;
  }
  function ready() {
    const context = options.context();
    if (!context.identityScope || !context.address || context.chainId !== 31337 || !context.prepared) throw new NftLaunchError('Check the collection terms and connect your wallet to the test network (31337).', 'IDENTITY_CHANGED');
    return context;
  }
  function unresolvedTransaction() { return state.hash !== null && state.receipt?.status !== 'confirmed' && state.receipt?.status !== 'reverted'; }
  function fail(error: unknown) {
    // A transient receipt failure cannot undo a broadcast. Keep its exact hash available for
    // retry instead of permitting a replacement review while this transaction is unresolved.
    if (unresolvedTransaction()) { set({ ...state, phase: 'error', message: message(error) }); return; }
    const code = error instanceof NftLaunchError ? error.code : '';
    if (/EXPIRED|CHANGED|INVALID|STALE|DISABLED|DEPLOYMENT|REORG|SIMULATION/i.test(code) || error instanceof NftLaunchError && error.status === 409) invalidate(message(error));
    else set({ ...state, phase: isRejection(error) ? 'rejected' : 'error', message: message(error) });
  }
  async function receipt(ticket: number, captured: string, attempts: number) {
    const review = state.review; const hash = state.hash;
    if (!review || !hash || !active(ticket, captured)) return;
    set({ ...state, phase: 'confirming', message: null });
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await options.api.receipt({ reviewId: review.id, hash });
      if (!active(ticket, captured)) return;
      if (!result || !['pending', 'confirmed', 'reverted'].includes(result.status)) throw new NftLaunchError('The transaction status could not be verified. Check its receipt again.', 'INVALID_RECEIPT');
      if (result.status !== 'pending') {
        if (options.context().userId) pending.forget(options.context().userId!,review.id);
        set({ ...state, receipt: result, phase: result.status === 'confirmed' ? 'success' : 'reverted', message: result.status === 'reverted' ? 'The test-network transaction failed. Refresh the collection and prepare a new review.' : 'The test-network transaction is confirmed.' }); return;
      }
      set({ ...state, receipt: result, phase: 'confirming', message: 'Waiting for the test network to confirm your transaction.' });
      if (attempt + 1 < attempts) { await pause(1500); if (!active(ticket, captured)) return; }
    }
    set({ ...state, phase: 'submitted', message: 'Your transaction is still pending. Choose Check receipt to check again.' });
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    invalidate, syncContext,
    async prepare(input: NftLaunchRequest) {
      if (unresolvedTransaction() || ['validating', 'signing', 'submitted', 'confirming'].includes(state.phase)) return;
      syncContext(); const ticket = ++epoch; const captured = stamp(options.context());
      set({ phase: 'reviewing', review: null, hash: null, receipt: null, message: null });
      try {
        const context = ready();
        const sameTarget = context.scope === 'public'
          ? input.draftId === undefined && input.expectedRevision === undefined && (input.collection?.toLowerCase() === context.draftId.toLowerCase()
            || input.action === 'claim' && input.collection === undefined && addressPattern.test(input.contract || '') && input.contract?.toLowerCase() === context.draftId.toLowerCase())
          : input.draftId === context.draftId && input.expectedRevision === context.revision;
        if (input.localEthAcknowledged !== true || !sameTarget || input.from.toLowerCase() !== context.address?.toLowerCase()) throw new NftLaunchError('Confirm that you are using test ETH and the selected collection and wallet.', 'INVALID_REQUEST');
        const review = await options.api.review(input);
        if (!active(ticket, captured)) return;
        assertReview(review, context, now());
        if (review.action !== input.action) throw new NftLaunchError('The review action changed. Prepare a new review.', 'INVALID_REVIEW');
        set({ phase: 'review', review, hash: null, receipt: null, message: null });
      } catch (error) { if (active(ticket, captured)) fail(error); }
    },
    async approve() {
      if (state.phase !== 'review' || !state.review) return;
      const original = state.review; const ticket = epoch; const captured = contextStamp;
      try {
        if (!active(ticket, captured)) return;
        const context = ready(); assertReview(original, context, now());
        set({ ...state, phase: 'validating', message: null });
        const fresh = await options.api.validate({ reviewId: original.id, reviewHash: original.reviewHash });
        if (!active(ticket, captured)) return;
        assertReview(fresh, context, now());
        if (!sameCall(original, fresh)) throw new NftLaunchError('The reviewed transaction changed. Prepare a new review.', 'INVALID_REVIEW');
        set({ ...state, review: fresh, phase: 'signing' });
        const hash = await options.sendEvmTransaction({ from: fresh.from, to: fresh.to, data: fresh.data, value: fresh.value, chainId: fresh.chainId, expectedIdentityScope: context.identityScope!, expiresAt: fresh.expiresAt });
        if (!hashPattern.test(hash)) throw new NftLaunchError('The wallet did not return a valid transaction hash.', 'INVALID_HASH');
        if (context.userId) pending.remember({userId:context.userId,from:fresh.from,deploymentId:fresh.deploymentId,reviewId:fresh.id,reviewHash:fresh.reviewHash,hash,createdAt:new Date(now()).toISOString()});
        if (!active(ticket, captured)) return;
        set({ ...state, hash, phase: 'submitted', message: 'Your transaction was submitted to the test network.' });
        if (options.api.submitted) await options.api.submitted({reviewId:fresh.id,reviewHash:fresh.reviewHash,hash});
        if (!active(ticket,captured)) return;
        await receipt(ticket, captured, Math.max(1, Math.min(options.receiptAttempts ?? 5, 10)));
      } catch (error) { if (active(ticket, captured)) fail(error); }
    },
    async refreshReceipt() {
      if (!state.hash || !state.review || ['signing', 'validating', 'confirming'].includes(state.phase)) return;
      const ticket = epoch; const captured = contextStamp;
      try { await receipt(ticket, captured, 1); } catch (error) { if (active(ticket, captured)) fail(error); }
    },
    async recover(record: NftTransactionRecord, fallbackHash?: string) {
      if (['signing','validating','confirming'].includes(state.phase)) return;
      syncContext(); const ticket = ++epoch, captured = stamp(options.context());
      try {
        const context = ready(), hash = record.transactionHash || fallbackHash;
        assertReview(record.review,context,now(),true);
        if (!hash || !hashPattern.test(hash)) throw new NftLaunchError('No valid transaction hash is available. Check your wallet before starting another review.','INVALID_RECOVERY');
        set({phase:'submitted',review:record.review,hash,receipt:null,message:'Checking the saved transaction. No wallet approval will be requested.'});
        if (options.api.submitted) await options.api.submitted({reviewId:record.review.id,reviewHash:record.review.reviewHash,hash});
        if (!active(ticket,captured)) return;
        await receipt(ticket,captured,1);
      } catch(error) { if (active(ticket,captured)) fail(error); }
    },
  };
}

/** Provider guards run around every asynchronous boundary; no network switching is performed. */
export async function sendReviewedEvmTransaction(options: {
  transaction: EvmWalletTransaction; identityScope(): string | null;
  getProvider(): Promise<{ request(input: { method: string; params?: unknown[] }): Promise<unknown> }>;
  now?: () => number;
}): Promise<string> {
  // Preserve the exact reviewed call while provider discovery and account/chain checks await.
  const tx = { ...options.transaction }; const now = options.now || Date.now;
  const assertIdentity = () => {
    if (!tx.expectedIdentityScope || options.identityScope() !== tx.expectedIdentityScope) throw new NftLaunchError('Your account or wallet changed. Prepare a new review.', 'IDENTITY_CHANGED');
  };
  const assertCurrent = () => {
    assertIdentity();
    if (!Number.isFinite(Date.parse(tx.expiresAt)) || Date.parse(tx.expiresAt) <= now()) throw new NftLaunchError('This review expired. Prepare a new review.', 'REVIEW_EXPIRED');
  };
  assertCurrent();
  if (tx.chainId !== 31337 || !addressPattern.test(tx.from) || !addressPattern.test(tx.to) || !/^0x(?:[\da-f]{2})*$/i.test(tx.data) || !unsignedPattern.test(tx.value) || BigInt(tx.value) >= 2n ** 256n) throw new NftLaunchError('Only reviewed test ETH transactions are supported.', 'INVALID_REVIEW');
  const provider = await options.getProvider(); assertCurrent();
  const chainId = await provider.request({ method: 'eth_chainId' }); assertCurrent();
  if (typeof chainId !== 'string' || !/^0x[\da-f]+$/i.test(chainId) || BigInt(chainId) !== 31337n) throw new NftLaunchError('Switch your wallet to the test network (31337) and prepare a new review.', 'IDENTITY_CHANGED');
  const accounts = await provider.request({ method: 'eth_accounts' }); assertCurrent();
  if (!Array.isArray(accounts) || !accounts.some(account => typeof account === 'string' && account.toLowerCase() === tx.from.toLowerCase())) throw new NftLaunchError('The reviewed sender is no longer available in your wallet.', 'IDENTITY_CHANGED');
  // Recheck the network after account discovery before the only signing request.
  const finalChainId = await provider.request({ method: 'eth_chainId' }); assertCurrent();
  if (finalChainId !== chainId) throw new NftLaunchError('Your wallet network changed. Prepare a new review.', 'IDENTITY_CHANGED');
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: tx.from, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value).toString(16)}`, chainId: '0x7a69' }] });
  // Once submitted, retain the hash even if an already-open wallet prompt crossed expiry.
  if (typeof hash !== 'string' || !hashPattern.test(hash)) throw new NftLaunchError('The wallet did not return a valid transaction hash.', 'INVALID_HASH');
  // The controller stores this broadcast under the captured owner before suppressing stale UI.
  return hash;
}
