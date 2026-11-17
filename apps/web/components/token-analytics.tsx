import { useState } from 'react';
import { ChartNoAxesCombined } from 'lucide-react';
import { formatIndexedAmount, type IndexedTokenContext, type IndexedTokenMarket, type TokenAnalyticsMarketResponse, type TokenAnalyticsTrade, type TokenHolderBalance, type TokenPoolSwap } from '@oneshot/evm';
import { tokenAnalyticsCheckpointKey, tokenAnalyticsSourceMatches, useTokenAnalyticsMarket, useTokenAnalyticsPage } from '../lib/client-token-analytics';
import { tokenPriceDisplay } from '../lib/token-price';
import { nftExplorerHref, nftNetworkLabel } from '../lib/nft-network';
import { TokenPriceChart } from './token-price-chart';
import { Address, Button, EmptyState, ErrorState, InfoRow, Loading, Tabs } from './ui';
import '../app/token-analytics.css';

const native = (raw: string) => `${formatIndexedAmount(raw, 18)} test ETH`;
const tokenAmount = (raw: string) => formatIndexedAmount(raw, 8);
const counted = (amount: string, noun: string, plural = `${noun}s`) => `${amount} ${amount === '1' ? noun : plural}`;
const signedAmount = (raw: string, decimals: number) => `${raw.startsWith('-') ? '−' : raw === '0' ? '' : '+'}${formatIndexedAmount(raw.replace(/^-/, ''), decimals)}`;
function timestamp(raw: string) { const seconds = BigInt(raw); return seconds > 8640000000000n ? 'Outside displayable date range' : new Date(Number(seconds) * 1000).toLocaleString(undefined, { timeZone: 'UTC', timeZoneName: 'short' }); }
function Explorer({ value, chainId, kind, children }: { value: string; chainId: number; kind: 'address' | 'tx'; children?: React.ReactNode }) {
  const href = nftExplorerHref(chainId, value, kind);
  return href ? <a className="text-link" href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children || <Address value={value} />}</a> : children || <Address value={value} />;
}

/** Every displayed count/price comes from this response's own event-journal checkpoint. */
export function TokenAnalyticsMetrics({ response }: { response: TokenAnalyticsMarketResponse }) {
  const { analytics, context } = response; if (!context.available || !analytics) return null;
  const price = tokenPriceDisplay(analytics.price.nativeRawPerWholeToken);
  return <>
    <p className="token-analytics-checkpoint">{nftNetworkLabel(context.network)}. Activity through block {context.checkpoint!.number}; observed network head {context.observedHeadNumber}, {counted(context.lagBlocks!, 'block')} behind. Recent blocks may change.</p>
    <dl className="token-analytics-metrics">
      <div><dt>Indexed pool price</dt><dd>{price.approximate && !price.belowPrecision ? '≈ ' : ''}{price.text} <span>test ETH / token</span></dd><p>Latest pool price observation at block {analytics.price.blockNumber}. This pool ratio is separate from a trade quote.</p></div>
      <div><dt>Pool swap volume · all routes</dt><dd>{native(analytics.poolNativeVolumeRaw)}</dd><p>Absolute native deltas in {analytics.poolSwaps} pool Swap events since market creation.</p></div>
      <div><dt>oneshot gross trade volume</dt><dd>{native(analytics.oneshotGrossNativeVolumeRaw)}</dd><p>{counted(analytics.oneshotTrades, 'oneshot trade')}: {counted(analytics.oneshotBuys, 'buy')} and {counted(analytics.oneshotSells, 'sell')}. Gross amounts include execution fees.</p></div>
      <div><dt>oneshot execution fees</dt><dd>{native(analytics.oneshotExecutionFeesRaw)}</dd><p>Fees from oneshot Trade events only.</p></div>
      <div><dt>Holder addresses</dt><dd>{analytics.holderCount}</dd><p>All addresses with positive balances, including contracts and PoolManager. Burned supply sent to the zero address is excluded.</p></div>
      <div><dt>Observed supply</dt><dd>{tokenAmount(analytics.observedSupplyRaw)} <span>{response.market?.symbol}</span></dd><p>{tokenAmount(analytics.burnedRaw)} tokens burned. Transfers to other addresses remain part of supply.</p></div>
    </dl>
    <p className="field-hint token-analytics-scope">oneshot activity overlaps the all-route pool totals. Pool volume and oneshot gross volume use different event amounts. Wallet profit and loss is unavailable.</p>
    <details className="token-price-ratio"><summary>Exact pool price ratio</summary><InfoRow label="Native raw units per whole token"><span>{analytics.price.nativeRawPerWholeToken.numerator} / {analytics.price.nativeRawPerWholeToken.denominator}</span></InfoRow><p className="field-hint">Divide this ratio by 10¹⁸ to obtain test ETH per whole token. Decimal displays marked ≈ are truncated; the ratio above stays exact.</p></details>
  </>;
}

