import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useWallet } from '../lib/client-wallet';
import { appendExternalNftImportPage, createExternalNftImportsApi, ExternalNftImportError, externalNftImportStatusLabel, type ExternalNftImportConfig, type ExternalNftImportsApi } from '../lib/client-external-nft-imports';
import { externalNftImportInputSchema, type AccountExternalNftImport, type AccountExternalNftImportPage } from '../lib/external-nft-import';
import { Address, Badge, Button, EmptyState, ErrorState, Field, Loading, Modal, PageHeading, SafetyNote } from './ui';
import { WalletButton } from './wallet-button';
import '../app/external-nft-imports.css';

const unavailable = 'Collection import requests are currently unavailable. Reload to try again later.';
const date = (value: string) => new Date(value).toLocaleString();
const network = (chainId: number) => chainId === 84532 ? 'Base Sepolia testnet (84532)' : 'Local test network (31337)';

export function ExternalNftImportsPage() {
  const wallet = useWallet(), current = useRef(wallet); current.current = wallet;
  const api = useMemo(() => createExternalNftImportsApi({ identityScope: () => current.current.identityScope(), getAccessToken: () => current.current.getAccessToken() }), []);
  const [config, setConfig] = useState<{ data: ExternalNftImportConfig | null; loading: boolean; error: boolean }>({ data: null, loading: true, error: false }), [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true; const controller = new AbortController();
    setConfig(previous => ({ ...previous, loading: true, error: false }));
    void api.config(controller.signal).then(data => { if (active) setConfig({ data, loading: false, error: false }); }).catch(() => { if (active) setConfig({ data: null, loading: false, error: true }); });
    return () => { active = false; controller.abort(); };
  }, [api, version]);
  const scope = wallet.authenticated ? wallet.identityScope() : null;
  function reloadConfig() { setConfig(previous => ({ ...previous, loading: true, error: false })); setVersion(value => value + 1); }
  return <>
    <PageHeading title="Import a collection" description="Request review for an existing NFT collection, then return to check the decision." />
    <SafetyNote>Submitting a collection address does not establish creator or contract ownership. Review approval does not enable minting, listings or trading.</SafetyNote>
    {!wallet.authenticated ? <section className="panel external-import-intro"><h2>{config.data?.available && !config.error && !config.loading ? 'Sign in to request a review' : 'Sign in to view your review requests'}</h2><p>Your collection import requests and notes are private to your account and the review team. A linked wallet or signature is not required.</p>{config.loading ? <p role="status">Checking new request availability…</p> : (!config.data?.available || config.error) && <div className="external-import-unavailable"><p>{unavailable} You can still sign in to view or withdraw existing requests.</p><Button type="button" variant="secondary" onClick={reloadConfig}>Reload availability</Button></div>}<WalletButton /></section>
      : !scope ? <section className="panel external-import-intro"><ErrorState message="Your account is not ready. Sign in again to manage collection import requests." /><WalletButton /></section>
        : <AccountExternalNftImports key={scope} api={api} config={config.data} configLoading={config.loading} configFailed={config.error} reloadConfig={reloadConfig} />}
  </>;
}

