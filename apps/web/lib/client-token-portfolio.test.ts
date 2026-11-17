import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { BASE_SEPOLIA_GENESIS_HASH, BASE_SEPOLIA_POOL_MANAGER, nftNetworkForChainId, type IndexedTokenMarket, type TokenAnalyticsContext, type TokenWalletHolding, type TokenWalletHoldingsResponse } from '@oneshot/evm';
import { TokenPortfolioBalances } from '../components/token-portfolio';
import { readTokenWalletHoldings, tokenWalletHoldingsPath, TokenPortfolioLoader, TokenPortfolioReadError, validateTokenWalletHoldings } from './client-token-portfolio';

const address = (n: string) => `0x${n.repeat(40)}`, hash = (n: string) => `0x${n.repeat(64)}`, wallet = address('a');
const contract = (n: string) => ({ address: address(n), codeHash: hash(n) });
const context = (): TokenAnalyticsContext => ({ schemaVersion: 1, kind: 'canonical-event-journal', enabled: true, available: true, reason: null, deploymentId: 'a'.repeat(64), network: nftNetworkForChainId(84532)!,
  source: { chainId: 84532, genesisHash: BASE_SEPOLIA_GENESIS_HASH, factory: contract('3'), poolManager: { ...contract('4'), address: BASE_SEPOLIA_POOL_MANAGER }, oracle: contract('5'), quoter: contract('6') },
  checkpoint: { number: '100', hash: hash('a'), parentHash: hash('b'), timestamp: '1794816000' }, observedHeadNumber: '103', lagBlocks: '3', readonly: true, finalized: false });
const market = (token = address('2'), market = address('1')): IndexedTokenMarket => ({ schemaVersion: 1, market, token, creator: address('7'), platformRecipient: address('8'), name: 'Orbit', symbol: 'ORBIT', tokenDecimals: 8,
  initialSupplyRaw: '100000000000000000', totalSupplyRaw: '99999999999999999', executionFeeBps: 150, liquidityAndBurn: false, openingValuationNativeRaw: '1000000000000000001', effectiveOpeningValuationNativeRaw: '1000000000000000002', effectiveUpperValuationNativeRaw: '40000000000000000000', poolId: hash('9'), lpFeePips: 2500, tickSpacing: 10, tickLower: -100, tickUpper: 100, lockedLiquidityRaw: '9007199254740993', lockedRoundingDustRaw: '1', observedMarketCodeHash: hash('c'), observedTokenCodeHash: hash('d') });
const holding = (token?: string, contract?: string): TokenWalletHolding => ({ market: market(token, contract), balanceRaw: '9007199254740993', price: { sqrtPriceX96Raw: (2n ** 96n).toString(), tick: 0, nativeRawPerWholeToken: { numerator: (2n ** 192n * 100000000n).toString(), denominator: (2n ** 192n).toString() }, blockNumber: '98', blockHash: hash('e') }, lastBalanceBlockNumber: '99', lastBalanceBlockHash: hash('c') });
const page = (): TokenWalletHoldingsResponse => ({ context: context(), wallet, scope: 'registered-token-markets', holdingCount: '1', items: [holding()], nextCursor: null });

