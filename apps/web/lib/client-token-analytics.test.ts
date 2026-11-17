import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BASE_SEPOLIA_GENESIS_HASH, BASE_SEPOLIA_POOL_MANAGER, nftNetworkForChainId, type IndexedTokenMarket, type TokenAnalyticsContext, type TokenAnalyticsMarketResponse, type TokenAnalyticsTradesResponse, type TokenAnalyticsHoldersResponse, type TokenPoolSwap, type TokenOneshotTrade } from '@oneshot/evm';
import { TokenAnalyticsHolders, TokenAnalyticsMetrics, TokenAnalyticsTrades } from '../components/token-analytics';
import { readTokenAnalyticsMarket, tokenAnalyticsCheckpointKey, tokenAnalyticsSourceMatches, tokenAnalyticsPagePath, TokenAnalyticsPageLoader, TokenAnalyticsReadError, validateTokenAnalyticsHolders, validateTokenAnalyticsMarket, validateTokenAnalyticsTrades, validTokenAnalyticsContext, type TokenAnalyticsPageRequest } from './client-token-analytics';
import { tokenPoolChartPoints } from './token-price-chart';

const address = (n: string) => `0x${n.repeat(40)}`, hash = (n: string) => `0x${n.repeat(64)}`, marketAddress = address('1'), token = address('2');
const sourceContract = (n: string) => ({ address: address(n), codeHash: hash(n) });
const context = (): TokenAnalyticsContext => ({ schemaVersion: 1, kind: 'canonical-event-journal', enabled: true, available: true, reason: null, deploymentId: 'a'.repeat(64), network: nftNetworkForChainId(84532)!,
  source: { chainId: 84532, genesisHash: BASE_SEPOLIA_GENESIS_HASH, factory: sourceContract('3'), poolManager: { ...sourceContract('4'), address: BASE_SEPOLIA_POOL_MANAGER }, oracle: sourceContract('5'), quoter: sourceContract('6') },
  checkpoint: { number: '100', hash: hash('a'), parentHash: hash('b'), timestamp: '1794816000' }, observedHeadNumber: '103', lagBlocks: '3', readonly: true, finalized: false });
const disabled = (): TokenAnalyticsContext => ({ schemaVersion: 1, kind: 'canonical-event-journal', enabled: false, available: false, reason: 'unavailable', deploymentId: null, network: null, source: null, checkpoint: null, observedHeadNumber: null, lagBlocks: null, readonly: true, finalized: false });
const market = (): IndexedTokenMarket => ({ schemaVersion: 1, market: marketAddress, token, creator: address('7'), platformRecipient: address('8'), name: 'Orbit', symbol: 'ORBIT', tokenDecimals: 8, initialSupplyRaw: '100000000000000000', totalSupplyRaw: '99999999999999999', executionFeeBps: 150, liquidityAndBurn: false,
  openingValuationNativeRaw: '1000000000000000001', effectiveOpeningValuationNativeRaw: '1000000000000000002', effectiveUpperValuationNativeRaw: '40000000000000000000', poolId: hash('9'), lpFeePips: 2500, tickSpacing: 10, tickLower: -100, tickUpper: 100, lockedLiquidityRaw: '9007199254740993', lockedRoundingDustRaw: '1', observedMarketCodeHash: hash('c'), observedTokenCodeHash: hash('d') });
const detail = (): TokenAnalyticsMarketResponse => ({ context: context(), market: market(), analytics: { market: marketAddress, token, creator: address('7'), poolId: hash('9'), tokenDecimals: 8, observedSupplyRaw: '99999999999999999', mintedRaw: '100000000000000000', burnedRaw: '1', holderCount: '3', holderScope: 'all-nonzero-balance-addresses',
  poolSwaps: '2', poolNativeVolumeRaw: '9007199254740993000000001', poolTokenVolumeRaw: '100000001', oneshotTrades: '1', oneshotBuys: '1', oneshotSells: '0', oneshotGrossNativeVolumeRaw: '1000000000000000001', oneshotExecutionFeesRaw: '15000000000000000',
  price: { sqrtPriceX96Raw: (2n ** 96n).toString(), tick: 0, nativeRawPerWholeToken: { numerator: (2n ** 192n * 100000000n).toString(), denominator: (2n ** 192n).toString() }, blockNumber: '98', blockHash: hash('e') } } });