function AccountExternalNftImports({ api, config, configLoading, configFailed, reloadConfig }: {
  api: ExternalNftImportsApi; config: ExternalNftImportConfig | null; configLoading: boolean; configFailed: boolean; reloadConfig(): void;
}) {
  const [history, setHistory] = useState<{ data: AccountExternalNftImportPage | null; loading: boolean; loadingMore: boolean; error: string | null }>({ data: null, loading: true, loadingMore: false, error: null });
  const [deploymentId, setDeploymentId] = useState(''), [collection, setCollection] = useState(''), [note, setNote] = useState(''), [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [requiresReload, setRequiresReload] = useState(false), [withdrawal, setWithdrawal] = useState<AccountExternalNftImport | null>(null);
  const active = useRef(true), readGeneration = useRef(0), mutationGeneration = useRef(0), readAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true; void load();
    return () => { active.current = false; readGeneration.current++; mutationGeneration.current++; readAbort.current?.abort(); };
  }, [api]);
  useEffect(() => { if (!deploymentId && config?.available && config.deployments.length === 1) setDeploymentId(config.deployments[0].deploymentId); }, [config, deploymentId]);
  async function load(more = false) {
    if (more && (!history.data?.nextCursor || history.loading || history.loadingMore)) return;
    const previous = history.data, ticket = ++readGeneration.current;
    readAbort.current?.abort(); const controller = new AbortController(); readAbort.current = controller;
    setHistory({ data: more ? previous : null, loading: !more, loadingMore: more, error: null });
    try {
      const page = await api.list({ limit: 20, ...(more && previous?.nextCursor ? { cursor: previous.nextCursor } : {}) }, controller.signal);
      if (!active.current || ticket !== readGeneration.current) return;
      const data = more && previous ? appendExternalNftImportPage(previous, page) : page;
      setHistory({ data, loading: false, loadingMore: false, error: null });
      if (!more) setRequiresReload(false);
    } catch (reason) {
      if (active.current && ticket === readGeneration.current) setHistory({ data: more ? previous : null, loading: false, loadingMore: false, error: reason instanceof Error ? reason.message : 'Your requests could not be loaded. Reload to try again.' });
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || requiresReload || configLoading || configFailed || !config?.available) return;
    if (!config.deployments.some(deployment => deployment.deploymentId === deploymentId)) { setError('Choose an available collection network and try again.'); return; }
    const parsed = externalNftImportInputSchema.safeParse({ deploymentId, collection: collection.trim(), note, reference });
    if (!parsed.success) { setError('Check the collection address and request notes. Use a nonzero Ethereum collection contract address.'); return; }
    const ticket = ++mutationGeneration.current; setBusy(true); setError(null); setNotice(null);
    readGeneration.current++; readAbort.current?.abort(); setHistory(previous => ({ ...previous, loading: false, loadingMore: false }));
    try {
      await api.submit(parsed.data);
      if (!active.current || ticket !== mutationGeneration.current) return;
      setCollection(''); setNote(''); setReference(''); setNotice('Your review request was submitted. Trading is not enabled by this request.');
      await load();
    } catch (reason) {
      if (active.current && ticket === mutationGeneration.current) {
        setError(reason instanceof Error ? reason.message : 'The request could not be submitted. Reload your requests to check its status.');
        setRequiresReload(!(reason instanceof ExternalNftImportError && reason.status === 400));
      }
    } finally { if (active.current && ticket === mutationGeneration.current) setBusy(false); }
  }
  async function withdraw() {
    const selected = withdrawal;
    if (!selected || busy || requiresReload) return;
    const latest = history.data?.items.find(item => item.id === selected.id);
    if (!latest || latest.revision !== selected.revision || latest.status !== selected.status) { setWithdrawal(null); setRequiresReload(true); setError('This request changed. Reload your requests before withdrawing it.'); return; }
    const ticket = ++mutationGeneration.current; setBusy(true); setWithdrawal(null); setError(null); setNotice(null);
    readGeneration.current++; readAbort.current?.abort(); setHistory(previous => ({ ...previous, loading: false, loadingMore: false }));
    try {
      await api.withdraw(selected);
      if (!active.current || ticket !== mutationGeneration.current) return;
      setNotice('The review request was withdrawn. Any permit already issued or existing on-chain registration is unchanged.');
      await load();
    } catch (reason) {
      if (active.current && ticket === mutationGeneration.current) { setError(reason instanceof Error ? reason.message : 'The request could not be withdrawn. Reload your requests to check its status.'); setRequiresReload(true); }
    } finally { if (active.current && ticket === mutationGeneration.current) setBusy(false); }
  }
  const available = Boolean(config?.available && !configLoading && !configFailed), selected = config?.deployments.find(deployment => deployment.deploymentId === deploymentId);
  return <div className="external-import-layout">
    <section className="panel external-import-form-panel"><h2>Request a collection review</h2><p>Use the collection’s contract address on its original network. Do not include secrets or private credentials in your notes.</p>
      {configLoading ? <Loading rows={2} /> : !available ? <div className="external-import-unavailable"><p>{unavailable}</p><Button type="button" variant="secondary" onClick={reloadConfig}><RefreshCw size={13} />Reload availability</Button></div> : <form onSubmit={event => { void submit(event); }}><fieldset disabled={busy}>
        <Field label="Collection network" required><select value={deploymentId} required onChange={event => { setDeploymentId(event.target.value); setError(null); }}><option value="">Choose a network</option>{config!.deployments.map(deployment => <option key={deployment.deploymentId} value={deployment.deploymentId}>{network(deployment.chainId)}</option>)}</select></Field>
        <Field label="Collection contract address" required><input value={collection} placeholder="0x…" required maxLength={42} autoComplete="off" spellCheck={false} onChange={event => { setCollection(event.target.value); setError(null); }} /></Field>
        <Field label="Request notes" hint="Optional context for the review team, up to 1,000 characters."><textarea value={note} rows={5} maxLength={1000} onChange={event => { setNote(event.target.value); setError(null); }} /></Field>
        <Field label="Reference" hint="Optional collection website or other reference, up to 2,048 characters."><input value={reference} maxLength={2048} onChange={event => { setReference(event.target.value); setError(null); }} /></Field>
        {selected && <p className="field-hint">This request concerns {network(selected.chainId)}. It does not request a wallet transaction.</p>}
        <Button type="submit" loading={busy} disabled={!selected || requiresReload}>Submit for review</Button>
      </fieldset></form>}
      {error && <div className="external-import-feedback"><ErrorState message={error} retry={() => { if (!busy) void load(); }} /></div>}
      {requiresReload && <p className="data-notice" role="status">Reload your requests to check their latest status before submitting or withdrawing another request.</p>}
      {notice && <p className="data-notice" role="status">{notice}</p>}
    </section>
    <section className="panel external-import-history"><div className="external-import-history-heading"><div><h2>Your review requests</h2><p>Private to your account and the review team.</p></div><Button type="button" variant="ghost" disabled={busy || history.loadingMore} loading={history.loading} onClick={() => { void load(); }}><RefreshCw size={13} />Reload requests</Button></div>
      {history.loading || busy && !history.data ? <Loading rows={4} /> : history.error && !history.data ? <div className="external-import-feedback"><ErrorState message={history.error} retry={() => { if (!busy) void load(); }} /></div> : history.data ? <>
        {history.data.items.length ? <div className="external-import-requests">{history.data.items.map(item => <ExternalNftImportRequest key={item.id} item={item} config={config} disabled={busy || requiresReload || history.loadingMore} onWithdraw={() => setWithdrawal(item)} />)}</div> : <EmptyState compact title="No collection import requests" description="Submit a collection contract address to request a review. No wallet transaction is needed." />}
        {history.error && <div className="external-import-feedback"><ErrorState message={history.error} retry={() => { if (!busy) void load(true); }} /></div>}
        <div className="indexed-page-footer"><span>{history.data.items.length} requests loaded</span>{history.data.nextCursor && <Button type="button" variant="secondary" disabled={busy} loading={history.loadingMore} onClick={() => { void load(true); }}>Load more requests</Button>}</div>
      </> : <div className="external-import-feedback"><ErrorState message="Your requests could not be loaded." retry={() => { if (!busy) void load(); }} /></div>}
    </section>
    {withdrawal && <Modal title="Withdraw this review request?" onClose={() => setWithdrawal(null)}><p>This withdraws your review request. It does not revoke an admission permit already issued or remove an existing on-chain registration. No funds are sent.</p><p className="external-import-address section-gap"><Address value={withdrawal.collection} full /></p><div className="button-row section-gap"><Button type="button" variant="ghost" onClick={() => setWithdrawal(null)}>Keep request</Button><Button type="button" disabled={busy || requiresReload} onClick={() => { void withdraw(); }}>Withdraw request</Button></div></Modal>}
  </div>;
}

