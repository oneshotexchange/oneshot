import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Gem, RefreshCw, Wallet } from 'lucide-react';
import { formatIndexedAmount, type IndexedActivity, type IndexedClaim, type IndexedCollection, type IndexedCollectionResponse, type IndexedItemResponse, type IndexedListing, type IndexedNftContext, type IndexedNftItem } from '@oneshot/evm';
import Link from './navigation';
import { useWallet } from '../lib/client-wallet';
import { NftCheckout, NftTransactionRecovery } from './nft-checkout';
import { NftEarnings } from './nft-earnings';
import { sameIndexedCheckpoint, useIndexedPage, useIndexedResource } from '../lib/client-indexed-api';
import { indexedPresentation, type IndexedPresentation } from '../lib/client-indexed-presentation';
import { nftDeploymentLinkIssue } from '../lib/client-nft-deployment-link';
import { shortAddress } from '../lib/client-api';
import { Address, Badge, Button, ButtonLink, EmptyState, ErrorState, Field, InfoRow, Loading, PageHeading, SafetyNote, Stat, Tabs } from './ui';

const base = '/api/oneshot/indexed';
const collectionKey = (value: IndexedCollection) => value.address;
const itemKey = (value: IndexedNftItem) => value.id;
const listingKey = (value: IndexedListing) => value.id;
const activityKey = (value: IndexedActivity) => value.id;
const claimKey = (value: IndexedClaim) => `${value.contract}:${value.beneficiary}`;
const collectionPath = (address: string) => `${base}/collections/${encodeURIComponent(address)}`;
const deploymentQuery = (deploymentId?: string) => deploymentId && /^[a-f0-9]{64}$/.test(deploymentId) ? `?deployment=${deploymentId}` : '';
const collectionHref = (address: string, deploymentId?: string) => `/nfts/${encodeURIComponent(address)}${deploymentQuery(deploymentId)}`;
const itemHref = (value: Pick<IndexedNftItem, 'collection' | 'tokenId'>, deploymentId?: string) => `/nfts/${encodeURIComponent(value.collection)}/${encodeURIComponent(value.tokenId)}${deploymentQuery(deploymentId)}`;
const amount = (value: string) => `${formatIndexedAmount(value)} ETH`;
const listingStatus = { active: 'For sale', sold: 'Sold', cancelled: 'Canceled' };

function ArtworkFrame({ presentation, alt, className, caption }: { presentation: IndexedPresentation | null; alt: string; className: string; caption?: string }) {
  const [failed, setFailed] = useState(false);
  return <div className={`${className} indexed-artwork`}>
    {presentation && !failed ? <img src={presentation.imageUrl} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : <div className="indexed-art-fallback"><Gem size={40} strokeWidth={1} aria-hidden="true" /><span>{failed ? 'Artwork could not be loaded' : 'Art unavailable'}</span></div>}
    {caption && <span className="indexed-art-caption">{caption}</span>}
  </div>;
}

function IndexedArtwork(props: Parameters<typeof ArtworkFrame>[0]) {
  // A different content URL gets a fresh failure state, including after navigation or refresh.
  return <ArtworkFrame key={props.presentation?.imageUrl || 'unavailable'} {...props} />;
}

