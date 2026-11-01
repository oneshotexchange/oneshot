import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNftLaunchApi, createNftLaunchController, NftLaunchError, sendReviewedEvmTransaction, type EvmWalletTransaction, type NftLaunchContext, type NftLaunchReview, type NftLaunchRequest } from './client-nft-launch';
import { createNftPendingStore } from './client-nft-recovery';

const from = `0x${'ab'.repeat(20)}`; const to = `0x${'cd'.repeat(20)}`; const hash = `0x${'ef'.repeat(32)}`;
const now = Date.parse('2026-10-23T12:00:00Z');
const review: NftLaunchReview = {
  id: 'review-one', reviewHash: `0x${'12'.repeat(32)}`, expiresAt: new Date(now + 120_000).toISOString(), chainId: 31337,
  from, to, data: '0x123400ff', value: '900719925474099300000001', action: 'create',
  network: { chainId: 31337, name: 'Local Anvil', nativeSymbol: 'ETH', nativeDecimals: 18 }, summary: { 'Exact public price (wei)': '1' },
  deploymentId: 'local-deployment', draftId: 'draft-one', revision: 4,
  simulation: { blockNumber: '13', blockHash: `0x${'34'.repeat(32)}`, gasEstimate: '391902' },
};
const request: NftLaunchRequest = { draftId: review.draftId, expectedRevision: review.revision, action: 'create', from, localEthAcknowledged: true };
const transaction: EvmWalletTransaction = { from, to, data: review.data, value: review.value, chainId: 31337, expectedIdentityScope: 'user:a/wallet:ab/chain:31337', expiresAt: review.expiresAt };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(pendingStore?: ReturnType<typeof createNftPendingStore>) {
  let context: NftLaunchContext = { identityScope: transaction.expectedIdentityScope, address: from, chainId: 31337, draftId: review.draftId, revision: review.revision, prepared: true, deploymentId: review.deploymentId };
  let time = now;
  const api = {
    status: vi.fn().mockResolvedValue({ enabled: true, reason: null, network: review.network, deploymentId: review.deploymentId }),
    review: vi.fn().mockResolvedValue(structuredClone(review)), validate: vi.fn().mockResolvedValue(structuredClone(review)),
    receipt: vi.fn().mockResolvedValue({ status: 'confirmed', collection: to, blockNumber: '14' }),
    submitted: vi.fn().mockResolvedValue({review,transactionHash:hash,outcome:'submitted',updatedAt:new Date(now).toISOString()}),
  };
  const send = vi.fn().mockResolvedValue(hash); const pause = vi.fn().mockResolvedValue(undefined);
  const controller = createNftLaunchController({ api, context: () => context, now: () => time, sendEvmTransaction: send, pause, receiptAttempts: 3, pendingStore });
  return { api, send, pause, controller, setContext: (fields: Partial<NftLaunchContext>) => { context = { ...context, ...fields }; }, setTime: (value: number) => { time = value; } };
}

