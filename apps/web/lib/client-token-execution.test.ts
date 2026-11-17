import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { MARKET_TOKEN_ABI, TOKEN_MARKET_ABI, TOKEN_MARKET_FACTORY_ABI, nftNetworkForChainId, type TokenExecutionReview, type TokenTransactionIntent, type TokenExecutionReceipt } from '@oneshot/evm';
import { assertTokenReview, createTokenExecutionApi, createTokenExecutionController, TokenExecutionError, validateTokenExecutionReceipt, validateTokenExecutionStatus, type TokenExecutionContext } from './client-token-execution';
import { createTokenPendingStore, TOKEN_PENDING_STORAGE_KEY } from './client-token-pending';

const addr = (n: string) => `0x${n.repeat(40)}` as Address, hash = (n: string) => `0x${n.repeat(64)}` as Hex;
const now = Date.parse('2026-11-16T12:00:00Z'), reviewId = '00000000-0000-4000-8000-000000000001', network = nftNetworkForChainId(84532)!;
const from = addr('1'), market = addr('2'), token = addr('3'), factory = addr('4'), deploymentId = 'a'.repeat(64), transactionHash = hash('5');
const common = { from, testEthAcknowledged: true as const, expectedChainId: 84532 as const, expectedDeploymentId: deploymentId };
const buy: TokenTransactionIntent = { ...common, action: 'buy', market, amount: '1', slippageBps: 100 };
const deadline = BigInt(now / 1000 + 60);
const review = (): TokenExecutionReview => ({ id: reviewId, reviewHash: 'b'.repeat(64), expiresAt: new Date(now + 60_000).toISOString(), action: 'buy', chainId: 84532, deploymentId, network, from, to: market, value: '1000000000000000000',
  data: encodeFunctionData({ abi: TOKEN_MARKET_ABI, functionName: 'buy', args: [990000000n, from, deadline, 100n] }),
  summary: { side: 'buy', token, recipient: from, amountRaw: '1000000000000000000', poolInputRaw: '985000000000000000', quotedReceiveRaw: '1000000000', minimumReceiveRaw: '990000000', grossNativeRaw: '1000000000000000000', quotedExecutionFeeRaw: '15000000000000000', executionFeeBps: '150', feeMode: 'creator', lpFeePips: '2500', protocolFeePips: '0', totalDexFeePips: '2500', protocolFeeMayApply: 'true', gasPaidSeparately: 'true', fullInputRequired: 'true' },
  simulation: { blockNumber: '9007199254740993', blockHash: hash('6'), gasEstimate: '120000' } });