const poolSwap = (changes: Partial<TokenPoolSwap> = {}): TokenPoolSwap => ({ id: `${hash('f')}:1`, market: marketAddress, blockNumber: '99', blockHash: hash('c'), timestamp: '1794815999', transactionHash: hash('f'), transactionIndex: 0, logIndex: 1, kind: 'pool-swap', poolId: hash('9'), poolSender: address('a'), trader: null, recipient: null,
  amount0Raw: '-1000000000000000001', amount1Raw: '123456789', sqrtPriceX96Raw: (2n ** 96n).toString(), liquidityRaw: '9007199254740993', tick: 0, feePips: 2500, ...changes });
const oneshot = (): TokenOneshotTrade => ({ id: `${hash('f')}:2`, market: marketAddress, blockNumber: '99', blockHash: hash('c'), timestamp: '1794815999', transactionHash: hash('f'), transactionIndex: 0, logIndex: 2, kind: 'oneshot-trade', token, trader: address('b'), recipient: address('c'), buy: true, tokensRaw: '123456789', grossNativeRaw: '1000000000000000001', netNativeRaw: '985000000000000001', executionFeeRaw: '15000000000000000' });
const request = (view: TokenAnalyticsPageRequest['view'] = 'pool-swap'): TokenAnalyticsPageRequest => ({ market: marketAddress, view, reference: { token, poolId: hash('9'), executionFeeBps: 150 } });
const trades = (): TokenAnalyticsTradesResponse => ({ context: context(), market: marketAddress, kind: 'pool-swap', items: [poolSwap()], nextCursor: null });
const holders = (): TokenAnalyticsHoldersResponse => ({ context: context(), market: marketAddress, token, scope: 'all-nonzero-balance-addresses', items: [{ wallet: address('5'), balanceRaw: '9007199254740993', lastBlockNumber: '99', lastBlockHash: hash('c') }], nextCursor: null });

describe('canonical token analytics admission', () => {
  it('preserves exact ETH/token amounts, all-route scope and a price unrelated to opening valuation', () => {
    const response = validateTokenAnalyticsMarket(detail(), marketAddress);
    expect(response.analytics?.poolNativeVolumeRaw).toBe('9007199254740993000000001');
    const html = renderToStaticMarkup(createElement(TokenAnalyticsMetrics, { response }));
    for (const text of ['0.0000000001', '9007199.254740993000000001', '1.000000000000000001', '0.015', 'Pool swap volume', 'all routes', 'oneshot execution fees', 'including contracts', 'PoolManager', 'block 100', 'head 103', '3 blocks behind', 'overlaps', 'profit and loss is unavailable']) expect(html).toContain(text);
    expect(html).not.toContain('1.000000000000000002'); expect(html).not.toMatch(/24h|Live volume|Token price from opening|zero holders/);
  });
  it('permits zero activity, an initial price without swaps, and cumulative volume larger than uint256', () => {
    const empty = detail(); Object.assign(empty.analytics!, { poolSwaps: '0', poolNativeVolumeRaw: '0', poolTokenVolumeRaw: '0', oneshotTrades: '0', oneshotBuys: '0', oneshotSells: '0', oneshotGrossNativeVolumeRaw: '0', oneshotExecutionFeesRaw: '0' });
    expect(validateTokenAnalyticsMarket(empty, marketAddress).analytics?.oneshotTrades).toBe('0');
    const large = detail(); large.analytics!.poolNativeVolumeRaw = (2n ** 256n * 1000n + 123n).toString();
    expect(validateTokenAnalyticsMarket(large, marketAddress).analytics?.poolNativeVolumeRaw).toBe(large.analytics?.poolNativeVolumeRaw);
  });
  it('treats disabled/not-yet-journaled records as unavailable and never accepts their fabricated numbers', () => {
    expect(validateTokenAnalyticsMarket({ context: disabled(), market: null, analytics: null }, marketAddress).analytics).toBeNull();
    expect(validTokenAnalyticsContext({ ...disabled(), enabled: true })).toBe(true);
    expect(() => validateTokenAnalyticsMarket({ ...detail(), context: disabled() }, marketAddress)).toThrow(TokenAnalyticsReadError);
  });
  it.each([
    { holderCount: '-1' }, { observedSupplyRaw: '1' }, { burnedRaw: '0' }, { mintedRaw: '01' }, { oneshotTrades: '2' }, { oneshotExecutionFeesRaw: '999999999999999999' }, { holderScope: 'wallets-only' },
    { price: { ...detail().analytics!.price, nativeRawPerWholeToken: { numerator: '1', denominator: '1' } } }, { price: { ...detail().analytics!.price, blockNumber: '101' } },
  ])('rejects malformed or internally inconsistent totals/price provenance: %j', change => {
    const value = detail(); Object.assign(value.analytics!, change); expect(() => validateTokenAnalyticsMarket(value, marketAddress)).toThrow(TokenAnalyticsReadError);
  });
  it.each([{ lagBlocks: '2' }, { observedHeadNumber: '99' }, { finalized: true }, { kind: 'canonical-contract-snapshot' }, { network: { ...context().network!, chainId: 8453 } }, { source: { ...context().source!, genesisHash: hash('0') } }])('rejects unverified source/checkpoint/lag context: %j', change => {
    const value = detail(); Object.assign(value.context, change); expect(() => validateTokenAnalyticsMarket(value, marketAddress)).toThrow(TokenAnalyticsReadError);
  });
  it('compares checkpoint/source values independent of PostgreSQL nested object-key order', () => {
    const first = context(), second = context(); second.source = JSON.parse(JSON.stringify(first.source, ['quoter', 'oracle', 'poolManager', 'factory', 'genesisHash', 'chainId', 'codeHash', 'address']));
    expect(tokenAnalyticsCheckpointKey(first)).toBe(tokenAnalyticsCheckpointKey(second)); expect(tokenAnalyticsSourceMatches(first, second)).toBe(true);
  });
});

