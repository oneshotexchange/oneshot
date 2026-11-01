import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, LockKeyhole, LogOut, RefreshCw } from 'lucide-react';
import { useWallet } from '../lib/client-wallet';
import { apiUrl } from '../lib/api-url';
import { customerErrorDetails, customerFetch, customerResponseJson } from '../lib/customer-http';
import { featureEnabled, useApi, type SystemStatus } from '../lib/client-api';
import { Badge, Button, ErrorState, Field, InfoRow, PageHeading } from './ui';
import { ThemePicker } from './theme-picker';
import { WalletButton } from './wallet-button';

type AdminStatus = SystemStatus & {
  nativeSymbol?: string;
  auth?: { configured: boolean; reason?: string | null };
  accountDrafts?: { configured: boolean };
  metadata?: { publicOriginConfigured: boolean };
  storage?: { configured: boolean; mode?: string };
  networkConfig?: { name: string; mode: string; chainId: number | null; nativeDecimals: number | null; configurationReady: boolean; configurationValid?: boolean; missing: string[] };
};
type AdminReadiness = { ready: boolean; checks: { originsConfigured: boolean; databaseAvailable: boolean; objectStorageConfigured: boolean }; storageAvailabilityVerified: boolean; chainConnectionVerified: boolean };

export function SettingsPage() {
  const wallet = useWallet();
  const availability = useApi<SystemStatus>('/api/status');
  const status = availability.data;
  const featureStatus = (key: string) => availability.loading ? 'Checking…' : availability.error ? 'Status unavailable' : featureEnabled(status, key) ? 'Available' : 'Currently unavailable';
  return <>
    <PageHeading title="Settings" />
    <div className="settings-layout">
      <div>
        <section className="panel settings-panel"><h2>Account</h2><p>{wallet.authenticated ? wallet.connected ? 'Switch wallets, copy your address or sign out.' : 'You’re signed in. Add a wallet to collect NFTs and manage your assets.' : !wallet.configured || wallet.unavailableReason ? 'Sign-in isn’t available right now. You can still save drafts on this device.' : 'Sign in to save collections to your account and manage your assets.'}</p><WalletButton /></section>
        <section className="panel settings-panel"><h2>Appearance</h2><ThemePicker /></section>
      </div>
      <section className="panel settings-panel"><h2>Network</h2>
        <InfoRow label="Network">Zero</InfoRow>
        <InfoRow label="Token trading">{featureStatus('trading')}</InfoRow>
        <InfoRow label="NFT minting">{featureStatus('nftLaunch')}</InfoRow>
        {availability.error && <ErrorState message="Network availability could not be checked." retry={availability.refresh} />}
        <a href="https://layerzero.network/zero" target="_blank" rel="noreferrer" className="external-row">About Zero <ArrowUpRight size={14} /></a>
      </section>
    </div>
  </>;
}

class AdminRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
async function adminRequest<T>(path: string, token?: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (token) headers.set('Authorization', 'Bearer ' + token);
  if (options?.body) headers.set('Content-Type', 'application/json');
  const response = await customerFetch(apiUrl('/api/admin/' + path), { ...options, headers, credentials: 'omit', cache: 'no-store', redirect: 'error' });
  const body = await customerResponseJson(response);
  if (!response.ok) throw new AdminRequestError(customerErrorDetails(body).message || 'Could not load administration. Try again.', response.status);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Administration could not be loaded. Try again.');
  return body as T;
}

export function AdminPage() {
  // Credentials and session tokens never enter persistent browser storage.
  const [password, setPassword] = useState('');
  const [session, setSession] = useState<{ token: string; expiresAt: number } | null>(null);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [readiness, setReadiness] = useState<AdminReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(() => { setSession(null); setStatus(null); setReadiness(null); setError('Your admin session expired. Sign in again.'); }, Math.max(0, session.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [session]);
  async function load(token: string) {
    try {
      const [nextStatus, nextReadiness] = await Promise.all([adminRequest<AdminStatus>('status', token), adminRequest<AdminReadiness>('readiness', token)]);
      setStatus(nextStatus); setReadiness(nextReadiness);
    }
    catch (reason) { if (reason instanceof AdminRequestError && (reason.status === 401 || reason.status === 503)) { setSession(null); setStatus(null); setReadiness(null); } throw reason; }
  }
  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const next = await adminRequest<{ token: string; expiresAt: number }>('session', undefined, { method: 'POST', body: JSON.stringify({ password }) });
      if (!next || typeof next.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(next.token) || !Number.isFinite(next.expiresAt) || next.expiresAt <= Date.now()) throw new Error('Admin sign-in could not be completed. Try again.');
      setPassword(''); setSession(next); await load(next.token);
    } catch (reason) { setPassword(''); setError(reason instanceof Error ? reason.message : 'Could not sign in. Try again.'); }
    finally { setBusy(false); }
  }
  async function refresh() {
    if (!session) return; setBusy(true); setError(null);
    try { await load(session.token); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not refresh status.'); } finally { setBusy(false); }
  }
  async function logout() {
    if (!session) return; setBusy(true); setError(null);
    try { await adminRequest('session', session.token, { method: 'DELETE' }); setSession(null); setStatus(null); setReadiness(null); }
    catch (reason) { if (reason instanceof AdminRequestError && (reason.status === 401 || reason.status === 503)) { setSession(null); setStatus(null); setReadiness(null); } else setError('Could not end the server session. Try signing out again.'); }
    finally { setBusy(false); }
  }
  return <>
    <PageHeading title="Administration" description="Restricted access for platform administrators." action={session && <><Button variant="secondary" onClick={refresh} loading={busy}><RefreshCw size={14} />Refresh</Button><Button variant="ghost" onClick={logout} disabled={busy}><LogOut size={14} />Sign out</Button></>} />
    {error && <ErrorState message={error} />}
    {!session ? <form className="panel settings-panel admin-login" onSubmit={login}>
      <LockKeyhole size={24} /><h2>Admin sign in</h2><p>Enter your administrator password to view platform configuration.</p>
      <Field label="Admin password" required><input type="password" name="admin-password" autoComplete="current-password" required maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} /></Field>
      <Button type="submit" loading={busy}>Sign in</Button>
    </form> : status ? <AdminDiagnostics status={status} readiness={readiness} /> : <p>Loading platform configuration…</p>}
  </>;
}

