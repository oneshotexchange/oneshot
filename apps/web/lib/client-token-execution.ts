import { decodeFunctionData, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { isNftExecutionNetwork, isSupportedNftChainId, MARKET_TOKEN_ABI, TOKEN_MARKET_ABI, TOKEN_MARKET_FACTORY_ABI, parseAssetAmount, type TokenExecutionReceipt, type TokenExecutionRecovery, type TokenExecutionReview, type TokenExecutionStatus, type TokenTransactionIntent } from '@oneshot/evm';
import type { EvmWalletTransaction } from './client-nft-launch';
import { apiUrl } from './api-url';
import { customerErrorDetails, customerFetch, customerResponseJson } from './customer-http';
import { createTokenPendingStore } from './client-token-pending';

const address = z.string().regex(/^0x[\da-f]{40}$/).refine(value => !/^0x0{40}$/.test(value));
const hash = z.string().regex(/^0x[\da-f]{64}$/).refine(value => !/^0x0{64}$/.test(value));
const uint = z.string().max(78).regex(/^(0|[1-9]\d*)$/).refine(value => BigInt(value) < 2n ** 256n);
const digest = z.string().regex(/^[\da-f]{64}$/);
const id = z.string().uuid();
const reviewSchema = z.object({ id, reviewHash: digest, expiresAt: z.string().datetime(), action: z.enum(['launch', 'approve', 'buy', 'sell', 'claim']),
  chainId: z.union([z.literal(31337), z.literal(84532)]), deploymentId: digest, network: z.custom<TokenExecutionReview['network']>(isNftExecutionNetwork),
  from: address, to: address, value: uint, data: z.string().max(32770).regex(/^0x(?:[\da-f]{2})+$/), summary: z.record(z.string().max(64), z.string().max(2048)),
  simulation: z.object({ blockNumber: uint, blockHash: hash, gasEstimate: uint.refine(value => value !== '0') }).strict(),
}).strict().refine(value => value.network.chainId === value.chainId && Object.keys(value.summary).length <= 64);
export class TokenExecutionError extends Error { constructor(message: string, readonly code = 'TOKEN_EXECUTION_ERROR', readonly status?: number) { super(message); } }
const invalid = (message = 'This token transaction response could not be verified. Prepare a new review.') => new TokenExecutionError(message, 'TOKEN_RESPONSE_INVALID');
const changed = () => new TokenExecutionError('Your account, wallet, network or token details changed. Prepare a new review.', 'TOKEN_CONTEXT_CHANGED');
const sameAddress = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
function raw(value: unknown) { const parsed = uint.safeParse(value); if (!parsed.success) throw invalid(); return BigInt(parsed.data); }
function positive(value: unknown) { const result = raw(value); if (!result) throw invalid(); return result; }
function uuid(value: unknown) { if (!id.safeParse(value).success) throw invalid(); }

export function validateTokenExecutionReview(value: unknown): TokenExecutionReview {
  const parsed = reviewSchema.safeParse(value); if (!parsed.success) throw invalid(); return parsed.data as TokenExecutionReview;
}
export function validateTokenExecutionStatus(value: unknown): TokenExecutionStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Token transaction availability could not be verified. Try again.');
  const input = value as TokenExecutionStatus;
  if (input.enabled === false && input.network === null && input.deploymentId === null && input.factory === null && typeof input.reason === 'string') return { ...input, reason: 'Token transactions are currently unavailable. You can save a draft and return later.' };
  if (input.enabled === true && isNftExecutionNetwork(input.network) && digest.safeParse(input.deploymentId).success && address.safeParse(input.factory).success && input.reason === null) return input;
  throw invalid('Token transaction availability could not be verified. Try again.');
}
export function validateTokenExecutionReceipt(value: unknown, reviewId: string, transactionHash: Hex): TokenExecutionReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('The receipt could not be verified. Keep the transaction hash and check again.');
  const input = value as TokenExecutionReceipt;
  if (input.reviewId !== reviewId || input.hash !== transactionHash) throw invalid('This receipt does not match the submitted transaction. Check again.');
  if (input.status === 'pending' && typeof input.reason === 'string') return { ...input, reason: 'Waiting for the test network to confirm this transaction.' };
  if ((input.status === 'confirmed' || input.status === 'reverted') && uint.safeParse(input.blockNumber).success && hash.safeParse(input.blockHash).success && input.finalized === false) {
    if (input.createdMarket !== undefined && (input.status !== 'confirmed' || !input.createdMarket || !address.safeParse(input.createdMarket.market).success || !address.safeParse(input.createdMarket.token).success || input.createdMarket.market === input.createdMarket.token)) throw invalid();
    return input;
  }
  throw invalid('The receipt could not be verified. Keep the transaction hash and check again.');
}