describe('token event and holder pages', () => {
  it('retains unknown external traders and never replaces them with the pool sender', () => {
    const page = validateTokenAnalyticsTrades(trades(), request()); expect(page.items[0]).toMatchObject({ trader: null, recipient: null, poolSender: address('a') });
    const html = renderToStaticMarkup(createElement(TokenAnalyticsTrades, { items: page.items, symbol: 'ORBIT', chainId: 84532, kind: 'pool-swap' }));
    expect(html).toContain('Unknown'); expect(html).toContain('Pool sender'); expect(html).toContain('−1.000000000000000001'); expect(html).toContain('1.23456789'); expect(html).not.toMatch(/Profit|PnL|0x0000000000000000000000000000000000000000/);
    const spoof = trades(); spoof.items[0] = { ...poolSwap(), trader: address('a') } as never; expect(() => validateTokenAnalyticsTrades(spoof, request())).toThrow(TokenAnalyticsReadError);
  });
  it('keeps oneshot gross/net/fees exact and checks the event arithmetic and selected market/token', () => {
    const page: TokenAnalyticsTradesResponse = { ...trades(), kind: 'oneshot-trade', items: [oneshot()] };
    expect(validateTokenAnalyticsTrades(page, request('oneshot-trade')).items[0]).toEqual(oneshot());
    const wrong = { ...oneshot(), netNativeRaw: '1' }; expect(() => validateTokenAnalyticsTrades({ ...page, items: [wrong] }, request('oneshot-trade'))).toThrow(TokenAnalyticsReadError);
    expect(() => validateTokenAnalyticsTrades(page, { ...request('oneshot-trade'), market: address('9') })).toThrow(TokenAnalyticsReadError);
  });
  it('requires descending event positions and rejects future checkpoints, duplicate events and wrong filters', () => {
    const all = { ...trades(), kind: 'all', items: [oneshot(), poolSwap()] }; expect(validateTokenAnalyticsTrades(all, request('all')).items).toHaveLength(2);
    for (const items of [[poolSwap(), poolSwap()], [poolSwap(), oneshot()], [poolSwap({ blockNumber: '101' })], [poolSwap({ timestamp: '1794816001' })]]) expect(() => validateTokenAnalyticsTrades({ ...all, items }, request('all'))).toThrow(TokenAnalyticsReadError);
    expect(() => validateTokenAnalyticsTrades(all, request('oneshot-trade'))).toThrow(TokenAnalyticsReadError);
  });
  it('includes contract holder balances without classifying a dead address as burned supply', () => {
    const page = holders(); page.items.push({ wallet: '0x000000000000000000000000000000000000dead', balanceRaw: '1', lastBlockNumber: '99', lastBlockHash: hash('c') }); page.items.sort((a, b) => a.wallet.localeCompare(b.wallet));
    const admitted = validateTokenAnalyticsHolders(page, request('holders')); expect(admitted.items).toHaveLength(2);
    const html = renderToStaticMarkup(createElement(TokenAnalyticsHolders, { items: admitted.items, symbol: 'ORBIT', chainId: 84532 })); expect(html).toContain('90071992.54740993'); expect(html).toContain('0.00000001');
    for (const change of [{ balanceRaw: '0' }, { balanceRaw: '-1' }, { wallet: `0x${'0'.repeat(40)}` }, { lastBlockNumber: '101' }]) expect(() => validateTokenAnalyticsHolders({ ...holders(), items: [{ ...holders().items[0], ...change }] }, request('holders'))).toThrow(TokenAnalyticsReadError);
  });
  it('builds bound query paths and does not turn malformed/error responses into empty activity', async () => {
    expect(tokenAnalyticsPagePath(request('oneshot-trade'), 'abc_DEF-123')).toBe(`/api/oneshot/token-analytics/markets/${marketAddress}/trades?limit=20&kind=oneshot-trade&cursor=abc_DEF-123`);
    for (const spec of [{ ...request(), limit: 51 }, { ...request(), market: 'bad' }, { ...request(), reference: { ...request().reference!, executionFeeBps: 999 } }]) expect(() => tokenAnalyticsPagePath(spec)).toThrow(TokenAnalyticsReadError);
    const failed = vi.fn(async () => Response.json({ error: { code: 'TOKEN_ANALYTICS_INVALID', message: 'secret RPC URL' } }, { status: 503 })); await expect(readTokenAnalyticsMarket(marketAddress, undefined, failed)).rejects.toThrow('could not be loaded'); await expect(readTokenAnalyticsMarket(marketAddress, undefined, failed)).rejects.not.toThrow('secret');
    await expect(readTokenAnalyticsMarket(marketAddress, undefined, vi.fn(async () => Response.json({})))).rejects.toThrow('could not be verified');
  });
});