describe('canonical public wallet token balances', () => {
  it('preserves exact token8 balances and price ratios without estimating cash value or profit', () => {
    const data = validateTokenWalletHoldings(page(), wallet, 3, 84532);
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(TokenPortfolioBalances, { data })));
    expect(html).toContain('90071992.54740993 ORBIT'); expect(html).toContain('0.0000000001 test ETH / token'); expect(html).toContain(`/tokens/${address('1')}`); expect(html).toContain('Block 99');
    expect(html).not.toMatch(/Market cap|PnL|Profit|\$|ZRO/);
  });
  it('admits a genuine empty wallet, keeps disabled results unavailable, and rejects a positive count with a missing first page', () => {
    expect(validateTokenWalletHoldings({ ...page(), holdingCount: '0', items: [] }, wallet).holdingCount).toBe('0');
    const disabled = { ...context(), enabled: false, available: false, reason: 'unavailable', deploymentId: null, network: null, source: null, checkpoint: null, observedHeadNumber: null, lagBlocks: null };
    expect(validateTokenWalletHoldings({ ...page(), context: disabled, holdingCount: null, items: [] }, wallet).context.available).toBe(false);
    for (const value of [{ ...page(), holdingCount: '1', items: [] }, { ...page(), holdingCount: '2' }, { ...page(), context: disabled }]) expect(() => validateTokenWalletHoldings(value, wallet)).toThrow(TokenPortfolioReadError);
  });
  it('binds the response to the exact viewed wallet, network, registry scope and count', () => {
    expect(() => validateTokenWalletHoldings(page(), address('b'))).toThrow(TokenPortfolioReadError);
    expect(() => validateTokenWalletHoldings(page(), wallet, 3, 31337)).toThrow('different network');
    for (const changes of [{ scope: 'all-wallet-tokens' }, { holdingCount: '-1' }, { holdingCount: '0' }, { holdingCount: null }]) expect(() => validateTokenWalletHoldings({ ...page(), ...changes }, wallet)).toThrow(TokenPortfolioReadError);
    expect(validateTokenWalletHoldings(page(), wallet.toUpperCase().replace('0X', '0x')).wallet).toBe(wallet);
  });
  it.each([{ balanceRaw: '0' }, { balanceRaw: '999999999999999999' }, { balanceRaw: '-1' }, { lastBalanceBlockNumber: '101' }, { lastBalanceBlockNumber: '100', lastBalanceBlockHash: hash('c') }, { price: { ...holding().price, blockNumber: '101' } }, { price: { ...holding().price, nativeRawPerWholeToken: { numerator: '1', denominator: '1' } } }])('rejects malformed or mismatched balance/price proof: %j', change => {
    expect(() => validateTokenWalletHoldings({ ...page(), items: [{ ...holding(), ...change }] }, wallet)).toThrow(TokenPortfolioReadError);
  });
  it('requires ascending unique token identity rather than sorting or replacing inconsistent records', () => {
    const second = holding(address('4'), address('3'));
    expect(validateTokenWalletHoldings({ ...page(), holdingCount: '2', items: [holding(), second] }, wallet).items).toHaveLength(2);
    for (const items of [[second, holding()], [holding(), holding()], [holding(), holding(address('4'), address('1'))]]) expect(() => validateTokenWalletHoldings({ ...page(), holdingCount: '2', items }, wallet)).toThrow(TokenPortfolioReadError);
  });
  it('uses bounded read-only public requests without account credentials and never maps failure to zero', async () => {
    expect(tokenWalletHoldingsPath(wallet)).toBe(`/api/oneshot/token-analytics/wallets/${wallet}?limit=3`);
    for (const limit of [1, 6, 20]) expect(() => tokenWalletHoldingsPath(wallet, limit)).toThrow(TokenPortfolioReadError);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(page())); await readTokenWalletHoldings(wallet, undefined, undefined, 3, 84532, fetcher);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/wallets/'), expect.objectContaining({ credentials: 'omit', redirect: 'error', cache: 'no-store' }));
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('headers');
    const unavailable = vi.fn(async () => Response.json({ error: { message: 'private provider URL', code: 'TOKEN_RPC' } }, { status: 503 })); await expect(readTokenWalletHoldings(wallet, undefined, undefined, 3, undefined, unavailable)).rejects.toThrow('could not be loaded');
    await expect(readTokenWalletHoldings(wallet, undefined, undefined, 3, undefined, unavailable)).rejects.not.toThrow('private');
  });
});

describe('token wallet pagination and address changes', () => {
  it('does not attach a late previous wallet response to the selected address', async () => {
    let finish!: (value: TokenWalletHoldingsResponse) => void; const late = new Promise<TokenWalletHoldingsResponse>(resolve => { finish = resolve; });
    const loader = new TokenPortfolioLoader(vi.fn().mockImplementationOnce(() => late).mockResolvedValueOnce({ ...page(), wallet: address('b') }));
    const first = loader.open({ wallet }); await loader.open({ wallet: address('b') }); finish(page()); await first; expect(loader.snapshot().data?.wallet).toBe(address('b'));
  });
  it('appends same-checkpoint proofs only in token order and preserves the aggregate count', async () => {
    const first = { ...page(), holdingCount: '3', items: [holding(), holding(address('4'), address('3'))], nextCursor: 'cursor' }, second = { ...page(), holdingCount: '3', items: [holding(address('6'), address('5'))] };
    const loader = new TokenPortfolioLoader(vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)); await loader.open({ wallet, limit: 2 }); await loader.loadMore();
    expect(loader.snapshot().data?.items).toHaveLength(3); expect(loader.snapshot().data?.holdingCount).toBe('3');
  });
  it('clears old balances on a checkpoint advance or reported chain move while preserving them for a transient failed next page', async () => {
    const first = { ...page(), holdingCount: '3', items: [holding(), holding(address('4'), address('3'))], nextCursor: 'cursor' };
    const moved = { ...page(), holdingCount: '3', items: [holding(address('6'), address('5'))], context: { ...context(), checkpoint: { ...context().checkpoint!, number: '101', hash: hash('d') }, observedHeadNumber: '104' } };
    const loader = new TokenPortfolioLoader(vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('private')).mockResolvedValueOnce(moved)); await loader.open({ wallet, limit: 2 }); await loader.loadMore(); expect(loader.snapshot().data?.items).toHaveLength(2); expect(loader.snapshot().error).not.toContain('private');
    await loader.loadMore(); expect(loader.snapshot()).toMatchObject({ data: null, stale: true });
    const reorg = new TokenPortfolioLoader(vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new TokenPortfolioReadError(409, 'TOKEN_CHAIN_MOVED', 'Refresh balances.'))); await reorg.open({ wallet, limit: 2 }); await reorg.loadMore(); expect(reorg.snapshot()).toMatchObject({ data: null, stale: true });
  });
});