export function TokenAnalyticsTrades({ items, symbol, chainId, kind }: { items: readonly TokenAnalyticsTrade[]; symbol: string; chainId: number; kind: 'pool-swap' | 'oneshot-trade' }) {
  if (!items.length) return <EmptyState compact title={kind === 'pool-swap' ? 'No pool swaps at this checkpoint' : 'No oneshot trades at this checkpoint'} description="Transactions appear here after they are indexed. No trade activity is inferred from token transfers." />;
  return <>{kind === 'pool-swap' && <p className="data-notice">Pool senders may be routers or contracts. End-user trader and recipient are unavailable for these pool events.</p>}<div className="table-wrap"><table className="data-table token-analytics-table"><thead>{kind === 'pool-swap' ? <tr><th>Time</th><th>Native pool delta</th><th>{symbol} pool delta</th><th>Pool fee</th><th>Pool sender</th><th>Trader</th><th>Transaction</th></tr> : <tr><th>Side</th><th>Time</th><th>{symbol} amount</th><th>Gross test ETH</th><th>Net test ETH</th><th>Execution fee</th><th>Trader / recipient</th><th>Transaction</th></tr>}</thead><tbody>{items.map(item => item.kind === 'pool-swap' ? <tr key={item.id}><td>{timestamp(item.timestamp)}<small className="indexed-subline">Block {item.blockNumber}</small></td><td>{signedAmount(item.amount0Raw, 18)}</td><td>{signedAmount(item.amount1Raw, 8)}</td><td>{formatIndexedAmount(String(item.feePips), 4)}%</td><td><Explorer value={item.poolSender} chainId={chainId} kind="address" /></td><td>Unknown</td><td><Explorer value={item.transactionHash} chainId={chainId} kind="tx">View transaction</Explorer></td></tr>
      : <tr key={item.id}><td>{item.buy ? 'Buy' : 'Sell'}</td><td>{timestamp(item.timestamp)}<small className="indexed-subline">Block {item.blockNumber}</small></td><td>{tokenAmount(item.tokensRaw)}</td><td>{formatIndexedAmount(item.grossNativeRaw, 18)}</td><td>{formatIndexedAmount(item.netNativeRaw, 18)}</td><td>{formatIndexedAmount(item.executionFeeRaw, 18)}</td><td><Explorer value={item.trader} chainId={chainId} kind="address" /><small className="indexed-subline">Recipient <Explorer value={item.recipient} chainId={chainId} kind="address" /></small></td><td><Explorer value={item.transactionHash} chainId={chainId} kind="tx">View transaction</Explorer></td></tr>)}</tbody></table></div></>;
}
export function TokenAnalyticsHolders({ items, symbol, chainId }: { items: readonly TokenHolderBalance[]; symbol: string; chainId: number }) {
  if (!items.length) return <EmptyState compact title="No holder balances at this checkpoint" description="Only addresses with a positive indexed balance appear here. This includes contracts and pools." />;
  return <div className="table-wrap"><table className="data-table token-analytics-table"><thead><tr><th>Address</th><th>{symbol} balance</th><th>Last transfer block</th></tr></thead><tbody>{items.map(item => <tr key={item.wallet}><td><Explorer value={item.wallet} chainId={chainId} kind="address" /></td><td>{tokenAmount(item.balanceRaw)}</td><td>{item.lastBlockNumber}</td></tr>)}</tbody></table></div>;
}