function PresentationMetadata({ presentation }: { presentation: IndexedPresentation }) {
  return <a className="text-link" href={presentation.metadataUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">View metadata <ArrowRight size={12} aria-hidden="true" /></a>;
}

export function IndexedContextNote({ context }: { context: IndexedNftContext | null | undefined }) {
  if (context?.network?.mode !== 'local' || context.network.chainId !== 31337) return null;
  return <div className="indexed-context" role="status"><Badge tone="amber">Test network</Badge><p>Collections, activity and ETH amounts shown here belong to a local test network.</p></div>;
}

type PagedResult = { loading: boolean; loadingMore: boolean; error: string | null; notice: string | null; data: { context: IndexedNftContext; items: unknown[]; nextCursor: string | null } | null; refresh(): unknown; loadMore(): unknown };
function PageFooter({ page }: { page: PagedResult }) {
  return <>{page.notice && <div className="data-notice" role="status">{page.notice}</div>}{page.error && page.data && <ErrorState message={page.error} retry={() => { void page.loadMore(); }} />}
    {page.data?.context.available && <div className="indexed-page-footer"><span>{page.data.items.length} results</span>{page.data.nextCursor && <Button variant="secondary" loading={page.loadingMore} onClick={() => { void page.loadMore(); }}>Load more <ArrowRight size={13} /></Button>}</div>}</>;
}
function PageBody({ page, empty, description = 'New activity will appear here after confirmation.', unavailable = 'NFT browsing is unavailable', action, footer = true, children }: { page: PagedResult; empty: string; description?: string; unavailable?: string; action?: React.ReactNode; footer?: boolean; children: React.ReactNode }) {
  if (page.loading) return <Loading rows={4} />;
  if (page.error && !page.data) return <ErrorState message={page.error} retry={() => { void page.refresh(); }} />;
  if (!page.data?.context.available) return <EmptyState title={unavailable} description="Try refreshing in a moment." action={<Button variant="secondary" onClick={() => { void page.refresh(); }}>Try again <RefreshCw size={14} /></Button>} />;
  return <>{page.data.items.length ? children : <EmptyState icon={Gem} title={empty} description={description} action={action} />}{footer && <PageFooter page={page} />}</>;
}

/** The home page and NFT routes share the same records and availability states. */
export function IndexedCollectionHighlights() {
  const page = useIndexedPage<IndexedCollection>(`${base}/collections`, collectionKey);
  return <><IndexedContextNote context={page.data?.context} /><PageBody page={page} footer={false} empty="No collections yet" description="Save a draft with your artwork and mint settings to start a collection of your own." action={<ButtonLink href="/nfts/new" variant="secondary">Create collection draft <ArrowRight size={14} /></ButtonLink>}><div className="indexed-collection-grid">{page.data?.items.slice(0, 3).map(collection => <IndexedCollectionCard key={collection.address} collection={collection} deploymentId={page.data?.context.deploymentId || undefined} />)}</div></PageBody></>;
}

export function IndexedActivityHighlights() {
  const page = useIndexedPage<IndexedActivity>(`${base}/activity`, activityKey);
  return <><IndexedContextNote context={page.data?.context} /><PageBody page={page} footer={false} unavailable="Activity is unavailable" empty="No NFT activity yet" description="Confirmed NFT mints, listings, sales and payouts will appear here."><ActivityRows activities={page.data?.items.slice(0, 4) || []} deploymentId={page.data?.context.deploymentId || undefined} /></PageBody></>;
}

export function IndexedItemCards({ items, deploymentId }: { items: IndexedNftItem[]; deploymentId?: string }) {
  return <div className="item-grid">{items.map(item => {
    const presentation = indexedPresentation(item.presentation, item.tokenId);
    const name = presentation?.name || `NFT #${item.tokenId}`;
    return <Link className="item-card" key={item.id} href={itemHref(item, deploymentId)}><IndexedArtwork className="item-card-image" presentation={presentation} alt={`${name}, NFT #${item.tokenId}`} /><div className="item-card-info"><h3>{name}</h3>{presentation && <span className="indexed-item-serial">NFT #{item.tokenId}</span>}<div><span>{item.burned ? 'Burned' : item.listing?.status === 'active' ? 'Listed for sale' : 'Owned'}</span></div>{item.listing?.status === 'active' && <strong className="indexed-amount">{amount(item.listing.totalPriceRaw)}</strong>}<div className="indexed-address"><Address value={item.owner || undefined} /></div></div></Link>;
  })}</div>;
}

function Listings({ listings, deploymentId }: { listings: IndexedListing[]; deploymentId?: string }) {
  return <div className="table-scroll"><table className="data-table indexed-table"><thead><tr><th>NFT</th><th>Status</th><th>Buyer total</th><th>Seller</th></tr></thead><tbody>{listings.map(listing => <tr key={listing.id}><td><Link className="text-link" href={itemHref(listing, deploymentId)}>#{listing.tokenId}</Link><small className="indexed-subline" title={listing.collection}>{shortAddress(listing.collection)}</small></td><td><Badge>{listingStatus[listing.status]}</Badge></td><td className="indexed-amount">{amount(listing.totalPriceRaw)}</td><td><Address value={listing.seller} /></td></tr>)}</tbody></table></div>;
}

export function IndexedNftDiscovery() {
  const page = useIndexedPage<IndexedCollection>(`${base}/collections`, collectionKey);
  return <><PageHeading title="NFT collections" description="Find a collection, explore the artwork and check its mint terms." action={<><Button variant="ghost" loading={page.loading} onClick={() => { void page.refresh(); }}><RefreshCw size={13} />Refresh</Button><ButtonLink href="/nfts/new">Create a collection <ArrowRight size={14} /></ButtonLink></>} />
    <IndexedContextNote context={page.data?.context} />
    <section className="panel" aria-label="Collections">
      <PageBody page={page} empty="No collections yet" description="Save a draft with your artwork and mint settings to start a collection of your own."><div className="indexed-collection-grid">{page.data?.items.map(collection => <IndexedCollectionCard key={collection.address} collection={collection} deploymentId={page.data?.context.deploymentId || undefined} />)}</div></PageBody>
    </section></>;
}

export function IndexedCollectionCard({ collection, deploymentId }: { collection: IndexedCollection; deploymentId?: string }) {
  const presentation = indexedPresentation(collection.presentation, '1');
  return <Link className="collection-card indexed-collection-card" href={collectionHref(collection.address, deploymentId)}><IndexedArtwork className="collection-image" presentation={presentation} alt={`First NFT from ${collection.name}: ${presentation?.name || 'stored artwork'}`} caption={presentation ? 'First NFT' : undefined} /><div className="collection-card-body"><div className="indexed-card-title"><h3>{collection.name}</h3><Badge tone={collection.opened ? 'mint' : 'neutral'}>{collection.opened ? 'Mint terms locked' : 'Mint not open'}</Badge></div><p>{collection.symbol}, <Address value={collection.creator} /></p><div className="indexed-card-stats"><span><strong>{collection.totalMinted}</strong> minted</span><span>View mint details</span></div></div></Link>;
}

export function IndexedCollectionPreview({ collection }: { collection: IndexedCollection }) {
  const presentation = indexedPresentation(collection.presentation, '1');
  if (!presentation) return null;
  return <section className="panel indexed-collection-preview" aria-label="First NFT preview"><IndexedArtwork className="indexed-preview-art" presentation={presentation} alt={`First NFT from ${collection.name}: ${presentation.name}`} /><div><h2>{presentation.name || 'NFT #1'}</h2>{presentation.description && <p className="indexed-presentation-description">{presentation.description}</p>}<p className="indexed-preview-note">Artwork from the first NFT in this collection.</p><PresentationMetadata presentation={presentation} /></div></section>;
}

export function IndexedNftCollection({ id }: { id: string }) {
  const location = useLocation();
  const response = useIndexedResource<IndexedCollectionResponse>(collectionPath(id));
  const [tab, setTab] = useState('items');
  const page = useIndexedPage<IndexedNftItem>(tab === 'items' ? `${collectionPath(id)}/items` : null, itemKey);
  const listings = useIndexedPage<IndexedListing>(tab === 'listings' ? `${base}/listings?collection=${encodeURIComponent(id)}&status=active` : null, listingKey);
  const activity = useIndexedPage<IndexedActivity>(tab === 'activity' ? `${base}/activity?collection=${encodeURIComponent(id)}` : null, activityKey);
  const refresh = () => { response.refresh(); void page.refresh(); void listings.refresh(); void activity.refresh(); };
  if (response.loading) return <Loading rows={5} />;
  if (response.error) return <><ButtonLink href="/nfts" variant="ghost"><ArrowLeft size={13} />All collections</ButtonLink><ErrorState message={response.error} retry={response.refresh} /></>;
  const expectedDeployment = new URLSearchParams(location.search).get('deployment') || response.data?.context.deploymentId || undefined;
  const deploymentIssue = nftDeploymentLinkIssue(location.search, response.data?.context.deploymentId);
  if (deploymentIssue) return <><ButtonLink href="/nfts" variant="ghost"><ArrowLeft size={13} />All collections</ButtonLink><EmptyState title="Collection network changed" description={deploymentIssue} /></>;
  const collection = response.data?.collection;
  if (!collection) return <><ButtonLink href="/nfts" variant="ghost"><ArrowLeft size={13} />All collections</ButtonLink><IndexedContextNote context={response.data?.context} /><EmptyState title="Collection unavailable" description="This collection could not be found. Check the address or browse other collections." /></>;
  const active = tab === 'items' ? page : tab === 'listings' ? listings : activity;
  const changed = Boolean(active.data && response.data && !sameIndexedCheckpoint(active.data.context, response.data.context));
  return <><Link className="back-link" href="/nfts"><ArrowLeft size={13} />All collections</Link><PageHeading title={collection.name} description="Artwork, mint terms and collection history." action={<Button variant="secondary" onClick={refresh}><RefreshCw size={13} />Refresh collection</Button>} />
    <IndexedContextNote context={response.data?.context} />
    <IndexedCollectionPreview collection={collection} />
    <div className="metric-grid" style={{gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))'}}><Stat label="Total minted" value={collection.totalMinted} /><Stat label="Mint sales" value={formatIndexedAmount(collection.primaryTotalPriceRaw)} suffix="ETH" note="Total paid by collectors" /><Stat label="Mint terms" value={collection.opened ? 'Locked' : 'Editable'} note="Locked when minting opens" /></div>
    <NftCheckout collection={collection.address} indexedDeploymentId={response.data?.context.deploymentId} onRefresh={refresh} />
    <section className="panel"><div className="panel-toolbar"><Tabs tabs={[{ value: 'items', label: 'Items' }, { value: 'listings', label: 'Active listings' }, { value: 'activity', label: 'Activity' }]} active={tab} onChange={setTab} /></div>
      {changed ? <div className="indexed-snapshot-change"><p>The collection has changed. Refresh to see its latest activity.</p><Button onClick={refresh} variant="secondary">Refresh collection</Button></div> : tab === 'items' ? <PageBody page={page} empty="No NFTs minted yet" description="Check the mint details above for the schedule and price."><IndexedItemCards items={page.data?.items || []} deploymentId={expectedDeployment} /></PageBody> : tab === 'listings' ? <PageBody page={listings} empty="No active listings" description="Open an NFT you own to list it for sale."><Listings listings={listings.data?.items || []} deploymentId={expectedDeployment} /></PageBody> : <PageBody page={activity} empty="No activity yet" description="Mints, listings, sales and payouts appear after confirmation."><ActivityRows activities={activity.data?.items || []} deploymentId={expectedDeployment} /></PageBody>}
    </section>
    <section className="panel indexed-details"><h2>Collection details</h2><InfoRow label="Collection address"><Address value={collection.address} full /></InfoRow><InfoRow label="Creator"><Address value={collection.creator} full /></InfoRow><InfoRow label="Artwork preview">{indexedPresentation(collection.presentation, '1') ? 'First NFT' : 'Unavailable'}</InfoRow></section>
    <SafetyNote>Review the current mint terms and total cost before approving a transaction in your wallet.</SafetyNote></>;
}

export function IndexedNftItemDetail({ collectionId, itemId }: { collectionId: string; itemId: string }) {
  const location = useLocation();
  const response = useIndexedResource<IndexedItemResponse>(`${collectionPath(collectionId)}/items/${encodeURIComponent(itemId)}`);
  const expectedDeployment = new URLSearchParams(location.search).get('deployment') || response.data?.context.deploymentId || undefined;
  const deploymentIssue = !response.loading && !response.error ? nftDeploymentLinkIssue(location.search, response.data?.context.deploymentId) : null;
  if (deploymentIssue) return <><ButtonLink href="/nfts" variant="ghost"><ArrowLeft size={13} />All collections</ButtonLink><EmptyState title="Collection network changed" description={deploymentIssue} /></>;
  const presentation = response.data?.item ? indexedPresentation(response.data.item.presentation, response.data.item.tokenId) : null;
  return <><Link className="back-link" href={collectionHref(collectionId, expectedDeployment)}><ArrowLeft size={13} />View collection</Link><PageHeading title={presentation?.name || `NFT #${itemId}`} description={presentation ? `NFT #${itemId}` : undefined} />
    {response.loading ? <Loading rows={4} /> : response.error ? <ErrorState message={response.error} retry={response.refresh} /> : <><IndexedContextNote context={response.data?.context} />{response.data?.item ? <><IndexedItemRecord item={response.data.item} deploymentId={expectedDeployment} /><NftCheckout key={response.data.item.id} collection={collectionId} item={response.data.item} indexedDeploymentId={response.data.context.deploymentId} onRefresh={response.refresh} /></> : <EmptyState icon={Gem} title="NFT unavailable" description="This NFT could not be found. Check the item address or browse its collection." />}</>}
  </>;
}

export function IndexedItemRecord({ item, deploymentId }: { item: IndexedNftItem; deploymentId?: string }) {
  const presentation = indexedPresentation(item.presentation, item.tokenId);
  return <div className="item-detail-layout"><div><IndexedArtwork className="item-detail-art indexed-item-art" presentation={presentation} alt={`${presentation?.name || 'NFT'}, NFT #${item.tokenId}`} />{Boolean(presentation?.attributes.length) && <div className="trait-grid indexed-traits" aria-label="Item traits">{presentation!.attributes.map((trait, index) => <div className="trait" key={`${trait.trait_type}:${index}`}><span>{trait.trait_type}</span><strong>{trait.value}</strong></div>)}</div>}</div><section className="panel indexed-details"><h2>NFT details</h2>{presentation?.description && <p className="indexed-presentation-description indexed-item-description">{presentation.description}</p>}<InfoRow label="Serial">{item.tokenId}</InfoRow><InfoRow label="Collection"><Link className="text-link" href={collectionHref(item.collection, deploymentId)}><Address value={item.collection} /></Link></InfoRow><InfoRow label="Owner">{item.burned ? 'Burned' : <Address value={item.owner || undefined} full />}</InfoRow><InfoRow label="Metadata">{presentation ? <PresentationMetadata presentation={presentation} /> : 'Unavailable'}</InfoRow>{item.listing ? <><InfoRow label="Resale status">{listingStatus[item.listing.status]}</InfoRow><InfoRow label="Buyer total"><span className="indexed-amount">{amount(item.listing.totalPriceRaw)}</span></InfoRow><InfoRow label="Seller"><Address value={item.listing.seller} /></InfoRow></> : <InfoRow label="Active listing">None</InfoRow>}<SafetyNote>Ownership and listing details are checked again before a transaction is approved.</SafetyNote></section></div>;
}

function activityAmount(activity: IndexedActivity) {
  const raw = activity.args.totalPrice ?? activity.args.amount;
  if (raw === undefined) return 'Not applicable';
  return typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw) ? amount(raw) : 'Unavailable';
}
function eventTitle(value: string) {
  const labels: Record<string, string> = { CollectionCreated: 'Collection created', TermsConfigured: 'Mint terms set', CollectionOpened: 'Mint opened', Transfer: 'NFT transferred', Minted: 'NFT minted', Listed: 'NFT listed', Sold: 'NFT sold', Cancelled: 'Listing canceled', Claimed: 'Proceeds claimed', Approval: 'NFT approved', ApprovalForAll: 'Marketplace approval changed', PolicyCommitted: 'Listing floor updated' };
  return labels[value] || value.replace(/([a-z])([A-Z])/g, '$1 $2');
}
function eventTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString(); }
function ActivityRows({ activities, deploymentId }: { activities: IndexedActivity[]; deploymentId?: string }) {
  return <div className="table-scroll"><table className="data-table indexed-table"><thead><tr><th>Event</th><th>Amount</th><th>Block / transaction</th><th>Time</th></tr></thead><tbody>{activities.map(activity => <tr key={activity.id}><td><strong>{eventTitle(activity.eventName)}</strong>{activity.collection && <Link href={collectionHref(activity.collection, deploymentId)} className="indexed-subline text-link">{shortAddress(activity.collection)}</Link>}{typeof activity.args.tokenId === 'string' && <small className="indexed-subline">NFT #{activity.args.tokenId}</small>}</td><td className="indexed-amount">{activityAmount(activity)}</td><td>Block {activity.blockNumber}<span className="indexed-subline" title={activity.transactionHash}>{shortAddress(activity.transactionHash)}</span></td><td>{eventTime(activity.timestamp)}</td></tr>)}</tbody></table></div>;
}

export function IndexedActivityPage() {
  const page = useIndexedPage<IndexedActivity>(`${base}/activity`, activityKey);
  return <><PageHeading title="NFT activity" description="Mints, listings, sales and payouts across oneshot." action={<Button variant="secondary" loading={page.loading} onClick={() => { void page.refresh(); }}><RefreshCw size={13} />Refresh</Button>} /><IndexedContextNote context={page.data?.context} /><section className="panel"><PageBody page={page} unavailable="Activity is unavailable" empty="No activity yet"><ActivityRows activities={page.data?.items || []} deploymentId={page.data?.context.deploymentId || undefined} /></PageBody></section><SafetyNote>Recent transactions may change while the network confirms them.</SafetyNote></>;
}

export function IndexedPortfolioPage() {
  const { account } = useWallet();
  const [addressInput, setAddressInput] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [tab, setTab] = useState('owned');
  const wallet = selected || account?.address.toLowerCase() || null;
  const owned = useIndexedPage<IndexedNftItem>(wallet && tab === 'owned' ? `${base}/wallets/${wallet}/items` : null, itemKey);
  const listed = useIndexedPage<IndexedListing>(wallet && tab === 'listed' ? `${base}/listings?seller=${wallet}&status=active` : null, listingKey);
  const claims = useIndexedPage<IndexedClaim>(wallet && tab === 'claims' ? `${base}/wallets/${wallet}/claims` : null, claimKey);
  const status = useIndexedResource<{ context: IndexedNftContext }>(wallet ? null : `${base}/status`);
  const active = tab === 'owned' ? owned : tab === 'listed' ? listed : claims;
  function inspect(event: React.FormEvent) {
    event.preventDefault();
    const value = addressInput.trim();
    if (!/^0x[\da-fA-F]{40}$/.test(value)) { setInputError('Enter a complete Ethereum wallet address.'); return; }
    setInputError(null); setSelected(value.toLowerCase());
  }
  const refresh = () => { void owned.refresh(); void listed.refresh(); void claims.refresh(); status.refresh(); };
  return <><PageHeading title="Your portfolio" description="Manage your NFTs, listings and creator earnings." />
    <NftEarnings onRefresh={refresh} />
    <section className="panel indexed-details"><form onSubmit={inspect} className="indexed-wallet-form"><Field label="Wallet address" hint="Look up any wallet. No sign-in or signature needed."><input value={addressInput} onChange={event => setAddressInput(event.target.value)} placeholder={account?.address || '0x…'} aria-label="Wallet address to inspect" /></Field><Button type="submit" variant="secondary"><Wallet size={13} />View portfolio</Button>{account && <Button type="button" variant="ghost" onClick={() => { setSelected(null); setAddressInput(''); setInputError(null); }}>Use connected wallet</Button>}</form>{inputError && <ErrorState message={inputError} />}{wallet && <p className="indexed-wallet-address">Viewing <Address value={wallet} full /></p>}</section>
    <IndexedContextNote context={active.data?.context || status.data?.context} />
    {!wallet ? status.error ? <ErrorState message={status.error} retry={status.refresh} /> : <EmptyState icon={Wallet} title="View your portfolio" description="Connect your wallet or enter an Ethereum address to view its NFTs and activity." /> : <section className="panel"><div className="panel-toolbar"><Tabs tabs={[{ value: 'owned', label: 'Owned NFTs' }, { value: 'listed', label: 'Listed for sale' }, { value: 'claims', label: 'Completed payouts' }]} active={tab} onChange={setTab} /><Button variant="ghost" onClick={() => { void active.refresh(); }} loading={active.loading}><RefreshCw size={13} />Refresh</Button></div>{tab === 'owned' ? <PageBody page={owned} empty="No NFTs in this wallet" description="Mint or buy an NFT to add it to your wallet." action={<ButtonLink href="/nfts" variant="secondary">Explore collections <ArrowRight size={14} /></ButtonLink>}><IndexedItemCards items={owned.data?.items || []} deploymentId={owned.data?.context.deploymentId || undefined} /></PageBody> : tab === 'listed' ? <PageBody page={listed} empty="No NFTs listed for sale" description="Open an NFT you own to review a listing."><Listings listings={listed.data?.items || []} deploymentId={listed.data?.context.deploymentId || undefined} /></PageBody> : <PageBody page={claims} empty="No completed payouts" description="Payouts will appear here after the wallet claims its NFT proceeds."><div className="table-scroll"><table className="data-table indexed-table"><thead><tr><th>Payout source</th><th>Total received</th><th>Last payout recipient</th></tr></thead><tbody>{claims.data?.items.map(claim => <tr key={claimKey(claim)}><td><Address value={claim.contract} /></td><td className="indexed-amount">{amount(claim.totalClaimedRaw)}</td><td><Address value={claim.recipient} /></td></tr>)}</tbody></table></div></PageBody>}</section>}
    <NftTransactionRecovery onRefresh={refresh} /><SafetyNote>Available proceeds belong to your connected wallet. NFT records and completed payouts show the address selected above. Token holdings and wallet balances are unavailable.</SafetyNote></>;
}