const confirmed = (): TokenExecutionReceipt => ({ reviewId, hash: transactionHash, status: 'confirmed', blockNumber: '9007199254740994', blockHash: hash('7'), finalized: false });
function memory(raw?: string) { const values = new Map(raw === undefined ? [] : [[TOKEN_PENDING_STORAGE_KEY, raw]]); return { values, getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function harness() {
  let context: TokenExecutionContext = { identityScope: 'owner/wallet/base', userId: 'owner', from, chainId: 84532, deploymentId, ready: true, selection: 'buy/1/100', market, token, factory, executionFeeBps: 150, feeMode: 'creator' }, clock = now;
  const storage = memory(), pending = createTokenPendingStore(storage, () => clock);
  const api = { status: vi.fn(), review: vi.fn(async () => review()), validate: vi.fn(async () => review()), receipt: vi.fn(async () => confirmed()), recover: vi.fn(async () => ({ review: review(), transactionHash, outcome: 'submitted' as const })) };
  const send = vi.fn(async () => transactionHash);
  const controller = createTokenExecutionController({ api, context: () => context, sendEvmTransaction: send, pending, now: () => clock });
  return { api, send, pending, storage, controller, context: () => context, change: (change: Partial<TokenExecutionContext>) => { context = { ...context, ...change }; }, clock: (value: number) => { clock = value; } };
}

describe('token review authority and exact calldata', () => {
  it('matches checksummed decoded recipients by address for buys, sells and claims',()=>{
    const owner=addr('a'),f=harness();f.change({from:owner});
    const bought={...review(),from:owner,summary:{...review().summary,recipient:owner},data:encodeFunctionData({abi:TOKEN_MARKET_ABI,functionName:'buy',args:[990000000n,owner,deadline,100n]})};
    expect(assertTokenReview(bought,f.context(),now,{...buy,from:owner})).toEqual(bought);
    const sold:TokenExecutionReview={...bought,action:'sell',value:'0',summary:{...bought.summary,side:'sell',amountRaw:'100000000',poolInputRaw:'100000000',quotedReceiveRaw:'985000000000000000',minimumReceiveRaw:'975150000000000000'},
      data:encodeFunctionData({abi:TOKEN_MARKET_ABI,functionName:'sell',args:[100000000n,975150000000000000n,owner,deadline,10000n]})};
    expect(assertTokenReview(sold,f.context(),now,{...common,from:owner,action:'sell',market,amount:'1',slippageBps:100})).toEqual(sold);
    const claim:TokenExecutionReview={...bought,action:'claim',value:'0',summary:{market,recipient:owner,claimableNativeRaw:'100',gasPaidSeparately:'true'},data:encodeFunctionData({abi:TOKEN_MARKET_ABI,functionName:'claimTo',args:[owner]})};
    expect(assertTokenReview(claim,f.context(),now,{...common,from:owner,action:'claim',market})).toEqual(claim);
    expect(()=>assertTokenReview({...bought,summary:{...bought.summary,recipient:addr('9')}},f.context(),now,{...buy,from:owner})).toThrow();
  });
  it('allows initial form edits without claiming an absent review changed',()=>{
    const f=harness();f.controller.invalidate('Trade details changed. Prepare a new review.');
    expect(f.controller.snapshot()).toMatchObject({phase:'idle',review:null,message:null});
    f.change({selection:'buy/0.01/100'});expect(f.controller.snapshot()).toMatchObject({phase:'idle',message:null});
  });
  it('does not request the wallet while preparing; a separate approval revalidates the same call once', async () => {
    const f = harness(); await f.controller.prepare(buy); expect(f.api.review).toHaveBeenCalledExactlyOnceWith(buy); expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot().phase).toBe('review'); await Promise.all([f.controller.approve(), f.controller.approve()]);
    expect(f.api.validate).toHaveBeenCalledExactlyOnceWith({ id: reviewId, reviewHash: 'b'.repeat(64) });
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ from, to: market, value: review().value, data: review().data, chainId: 84532, expectedIdentityScope: 'owner/wallet/base', expiresAt: review().expiresAt });
    expect(f.controller.snapshot()).toMatchObject({ phase: 'confirmed', hash: transactionHash, receipt: confirmed() });
  });

  it.each([{ expectedChainId: 8453 }, { expectedChainId: 31337 }, { expectedDeploymentId: 'c'.repeat(64) }, { testEthAcknowledged: false }, { from: addr('9') }, { market: addr('9') }])('rejects a mismatched intent before even requesting a review: %j', async change => {
    const f = harness(); await f.controller.prepare({ ...buy, ...change } as TokenTransactionIntent); expect(f.api.review).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });

  it('accepts identical PostgreSQL-reordered nested network, summary and simulation keys without changing the reviewed values', async () => {
    const f = harness(), original = review();
    const reordered = { ...original,
      network: { nativeDecimals: 18 as const, name: 'Base Sepolia' as const, nativeSymbol: 'ETH' as const, chainId: 84532 as const, mode: 'base-sepolia' as const },
      summary: Object.fromEntries(Object.entries(original.summary).reverse()),
      simulation: { gasEstimate: original.simulation.gasEstimate, blockHash: original.simulation.blockHash, blockNumber: original.simulation.blockNumber },
    };
    f.api.validate.mockResolvedValue(reordered); await f.controller.prepare(buy); await f.controller.approve();
    expect(f.send).toHaveBeenCalledOnce(); expect(f.controller.snapshot().phase).toBe('confirmed');
  });

  it.each(['from', 'to', 'value', 'data', 'summary', 'chainId', 'reviewHash', 'expiresAt'] as const)('rejects changed revalidation field %s before wallet approval', async field => {
    const f = harness(), changed = review();
    if (field === 'summary') changed.summary = { ...changed.summary, totalDexFeePips: '3000' };
    else if (field === 'chainId') { changed.chainId = 31337; changed.network = nftNetworkForChainId(31337)!; }
    else if (field === 'expiresAt') changed.expiresAt = new Date(now + 30_000).toISOString();
    else if (field === 'from' || field === 'to') changed[field] = addr('9');
    else if (field === 'data') changed.data = '0x1234'; else if (field === 'value') changed.value = '1'; else changed.reviewHash = 'c'.repeat(64);
    f.api.validate.mockResolvedValue(changed); await f.controller.prepare(buy); await f.controller.approve(); expect(f.send).not.toHaveBeenCalled();
  });

  it('preserves the reviewed minimum and checks fee arithmetic instead of relabeling inconsistent raw strings', () => {
    const f = harness(); expect(assertTokenReview(review(), f.context(), now, buy)).toEqual(review());
    for (const changes of [{ minimumReceiveRaw: '1' }, { amountRaw: '1' }, { quotedExecutionFeeRaw: '0' }, { poolInputRaw: '1' }, { executionFeeBps: '250' }, { protocolFeePips: '1000000' }, { feeMode: 'liquidity_burn' }] as Record<string, string>[]) {
      const malformed = review(); malformed.summary = { ...malformed.summary, ...changes };
      expect(() => assertTokenReview(malformed, f.context(), now, buy)).toThrow(TokenExecutionError);
    }
  });

  it('requires exact limited allowance and separates its approval from a sale', () => {
    const f = harness(), input: TokenTransactionIntent = { ...common, action: 'approve', market, amount: '2.5' }, approval = { ...review(), action: 'approve' as const, to: token, value: '0', data: encodeFunctionData({ abi: MARKET_TOKEN_ABI, functionName: 'approve', args: [market, 250000000n] }), summary: { token, market, spender: market, allowanceRaw: '250000000', gasPaidSeparately: 'true' } };
    expect(assertTokenReview(approval, f.context(), now, input)).toEqual(approval);
    const unlimited = { ...approval, data: encodeFunctionData({ abi: MARKET_TOKEN_ABI, functionName: 'approve', args: [market, 2n ** 256n - 1n] }), summary: { ...approval.summary, allowanceRaw: (2n ** 256n - 1n).toString() } };
    expect(() => assertTokenReview(unlimited, f.context(), now, input)).toThrow(TokenExecutionError);
  });

  it('checks new Base launch denomination, factory and effective valuations against the exact calldata', () => {
    const f = harness(), input: TokenTransactionIntent = { ...common, action: 'launch', draft: { pricingNetwork: 'base-sepolia', name: 'Orbit', symbol: 'ORBIT', openingValuation: '1', executionFeeBps: 150, feeMode: 'creator' } };
    const launch = { ...review(), action: 'launch' as const, to: factory, value: '0', data: encodeFunctionData({ abi: TOKEN_MARKET_FACTORY_ABI, functionName: 'createMarket', args: ['Orbit', 'ORBIT', 150, false, 1000000000000000000n] }), summary: { name: 'Orbit', symbol: 'ORBIT', initialSupplyRaw: '100000000000000000', tokenDecimals: '8', executionFeeBps: '150', feeMode: 'creator', openingValuationNativeRaw: '1000000000000000000', effectiveOpeningValuationNativeRaw: '1001000000000000000', effectiveUpperValuationNativeRaw: '1001000000000000000000', initialNativePrincipalRaw: '0', principalLocked: 'true', fixedRange: 'true', gasPaidSeparately: 'true' } };
    expect(assertTokenReview(launch, f.context(), now, input)).toEqual(launch);
    expect(() => assertTokenReview(launch, f.context(), now, { ...input, draft: { ...input.draft, pricingNetwork: 'zero' } })).toThrow(TokenExecutionError);
    expect(() => assertTokenReview({ ...launch, to: market }, f.context(), now, input)).toThrow(TokenExecutionError);
  });
});

