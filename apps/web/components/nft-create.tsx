"use client";

import Link from "./navigation";
import { ArrowLeft, ArrowRight, Check, FileImage, Gem, LockKeyhole, Save, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { accountCollectionInput, accountCollectionLocalDraft, collectionAccountInput, createOneshotAccountApi, normalizeLocalCollectionDraft, type LocalCollectionDraft, type UploadedArt } from "../lib/client-oneshot-api";
import { useWallet } from "../lib/client-wallet";
import { privyIdentityScope } from "../lib/privy-wallet-state";
import type { OneshotDraft, OneshotDraftInput } from "../lib/oneshot-draft-schema";
import { Badge, Button, ErrorState, Field, InfoRow, PageHeading, SafetyNote } from "./ui";
import { WalletButton } from "./wallet-button";
import { NftLaunchReview } from "./nft-launch-review";
import { createNftDraftHandoffLoader, parseNftDraftHandoff } from "../lib/client-nft-handoff";
import { createNftDraftRequestGate } from "../lib/client-nft-draft-requests";
import { accountDraftChanges } from "../lib/client-nft-draft-sync";

type CollectionDraft = LocalCollectionDraft;
const storageKey = "oneshot.zero.collectionDrafts.v1";
function localDate(value: number) { const date = new Date(value); return new Date(value - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19); }
function scheduleLabel(value?: string) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Needs completion"; }
function blankDraft(): CollectionDraft { return { id: "", name: "", symbol: "", description: "", supply: "100", royalty: "5", price: "0", limit: "2", metadataMode: "upload", metadataUrl: "", fileNames: [], publicStart: "", publicEnd: "", allowlist: false, allowlistStart: "", allowlistEnd: "", allowlistPrice: "0", addresses: "", savedAt: "" }; }
export function NftCreate() {
  const { search } = useLocation();
  const [draft, setDraft] = useState<CollectionDraft>(blankDraft); const [savedDrafts, setSavedDrafts] = useState<CollectionDraft[]>([]); const [files, setFiles] = useState<File[]>([]); const [cover, setCover] = useState(""); const [review, setReview] = useState(false); const [error, setError] = useState<string | null>(null);
  const [artworkDirty, setArtworkDirty] = useState(false);
  const wallet = useWallet(); const currentWallet = useRef(wallet); currentWallet.current = wallet;
  const currentDraft = useRef(draft); currentDraft.current = draft;
  const accountRequests = useMemo(() => createNftDraftRequestGate(() => ({ identityScope: currentWallet.current.identityScope(), draft: currentDraft.current })), []);
  const accountApi = useMemo(() => createOneshotAccountApi({ getAccessToken: () => currentWallet.current.getAccessToken(), identityScope: () => currentWallet.current.identityScope() }), []);
  const handoff = useMemo(() => { try { return { target: parseNftDraftHandoff(search), error: null }; } catch (reason) { return { target: null, error: reason instanceof Error ? reason.message : 'This collection draft link is invalid.' }; } }, [search]);
  const handoffLoader = useMemo(() => createNftDraftHandoffLoader({ getDraft: accountApi.getDraft, identity: () => {
    const current = currentWallet.current, scope = current.identityScope();
    return current.authenticated && current.authenticationReady && scope === privyIdentityScope(current)
      ? { userId: current.userId, scope } : { userId: null, scope: null };
  } }), [accountApi]);
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const identityScope = wallet.identityScope();
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountList, setAccountList] = useState<{ userId: string; items: OneshotDraft[] } | null>(null);
  const [draftSource, setDraftSource] = useState<"local" | "account">("local");
  const [openedAccountOwner, setOpenedAccountOwner] = useState<string | null>(null);
  const [remote, setRemote] = useState<{ userId: string; localId: string; record: OneshotDraft | null; input: OneshotDraftInput; fileNames: string[] } | null>(null);
  const [accountMessage, setAccountMessage] = useState<{ userId: string; localId: string; message: string } | null>(null);
  const accountDraft = remote?.userId === wallet.userId && remote?.localId === draft.id ? remote.record : null;
  const resumeLaunchId = handoff.target?.draftId === accountDraft?.id ? handoff.target?.launchId ?? undefined : undefined;
  const accountNotice = accountMessage?.userId === wallet.userId && accountMessage?.localId === draft.id ? accountMessage.message : null;
  const accountItems = accountList?.userId === wallet.userId ? accountList.items : [];
  const viewingPrepared = draftSource === "account" && accountDraft?.status === "prepared";
  const accountChanges = accountDraft && remote ? accountDraftChanges(draft, remote.input, remote.fileNames, accountDraft.status === "prepared" ? remote.input.creatorWallet : wallet.account?.address, artworkDirty) : null;
  useEffect(() => {
    accountRequests.invalidate(); setAccountBusy(false);
    return () => accountRequests.invalidate();
  }, [accountRequests, identityScope]);
  useEffect(() => {
    setAccountList(null); setRemote(null); setAccountMessage(null);
    if (draftSource === "account") reset();
  }, [wallet.userId]);
  useEffect(() => {
    handoffLoader.cancel();
    if (handoff.error) { setHandoffNotice(null); setError(handoff.error); return; }
    if (!handoff.target) { setHandoffNotice(null); return; }
    if (!wallet.authenticated || !wallet.authenticationReady || !wallet.userId || !identityScope) {
      setHandoffNotice('Sign in to resume your saved collection draft.');
      return;
    }
    let active = true;
    setHandoffNotice('Loading your collection draft…');
    void handoffLoader.load(handoff.target.draftId).then(record => {
      if (!active || !record) return;
      openAccountDraft(record);
      setHandoffNotice('Collection draft loaded. Check your launch progress to continue.');
    }).catch(reason => {
      if (!active) return;
      setHandoffNotice(null);
      setError(reason instanceof Error ? reason.message : 'Your saved collection draft could not be loaded.');
    });
    return () => { active = false; handoffLoader.cancel(); };
  }, [handoff, handoffLoader, identityScope, wallet.userId, wallet.authenticated, wallet.authenticationReady]);
  useEffect(() => {
    setDraft(previous => ({ ...previous, publicStart: localDate(Date.now() + 60 * 60000), allowlistStart: localDate(Date.now() + 15 * 60000) }));
    try { const saved = JSON.parse(localStorage.getItem(storageKey) || "[]"); if (Array.isArray(saved)) setSavedDrafts(saved.filter(value => value && typeof value.id === "string" && typeof value.name === "string" && typeof value.price === "string" && Array.isArray(value.fileNames)).map(value => normalizeLocalCollectionDraft({ ...blankDraft(), ...value })).slice(0, 20)); } catch { setError("Saved drafts could not be loaded from browser storage. You can prepare a new draft here."); }
  }, []);
  useEffect(() => { if (!files.length) { setCover(""); return; } const url = URL.createObjectURL(files[0]); setCover(url); return () => URL.revokeObjectURL(url); }, [files]);
  const patch = (values: Partial<CollectionDraft>) => setDraft(previous => ({ ...previous, ...values }));
  function selectFiles(selected: FileList | null) {
    if (!selected?.length) return; const chosen = Array.from(selected);
    if (chosen.some(file => file.size > 5 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type))) { setError("Choose PNG, JPEG or WebP images of 5 MiB or smaller."); return; }
    if (chosen.length > 10) { setError("Choose up to 10 images, or use a metadata manifest URL for a larger collection."); return; }
    setError(null); setFiles(chosen); setArtworkDirty(true); patch({ fileNames: chosen.map(file => file.name), ...(chosen.length > 1 ? { supply: String(chosen.length) } : {}) });
  }
  function persist(next: CollectionDraft[]) { localStorage.setItem(storageKey, JSON.stringify(next)); setSavedDrafts(next); }
  function save(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    try {
      if (draft.metadataMode === "upload" && !draft.fileNames.length) throw new Error("Choose art to preview, or use a metadata manifest URL.");
      if (draft.metadataMode === "upload" && draft.fileNames.length > 1 && draft.fileNames.length !== Number(draft.supply)) throw new Error("Choose one image per NFT, or one image for a shared-art edition.");
      if (!draft.symbol?.trim()) throw new Error("Enter a collection symbol.");
      const validated = collectionAccountInput(draft);
      const saved = { ...draft, name: validated.name, symbol: validated.symbol, addresses: validated.allowlistAddresses.join("\n"), id: draft.id || crypto.randomUUID(), savedAt: new Date().toISOString() };
      const next = [saved, ...savedDrafts.filter(value => value.id !== saved.id)].slice(0, 20); persist(next); setDraft(saved); setDraftSource("local"); setReview(true); window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save the browser draft."); }
  }
  function resume(value: CollectionDraft) { handoffLoader.cancel(); setDraft(normalizeLocalCollectionDraft(value)); setDraftSource("local"); setFiles([]); setArtworkDirty(false); setReview(true); setError(null); window.scrollTo({ top: 0, behavior: "smooth" }); }
  function reset() { handoffLoader.cancel(); setDraft({ ...blankDraft(), publicStart: localDate(Date.now() + 60 * 60000), allowlistStart: localDate(Date.now() + 15 * 60000) }); setDraftSource("local"); setOpenedAccountOwner(null); setFiles([]); setArtworkDirty(false); setReview(false); setError(null); }
  function remove() { try { persist(savedDrafts.filter(value => value.id !== draft.id)); reset(); } catch { setError("The draft could not be removed from browser storage."); } }
  async function loadAccountDrafts() {
    const userId = wallet.userId;
    if (!userId || wallet.identityScope() !== privyIdentityScope(wallet)) { setError("Sign in to load your saved drafts."); return; }
    const request = accountRequests.begin({ bindDraft: false }); if (!request) return;
    setAccountBusy(true); setError(null);
    try { const result = await accountApi.listDrafts(); if (request.isCurrent()) setAccountList({ userId, items: result.items.filter(record => record.ownerUserId === userId && record.status !== "deleted") }); }
    catch (reason) { if (request.isCurrent()) setError(reason instanceof Error ? reason.message : "Account drafts could not be loaded."); }
    finally { if (request.finish()) setAccountBusy(false); }
  }
  function openAccountDraft(record: OneshotDraft) {
    const owner = currentWallet.current.userId;
    if (!currentWallet.current.authenticated || !owner || record.ownerUserId !== owner) return;
    const local = accountCollectionLocalDraft(record);
    setDraft(local); setDraftSource("account"); setOpenedAccountOwner(owner); setFiles([]); setArtworkDirty(false); setReview(true); setError(null);
    setRemote({ userId: owner, localId: local.id, record, input: accountCollectionInput(record), fileNames: [...local.fileNames] });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function copyAccountTerms() {
    if (!remote || !accountDraft || !wallet.userId) return;
    const local = { ...accountCollectionLocalDraft(accountDraft), id: crypto.randomUUID(), savedAt: "" };
    if (local.metadataMode === "upload" && !remote.input.imageUrl && !remote.input.manifest) local.fileNames = [];
    setDraft(local); setDraftSource("local"); setOpenedAccountOwner(null); setReview(false); setFiles([]); setArtworkDirty(false); setError(null);
    setRemote({ ...remote, localId: local.id, record: null, fileNames: [...local.fileNames] });
    setAccountMessage({ userId: wallet.userId, localId: local.id, message: "Draft copied. Select the artwork again if needed." });
  }
  async function saveToAccount(upload: boolean) {
    const userId = wallet.userId; const localId = draft.id; const scope = privyIdentityScope(wallet);
    if (!userId || !scope) { setError("Sign in to save drafts to your account."); return; }
    if (wallet.identityScope() !== scope) { setError("Your account or wallet changed. Please try again."); return; }
    const request = accountRequests.begin(); if (!request) return;
    const assertCurrent = request.assertCurrent;
    const notice = (message: string) => setAccountMessage({ userId, localId, message });
    setAccountBusy(true); setError(null);
    try {
      collectionAccountInput(draft, wallet.account?.address); // Validate terms before publishing any selected file.
      const uploads: UploadedArt[] = [];
      if (upload) {
        if (draft.metadataMode !== "upload" || !files.length) throw new Error("Select the original image files before uploading art.");
        if (files.length !== draft.fileNames.length || files.some((file, index) => file.name !== draft.fileNames[index])) throw new Error("Save your latest image selection before uploading.");
        for (const [index, file] of files.entries()) { assertCurrent(); notice(`Uploading image ${index + 1} of ${files.length}…`); uploads.push(await accountApi.uploadArt(file)); assertCurrent(); }
      }
      const input = collectionAccountInput(draft, wallet.account?.address, uploads);
      // Saving settings alone never uploads files or silently removes prior uploaded art.
      if (!upload && input.metadataMode === "upload" && remote?.userId === userId && remote.localId === localId && remote.input.metadataMode === "upload") {
        if (remote.input.imageUrl) input.imageUrl = remote.input.imageUrl;
        if (remote.input.manifest) input.manifest = remote.input.manifest;
      }
      assertCurrent(); notice("Saving your draft to your account…");
      const record = await accountApi.saveDraft(input, accountDraft?.status === "draft" ? accountDraft : undefined); assertCurrent();
      setRemote({ userId, localId, record, input, fileNames: upload ? [...draft.fileNames] : remote?.userId === userId && remote.localId === localId ? remote.fileNames : [] });
      if (upload) setArtworkDirty(false);
      setAccountList(previous => previous?.userId === userId ? { userId, items: [record, ...previous.items.filter(item => item.id !== record.id)] } : previous);
      notice(upload ? "Artwork uploaded and draft saved. Your collection has not launched yet." : "Draft saved to your account. Your artwork has not changed.");
    } catch (reason) { if (request.isCurrent()) { setError(reason instanceof Error ? reason.message : "The account draft could not be saved."); notice("Could not save to your account. Your browser draft is unchanged."); } }
    finally { if (request.finish()) setAccountBusy(false); }
  }
  async function prepareAccountDraft() {
    if (!accountDraft || !wallet.userId || !remote) return;
    if (wallet.identityScope() !== privyIdentityScope(wallet)) { setError("Your account or wallet changed. Please try again."); return; }
    const changes = accountDraftChanges(draft, remote.input, remote.fileNames, wallet.account?.address, artworkDirty);
    if (changes.needsSave || changes.needsArtUpload) { setError(changes.needsArtUpload ? "Upload your selected artwork before preparing metadata." : "Save your changes to your account before preparing metadata."); return; }
    const request = accountRequests.begin(); if (!request) return;
    const userId = wallet.userId; const localId = draft.id;
    setAccountBusy(true); setError(null); setAccountMessage({ userId, localId, message: "Preparing your saved artwork and collection details…" });
    try { const record = await accountApi.prepareDraft(accountDraft); if (!request.isCurrent()) return; setRemote({ userId, localId, record, input: remote.input, fileNames: remote.fileNames }); setAccountList(previous => previous?.userId === userId ? { userId, items: [record, ...previous.items.filter(item => item.id !== record.id)] } : previous); setAccountMessage({ userId, localId, message: "Your collection is ready for launch review. Check availability below." }); }
    catch (reason) { if (request.isCurrent()) { setError(reason instanceof Error ? reason.message : "Could not prepare the metadata. Try again."); setAccountMessage({ userId, localId, message: "Your drafts are still saved. Try preparing the metadata again." }); } }
    finally { if (request.finish()) setAccountBusy(false); }
  }
  async function archiveAccountDraft() {
    if (!accountDraft || !wallet.userId || draftSource !== "account") return;
    const userId = wallet.userId; const localId = draft.id; const recordId = accountDraft.id;
    if (wallet.identityScope() !== privyIdentityScope(wallet)) { setError("Your account or wallet changed. Please try again."); return; }
    const request = accountRequests.begin(); if (!request) return;
    setAccountBusy(true); setError(null);
    try {
      const result = await accountApi.archiveDraft(accountDraft);
      if (!request.isCurrent()) return;
      if (!result.archived || result.id !== recordId) throw new Error("The account draft was not archived. Refresh your account drafts and try again.");
      setAccountList(previous => previous?.userId === userId ? { userId, items: previous.items.filter(item => item.id !== recordId) } : previous);
      setRemote(previous => previous?.userId === userId && previous.record?.id === recordId ? null : previous);
      if (currentWallet.current.userId === userId && currentDraft.current.id === localId) {
        reset();
        setAccountMessage({ userId, localId: "", message: "Account draft archived. Uploaded images and saved metadata remain available." });
      }
    } catch (reason) { if (request.isCurrent()) setError(reason instanceof Error ? reason.message : "The account draft could not be archived."); }
    finally { if (request.finish()) setAccountBusy(false); }
  }
  if (draftSource === "account" && (!wallet.authenticated || openedAccountOwner !== wallet.userId)) return <><PageHeading title="Your account changed" description="The previous account draft has been closed." /><Button onClick={reset}>Create a draft</Button></>;
  const accountPanel = <div className="section-gap"><h3>Save to your account</h3><p className="form-help">Save here to pick up your draft on another device. Choose Upload art & save to store the images too.</p>
    {!wallet.authenticated ? <div className="section-gap"><WalletButton /></div> : <>
      {viewingPrepared ? <><SafetyNote>This version is ready for launch review. Copy it to a new draft to make changes.</SafetyNote><Button variant="secondary" className="section-gap" onClick={copyAccountTerms}>Copy to new draft</Button></> : <><div className="button-row section-gap"><Button variant="secondary" loading={accountBusy} disabled={!wallet.authenticationReady} onClick={() => void saveToAccount(false)}><Save size={14} />{accountDraft?.status === "prepared" ? "Save as new account draft" : "Save to account"}</Button>{draft.metadataMode === "upload" && <Button loading={accountBusy} disabled={!files.length || !wallet.authenticationReady} onClick={() => void saveToAccount(true)}><Upload size={14} />Upload art & save</Button>}</div>{draft.metadataMode === "upload" && <SafetyNote>{files.length ? "Uploaded images are publicly accessible by their URL. Only upload artwork you have the rights to use." : "Edit this draft and select the original files again to upload your artwork."}</SafetyNote>}</>}
      {accountDraft && <><div className="review-rows section-gap"><InfoRow label="Draft version">{accountDraft.revision}</InfoRow><InfoRow label="Saved metadata">{accountDraft.status === "prepared" ? "Ready" : "Not ready"}</InfoRow></div>
        {accountDraft.snapshot && <><div className="button-row section-gap"><a className="text-link" href={accountDraft.snapshot.baseUri + "1"} target="_blank" rel="noreferrer">View first NFT metadata <ArrowRight size={12} /></a><Button variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(accountDraft.snapshot!.baseUri); setAccountMessage({ userId: wallet.userId!, localId: draft.id, message: "Metadata base URI copied." }); } catch { setError("Could not copy the metadata base URI."); } }}>Copy metadata base URI</Button></div></>}
        <Button className="section-gap" variant="secondary" loading={accountBusy} disabled={accountDraft.status === "prepared" || accountChanges?.needsSave || accountChanges?.needsArtUpload} onClick={() => void prepareAccountDraft()}>Prepare metadata</Button><p className="form-help">{accountChanges?.needsArtUpload ? "Upload your selected artwork before preparing metadata." : accountChanges?.needsSave ? "Save your changes to your account before preparing metadata." : "This saves the metadata version you will use for launch review."}</p></>}
      {draftSource === "account" && accountDraft && <div className="section-gap"><Button variant="ghost" loading={accountBusy} onClick={() => void archiveAccountDraft()}>Archive account draft</Button><p className="form-help">Removes this draft from your account list. Uploaded images and saved metadata stay available.</p></div>}
    </>}{accountNotice && <p className="form-help" role="status">{accountNotice}</p>}</div>;
  const displayPrice = Number(draft.price) === 0 ? "Free" : `${draft.price} ZRO (planned)`;
  return <><Link href="/nfts" className="back-link"><ArrowLeft size={13} />Back to collections</Link><PageHeading title={review ? draftSource === "account" ? "Your saved collection" : "Review your collection" : "Create a collection"} description={review ? "Review your artwork, mint schedule and royalties before launch." : "Add your artwork and mint settings, then save a draft. No wallet needed."} action={<Badge>{draftSource === "account" ? "Account draft" : "Browser draft"}</Badge>} />
    <div className="gate-panel"><div className="gate-panel-title"><LockKeyhole size={15} />Zero launches are unavailable</div><p>Keep working on your draft. Images upload only when you choose Upload art & save.</p></div>
    {error && <ErrorState message={error} />}
    {handoffNotice && <p className="data-notice" role="status">{handoffNotice}</p>}
    {!review && accountNotice && <p className="form-help" role="status">{accountNotice}</p>}
    <div className="panel draft-summary"><div className="panel-toolbar"><span className="small muted">Your account drafts</span>{wallet.authenticated ? <><Button variant="secondary" loading={accountBusy} onClick={() => void loadAccountDrafts()}>Load saved drafts</Button>{accountItems.length > 0 && <select className="input-control" aria-label="Open a saved account draft" value="" style={{ maxWidth: 270 }} onChange={event => { const record = accountItems.find(item => item.id === event.target.value); if (record) openAccountDraft(record); }}><option value="">Open an account draft…</option>{accountItems.map(record => <option key={record.id} value={record.id}>{record.name}, version {record.revision}, {record.status === "prepared" ? "Ready for review" : "Draft"}</option>)}</select>}</> : <WalletButton />}</div>{accountList?.userId === wallet.userId && accountItems.length === 0 && <p className="data-notice">No drafts saved to your account yet. Save one here to pick up on another device.</p>}</div>
    {savedDrafts.length > 0 && <div className="panel draft-summary"><div className="panel-toolbar"><span className="small muted">Your saved collection drafts</span><select className="input-control" aria-label="Resume a saved collection draft" value="" style={{ maxWidth: 270 }} onChange={event => { const value = savedDrafts.find(item => item.id === event.target.value); if (value) resume(value); }}><option value="">Resume a browser draft…</option>{savedDrafts.map(value => <option value={value.id} key={value.id}>{value.name}</option>)}</select><Button variant="ghost" onClick={reset}>New draft</Button></div></div>}
    <div className="form-layout">{review ? <section className="form-section"><div className="review-asset"><div className="asset-icon asset-icon-large">{cover ? <img src={cover} alt="" /> : <Gem size={23} />}</div><div><h3>{draft.name}</h3><p>{draft.supply} NFTs planned for Zero</p></div></div><div className="process-steps"><div className="process-step done"><span><Check size={11} /></span>{draftSource === "account" ? "Draft loaded from your account" : "Draft saved on this device"}</div><div className="process-step"><span>2</span>Prepare artwork and metadata</div><div className="process-step"><span>3</span>Set mint phases</div><div className="process-step"><span>4</span>Open mint and lock terms when available</div></div><div className="review-rows"><InfoRow label="Symbol">{draft.symbol || "Needs completion"}</InfoRow><InfoRow label="Supply">{draft.supply}</InfoRow><InfoRow label="Planned public mint price">{displayPrice}</InfoRow><InfoRow label="Creator royalty">{draft.royalty}% on oneshot resale</InfoRow><InfoRow label="Planned platform fee">2% included in paid mint & resale</InfoRow><InfoRow label="Public mint start">{scheduleLabel(draft.publicStart)}</InfoRow><InfoRow label="Public mint end">{scheduleLabel(draft.publicEnd)}</InfoRow>{draft.allowlist && <><InfoRow label="Allowlist start">{scheduleLabel(draft.allowlistStart)}</InfoRow><InfoRow label="Allowlist end">{scheduleLabel(draft.allowlistEnd)}</InfoRow></>}<InfoRow label="Mint limit per wallet">{draft.limit}</InfoRow><InfoRow label="Allowlist">{draft.allowlist ? `${draft.addresses.split("\n").length} EVM wallets` : "Public only"}</InfoRow><InfoRow label="Metadata">{draft.metadataMode === "url" ? "Metadata URL (not yet checked)" : `${draft.fileNames.length} image${draft.fileNames.length === 1 ? "" : "s"} selected`}</InfoRow></div>{(!draft.symbol || !draft.publicEnd || (draft.allowlist && !draft.allowlistEnd)) && <SafetyNote>Complete the collection symbol and mint end dates before launch. {viewingPrepared ? "Copy its terms as a new draft to complete them." : "Edit the draft to complete the missing fields."}</SafetyNote>}{draft.metadataMode === "url" && <p className="settings-code section-gap">{draft.metadataUrl}</p>}{draft.metadataMode === "upload" && draftSource === "local" && <SafetyNote>Browser drafts keep file names only. Use Upload art & save below to store selected images; reselect the originals after reopening a browser draft.</SafetyNote>}<div className="button-row section-gap"><Button variant="secondary" disabled={viewingPrepared} onClick={() => setReview(false)}><ArrowLeft size={14} />Edit draft</Button><Button disabled title="Zero launches are unavailable"><LockKeyhole size={14} />Launch unavailable</Button></div>{draftSource === "local" && <Button className="section-gap" variant="ghost" onClick={remove}>Delete browser draft</Button>}<span className="draft-id">{draftSource === "account" ? "Account version saved" : "Saved on this device"} {new Date(draft.savedAt).toLocaleString()}</span>{accountPanel}{accountDraft?.status === "prepared" && !accountChanges?.needsSave && !accountChanges?.needsArtUpload && <NftLaunchReview key={accountDraft.id} draft={accountDraft} initialLaunchId={resumeLaunchId} />}</section> : <form onSubmit={save} className="form-main"><section className="form-section"><div className="form-section-title"><span className="step-number">01</span><h2>Collection details</h2></div><Field label="Collection name" required><input value={draft.name} maxLength={100} onChange={event => patch({ name: event.target.value })} required placeholder="e.g. Night Shift" /></Field><Field label="Collection symbol" hint="Shown alongside your collection name." required><input value={draft.symbol || ""} maxLength={20} onChange={event => patch({ symbol: event.target.value })} required placeholder="NIGHT" /></Field><Field label="Description" hint="Tell collectors what ties the work together."><textarea value={draft.description} onChange={event => patch({ description: event.target.value })} maxLength={2048} placeholder="Introduce the art, the idea or the story behind it" /></Field><div className="field-grid"><Field label="Collection supply" hint="1 to 1,000 NFTs." required><input type="number" min="1" max="1000" step="1" value={draft.supply} onChange={event => patch({ supply: event.target.value })} required /></Field><Field label="Creator resale royalty" hint="0–10% on oneshot resales. Locked when mint opens."><div className="input-suffix"><input type="number" min="0" max="10" step="0.1" value={draft.royalty} onChange={event => patch({ royalty: event.target.value })} required /><span>%</span></div></Field></div></section><section className="form-section"><div className="form-section-title"><span className="step-number">02</span><h2>Artwork and metadata</h2></div><div className="segmented"><button type="button" className={draft.metadataMode === "upload" ? "active" : ""} onClick={() => patch({ metadataMode: "upload" })}>Select images</button><button type="button" className={draft.metadataMode === "url" ? "active" : ""} onClick={() => patch({ metadataMode: "url" })}>Metadata URL</button></div>{draft.metadataMode === "upload" ? <><label className="upload-zone"><Upload size={25} /><strong>{draft.fileNames.length ? `${draft.fileNames.length} image${draft.fileNames.length > 1 ? "s" : ""} selected` : "Choose artwork"}</strong><span>PNG, JPEG or WebP. Up to 10 files, 5 MiB each.</span><input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={event => selectFiles(event.target.files)} /></label>{draft.fileNames.length > 0 && <div className="file-list">{draft.fileNames.slice(0, 3).map((name, index) => <div className="file-row" key={`${name}-${index}`}><FileImage size={15} /><span>{name}</span><small>{files[index] ? `${(files[index].size / 1024 / 1024).toFixed(1)} MiB` : "File not attached"}</small></div>)}{draft.fileNames.length > 3 && <span className="field-hint">+ {draft.fileNames.length - 3} more images</span>}</div>}<p className="field-hint">Use one image for a shared-art edition, or one per NFT for distinct pieces. Browser drafts save file names only; choose Upload art & save to store the images.</p></> : <><Field label="Metadata manifest URL" hint='An HTTPS or IPFS JSON manifest with an "items" array. Contents will be checked before launch.' required><input type="url" value={draft.metadataUrl} onChange={event => patch({ metadataUrl: event.target.value })} required placeholder="https://yourproject.com/collection.json" /></Field><details className="form-help"><summary>Manifest example</summary><pre className="settings-code">{`{ "items": [\n  { "name": "NFT #1",\n    "image": "https://…/1.png",\n    "attributes": [\n      { "trait_type": "Color", "value": "Mint" }\n    ]\n  }\n] }`}</pre></details></>}<SafetyNote>Artwork, metadata and royalties are locked when the collection opens for minting. Drafts remain editable.</SafetyNote></section><section className="form-section"><div className="form-section-title"><span className="step-number">03</span><h2>Mint settings</h2></div><div className="field-grid"><Field label="Planned public mint price" hint="Enter 0 for a free mint. Final pricing is confirmed before launch." required><div className="input-suffix"><input value={draft.price} onChange={event => patch({ price: event.target.value })} inputMode="decimal" pattern="[0-9]+(\.[0-9]+)?" maxLength={60} required /><span>ZRO</span></div></Field><Field label="Mint limit per wallet" hint="Each mint phase has its own limit." required><input type="number" min="1" max={draft.supply || 1000} step="1" value={draft.limit} onChange={event => patch({ limit: event.target.value })} required /></Field></div><div className="field-grid"><Field label="Public mint start" hint="Your local timezone, including seconds." required><input type="datetime-local" step="1" value={draft.publicStart} onChange={event => patch({ publicStart: event.target.value })} required /></Field><Field label="Public mint end" hint="Choose a time after the public mint starts." required><input type="datetime-local" step="1" value={draft.publicEnd || ""} onChange={event => patch({ publicEnd: event.target.value })} required /></Field></div><label className="checkbox-field"><input type="checkbox" checked={draft.allowlist} onChange={event => patch({ allowlist: event.target.checked })} /><span><strong>Enable an allowlist phase</strong><br />Give selected wallets access before the public mint.</span></label>{draft.allowlist && <div className="allowlist-fields"><div className="field-grid"><Field label="Planned allowlist price" required><div className="input-suffix"><input value={draft.allowlistPrice} onChange={event => patch({ allowlistPrice: event.target.value })} inputMode="decimal" pattern="[0-9]+(\.[0-9]+)?" maxLength={60} required /><span>ZRO</span></div></Field></div><div className="field-grid"><Field label="Allowlist start" hint="Your local timezone, including seconds." required><input type="datetime-local" step="1" value={draft.allowlistStart} onChange={event => patch({ allowlistStart: event.target.value })} required /></Field><Field label="Allowlist end" hint="After the allowlist starts and no later than the public mint." required><input type="datetime-local" step="1" value={draft.allowlistEnd || ""} onChange={event => patch({ allowlistEnd: event.target.value })} required /></Field></div><Field label="Allowlisted EVM wallets" hint="Nonzero EVM addresses, one per line or comma separated. Duplicates are removed." required><textarea value={draft.addresses} onChange={event => patch({ addresses: event.target.value })} placeholder={"0x…\n0x…"} required /></Field></div>}<SafetyNote>The planned platform fee is 2% of paid mint and resale prices. Creator royalties also apply to resales. Network gas is separate, including for free mints.</SafetyNote></section><div className="form-footer"><span><Save size={12} />No wallet or transaction needed.</span><Button type="submit">Save & review draft <ArrowRight size={14} /></Button></div><Button className="section-gap" type="button" variant="ghost" onClick={reset}>Reset form</Button></form>}
    <aside className="form-aside"><div className="panel"><div className="preview-label"><Badge>Draft</Badge></div><div className="meta-preview">{cover ? <img src={cover} alt="Collection preview" /> : <Gem size={49} strokeWidth={.8} />}</div><h3>{draft.name || "Collection preview"}</h3><p className="preview-description section-gap">{draft.description || "Add a description to introduce the work to collectors."}</p><InfoRow label="Supply">{draft.supply || "Unavailable"} items</InfoRow><InfoRow label="Planned mint price">{displayPrice}</InfoRow><InfoRow label="Creator royalty">{draft.royalty}%</InfoRow><InfoRow label="Planned platform fee">2%</InfoRow><InfoRow label="Allowlist">{draft.allowlist ? "Planned" : "Public only"}</InfoRow></div><SafetyNote>Review your collection before launch. Supply, metadata and mint terms are locked when minting opens.</SafetyNote></aside></div></>;
}
