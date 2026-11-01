"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatIndexedAmount } from '@oneshot/evm';
import type { OneshotDraft } from '../lib/oneshot-draft-schema';
import { useWallet } from '../lib/client-wallet';
import { createNftLaunchApi, createNftLaunchController, type NftLaunchAction, type NftLaunchContext, type NftLaunchRequest, type NftLaunchStatus } from '../lib/client-nft-launch';
import { Badge, Button, ErrorState, InfoRow, SafetyNote } from './ui';
import { NftFloorSettings } from './nft-floor-settings';
import { useNftIndexedSync } from '../lib/client-indexed-sync';
import { NftIndexedSyncNotice } from './nft-indexed-sync';
import type { NftCreatorProgress } from '@oneshot/evm';
import { assertCreatorRecovery, creatorCanStart, creatorWorkspaceKey, useNftCreatorWorkspace, type CreatorWorkspaceScope } from '../lib/client-nft-creator-progress';
import { NftCreatorProgressPanel } from './nft-creator-progress';
import { NftReviewSummary, NftTransactionData, nftTransactionPhase } from './nft-review-summary';

const actions: { value: NftLaunchAction; label: string }[] = [
  { value: 'create', label: 'Create collection' }, { value: 'configure', label: 'Set mint phases' }, { value: 'open', label: 'Open mint' },
];
const busyPhases = ['reviewing', 'validating', 'signing', 'confirming'];