describe('local NFT transaction controller', () => {
  it('reviews a creator policy without a draft and still requires separate wallet approval', async () => {
    const h = harness();
    const policyReview: NftLaunchReview = { ...review, scope: 'public', draftId: to, revision: 0, action: 'policy', value: '0', summary: { enabled: 'true', floorRaw: '5000000000000000000', policyCommitment: `0x${'56'.repeat(32)}`, effect: 'Applies to new listings; existing orders keep their approved prices.' } };
    h.setContext({ scope: 'public', draftId: to, revision: 0 }); h.api.review.mockResolvedValue(policyReview); h.api.validate.mockResolvedValue(policyReview);
    const input: NftLaunchRequest = { action: 'policy', from, collection: to, localEthAcknowledged: true, floorEnabled: true, floorPrice: '5' };
    await h.controller.prepare(input); expect(h.api.review).toHaveBeenCalledExactlyOnceWith(input); expect(h.send).not.toHaveBeenCalled();
    await h.controller.approve(); expect(h.send).toHaveBeenCalledExactlyOnceWith({ ...transaction, value: '0' }); expect(h.controller.getSnapshot().phase).toBe('success');
  });
  it.each(['enteredPriceRaw', 'floorPriceRaw', 'priceRaw', 'policyCommitment'])('invalidates a changed private listing %s before wallet approval', async field => {
    const h = harness();
    const listingReview: NftLaunchReview = { ...review, action: 'list', value: '0', summary: { enteredPriceRaw: '4000000000000000000', floorPriceRaw: '5000000000000000000', priceRaw: '9000000000000000000', policyCommitment: `0x${'56'.repeat(32)}` } };
    h.api.review.mockResolvedValue(listingReview); h.api.validate.mockResolvedValue({ ...listingReview, summary: { ...listingReview.summary, [field]: field === 'policyCommitment' ? `0x${'78'.repeat(32)}` : '1' } });
    await h.controller.prepare({ ...request, action: 'list', collection: to, tokenId: '1', price: '4' });
    expect(h.controller.getSnapshot().review?.summary).toEqual(listingReview.summary); expect(h.send).not.toHaveBeenCalled();
    await h.controller.approve(); expect(h.controller.getSnapshot().phase).toBe('invalidated'); expect(h.send).not.toHaveBeenCalled();
  });
  it('reviews a public collection without using the creator’s private draft', async () => {
    const h=harness(); const publicReview={...review,scope:'public' as const,draftId:to,revision:0,action:'mint' as const};
    h.setContext({scope:'public',draftId:to,revision:0}); h.api.review.mockResolvedValue(publicReview);h.api.validate.mockResolvedValue(publicReview);
    const publicInput:NftLaunchRequest={from,collection:to,action:'mint',quantity:'2',localEthAcknowledged:true};
    await h.controller.prepare(publicInput);expect(h.api.review).toHaveBeenCalledExactlyOnceWith(publicInput);expect(h.controller.getSnapshot().phase).toBe('review');
    await h.controller.approve();expect(h.controller.getSnapshot().phase).toBe('success');expect(h.send).toHaveBeenCalledOnce();
    const changed=harness();changed.setContext({scope:'public',draftId:to,revision:0});
    await changed.controller.prepare({...publicInput,draftId:'creator-private-draft',expectedRevision:4});expect(changed.api.review).not.toHaveBeenCalled();
  });
  it('reviews a collection-less marketplace claim only for the selected public contract and a separate approval', async () => {
    const h = harness();
    const claimReview: NftLaunchReview = { ...review, action: 'claim', scope: 'public', draftId: to, revision: 0, value: '0', summary: { contract: to, claimAmountRaw: '7000000000000000001', recipient: from } };
    h.setContext({ scope: 'public', draftId: to, revision: 0 }); h.api.review.mockResolvedValue(claimReview); h.api.validate.mockResolvedValue(claimReview);
    const input: NftLaunchRequest = { from, action: 'claim', contract: to.toUpperCase(), localEthAcknowledged: true };
    await h.controller.prepare(input);
    expect(h.api.review).toHaveBeenCalledExactlyOnceWith(input); expect(h.controller.getSnapshot().phase).toBe('review');
    expect(h.send).not.toHaveBeenCalled(); expect(h.api.validate).not.toHaveBeenCalled();
    await h.controller.approve(); expect(h.send).toHaveBeenCalledExactlyOnceWith({ ...transaction, value: '0' });
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'success', review: { draftId: to, revision: 0, action: 'claim', scope: 'public' } });
  });
  it.each([
    { contract: from }, { contract: undefined }, { contract: 'marketplace' }, { collection: from }, { collection: '' },
    { action: 'mint' }, { action: 'configure' }, { draftId: 'creator-private-draft' }, { expectedRevision: 0 },
  ])('rejects collection-less public claims with a wrong target, action or draft parameters: %j', async fields => {
    const h = harness(); h.setContext({ scope: 'public', draftId: to, revision: 0 });
    await h.controller.prepare({ from, action: 'claim', contract: to, localEthAcknowledged: true, ...fields } as NftLaunchRequest);
    expect(h.api.review).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); expect(h.api.receipt).not.toHaveBeenCalled();
  });
  it('invalidates a standalone claim when the pending amount changes during exact approval validation', async () => {
    const h = harness();
    const claimReview: NftLaunchReview = { ...review, action: 'claim', scope: 'public', draftId: to, revision: 0, value: '0', summary: { contract: to, claimAmountRaw: '900719925474099300000001', recipient: from } };
    h.setContext({ scope: 'public', draftId: to, revision: 0 }); h.api.review.mockResolvedValue(claimReview);
    h.api.validate.mockResolvedValue({ ...claimReview, summary: { ...claimReview.summary, claimAmountRaw: '900719925474099300000002' } });
    await h.controller.prepare({ from, action: 'claim', contract: to, localEthAcknowledged: true }); await h.controller.approve();
    expect(h.api.validate).toHaveBeenCalledExactlyOnceWith({ reviewId: claimReview.id, reviewHash: claimReview.reviewHash });
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'invalidated', review: null, hash: null });
    expect(h.send).not.toHaveBeenCalled(); expect(h.api.submitted).not.toHaveBeenCalled(); expect(h.api.receipt).not.toHaveBeenCalled();
  });
  it('recovers an expired public marketplace-address claim without another wallet submission', async () => {
    const h = harness();
    const claimReview: NftLaunchReview = { ...review, action: 'claim', scope: 'public', draftId: to, revision: 0, value: '0', summary: { contract: to, claimAmountRaw: '7', recipient: from } };
    h.setContext({ scope: 'public', draftId: to, revision: 0, userId: 'account-a', identityScope: 'account-a:new-session' }); h.setTime(now + 600_000);
    h.api.receipt.mockResolvedValue({ status: 'confirmed', blockNumber: '20' });
    await h.controller.recover({ review: claimReview, transactionHash: hash, outcome: 'submitted', updatedAt: new Date(now).toISOString() });
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'success', hash, review: { draftId: to, action: 'claim' } });
    expect(h.send).not.toHaveBeenCalled(); expect(h.api.review).not.toHaveBeenCalled(); expect(h.api.validate).not.toHaveBeenCalled();
    expect(h.api.receipt).toHaveBeenCalledExactlyOnceWith({ reviewId: claimReview.id, hash });
  });
  it.each([{selectionKey:'item:1/listing:2'},{termsHash:`0x${'56'.repeat(32)}`}])('invalidates a review when its item, listing or displayed terms change within the same collection: %j',async fields=>{
    const h=harness();h.setContext({selectionKey:'item:1/listing:1'});await h.controller.prepare(request);
    h.setContext(fields);h.controller.syncContext();await h.controller.approve();
    expect(h.controller.getSnapshot()).toMatchObject({phase:'invalidated',review:null});expect(h.send).not.toHaveBeenCalled();expect(h.api.validate).not.toHaveBeenCalled();
  });
  it('persists the returned wallet hash before querying its receipt', async () => {
    const h=harness(),events:string[]=[];
    h.send.mockImplementation(async()=>{events.push('send');return hash;});h.api.submitted.mockImplementation(async()=>{events.push('persist');return {review,transactionHash:hash,outcome:'submitted',updatedAt:new Date(now).toISOString()};});h.api.receipt.mockImplementation(async()=>{events.push('receipt');return {status:'confirmed'};});
    await h.controller.prepare(request);await h.controller.approve();expect(events).toEqual(['send','persist','receipt']);
    expect(h.api.submitted).toHaveBeenCalledExactlyOnceWith({reviewId:review.id,reviewHash:review.reviewHash,hash});
  });
  it('retains a browser fallback if server submission persistence fails and recovers without sending again', async () => {
    let saved='[]';const store=createNftPendingStore({getItem:()=>saved,setItem:(_key,value)=>{saved=value;}},()=>now);
    const h=harness(store);h.setContext({userId:'account-a'});h.api.submitted.mockRejectedValue(new Error('API restarted after wallet broadcast'));
    await h.controller.prepare(request);await h.controller.approve();expect(h.controller.getSnapshot()).toMatchObject({phase:'error',hash});expect(h.api.receipt).not.toHaveBeenCalled();
    expect(store.list('account-a')).toEqual([expect.objectContaining({reviewId:review.id,reviewHash:review.reviewHash,hash,from})]);expect(store.list('account-b')).toEqual([]);
    const restarted=harness(store);restarted.setContext({userId:'account-a',identityScope:'account-a:new-session'});restarted.setTime(now+600_000);
    await restarted.controller.recover({review,transactionHash:null,outcome:'review',updatedAt:new Date(now).toISOString()},hash);
    expect(restarted.controller.getSnapshot()).toMatchObject({phase:'success',hash});expect(restarted.send).not.toHaveBeenCalled();expect(restarted.api.validate).not.toHaveBeenCalled();expect(store.list('account-a')).toEqual([]);
  });
  it('keeps an already-broadcast hash under its captured account after logout without exposing it to the next account', async () => {
    let saved='[]';const store=createNftPendingStore({getItem:()=>saved,setItem:(_key,value)=>{saved=value;}},()=>now);
    const h=harness(store),broadcast=deferred<string>();h.setContext({userId:'account-a'});h.send.mockReturnValue(broadcast.promise);
    await h.controller.prepare(request);const approving=h.controller.approve();await vi.waitFor(()=>expect(h.send).toHaveBeenCalledOnce());
    h.setContext({userId:'account-b',identityScope:'account-b',address:to});h.controller.syncContext();broadcast.resolve(hash);await approving;
    expect(h.controller.getSnapshot()).toMatchObject({phase:'invalidated',hash:null});expect(h.api.submitted).not.toHaveBeenCalled();expect(h.api.receipt).not.toHaveBeenCalled();
    expect(store.list('account-a')).toHaveLength(1);expect(store.list('account-b')).toEqual([]);
  });
  it('only recovers broadcasts for the selected local wallet and deployment', async () => {
    const saved={review,transactionHash:hash,outcome:'submitted' as const,updatedAt:new Date(now).toISOString()};
    for(const fields of [{address:to},{chainId:1},{deploymentId:'another-deployment'}]){const h=harness();h.setContext(fields);await h.controller.recover(saved);expect(h.api.submitted).not.toHaveBeenCalled();expect(h.api.receipt).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled();}
    const unsigned=harness();await unsigned.controller.recover({...saved,transactionHash:null,outcome:'review'});expect(unsigned.api.receipt).not.toHaveBeenCalled();expect(unsigned.send).not.toHaveBeenCalled();
  });
  it('only prepares a review until a separate approval; validates the exact call and confirms its receipt', async () => {
    const h = harness();
    await h.controller.prepare(request);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'review', review });
    expect(h.send).not.toHaveBeenCalled(); expect(h.api.validate).not.toHaveBeenCalled();
    // Revalidation can update the simulation without changing the reviewed transaction.
    h.api.validate.mockResolvedValue({ ...review, simulation: { ...review.simulation, blockNumber: '14', gasEstimate: '392000' } });
    await h.controller.approve();
    expect(h.api.validate).toHaveBeenCalledExactlyOnceWith({ reviewId: review.id, reviewHash: review.reviewHash });
    expect(h.send).toHaveBeenCalledExactlyOnceWith(transaction);
    expect(h.api.receipt).toHaveBeenCalledExactlyOnceWith({ reviewId: review.id, hash });
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'success', hash, receipt: { status: 'confirmed', collection: to } });
  });
  it('requires the acknowledgement, prepared draft and selected local sender', async () => {
    const h = harness();
    await h.controller.prepare({ ...request, localEthAcknowledged: false } as unknown as NftLaunchRequest);
    expect(h.api.review).not.toHaveBeenCalled();
    await h.controller.prepare({ ...request, from: to });
    expect(h.api.review).not.toHaveBeenCalled();
    h.setContext({ prepared: false }); await h.controller.prepare(request);
    expect(h.controller.getSnapshot().phase).toBe('invalidated');
    expect(h.api.review).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
  it.each([
    ['value', '900719925474099300000002'], ['data', '0x123400fe'], ['to', from], ['from', to],
    ['deploymentId', 'replacement-local-deployment'], ['reviewHash', `0x${'99'.repeat(32)}`], ['revision', 5], ['action', 'open'],
    ['summary', { 'Exact public price (wei)': '2' }],
  ])('invalidates a validation response whose %s changed', async (field, value) => {
    const h = harness(); await h.controller.prepare(request);
    h.api.validate.mockResolvedValue({ ...review, [field]: value }); await h.controller.approve();
    expect(h.controller.getSnapshot().phase).toBe('invalidated'); expect(h.send).not.toHaveBeenCalled();
  });
  it('rejects expired reviews before requesting a wallet and expires while validation is in flight', async () => {
    const h = harness(); await h.controller.prepare(request); h.setTime(now + 120_000); await h.controller.approve();
    expect(h.controller.getSnapshot().phase).toBe('invalidated'); expect(h.api.validate).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
    const delayed = harness(); const result = deferred<NftLaunchReview>(); await delayed.controller.prepare(request);
    delayed.api.validate.mockReturnValue(result.promise); const approval = delayed.controller.approve();
    delayed.setTime(now + 120_001); result.resolve(review); await approval;
    expect(delayed.controller.getSnapshot().phase).toBe('invalidated'); expect(delayed.send).not.toHaveBeenCalled();
  });
  it('binds the complete summary while allowing a different key order', async () => {
    const added = harness(); await added.controller.prepare(request);
    added.api.validate.mockResolvedValue({ ...review, summary: { ...review.summary, effect: 'Unexpected new effect' } });
    await added.controller.approve(); expect(added.controller.getSnapshot().phase).toBe('invalidated'); expect(added.send).not.toHaveBeenCalled();
    const reordered = harness();
    reordered.api.review.mockResolvedValue({ ...review, summary: { price: '1', effect: 'Create collection' } });
    reordered.api.validate.mockResolvedValue({ ...review, summary: { effect: 'Create collection', price: '1' } });
    await reordered.controller.prepare(request); await reordered.controller.approve();
    expect(reordered.controller.getSnapshot().phase).toBe('success'); expect(reordered.send).toHaveBeenCalledOnce();
    const malformed = harness(); malformed.api.review.mockResolvedValue({ ...review, summary: null });
    await malformed.controller.prepare(request); expect(malformed.controller.getSnapshot().phase).toBe('invalidated'); expect(malformed.send).not.toHaveBeenCalled();
  });
  it.each([
    { identityScope: null, address: null }, { identityScope: 'user:b', address: to },
    { chainId: 1 }, { revision: 5 }, { deploymentId: 'new-deployment' }, { prepared: false },
  ])('discards an in-flight review after context changes: %j', async fields => {
    const h = harness(); const result = deferred<NftLaunchReview>(); h.api.review.mockReturnValue(result.promise);
    const pending = h.controller.prepare(request); h.setContext(fields); result.resolve(review); await pending;
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'invalidated', review: null, hash: null }); expect(h.send).not.toHaveBeenCalled();
  });
  it('does not send after a selected chain changes while validation is in flight', async () => {
    const h = harness(); await h.controller.prepare(request); const result = deferred<NftLaunchReview>(); h.api.validate.mockReturnValue(result.promise);
    const pending = h.controller.approve(); h.setContext({ chainId: 8453 }); result.resolve(review); await pending;
    expect(h.controller.getSnapshot().phase).toBe('invalidated'); expect(h.send).not.toHaveBeenCalled();
  });
  it('does not surface an old wallet hash or receipt after logout during wallet approval', async () => {
    const h = harness(); await h.controller.prepare(request); const result = deferred<string>(); h.send.mockReturnValue(result.promise);
    const pending = h.controller.approve(); await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    h.setContext({ identityScope: null, address: null }); h.controller.syncContext(); result.resolve(hash); await pending;
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'invalidated', review: null, hash: null }); expect(h.api.receipt).not.toHaveBeenCalled();
  });
  it('ignores an older review completion after a newer request', async () => {
    const h = harness(); const old = deferred<NftLaunchReview>(); h.api.review.mockReturnValueOnce(old.promise);
    const pending = h.controller.prepare(request); await h.controller.prepare(request);
    expect(h.controller.getSnapshot().phase).toBe('review');
    old.reject(new Error('Old request failed')); await pending;
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'review', message: null });
  });
  it('treats wallet rejection as rejected without querying a receipt or retrying the signature', async () => {
    const h = harness(); h.send.mockRejectedValue({ code: 4001, message: 'User rejected the request' });
    await h.controller.prepare(request); await h.controller.approve(); await h.controller.approve();
    expect(h.controller.getSnapshot().phase).toBe('rejected'); expect(h.send).toHaveBeenCalledOnce(); expect(h.api.receipt).not.toHaveBeenCalled();
  });
  it('bounds pending receipt polling, permits an explicit refresh after review expiry, and reports reverts', async () => {
    const h = harness(); h.api.receipt.mockResolvedValue({ status: 'pending' }); await h.controller.prepare(request); await h.controller.approve();
    expect(h.api.receipt).toHaveBeenCalledTimes(3); expect(h.pause).toHaveBeenCalledTimes(2);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'submitted', hash });
    h.setTime(now + 121_000); h.api.receipt.mockResolvedValue({ status: 'reverted' }); await h.controller.refreshReceipt();
    expect(h.api.receipt).toHaveBeenCalledTimes(4); expect(h.controller.getSnapshot().phase).toBe('reverted'); expect(h.send).toHaveBeenCalledOnce();
  });
  it.each([new Error('Local RPC unavailable'), new NftLaunchError('The receipt was reorganized.', 'RECEIPT_REORGED', 409)])('retains an unresolved hash after a receipt error until an explicit retry confirms it', async error => {
    const h = harness(); h.api.receipt.mockRejectedValueOnce(error);
    await h.controller.prepare(request); await h.controller.approve();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'error', hash, review });
    await h.controller.prepare(request);
    expect(h.api.review).toHaveBeenCalledOnce(); expect(h.send).toHaveBeenCalledOnce();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'error', hash });
    await h.controller.refreshReceipt();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'success', hash, receipt: { status: 'confirmed' } });
    await h.controller.prepare(request); expect(h.api.review).toHaveBeenCalledTimes(2);
  });
  it('blocks double approval while the first validation is pending', async () => {
    const h = harness(); await h.controller.prepare(request); const result = deferred<NftLaunchReview>(); h.api.validate.mockReturnValue(result.promise);
    const pending = h.controller.approve(); await h.controller.approve(); expect(h.api.validate).toHaveBeenCalledOnce();
    result.resolve(review); await pending; expect(h.send).toHaveBeenCalledOnce();
  });
  it('invalidates a server stale-review response without opening the wallet', async () => {
    const h = harness(); await h.controller.prepare(request); h.api.validate.mockRejectedValue(new NftLaunchError('The local deployment changed.', 'DEPLOYMENT_CHANGED', 409));
    await h.controller.approve(); expect(h.controller.getSnapshot().phase).toBe('invalidated'); expect(h.send).not.toHaveBeenCalled();
  });
});

