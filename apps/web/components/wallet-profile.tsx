import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useBlocker, useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Copy, ImagePlus, RefreshCw, Save, UserRound } from 'lucide-react';
import type { IndexedActivity, IndexedCollection, IndexedListing, IndexedNftItem, IndexedPage } from '@oneshot/evm';
import { createOneshotAccountApi } from '../lib/client-oneshot-api';
import { assertProfileAssetPage, profileAssetPath, readWalletProfile, type ProfileTab } from '../lib/client-wallet-profile';
import { IndexedPageLoader, indexedApi } from '../lib/client-indexed-api';
import { useWallet } from '../lib/client-wallet';
import { apiUrl } from '../lib/api-url';
import { emptyWalletProfile, profileWallet, walletProfileDetailsSchema, walletProfileHref, type AccountWalletProfile, type PublicWalletProfileResponse, type WalletProfileDetails } from '../lib/wallet-profile';
import { ActivityRows, IndexedCollectionCard, IndexedContextNote, IndexedItemCards, Listings } from './indexed-nfts';
import { Address, Button, ButtonLink, EmptyState, ErrorState, Field, Loading, Modal, PageHeading, SafetyNote, Tabs } from './ui';
import { WalletButton } from './wallet-button';
import { WalletFollowButton } from './wallet-following';
import { TokenPortfolioPanel } from './token-portfolio';
import { TokenTradesFeedPanel } from './token-analytics';
import { ReviewedWalletPanel } from './reviewed-nfts';
import { completeWalletProfileChange, restoreWalletProfileWorkingCopy, walletProfileEditConflict, walletProfileHasOpenEdits, type WalletProfileWorkingCopy } from '../lib/wallet-profile-editor';
import '../app/wallet-profile.css';

