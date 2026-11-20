import { Component, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Route, RouterProvider, Routes, useLocation, useParams } from 'react-router-dom';
import { Providers } from '../components/providers';
import { ThemeProvider } from '../components/theme-provider';
import { Shell } from '../components/shell';
import { Overview } from '../components/overview';
import { TokenDiscovery } from '../components/discovery';
import { TokenLaunch } from '../components/token-launch';
import { TokenTerminal } from '../components/token-terminal';
import { NftCreate } from '../components/nft-create';
import { NftCartPage } from '../components/nft-cart';
import { IndexedNftDiscovery, IndexedNftCollection, IndexedNftItemDetail, IndexedPortfolioPage } from '../components/indexed-nfts';
import { AdminPage, SettingsPage } from '../components/workspace-pages';
import { GenesisWhitelist } from '../components/genesis-whitelist';
import { GenesisAuthProvider } from '../components/genesis-auth';
import WorkspaceError from '../app/error';
import NotFound from '../app/not-found';
import { workspaceNavigationKey } from '../lib/workspace-navigation';
import { PublicWalletProfile, WalletProfileSettings } from '../components/wallet-profile';
import { WalletActivityPage } from '../components/wallet-following';
import { ExternalNftImportsPage } from '../components/external-nft-imports';
import { ReviewedNftDiscovery, ReviewedNftCollection, ReviewedNftItemDetail } from '../components/reviewed-nfts';
import '../app/globals.css';
import '../app/themes.css';
import '../app/theme-picker.css';
import '../app/brand.css';
import '../app/studio-illustration.css';
import '../app/motion.css';
import '../app/launchpad.css';

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

function Workspace() {
  const location = useLocation();
  const navigationKey = workspaceNavigationKey(location.pathname, location.search);
  useEffect(() => { window.scrollTo(0, 0); }, [navigationKey]);
  const content = <PageBoundary key={navigationKey}><Routes>
    <Route path="/whitelist" element={<GenesisWhitelist />} />
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
    <Route path="/admin/genesis" element={<AdminPage />} />
    <Route path="*" element={<NotFound />} />
  </Routes></PageBoundary>;
  return location.pathname === '/whitelist' ? <GenesisAuthProvider>{content}</GenesisAuthProvider> : <Providers><Shell>{content}</Shell></Providers>;
}

// A data router lets creator forms protect unsaved artwork and account edits
// before SPA navigation. Keep the existing route tree and provider boundaries.
const router = createBrowserRouter([{ path: '*', element: <Workspace />,
  errorElement: <WorkspaceError error={null} retry={() => window.location.reload()} />,
}]);
createRoot(document.getElementById('root')!).render(<ThemeProvider><RouterProvider router={router} /></ThemeProvider>);
