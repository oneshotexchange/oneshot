import { useEffect, useMemo, useRef, useState } from 'react';
import { createOneshotAccountApi } from '../lib/client-oneshot-api';
import { useWallet } from '../lib/client-wallet';
import { tokenDraftSchema, type TokenDraft } from '../lib/token-drafts';
import type { TokenAccountDraft } from '../lib/token-account-draft';
import { draftPriceUnit, draftPricingNetworkLabel } from '../lib/nft-network';
import { Button, ErrorState, InfoRow } from './ui';
import { WalletButton } from './wallet-button';
import './token-account-drafts.css';

type Library = { scope: string | null; items: TokenAccountDraft[] | null; busy: boolean; error: string; notice: string };
type Pending = { kind: 'update'; record: TokenAccountDraft; draft: TokenDraft } | { kind: 'archive'; record: TokenAccountDraft };
const name = (draft: TokenDraft) => draft.name.trim() || 'Untitled token';

/** Account copies never replace browser storage or the open editor as a side effect of a response. */
export function TokenAccountDrafts({ draft, ready, onCopy }: { draft: TokenDraft; ready: boolean; onCopy(draft: TokenDraft): void }) {
  const wallet = useWallet(), currentWallet = useRef(wallet); currentWallet.current = wallet;
  const scope = wallet.authenticated && wallet.userId ? wallet.identityScope() : null;
  const generation = useRef(0), active = useRef(false);
  const [library, setLibrary] = useState<Library>({ scope: null, items: null, busy: false, error: '', notice: '' });
  const [selectedId, setSelectedId] = useState(''), [pending, setPending] = useState<Pending | null>(null);
  const api = useMemo(() => createOneshotAccountApi({ getAccessToken: () => currentWallet.current.getAccessToken(), identityScope: () => currentWallet.current.identityScope() }), []);
  const visible = library.scope === scope ? library : { scope, items: null, busy: true, error: '', notice: '' };
  const selected = visible.items?.find(record => record.id === selectedId);
  const owned = (record: TokenAccountDraft) => {
    if (record.ownerUserId !== currentWallet.current.userId) throw new Error('This account draft could not be verified. Refresh and try again.');
    return record;
  };
  async function load() {
    if (!scope || scope !== currentWallet.current.identityScope() || active.current) return;
    const request = ++generation.current; active.current = true; setPending(null);
    setLibrary({ scope, items: null, busy: true, error: '', notice: '' });
    try {
      const result = await api.listTokenDrafts(); result.items.forEach(owned);
      if (request === generation.current) { setLibrary({ scope, items: result.items, busy: false, error: '', notice: '' }); setSelectedId(''); }
    } catch (error) {
      if (request === generation.current) setLibrary({ scope, items: null, busy: false, error: error instanceof Error ? error.message : 'Account drafts could not be loaded. Refresh and try again.', notice: '' });
    } finally { if (request === generation.current) active.current = false; }
  }
  useEffect(() => {
    generation.current++; active.current = false; setPending(null); setSelectedId('');
    if (scope) void load();
    else setLibrary({ scope: null, items: null, busy: false, error: '', notice: '' });
    return () => { generation.current++; active.current = false; };
  }, [scope]);
  async function perform(kind: 'create' | 'copy' | 'update' | 'archive', record?: TokenAccountDraft, terms?: TokenDraft) {
    if (!scope || scope !== currentWallet.current.identityScope() || active.current || !visible.items) return;
    const request = ++generation.current, items = visible.items; active.current = true;
    setLibrary({ ...visible, busy: true, error: '', notice: '' });
    try {
      const saved = kind === 'archive' ? await api.archiveTokenDraft(record!) : kind === 'copy' ? owned(await api.getTokenDraft(record!.id)) : owned(await api.saveTokenDraft(tokenDraftSchema.parse(terms ?? draft), kind === 'update' ? record : undefined));
      if (request !== generation.current) return;
      if (kind === 'copy') onCopy((saved as TokenAccountDraft).draft);
      const next = kind === 'archive' ? items.filter(item => item.id !== record!.id) : kind === 'copy' ? items : [saved as TokenAccountDraft, ...items.filter(item => item.id !== saved.id)];
      setLibrary({ scope, items: next, busy: false, error: '', notice: kind === 'archive' ? 'Account copy archived. Your open draft is unchanged.' : kind === 'copy' ? 'Account copy loaded. Confirm any draft replacement above.' : 'Token draft saved to your account. It has not been published.' });
      setPending(null);
      if (kind === 'archive') setSelectedId(''); else if (kind !== 'copy') setSelectedId(saved.id);
    } catch (error) {
      // A timed-out write may have committed. Require a read before another write;
      // do not turn an unknown result into an empty library or retry a create.
      if (request === generation.current) { setPending(null); setLibrary({ scope, items: null, busy: false, error: error instanceof Error ? error.message : 'The account request could not be completed. Refresh account drafts before retrying.', notice: '' }); }
    } finally { if (request === generation.current) active.current = false; }
  }
  function prepareUpdate() {
    try { if (selected) setPending({ kind: 'update', record: selected, draft: tokenDraftSchema.parse(draft) }); }
    catch { setLibrary({ ...visible, error: 'Check your open draft fields before saving to your account.' }); }
  }
  return <section className="panel draft-summary token-account-drafts" aria-label="Account token drafts">
    <div className="panel-toolbar"><div><h2>Account token drafts</h2><p className="small muted">Save a private copy to resume on another device. No wallet or transaction is needed.</p></div>
      {scope ? <div className="button-row"><Button type="button" variant="secondary" disabled={!ready || visible.busy || !visible.items || visible.items.length >= 20 || !!pending} onClick={() => void perform('create')}>Save account copy</Button><Button type="button" variant="ghost" disabled={visible.busy || !!pending} onClick={() => void load()}>Refresh account drafts</Button></div> : <WalletButton />}
    </div>
    {scope && <>
      {visible.busy && <p className="small muted" role="status">Loading or saving account drafts…</p>}
      {visible.error && <ErrorState message={visible.error} />}
      {visible.notice && <p className="data-notice" role="status">{visible.notice}</p>}
      {visible.items && <><p className="small muted">{visible.items.length} of 20 account copies saved.</p>{visible.items.length === 0 ? <p>No token drafts saved to your account yet.</p> : <select className="input-control" aria-label="Select an account token draft" value={selectedId} disabled={visible.busy || !!pending} onChange={event => setSelectedId(event.target.value)}><option value="">Choose an account draft…</option>{visible.items.map(record => <option key={record.id} value={record.id}>{name(record.draft)}{record.draft.symbol ? ` (${record.draft.symbol})` : ''} — version {record.revision}</option>)}</select>}</>}
      {selected && <div className="section-gap">
        <p>Saved {new Date(selected.updatedAt).toLocaleString()}. {draftPricingNetworkLabel(selected.draft)}.</p>
        <div className="button-row"><Button type="button" variant="secondary" disabled={visible.busy || !!pending || !ready} onClick={() => void perform('copy', selected)}>Copy to editor</Button><Button type="button" variant="ghost" disabled={visible.busy || !!pending || !ready} onClick={prepareUpdate}>Update from editor</Button><Button type="button" variant="ghost" disabled={visible.busy || !!pending} onClick={() => setPending({ kind: 'archive', record: selected })}>Archive account copy</Button></div>
        <p className="small muted">Copy to editor creates a working copy on this device. It stays here after sign-out. Updating or archiving the account copy does not change your open draft.</p>
      </div>}
      {pending && library.scope === scope && <div className="section-gap" role="group" aria-label={pending.kind === 'archive' ? 'Archive account token draft' : 'Update account token draft'}>
        <h3>{pending.kind === 'archive' ? 'Archive this account copy?' : 'Replace this account copy?'}</h3><p>{name(pending.record.draft)}, version {pending.record.revision}. {pending.kind === 'archive' ? 'Your open working copy will remain.' : 'The terms below are the copy that will be saved.'}</p>
        {pending.kind === 'update' && <div className="review-rows"><InfoRow label="Token">{name(pending.draft)} {pending.draft.symbol && `(${pending.draft.symbol})`}</InfoRow><InfoRow label="Network">{draftPricingNetworkLabel(pending.draft)}</InfoRow><InfoRow label="Opening valuation">{pending.draft.openingValuation || 'Not set'} {draftPriceUnit(pending.draft)}</InfoRow><InfoRow label="Execution fee">{pending.draft.fee.toFixed(1)}%</InfoRow><InfoRow label="Fee destination">{pending.draft.mode === 'creator' ? 'Creator earnings' : 'Liquidity & burn'}</InfoRow></div>}
        <div className="button-row"><Button type="button" disabled={visible.busy} onClick={() => void perform(pending.kind, pending.record, pending.kind === 'update' ? pending.draft : undefined)}>{pending.kind === 'archive' ? 'Archive account copy' : 'Save this version'}</Button><Button type="button" variant="ghost" disabled={visible.busy} onClick={() => setPending(null)}>Keep account copy</Button></div>
      </div>}
    </>}
  </section>;
}
