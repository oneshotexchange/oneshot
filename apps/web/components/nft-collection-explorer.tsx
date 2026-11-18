import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, RefreshCw, Search, X } from 'lucide-react';
import type { IndexedNftContext, IndexedNftItem } from '@oneshot/evm';
import { createNftCollectionExploreLoader, emptyNftItemFilters, nftCollectionExplorePath, nftItemFiltersActive, nftItemFiltersFromSearch, nftItemFiltersSearch, nftManualTraitValue, nftTraitFilterKey, nftTraitNameOptionValue, normalizeNftItemFilters, type NftCollectionExploreResponse, type NftItemFilters, type NftItemTraitFilter } from '../lib/client-nft-collection-explorer';
import { readNftNetwork } from '../lib/nft-network';
import { Button, EmptyState, ErrorState, Field, Loading } from './ui';
import '../app/nft-collection-explorer.css';

const traitName = (name: string) => name || '(Unnamed trait)';
const traitValue = (value: string | number) => `${String(value) || '(Empty text)'} (${typeof value === 'number' ? 'number' : 'text'})`;

export function NftTraitNameSelect({ names, value, onChange }: { names: string[]; value: string; onChange(value: string): void }) {
  return <select value={value} onChange={event => onChange(event.target.value)}><option value="">Choose a trait</option>{names.map(name => <option value={nftTraitNameOptionValue(name)} key={name}>{traitName(name)}</option>)}</select>;
}

function useCollectionItems(path: string | null, expected: { collection: string; deploymentId: string; chainId: number; filters: NftItemFilters }) {
  const loader = useMemo(() => createNftCollectionExploreLoader(expected), [path, expected.collection, expected.deploymentId, expected.chainId]);
  const state = useSyncExternalStore(loader.subscribe, loader.snapshot, loader.snapshot);
  useEffect(() => { void loader.open(path); return () => loader.cancel(); }, [loader, path]);
  const active = state.path === path ? state : { data: null, loading: Boolean(path), loadingMore: false, error: null, notice: null };
  return { ...active, data: active.data as NftCollectionExploreResponse | null, refresh: loader.refresh, loadMore: loader.loadMore };
}

export function NftCollectionExplorerResults({ data, loading, loadingMore, error, notice, filtered, onRefresh, onRefreshCollection, onLoadMore, onClear, renderItems }: {
  data: NftCollectionExploreResponse | null; loading: boolean; loadingMore: boolean; error: string | null; notice: string | null; filtered: boolean;
  onRefresh(): void; onRefreshCollection(): void; onLoadMore(): void; onClear(): void; renderItems(items: IndexedNftItem[]): ReactNode;
}) {
  if (loading) return <Loading rows={4} />;
  if (error && !data) return <div className="nft-explorer-feedback"><ErrorState message={error} retry={onRefresh} /><div className="button-row"><Button type="button" variant="ghost" onClick={onClear}>Clear filters</Button><Button type="button" variant="ghost" onClick={onRefreshCollection}>Refresh collection</Button></div></div>;
  if (!data?.context.available || !data.discovery) return <EmptyState title="Collection items are unavailable" description="Refresh items to try again in a moment." action={<Button type="button" variant="secondary" onClick={onRefresh}>Refresh items <RefreshCw size={13} /></Button>} />;
  const discovery = data.discovery;
  return <>
    <div className="nft-explorer-result-heading" role="status" aria-live="polite"><span><strong>{discovery.matchingItems}</strong> {filtered ? 'matching NFTs' : 'NFTs'} <span className="muted">of {discovery.totalItems} minted and unburned</span></span><span>Items as of block {data.context.checkpoint?.number}. Recent activity may change.</span></div>
    {!discovery.metadataFilters.available && <div className="nft-explorer-metadata-note"><p>Name search and trait filters are currently unavailable. You can still browse by NFT number, availability, price or owner wallet.</p><Button type="button" variant="ghost" onClick={onRefresh}>Refresh items</Button></div>}
    {data.items.length ? renderItems(data.items) : <EmptyState compact title={filtered ? 'No NFTs match these filters' : 'No NFTs to show'} description={filtered ? 'Try a different name, number or price, or clear the filters to browse this collection.' : 'This collection has no minted, unburned NFTs at this checkpoint. Check the mint details above for the schedule and price.'} action={filtered ? <Button type="button" variant="secondary" onClick={onClear}>Clear filters</Button> : undefined} />}
    {notice && <p className="data-notice" role="status">{notice}</p>}
    {error && data && <div className="nft-explorer-feedback"><ErrorState message={error} retry={onLoadMore} /></div>}
    {data.items.length > 0 && <div className="indexed-page-footer"><span>{data.items.length} of {discovery.matchingItems} loaded</span>{data.nextCursor && <Button type="button" variant="secondary" loading={loadingMore} onClick={onLoadMore}>Load more <ArrowRight size={13} /></Button>}</div>}
  </>;
}