describe('reviewed EVM provider bridge', () => {
  function providerHarness() {
    let scope: string | null = transaction.expectedIdentityScope;
    let time = now; const transactionInput = { ...transaction };
    const request = vi.fn(async (input: { method: string; params?: unknown[] }): Promise<unknown> => {
      if (input.method === 'eth_chainId') return '0x7a69'; if (input.method === 'eth_accounts') return [from]; if (input.method === 'eth_sendTransaction') return hash;
      throw new Error(`Unexpected method ${input.method}`);
    });
    const getProvider = vi.fn(async () => ({ request }));
    const send = () => sendReviewedEvmTransaction({ transaction: transactionInput, identityScope: () => scope, getProvider, now: () => time });
    return { request, getProvider, send, transaction: transactionInput, setScope: (value: string | null) => { scope = value; }, setTime: (value: number) => { time = value; } };
  }
  it('passes exact reviewed calldata and lossless value to eth_sendTransaction with the local chain id', async () => {
    const h = providerHarness(); await expect(h.send()).resolves.toBe(hash);
    expect(h.request.mock.calls.map(([input]) => input.method)).toEqual(['eth_chainId', 'eth_accounts', 'eth_chainId', 'eth_sendTransaction']);
    expect(h.request).toHaveBeenLastCalledWith({ method: 'eth_sendTransaction', params: [{ from, to, data: review.data, value: `0x${BigInt(review.value).toString(16)}`, chainId: '0x7a69' }] });
  });
  it('does not send if Privy identity changes while the provider is loading', async () => {
    const h = providerHarness(); const loaded = deferred<{ request: typeof h.request }>(); h.getProvider.mockReturnValue(loaded.promise);
    const pending = h.send(); h.setScope('different-account'); loaded.resolve({ request: h.request });
    await expect(pending).rejects.toThrow('account or wallet changed'); expect(h.request).not.toHaveBeenCalled();
  });
  it('copies the exact reviewed transaction before asynchronous provider checks', async () => {
    const h = providerHarness(); const loaded = deferred<{ request: typeof h.request }>(); h.getProvider.mockReturnValue(loaded.promise);
    const pending = h.send();
    Object.assign(h.transaction, { to: from, data: '0xabcd', value: '1', expiresAt: new Date(now - 1).toISOString(), expectedIdentityScope: 'unreviewed-scope' });
    loaded.resolve({ request: h.request }); await expect(pending).resolves.toBe(hash);
    expect(h.request).toHaveBeenLastCalledWith({ method: 'eth_sendTransaction', params: [{ from, to, data: review.data, value: `0x${BigInt(review.value).toString(16)}`, chainId: '0x7a69' }] });
  });
  it('refuses an already-expired review before provider discovery', async () => {
    const h = providerHarness(); h.setTime(now + 120_000);
    await expect(h.send()).rejects.toMatchObject({ code: 'REVIEW_EXPIRED' }); expect(h.getProvider).not.toHaveBeenCalled();
  });
  it('checks expiry after the final chain probe before opening wallet approval', async () => {
    const h = providerHarness(); let chainReads = 0;
    h.request.mockImplementation(async input => {
      if (input.method === 'eth_chainId') { chainReads += 1; if (chainReads === 2) h.setTime(now + 120_000); return '0x7a69'; }
      if (input.method === 'eth_accounts') return [from];
      throw new Error('Expired review must not reach the signing request');
    });
    await expect(h.send()).rejects.toMatchObject({ code: 'REVIEW_EXPIRED' });
    expect(h.request.mock.calls.map(([input]) => input.method)).toEqual(['eth_chainId', 'eth_accounts', 'eth_chainId']);
  });
  it('retains a submitted hash if an already-open wallet prompt crosses review expiry', async () => {
    const h = providerHarness();
    h.request.mockImplementation(async input => {
      if (input.method === 'eth_chainId') return '0x7a69'; if (input.method === 'eth_accounts') return [from];
      h.setTime(now + 120_001); return hash;
    });
    await expect(h.send()).resolves.toBe(hash);
  });
  it('does not send if identity changes during account discovery', async () => {
    const h = providerHarness(); h.request.mockImplementation(async input => {
      if (input.method === 'eth_chainId') return '0x7a69'; h.setScope(null); return [from];
    });
    await expect(h.send()).rejects.toThrow('account or wallet changed'); expect(h.request.mock.calls.some(([input]) => input.method === 'eth_sendTransaction')).toBe(false);
  });
  it('requires the selected sender and refuses to switch or send on another network', async () => {
    const h = providerHarness(); h.request.mockResolvedValue('0x1'); await expect(h.send()).rejects.toThrow('test network (31337)');
    expect(h.request).toHaveBeenCalledOnce();
    const other = providerHarness(); other.request.mockImplementation(async input => input.method === 'eth_chainId' ? '0x7a69' : [to]);
    await expect(other.send()).rejects.toThrow('sender is no longer available'); expect(other.request.mock.calls.some(([input]) => input.method === 'eth_sendTransaction')).toBe(false);
  });
  it('catches provider chain changes after account discovery', async () => {
    const h = providerHarness(); h.request.mockResolvedValueOnce('0x7a69').mockResolvedValueOnce([from]).mockResolvedValueOnce('0x1');
    await expect(h.send()).rejects.toThrow('wallet network changed'); expect(h.request).toHaveBeenCalledTimes(3);
  });
  it('does not open wallet approval if the review expires during asynchronous provider loading', async () => {
    let time = now; const provider = { request: vi.fn<(input: { method: string; params?: unknown[] }) => Promise<unknown>>() }; const loaded = deferred<typeof provider>();
    const pending = sendReviewedEvmTransaction({ transaction, identityScope: () => transaction.expectedIdentityScope, getProvider: () => loaded.promise, now: () => time });
    time += 120_000; loaded.resolve(provider);
    await expect(pending).rejects.toThrow('review expired'); expect(provider.request).not.toHaveBeenCalled();
  });
});

