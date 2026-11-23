"use client";

import Link from "./navigation";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Gem, Layers2, Radio, Star } from "lucide-react";
import { Activity, apt, Collection, date } from "../lib/client-api";
import type { IndexedTokenMarket, TokenAnalytics } from '@oneshot/evm';
import { tokenNativeAmount, tokenSupplyAmount } from '../lib/client-token-markets';
import { tokenIsWatched, useTokenWatchlist } from "../lib/token-watchlist";
import { Address, AssetIcon, Badge, ButtonLink, EmptyState, ErrorState } from "./ui";
import '../app/token-markets.css';

/** Only canonical token snapshots enter this table; launch valuation is not a spot price. */
export function TokenTable({
  tokens,
  compact = false,
  analyticsByMarket,
  nativeSymbol = 'ETH',
}: {
  tokens: IndexedTokenMarket[];
  compact?: boolean;
  analyticsByMarket?: ReadonlyMap<string, TokenAnalytics>;
  nativeSymbol?: string;
}) {
  const watchlist = useTokenWatchlist();
  const showAnalytics = Boolean(analyticsByMarket && analyticsByMarket.size > 0);
  if (!tokens.length) return <EmptyState icon={Layers2} illustration="tokens" title="No token markets to show" description="No verified markets match this view. You can start a token draft and return later." compact={compact} action={<ButtonLink href="/tokens/new" variant="secondary">Start a draft <ArrowRight size={15} /></ButtonLink>} />;
  return <>{watchlist.error && <ErrorState message={watchlist.error} retry={watchlist.refresh} />}<div className="table-wrap"><table className="data-table token-table"><thead><tr><th className="star-column"><span className="sr-only">Watchlist</span></th><th>Token</th><th>Opening valuation <span>{nativeSymbol}</span></th><th>Current supply</th><th>Execution fee</th>{showAnalytics && <><th>Pool volume <span>{nativeSymbol}</span></th><th>Holders</th></>}<th /></tr></thead><tbody>{tokens.map(token => {
    const metrics = analyticsByMarket?.get(token.market.toLowerCase());
    return <tr key={token.market}><td><button className={`watch-button ${tokenIsWatched(watchlist.entries, token.token) ? "watched" : ""}`} disabled={!watchlist.loaded} onClick={() => watchlist.toggle(token.token)} aria-label={`${tokenIsWatched(watchlist.entries, token.token) ? "Remove" : "Add"} ${token.name} ${tokenIsWatched(watchlist.entries, token.token) ? "from" : "to"} watchlist`}><Star size={15} fill={tokenIsWatched(watchlist.entries, token.token) ? "currentColor" : "none"} /></button></td><td><Link className="asset-cell" href={`/tokens/${encodeURIComponent(token.market)}`}><AssetIcon name={token.symbol || token.name} /><div><strong>{token.name}</strong><span>{token.symbol}</span></div></Link></td><td className="numeric token-snapshot-amount">{tokenNativeAmount(token.openingValuationNativeRaw)}</td><td className="numeric token-snapshot-amount">{tokenSupplyAmount(token.totalSupplyRaw)}</td><td><Badge>{token.executionFeeBps / 100}%</Badge></td>{showAnalytics && <><td className="numeric token-snapshot-amount">{metrics ? tokenNativeAmount(metrics.poolNativeVolumeRaw) : '—'}</td><td className="numeric">{metrics ? metrics.holderCount : '—'}</td></>}<td><Link className="row-link" href={`/tokens/${encodeURIComponent(token.market)}`} aria-label={`Open ${token.name}`}><ArrowUpRight size={16} /></Link></td></tr>;
  })}</tbody></table></div></>;
}
export function CollectionGrid({ collections }: { collections: Collection[] }) {
  if (!collections.length) return <EmptyState icon={Gem} illustration="collection" title="No collections to show" description="Try another search, or start a collection of your own." action={<ButtonLink href="/nfts/new" variant="secondary">Create a collection <ArrowRight size={15} /></ButtonLink>} />;
  return <div className="collection-grid">{collections.map(collection => <Link className="collection-card" key={collection.id} href={`/nfts/${encodeURIComponent(collection.id)}`}><div className="collection-image">{collection.imageUrl ? <img src={collection.imageUrl} alt={collection.name} /> : <div className="collection-placeholder"><Gem size={44} strokeWidth={1} /><span>{collection.name}</span></div>}<Badge tone={collection.status === "open" ? "mint" : "neutral"}>{collection.status === "open" ? "Minting now" : collection.status || "Collection"}</Badge></div><div className="collection-card-body"><div className="collection-card-title"><h3>{collection.name}</h3><ArrowUpRight size={17} /></div>{collection.description && <p>{collection.description}</p>}<div className="collection-card-stats"><div><span>Mint price</span><strong>{Number(collection.publicPriceApt ?? collection.priceApt) === 0 ? "Free" : `${apt(collection.publicPriceApt ?? collection.priceApt)} ZRO`}</strong></div><div><span>Minted</span><strong>{collection.minted ?? 0}<span> / {collection.maxSupply ?? collection.supply ?? "N/A"}</span></strong></div></div></div></Link>)}</div>;
}
export function ActivityTable({ activities, compact = false }: { activities: Activity[]; compact?: boolean }) {
  if (!activities.length) return <EmptyState icon={Radio} illustration="activity" compact={compact} title="No activity yet" description="Transactions appear here after confirmation." />;
  return <div className="table-wrap"><table className="data-table"><thead><tr><th>Event</th><th>Asset</th><th>Value <span>ZRO</span></th><th>Wallet</th><th>Time</th><th /></tr></thead><tbody>{activities.map(activity => <tr key={activity.id}><td><span className="event-type"><span className={`event-icon ${["sell", "cancel"].includes(activity.type) ? "event-sell" : ""}`}>{activity.type === "sell" ? <ArrowUpRight size={13} /> : <ArrowDownLeft size={13} />}</span>{activity.type.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ")}</span></td><td><strong className="table-name">{activity.name || activity.symbol || "N/A"}</strong></td><td className="numeric">{apt(activity.amountApt)}</td><td><Address value={activity.wallet} /></td><td className="muted small">{date(activity.timestamp)}</td><td>{activity.transactionHash && <span className="muted small" title={activity.transactionHash}>Transaction hash</span>}</td></tr>)}</tbody></table></div>;
}
