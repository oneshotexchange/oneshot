import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { BASE_SEPOLIA_GENESIS_HASH, BASE_SEPOLIA_POOL_MANAGER } from '@oneshot/evm';
import { describe, expect, it, vi } from 'vitest';
import { nftNetworkForChainId, type IndexedTokenContext, type IndexedTokenMarket, type IndexedTokenMarketsResponse } from '@oneshot/evm';
import { TokenTable } from '../components/market-data';
import { TokenMarketDetails } from '../components/token-terminal';
import { TokenMarketsUnavailable } from '../components/token-market-context';
import {
  readTokenMarket,
  readTokenMarkets,
  tokenAnalyticsMarketsPath,
  tokenDiscoveryQuery,
  tokenDiscoverySort,
  tokenMarketsPath,
  tokenNativeAmount,
  tokenSupplyAmount,
  TokenMarketReadError,
  TokenMarketsLoader,
  validateTokenAnalyticsMarketsResponse,
  validateTokenMarketResponse,
  validateTokenMarketsResponse,
} from './client-token-markets';

describe('event-journal token discovery sorting and response checks', () => {
  it('validates analytics list query helpers and sort options', () => {
    expect(tokenDiscoverySort('?sort=volume')).toBe('volume');
    expect(tokenDiscoverySort('')).toBe('newest');
    expect(tokenAnalyticsMarketsPath('Orbit', 'holders', 10)).toBe('/api/oneshot/token-analytics/markets?limit=10&sort=holders&q=Orbit');
    expect(() => tokenDiscoverySort('?sort=invalid')).toThrow(TokenMarketReadError);
    expect(() => tokenDiscoverySort('?sort=volume&sort=holders')).toThrow(TokenMarketReadError);
  });

  it('rejects malformed analytics list payloads and accepts valid disabled responses', () => {
    const disabled = {
      context: {
        schemaVersion: 1,
        kind: 'canonical-event-journal',
        enabled: false,
        available: false,
        reason: 'Token activity is currently unavailable.',
        deploymentId: null,
        network: null,
        source: null,
        checkpoint: null,
        observedHeadNumber: null,
        lagBlocks: null,
        readonly: true,
        finalized: false,
      },
      sort: 'volume',
      items: [],
      nextCursor: null,
    };
    expect(validateTokenAnalyticsMarketsResponse(disabled)).toEqual(disabled);
    expect(() => validateTokenAnalyticsMarketsResponse({ ...disabled, sort: 'bad' })).toThrow(TokenMarketReadError);
  });
});

const addr = (n: string) => `0x${n.repeat(40)}`, hash = (n: string) => `0x${n.repeat(64)}`;
const market = (changes: Partial<IndexedTokenMarket> = {}): IndexedTokenMarket => ({ schemaVersion: 1, market: addr('1'), token: addr('2'), creator: addr('3'), platformRecipient: addr('4'), name: 'Orbit', symbol: 'ORBIT', tokenDecimals: 8,
  initialSupplyRaw: '100000000000000000', totalSupplyRaw: '99999999999999999', executionFeeBps: 110, liquidityAndBurn: false, openingValuationNativeRaw: '1000000000000000001', effectiveOpeningValuationNativeRaw: '1000000000000000002', effectiveUpperValuationNativeRaw: '40000000000000000000',
  poolId: hash('5'), lpFeePips: 2500, tickSpacing: 10, tickLower: -100, tickUpper: 100, lockedLiquidityRaw: '9007199254740993', lockedRoundingDustRaw: '1', observedMarketCodeHash: hash('6'), observedTokenCodeHash: hash('7'), ...changes });
const sourceContract = (n: string) => ({ address: addr(n), codeHash: hash(n) });
const context = (): IndexedTokenContext => ({ schemaVersion: 1, enabled: true, available: true, reason: null, network: nftNetworkForChainId(84532)!, deploymentId: 'a'.repeat(64),
  source: { chainId: 84532, genesisHash: BASE_SEPOLIA_GENESIS_HASH, factory: sourceContract('9'), poolManager: { ...sourceContract('a'), address: BASE_SEPOLIA_POOL_MANAGER }, oracle: sourceContract('b'), quoter: sourceContract('c') },
  checkpoint: { number: '9007199254740993', hash: hash('d'), parentHash: hash('e'), timestamp: '1794816000' }, readonly: true, finalized: false, kind: 'canonical-contract-snapshot' });
