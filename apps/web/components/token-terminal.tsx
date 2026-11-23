"use client";

import { ArrowLeft, ChartNoAxesCombined, Star } from 'lucide-react';
import type { IndexedTokenContext, IndexedTokenMarket } from '@oneshot/evm';
import { isMainnetExecutionNetwork } from '@oneshot/evm';
import Link from './navigation';
import { tokenNativeAmount, tokenSupplyAmount, useTokenMarket } from '../lib/client-token-markets';
import { tokenIsWatched, useTokenWatchlist } from '../lib/token-watchlist';
import { nativeAssetLabel, nftExplorerHref } from '../lib/nft-network';
import { Address, AssetIcon, Badge, Button, ButtonLink, EmptyState, ErrorState, InfoRow, Loading, SafetyNote } from './ui';
import { TokenMarketContext, TokenMarketsUnavailable } from './token-market-context';
import { TokenTradePanel } from './token-execution-panel';
import { TokenAnalyticsPanel } from './token-analytics';
import '../app/token-markets.css';

function MarketAddress({ value, chainId }: { value: string; chainId?: number }) {
  const href = nftExplorerHref(chainId, value, 'address');
  return href ? <a className="text-link" href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><Address value={value} full /></a> : <Address value={value} full />;
}

/** A contract snapshot does not supply a current quote, chart, volume or wallet balance. */
export function TokenMarketDetails({ market, context, onRefresh, analytics }: { market: IndexedTokenMarket; context: IndexedTokenContext; onRefresh(): void; analytics?: React.ReactNode }) {
  const watchlist = useTokenWatchlist(), watched = tokenIsWatched(watchlist.entries, market.token);
  const currency = nativeAssetLabel(context.network);
  const mainnet = isMainnetExecutionNetwork(context.network);
  return <>
    <div className="terminal-header token-market-detail-header"><AssetIcon name={market.symbol} large /><div className="terminal-title"><h1>{market.name}</h1><p>{market.symbol} / {currency}</p></div><Badge tone="amber">{mainnet ? 'Mainnet' : 'Test network'}</Badge><button className={`watch-button ${watched ? 'watched' : ''}`} aria-label={watched ? 'Remove from watchlist' : 'Add to watchlist'} disabled={!watchlist.loaded} onClick={() => watchlist.toggle(market.token)}><Star size={19} fill={watched ? 'currentColor' : 'none'} /></button><Button variant="secondary" onClick={onRefresh}>Refresh market</Button></div>
    {watchlist.error && <ErrorState message={watchlist.error} retry={watchlist.refresh} />}
    <TokenMarketContext context={context} />
    {analytics}
    <div className="token-market-detail-grid section-gap">
      <section className="panel token-market-summary" aria-label="Token market terms"><h2>Market terms</h2>
        <InfoRow label="Opening valuation">{tokenNativeAmount(market.openingValuationNativeRaw)} {currency}</InfoRow>
        <InfoRow label="Effective opening valuation">{tokenNativeAmount(market.effectiveOpeningValuationNativeRaw)} {currency}</InfoRow>
        <InfoRow label="Effective upper valuation">{tokenNativeAmount(market.effectiveUpperValuationNativeRaw)} {currency}</InfoRow>
        <p className="field-hint">Effective values describe the liquidity range after price rounding. They are not a current token price or market cap.</p>
        <InfoRow label="Initial supply">{tokenSupplyAmount(market.initialSupplyRaw)} {market.symbol}</InfoRow>
        <InfoRow label="Current total supply">{tokenSupplyAmount(market.totalSupplyRaw)} {market.symbol}</InfoRow>
        <InfoRow label="Token decimals">8</InfoRow>
        <InfoRow label="Execution fee">{market.executionFeeBps / 100}%</InfoRow>
        <InfoRow label="LP fee">0.25%</InfoRow>
        <InfoRow label="Fee destination">{market.liquidityAndBurn ? 'Liquidity and burn' : 'Creator proceeds'}</InfoRow>
        <p className="field-hint">A pool protocol fee may also apply. Review the actual total pool fee, execution fee and network gas before any trade.</p>
      </section>
      <section className="panel token-market-summary" aria-label="Token contracts"><h2>Contracts and liquidity</h2>
        <InfoRow label="Token"><MarketAddress value={market.token} chainId={context.network?.chainId} /></InfoRow>
        <InfoRow label="Market"><MarketAddress value={market.market} chainId={context.network?.chainId} /></InfoRow>
        <InfoRow label="Creator"><MarketAddress value={market.creator} chainId={context.network?.chainId} /></InfoRow>
        <InfoRow label="Locked liquidity units">{market.lockedLiquidityRaw}</InfoRow>
        <p className="field-hint">Liquidity units represent this market’s pool position, rather than an {context.network?.nativeSymbol ?? 'ETH'} balance or a cash value.</p>
        <InfoRow label="Pool ID"><span className="indexed-hash">{market.poolId}</span></InfoRow>
      </section>
    </div>
    {!analytics && <section className="panel token-market-unavailable section-gap" aria-label="Token market analytics">
      <EmptyState compact icon={ChartNoAxesCombined} title="Market analytics are unavailable" description="Price history, volume and holder analytics are not available here yet. Contract terms are shown above." />
    </section>}
    <SafetyNote amber={mainnet}>{mainnet ? 'Zero Mainnet transactions use real ZRO. Viewing market terms or saving a token to your watchlist does not buy, sell or approve a transaction.' : 'These are test-network assets. Viewing market terms or saving a token to your watchlist does not buy, sell or approve a transaction.'}</SafetyNote>
  </>;
}

export function TokenTerminal({ id }: { id: string }) {
  const response = useTokenMarket(id);
  return <><Link className="back-link" href="/tokens"><ArrowLeft size={13} />Token markets</Link>
    {response.loading ? <div className="panel"><Loading rows={5} /></div> : response.error ? <div className="panel token-market-unavailable"><ErrorState message={response.error} retry={response.refresh} /><ButtonLink href="/tokens" variant="secondary">Back to markets</ButtonLink></div>
      : !response.data?.context.available || !response.data.market ? <div className="panel"><TokenMarketsUnavailable onRefresh={response.refresh} /></div>
        : <><TokenMarketDetails market={response.data.market} context={response.data.context} onRefresh={response.refresh} analytics={<TokenAnalyticsPanel market={response.data.market} snapshot={response.data.context} />} /><TokenTradePanel market={response.data.market} context={response.data.context} onRefresh={response.refresh} /></>}
  </>;
}