function AdminDiagnostics({ status, readiness }: { status: AdminStatus; readiness: AdminReadiness | null }) {
  const profile = status.networkConfig;
  return <div className="settings-layout"><div>
    <section className="panel settings-panel"><h2>Account and content services</h2><p>These checks report configuration only. They do not verify provider availability.</p>
      <ConfigRow label="Wallet authentication" enabled={status.auth?.configured} /><ConfigRow label="Account drafts" enabled={status.accountDrafts?.configured} /><ConfigRow label="Art storage" enabled={status.storage?.configured} /><InfoRow label="Storage mode">{status.storage?.mode || 'Not configured'}</InfoRow><ConfigRow label="Public metadata origin" enabled={status.metadata?.publicOriginConfigured} />{status.auth?.reason && <p>{status.auth.reason}</p>}
    </section>
    {readiness && <section className="panel settings-panel"><h2>Service readiness</h2><InfoRow label="Overall readiness"><Badge tone={readiness.ready ? 'mint' : 'amber'}>{readiness.ready ? 'Ready' : 'Needs attention'}</Badge></InfoRow><ConfigRow label="Application origins" enabled={readiness.checks.originsConfigured} /><InfoRow label="Database connection"><Badge tone={readiness.checks.databaseAvailable ? 'mint' : 'amber'}>{readiness.checks.databaseAvailable ? 'Available' : 'Unavailable'}</Badge></InfoRow><ConfigRow label="Object storage" enabled={readiness.checks.objectStorageConfigured} /><p>Storage availability and chain connectivity are separate checks and are not established by this readiness result.</p></section>}
    <section className="panel settings-panel"><h2>Zero execution</h2>
      {Object.entries(status.features || {}).map(([name, feature]) => <div className="admin-feature" key={name}><InfoRow label={name}><Badge tone={feature === true || typeof feature === 'object' && feature.enabled ? 'mint' : 'amber'}>{feature === true || typeof feature === 'object' && feature.enabled ? 'Enabled' : 'Disabled'}</Badge></InfoRow>{typeof feature === 'object' && feature.reason && <p>{feature.reason}</p>}</div>)}
      <p>These checks cover Zero. Optional local test-network workflows have separate verification.</p>
    </section>
    <section className="panel settings-panel"><h2>Planned launch policy</h2><p>These are product policy targets, not a report of deployed contract settings.</p><InfoRow label="Initial token supply">1 billion, 8 decimals</InfoRow><InfoRow label="Opening valuation">Set per launch</InfoRow><InfoRow label="Upper price target">1,000× opening</InfoRow><InfoRow label="Liquidity target">100% of supply, token-only</InfoRow><InfoRow label="Principal custody target">Permanent lock</InfoRow><InfoRow label="DEX fee target">0.25%, subject to verification</InfoRow><InfoRow label="Execution fee">Creator selects 1–5%</InfoRow><InfoRow label="Collected fee split">20% protocol / 80% destination</InfoRow><InfoRow label="NFT platform fee">2% of paid mints and resales</InfoRow><InfoRow label="Creator resale royalty">0–10%</InfoRow></section>
  </div><div>
    <section className="panel settings-panel"><h2>Network configuration</h2><InfoRow label="Active profile">{profile?.name || status.network || 'Unknown'}</InfoRow><InfoRow label="Mode">{profile?.mode || 'Unknown'}</InfoRow><InfoRow label="Chain ID">{profile?.chainId ?? 'Unverified'}</InfoRow><InfoRow label="Native asset">{status.nativeSymbol || 'Unverified'}</InfoRow><InfoRow label="Native decimals">{profile?.nativeDecimals ?? 'Unverified'}</InfoRow><ConfigRow label="Network profile configuration" enabled={profile?.configurationReady} />{profile?.configurationValid === false && <p>Network configuration is invalid. Other service checks remain available.</p>}
      {Boolean(profile?.missing?.length) && <><h3>Missing configuration</h3><ul className="admin-missing">{profile!.missing.map(item => <li key={item}>{item}</li>)}</ul></>}
      <a href="https://docs.layerzero.network/chain" target="_blank" rel="noreferrer" className="external-row">Zero documentation <ArrowUpRight size={14} /></a>
    </section>
    <section className="panel settings-panel"><h2>Zero contract deployment</h2><InfoRow label="NFT contracts">{status.contracts?.nftPackage || 'Not deployed'}</InfoRow><InfoRow label="Token contracts">{status.contracts?.tokenPackage || 'Not deployed'}</InfoRow><InfoRow label="Treasury">{status.contracts?.treasury || 'Not configured'}</InfoRow></section>
    <section className="panel settings-panel"><h2>Admin session</h2><p>This session expires after 30 minutes. Refreshing or leaving this page requires a new sign in.</p></section>
  </div></div>;
}
function ConfigRow({ label, enabled }: { label: string; enabled?: boolean }) { return <InfoRow label={label}><Badge tone={enabled ? 'mint' : 'amber'}>{enabled ? 'Configured' : 'Not configured'}</Badge></InfoRow>; }

