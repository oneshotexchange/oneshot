"use client";

import { ArrowUpRight, Gem, Layers2, Plus, Search, ShieldCheck, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from 'react-router-dom';
import { Collection, items, useApi } from "../lib/client-api";
import { tokenIsWatched, useTokenWatchlist } from "../lib/token-watchlist";
import { tokenDiscoveryQuery, tokenMarketsPath, useTokenMarkets } from '../lib/client-token-markets';
import { CollectionGrid, TokenTable } from "./market-data";
import { Button, ButtonLink, EmptyState, ErrorState, Field, Loading, PageHeading, SearchInput, Tabs } from "./ui";
import { TokenMarketContext, TokenMarketsUnavailable } from './token-market-context';
import '../app/token-markets.css';

export function TokenDiscovery() {
  const [params, setParams] = useSearchParams(); let applied = '', filterError: string | null = null;
  try { applied = tokenDiscoveryQuery(params.toString()); } catch (error) { filterError = error instanceof Error ? error.message : 'Clear the search to browse markets.'; }
  const [query, setQuery] = useState(params.get('q') ?? ''), [tab, setTab] = useState('all'), [inputError, setInputError] = useState<string | null>(null);
  useEffect(() => { setQuery(params.get('q') ?? ''); setInputError(null); }, [params]);
  const response = useTokenMarkets(filterError ? null : tokenMarketsPath(applied)), watchlist = useTokenWatchlist();
  const tokens = (response.data?.items || []).filter(token => tab !== 'watchlist' || tokenIsWatched(watchlist.entries, token.token));
  function search(value: string) { try { tokenMarketsPath(value); setInputError(null); setParams(value.trim() ? { q: value.trim() } : {}); } catch (error) { setInputError(error instanceof Error ? error.message : 'Check the token search.'); } }
  return <><PageHeading title="Token markets" description="Review market terms and save the tokens you follow." action={<><Button variant="ghost" disabled={Boolean(filterError)} loading={response.loading} onClick={() => void response.refresh()}>Refresh markets</Button><ButtonLink href="/tokens/new"><Plus size={16} />Start a token draft</ButtonLink></>} />
    <div className="panel"><div className="panel-toolbar"><Tabs tabs={[{ value: 'all', label: 'All tokens' }, { value: 'watchlist', label: 'Watchlist' }]} active={tab} onChange={setTab} /></div>
      <form className="token-discovery-search" role="search" onSubmit={event => { event.preventDefault(); search(query); }}><Field label="Search token markets"><input type="search" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} placeholder="Name, symbol, token or market address" /></Field><Button type="submit" variant="secondary">Search</Button>{(applied || filterError) && <Button type="button" variant="ghost" onClick={() => search('')}>Clear search</Button>}</form>
      {inputError && <ErrorState message={inputError} />}
      {filterError ? <ErrorState message={filterError} /> : response.loading ? <Loading rows={5} /> : response.error && !response.data ? <ErrorState message={response.error} retry={() => void response.refresh()} /> : !response.data?.context.available ? <TokenMarketsUnavailable onRefresh={() => void response.refresh()} /> : <>
        <TokenMarketContext context={response.data.context} />
        {tab === 'watchlist' && !watchlist.loaded ? <Loading /> : tab === 'watchlist' && watchlist.error ? <ErrorState message={watchlist.error} retry={watchlist.refresh} /> : tokens.length === 0 && (applied || tab === 'watchlist') ? <EmptyState icon={tab === 'watchlist' ? Star : Search} title={tab === 'watchlist' ? watchlist.entries.length ? 'No saved tokens in these results' : 'Your watchlist is empty' : 'No matching markets'} description={tab === 'watchlist' ? `${response.data.nextCursor ? 'Load more markets to check the remaining results. ' : ''}Use the star beside a token to save its address on this device.` : 'Try another name, symbol or address, or clear your search.'} /> : <TokenTable tokens={tokens} />}
        {response.notice && <p className="data-notice" role="status">{response.notice}</p>}
        {response.error && <ErrorState message={response.error} retry={() => void response.loadMore()} />}
        <div className="indexed-page-footer"><span>{response.data.items.length} markets loaded{tab === 'watchlist' ? `, ${tokens.length} saved matches` : ''}</span>{response.data.nextCursor && <Button variant="secondary" loading={response.loadingMore} onClick={() => void response.loadMore()}>Load more markets</Button>}</div>
      </>}
    </div></>;
}
export function NftDiscovery() {
  const response = useApi<unknown>("/api/collections"); const [query, setQuery] = useState(""); const [tab, setTab] = useState("all");
  const collections = items<Collection>(response.data, "collections").filter(collection => (!query || `${collection.name} ${collection.description}`.toLowerCase().includes(query.toLowerCase())) && (tab !== "minting" || collection.status === "open"));
  return <><PageHeading title="NFT collections" description="Explore collections and see what’s minting." action={<ButtonLink href="/nfts/new"><Plus size={16} />Create a collection</ButtonLink>} /><div className="nft-feature"><div><h2>Put your work<br /><em>in a collection.</em></h2><p>Set a supply and mint price for your artwork.</p><ButtonLink href="/nfts/new" variant="secondary">Create a collection <ArrowUpRight size={15} /></ButtonLink></div><div className="nft-feature-art" aria-hidden="true"><div className="nft-art-card art-card-back"><span>01 / ∞</span><div className="nft-art-circle" /></div><div className="nft-art-card art-card-front"><div className="nft-art-asterisk">✳</div><strong>Your collection</strong></div></div></div><div className="section-header"><Tabs tabs={[{ value: "all", label: "All collections" }, { value: "minting", label: "Minting now" }]} active={tab} onChange={setTab} /><SearchInput value={query} onChange={setQuery} placeholder="Search collections" /></div><div className="panel collection-panel">{response.loading ? <Loading rows={4} /> : response.error ? <ErrorState message={response.error} retry={response.refresh} /> : <CollectionGrid collections={collections} />}</div><div className="nft-principles"><span><ShieldCheck size={15} />Frozen metadata at mint open</span><span><Gem size={15} />2% platform fee on paid mints & resale</span><span><Layers2 size={15} />Collections created on oneshot</span></div></>;
}