const page = (changes: Partial<IndexedTokenMarketsResponse> = {}): IndexedTokenMarketsResponse => ({ context: context(), items: [market()], nextCursor: null, ...changes });
const disabled = (): IndexedTokenContext => ({ schemaVersion: 1, enabled: false, available: false, reason: 'unavailable', deploymentId: null, network: null, source: null, checkpoint: null, readonly: true, finalized: false, kind: 'canonical-contract-snapshot' });
const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, null, element));

describe('canonical token snapshots', () => {
  it('retains exact ETH18 and token8 integers above JavaScript precision without treating launch valuation as a spot price', () => {
    const value = validateTokenMarketsResponse(page()); expect(value.items[0].lockedLiquidityRaw).toBe('9007199254740993');
    expect(tokenNativeAmount(value.items[0].openingValuationNativeRaw)).toBe('1.000000000000000001');
    expect(tokenSupplyAmount(value.items[0].totalSupplyRaw)).toBe('999999999.99999999');
    expect(validateTokenMarketResponse({ context: value.context, market: value.items[0] }, addr('1')).market).toEqual(value.items[0]);
    const html = render(createElement(TokenTable, { tokens: value.items }));
    expect(html).toContain('Opening valuation'); expect(html).toContain('1.000000000000000001'); expect(html).toContain('999999999.99999999');
    expect(html).toContain(`/tokens/${addr('1')}`); expect(html).not.toMatch(/ZRO|Market cap|24h volume|Holders/);
  });

  it('keeps disabled service distinct from a real empty verified result and exposes useful recovery', () => {
    expect(validateTokenMarketsResponse(page({ context: disabled(), items: [] })).context.available).toBe(false);
    expect(validateTokenMarketResponse({ context: disabled(), market: null }, addr('1')).market).toBeNull();
    expect(validateTokenMarketsResponse(page({ items: [] })).context.available).toBe(true);
    expect(() => validateTokenMarketsResponse(page({ context: disabled() }))).toThrow(TokenMarketReadError);
    const html = render(createElement(TokenMarketsUnavailable, { onRefresh: vi.fn() })); expect(html).toContain('Refresh markets'); expect(html).not.toContain('No token markets');
  });

  it('rejects legacy Aptos values, wrong detail identity, duplicate rows and unsupported schema', () => {
    for (const value of [{ tokens: [{ address: addr('1'), priceApt: '1' }] }, page({ items: [{ address: addr('1'), priceApt: '1' }] as never }), page({ items: [market(), market()] }), { ...page(), context: { ...context(), schemaVersion: 2 } }]) expect(() => validateTokenMarketsResponse(value)).toThrow(TokenMarketReadError);
    expect(() => validateTokenMarketResponse({ context: context(), market: market() }, addr('2'))).toThrow(TokenMarketReadError);
    expect(() => validateTokenMarketResponse({ context: context(), market: null }, addr('1'))).toThrow(TokenMarketReadError);
  });

  it.each([
    { network: nftNetworkForChainId(31337)! }, { network: { ...nftNetworkForChainId(84532)!, chainId: 8453 } }, { network: { ...nftNetworkForChainId(84532)!, nativeDecimals: 8 } },
    { source: { ...context().source!, chainId: 31337 } }, { source: { ...context().source!, quoter: null } }, { source: { ...context().source!, genesisHash: hash('0') } }, { source: { ...context().source!, genesisHash: hash('8') } }, { source: { ...context().source!, poolManager: sourceContract('a') } },
    { checkpoint: { ...context().checkpoint!, number: '-1' } }, { checkpoint: { ...context().checkpoint!, hash: hash('0') } }, { finalized: true }, { readonly: false }, { deploymentId: null },
  ])('rejects unverifiable or mismatched network/checkpoint context: %j', change => {
    expect(() => validateTokenMarketsResponse({ ...page(), context: { ...context(), ...change } })).toThrow(TokenMarketReadError);
  });

  it.each([
    { tokenDecimals: 18 }, { openingValuationNativeRaw: '0' }, { openingValuationNativeRaw: '01' }, { totalSupplyRaw: '100000000000000001' }, { totalSupplyRaw: (2n ** 256n).toString() },
    { effectiveUpperValuationNativeRaw: '1' }, { lockedLiquidityRaw: '0' }, { lockedLiquidityRaw: (2n ** 128n).toString() }, { executionFeeBps: 115 }, { executionFeeBps: 501 }, { poolId: hash('0') }, { tickUpper: -100 }, { tickSpacing: 60 },
  ])('rejects impossible or malformed amount/fee/pool terms: %j', change => {
    expect(() => validateTokenMarketsResponse(page({ items: [market(change as Partial<IndexedTokenMarket>)] }))).toThrow(TokenMarketReadError);
  });

  it('shows only supplied market terms, marks analytics/trading unavailable, and provides trusted Base explorer links', () => {
    const html = render(createElement(TokenMarketDetails, { market: market(), context: context(), onRefresh: vi.fn() }));
    for (const text of ['Base Sepolia testnet (84532)', 'block 9007199254740993', 'Effective opening valuation', '1.000000000000000002', '0.25%', 'LP fee', 'pool protocol fee', 'Creator proceeds', 'Market analytics are unavailable', 'recent blocks may change']) expect(html).toContain(text);
    expect(html).toContain(`https://sepolia.basescan.org/address/${addr('2')}`);
    expect(html).not.toMatch(/ZRO|eth_sendTransaction|Approve in wallet|Connect wallet|No price history|0 ETH/);
  });
});

