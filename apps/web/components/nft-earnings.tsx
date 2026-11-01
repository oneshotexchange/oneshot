import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatIndexedAmount, type NftEarningsPage } from '@oneshot/evm';
import { useWallet } from '../lib/client-wallet';
import { createNftLaunchApi, createNftLaunchController, type NftLaunchApi, type NftLaunchContext } from '../lib/client-nft-launch';
import { createNftEarningsController, nftEarningsScopeKey, type NftEarningsState } from '../lib/client-nft-earnings';
import { useNftIndexedSync } from '../lib/client-indexed-sync';
import { Address, Badge, Button, EmptyState, ErrorState, Field, InfoRow, Loading, SafetyNote, Stat } from './ui';
import { WalletButton } from './wallet-button';
import { ReviewResult } from './nft-checkout';
import { NftIndexedSyncNotice } from './nft-indexed-sync';

const money = (raw: string) => formatIndexedAmount(raw, 18);
type ClaimSource = { contract: string; name: string; collection?: string };
const busyPhases = ['reviewing', 'validating', 'signing', 'confirming'];

/** Read-only presentation also used by the explicitly simulated visual fixture. */
export function NftEarningsBalances({ state, disabled, onRefresh, onMore, onSelect }: {
  state: NftEarningsState; disabled?: boolean; onRefresh(): void; onMore(): void; onSelect(source: ClaimSource): void;
}) {
  const data = state.data;
  const collectionTotal = data?.collections.reduce((total, item) => total + BigInt(item.amountRaw), 0n) ?? 0n;
  const positive = data?.collections.filter(item => BigInt(item.amountRaw) > 0n) || [];
  return <>
    <div className="section-header"><div><h2>Available NFT proceeds</h2><p>Check mint income, sales and royalties for this wallet.</p></div><Button variant="ghost" disabled={disabled || state.loadingMore} loading={state.loading} onClick={onRefresh}>Refresh balances</Button></div>
    {state.error && <ErrorState message={state.error} retry={onRefresh} />}
    {state.loading && <Loading rows={2} />}
    {data && <>
      <InfoRow label="Earnings wallet"><Address value={data.wallet} full /></InfoRow>
      <div className="metric-grid nft-earnings-metrics"><Stat label="Resale proceeds" value={money(data.marketplace.amountRaw)} suffix="ETH" note="Sales and royalties" /><Stat label="Collection proceeds" value={money(collectionTotal.toString())} suffix="ETH" note={`${data.scannedCount} of ${data.totalCollectionsRaw} collections checked`} /></div>
      <p className="field-hint nft-earnings-checkpoint">Test network (31337). {data.nextCursor ? 'More collections remain; the collection subtotal covers only those checked.' : 'All collections have been checked.'} Balances can change before your review.</p>
      <div className="nft-earnings-sources">
        <div className="nft-earnings-source"><div><h3>Marketplace proceeds</h3><p>Sales and creator royalties.</p><Address value={data.marketplace.contract} /></div><strong className="indexed-amount">{money(data.marketplace.amountRaw)} ETH</strong><Button variant="secondary" disabled={disabled || data.marketplace.amountRaw === '0'} onClick={() => onSelect({ contract: data.marketplace.contract, name: 'Marketplace proceeds' })}>Review claim</Button></div>
        {positive.map(item => <div className="nft-earnings-source" key={item.contract}><div><h3>{item.name || 'Collection proceeds'}</h3><p>Income from minting this collection.</p><Address value={item.contract} /></div><strong className="indexed-amount">{money(item.amountRaw)} ETH</strong><Button variant="secondary" disabled={disabled || !item.opened} onClick={() => onSelect({ contract: item.contract, collection: item.contract, name: item.name || 'Collection proceeds' })}>Review claim</Button></div>)}
      </div>
      {!positive.length && <p className="data-notice section-gap">No collection proceeds in the {data.scannedCount} checked collections.{data.nextCursor ? ' Check the remaining collections for more proceeds.' : ''}</p>}
      {data.nextCursor && <div className="button-row section-gap"><Button variant="secondary" loading={state.loadingMore} disabled={disabled || state.loading} onClick={onMore}>Check next collections</Button></div>}
    </>}
  </>;
}