/** Activity failures do not replace contract terms or revive an unavailable signing service. */
export function TokenAnalyticsPanel({ market, snapshot }: { market: IndexedTokenMarket; snapshot: IndexedTokenContext }) {
  const detail = useTokenAnalyticsMarket(market.market), [tab, setTab] = useState('chart');
  const reference = { token: market.token, poolId: market.poolId, executionFeeBps: market.executionFeeBps }, available = Boolean(!detail.loading && detail.data?.context.available && detail.data.analytics && tokenAnalyticsSourceMatches(detail.data.context, snapshot));
  const pools = useTokenAnalyticsPage(available && (tab === 'chart' || tab === 'pool') ? { market: market.market, view: 'pool-swap', reference } : null);
  const oneshot = useTokenAnalyticsPage(available && tab === 'oneshot' ? { market: market.market, view: 'oneshot-trade', reference } : null);
  const holders = useTokenAnalyticsPage(available && tab === 'holders' ? { market: market.market, view: 'holders', reference } : null);
  const active = tab === 'holders' ? holders : tab === 'oneshot' ? oneshot : pools;
  const refresh = () => detail.refresh();
  const changed = active.stale || Boolean(detail.data && active.data?.context.available && tokenAnalyticsCheckpointKey(detail.data.context) !== tokenAnalyticsCheckpointKey(active.data.context));
  const body = detail.data;
  return <section className="panel token-analytics-panel section-gap" aria-label="Token market activity"><div className="section-header"><div><h2>Market activity</h2><p>Verified pool swaps, oneshot trades and token balances.</p></div><Button variant="secondary" loading={detail.loading} onClick={refresh}>Refresh activity</Button></div>
    {detail.loading ? <Loading rows={3} /> : detail.error ? <ErrorState message={detail.error} retry={refresh} /> : !body?.context.available || !body.analytics ? <EmptyState compact icon={ChartNoAxesCombined} title="Token activity is unavailable" description="Contract terms and transaction availability can still be checked separately. Refresh activity in a moment." action={<Button variant="secondary" onClick={refresh}>Refresh activity</Button>} /> : !available || body.analytics.token !== market.token || body.analytics.poolId !== market.poolId ? <ErrorState message="The activity source does not match this market. Refresh the market and activity before using these records." retry={refresh} /> : changed ? <ErrorState message="The activity checkpoint changed. Refresh all activity before continuing." retry={refresh} /> : <>
      <TokenAnalyticsMetrics response={body} />
      <Tabs tabs={[{ value: 'chart', label: 'Price history' }, { value: 'pool', label: 'All-route pool swaps' }, { value: 'oneshot', label: 'oneshot trades' }, { value: 'holders', label: 'Holders' }]} active={tab} onChange={setTab} />
      {active.loading ? <Loading rows={3} /> : active.error && !active.data ? <ErrorState message={active.error} retry={refresh} /> : !active.data?.context.available ? <p className="data-notice">This activity page is unavailable. Refresh activity to try again.</p> : <>
        {tab === 'chart' && 'kind' in active.data ? <TokenPriceChart swaps={active.data.items.filter((item): item is TokenPoolSwap => item.kind === 'pool-swap')} /> : tab === 'holders' && 'scope' in active.data ? <TokenAnalyticsHolders items={active.data.items} symbol={market.symbol} chainId={body.context.network!.chainId} /> : 'kind' in active.data ? <TokenAnalyticsTrades items={active.data.items} symbol={market.symbol} chainId={body.context.network!.chainId} kind={tab === 'oneshot' ? 'oneshot-trade' : 'pool-swap'} /> : null}
        {active.error && <ErrorState message={active.error} retry={() => void active.loadMore()} />}
        <div className="indexed-page-footer"><span>{tab === 'holders' ? counted(String(active.data.items.length), 'holder address', 'holder addresses') : counted(String(active.data.items.length), 'event')} loaded</span>{active.data.nextCursor && <Button variant="secondary" loading={active.loadingMore} onClick={() => void active.loadMore()}>Load {tab === 'holders' ? 'more holders' : 'earlier events'}</Button>}</div>
      </>}
    </>}
  </section>;
}