type ProfileAsset = IndexedCollection | IndexedNftItem | IndexedListing | IndexedActivity;
const assetKey = (item: ProfileAsset) => 'address' in item ? item.address : item.id;
const tabs = [{ value: 'created', label: 'Created collections' }, { value: 'collected', label: 'Collected NFTs' }, { value: 'listings', label: 'For sale' }, { value: 'activity', label: 'Activity' }];
const descriptions = {
  created: 'Collections created by this wallet on oneshot.',
  collected: 'NFTs currently held by this wallet. Listed NFTs are held by the marketplace and appear under For sale.',
  listings: 'Active oneshot listings from this wallet. Prices are asking prices; checkout checks the current terms again.',
  activity: 'NFT events involving this wallet on oneshot. An approval or transfer does not establish a purchase.',
};
function ProfileImage({ path, className, alt }: { path: string | null; className: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return <div className={className}>{path && !failed ? <img src={apiUrl(path)} alt={alt} referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <UserRound size={36} strokeWidth={1.2} aria-hidden="true" />}</div>;
}
export function ProfileIdentity({ wallet, details, preview = false }: { wallet: string; details: WalletProfileDetails | null; preview?: boolean }) {
  const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState(false);
  return <div className={`wallet-profile-identity${preview ? ' wallet-profile-preview' : ''}`}>
    {details?.bannerPath && <ProfileImage key={details.bannerPath} className="wallet-profile-banner" path={details.bannerPath} alt="Profile cover" />}
    <div className="wallet-profile-intro"><ProfileImage key={details?.avatarPath || 'none'} className="wallet-profile-avatar" path={details?.avatarPath || null} alt="Profile avatar" /><div className="wallet-profile-name">{preview ? <h3>{details?.displayName || 'Your display name'}</h3> : <h1>{details?.displayName || 'Wallet profile'}</h1>}<div className="wallet-profile-address"><Address value={wallet} full /><button type="button" aria-label="Copy profile wallet address" onClick={async () => { try { await navigator.clipboard.writeText(wallet); setCopied(true); setCopyError(false); } catch { setCopyError(true); } }}><Copy size={14} />{copied ? 'Copied' : 'Copy'}</button></div>{copyError && <p role="status">Select the wallet address above to copy it.</p>}</div></div>
    {details?.bio && <p className="wallet-profile-bio">{details.bio}</p>}
    {details?.website && <a className="text-link wallet-profile-website" href={details.website} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{new URL(details.website).hostname}<ArrowUpRight size={13} /><span className="muted">Self-reported website</span></a>}
  </div>;
}
function useProfileAssets(wallet: string, tab: ProfileTab, deployment: string | null) {
  const path = profileAssetPath(wallet, tab);
  const loader = useMemo(() => new IndexedPageLoader<ProfileAsset>(assetKey, async <T,>(url: string, signal?: AbortSignal) => {
    const page = assertProfileAssetPage(await indexedApi<IndexedPage<ProfileAsset>>(url, signal), wallet, tab);
    if (deployment && page.context.deploymentId !== deployment) throw new Error('NFT records are unavailable on this profile link’s original test network. Open a current collection link to continue.');
    return page as T;
  }), [wallet, tab, deployment]);
  const state = useSyncExternalStore(loader.subscribe, loader.snapshot, loader.snapshot);
  useEffect(() => { void loader.open(path); return () => loader.cancel(); }, [loader, path]);
  return { ...state, refresh: loader.refresh, loadMore: loader.loadMore };
}
export function PublicWalletProfile({ wallet: input }: { wallet: string }) {
  let wallet: string;
  try { wallet = profileWallet(input); } catch { return <><PageHeading title="Wallet profile" /><EmptyState title="Check the wallet address" description="Use a nonzero Ethereum wallet address, or explore NFT collections to find a creator." action={<ButtonLink href="/nfts">Explore NFTs</ButtonLink>} /></>; }
  return <PublicWalletProfileContent key={wallet} wallet={wallet} />;
}
function PublicWalletProfileContent({ wallet }: { wallet: string }) {
  const current = useWallet(), location = useLocation(), params = new URLSearchParams(location.search), deployments = params.getAll('deployment');
  const invalidDeployment = deployments.length > 1 || deployments.length === 1 && !/^[a-f0-9]{64}$/.test(deployments[0]);
  const [tab, setTab] = useState<ProfileTab>('created'), [profile, setProfile] = useState<PublicWalletProfileResponse | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true), [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setLoading(true); setError(null); setProfile(null);
    void readWalletProfile(wallet, controller.signal).then(value => { if (active) setProfile(value); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Profile details could not be loaded. Please try again.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [wallet, version]);
  return <>
    <div className="wallet-profile-toolbar"><ButtonLink href="/nfts" variant="ghost"><ArrowLeft size={13} />Explore NFTs</ButtonLink><div className="button-row"><Button variant="ghost" loading={loading} onClick={() => setVersion(value => value + 1)}><RefreshCw size={13} />Refresh details</Button>{current.authenticated && current.account?.address.toLowerCase() === wallet && <ButtonLink href="/settings/profile" variant="secondary">Edit profile</ButtonLink>}</div></div>
    <section className="panel wallet-profile-header"><ProfileIdentity wallet={wallet} details={profile?.profile || null} />
      <div className="wallet-profile-follow"><WalletFollowButton address={wallet} /></div>
      {loading ? <p className="wallet-profile-status" role="status">Loading profile details…</p> : error ? <ErrorState message={error} retry={() => setVersion(value => value + 1)} /> : !profile?.profile ? <p className="wallet-profile-status">This wallet has no published profile details. Its public NFT records are shown below when available.</p> : <p className="wallet-profile-status">Name, bio and images are supplied by this wallet’s account. They do not verify identity or ownership of artwork.</p>}
    </section>
    {invalidDeployment ? <ErrorState message="This profile link has an invalid NFT network selection. Open a current collection link to continue." /> : <ProfileAssets key={tab} wallet={wallet} tab={tab} deployment={deployments[0] || null} setTab={setTab} />}
    <TokenPortfolioPanel wallet={wallet} />
    <TokenTradesFeedPanel wallet={wallet} title="Token trades" description="Confirmed oneshot token buys and sells involving this wallet." />
    <ReviewedWalletPanel wallet={wallet} />
  </>;
}
function ProfileAssets({ wallet, tab, deployment, setTab }: { wallet: string; tab: ProfileTab; deployment: string | null; setTab(value: ProfileTab): void }) {
  const page = useProfileAssets(wallet, tab, deployment), context = page.data?.context, deploymentId = context?.deploymentId || undefined;
  return <section className="panel wallet-profile-assets"><div className="wallet-profile-asset-heading"><h2>Public NFT records</h2><Button variant="ghost" loading={page.loading} onClick={() => { void page.refresh(); }}><RefreshCw size={13} />Refresh</Button></div>
    <Tabs tabs={tabs} active={tab} onChange={value => setTab(value as ProfileTab)} /><p className="wallet-profile-scope">{descriptions[tab]}</p><IndexedContextNote context={context} />
    {page.loading ? <Loading rows={4} /> : page.error && !page.data ? <ErrorState message={page.error} retry={() => { void page.refresh(); }} /> : !page.data?.context.available ? <EmptyState title="NFT records are unavailable" description="Try refreshing in a moment. You can also explore collections or save a collection draft." action={<Button variant="secondary" onClick={() => { void page.refresh(); }}>Try again</Button>} /> : <>
      <p className="wallet-profile-checkpoint">As of block {context?.checkpoint?.number}. Recent activity may change.</p>
      {!page.data.items.length ? <EmptyState compact title={tab === 'created' ? 'No created collections' : tab === 'collected' ? 'No NFTs held by this wallet' : tab === 'listings' ? 'No active listings' : 'No NFT activity'} description="There are no matching oneshot records at this checkpoint." /> : tab === 'created' ? <div className="indexed-collection-grid">{(page.data.items as IndexedCollection[]).map(collection => <IndexedCollectionCard key={collection.address} collection={collection} deploymentId={deploymentId} />)}</div> : tab === 'collected' ? <IndexedItemCards items={page.data.items as IndexedNftItem[]} deploymentId={deploymentId} /> : tab === 'listings' ? <Listings listings={page.data.items as IndexedListing[]} deploymentId={deploymentId} /> : <ActivityRows activities={page.data.items as IndexedActivity[]} deploymentId={deploymentId} chainId={context?.network?.chainId} />}
      {page.notice && <p className="data-notice" role="status">{page.notice}</p>}{page.error && <ErrorState message={page.error} retry={() => { void page.loadMore(); }} />}
      <div className="indexed-page-footer"><span>{page.data.items.length} loaded</span>{page.data.nextCursor && <Button variant="secondary" loading={page.loadingMore} onClick={() => { void page.loadMore(); }}>Load more</Button>}</div>
    </>}
  </section>;
}

export function WalletProfileSettings() {
  const wallet = useWallet(), cache = useRef(new Map<string, WalletProfileWorkingCopy>()), previousUser = useRef(wallet.userId);
  // Keep wallet-switch edits only in memory for this signed-in account. Never put
  // private profile edits, identities or bearer tokens in browser storage.
  if (previousUser.current !== wallet.userId) { cache.current.clear(); previousUser.current = wallet.userId; }
  return <><PageHeading title="Your public profile" description="Save your name, bio and images, then choose when to publish them." />
    {!wallet.authenticated || !wallet.account ? <section className="panel settings-panel"><h2>{wallet.authenticated ? 'Choose a linked wallet' : 'Sign in to edit a profile'}</h2><p>{wallet.authenticated ? 'Connect a wallet linked to your account to save and publish its profile. Your saved drafts are unchanged.' : 'You can browse public profiles without signing in. Sign in to save your own profile details.'}</p><WalletButton /></section> : <ProfileEditor key={`${wallet.userId}:${wallet.account.address}`} walletAddress={wallet.account.address.toLowerCase()} cached={cache.current.get(wallet.account.address.toLowerCase())} remember={value => { if (value) cache.current.set(wallet.account!.address.toLowerCase(), value); else cache.current.delete(wallet.account!.address.toLowerCase()); }} />}
  </>;
}
function ProfileEditor({ walletAddress, cached, remember }: { walletAddress: string; cached?: WalletProfileWorkingCopy; remember(value: WalletProfileWorkingCopy | null): void }) {
  const wallet = useWallet(), currentWallet = useRef(wallet); currentWallet.current = wallet;
  const api = useMemo(() => createOneshotAccountApi({ identityScope: () => currentWallet.current.identityScope(), getAccessToken: () => currentWallet.current.getAccessToken() }), []);
  const [account, setAccount] = useState<AccountWalletProfile | null>(null), [working, setWorking] = useState<WalletProfileWorkingCopy>(cached || { draft: emptyWalletProfile(), baseRevision: 0, conflicted: false }), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(cached ? 'Your unsaved edits for this wallet are still open.' : null), [confirm, setConfirm] = useState<'publish' | 'unpublish' | 'reload' | 'review' | null>(null), [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
  const draft = working.draft, conflict = Boolean(account && walletProfileEditConflict(account, working));
  const active = useRef(true), request = useRef(0), dirty = account ? walletProfileHasOpenEdits(account, working) : Boolean(cached);
  const currentWorking = useRef(working); currentWorking.current = working;
  const blocked = useBlocker(dirty || busy);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before);
  }, [dirty, busy]);
  useEffect(() => { active.current = true; void load(false); return () => { active.current = false; request.current++; }; }, [walletAddress, api]);
  function keepWorking(copy: WalletProfileWorkingCopy, saved: AccountWalletProfile | null = account) {
    currentWorking.current = copy; setWorking(copy);
    remember(saved && !walletProfileHasOpenEdits(saved, copy) ? null : copy);
  }
  function patch(change: Partial<WalletProfileDetails>) { keepWorking({ ...currentWorking.current, draft: { ...currentWorking.current.draft, ...change } }); setError(null); setNotice(null); }
  async function load(discard: boolean) {
    const generation = ++request.current, open = discard ? undefined : account ? currentWorking.current : cached; setLoading(true); setError(null); setConfirm(null); setReviewedRevision(null);
    try { const value = await api.getWalletProfile(walletAddress); if (!active.current || generation !== request.current) return; setAccount(value); keepWorking(restoreWalletProfileWorkingCopy(value, open), value); }
    catch (reason) { if (active.current && generation === request.current) setError(reason instanceof Error ? reason.message : 'Your saved profile could not be loaded. Try again.'); }
    finally { if (active.current && generation === request.current) setLoading(false); }
  }
  async function reviewSaved() {
    if (!account || busy) return;
    const generation = ++request.current, open = currentWorking.current; setBusy(true); setError(null); setNotice(null); setReviewedRevision(null);
    try {
      const value = await api.getWalletProfile(walletAddress);
      if (!active.current || generation !== request.current) return;
      setAccount(value); keepWorking(restoreWalletProfileWorkingCopy(value, open), value); setReviewedRevision(value.revision); setConfirm('review');
    } catch (reason) { if (active.current && generation === request.current) setError(reason instanceof Error ? reason.message : 'The saved profile could not be loaded. Your open edits are still here.'); }
    finally { if (active.current && generation === request.current) setBusy(false); }
  }
  async function change(action: 'save' | 'publish' | 'unpublish', acknowledgedRevision?: number) {
    if (!account || busy || action !== 'unpublish' && conflict && (action !== 'save' || acknowledgedRevision !== account.revision)
      || action === 'publish' && dirty) return;
    const generation = ++request.current, submitted = currentWorking.current, selected = account; setBusy(true); setError(null); setNotice(null); setConfirm(null); setReviewedRevision(null);
    try {
      const value = await api.changeWalletProfile(action, selected, action === 'save' ? submitted.draft : undefined);
      if (!active.current || generation !== request.current) return;
      const next = completeWalletProfileChange(selected, submitted, action, value, acknowledgedRevision);
      setAccount(value); keepWorking(next, value);
      setNotice(action === 'save' ? 'Changes saved to your account. Your published profile has not changed.' : action === 'publish' ? 'Your saved profile details are now public.' : `Your profile details are no longer published. Public blockchain activity remains accessible.${walletProfileHasOpenEdits(value, next) ? ' Your open edits are still here and have not been saved.' : ''}`);
    } catch (reason) {
      if (active.current && generation === request.current) {
        // The request may have raced a newer version or its response may be unavailable.
        // Keep the original base until the user reviews a fresh saved version.
        keepWorking({ ...submitted, conflicted: true }, selected);
        setError(reason instanceof Error ? reason.message : 'The profile change could not be completed. Review its saved version before trying again.');
      }
    }
    finally { if (active.current && generation === request.current) setBusy(false); }
  }
  async function upload(file: File | undefined, field: 'avatarPath' | 'bannerPath') {
    if (!file || busy) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { setError('Choose a PNG, JPEG or WebP image up to 5 MiB.'); return; }
    const generation = ++request.current; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api.uploadArt(file);
      if (!active.current || generation !== request.current) return;
      const path = `/api/media/${result.hash}.webp`;
      if (!/^[a-f0-9]{64}$/.test(result.hash) || result.reference !== path || !Number.isSafeInteger(result.size) || result.size <= 0 || result.size > 5 * 1024 * 1024) throw new Error('The uploaded image could not be verified. Try uploading it again.');
      patch({ [field]: path }); setNotice('Image uploaded publicly. Save your changes to add it to the profile draft.');
    } catch (reason) { if (active.current && generation === request.current) setError(reason instanceof Error ? reason.message : 'The image could not be uploaded. Please try again.'); }
    finally { if (active.current && generation === request.current) setBusy(false); }
  }
  const valid = walletProfileDetailsSchema.safeParse(draft), changedPublication = Boolean(account && JSON.stringify(account.published && walletProfileDetailsSchema.parse({ displayName: account.published.displayName, bio: account.published.bio, website: account.published.website, avatarPath: account.published.avatarPath, bannerPath: account.published.bannerPath })) !== JSON.stringify(account.draft));
  return <div className="wallet-profile-editor"><section className="panel settings-panel"><div className="wallet-profile-edit-title"><h2>Profile details</h2><ButtonLink href={walletProfileHref(walletAddress)} variant="ghost">View public profile<ArrowUpRight size={13} /></ButtonLink></div><p className="wallet-profile-edit-address"><Address value={walletAddress} full /></p>
    {loading ? <Loading rows={3} /> : <>{error && <ErrorState message={error} retry={() => dirty ? setConfirm('reload') : void load(true)} />}{notice && <p className="data-notice" role="status">{notice}</p>}
      {conflict && <div className="section-gap"><p className="data-notice" role="status">The saved profile may have changed. Your open edits are preserved. Review the saved version before replacing it, or reload it to discard your open edits.</p><Button type="button" variant="secondary" disabled={busy} onClick={() => { void reviewSaved(); }}>Review saved changes</Button></div>}
      {account && <form onSubmit={event => { event.preventDefault(); void change('save'); }}><fieldset disabled={busy} className="wallet-profile-fields">
        <Field label="Display name" hint="Up to 60 characters. Names are not unique or identity verification."><input value={draft.displayName} maxLength={60} onChange={event => patch({ displayName: event.target.value })} /></Field>
        <Field label="Bio" hint="Tell collectors about your work. Plain text, up to 500 characters."><textarea rows={5} value={draft.bio} maxLength={500} onChange={event => patch({ bio: event.target.value })} /></Field>
        <Field label="Website" hint="Optional public HTTPS website. Visitors choose whether to open it."><input type="url" value={draft.website || ''} maxLength={2048} placeholder="https://example.com" onChange={event => patch({ website: event.target.value || null })} /></Field>
        <div className="wallet-profile-image-controls">{(['avatarPath', 'bannerPath'] as const).map(field => <div key={field}><label className="wallet-profile-upload"><ImagePlus size={18} /><span>Upload {field === 'avatarPath' ? 'avatar' : 'cover'} (public image)</span><input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file, field); }} /></label>{draft[field] && <Button type="button" variant="ghost" onClick={() => patch({ [field]: null })}>Remove {field === 'avatarPath' ? 'avatar' : 'cover'}</Button>}</div>)}</div>
        <p className="field-hint">PNG, JPEG or WebP, up to 5 MiB. Selecting an image uploads it publicly immediately, even while your profile is private. Use images you have permission to share. Removing a reference does not delete the uploaded file.</p>
        <div className="button-row"><Button type="submit" loading={busy} disabled={conflict || !valid.success || !dirty && account.revision > 0}><Save size={14} />Save changes</Button><Button type="button" variant="ghost" onClick={() => dirty ? setConfirm('reload') : void load(true)}>Reload saved profile</Button></div>
      </fieldset></form>}
      {account && <div className="wallet-profile-publication"><h3>{account.published ? 'Published profile' : 'Profile details are private'}</h3><p>{conflict ? 'Resolve the saved-profile change before saving or publishing your open edits.' : dirty ? 'Save your edits before publishing. Saving alone leaves the public version unchanged.' : account.published ? changedPublication ? 'Your saved changes differ from the public version. Publish to share them.' : 'The public version matches your saved details.' : 'Publish your saved details when you are ready to share them.'}</p><div className="button-row"><Button type="button" variant="secondary" disabled={busy || conflict || dirty || !account.draft.displayName || account.revision === 0 || !!account.published && !changedPublication} onClick={() => setConfirm('publish')}>Publish saved profile</Button>{account.published && <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirm('unpublish')}>Unpublish details</Button>}</div><SafetyNote>Publishing shows this wallet address, name, bio, images and website to everyone. Unpublishing hides these profile details. Public blockchain records and uploaded images remain accessible.</SafetyNote></div>}
    </>}
  </section><aside className="panel settings-panel wallet-profile-preview-panel"><h2>Preview</h2><p>Your open edits. Publish only after saving and reviewing them.</p><ProfileIdentity wallet={walletAddress} details={valid.success ? valid.data : { ...draft, website: null }} preview /></aside>
    {confirm && confirm !== 'review' && <Modal title={confirm === 'publish' ? 'Publish saved profile?' : confirm === 'unpublish' ? 'Unpublish profile details?' : 'Reload saved profile?'} onClose={() => setConfirm(null)}><p>{confirm === 'publish' ? 'Your saved name, bio, images, website and this wallet address will be public. Your account identity and private drafts stay private.' : confirm === 'unpublish' ? 'Your name, bio, images and website will be removed from the public profile. Your open edits are kept. Blockchain records and uploaded images remain public.' : 'Reloading discards your open edits and replaces them with the latest saved account version.'}</p><div className="button-row"><Button variant="ghost" onClick={() => setConfirm(null)}>Keep editing</Button><Button onClick={() => confirm === 'reload' ? void load(true) : void change(confirm)}>{confirm === 'publish' ? 'Publish profile' : confirm === 'unpublish' ? 'Unpublish details' : 'Discard edits and reload'}</Button></div></Modal>}
    {confirm === 'review' && account && reviewedRevision !== null && <Modal title="Review saved profile changes" onClose={() => { setConfirm(null); setReviewedRevision(null); }}><p>Compare the latest saved profile with your open edits. Saving your edits replaces the saved details shown here. Your published profile stays unchanged.</p><section className="section-gap"><h3>Saved account version</h3><ProfileIdentity wallet={walletAddress} details={account.draft} preview /></section><section className="section-gap"><h3>Your open edits</h3><ProfileIdentity wallet={walletAddress} details={valid.success ? valid.data : { ...draft, website: null }} preview /></section>{!valid.success && <p className="data-notice">Check your profile fields before saving these edits.</p>}<div className="button-row section-gap"><Button variant="ghost" onClick={() => { setConfirm(null); setReviewedRevision(null); }}>Keep editing</Button><Button variant="secondary" onClick={() => { keepWorking(restoreWalletProfileWorkingCopy(account), account); setConfirm(null); setReviewedRevision(null); setError(null); setNotice('Your open edits were replaced with the saved account version.'); }}>Use saved version</Button><Button disabled={busy || !valid.success} onClick={() => { void change('save', reviewedRevision); }}>Save my edits</Button></div></Modal>}
    {blocked.state === 'blocked' && <Modal title="Leave profile editor?" onClose={() => blocked.reset()}><p>{busy ? 'A profile request is still in progress. Leaving does not undo a request already sent. Reload the saved profile to check its result.' : 'Your open profile edits have not been saved to your account.'}</p><div className="button-row"><Button variant="secondary" onClick={() => blocked.reset()}>Keep editing</Button><Button variant="ghost" onClick={() => { remember(null); blocked.proceed(); }}>Leave editor</Button></div></Modal>}
  </div>;
}