const errors: Record<string, string> = {
  TOKEN_APPROVAL_REQUIRED: 'Approve this token amount, then prepare a new sale review.', TOKEN_BALANCE_LOW: 'This wallet does not have enough tokens for this sale.',
  TOKEN_NOTHING_TO_CLAIM: 'This wallet has no proceeds to claim from this market.', TOKEN_RECIPIENT_INVALID: 'Choose a wallet that can receive this asset.',
  TOKEN_QUOTE_UNAVAILABLE: 'A quote is unavailable for this amount. Refresh or try a smaller amount.', TOKEN_QUOTE_EXPIRED: 'This review expired. Prepare a new review.',
  TOKEN_REVIEW_CHANGED: 'The network or market changed. Prepare a new review.', TOKEN_SIMULATION_FAILED: 'The transaction could not complete with the current balance, price or market state. Check your balance and prepare a new review.',
  TOKEN_AMOUNT_INVALID: 'Enter a positive amount with no more than 18 decimals for test ETH or 8 decimals for this token.', TOKEN_AMOUNT: 'Enter a positive amount within this asset’s supported precision.',
  TOKEN_TERMS: 'Check the token name, symbol, fee and test ETH opening valuation.', TOKEN_QUOTE: 'A current quote is unavailable. Try a new review.', TOKEN_EXPIRED: 'The quote expired. Try a new review.',
  TOKEN_RECIPIENT: 'Choose a wallet that can receive this asset.', TOKEN_NETWORK: 'This token uses an unsupported test network.', TOKEN_IDENTITY: 'Refresh this market before continuing.',
  TOKEN_TRANSACTION_MISMATCH: 'This transaction does not match the reviewed wallet call. Keep its hash and check your wallet.', TOKEN_REVIEW_LIMIT: 'You have several active reviews. Wait for one to expire and try again.',
  TOKEN_TRANSACTION_PREDATES_REVIEW: 'This transaction was included before this review. Use the transaction submitted for this review.',
  WALLET_NOT_LINKED: 'Select a connected wallet linked to your signed-in account.', AUTH_REQUIRED: 'Sign in again to continue.', TOKEN_REVIEW_NOT_FOUND: 'This review could not be found in your account. Check its ID and sign in with the account that created it.',
};
export function createTokenExecutionApi(options: { identityScope(): string | null; getAccessToken(): Promise<string | null>; fetcher?: typeof fetch }) {
  async function request<T>(endpoint: string, body: unknown | undefined, validate: (value: unknown) => T, signal?: AbortSignal, publicRead = false) {
    signal?.throwIfAborted(); const scope = options.identityScope(), headers = new Headers();
    if (!publicRead) {
      if (!scope) throw changed(); const token = await options.getAccessToken();
      if (options.identityScope() !== scope) throw changed(); if (!token) throw new TokenExecutionError('Your session expired. Sign in again.', 'AUTH_REQUIRED');
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await customerFetch(apiUrl(`/api/oneshot/token-execution/${endpoint}`), { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, credentials: 'omit', redirect: 'error', cache: 'no-store' }, options.fetcher);
    const value = await customerResponseJson(response, { signal, invalidResponse: invalid });
    if (!publicRead && options.identityScope() !== scope) throw changed();
    if (!response.ok) { const { code } = customerErrorDetails(value); throw new TokenExecutionError(code && errors[code] || (response.status === 429 ? 'Too many requests. Wait a moment and try again.' : 'Token transactions are unavailable right now. Please try again later.'), code || 'TOKEN_REQUEST_FAILED', response.status); }
    return validate(value);
  }
  return {
    status: (signal?: AbortSignal) => request('status', undefined, validateTokenExecutionStatus, signal, true),
    review: (input: TokenTransactionIntent) => request('review', input, validateTokenExecutionReview),
    validate: (input: { id: string; reviewHash: string }) => { uuid(input.id); if (!digest.safeParse(input.reviewHash).success) return Promise.reject(invalid()); return request('validate', input, validateTokenExecutionReview); },
    receipt: (input: { id: string; hash: Hex }) => { uuid(input.id); if (!hash.safeParse(input.hash).success) return Promise.reject(invalid()); return request('receipt', input, value => validateTokenExecutionReceipt(value, input.id, input.hash)); },
    recover: (reviewId: string) => { uuid(reviewId); return request(`reviews/${reviewId}`, undefined, (value): TokenExecutionRecovery => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(); const record = value as TokenExecutionRecovery, review = validateTokenExecutionReview(record.review);
      if (review.id !== reviewId || !(record.transactionHash === null && record.outcome === null || hash.safeParse(record.transactionHash).success && ['submitted', 'confirmed', 'reverted'].includes(record.outcome || ''))) throw invalid();
      return { ...record, review };
    }); },
  };
}
export type TokenExecutionApi = ReturnType<typeof createTokenExecutionApi>;
export type TokenExecutionContext = { identityScope: string | null; userId: string | null; from: string | null; chainId: number | null; deploymentId: string | null; ready: boolean; selection: string; market?: string; token?: string; factory?: string; executionFeeBps?: number; feeMode?: 'creator' | 'liquidity_burn' };
export type TokenExecutionState = { phase: 'idle' | 'reviewing' | 'review' | 'validating' | 'signing' | 'submitted' | 'confirming' | 'confirmed' | 'reverted' | 'rejected' | 'invalidated' | 'error'; review: TokenExecutionReview | null; hash: Hex | null; receipt: TokenExecutionReceipt | null; message: string | null; storageWarning: string | null };