describe('token transaction races and recovery', () => {
  it('drops a late review after an account, chain or selected amount changes', async () => {
    const f = harness(), late = deferred<TokenExecutionReview>(); f.api.review.mockReturnValue(late.promise);
    const preparing = f.controller.prepare(buy); f.change({ selection: 'buy/2/100' }); late.resolve(review()); await preparing;
    expect(f.controller.snapshot()).toMatchObject({ phase: 'invalidated', review: null }); expect(f.send).not.toHaveBeenCalled();
  });
  it('checks expiry before and after the asynchronous revalidation', async () => {
    const first = harness(); await first.controller.prepare(buy); first.clock(now + 60_000); await first.controller.approve(); expect(first.api.validate).not.toHaveBeenCalled(); expect(first.send).not.toHaveBeenCalled();
    const second = harness(), late = deferred<TokenExecutionReview>(); second.api.validate.mockReturnValue(late.promise); await second.controller.prepare(buy);
    const approving = second.controller.approve(); second.clock(now + 60_000); late.resolve(review()); await approving; expect(second.send).not.toHaveBeenCalled();
  });
  it('keeps a broadcast hash and forbids a replacement review when receipt fetching fails', async () => {
    const f = harness(); f.api.receipt.mockRejectedValueOnce(new Error('secret provider URL')); await f.controller.prepare(buy); await f.controller.approve();
    expect(f.controller.snapshot()).toMatchObject({ phase: 'submitted', hash: transactionHash }); expect(f.controller.snapshot().message).not.toContain('secret');
    await f.controller.prepare(buy); expect(f.api.review).toHaveBeenCalledOnce(); await f.controller.refreshReceipt(); expect(f.controller.snapshot().phase).toBe('confirmed'); expect(f.send).toHaveBeenCalledOnce();
  });
  it('records a broadcast under its captured owner while suppressing stale UI after a wallet prompt crosses identity change', async () => {
    const f = harness(), sent = deferred<Hex>(); f.send.mockReturnValue(sent.promise); await f.controller.prepare(buy);
    const approving = f.controller.approve(); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce()); f.change({ identityScope: 'other', userId: 'other' }); sent.resolve(transactionHash); await approving;
    expect(f.controller.snapshot()).toMatchObject({ phase: 'invalidated', hash: null });
    expect(f.pending.list('owner', from, 84532, deploymentId)).toHaveLength(1); expect(f.pending.list('other', from, 84532, deploymentId)).toHaveLength(0); expect(f.api.receipt).not.toHaveBeenCalled();
  });
  it('recovers an expired submitted review without requesting a new quote, approval or wallet call', async () => {
    const f = harness(); f.clock(now + 600_000); await f.controller.recover(reviewId, transactionHash);
    expect(f.controller.snapshot().phase).toBe('confirmed'); expect(f.api.receipt).toHaveBeenCalledExactlyOnceWith({ id: reviewId, hash: transactionHash });
    expect(f.api.review).not.toHaveBeenCalled(); expect(f.api.validate).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('requires the exact receipt review/hash and admits a verified created market only on a confirmed receipt', () => {
    expect(validateTokenExecutionReceipt({ ...confirmed(), createdMarket: { market, token } }, reviewId, transactionHash)).toMatchObject({ createdMarket: { market, token } });
    for (const value of [{ ...confirmed(), reviewId: 'other' }, { ...confirmed(), hash: hash('8') }, { ...confirmed(), finalized: true }, { ...confirmed(), status: 'reverted', createdMarket: { market, token } }]) expect(() => validateTokenExecutionReceipt(value, reviewId, transactionHash)).toThrow(TokenExecutionError);
  });
});

describe('private token API and pending storage', () => {
  it('requires the verified factory in enabled public availability and rejects a mainnet profile', () => {
    expect(validateTokenExecutionStatus({ enabled: true, network, deploymentId, factory, reason: null })).toMatchObject({ factory });
    for (const value of [{ enabled: true, network, deploymentId, reason: null }, { enabled: true, network: { ...network, chainId: 8453 }, deploymentId, factory, reason: null }]) expect(() => validateTokenExecutionStatus(value)).toThrow(TokenExecutionError);
  });
  it('never forwards a bearer token after identity changes, and ignores raw server error text', async () => {
    let scope = 'owner'; const tokenRead = deferred<string | null>(), fetcher = vi.fn();
    const api = createTokenExecutionApi({ identityScope: () => scope, getAccessToken: () => tokenRead.promise, fetcher });
    const result = api.review(buy); scope = 'other'; tokenRead.resolve('private'); await expect(result).rejects.toThrow('changed'); expect(fetcher).not.toHaveBeenCalled();
    const failed = createTokenExecutionApi({ identityScope: () => 'owner', getAccessToken: async () => 'private', fetcher: vi.fn(async () => new Response(JSON.stringify({ error: { code: 'RPC_SECRET', message: 'secret URL' } }), { status: 503 })) });
    await expect(failed.review(buy)).rejects.toThrow('unavailable'); await expect(failed.review(buy)).rejects.not.toThrow('secret');
  });
  it('preserves corrupt references and distinguishes denied storage from a successful save', () => {
    const corrupt = memory('{'), denied = { getItem: vi.fn(() => { throw new Error('private'); }), setItem: vi.fn() };
    for (const storage of [corrupt, denied]) {
      const store = createTokenPendingStore(storage, () => now);
      expect(store.remember({ userId: 'owner', from, chainId: 84532, deploymentId, reviewId, hash: transactionHash, createdAt: new Date(now).toISOString(), target: market, action: 'buy' })).toBe(false);
      expect(store.warning()).toContain('could not be saved'); expect(storage.setItem).not.toHaveBeenCalled();
    }
    expect(corrupt.values.get(TOKEN_PENDING_STORAGE_KEY)).toBe('{');
  });
});
