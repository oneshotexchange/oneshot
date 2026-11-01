import { Component, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Providers } from '../components/providers';
import { ThemeProvider } from '../components/theme-provider';
import { Shell } from '../components/shell';
import { Overview } from '../components/overview';
import { TokenDiscovery } from '../components/discovery';
import { TokenLaunch } from '../components/token-launch';
import { TokenTerminal } from '../components/token-terminal';
import { NftCreate } from '../components/nft-create';
import { IndexedNftDiscovery, IndexedNftCollection, IndexedNftItemDetail, IndexedActivityPage, IndexedPortfolioPage } from '../components/indexed-nfts';
import { AdminPage, SettingsPage } from '../components/workspace-pages';
import WorkspaceError from '../app/error';
import NotFound from '../app/not-found';
import '../app/globals.css';
import '../app/themes.css';
import '../app/theme-picker.css';

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

function Workspace() {
  const location = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname, location.search]);
  return <Providers><Shell><PageBoundary key={location.pathname + location.search}><Routes>
    <Route path="/" element={<Overview />} />
    <Route path="/tokens" element={<TokenDiscovery />} />
    <Route path="/tokens/new" element={<TokenLaunch />} />
    <Route path="/tokens/:id" element={<TokenPage />} />
    <Route path="/nfts" element={<IndexedNftDiscovery />} />
    <Route path="/nfts/new" element={<NftCreate />} />
    <Route path="/nfts/:id" element={<CollectionPage />} />
    <Route path="/nfts/:id/:item" element={<ItemPage />} />
    <Route path="/activity" element={<IndexedActivityPage />} />
    <Route path="/portfolio" element={<IndexedPortfolioPage />} />
    <Route path="/settings" element={<SettingsPage />} />
    <Route path="/admin" element={<AdminPage />} />
    <Route path="*" element={<NotFound />} />
  </Routes></PageBoundary></Shell></Providers>;
}

createRoot(document.getElementById('root')!).render(<ThemeProvider><BrowserRouter><Workspace /></BrowserRouter></ThemeProvider>);