describe('local launch API', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('keeps status public, obtains fresh bearer tokens per review and disables cookies and redirects', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.oneshot.app');
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(review))); const token = vi.fn().mockResolvedValueOnce('one').mockResolvedValueOnce('two');
    const api = createNftLaunchApi({ identityScope: () => 'current-user', getAccessToken: token, fetcher });
    await api.status(); await api.review(request); await api.validate({ reviewId: review.id, reviewHash: review.reviewHash });
    expect(token).toHaveBeenCalledTimes(2); expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer one'); expect(new Headers(fetcher.mock.calls[2][1]?.headers).get('Authorization')).toBe('Bearer two');
    expect(fetcher.mock.calls[1][0]).toBe('https://api.oneshot.app/api/oneshot/launch/review');
    expect(fetcher.mock.calls[1][1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', body: JSON.stringify(request) });
  });
  it('does not forward a token or return a result after identity changes', async () => {
    let scope = 'user:a'; const token = deferred<string>(); const fetcher = vi.fn<typeof fetch>();
    const api = createNftLaunchApi({ identityScope: () => scope, getAccessToken: () => token.promise, fetcher });
    const pending = api.review(request); scope = 'user:b'; token.resolve('old-token');
    await expect(pending).rejects.toThrow('account or wallet changed'); expect(fetcher).not.toHaveBeenCalled();
    const body = deferred<Response>(); const nextApi = createNftLaunchApi({ identityScope: () => scope, getAccessToken: async () => 'token', fetcher: () => body.promise });
    const response = nextApi.review(request); await Promise.resolve(); scope = 'user:c'; body.resolve(new Response(JSON.stringify(review)));
    await expect(response).rejects.toThrow('account or wallet changed');
  });
  it('preserves a conflict code so the controller can invalidate a stale review', async () => {
    const api = createNftLaunchApi({ identityScope: () => 'user', getAccessToken: async () => 'token', fetcher: async () => new Response(JSON.stringify({ error: { code: 'REVIEW_EXPIRED', message: 'Review expired.' } }), { status: 409 }) });
    await expect(api.validate({ reviewId: review.id, reviewHash: review.reviewHash })).rejects.toMatchObject({ code: 'REVIEW_EXPIRED', status: 409, message: 'Review expired.' });
  });
  it('loads public contract terms without a token and protects all recovery routes with fresh tokens', async () => {
    const terms={network:review.network,deploymentId:review.deploymentId,collection:to,creator:from,name:'Originals',symbol:'SHOT',opened:true,totalMintedRaw:'1',termsHash:hash,blockNumber:'20',blockHash:hash,blockTimestamp:'1800000000',terms:{maxSupplyRaw:'10',royaltyBps:500,allowlistRoot:hash,contentHash:hash,metadataBaseURI:'https://art.oneshot.app/items/',collectionURI:'https://art.oneshot.app/collection.json',allowlist:{start:'1',end:'2',walletLimitRaw:'2',priceRaw:'1000000000000000000'},publicMint:{start:'2',end:'9999999999',walletLimitRaw:'2',priceRaw:'2000000000000000000'}}};
    const fetcher=vi.fn<typeof fetch>(async(url)=>new Response(JSON.stringify(String(url).includes('/collections/')?terms:{items:[]}))),token=vi.fn().mockResolvedValue('fresh');
    const api=createNftLaunchApi({identityScope:()=> 'scope',getAccessToken:token,fetcher});
    expect(await api.collection(to)).toMatchObject({collection:to,terms:{maxSupplyRaw:'10'}});expect(token).not.toHaveBeenCalled();
    await api.transactions({wallet:from,limit:20,cursor:'next/page'});await api.reviewRecord('review/id');await api.submitted({reviewId:review.id,reviewHash:review.reviewHash,hash});
    expect(token).toHaveBeenCalledTimes(3);expect(String(fetcher.mock.calls[1][0])).toContain(`wallet=${from}`);expect(String(fetcher.mock.calls[1][0])).toContain('cursor=next%2Fpage');expect(String(fetcher.mock.calls[2][0])).toContain('reviews/review%2Fid');
    expect(fetcher.mock.calls.slice(1).every(([,options])=>new Headers(options?.headers).get('authorization')==='Bearer fresh')).toBe(true);
    const invalid=createNftLaunchApi({identityScope:()=>null,getAccessToken:async()=>null,fetcher:async()=>new Response(JSON.stringify({...terms,terms:{...terms.terms,maxSupplyRaw:'1.5'}}))});
    await expect(invalid.collection(to)).rejects.toMatchObject({code:'INVALID_COLLECTION'});
  });
  it('loads private earnings with a fresh bearer, fixed API destination, encoded cursor and cancellation', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.oneshot.app');
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ items: [], nextCursor: null }));
    const token = vi.fn().mockResolvedValueOnce('first-token').mockResolvedValueOnce('second-token');
    const api = createNftLaunchApi({ identityScope: () => 'current-user', getAccessToken: token, fetcher });
    const abort = new AbortController();
    await api.earnings({ wallet: from.toUpperCase(), cursor: 'next/page?checkpoint=1' }, abort.signal); await api.earnings({ wallet: from });
    expect(String(fetcher.mock.calls[0][0])).toBe(`https://api.oneshot.app/api/oneshot/launch/earnings?wallet=${from}&cursor=next%2Fpage%3Fcheckpoint%3D1`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: abort.signal });
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer first-token');
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer second-token');
    expect(token).toHaveBeenCalledTimes(2);
    expect(() => api.earnings({ wallet: 'https://outside.example' })).toThrow('linked wallet');
    expect(() => api.earnings({ wallet: from, cursor: '' })).toThrow('refresh its earnings');
    expect(() => api.earnings({ wallet: from, cursor: 'x'.repeat(2049) })).toThrow('refresh its earnings');
    abort.abort(); await expect(api.earnings({ wallet: from }, abort.signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not expose private earnings after the authenticated identity changes', async () => {
    let scope = 'account-a'; const response = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(() => response.promise);
    const api = createNftLaunchApi({ identityScope: () => scope, getAccessToken: async () => 'account-a-token', fetcher });
    const pending = api.earnings({ wallet: from }); await Promise.resolve(); scope = 'account-b';
    response.resolve(Response.json({ items: [{ pendingRaw: '123' }] }));
    await expect(pending).rejects.toThrow('account or wallet changed');
  });
  it('keeps status public while forwarding read cancellation without requesting an access token', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ enabled: false })), token = vi.fn();
    const api = createNftLaunchApi({ identityScope: () => null, getAccessToken: token, fetcher }), abort = new AbortController();
    await api.status(abort.signal); expect(fetcher.mock.calls[0][1]?.signal).toBe(abort.signal);
    expect(token).not.toHaveBeenCalled(); abort.abort(); await expect(api.status(abort.signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
