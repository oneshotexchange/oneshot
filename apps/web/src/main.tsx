import { Component, Suspense, lazy, useEffect, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, Route, RouterProvider, Routes, useLocation, useParams } from 'react-router-dom';
import { Providers } from '../components/providers';
import { ThemeProvider } from '../components/theme-provider';
import { Shell } from '../components/shell';
import { Overview } from '../components/overview';
import { IndexedNftDiscovery, IndexedNftCollection, IndexedNftItemDetail, IndexedPortfolioPage } from '../components/indexed-nfts';
import { ReviewedNftDiscovery, ReviewedNftCollection, ReviewedNftItemDetail } from '../components/reviewed-nfts';
import { GenesisAuthProvider } from '../components/genesis-auth';
import { Loading } from '../components/ui';
import WorkspaceError from '../app/error';
import NotFound from '../app/not-found';
import { workspaceNavigationKey } from '../lib/workspace-navigation';
import { trackPageVisit } from '../lib/client-analytics';
import '../app/globals.css';
import '../app/themes.css';
import '../app/theme-picker.css';
import '../app/brand.css';
import '../app/studio-illustration.css';
import '../app/motion.css';
import '../app/launchpad.css';

function lazyNamed<TModule, TProps extends object>(
  loader: () => Promise<TModule>,
  pick: (mod: TModule) => ComponentType<TProps>,
) {
  return lazy(async () => ({ default: pick(await loader()) }));
}

const TokenDiscovery = lazyNamed(() => import('../components/discovery'), m => m.TokenDiscovery);
const TokenLaunch = lazyNamed(() => import('../components/token-launch'), m => m.TokenLaunch);
const TokenTerminal = lazyNamed(() => import('../components/token-terminal'), m => m.TokenTerminal);
const NftCreate = lazyNamed(() => import('../components/nft-create'), m => m.NftCreate);
const NftCartPage = lazyNamed(() => import('../components/nft-cart'), m => m.NftCartPage);
const AdminPage = lazyNamed(() => import('../components/workspace-pages'), m => m.AdminPage);
const SettingsPage = lazyNamed(() => import('../components/workspace-pages'), m => m.SettingsPage);
const AirdropPage = lazyNamed(() => import('../components/airdrop-page'), m => m.AirdropPage);
const PublicWalletProfile = lazyNamed(() => import('../components/wallet-profile'), m => m.PublicWalletProfile);
const WalletProfileSettings = lazyNamed(() => import('../components/wallet-profile'), m => m.WalletProfileSettings);
const WalletActivityPage = lazyNamed(() => import('../components/wallet-following'), m => m.WalletActivityPage);
const ExternalNftImportsPage = lazyNamed(() => import('../components/external-nft-imports'), m => m.ExternalNftImportsPage);

class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <WorkspaceError error={null} retry={() => this.setState({ failed: false })} />
      : this.props.children;
  }
}

function TokenPage() { const { id = '' } = useParams(); return <TokenTerminal id={id} />; }
function CollectionPage() { const { id = '' } = useParams(); return <IndexedNftCollection id={id} />; }
function ItemPage() { const { id = '', item = '' } = useParams(); return <IndexedNftItemDetail collectionId={id} itemId={item} />; }
function ProfilePage() { const { wallet = '' } = useParams(); return <PublicWalletProfile wallet={wallet} />; }
function ReviewedCollectionPage() { const { collection = '' } = useParams(); return <ReviewedNftCollection collection={collection} />; }
function ReviewedItemPage() { const { collection = '', tokenId = '' } = useParams(); return <ReviewedNftItemDetail collection={collection} tokenId={tokenId} />; }

function WhitelistRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/airdrop${search}`} replace />;
}

function Workspace() {
  const location = useLocation();
  const navigationKey = workspaceNavigationKey(location.pathname, location.search);
  useEffect(() => { window.scrollTo(0, 0); }, [navigationKey]);
  useEffect(() => { trackPageVisit(location.pathname); }, [location.pathname]);
  const content = <PageBoundary key={navigationKey}><Suspense fallback={<Loading rows={4} />}><Routes>
    <Route path="/airdrop" element={<AirdropPage />} />
    <Route path="/whitelist" element={<WhitelistRedirect />} />
    <Route path="/" element={<Overview />} />
    <Route path="/tokens" element={<TokenDiscovery />} />
    <Route path="/tokens/new" element={<TokenLaunch />} />
    <Route path="/tokens/:id" element={<TokenPage />} />
    <Route path="/nfts" element={<IndexedNftDiscovery />} />
    <Route path="/nfts/new" element={<NftCreate />} />
    <Route path="/nfts/import" element={<ExternalNftImportsPage />} />
    <Route path="/nfts/reviewed" element={<ReviewedNftDiscovery />} />
    <Route path="/nfts/reviewed/:collection" element={<ReviewedCollectionPage />} />
    <Route path="/nfts/reviewed/:collection/:tokenId" element={<ReviewedItemPage />} />
    <Route path="/nfts/cart" element={<NftCartPage />} />
    <Route path="/nfts/:id" element={<CollectionPage />} />
    <Route path="/nfts/:id/:item" element={<ItemPage />} />
    <Route path="/activity" element={<WalletActivityPage />} />
    <Route path="/portfolio" element={<IndexedPortfolioPage />} />
    <Route path="/settings" element={<SettingsPage />} />
    <Route path="/settings/profile" element={<WalletProfileSettings />} />
    <Route path="/profile/:wallet" element={<ProfilePage />} />
    <Route path="/admin" element={<AdminPage />} />
    <Route path="/admin/airdrop" element={<AdminPage />} />
    <Route path="/admin/genesis" element={<AdminPage />} />
    <Route path="*" element={<NotFound />} />
  </Routes></Suspense></PageBoundary>;
  return location.pathname === '/airdrop' || location.pathname === '/whitelist'
    ? <GenesisAuthProvider>{content}</GenesisAuthProvider>
    : <Providers><Shell>{content}</Shell></Providers>;
}

// A data router lets creator forms protect unsaved artwork and account edits
// before SPA navigation. Keep the existing route tree and provider boundaries.
const router = createBrowserRouter([{
  path: '*', element: <Workspace />,
  errorElement: <WorkspaceError error={null} retry={() => window.location.reload()} />,
}]);
createRoot(document.getElementById('root')!).render(<ThemeProvider><RouterProvider router={router} /></ThemeProvider>);
