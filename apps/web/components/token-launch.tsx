"use client";

import Link from "./navigation";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, CircleAlert, Coins, Flame, LockKeyhole, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AssetIcon, Badge, Button, ErrorState, Field, InfoRow, PageHeading, SafetyNote } from "./ui";
import { DraftBackup } from './draft-backup';
import { parseDraftBackup, serializeDraftBackup } from '../lib/draft-backup';
import { draftPriceUnit, draftPricingNetwork, draftPricingNetworkLabel } from '../lib/nft-network';
import { tokenCopyForBase, tokenCopyForZero } from '../lib/draft-pricing';
import { TokenLaunchReview } from './token-execution-panel';
import { TokenAccountDrafts } from './token-account-drafts';
import { useWallet } from '../lib/client-wallet';
import { draftStorageUnchanged } from '../lib/draft-storage-migration';
import {
  TOKEN_DRAFTS_STORAGE_KEY, LEGACY_TOKEN_DRAFTS_STORAGE_KEY, LEGACY_TOKEN_DRAFT_STORAGE_KEY, TokenDraftStorageError, createTokenDraftAutosave, emptyTokenDraftWorkspace, newTokenDraft,
  readTokenDrafts, removeTokenDraft, resumeTokenDraft, saveTokenDraft, tokenDraftHasContent,
  tokenDraftReviewSchema, tokenDraftSchema, tokenDraftsEqual, writeTokenDrafts,
  type TokenDraft, type TokenDraftWorkspace,
} from '../lib/token-drafts';