/** Check the returned calldata against both the selected market and the exact customer intent. */
export function assertTokenReview(reviewInput: unknown, context: TokenExecutionContext, now: number, intent?: TokenTransactionIntent, recovery = false) {
  const review = validateTokenExecutionReview(reviewInput), summary = review.summary;
  if (!context.identityScope || !context.userId || !context.from || !context.ready || !isSupportedNftChainId(context.chainId) || !context.deploymentId
    || review.chainId !== context.chainId || review.deploymentId !== context.deploymentId || !sameAddress(review.from, context.from)) throw changed();
  if (!recovery && (Date.parse(review.expiresAt) <= now || Date.parse(review.expiresAt) > now + 120_000)) throw new TokenExecutionError('This review expired. Prepare a new review.', 'TOKEN_QUOTE_EXPIRED');
  if (intent && (review.action !== intent.action || !sameAddress(intent.from, review.from) || intent.expectedChainId !== review.chainId || intent.expectedDeploymentId !== review.deploymentId)) throw invalid();
  try {
    if (review.action === 'launch') {
      if (!context.factory || !sameAddress(review.to, context.factory) || review.value !== '0') throw invalid();
      const call = decodeFunctionData({ abi: TOKEN_MARKET_FACTORY_ABI, data: review.data });
      if (call.functionName !== 'createMarket') throw invalid();
      const [name, symbol, fee, liquidityAndBurn, valuation] = call.args;
      if (summary.name !== name || summary.symbol !== symbol || summary.executionFeeBps !== String(fee) || summary.feeMode !== (liquidityAndBurn ? 'liquidity_burn' : 'creator')
        || positive(summary.openingValuationNativeRaw) !== valuation || summary.tokenDecimals !== '8' || raw(summary.initialSupplyRaw) !== 100000000000000000n
        || positive(summary.effectiveOpeningValuationNativeRaw) < valuation || positive(summary.effectiveUpperValuationNativeRaw) <= positive(summary.effectiveOpeningValuationNativeRaw)
        || summary.initialNativePrincipalRaw !== '0' || summary.principalLocked !== 'true' || summary.fixedRange !== 'true') throw invalid();
      if (intent?.action === 'launch' && (intent.draft.pricingNetwork !== 'base-sepolia' && review.chainId === 84532 || name !== intent.draft.name.trim() || symbol !== intent.draft.symbol.trim()
        || fee !== intent.draft.executionFeeBps || liquidityAndBurn !== (intent.draft.feeMode === 'liquidity_burn') || valuation !== parseAssetAmount(intent.draft.openingValuation, 18))) throw invalid();
    } else {
      if (!context.market || !context.token || intent && 'market' in intent && !sameAddress(intent.market, context.market)) throw changed();
      if (review.action === 'approve') {
        const call = decodeFunctionData({ abi: MARKET_TOKEN_ABI, data: review.data });
        if (!sameAddress(review.to, context.token) || review.value !== '0' || call.functionName !== 'approve' || !sameAddress(call.args[0], context.market)
          || summary.token !== context.token.toLowerCase() || summary.market !== context.market.toLowerCase() || summary.spender !== context.market.toLowerCase()
          || positive(summary.allowanceRaw) !== call.args[1] || intent?.action === 'approve' && parseAssetAmount(intent.amount, 8) !== call.args[1]) throw invalid();
      } else {
        const call = decodeFunctionData({ abi: TOKEN_MARKET_ABI, data: review.data });
        if (!sameAddress(review.to, context.market)) throw invalid();
        if (review.action === 'claim') {
          if (call.functionName !== 'claimTo' || review.value !== '0' || summary.market !== context.market.toLowerCase() || !sameAddress(summary.recipient, call.args[0]) || positive(summary.claimableNativeRaw) <= 0n
            || intent?.action === 'claim' && !sameAddress(call.args[0], intent.recipient || intent.from)) throw invalid();
        } else {
          if (call.functionName !== review.action || summary.side !== review.action || summary.token !== context.token.toLowerCase() || summary.lpFeePips !== '2500'
            || summary.fullInputRequired !== 'true' || summary.protocolFeeMayApply !== 'true') throw invalid();
          const buy = review.action === 'buy';
          const minimum = buy ? call.args[0] : call.args[1], recipient = buy ? call.args[1] : call.args[2], deadline = buy ? call.args[2] : call.args[3];
          if (positive(summary.minimumReceiveRaw) !== minimum || !sameAddress(summary.recipient, String(recipient)) || positive(summary.quotedReceiveRaw) < minimum || Date.parse(review.expiresAt) > Number(deadline) * 1000
            || buy && positive(summary.amountRaw) !== raw(review.value) || !buy && (review.value !== '0' || positive(summary.amountRaw) !== call.args[0])) throw invalid();
          if (intent?.action === 'buy' || intent?.action === 'sell') {
            if (positive(summary.amountRaw) !== parseAssetAmount(intent.amount, buy ? 18 : 8) || !sameAddress(String(recipient), intent.recipient || intent.from)
              || minimum !== positive(summary.quotedReceiveRaw) * BigInt(10_000 - intent.slippageBps) / 10_000n) throw invalid();
          }
          const poolInput = positive(summary.poolInputRaw), gross = positive(summary.grossNativeRaw), executionFee = raw(summary.quotedExecutionFeeRaw);
          if (!/^\d+$/.test(summary.executionFeeBps) || Number(summary.executionFeeBps) < 100 || Number(summary.executionFeeBps) > 500 || Number(summary.executionFeeBps) % 10 !== 0 || !['creator', 'liquidity_burn'].includes(summary.feeMode)) throw invalid();
          if (context.executionFeeBps !== undefined && Number(summary.executionFeeBps) !== context.executionFeeBps || context.feeMode !== undefined && summary.feeMode !== context.feeMode) throw invalid();
          if (executionFee !== gross * BigInt(summary.executionFeeBps) / 10_000n || executionFee >= gross || (buy ? gross !== raw(review.value) || poolInput !== gross - executionFee : poolInput !== positive(summary.amountRaw) || positive(summary.quotedReceiveRaw) !== gross - executionFee)) throw invalid();
          for (const key of ['protocolFeePips', 'totalDexFeePips']) if (!/^\d{1,6}$/.test(summary[key]) || Number(summary[key]) >= 1_000_000) throw invalid();
        }
      }
    }
    if (summary.gasPaidSeparately !== 'true') throw invalid();
  } catch (error) { if (error instanceof TokenExecutionError) throw error; throw invalid(); }
  return review;
}