export function ExternalNftImportRequest({ item, config, disabled, onWithdraw }: { item: AccountExternalNftImport; config: ExternalNftImportConfig | null; disabled: boolean; onWithdraw(): void }) {
  const deployment = config?.deployments.find(value => value.deploymentId === item.deploymentId);
  return <article className="external-import-request"><div className="external-import-request-heading"><h3 className="external-import-address"><Address value={item.collection} full /></h3><Badge tone={item.status === 'review-approved' ? 'amber' : 'neutral'}>{externalNftImportStatusLabel(item.status)}</Badge></div>
    <p className="external-import-network">{deployment ? network(deployment.chainId) : 'Original network details unavailable'}</p>
    {item.status === 'review-approved' && <p className="external-import-trading">Trading not enabled</p>}
    <p className="external-import-dates">Submitted {date(item.createdAt)}<br />Updated {date(item.updatedAt)}</p>
    {item.customerNote !== null && item.customerNote.length > 0 && <div className="external-import-note"><strong>Review note</strong><p>{item.customerNote}</p></div>}
    {(item.note || item.reference) && <details className="external-import-submitted"><summary>Your submitted details</summary>{item.note && <p>{item.note}</p>}{item.reference && <p><strong>Reference</strong><br />{item.reference}</p>}</details>}
    {item.status !== 'withdrawn' && <Button type="button" variant="ghost" disabled={disabled} onClick={onWithdraw}>Withdraw request</Button>}
  </article>;
}