describe('token analytics page and chart scope', () => {
  it('ignores a late response from a previous market and clears stale cursors rather than merging checkpoints', async () => {
    let finish!: (value: TokenAnalyticsTradesResponse) => void; const late = new Promise<TokenAnalyticsTradesResponse>(resolve => { finish = resolve; });
    const loader = new TokenAnalyticsPageLoader(vi.fn().mockImplementationOnce(() => late).mockResolvedValueOnce({ ...trades(), kind: 'oneshot-trade', items: [oneshot()] }));
    const old = loader.open(request()); await loader.open(request('oneshot-trade')); finish(trades()); await old; expect(loader.snapshot().data).toMatchObject({ kind: 'oneshot-trade' });
    const first = { ...trades(), nextCursor: 'cursor' }, next = trades(); next.context.checkpoint!.number = '101'; next.context.checkpoint!.hash = hash('d'); next.context.observedHeadNumber = '104';
    const moving = new TokenAnalyticsPageLoader(vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(next)); await moving.open(request()); await moving.loadMore(); expect(moving.snapshot()).toMatchObject({ stale: true, data: null });
  });
  it('keeps a good first page on transient failure but removes it after a server-reported chain move', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ...trades(), nextCursor: 'cursor' }).mockRejectedValueOnce(new Error('private')).mockRejectedValueOnce(new TokenAnalyticsReadError(409, 'TOKEN_CHAIN_MOVED', 'Activity changed.'));
    const loader = new TokenAnalyticsPageLoader(fetcher); await loader.open(request()); await loader.loadMore(); expect(loader.snapshot().data?.items).toHaveLength(1); expect(loader.snapshot().error).not.toContain('private');
    await loader.loadMore(); expect(loader.snapshot()).toMatchObject({ data: null, stale: true });
  });
  it('uses exact block order for repeated-second chart observations and never plots oneshot events twice', () => {
    const first = poolSwap({ blockNumber: '9007199254740992', logIndex: 3 }), second = poolSwap({ blockNumber: '9007199254740993', logIndex: 1, sqrtPriceX96Raw: (2n ** 95n).toString() });
    const points = tokenPoolChartPoints([second, first]); expect(points).toHaveLength(1); expect(points[0].blockNumber).toBe('9007199254740993'); expect(points[0].value).toBeCloseTo(0.0000000004);
    expect(points[0].price.denominator).toBe((2n ** 190n).toString()); expect(tokenPoolChartPoints([poolSwap({ timestamp: '999999999999999999999' })])).toEqual([]);
  });
});
