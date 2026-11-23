import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { RefreshCw, UserPlus, Check } from 'lucide-react';
import type { IndexedActivity, IndexedPage } from '@oneshot/evm';
import { createOneshotAccountApi } from '../lib/client-oneshot-api';
import { IndexedPageLoader, indexedApi, useIndexedPage } from '../lib/client-indexed-api';
import { assertProfileAssetPage } from '../lib/client-wallet-profile';
import { encodeFollowedWallets, type WalletFollowing } from '../lib/wallet-following';
import { useWallet } from '../lib/client-wallet';
import { walletProfileHref } from '../lib/wallet-profile';
import { ActivityRows, IndexedContextNote } from './indexed-nfts';
import { TokenTradesFeedPanel } from './token-analytics';
import { ReviewedGlobalActivityPanel } from './reviewed-nfts';
import { Address, Button, ButtonLink, EmptyState, ErrorState, Loading, PageHeading, SafetyNote, Tabs } from './ui';
import { WalletButton } from './wallet-button';
import Link from './navigation';

function useFollowing() {
  const wallet = useWallet(), current = useRef(wallet); current.current = wallet;
  const scope = wallet.authenticated ? wallet.identityScope() : null;
  const api = useMemo(() => createOneshotAccountApi({ getAccessToken: () => current.current.getAccessToken(), identityScope: () => current.current.identityScope() }), []);
  const [state, setState] = useState<{ scope: string | null; data: WalletFollowing | null; loading: boolean; busy: boolean; error: string | null }>({ scope, data: null, loading: Boolean(scope), busy: false, error: null });
  const [version, setVersion] = useState(0), generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    setState({ scope, data: null, loading: Boolean(scope), busy: false, error: null });
    if (scope) void api.getWalletFollowing().then(data => { if (generation.current === request) setState({ scope, data, loading: false, busy: false, error: null }); })
      .catch(reason => { if (generation.current === request) setState({ scope, data: null, loading: false, busy: false, error: reason instanceof Error ? reason.message : 'Your following list could not be loaded. Try again.' }); });
    return () => { generation.current++; };
  }, [scope, version, api]);
  const selected = state.scope === scope ? state : { scope, data: null, loading: Boolean(scope), busy: false, error: null };
  async function change(address: string, following: boolean) {
    if (!selected.data || selected.busy || !scope) return;
    const request = ++generation.current; setState({ ...selected, busy: true, error: null });
    try { const data = await api.changeWalletFollowing(selected.data, address, following); if (generation.current === request) setState({ scope, data, loading: false, busy: false, error: null }); }
    catch (reason) { if (generation.current === request) setState({ ...selected, busy: false, error: reason instanceof Error ? reason.message : 'Your following list could not be changed. Reload it before trying again.' }); }
  }
  return { ...selected, change, refresh: () => setVersion(value => value + 1) };
}
export function WalletFollowButton({ address }: { address: string }) {
  const wallet = useWallet(), following = useFollowing(), [signInError, setSignInError] = useState<string | null>(null);
  const selected = following.data?.wallets.includes(address) === true;
  async function signIn() { try { setSignInError(null); await wallet.connect(); } catch { setSignInError('Sign-in could not be opened. Please try again.'); } }
  const error = following.error || (!wallet.authenticated ? signInError : null);
  return <div className="wallet-follow-control">{!wallet.authenticated ? <Button variant="secondary" disabled={!wallet.configured || !!wallet.unavailableReason} onClick={() => { void signIn(); }}><UserPlus size={14} />Sign in to follow</Button> : <Button variant="secondary" loading={following.loading || following.busy} disabled={!following.data || !!following.error} onClick={() => { void following.change(address, !selected); }}>{selected ? <Check size={14} /> : <UserPlus size={14} />}{selected ? 'Unfollow wallet' : 'Follow wallet'}</Button>}
    {error && <ErrorState message={error} retry={following.error ? following.refresh : () => { void signIn(); }} />}
    {wallet.authenticated && !following.error && following.data && <span className="field-hint">Your following list is private</span>}
  </div>;
}
const eventKey = (activity: IndexedActivity) => activity.id;
export function assertFollowingActivity(page: IndexedPage<IndexedActivity>, wallets: string[]) {
  if (!wallets.length || !Array.isArray(page.items)) throw new Error('This activity feed could not be verified. Please refresh it.');
  if (!page.context?.available) { assertProfileAssetPage(page, wallets[0], 'activity'); return page; }
  if (!Array.isArray(page.items) || page.items.length > 50) throw new Error('This activity feed could not be verified. Please refresh it.');
  assertProfileAssetPage({ ...page, items: [] }, wallets[0], 'activity');
  const ids = new Set<string>();
  for (const event of page.items) {
    const matched = wallets.find(wallet => event && event.args && Object.entries(event.args).some(([key, value]) => ['creator','payer','recipient','from','to','account','owner','approved','operator','buyer','seller','bidder','caller'].includes(key) && value === wallet));
    if (!matched || ids.has(event.id)) throw new Error('This activity feed could not be verified for your followed wallets. Please refresh it.');
    assertProfileAssetPage({ ...page, items: [event] }, matched, 'activity'); ids.add(event.id);
  }
  return page;
}
function FollowingEvents({ following }: { following: WalletFollowing }) {
  const encoded = encodeFollowedWallets(following.wallets), path = `/api/oneshot/indexed/activity?wallets=${encoded}`;
  const loader = useMemo(() => new IndexedPageLoader<IndexedActivity>(eventKey, async <T,>(url: string, signal?: AbortSignal) => assertFollowingActivity(await indexedApi<IndexedPage<IndexedActivity>>(url, signal), following.wallets) as T), [encoded]);
  const state = useSyncExternalStore(loader.subscribe, loader.snapshot, loader.snapshot);
  useEffect(() => { void loader.open(path); return () => loader.cancel(); }, [loader, path]);
  return <ActivityFeedResults page={{ ...state, refresh: loader.refresh, loadMore: loader.loadMore }} />;
}
type ActivityPageState = { loading: boolean; loadingMore: boolean; error: string | null; notice: string | null; data: IndexedPage<IndexedActivity> | null; refresh(): unknown; loadMore(): unknown };
export function ActivityFeedResults({ page }: { page: ActivityPageState }) {
  if (page.loading) return <Loading rows={4} />;
  if (page.error && !page.data) return <ErrorState message={page.error} retry={() => { void page.refresh(); }} />;
  if (!page.data?.context.available) return <EmptyState title="Activity is unavailable" description="Refresh the feed to try again in a moment." action={<Button variant="secondary" onClick={() => { void page.refresh(); }}>Refresh activity</Button>} />;
  const { context, items } = page.data;
  return <><IndexedContextNote context={context} /><p className="wallet-profile-checkpoint">As of block {context.checkpoint?.number}. Recent activity may change.</p>{items.length ? <ActivityRows activities={items} deploymentId={context.deploymentId || undefined} chainId={context.network?.chainId} /> : <EmptyState compact title="No NFT activity at this checkpoint" description="Confirmed NFT events will appear here as they are recorded." />}
    {page.notice && <p className="data-notice" role="status">{page.notice}</p>}{page.error && <ErrorState message={page.error} retry={() => { void page.loadMore(); }} />}<div className="indexed-page-footer"><span>{items.length} events loaded</span><Button variant="ghost" onClick={() => { void page.refresh(); }}><RefreshCw size={13} />Refresh</Button>{page.data.nextCursor && <Button variant="secondary" loading={page.loadingMore} onClick={() => { void page.loadMore(); }}>Load more</Button>}</div></>;
}
function FollowedActivity() {
  const wallet = useWallet(), following = useFollowing();
  if (!wallet.authenticated) return <section className="settings-panel"><h2>Follow wallets you want to return to</h2><p>Sign in to save a private following list. You do not need to link a wallet to follow creators and collectors.</p><WalletButton /></section>;
  if (following.loading) return <Loading rows={3} />;
  if (following.error || !following.data) return <ErrorState message={following.error || 'Your following list could not be loaded. Please try again.'} retry={following.refresh} />;
  return <><div className="wallet-profile-asset-heading"><span>Your following list is private</span><Button variant="ghost" disabled={following.busy} onClick={following.refresh}><RefreshCw size={13} />Reload following</Button></div><details className="wallet-following-list"><summary>Following {following.data.wallets.length} of 50 wallets · private to your account</summary><ul>{following.data.wallets.map(address => <li key={address}><Link className="text-link" href={walletProfileHref(address)}><Address value={address} /></Link><Button variant="ghost" disabled={following.busy} onClick={() => { void following.change(address, false); }}>Unfollow</Button></li>)}</ul></details>
    {following.data.wallets.length ? <><FollowingEvents key={JSON.stringify(following.data.wallets)} following={following.data} /><TokenTradesFeedPanel key={`tokens:${JSON.stringify(following.data.wallets)}`} wallets={following.data.wallets} title="Followed token trades" description="Confirmed oneshot token buys and sells involving wallets you follow." /></> : <EmptyState title="You’re not following any wallets yet" description="Open a creator or collector profile and choose Follow wallet. Your following list is private." action={<ButtonLink href="/nfts" variant="secondary">Explore NFT collections</ButtonLink>} />}
  </>;
}
export function WalletActivityPage() {
  const [tab, setTab] = useState('all'), all = useIndexedPage<IndexedActivity>(tab === 'all' ? '/api/oneshot/indexed/activity' : null, eventKey);
  return <><PageHeading title="Market activity" description="Explore NFT events, reviewed collections and token trades across oneshot or from wallets you follow." /><section className="panel wallet-profile-assets"><Tabs tabs={[{ value: 'all', label: 'NFT activity' }, { value: 'following', label: 'Following' }, { value: 'tokens', label: 'Token trades' }, { value: 'reviewed', label: 'Reviewed NFTs' }]} active={tab} onChange={setTab} />{tab === 'all' ? <ActivityFeedResults page={all} /> : tab === 'following' ? <FollowedActivity /> : tab === 'tokens' ? <TokenTradesFeedPanel title="Token trades" description="Confirmed oneshot token buys and sells across registered markets." /> : <ReviewedGlobalActivityPanel />}</section><SafetyNote>This feed shows public NFT and token events. Transfers and approvals do not prove a trade, and recent confirmations can change. Following a wallet does not copy its trades, send funds or notify its owner.</SafetyNote></>;
}
