import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { formatEther } from 'viem';
import { ArrowLeft, ArrowRight, Gem, RefreshCw } from 'lucide-react';
import { assertReviewedNftCheckpoint, fetchReviewedNftRead, reviewedNftAddress, reviewedNftCollectionHref, reviewedNftDeployment, reviewedNftDiscoveryHref, reviewedNftItemHref, reviewedNftTokenId, type ReviewedNftReadSelection } from '../lib/client-reviewed-nfts';
import { reviewedCollectionsPageSchema, reviewedCollectionDetailSchema, reviewedItemsPageSchema, reviewedItemDetailSchema, reviewedListingsPageSchema, reviewedActivityPageSchema, reviewedClaimsPageSchema, type ReviewedActivity, type ReviewedClaim, type ReviewedCollection, type ReviewedListing, type ReviewedNftContext } from '../lib/reviewed-nft-data';
import { nativeAssetLabel, nftNetworkLabel } from '../lib/nft-network';
import { Address, Badge, Button, ButtonLink, EmptyState, ErrorState, Field, InfoRow, Loading, PageHeading, Tabs } from './ui';
import { ReviewedNftTransactions } from './reviewed-nft-transactions';
import Link from './navigation';
import '../app/reviewed-nfts.css';

function useRead<T extends { context: ReviewedNftContext }>(selection: ReviewedNftReadSelection | null, schema: z.ZodType<T>, expected: string | null, cursor?: string, checkpoint?: ReviewedNftContext) {
  const scope = JSON.stringify([selection, expected, cursor, checkpoint?.checkpoint]), [version, setVersion] = useState(0);
  const [state, setState] = useState<{ scope: string; data: T | null; error: string | null; loading: boolean }>({ scope, data: null, error: null, loading: true });
  useEffect(() => {
    let current = true; const controller = new AbortController();
    if (!selection) { setState({ scope, data: null, error: null, loading: false }); return; }
    setState({ scope, data: null, error: null, loading: true });
    void fetchReviewedNftRead(selection, expected, cursor, controller.signal).then(value => { if (current) { const parsed = schema.parse(value); if (checkpoint && parsed.context.available) assertReviewedNftCheckpoint(parsed.context, checkpoint); setState({ scope, data: parsed, error: null, loading: false }); } })
      .catch(reason => { if (current) setState({ scope, data: null, error: reason instanceof z.ZodError ? 'These NFT records could not be read. Refresh to try again.' : reason instanceof Error ? reason.message : 'NFT records are unavailable. Refresh to try again.', loading: false }); });
    return () => { current = false; controller.abort(); };
  }, [scope, version]);
  return { ...(state.scope === scope ? state : { data: null, error: null, loading: true }), refresh: () => setVersion(value => value + 1) };
}
function useSelection(collection?: string, tokenId?: string) {
  const { search } = useLocation();
  try { return { deployment: reviewedNftDeployment(search), collection: collection === undefined ? null : reviewedNftAddress(collection), tokenId: tokenId === undefined ? null : reviewedNftTokenId(tokenId), error: null }; }
  catch (reason) { return { deployment: null, collection: null, tokenId: null, error: reason instanceof Error ? reason.message : 'Check this collection link.' }; }
}
function Context({ context }: { context: ReviewedNftContext | undefined }) {
  if (!context?.available) return null;
  return <div className="reviewed-context"><p>{nftNetworkLabel(context.network)} · Observed through block {context.checkpoint!.number}. Recent records may change.</p><p>These records begin at collection admission. NFTs without a later observed transfer may be missing.</p></div>;
}
function State({ read, empty, emptyDescription, children }: { read: { loading: boolean; error: string | null; data: { context: ReviewedNftContext } | null; refresh(): void }; empty?: boolean; emptyDescription?: string; children: React.ReactNode }) {
  return read.loading ? <Loading /> : read.error ? <ErrorState message={read.error} retry={read.refresh} /> : !read.data?.context.available ? <EmptyState icon={Gem} title="Collection records are unavailable" description="Check again later, or request a review for a collection you want to see here." action={<><Button variant="secondary" onClick={read.refresh}>Try again</Button><ButtonLink href="/nfts/import" variant="secondary">Request collection review</ButtonLink></>} />
    : empty ? <EmptyState icon={Gem} title="No matching records observed" description={emptyDescription ?? 'Earlier NFTs and transfers may be outside this collection’s recorded history. Check its activity or return later.'} /> : <>{children}</>;
}
function Pager({ cursor, next, back, forward, refresh }: { cursor: string | undefined; next: string | null; back(): void; forward(): void; refresh(): void }) {
  return <div className="reviewed-pager"><Button variant="secondary" disabled={!cursor} onClick={back}><ArrowLeft size={14} />Previous</Button><Button variant="ghost" onClick={refresh}>Refresh from start</Button><Button variant="secondary" disabled={!next} onClick={forward}>Next<ArrowRight size={14} /></Button></div>;
}
function usePages() { const [pages, setPages] = useState<string[]>([]); return { cursor: pages.at(-1), reset: () => setPages([]), back: () => setPages(value => value.slice(0, -1)), next: (cursor: string | null) => { if (cursor) setPages(value => [...value, cursor]); } }; }
function CollectionCard({ value, deployment }: { value: ReviewedCollection; deployment: string }) {
  return <Link href={reviewedNftCollectionHref(value.address, deployment)} className="panel reviewed-collection-card"><div><Gem size={22} /><Badge tone={value.active ? 'mint' : 'amber'}>{value.active ? 'Admission active' : 'Admission revoked'}</Badge></div><h2><Address value={value.address} /></h2><p>Review version {value.reviewVersion}</p><p>Records begin at block {value.observedFromBlock}</p><span>View observed NFTs and activity <ArrowRight size={14} /></span></Link>;
}
export function ReviewedNftDiscovery() {
  const selected = useSelection(), pages = usePages(), read = useRead(selected.error ? null : { kind: 'collections' }, reviewedCollectionsPageSchema, selected.deployment, pages.cursor);
  const [lookup, setLookup] = useState(''), [error, setError] = useState<string | null>(null), navigate = useNavigate();
  function open(event: React.FormEvent) { event.preventDefault(); try { const address = reviewedNftAddress(lookup.trim()); if (read.data?.context.deploymentId) navigate(reviewedNftCollectionHref(address, read.data.context.deploymentId)); else setError('Collection records are unavailable. Try again shortly.'); } catch (reason) { setError((reason as Error).message); } }
  const refresh = () => { pages.reset(); read.refresh(); };
  return <><PageHeading title="Reviewed collections" description="Explore collections created outside oneshot and their recorded NFT activity." action={<ButtonLink href="/nfts/import" variant="secondary">Request a collection review</ButtonLink>} />
    {selected.error && <ErrorState message={selected.error} />}<Context context={read.data?.context} />
    <form onSubmit={open} className="panel reviewed-lookup"><Field label="Collection contract address"><input value={lookup} onChange={event => setLookup(event.target.value)} maxLength={42} placeholder="0x…" spellCheck={false} /></Field><Button type="submit" variant="secondary" disabled={!read.data?.context.available}>Open collection</Button>{error && <p role="alert">{error}</p>}</form>
    <State read={{ ...read, refresh }} empty={read.data?.items.length === 0} emptyDescription="No collection admissions have been recorded here yet. Request a collection review or return later."><div className="reviewed-collection-grid">{read.data?.items.map(value => <CollectionCard key={value.address} value={value} deployment={read.data!.context.deploymentId!} />)}</div></State>
    {read.data?.context.available && <Pager cursor={pages.cursor} next={read.data.nextCursor} back={pages.back} forward={() => pages.next(read.data!.nextCursor)} refresh={refresh} />}
  </>;
}
const money = (value: string, nativeLabel = 'test ETH') => `${formatEther(BigInt(value))} ${nativeLabel}`;
function ListingRows({ items, deployment, nativeLabel = 'test ETH' }: { items: ReviewedListing[]; deployment: string; nativeLabel?: string }) {
  return <div className="reviewed-records">{items.map(value => <article key={value.listingId} className="reviewed-listing"><div><Link href={reviewedNftItemHref(value.collection, value.tokenId, deployment)}>NFT #{value.tokenId}</Link><Badge>{value.status === 'active' ? 'Listed' : value.status === 'sold' ? 'Sold' : 'Cancelled'}</Badge></div><InfoRow label="Total asking price">{money(value.totalPriceRaw, nativeLabel)}</InfoRow><InfoRow label="Royalty in this listing">{money(value.royaltyRaw, nativeLabel)}</InfoRow><InfoRow label="Seller"><Address value={value.seller} /></InfoRow><p>2% platform fee is included in the total. Gas is separate.</p></article>)}</div>;
}
const reviewedActivityTitles = { ReviewAdmitted: 'Collection admitted', ReviewRevoked: 'Admission revoked', Transfer: 'NFT transfer', Listed: 'NFT listed', Sold: 'NFT sold', Cancelled: 'Listing cancelled', Claimed: 'Payout claimed' } as const;
function ReviewedActivityRows({ items, deployment, nativeLabel = 'test ETH', showCollection = false }: { items: ReviewedActivity[]; deployment: string; nativeLabel?: string; showCollection?: boolean }) {
  return <div className="reviewed-records">{items.map(value => <article key={value.id} className="reviewed-event"><strong>{reviewedActivityTitles[value.eventName]}</strong>
    {showCollection && value.collection && <Link href={reviewedNftCollectionHref(value.collection, deployment)}><Address value={value.collection} /></Link>}
    {typeof value.args.tokenId === 'string' && (value.collection ? <Link href={reviewedNftItemHref(value.collection, value.args.tokenId, deployment)}>NFT #{value.args.tokenId}</Link> : <span>NFT #{value.args.tokenId}</span>)}
    {typeof value.args.totalPrice === 'string' && <span>{money(value.args.totalPrice, nativeLabel)}</span>}{value.eventName === 'Claimed' && <span>{money(String(value.args.amount), nativeLabel)}</span>}
    {value.eventName === 'Transfer' && <span>From <Address value={String(value.args.from)} /> to <Address value={String(value.args.to)} /></span>}<span>Block {value.blockNumber}</span><time>{new Date(value.timestamp).toLocaleString()}</time><Address value={value.transactionHash} /></article>)}</div>;
}
function CollectionRecords({ collection, context, refresh }: { collection: string; context: ReviewedNftContext; refresh(): void }) {
  const [tab, setTab] = useState('items');
  return <section className="panel reviewed-record-panel"><Tabs tabs={[{ value: 'items', label: 'Observed NFTs' }, { value: 'listings', label: 'Listings' }, { value: 'activity', label: 'Activity' }]} active={tab} onChange={setTab} /><CollectionTab key={`${collection}:${context.deploymentId}:${tab}`} collection={collection} context={context} tab={tab} refreshParent={refresh} /></section>;
}
function CollectionTab({ collection, context, tab, refreshParent }: { collection: string; context: ReviewedNftContext; tab: string; refreshParent(): void }) {
  const deployment = context.deploymentId!;
  const nativeLabel = nativeAssetLabel(context.network);
  const pages = usePages(), selection: ReviewedNftReadSelection = tab === 'items' ? { kind: 'items', collection } : tab === 'listings' ? { kind: 'listings', collection } : { kind: 'activity', collection };
  const schema = tab === 'items' ? reviewedItemsPageSchema : tab === 'listings' ? reviewedListingsPageSchema : reviewedActivityPageSchema;
  const read = useRead(selection, schema as z.ZodType<z.infer<typeof reviewedItemsPageSchema> | z.infer<typeof reviewedListingsPageSchema> | z.infer<typeof reviewedActivityPageSchema>>, deployment, pages.cursor, context);
  const refresh = () => { pages.reset(); refreshParent(); };
  return <><State read={{ ...read, refresh }} empty={read.data?.items.length === 0}>
    {tab === 'items' ? <div className="reviewed-item-grid">{read.data?.items.map(raw => { const value = reviewedItemsPageSchema.shape.items.element.parse(raw); return <Link className="reviewed-item" key={value.tokenId} href={reviewedNftItemHref(collection, value.tokenId, deployment)}><Gem size={24} /><h3>NFT #{value.tokenId}</h3><Badge>{value.burned ? 'Burned' : value.activeListingId ? 'Listed' : 'Observed transfer'}</Badge><p>{value.burned ? 'No current owner' : 'Observed owner'} {!value.burned && <Address value={value.owner} />}</p></Link>; })}</div>
      : tab === 'listings' ? <ListingRows items={reviewedListingsPageSchema.shape.items.parse(read.data?.items ?? [])} deployment={deployment} nativeLabel={nativeLabel} />
        : <ReviewedActivityRows items={reviewedActivityPageSchema.shape.items.parse(read.data?.items ?? [])} deployment={deployment} nativeLabel={nativeLabel} />}
  </State>{read.data?.context.available && <Pager cursor={pages.cursor} next={read.data.nextCursor} back={pages.back} forward={() => pages.next(read.data!.nextCursor)} refresh={refresh} />}</>;
}
export function ReviewedNftCollection({ collection }: { collection: string }) {
  const selected = useSelection(collection), read = useRead(selected.collection ? { kind: 'collection', collection: selected.collection } : null, reviewedCollectionDetailSchema, selected.deployment), value = read.data?.collection;
  return <><Link className="back-link" href={reviewedNftDiscoveryHref(selected.deployment ?? undefined)}><ArrowLeft size={14} />Reviewed collections</Link><PageHeading title="Collection" description="Recorded admission, observed NFTs and marketplace activity." action={<Button variant="secondary" onClick={read.refresh}><RefreshCw size={14} />Refresh</Button>} />{selected.error && <ErrorState message={selected.error} />}<Context context={read.data?.context} />
    <State read={read}>{value && <><section className="panel reviewed-detail"><h2><Address value={value.address} /></h2><InfoRow label="Registry admission"><Badge tone={value.active ? 'mint' : 'amber'}>{value.active ? 'Active' : 'Revoked'}</Badge></InfoRow><InfoRow label="Review version">{value.reviewVersion}</InfoRow><InfoRow label="Records begin at block">{value.observedFromBlock}</InfoRow><p>Admission records do not verify authorship, artwork rights or permanent contract behavior.</p></section><CollectionRecords key={`${value.address}:${read.data!.context.deploymentId}:${read.data!.context.checkpoint!.hash}`} collection={value.address} context={read.data!.context} refresh={read.refresh} /></>}</State>
  </>;
}
export function ReviewedNftItemDetail({ collection, tokenId }: { collection: string; tokenId: string }) {
  const selected = useSelection(collection, tokenId), read = useRead(selected.collection && selected.tokenId !== null ? { kind: 'item', collection: selected.collection, tokenId: selected.tokenId } : null, reviewedItemDetailSchema, selected.deployment), value = read.data?.item, listing = read.data?.listing;
  const nativeLabel = nativeAssetLabel(read.data?.context.network);
  return <><Link className="back-link" href={selected.collection && selected.deployment ? reviewedNftCollectionHref(selected.collection, selected.deployment) : reviewedNftDiscoveryHref()}><ArrowLeft size={14} />View collection</Link><PageHeading title={`NFT #${selected.tokenId ?? ''}`} description="Ownership and listings observed in this collection’s recorded history." action={<Button variant="secondary" onClick={read.refresh}><RefreshCw size={14} />Refresh</Button>} />{selected.error && <ErrorState message={selected.error} />}<Context context={read.data?.context} /><State read={read}>{value && <>
    <section className="panel reviewed-detail"><InfoRow label="Collection"><Address value={value.collection} /></InfoRow><InfoRow label="Token ID">{value.tokenId}</InfoRow><InfoRow label={value.burned ? 'Ownership' : 'Observed owner'}>{value.burned ? 'Burned' : <Address value={value.owner} />}</InfoRow><InfoRow label="First observed at block">{value.firstObservedBlockNumber}</InfoRow></section>
    {listing && <ListingRows items={[listing]} deployment={read.data!.context.deploymentId!} nativeLabel={nativeLabel} />}
    <ReviewedNftTransactions collection={value.collection} tokenId={value.tokenId} listing={listing ?? null} burned={value.burned} deploymentId={read.data!.context.deploymentId!} onRefresh={read.refresh} />
  </>}</State></>;
}

function ReviewedWalletTab({ wallet, tab }: { wallet: string; tab: 'items' | 'listings' | 'claims' | 'activity' }) {
  const pages = usePages();
  const selection: ReviewedNftReadSelection =
    tab === 'items' ? { kind: 'wallet-items', wallet }
      : tab === 'listings' ? { kind: 'seller-listings', seller: wallet, status: 'active' }
        : tab === 'claims' ? { kind: 'wallet-claims', wallet }
          : { kind: 'global-activity', wallet };
  const schema =
    tab === 'items' ? reviewedItemsPageSchema
      : tab === 'listings' ? reviewedListingsPageSchema
        : tab === 'claims' ? reviewedClaimsPageSchema
          : reviewedActivityPageSchema;
  const read = useRead(
    selection,
    schema as z.ZodType<
      z.infer<typeof reviewedItemsPageSchema> | z.infer<typeof reviewedListingsPageSchema> | z.infer<typeof reviewedClaimsPageSchema> | z.infer<typeof reviewedActivityPageSchema>
    >,
    null,
    pages.cursor,
  );
  const deployment = read.data?.context.deploymentId || '';
  const nativeLabel = nativeAssetLabel(read.data?.context.network);
  const refresh = () => { pages.reset(); read.refresh(); };
  return <>
    <Context context={read.data?.context} />
    <State
      read={{ ...read, refresh }}
      empty={read.data?.items.length === 0}
      emptyDescription={
        tab === 'items'
          ? 'No admitted external NFTs observed in this wallet.'
          : tab === 'listings'
            ? 'No active reviewed NFT listings from this wallet.'
            : tab === 'claims'
              ? 'No reviewed marketplace payout balances for this wallet.'
              : 'No reviewed NFT activity involving this wallet.'
      }
    >
      {tab === 'items' ? (
        <div className="reviewed-item-grid">
          {reviewedItemsPageSchema.shape.items.parse(read.data?.items ?? []).map(value => (
            <Link className="reviewed-item" key={`${value.collection}:${value.tokenId}`} href={reviewedNftItemHref(value.collection, value.tokenId, deployment)}>
              <Gem size={24} />
              <h3>NFT #{value.tokenId}</h3>
              <Badge>{value.activeListingId ? 'Listed' : 'Observed custody'}</Badge>
              <p><Address value={value.collection} /></p>
            </Link>
          ))}
        </div>
      ) : tab === 'listings' ? (
        <ListingRows items={reviewedListingsPageSchema.shape.items.parse(read.data?.items ?? [])} deployment={deployment} nativeLabel={nativeLabel} />
      ) : tab === 'claims' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Marketplace</th><th>Available payout</th><th>Total claimed</th><th>Last block</th></tr>
            </thead>
            <tbody>
              {(read.data?.items as ReviewedClaim[] | undefined ?? []).map(claim => (
                <tr key={`${claim.marketplace}:${claim.account}`}>
                  <td><Address value={claim.marketplace} /></td>
                  <td>{money(claim.pendingRaw, nativeLabel)}</td>
                  <td>{money(claim.claimedRaw, nativeLabel)}</td>
                  <td>Block {claim.lastBlockNumber}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ReviewedActivityRows items={reviewedActivityPageSchema.shape.items.parse(read.data?.items ?? [])} deployment={deployment} nativeLabel={nativeLabel} showCollection />
      )}
    </State>
    {read.data?.context.available && <Pager cursor={pages.cursor} next={read.data.nextCursor} back={pages.back} forward={() => pages.next(read.data!.nextCursor)} refresh={refresh} />}
  </>;
}

export function ReviewedWalletPanel({ wallet, includeClaims = false }: { wallet: string; includeClaims?: boolean }) {
  let normalized: string;
  try { normalized = reviewedNftAddress(wallet); } catch { return null; }
  const [tab, setTab] = useState<'items' | 'listings' | 'claims' | 'activity'>('items');
  const [version, setVersion] = useState(0);
  const tabs = includeClaims
    ? [{ value: 'items', label: 'Observed NFTs' }, { value: 'listings', label: 'Listings' }, { value: 'claims', label: 'Marketplace payouts' }]
    : [{ value: 'items', label: 'Observed NFTs' }, { value: 'listings', label: 'Listings' }, { value: 'activity', label: 'Activity' }];
  return (
    <section className="panel reviewed-record-panel section-gap" aria-label="Reviewed external NFTs">
      <div className="section-header">
        <div>
          <h2>Reviewed external NFTs</h2>
          <p>ERC-721 collections reviewed and admitted outside oneshot.</p>
        </div>
        <div className="heading-actions">
          <Button variant="secondary" onClick={() => setVersion(value => value + 1)}><RefreshCw size={14} />Refresh</Button>
          <ButtonLink href="/nfts/reviewed" variant="ghost">Explore reviewed</ButtonLink>
        </div>
      </div>
      <Tabs tabs={tabs} active={tab} onChange={value => setTab(value as typeof tab)} />
      <ReviewedWalletTab key={`${normalized}:${tab}:${version}`} wallet={normalized} tab={tab} />
    </section>
  );
}

export function ReviewedGlobalActivityPanel({ wallet }: { wallet?: string }) {
  const normalized = wallet ? (() => { try { return reviewedNftAddress(wallet); } catch { return undefined; } })() : undefined;
  const pages = usePages();
  const read = useRead({ kind: 'global-activity', ...(normalized ? { wallet: normalized } : {}) }, reviewedActivityPageSchema, null, pages.cursor);
  const deployment = read.data?.context.deploymentId || '';
  const nativeLabel = nativeAssetLabel(read.data?.context.network);
  const refresh = () => { pages.reset(); read.refresh(); };
  return <>
    <Context context={read.data?.context} />
    <State read={{ ...read, refresh }} empty={read.data?.items.length === 0} emptyDescription="Recorded external collection admissions, listings and sales will appear here.">
      <ReviewedActivityRows items={reviewedActivityPageSchema.shape.items.parse(read.data?.items ?? [])} deployment={deployment} nativeLabel={nativeLabel} showCollection />
    </State>
    {read.data?.context.available && <Pager cursor={pages.cursor} next={read.data.nextCursor} back={pages.back} forward={() => pages.next(read.data!.nextCursor)} refresh={refresh} />}
  </>;
}