function NftEarningsClaim({ source, deploymentId, api, current, onRefresh }: {
  source: ClaimSource; deploymentId: string; api: NftLaunchApi; current: NftEarningsPage | null; onRefresh(): void;
}) {
  const wallet = useWallet(), latestWallet = useRef(wallet); latestWallet.current = wallet;
  const [recipient, setRecipient] = useState(''), [ack, setAck] = useState(false), [clock, setClock] = useState(Date.now());
  const scope = wallet.identityScope();
  const context = useRef<NftLaunchContext>({ identityScope: null, address: null, chainId: null, draftId: source.contract, revision: 0, prepared: false });
  context.current = { identityScope: scope, address: wallet.account?.address || null, chainId: wallet.network?.chainId || null, draftId: source.contract.toLowerCase(), revision: 0,
    prepared: Boolean(scope && wallet.authenticated && wallet.connected && wallet.network?.chainId === 31337), scope: 'public', deploymentId, userId: wallet.userId };
  const controller = useMemo(() => createNftLaunchController({ api, context: () => context.current, sendEvmTransaction: tx => latestWallet.current.sendEvmTransaction(tx) }), [api]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const amount = current && current.deploymentId === deploymentId ? source.collection
    ? current.collections.find(item => item.contract.toLowerCase() === source.contract.toLowerCase())?.amountRaw
    : current.marketplace.contract.toLowerCase() === source.contract.toLowerCase() ? current.marketplace.amountRaw : undefined : undefined;
  const fresh = Boolean(amount && BigInt(amount) > 0n), busy = busyPhases.includes(state.phase);
  const submitted = Boolean(state.hash && !['confirmed', 'reverted'].includes(state.receipt?.status || ''));
  const refresh = useRef(onRefresh); refresh.current = onRefresh;
  const refreshed = useRef<string | null>(null);
  useEffect(() => { controller.syncContext(); setAck(false); }, [controller, scope, wallet.account?.address, wallet.network?.chainId, deploymentId]);
  useEffect(() => { if (!fresh && !state.hash && state.review) controller.invalidate('Refresh the available proceeds before preparing another claim.'); }, [controller, fresh, amount, state.hash, state.review]);
  useEffect(() => { if (state.phase !== 'review') return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [state.phase]);
  useEffect(() => {
    if (state.phase !== 'success' || state.receipt?.status !== 'confirmed' || !state.hash) return;
    const key = JSON.stringify([state.hash, state.receipt.blockHash]);
    if (refreshed.current !== key) { refreshed.current = key; refresh.current(); }
  }, [state.phase, state.receipt, state.hash]);
  const indexedSync = useNftIndexedSync({ scope: scope ? JSON.stringify([scope, wallet.userId, wallet.account?.address, wallet.network?.chainId, deploymentId, source.contract]) : null,
    review: state.review, receipt: state.receipt, hash: state.hash, enabled: state.phase === 'success', readReceipt: api.receipt, onRefresh: () => refresh.current() });
  useEffect(() => () => controller.invalidate('The claim was closed.'), [controller]);
  function change(callback: () => void) { controller.invalidate('The claim details changed. Prepare a new review.'); callback(); }
  return <div className="nft-earnings-claim section-gap">
    <div className="section-header"><h3>Claim {source.name}</h3><Badge>Separate wallet approval</Badge></div>
    <InfoRow label="Source"><Address value={source.contract} full /></InfoRow>
    <Field label="Payout recipient" hint="Leave blank to receive proceeds in your connected wallet."><input value={recipient} placeholder={wallet.account?.address} disabled={busy || submitted} onChange={event => change(() => setRecipient(event.target.value))} /></Field>
    <label className="checkbox-field"><input type="checkbox" checked={ack} disabled={busy || submitted} onChange={event => { if (!event.target.checked) controller.invalidate('Local ETH acknowledgement was removed.'); setAck(event.target.checked); }} /><span>I understand this claims test ETH on chain 31337 and requires gas.</span></label>
    <Button variant="secondary" disabled={!fresh || !ack || busy || submitted} onClick={() => {
      if (!wallet.account || !fresh || !ack) return;
      void controller.prepare({ action: 'claim', from: wallet.account.address, contract: source.contract, ...(source.collection ? { collection: source.collection } : {}), ...(recipient.trim() ? { recipient: recipient.trim() } : {}), localEthAcknowledged: true }); setClock(Date.now());
    }}>Review claim</Button>
    <ReviewResult state={state} confirmationChanged={indexedSync.phase === 'reorg'} canApprove={fresh && ack && Boolean(state.review && Date.parse(state.review.expiresAt) > clock)} onApprove={() => void controller.approve()} onCheck={() => void controller.refreshReceipt()} />
    <NftIndexedSyncNotice state={indexedSync} onRetry={indexedSync.retry} />
  </div>;
}

/** Private balances follow the actual signing wallet, independent of public wallet inspection. */
export function NftEarnings({ onRefresh }: { onRefresh?: () => void }) {
  const wallet = useWallet(), latest = useRef(wallet); latest.current = wallet;
  const api = useMemo(() => createNftLaunchApi({ identityScope: () => latest.current.identityScope(), getAccessToken: () => latest.current.getAccessToken() }), []);
  const loader = useMemo(() => createNftEarningsController((input, signal) => api.earnings(input, signal)), [api]);
  const state = useSyncExternalStore(loader.subscribe, loader.snapshot, loader.snapshot);
  const [availability, setAvailability] = useState<{ key: string; deploymentId: string | null; reason: string | null } | null>(null);
  const [selected, setSelected] = useState<ClaimSource | null>(null), [attempt, setAttempt] = useState(0);
  const identity = wallet.identityScope(), from = wallet.account?.address?.toLowerCase();
  const key = JSON.stringify([identity, wallet.userId, from, wallet.network?.chainId]);
  const latestKey = useRef(key); latestKey.current = key;
  const reads = useRef(0);
  const ready = Boolean(wallet.authenticated && wallet.connected && identity && from && wallet.network?.chainId === 31337);
  useEffect(() => {
    let active = true; reads.current++; const abort = new AbortController(); setSelected(null); setAvailability(null); void loader.open(null);
    if (ready) void api.status(abort.signal).then(status => {
      if (!active) return;
      const deploymentId = status.enabled ? status.deploymentId : null;
      setAvailability({ key, deploymentId, reason: status.reason });
      if (deploymentId) void loader.open({ identityScope: key, wallet: from!, deploymentId });
    }).catch(reason => { if (active) setAvailability({ key, deploymentId: null, reason: reason instanceof Error ? reason.message : 'The test network is unavailable. Try again later.' }); });
    return () => { active = false; reads.current++; abort.abort(); loader.cancel(); };
  }, [api, loader, key, ready, attempt]);
  const matching = availability?.key === key ? availability : null;
  const snapshot = state.data;
  const data = matching?.deploymentId && snapshot && snapshot.wallet.toLowerCase() === from && snapshot.deploymentId === matching.deploymentId ? snapshot : null;
  const expectedKey = matching?.deploymentId && identity && from ? nftEarningsScopeKey({ identityScope: key, wallet: from, deploymentId: matching.deploymentId }) : null;
  const display: NftEarningsState = state.key === expectedKey ? { ...state, data } : { key: expectedKey, data: null, loading: Boolean(expectedKey), loadingMore: false, error: null };
  const refresh = () => {
    const ticket = ++reads.current;
    void loader.open(null);
    void api.status().then(status => {
      if (latestKey.current !== key || reads.current !== ticket) return;
      const deploymentId = status.enabled ? status.deploymentId : null;
      if (deploymentId && deploymentId === matching?.deploymentId && from) void loader.open({ identityScope: key, wallet: from, deploymentId });
      else {
        setSelected(null); setAvailability({ key, deploymentId, reason: status.reason });
        void loader.open(deploymentId && from ? { identityScope: key, wallet: from, deploymentId } : null);
      }
    }).catch(reason => {
      if (latestKey.current !== key || reads.current !== ticket) return;
      void loader.open(null); setAvailability({ key, deploymentId: null, reason: reason instanceof Error ? reason.message : 'The test network is unavailable. Try again later.' });
    });
    onRefresh?.();
  };
  return <section className="panel nft-launch-panel" aria-label="Current NFT proceeds">
    {!ready ? <><h2>Available NFT proceeds</h2><EmptyState title={!wallet.authenticated ? 'Sign in to check proceeds' : !wallet.connected ? 'Connect a wallet to check proceeds' : 'Switch to the test network'} description={wallet.authenticated && wallet.connected ? 'Switch your wallet to the test network (31337) to check and claim proceeds.' : 'Connect your wallet to the test network (31337) to check and claim proceeds. You can view public wallet records below.'} compact action={<WalletButton />} /></> : !matching?.deploymentId ? <><h2>Available NFT proceeds</h2>{matching?.reason ? <ErrorState message={matching.reason} retry={() => setAttempt(value => value + 1)} /> : <Loading rows={2} />}</> : <>
      <NftEarningsBalances state={display} onRefresh={refresh} onMore={() => void loader.loadMore()} onSelect={setSelected} />
      {selected && <NftEarningsClaim key={`${key}:${matching.deploymentId}:${selected.contract}`} source={selected} deploymentId={matching.deploymentId} api={api} current={data} onRefresh={refresh} />}
    </>}
    <SafetyNote>These proceeds use test ETH. Review each claim before approving it in your wallet.</SafetyNote>
  </section>;
}