function sameReview(left: TokenExecutionReview, right: TokenExecutionReview) {
  // jsonb may reorder nested object keys. Compare the complete reviewed values in a fixed order.
  const canonical = (review: TokenExecutionReview) => [review.id, review.reviewHash, review.expiresAt, review.action, review.chainId, review.deploymentId,
    [review.network.mode, review.network.chainId, review.network.name, review.network.nativeSymbol, review.network.nativeDecimals],
    review.from, review.to, review.value, review.data, Object.entries(review.summary).sort(([left], [right]) => left.localeCompare(right)),
    [review.simulation.blockNumber, review.simulation.blockHash, review.simulation.gasEstimate]];
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
const rejection = (error: unknown): boolean => Boolean(error && typeof error === 'object' && ('code' in error && [4001, '4001', 'ACTION_REJECTED'].includes(error.code as string) || 'cause' in error && rejection(error.cause)));
function errorMessage(error: unknown) { return error instanceof TokenExecutionError ? error.message : rejection(error) ? 'You declined the wallet request. No new transaction was submitted.' : 'The transaction could not be completed. Check your wallet and try again.'; }

/** Preparing has no signing capability. Sending requires a separate approval and exact server revalidation. */
export function createTokenExecutionController(options: {
  api: Pick<TokenExecutionApi, 'review' | 'validate' | 'receipt' | 'recover'>; context(): TokenExecutionContext;
  sendEvmTransaction(transaction: EvmWalletTransaction): Promise<string>; now?: () => number; pending?: ReturnType<typeof createTokenPendingStore>;
}) {
  const now = options.now || Date.now, pending = options.pending || createTokenPendingStore();
  let epoch = 0, stamp = JSON.stringify(options.context()), intent: TokenTransactionIntent | null = null;
  let state: TokenExecutionState = { phase: 'idle', review: null, hash: null, receipt: null, message: null, storageWarning: null };
  const listeners = new Set<() => void>(), publish = (next: TokenExecutionState) => { state = next; for (const listener of listeners) listener(); };
  const unresolved = () => state.hash !== null && state.receipt?.status !== 'confirmed' && state.receipt?.status !== 'reverted';
  function invalidate(message = 'Your account, wallet, network or token details changed. Prepare a new review.') {
    const hadReview = Boolean(state.review) || ['reviewing','validating','signing','confirming'].includes(state.phase);
    epoch++; stamp = JSON.stringify(options.context()); intent = null;
    publish({ phase: hadReview ? 'invalidated' : 'idle', review: null, hash: null, receipt: null, message: hadReview ? message : null, storageWarning: null });
  }
  function syncContext() { if (JSON.stringify(options.context()) !== stamp) { if (state.phase === 'idle') { epoch++; stamp = JSON.stringify(options.context()); } else invalidate(); } }
  function active(ticket: number, captured: string) { if (ticket !== epoch) return false; if (captured !== JSON.stringify(options.context())) { invalidate(); return false; } return true; }
  function fail(error: unknown) { publish({ ...state, phase: unresolved() ? 'submitted' : rejection(error) ? 'rejected' : 'error', message: errorMessage(error) }); }
  async function checkReceipt(ticket: number, captured: string) {
    const review = state.review, transactionHash = state.hash; if (!review || !transactionHash || !active(ticket, captured)) return;
    publish({ ...state, phase: 'confirming', message: null });
    const receipt = validateTokenExecutionReceipt(await options.api.receipt({ id: review.id, hash: transactionHash }), review.id, transactionHash);
    if (!active(ticket, captured)) return;
    if (receipt.status !== 'pending' && receipt.createdMarket && review.action !== 'launch') throw invalid('This receipt does not match the reviewed action. Check again.');
    if (receipt.status !== 'pending' && options.context().userId) pending.forget(options.context().userId!, review.id);
    publish({ ...state, receipt, phase: receipt.status === 'pending' ? 'submitted' : receipt.status, message: receipt.status === 'pending' ? 'Your transaction is pending. Check its receipt again shortly.' : receipt.status === 'confirmed' ? 'Transaction confirmed. Recent confirmations may change.' : 'The transaction failed on the test network. Network gas may still have been spent.' });
  }
  return {
    snapshot: () => state, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, invalidate, syncContext,
    async prepare(input: TokenTransactionIntent) {
      if (unresolved() || ['reviewing', 'validating', 'signing', 'confirming'].includes(state.phase)) return;
      syncContext(); const ticket = ++epoch, captured = JSON.stringify(options.context()), context = { ...options.context() }; stamp = captured;
      publish({ phase: 'reviewing', review: null, hash: null, receipt: null, message: null, storageWarning: null });
      try {
        if (!context.ready || !context.identityScope || !context.userId || !context.from || input.testEthAcknowledged !== true || input.expectedChainId !== context.chainId
          || input.expectedDeploymentId !== context.deploymentId || !sameAddress(input.from, context.from)
          || (input.action === 'launch' ? !context.factory : !context.market || !('market' in input) || !sameAddress(input.market, context.market))) throw changed();
        intent = structuredClone(input); const review = await options.api.review(input); if (!active(ticket, captured)) return;
        assertTokenReview(review, context, now(), intent); publish({ ...state, phase: 'review', review });
      } catch (error) { if (active(ticket, captured)) fail(error); }
    },
    async approve() {
      if (state.phase !== 'review' || !state.review || !intent) return;
      const original = state.review, ticket = epoch, captured = stamp, context = { ...options.context() };
      try {
        if (!active(ticket, captured)) return; assertTokenReview(original, context, now(), intent); publish({ ...state, phase: 'validating', message: null });
        const review = await options.api.validate({ id: original.id, reviewHash: original.reviewHash }); if (!active(ticket, captured)) return;
        assertTokenReview(review, context, now(), intent); if (!sameReview(original, review)) throw invalid('The reviewed transaction changed. Prepare a new review.');
        publish({ ...state, phase: 'signing' });
        const result = await options.sendEvmTransaction({ chainId: review.chainId, from: review.from, to: review.to, data: review.data, value: review.value, expiresAt: review.expiresAt, expectedIdentityScope: context.identityScope! });
        if (typeof result !== 'string' || !/^0x[\da-f]{64}$/i.test(result) || /^0x0{64}$/i.test(result)) throw invalid('The wallet did not return a valid transaction hash. Check your wallet before starting another review.');
        const transactionHash = result.toLowerCase() as Hex;
        const saved = pending.remember({ userId: context.userId!, from: review.from, chainId: review.chainId, deploymentId: review.deploymentId, reviewId: review.id, hash: transactionHash, createdAt: new Date(now()).toISOString(), target: (review.action === 'launch' ? context.factory! : context.market!).toLowerCase(), action: review.action });
        if (!active(ticket, captured)) return;
        publish({ ...state, hash: transactionHash, phase: 'submitted', storageWarning: saved ? null : pending.warning(), message: 'Transaction submitted. Checking its receipt.' });
        await checkReceipt(ticket, captured);
      } catch (error) { if (active(ticket, captured)) fail(error); }
    },
    async refreshReceipt() { if (!state.review || !state.hash || ['signing', 'validating', 'confirming'].includes(state.phase)) return; const ticket = epoch, captured = stamp; try { await checkReceipt(ticket, captured); } catch (error) { if (active(ticket, captured)) fail(error); } },
    async recover(reviewId: string, fallbackHash?: Hex) {
      if (['signing', 'validating', 'confirming'].includes(state.phase)) return; syncContext(); const ticket = ++epoch, captured = JSON.stringify(options.context()); stamp = captured;
      try {
        uuid(reviewId); const record = await options.api.recover(reviewId); if (!active(ticket, captured)) return;
        const review = assertTokenReview(record.review, options.context(), now(), undefined, true), transactionHash = record.transactionHash || fallbackHash;
        if (!transactionHash || !hash.safeParse(transactionHash).success || record.transactionHash && fallbackHash && record.transactionHash !== fallbackHash) throw invalid('No matching transaction hash is available. Check the review ID and your wallet transaction.');
        intent = null; publish({ phase: 'submitted', review, hash: transactionHash, receipt: null, message: 'Checking the saved transaction. No wallet approval is requested.', storageWarning: null });
        await checkReceipt(ticket, captured);
      } catch (error) { if (active(ticket, captured)) fail(error); }
    },
  };
}