/** Complete collection queries stay in the URL; individual result pages never become a local filter index. */
export function NftCollectionExplorer({ collection, context, onRefreshCollection, renderItems }: {
  collection: string; context: IndexedNftContext; onRefreshCollection(): void; renderItems(items: IndexedNftItem[]): ReactNode;
}) {
  const [params, setParams] = useSearchParams(), search = params.toString();
  const applied = useMemo(() => {
    try { const filters = nftItemFiltersFromSearch(search); return { filters, path: nftCollectionExplorePath(collection, filters), error: null }; }
    catch (error) { return { filters: emptyNftItemFilters(), path: null, error: error instanceof Error ? error.message : 'Check the item filters, or clear them to continue.' }; }
  }, [collection, search]);
  const [draft, setDraft] = useState(applied.filters), [formError, setFormError] = useState<string | null>(null);
  const [facetType, setFacetType] = useState(''), [facetChoice, setFacetChoice] = useState('');
  const [manualName, setManualName] = useState(''), [manualType, setManualType] = useState<'string' | 'number'>('string'), [manualValue, setManualValue] = useState('');
  useEffect(() => { setDraft(applied.filters); setFormError(null); }, [applied]);
  const network = readNftNetwork(context.network), deploymentId = context.deploymentId || '';
  const page = useCollectionItems(applied.path && context.available && network && deploymentId ? applied.path : null, { collection, deploymentId, chainId: network?.chainId || 0, filters: applied.filters });
  const discovery = page.data?.discovery, metadataAvailable = discovery?.metadataFilters.available === true;
  const facets = discovery?.facets || [], names = [...new Set(facets.map(facet => facet.trait_type))];
  const values = facets.filter(facet => nftTraitNameOptionValue(facet.trait_type) === facetType);
  const active = nftItemFiltersActive(applied.filters);
  function change(update: Partial<NftItemFilters>) { setDraft(previous => ({ ...previous, ...update })); setFormError(null); }
  function addTrait(trait: NftItemTraitFilter) {
    try {
      const next = normalizeNftItemFilters({ ...draft, traits: [...draft.traits, trait] }); setDraft(next); setFormError(null);
    } catch (error) { setFormError(error instanceof Error ? error.message : 'Check the selected trait and try again.'); }
  }
  function apply(event: React.FormEvent) {
    event.preventDefault();
    try { const next = nftItemFiltersSearch(search, draft, deploymentId); nftCollectionExplorePath(collection, nftItemFiltersFromSearch(next.toString())); setFormError(null); setParams(next); }
    catch (error) { setFormError(error instanceof Error ? error.message : 'Check the item filters and try again.'); }
  }
  function clear() {
    try { const next = nftItemFiltersSearch(search, emptyNftItemFilters(), deploymentId); setDraft(emptyNftItemFilters()); setFormError(null); setParams(next); }
    catch (error) { setFormError(error instanceof Error ? error.message : 'Refresh the collection before changing its filters.'); }
  }
  return <div className="nft-collection-explorer" aria-label="Explore collection items">
    <form className="nft-explorer-form" role="search" aria-label="Search and filter collection items" onSubmit={apply}>
      <div className="nft-explorer-main-controls">
        <Field label="Search items" hint="Enter a name or NFT number, such as #42."><input value={draft.query} maxLength={100} placeholder="Name or NFT number" onChange={event => change({ query: event.target.value })} /></Field>
        <Field label="Availability"><select value={draft.availability} onChange={event => change({ availability: event.target.value as NftItemFilters['availability'] })}><option value="all">All items</option><option value="listed">For sale</option><option value="unlisted">Not listed</option></select></Field>
        <Field label="Sort items"><select value={draft.sort} onChange={event => change({ sort: event.target.value as NftItemFilters['sort'], ...(event.target.value.startsWith('price-') ? { availability: 'listed' as const } : {}) })}><option value="serial-asc">NFT number: low to high</option><option value="serial-desc">NFT number: high to low</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option></select></Field>
      </div>
      <details className="nft-explorer-more" open={Boolean(draft.minPrice || draft.maxPrice || draft.owner || draft.traits.length) || undefined}>
        <summary>Price, owner and traits{draft.traits.length ? ` (${draft.traits.length} selected)` : ''}</summary>
        <div className="nft-explorer-secondary-controls">
          <Field label="Minimum price (test ETH)"><input inputMode="decimal" value={draft.minPrice} placeholder="No minimum" onChange={event => change({ minPrice: event.target.value, ...(event.target.value.trim() ? { availability: 'listed' as const } : {}) })} /></Field>
          <Field label="Maximum price (test ETH)"><input inputMode="decimal" value={draft.maxPrice} placeholder="No maximum" onChange={event => change({ maxPrice: event.target.value, ...(event.target.value.trim() ? { availability: 'listed' as const } : {}) })} /></Field>
          <Field label="Owner wallet" hint="Includes NFTs this wallet has listed for sale."><input value={draft.owner} placeholder="0x…" autoComplete="off" spellCheck={false} onChange={event => change({ owner: event.target.value })} /></Field>
        </div>
        <p className="field-hint">Price filters and price sorting show active listings only. Buyer totals include the platform fee and creator royalty; gas is separate.</p>
        <fieldset className="nft-explorer-traits" disabled={!metadataAvailable}><legend>Traits</legend><p>Match any selected value within a trait. Every different trait must match.</p>
          <div className="nft-explorer-trait-picker">
            <Field label="Trait"><NftTraitNameSelect names={names} value={facetType} onChange={value => { setFacetType(value); setFacetChoice(''); }} /></Field>
            <Field label="Trait value"><select value={facetChoice} onChange={event => setFacetChoice(event.target.value)}><option value="">Choose a value</option>{values.map(facet => <option key={nftTraitFilterKey(facet)} value={nftTraitFilterKey(facet)}>{traitValue(facet.value)} · {facet.count} NFTs</option>)}</select></Field>
            <Button type="button" variant="secondary" disabled={!facetChoice || draft.traits.length >= 10} onClick={() => { const selected = values.find(facet => nftTraitFilterKey(facet) === facetChoice); if (selected) addTrait({ trait_type: selected.trait_type, value: selected.value }); }}>Add trait</Button>
          </div>
          <p className="field-hint">Trait counts cover minted, unburned NFTs across the collection, before these filters.{discovery?.facetsTruncated ? ' Some trait names or values are not shown; enter them below.' : ''}</p>
          <details className="nft-explorer-manual-trait"><summary>Enter a trait value</summary><div className="nft-explorer-manual-controls">
            <Field label="Trait name"><input value={manualName} maxLength={100} onChange={event => setManualName(event.target.value)} /></Field>
            <Field label="Value type"><select value={manualType} onChange={event => setManualType(event.target.value as 'string' | 'number')}><option value="string">Text</option><option value="number">Number</option></select></Field>
            <Field label="Exact trait value"><input value={manualValue} maxLength={200} onChange={event => setManualValue(event.target.value)} /></Field>
            <Button type="button" variant="secondary" disabled={draft.traits.length >= 10} onClick={() => { try { addTrait({ trait_type: manualName, value: nftManualTraitValue(manualValue, manualType) }); } catch (error) { setFormError(error instanceof Error ? error.message : 'Check the trait value.'); } }}>Add trait</Button>
          </div><p className="field-hint">Text “7” and number 7 are different values. Use the name, type and value saved in this NFT’s traits.</p></details>
        </fieldset>
        {!metadataAvailable && <p className="field-hint">Trait choices appear when the collection’s names and traits are available.</p>}
        {draft.traits.length > 0 && <ul className="nft-explorer-selected-traits" aria-label="Selected trait filters">{draft.traits.map(trait => <li key={nftTraitFilterKey(trait)}><span>{traitName(trait.trait_type)}: {traitValue(trait.value)}</span><button type="button" aria-label={`Remove ${traitName(trait.trait_type)}: ${traitValue(trait.value)}`} onClick={() => change({ traits: draft.traits.filter(value => nftTraitFilterKey(value) !== nftTraitFilterKey(trait)) })}><X size={13} aria-hidden="true" /></button></li>)}</ul>}
      </details>
      {(formError || applied.error) && <ErrorState message={formError || applied.error!} />}
      <div className="nft-explorer-actions"><Button type="submit" variant="secondary"><Search size={13} />Apply filters</Button><Button type="button" variant="ghost" onClick={clear}>Clear filters</Button><Button type="button" variant="ghost" loading={page.loading} onClick={() => { void page.refresh(); }}>Refresh items <RefreshCw size={13} /></Button></div>
    </form>
    {!applied.error && <NftCollectionExplorerResults {...page} filtered={active} onRefresh={() => { void page.refresh(); }} onRefreshCollection={onRefreshCollection} onLoadMore={() => { void page.loadMore(); }} onClear={clear} renderItems={renderItems} />}
  </div>;
}