describe('token search and read recovery', () => {
  it('binds server search and pagination to an encoded canonical query', () => {
    expect(tokenMarketsPath('  Orbit & Moon  ')).toBe('/api/oneshot/token-indexed/markets?limit=25&q=Orbit+%26+Moon');
    expect(tokenDiscoveryQuery('?q=Orbit')).toBe('Orbit');
    for (const search of ['?q=a&q=b', '?q=' + 'x'.repeat(101), '?q=%00']) expect(() => tokenDiscoveryQuery(search)).toThrow(TokenMarketReadError);
  });

  it('does not turn malformed reads or operator errors into successful empty/zero markets', async () => {
    const malformed = vi.fn(async () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(readTokenMarkets(tokenMarketsPath(), undefined, malformed)).rejects.toThrow('could not be verified');
    const unavailable = vi.fn(async () => Response.json({ error: { code: 'TOKEN_RPC_UNAVAILABLE', message: 'private RPC password: secret' } }, { status: 503 }));
    await expect(readTokenMarkets(tokenMarketsPath(), undefined, unavailable)).rejects.toThrow('unavailable');
    await expect(readTokenMarkets(tokenMarketsPath(), undefined, unavailable)).rejects.not.toThrow('secret');
    const fetcher = vi.fn(); await expect(readTokenMarket('0xnot-an-address', undefined, fetcher)).rejects.toThrow('valid token market'); expect(fetcher).not.toHaveBeenCalled();
  });

  it('ignores a late previous search result and cancellation, keeping the current query authoritative', async () => {
    let finish!: (value: IndexedTokenMarketsResponse) => void;
    const old = new Promise<IndexedTokenMarketsResponse>(resolve => { finish = resolve; });
    const loader = new TokenMarketsLoader(vi.fn().mockImplementationOnce(() => old).mockResolvedValueOnce(page({ items: [market({ name: 'Moon' })] })));
    const pending = loader.open(tokenMarketsPath('Orbit')); await loader.open(tokenMarketsPath('Moon')); finish(page()); await pending;
    expect(loader.snapshot().data?.items[0].name).toBe('Moon'); expect(loader.snapshot().path).toBe(tokenMarketsPath('Moon'));
  });

  it('appends only the same source checkpoint and restarts instead of merging a later checkpoint', async () => {
    const first = page({ nextCursor: 'page-two' }), second = market({ market: addr('8'), token: addr('9'), name: 'Moon' });
    const fetcher = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(page({ items: [second] }));
    const loader = new TokenMarketsLoader(fetcher); await loader.open(tokenMarketsPath('Orbit')); await loader.loadMore();
    expect(fetcher).toHaveBeenLastCalledWith(`${tokenMarketsPath('Orbit')}&cursor=page-two`, expect.any(AbortSignal));
    expect(loader.snapshot().data?.items.map(item => item.name)).toEqual(['Orbit', 'Moon']);
    const moved = page({ items: [second] }); moved.context.checkpoint!.number = '9007199254740994';
    const changed = new TokenMarketsLoader(vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(moved).mockResolvedValueOnce(moved));
    await changed.open(tokenMarketsPath()); await changed.loadMore();
    expect(changed.snapshot().data?.items).toEqual([second]); expect(changed.snapshot().notice).toContain('refreshed');
  });
});