/** Execution is limited to an explicit local ETH deployment and a prepared account snapshot. */
export function NftLaunchReview({ draft, onRefresh, initialLaunchId }: { draft: OneshotDraft; onRefresh?: () => void | Promise<void>; initialLaunchId?: string }) {
  const wallet = useWallet(); const currentWallet = useRef(wallet); currentWallet.current = wallet;
  const [status, setStatus] = useState<NftLaunchStatus | null>(null); const [statusError, setStatusError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false); const [storedAction, setAction] = useState<NftLaunchAction | null>(null); const [actionKey, setActionKey] = useState<string | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null); const [recovering, setRecovering] = useState(false);
  const [collection, setCollection] = useState(''); const [clock, setClock] = useState(Date.now());
  const api = useMemo(() => createNftLaunchApi({ identityScope: () => currentWallet.current.identityScope(), getAccessToken: () => currentWallet.current.getAccessToken() }), []);
  const scope = wallet.identityScope();
  const localEnabled = Boolean(status?.enabled && status.network?.chainId === 31337 && status.network.nativeSymbol === 'ETH' && status.network.nativeDecimals === 18 && status.deploymentId);
  const context = useRef<NftLaunchContext>({ identityScope: scope, address: wallet.account?.address || null, chainId: wallet.network?.chainId || null, draftId: draft.id, revision: draft.revision, prepared: false, userId: wallet.userId, scope: 'draft' });
  context.current = { identityScope: scope, address: wallet.account?.address || null, chainId: wallet.network?.chainId || null, draftId: draft.id, revision: draft.revision, prepared: localEnabled && draft.status === 'prepared' && Boolean(draft.snapshot), deploymentId: status?.deploymentId, userId: wallet.userId, scope: 'draft' };
  const controller = useMemo(() => createNftLaunchController({ api, context: () => context.current, sendEvmTransaction: tx => currentWallet.current.sendEvmTransaction(tx) }), [api]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const busy = busyPhases.includes(state.phase); const submitted = Boolean(state.hash && !['confirmed','reverted'].includes(state.receipt?.status || ''));
  const creatorMatches = Boolean(wallet.userId && draft.ownerUserId === wallet.userId && draft.creatorWallet?.toLowerCase() === wallet.account?.address.toLowerCase());
  const ready = localEnabled && wallet.configured && wallet.authenticated && wallet.connected && creatorMatches && wallet.network?.chainId === 31337 && draft.status === 'prepared' && Boolean(draft.snapshot);
  const progressScope: CreatorWorkspaceScope | null = ready && scope && wallet.userId && wallet.account && status?.deploymentId
    ? { identityScope: scope, userId: wallet.userId, draftId: draft.id, revision: draft.revision, from: wallet.account.address, deploymentId: status.deploymentId } : null;
  const workspace = useNftCreatorWorkspace(api, progressScope, initialLaunchId);
  const progressKey = creatorWorkspaceKey(progressScope), activeProgressKey = useRef(progressKey); activeProgressKey.current = progressKey;
  useEffect(() => { activeProgressKey.current = progressKey; return () => { activeProgressKey.current = null; }; }, [progressKey]);
  const action = actionKey === progressKey ? storedAction : null;
  const selected = workspace.data?.selected || null;
  const canCreate = creatorCanStart(workspace.data, workspace.loading, workspace.error);
  const guidedActionAllowed = Boolean(!workspace.loading && !workspace.error && (action === 'create' ? canCreate
    : selected?.nextAction === action && selected.collection.toLowerCase() === collection.toLowerCase()));
  const actionAllowed = Boolean(action && guidedActionAllowed);
  const expiresIn = state.review ? Math.max(0, Math.ceil((Date.parse(state.review.expiresAt) - clock) / 1000)) : 0;
  async function refreshStatus() {
    setStatusError(null);
    try { setStatus(await api.status()); } catch (error) { setStatus(null); setStatusError(error instanceof Error ? error.message : 'Could not check launch availability. Try again.'); }
  }
  useEffect(() => { void refreshStatus(); }, [api]);
  useEffect(() => { controller.syncContext(); setAcknowledged(false); setAction(null); setCollection(''); setProgressError(null); setRecovering(false); }, [controller, scope, draft.id, draft.revision, draft.status, status?.deploymentId, localEnabled]);
  useEffect(() => { if (state.phase !== 'review') return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [state.phase, state.review?.id]);
  useEffect(() => {
    if (selected && ['created', 'configured', 'opened', 'schedule-expired'].includes(selected.phase)) setCollection(selected.collection);
  }, [selected?.id, selected?.collection, selected?.phase]);
  const refreshedReceipt = useRef<string | null>(null);
  useEffect(() => {
    if (state.phase !== 'success' || !state.review || !state.hash || !progressKey) return;
    const key = JSON.stringify([progressKey, state.review.id, state.hash, state.receipt?.blockNumber]);
    if (refreshedReceipt.current === key) return;
    refreshedReceipt.current = key; void workspace.refresh();
  }, [state.phase, state.review?.id, state.hash, state.receipt?.blockNumber, progressKey, workspace.refresh]);
  const indexedSync = useNftIndexedSync({ scope: scope ? JSON.stringify([scope,wallet.userId,wallet.account?.address,wallet.network?.chainId,draft.id,draft.revision,collection,status?.deploymentId,action]) : null,
    review: state.review, receipt: state.receipt, hash: state.hash,
    enabled: state.phase === 'success' && (!state.receipt?.collection || state.receipt.collection === collection),
    readReceipt: api.receipt, onRefresh: () => onRefresh?.() });
  const refreshedReorg = useRef<string | null>(null);
  useEffect(() => {
    if (indexedSync.phase !== 'reorg') { refreshedReorg.current = null; return; }
    if (!state.hash || !progressKey) return;
    const key = JSON.stringify([progressKey, state.hash]);
    if (refreshedReorg.current === key) return;
    refreshedReorg.current = key; void workspace.refresh();
  }, [indexedSync.phase, state.hash, progressKey, workspace.refresh]);
  useEffect(() => () => controller.invalidate('The launch review was closed.'), [controller]);
  function start() {
    if (!canCreate || busy || submitted) return;
    controller.invalidate('Create collection selected. Prepare and approve a fresh review to continue.'); setActionKey(progressKey); setAction('create'); setCollection(''); setAcknowledged(false); setProgressError(null);
  }
  function continueSetup(progress: NftCreatorProgress) {
    if (!progress.nextAction || busy || submitted || workspace.loading || workspace.error || selected?.id !== progress.id) return;
    controller.invalidate('The next setup step is selected. Prepare and approve a fresh review.'); setActionKey(progressKey); setCollection(progress.collection); setAction(progress.nextAction); setAcknowledged(false); setProgressError(null);
  }
  function chooseLaunch(id: string) {
    if (busy || submitted) return;
    controller.invalidate('A different saved collection is being checked.'); setAction(null); setCollection(''); setAcknowledged(false); setProgressError(null); void workspace.select(id);
  }
  async function recoverCreation(reviewId: string, hash: string) {
    if (!progressScope || busy || submitted || recovering) return;
    const captured = progressKey;
    setRecovering(true); setProgressError(null);
    try {
      const record = await api.reviewRecord(reviewId);
      if (activeProgressKey.current !== captured) return;
      assertCreatorRecovery(record, progressScope, reviewId, hash);
      await controller.recover(record, hash);
      if (activeProgressKey.current === captured) void workspace.refresh();
    } catch (error) { if (activeProgressKey.current === captured) setProgressError(error instanceof Error ? error.message : 'The saved creation could not be checked.'); }
    finally { if (activeProgressKey.current === captured) setRecovering(false); }
  }
  function prepare() {
    if (!acknowledged || !ready || !wallet.account || !action || !actionAllowed || recovering) return;
    const input: NftLaunchRequest = { draftId: draft.id, expectedRevision: draft.revision, from: wallet.account.address, action, localEthAcknowledged: true };
    if (action !== 'create') input.collection = collection;
    setClock(Date.now()); void controller.prepare(input);
  }
  let gate: string | null = null;
  if (!wallet.configured) gate = 'Wallet connection is unavailable. Try again later.';
  else if (!localEnabled) gate = 'Test network launches are unavailable. Check again later.';
  else if (draft.status !== 'prepared' || !draft.snapshot) gate = 'Prepare the saved metadata before reviewing your collection launch.';
  else if (!wallet.authenticated || !wallet.connected) gate = 'Connect your creator wallet to review the collection launch.';
  else if (!creatorMatches) gate = 'Select the creator wallet used to save this draft to continue.';
  else if (wallet.network?.chainId !== 31337) gate = 'Switch to the test network (31337) in your wallet to continue.';
  return <section className="panel nft-launch-panel" aria-label="Collection launch">
    <div className="section-header"><div><h2>Launch your collection</h2><p>Review each step and approve it in your creator wallet.</p></div><Badge tone={localEnabled ? 'amber' : 'neutral'}>{localEnabled ? 'Test network' : 'Launch unavailable'}</Badge></div>
    {localEnabled && <SafetyNote amber>This launch uses test ETH on a local test network. Zero launches are unavailable.</SafetyNote>}
    {gate && <div className="data-notice" role="status">{gate}</div>}
    {(!localEnabled || statusError) && <Button type="button" variant="ghost" onClick={() => void refreshStatus()}>Check availability</Button>}
    {ready && <>
      <NftCreatorProgressPanel state={workspace} disabled={busy || submitted || recovering} onRefresh={() => { setAction(null); setAcknowledged(false); controller.invalidate('Progress is being checked. Prepare a fresh review after choosing a step.'); void workspace.list(); }} onSelect={chooseLaunch} onMore={() => { void workspace.loadMore(); }} onStart={start} onContinue={continueSetup} onRecover={(id, hash) => { void recoverCreation(id, hash); }} />
      {progressError && <ErrorState message={progressError} />}
      {recovering && <p className="data-notice" role="status">Checking the saved creation receipt. No wallet approval is requested.</p>}
      {action && <div className="review-rows section-gap"><InfoRow label="Next step">{actions.find(item => item.value === action)?.label}</InfoRow>{collection && <InfoRow label="Collection"><span className="indexed-hash">{collection}</span></InfoRow>}</div>}
      {action && <><label className="checkbox-field"><input type="checkbox" checked={acknowledged} disabled={busy || submitted || recovering || !actionAllowed} onChange={event => { if (!event.target.checked) controller.invalidate('Local ETH acknowledgement was removed.'); setAcknowledged(event.target.checked); }} /><span>I understand this uses test ETH on chain 31337 and requires gas.</span></label>
      <div className="button-row section-gap"><Button type="button" variant="secondary" disabled={!acknowledged || busy || submitted || recovering || !actionAllowed} loading={state.phase === 'reviewing'} onClick={prepare}>Review transaction</Button></div></>}
    </>}
    {state.review && <div className="nft-launch-review section-gap">
      <div className="section-header"><div><h3>Transaction review</h3><p>{actions.find(item => item.value === state.review?.action)?.label}, draft version {state.review.revision}</p></div><Badge tone={state.phase === 'success' && indexedSync.phase !== 'reorg' ? 'mint' : 'amber'}>{indexedSync.phase === 'reorg' ? 'Confirmation changed' : nftTransactionPhase(state.phase)}</Badge></div>
      <div className="review-rows">
        <InfoRow label="Network">Test network (31337), ETH</InfoRow>
        <InfoRow label="From"><span className="indexed-hash">{state.review.from}</span></InfoRow>
        <InfoRow label="To"><span className="indexed-hash">{state.review.to}</span></InfoRow>
        <InfoRow label="Transaction value" accent><span>{formatIndexedAmount(state.review.value, 18)} ETH <small className="indexed-subline">{state.review.value} wei</small></span></InfoRow>
        <InfoRow label="Estimated gas">{state.review.simulation.gasEstimate} gas units, paid separately in test ETH</InfoRow>
        <NftReviewSummary summary={state.review.summary} action={state.review.action} />
        <InfoRow label="Review expiry">{new Date(state.review.expiresAt).toLocaleString()}{state.phase === 'review' ? `, ${expiresIn}s remaining` : ''}</InfoRow>
      </div>
      <NftTransactionData data={state.review.data} />
      {state.phase === 'review' && <div className="button-row"><Button type="button" disabled={!ready || !acknowledged || expiresIn === 0} onClick={() => void controller.approve()}>Approve in wallet</Button><Button type="button" variant="ghost" onClick={() => controller.invalidate('Review discarded. Prepare a new review to continue.')}>Discard review</Button></div>}
      {state.phase === 'validating' && <div className="data-notice" role="status">Checking the transaction before wallet approval…</div>}
      {state.phase === 'signing' && <div className="data-notice" role="status">Check the test network, recipient and value in your wallet, then approve when ready.</div>}
      {state.phase === 'review' && expiresIn === 0 && <div className="data-notice">This review expired. Prepare a new review before approving.</div>}
    </div>}
    {state.message && indexedSync.phase !== 'reorg' && <div className="section-gap" aria-live="polite">{['error', 'rejected', 'reverted'].includes(state.phase) ? <ErrorState message={state.message} /> : <div className="data-notice">{state.message}</div>}</div>}
    {state.hash && <div className="nft-launch-receipt"><InfoRow label="Transaction hash"><span className="indexed-hash">{state.hash}</span></InfoRow>{state.receipt?.collection && <InfoRow label="Collection"><span className="indexed-hash">{String(state.receipt.collection)}</span></InfoRow>}<Button type="button" variant="secondary" loading={state.phase === 'confirming'} disabled={busy && state.phase !== 'confirming'} onClick={() => void controller.refreshReceipt()}>Check receipt</Button></div>}
    <NftIndexedSyncNotice state={indexedSync} onRetry={indexedSync.retry} />
    <NftFloorSettings collection={collection} />
  </section>;
}