type DraftAction = { kind: 'new' | 'copy-base' | 'copy-zero-testnet' | 'copy-zero-mainnet' } | { kind: 'resume'; id: string } | { kind: 'reload' } | { kind: 'account-copy'; draft: TokenDraft; scope: string };
export function TokenLaunch() {
  const wallet = useWallet(), currentWallet = useRef(wallet); currentWallet.current = wallet;
  const accountScope = wallet.identityScope();
  const [workspace, setWorkspace] = useState<TokenDraftWorkspace>(emptyTokenDraftWorkspace);
  const [loaded, setLoaded] = useState(false), [writable, setWritable] = useState(false);
  const [review, setReview] = useState(false), [accepted, setAccepted] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null), [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState(''), [autosave, setAutosave] = useState<'loading' | 'saving' | 'saved' | 'memory'>('loading');
  const [pendingAction, setPendingAction] = useState<DraftAction | null>(null), [removeId, setRemoveId] = useState<string | null>(null);
  const snapshot = useRef<string | null>(null), canWrite = useRef(false);
  const latestWorkspace = useRef(workspace), autosaveController = useRef<ReturnType<typeof createTokenDraftAutosave> | null>(null);
  const draft = workspace.working.draft, selectedId = workspace.working.savedId;
  const selected = workspace.saved.find(record => record.id === selectedId);
  const label = (value: TokenDraft) => value.name.trim() || 'Untitled token';
  useEffect(() => {
    setPendingAction(previous => previous?.kind === 'account-copy' && previous.scope !== accountScope ? null : previous);
  }, [accountScope]);
  function storageFailure(error: unknown) {
    setStorageError(error instanceof TokenDraftStorageError ? error.message : 'Your token drafts could not be saved. Keep this page open or export a backup.');
    setAutosave('memory');
    if (error instanceof TokenDraftStorageError && ['unreadable', 'conflict'].includes(error.reason)) { canWrite.current = false; autosaveController.current?.cancel(); setWritable(false); }
  }
  function updateWorkspace(next: TokenDraftWorkspace) { latestWorkspace.current = next; setWorkspace(next); }
  function flushWorkingCopy(notify: boolean) {
    if (!canWrite.current) return;
    try {
      snapshot.current = writeTokenDrafts(window.localStorage, latestWorkspace.current, snapshot.current);
      if (notify) { setAutosave('saved'); setStorageError(null); }
    } catch (error) {
      if (notify) storageFailure(error);
      else if (error instanceof TokenDraftStorageError && ['unreadable', 'conflict'].includes(error.reason)) canWrite.current = false;
    }
  }
  function loadWorkspace() {
    autosaveController.current?.cancel();
    try {
      const loaded = readTokenDrafts(window.localStorage);
      snapshot.current = loaded.snapshot; canWrite.current = true; setWritable(true);
      updateWorkspace(loaded.workspace); setStorageError(null); setFormError(null); setAutosave('saving');
      setReview(false); setAccepted(false); setPendingAction(null); setRemoveId(null);
      setNotice(loaded.source === 'legacy' && loaded.workspace.saved.length ? 'Your previous token draft is available in saved drafts.' : '');
      // Recover the legacy plan immediately; a quick route change must not race
      // the first debounce or create a second recovery record on the next visit.
      if (loaded.source === 'legacy' || loaded.source === 'legacy-workspace') flushWorkingCopy(true);
    } catch (error) { canWrite.current = false; setWritable(false); storageFailure(error); }
    finally { setLoaded(true); }
  }
  useEffect(() => {
    const controller = createTokenDraftAutosave(flushWorkingCopy);
    autosaveController.current = controller; loadWorkspace();
    const flush = () => controller.flush();
    const visibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush); document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', visibility);
      controller.dispose(); if (autosaveController.current === controller) autosaveController.current = null;
    };
  }, []);
  useEffect(() => {
    if (!loaded || !canWrite.current) return;
    setAutosave('saving'); autosaveController.current?.schedule();
    return () => autosaveController.current?.cancel();
  }, [workspace, loaded]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== null && ![TOKEN_DRAFTS_STORAGE_KEY, LEGACY_TOKEN_DRAFTS_STORAGE_KEY, LEGACY_TOKEN_DRAFT_STORAGE_KEY].includes(event.key)) return;
      try {
        if (draftStorageUnchanged(window.localStorage, TOKEN_DRAFTS_STORAGE_KEY, [LEGACY_TOKEN_DRAFTS_STORAGE_KEY, LEGACY_TOKEN_DRAFT_STORAGE_KEY], snapshot.current)) return;
        autosaveController.current?.cancel();
        storageFailure(new TokenDraftStorageError('conflict', 'Your token drafts changed in another tab. Export your open draft, then reload saved drafts before saving here.'));
      } catch { storageFailure(new TokenDraftStorageError('unavailable', 'Browser storage could not be checked. Keep this page open or export your draft.')); }
    };
    window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed);
  }, []);
  const patch = (values: Partial<TokenDraft>) => {
    const previous = latestWorkspace.current;
    updateWorkspace({ ...previous, working: { ...previous.working, draft: { ...previous.working.draft, ...values } } });
    setAccepted(false); setFormError(null); setNotice(''); setRemoveId(null);
  };
  function persist(next: TokenDraftWorkspace) {
    autosaveController.current?.cancel();
    if (!canWrite.current) { setStorageError('Saved drafts are protected until browser storage can be read. Export your open draft before reloading saved drafts.'); return false; }
    try { snapshot.current = writeTokenDrafts(window.localStorage, next, snapshot.current); updateWorkspace(next); setStorageError(null); setFormError(null); setAutosave('saved'); return true; }
    catch (error) { storageFailure(error); return false; }
  }
  function saveCurrent(): TokenDraftWorkspace | null {
    try {
      const current = latestWorkspace.current;
      const next = saveTokenDraft(current, current.working.draft, { id: current.working.savedId });
      if (!persist(next)) return null;
      setNotice(`Saved “${label(draft)}” on this device.`); return next;
    } catch (error) { storageFailure(error); return null; }
  }
  function applyAction(action: DraftAction, current = latestWorkspace.current) {
    if (action.kind === 'account-copy' && action.scope !== currentWallet.current.identityScope()) {
      setPendingAction(null); setFormError('Your account changed. Choose the saved account draft again.'); return;
    }
    if (action.kind === 'reload') { loadWorkspace(); return; }
    try {
      const replacement = action.kind === 'account-copy'
        ? action.draft
        : action.kind === 'copy-base'
          ? tokenCopyForBase(current.working.draft)
          : action.kind === 'copy-zero-testnet'
            ? tokenCopyForZero(current.working.draft, 'zero-testnet')
            : action.kind === 'copy-zero-mainnet'
              ? tokenCopyForZero(current.working.draft, 'zero-mainnet')
              : undefined;
      autosaveController.current?.cancel(); updateWorkspace(action.kind === 'resume' ? resumeTokenDraft(current, action.id) : newTokenDraft(current, replacement));
      setReview(false); setAccepted(false); setPendingAction(null); setRemoveId(null); setFormError(null); setNotice(action.kind === 'account-copy' ? 'Account terms copied to a new working draft on this device. The account copy is unchanged.' : '');
    } catch (error) { storageFailure(error); }
  }
  function requestAction(action: DraftAction) {
    let unsaved = true;
    try { unsaved = tokenDraftHasContent(draft) && (!selected || !tokenDraftsEqual(draft, selected.draft)); } catch { /* Keep malformed in-progress fields in the editor until explicitly replaced. */ }
    if (unsaved) { setPendingAction(action); setRemoveId(null); }
    else applyAction(action);
  }
  function confirmRemoval() {
    if (!removeId) return;
    try { if (persist(removeTokenDraft(latestWorkspace.current, removeId))) { setRemoveId(null); setNotice('Saved draft removed. Your working copy is still open.'); } }
    catch (error) { storageFailure(error); }
  }
  function restoreBackup(restored: TokenDraft) {
    autosaveController.current?.cancel(); updateWorkspace(newTokenDraft(latestWorkspace.current, tokenDraftSchema.parse(restored)));
    setReview(false); setAccepted(false); setPendingAction(null); setRemoveId(null); setFormError(null); setNotice('Imported as a new working copy. Save it to add it to your saved drafts.');
  }
  function reviewDraft(event: React.FormEvent) {
    event.preventDefault(); const result = tokenDraftReviewSchema.safeParse(draft);
    if (!result.success) { setFormError(result.error.issues[0]?.message || 'Check your token details.'); return; }
    setFormError(null); setReview(true); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  const collected = draft.fee; const platform = collected * 0.2; const destination = collected * 0.8;
  const amount = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
  const currency = draftPriceUnit(draft), pricingNetwork = draftPricingNetwork(draft);
  const valuation = draft.openingValuation ? `${draft.openingValuation} ${currency}` : "Set before launch";
  return <><Link href="/tokens" className="back-link"><ArrowLeft size={13} />Back to markets</Link><PageHeading title={review ? "Review your token" : "Launch a token"} description={review ? "Check the planned supply and fees." : "Name your token and choose how its fees are used."} action={<Badge>Draft</Badge>} />
    <section className="panel draft-summary token-draft-library" aria-label="Your token drafts">
      <div className="panel-toolbar"><div><strong>Your token drafts</strong><p className="small muted">{workspace.saved.length} of 20 saved on this device. Your open working copy is saved separately.</p></div>
        <div className="button-row"><Button type="button" variant="secondary" disabled={!loaded || !writable} onClick={() => saveCurrent()}><Save size={14} />Save draft</Button><Button type="button" variant="ghost" disabled={!loaded} onClick={() => requestAction({ kind: 'new' })}>New draft</Button></div>
      </div>
      {workspace.saved.length > 0 && <div className="button-row"><select className="input-control" aria-label="Resume a saved token draft" value="" onChange={event => { if (event.target.value) requestAction({ kind: 'resume', id: event.target.value }); }} disabled={!loaded || !writable} style={{ maxWidth: 320 }}><option value="">Resume a saved token draft…</option>{workspace.saved.map(record => <option key={record.id} value={record.id}>{label(record.draft)}{record.draft.symbol ? ` (${record.draft.symbol})` : ''}</option>)}</select>{selected && <Button type="button" variant="ghost" disabled={!writable} onClick={() => { setRemoveId(selected.id); setPendingAction(null); }}>Remove saved draft</Button>}</div>}
      {selected && <p className="small muted">Editing {label(selected.draft)}. Last saved {new Date(selected.savedAt).toLocaleString()}.</p>}
      <p className="small muted" role="status">{autosave === 'loading' ? 'Opening browser drafts…' : autosave === 'saving' ? 'Saving your working copy…' : autosave === 'saved' ? 'Working copy saved on this device.' : 'Working copy is open in this tab. Export a backup before leaving.'}</p>
      {notice && <p className="data-notice" role="status">{notice}</p>}
      {storageError && <><ErrorState message={storageError} /><Button type="button" variant="ghost" onClick={() => requestAction({ kind: 'reload' })}>Reload saved drafts</Button></>}
      {pendingAction && <div className="section-gap" role="group" aria-label="Keep your current token draft"><h3>Keep your current draft?</h3><p>Save this working copy before opening another draft, or export a backup below.</p><div className="button-row"><Button type="button" disabled={!writable} onClick={() => { const next = saveCurrent(); if (next) applyAction(pendingAction, next); }}>Save & continue</Button><Button type="button" variant="secondary" onClick={() => applyAction(pendingAction)}>Continue without saving</Button><Button type="button" variant="ghost" onClick={() => setPendingAction(null)}>Keep editing</Button></div></div>}
      {removeId && <div className="section-gap" role="group" aria-label="Confirm saved token draft removal"><h3>Remove this saved draft?</h3><p>This removes the saved copy from this device. Your open working copy will remain.</p><div className="button-row"><Button type="button" variant="secondary" disabled={!writable} onClick={confirmRemoval}>Remove saved copy</Button><Button type="button" variant="ghost" onClick={() => setRemoveId(null)}>Cancel</Button></div></div>}
    </section>
    <TokenAccountDrafts draft={draft} ready={loaded} onCopy={value => { const scope = currentWallet.current.identityScope(); if (scope) requestAction({ kind: 'account-copy', draft: value, scope }); }} />
    <DraftBackup kind="token" name={draft.name} serialize={() => serializeDraftBackup('token', tokenDraftSchema.parse(draft))} parse={text => parseDraftBackup(text, 'token', value => tokenDraftSchema.parse(value))} onRestore={restoreBackup} />
    <SafetyNote>{pricingNetwork === 'base-sepolia'
      ? <>This draft is for Base Sepolia testnet. Amounts use test ETH, which has no monetary value. <Button type="button" variant="secondary" onClick={() => requestAction({ kind: 'copy-zero-testnet' })}>Create Zero Testnet copy</Button></>
      : <>This draft keeps its {pricingNetwork === 'zero-testnet' ? 'planned test ZRO' : 'planned ZRO'} valuation. A Base Sepolia copy clears the valuation so you can enter a test ETH amount. <Button type="button" variant="secondary" onClick={() => requestAction({ kind: 'copy-base' })}>Create Base Sepolia copy</Button></>
    }</SafetyNote>
    <div className="steps"><div className={!review ? "active" : ""}><span>{review ? <Check size={10} /> : "01"}</span>Details & fees</div><i /><div className={review ? "active" : ""}><span>02</span>Review</div><i /><div><span>03</span>Launch</div></div><div className="gate-panel"><div className="gate-panel-title"><LockKeyhole size={15} />Your token starts as a draft</div><p>Review your terms, then check test-network availability before launching.</p></div>{formError && <ErrorState message={formError} />}<div className="form-layout"><form className="form-main" onSubmit={reviewDraft}>
    {!review ? <><section className="form-section"><div className="form-section-title"><span className="step-number">01</span><h2>Token details</h2></div><div className="field-grid"><Field label="Token name" required><input value={draft.name} onChange={event => patch({ name: event.target.value })} maxLength={32} placeholder="Orbit Club" required /></Field><Field label="Symbol" hint="2–10 letters or numbers." required><input value={draft.symbol} onChange={event => patch({ symbol: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} minLength={2} maxLength={10} pattern="[A-Z0-9]{2,10}" placeholder="ORBIT" required /></Field></div><Field label="Description"><textarea value={draft.description} onChange={event => patch({ description: event.target.value })} maxLength={500} placeholder="What is your token for?" /></Field><Field label="Website" hint="Optional."><input type="url" maxLength={2048} value={draft.website} onChange={event => patch({ website: event.target.value })} placeholder="https://yourproject.com" /></Field></section><section className="form-section"><div className="form-section-title"><span className="step-number">02</span><h2>Fees and earnings</h2></div><Field label="oneshot execution fee" hint={`Paid in ${currency} on oneshot buys and sells. The rate is fixed at launch.`}><div className="fee-slider"><input aria-label="oneshot execution fee percent" type="range" min="1" max="5" step="0.1" value={draft.fee} onChange={event => patch({ fee: Number(event.target.value) })} /><div className="fee-value">{draft.fee.toFixed(1)}<span>%</span></div></div></Field><span className="field-label">Where your share goes</span><div className="mode-options"><button type="button" className={`mode-option ${draft.mode === "creator" ? "selected" : ""}`} onClick={() => patch({ mode: "creator" })}><Coins size={21} /><span className="mode-check">{draft.mode === "creator" && <Check size={9} />}</span><strong>Creator earnings</strong><p>80% of collected fees goes to you, paid in {currency}.</p></button><button type="button" className={`mode-option ${draft.mode === "liquidity_burn" ? "selected" : ""}`} onClick={() => patch({ mode: "liquidity_burn" })}><Flame size={21} /><span className="mode-check">{draft.mode === "liquidity_burn" && <Check size={9} />}</span><strong>Liquidity & burn</strong><p>Your 80% share funds locked liquidity (75%) and token buybacks and burns (25%).</p></button></div><div className="fee-distribution"><span /><span /></div><div className="fee-distribution-labels"><span>oneshot protocol: 20% of collected fees</span><span>Your share: 80%</span></div><Field label="Opening valuation" hint="Optional until launch, when the value becomes fixed for the market."><div className="input-suffix"><input inputMode="decimal" value={draft.openingValuation} onChange={event => patch({ openingValuation: event.target.value })} pattern="[0-9]+(\.[0-9]+)?" maxLength={60} placeholder="Choose later" /><span>{currency}</span></div></Field><SafetyNote>No transfer tax is planned. Trading fees on other exchanges are separate. Net liquidity earnings follow the same 20% protocol and 80% destination split.</SafetyNote></section><section className="form-section"><div className="form-section-title"><span className="step-number">03</span><h2>Supply and liquidity</h2></div><div className="preset-grid"><div className="preset"><span>Fixed initial supply</span><strong>1,000,000,000</strong><small>8 token decimals; no further minting</small></div><div className="preset"><span>Opening valuation</span><strong>{valuation}</strong><small>Fixed at launch</small></div><div className="preset"><span>Pool price ceiling</span><strong>1,000× opening price</strong><small>Upper end of the launch range</small></div><div className="preset"><span>LP fee</span><strong>0.25%</strong><small>Protocol fee may also apply</small></div></div><div className="range-hint"><CircleAlert size={12} /><span>At launch, the full supply is planned for locked liquidity. Review the final liquidity and pricing terms before signing.</span></div></section></> : <section className="form-section"><h2>Launch terms</h2><p>These are the planned terms. Your token has not been published.</p><div className="review-asset"><AssetIcon name={draft.symbol || "?"} large /><div><h3>{draft.name}</h3><p>{draft.symbol} / {currency}</p></div></div><div className="review-rows"><InfoRow label="Initial supply">1,000,000,000 (8 decimals)</InfoRow><InfoRow label="Supply allocation">100% locked launch liquidity</InfoRow><InfoRow label="Opening valuation">{valuation}</InfoRow><InfoRow label="Pool price range">Opening price → 1,000×</InfoRow><InfoRow label="oneshot execution fee">{draft.fee.toFixed(1)}%</InfoRow><InfoRow label="Fee destination">{draft.mode === "creator" ? "Creator earnings" : "Liquidity & burn"}</InfoRow><InfoRow label="Collected fee split">20% protocol / 80% {draft.mode === "creator" ? "creator earnings" : "liquidity & burn"}</InfoRow><InfoRow label="LP fee">0.25% plus any pool protocol fee</InfoRow><InfoRow label="Draft network">{draftPricingNetworkLabel(draft)}</InfoRow></div><div className="review-checks">{["Fixed supply with no further minting at launch", "Initial liquidity is intended to remain locked after launch", "Fee rate, destination and opening valuation fixed at launch"].map(text => <div key={text}><CheckCircle2 size={14} />{text}</div>)}</div><label className="checkbox-field"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} /><span>I have reviewed the planned terms. I understand this draft does not publish a token.</span></label></section>}
    <div className="form-footer">{review ? <Button type="button" variant="secondary" onClick={() => setReview(false)}><ArrowLeft size={14} />Edit details</Button> : <span><Save size={12} />{autosave === "saved" ? "Working copy saved on this device" : autosave === "saving" ? "Saving working copy…" : "Keep this page open or export a backup"}</span>}{review ? <span>Check the launch transaction below.</span> : <Button type="submit">Review launch <ArrowRight size={14} /></Button>}</div>{!review && <Button className="section-gap" type="button" variant="ghost" onClick={() => requestAction({ kind: 'new' })}>New draft</Button>}</form><aside className="form-aside"><div className="panel"><div className="preview-label">Token preview <Badge>Draft</Badge></div><div className="preview-token"><AssetIcon name={draft.symbol || "?"} large /><div><h3>{draft.name || "Token name"}</h3><p>{draft.symbol || "SYMBOL"} / {currency}</p></div></div>{draft.description && <p className="preview-description">{draft.description}</p>}<div className="preview-badges"><Badge tone="mint">{draft.mode === "creator" ? "Creator earnings" : "Liquidity & burn"}</Badge><Badge><LockKeyhole size={9} />Planned liquidity lock</Badge></div><InfoRow label="Opening valuation">{valuation}</InfoRow><InfoRow label="Execution fee">{draft.fee.toFixed(1)}%</InfoRow><InfoRow label="Token supply">1B</InfoRow><div className="form-subheading">Example: a 100 {currency} trade</div><InfoRow label="Collected execution fee">{amount(collected)} {currency}</InfoRow><InfoRow label="oneshot protocol">{amount(platform)} {currency}</InfoRow>{draft.mode === "creator" ? <InfoRow label="Your earnings" accent>{amount(destination)} {currency}</InfoRow> : <><InfoRow label="Locked liquidity">{amount(destination * .75)} {currency}</InfoRow><InfoRow label="Buyback & burn">{amount(destination * .25)} {currency}</InfoRow></>}<p className="form-help">Example fee split. Pool fees and network gas are separate.</p></div><SafetyNote>Publishing requires a transaction. You will review the final terms before signing.</SafetyNote></aside></div>{review && <TokenLaunchReview draft={draft} termsReviewed={accepted} />}</>;
}
