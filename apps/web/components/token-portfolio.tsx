import { formatIndexedAmount, type TokenWalletHoldingsResponse } from '@oneshot/evm';
import { ArrowUpRight } from 'lucide-react';
import Link from './navigation';
import { useTokenPortfolio } from '../lib/client-token-portfolio';
import { nftNetworkLabel } from '../lib/nft-network';
import { tokenPriceDisplay } from '../lib/token-price';
import { AssetIcon, Button, ButtonLink, EmptyState, ErrorState, Loading } from './ui';
import '../app/token-analytics.css';

export function TokenPortfolioBalances({ data }: { data: TokenWalletHoldingsResponse }) {
  return <div className="table-wrap"><table className="data-table token-portfolio-table"><thead><tr><th>Token</th><th>Balance</th><th>Indexed pool price</th><th>Last balance change</th><th /></tr></thead><tbody>{data.items.map(item => {
    const price = tokenPriceDisplay(item.price.nativeRawPerWholeToken);
    return <tr key={item.market.token}><td><Link className="asset-cell" href={`/tokens/${item.market.market}`}><AssetIcon name={item.market.symbol} /><div><strong>{item.market.name}</strong><span>{item.market.symbol}</span></div></Link></td><td>{formatIndexedAmount(item.balanceRaw, 8)} {item.market.symbol}</td><td>{price.approximate && !price.belowPrecision ? '≈ ' : ''}{price.text} test ETH / token<small className="indexed-subline">Price block {item.price.blockNumber}</small></td><td>Block {item.lastBalanceBlockNumber}</td><td><Link className="text-link" href={`/tokens/${item.market.market}`} aria-label={`Open ${item.market.name} market`}><ArrowUpRight size={16} /></Link></td></tr>;
  })}</tbody></table></div>;
}

/** Uses the portfolio's selected public address; it never selects a signing wallet. */
export function TokenPortfolioPanel({ wallet, expectedChainId, onRefreshPortfolio }: { wallet: string | null; expectedChainId?: number; onRefreshPortfolio?: () => void }) {
  const page = useTokenPortfolio(wallet); if (!wallet) return null;
  const data = page.data;
  return <section className="panel token-portfolio-panel section-gap" aria-label="Token balances"><div className="section-header"><div><h2>Token balances</h2><p>Tokens launched on oneshot held by the address selected above.</p></div><Button variant="secondary" loading={page.loading} onClick={() => void page.refresh()}>Refresh token balances</Button></div>
    {page.loading ? <Loading rows={3} /> : page.error && !data ? <ErrorState message={page.error} retry={() => void page.refresh()} /> : !data?.context.available ? <EmptyState compact title="Token balances are unavailable" description="Keep exploring token markets and refresh these balances later." action={<Button variant="secondary" onClick={() => void page.refresh()}>Refresh token balances</Button>} /> : expectedChainId !== undefined && data.context.network?.chainId !== expectedChainId ? <ErrorState message="Token balances belong to a different network from these NFT records. Refresh the portfolio before continuing." retry={() => { void page.refresh(); onRefreshPortfolio?.(); }} /> : <>
      <p className="token-analytics-checkpoint">{nftNetworkLabel(data.context.network)}. Balances through block {data.context.checkpoint!.number}; {data.context.lagBlocks} {data.context.lagBlocks === '1' ? 'block' : 'blocks'} behind the observed network head. Recent blocks may change.</p>
      {data.items.length ? <TokenPortfolioBalances data={data} /> : <EmptyState compact title="No oneshot tokens in this wallet" description="No positive token balances were found in the registered oneshot markets at this checkpoint." action={<ButtonLink href="/tokens" variant="secondary">Explore token markets</ButtonLink>} />}
      {page.error && <ErrorState message={page.error} retry={() => void page.loadMore()} />}
      <div className="indexed-page-footer"><span>{data.items.length} of {data.holdingCount} token balances loaded</span>{data.nextCursor && <Button variant="secondary" loading={page.loadingMore} onClick={() => void page.loadMore()}>Load more token balances</Button>}</div>
    </>}
    <p className="field-hint">Only registered oneshot token markets are included. Pool prices are separate from trade quotes. Native wallet balances, cash values and profit and loss are unavailable in this view.</p>
  </section>;
}
