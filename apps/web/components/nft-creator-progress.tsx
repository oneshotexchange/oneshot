import { useState } from 'react';
import type { NftCreatorProgress } from '@oneshot/evm';
import { creatorCanStart, creatorCollectionHref, type CreatorWorkspaceState } from '../lib/client-nft-creator-progress';
import { Address, Badge, Button, ButtonLink, ErrorState, InfoRow } from './ui';

const phaseLabel: Record<NftCreatorProgress['phase'], string> = {
  created: 'Ready to set mint phases', configured: 'Ready to open', opened: 'Mint terms locked',
  'schedule-expired': 'Mint schedule expired', orphaned: 'Confirmation changed', pending: 'Awaiting confirmation', mismatch: 'Saved terms differ',
};

export function NftCreatorProgressPanel({ state, disabled, onRefresh, onSelect, onMore, onStart, onContinue, onRecover }: {
  state: CreatorWorkspaceState; disabled: boolean; onRefresh(): void; onSelect(id: string): void; onMore(): void; onStart(): void;
  onContinue(progress: NftCreatorProgress): void; onRecover(reviewId: string, hash: string): void;
}) {
  const [copyMessage, setCopyMessage] = useState<{ href: string; text: string } | null>(null);
  const data = state.data, selected = data?.selected || null;
  const href = data ? creatorCollectionHref(selected, data.deploymentId) : null;
  const blocked = disabled || state.loading || state.loadingMore || Boolean(state.error);
  const complete = selected?.phase === 'opened' && selected.termsMatch ? 3
    : selected?.phase === 'schedule-expired' ? selected.termsMatch ? 2 : 1
    : selected?.phase === 'configured' ? 2 : selected?.phase === 'created' ? 1 : 0;
  async function copy() {
    if (!href) return;
    try { await navigator.clipboard.writeText(new URL(href, window.location.origin).href); setCopyMessage({ href, text: 'Collection link copied.' }); }
    catch { setCopyMessage({ href, text: 'The link could not be copied. Open the collection page to copy its address.' }); }
  }
  return <div className="nft-creator-workspace" aria-label="Saved collection launch progress">
    <div className="section-header"><div><h3>Continue your collection</h3><p>Use the creator wallet to pick up where you left off.</p></div><Button type="button" variant="ghost" loading={state.loading} disabled={disabled || state.loadingMore} onClick={onRefresh}>Check progress</Button></div>
    <ol className="nft-creator-steps" aria-label="Collection setup steps">{['Create collection', 'Set mint phases', 'Open mint'].map((label, index) => <li className={complete > index ? 'done' : ''} key={label}><span aria-hidden="true">{index + 1}</span>{label}{complete > index && <small>Complete</small>}</li>)}</ol>
    {state.loading && <p className="data-notice" role="status">Checking your collection progress…</p>}
    {state.error && <ErrorState message={state.error} retry={onRefresh} />}
    {data && <>
      {data.items.length > 1 || data.nextCursor ? <p className="field-hint">Choose the collection you want to continue.</p> : null}
      <div className="nft-creator-candidates">{data.items.map(item => <div className="nft-creator-candidate" key={item.id}><div><strong>Saved collection</strong><span className="indexed-hash">{item.collection}</span><small>Created {new Date(item.createdAt).toLocaleString()}</small></div><Button type="button" variant={selected?.id === item.id ? 'ghost' : 'secondary'} disabled={blocked} onClick={() => onSelect(item.id)}>{selected?.id === item.id ? 'Check selected collection' : 'Check this collection'}</Button></div>)}</div>
      {data.nextCursor && <Button type="button" variant="ghost" loading={state.loadingMore} disabled={disabled || state.loading} onClick={onMore}>Load more collections</Button>}
      {creatorCanStart(data, state.loading, state.error) && <div className="nft-creator-next"><p>Ready to turn this draft into a collection.</p><Button type="button" disabled={blocked} onClick={onStart}>Set up a new collection</Button></div>}
      {data.pending.map(item => <div className="nft-creator-candidate" key={item.reviewId}><div><strong>Unconfirmed creation</strong><span className="indexed-hash">{item.hash}</span><small>Check this transaction before creating another collection.</small></div><Button type="button" variant="secondary" disabled={blocked} onClick={() => onRecover(item.reviewId, item.hash)}>Check creation transaction</Button></div>)}
      {selected && <div className="nft-creator-selected"><Badge tone={selected.phase === 'opened' && selected.termsMatch ? 'mint' : 'amber'}>{phaseLabel[selected.phase]}</Badge><InfoRow label="Selected collection"><Address value={selected.collection} full /></InfoRow>{selected.blockNumber && <p className="field-hint">Progress checked against the network.</p>}
        {selected.nextAction && <div className="button-row section-gap"><Button type="button" disabled={blocked} onClick={() => onContinue(selected)}>{selected.nextAction === 'configure' ? 'Set mint phases' : 'Open mint'}</Button><span className="field-hint">Review this step, then approve it in your wallet.</span></div>}
        {selected.phase === 'schedule-expired' && <p className="data-notice">The mint dates passed before this collection opened. Copy these terms to a new draft and choose new dates before trying again.</p>}
        {selected.phase === 'mismatch' && <p className="data-notice">The collection terms no longer match this saved draft. Compare them before continuing.</p>}
        {selected.phase === 'orphaned' && <p className="data-notice">This collection’s confirmation changed. Check progress again before continuing.</p>}
        {selected.phase === 'pending' && <p className="data-notice">Collection creation is not yet confirmed. Check its receipt before continuing.</p>}
        {['orphaned', 'pending'].includes(selected.phase) && !data.pending.some(item => item.reviewId === selected.id) && <div className="button-row section-gap"><Button type="button" variant="secondary" disabled={blocked} onClick={() => onRecover(selected.id, selected.createHash)}>Check creation transaction</Button><span className="field-hint">Checking does not submit another transaction.</span></div>}
        {href && <><div className="button-row section-gap"><ButtonLink href={href} variant="secondary">View collection</ButtonLink><Button type="button" variant="ghost" onClick={() => void copy()}>Copy collection link</Button></div><p className="field-hint">This collection is on the test network. It may take a moment for recent activity to appear.</p>{copyMessage?.href === href && <p className="form-help" role="status">{copyMessage.text}</p>}</>}
      </div>}
      {data.pending.length > 0 && <div className="section-gap"><ButtonLink href="/portfolio" variant="ghost">View saved transactions</ButtonLink></div>}
    </>}
  </div>;
}
