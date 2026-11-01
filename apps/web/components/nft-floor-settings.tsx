"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatIndexedAmount } from '@oneshot/evm';
import { useWallet } from '../lib/client-wallet';
import { createNftFloorApi, nftFloorPolicyRequest, type PrivateNftFloorStatus } from '../lib/client-nft-floor';
import { createNftLaunchApi, createNftLaunchController, type NftLaunchContext } from '../lib/client-nft-launch';
import { Address, Badge, Button, ErrorState, Field, InfoRow } from './ui';
import { NftReviewSummary, NftTransactionData, nftTransactionPhase } from './nft-review-summary';

const busyPhases = ['reviewing', 'validating', 'signing', 'confirming'];

/** The entire settings UI is private: no placeholder or badge is rendered for other visitors. */
export function NftFloorSettings({ collection }: { collection: string }) {
  const wallet = useWallet(), scope = wallet.identityScope();
  if (!wallet.authenticated || !wallet.connected || !scope || !wallet.account || !/^0x[\da-f]{40}$/i.test(collection)) return null;
  return <CreatorFloorControls key={`${scope}:${collection.toLowerCase()}:${wallet.account.address.toLowerCase()}`} collection={collection.toLowerCase()} />;
}

function CreatorFloorControls({ collection }: { collection: string }) {
  const wallet = useWallet(), latestWallet = useRef(wallet); latestWallet.current = wallet;
  const api = useMemo(() => createNftLaunchApi({ identityScope: () => latestWallet.current.identityScope(), getAccessToken: () => latestWallet.current.getAccessToken() }), []);
  const floorApi = useMemo(() => createNftFloorApi({ identityScope: () => latestWallet.current.identityScope(), getAccessToken: () => latestWallet.current.getAccessToken() }), []);
  const [status, setStatus] = useState<PrivateNftFloorStatus | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const [enabled, setEnabled] = useState(false), [price, setPrice] = useState(''), [acknowledged, setAcknowledged] = useState(false), [clock, setClock] = useState(Date.now());
  const generation = useRef(0), scope = wallet.identityScope();
  const context = useRef<NftLaunchContext>({ identityScope: scope, address: wallet.account?.address || null, chainId: wallet.network?.chainId || null, draftId: collection, revision: 0, prepared: false, scope: 'public', userId: wallet.userId });
  context.current = { identityScope: scope, address: wallet.account?.address || null, chainId: wallet.network?.chainId || null, draftId: collection, revision: 0,
    prepared: Boolean(status && !error), deploymentId: status?.deploymentId, scope: 'public', userId: wallet.userId, selectionKey: `floor-settings:${collection}` };
  const controller = useMemo(() => createNftLaunchController({ api, context: () => context.current, sendEvmTransaction: transaction => latestWallet.current.sendEvmTransaction(transaction) }), [api]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const busy = busyPhases.includes(state.phase), submitted = Boolean(state.hash && !['confirmed', 'reverted'].includes(state.receipt?.status || ''));
  const ready = Boolean(status && !error && scope && wallet.connected && wallet.authenticated && wallet.network?.chainId === 31337);
  const expiresIn = state.review ? Math.max(0, Math.ceil((Date.parse(state.review.expiresAt) - clock) / 1000)) : 0;

  async function refresh() {
    const creator = latestWallet.current.account?.address, captured = latestWallet.current.identityScope(), ticket = ++generation.current;
    if (!creator || !captured) return;
    setLoading(true);
    try {
      const next = await floorApi.status(collection, creator);
      if (ticket !== generation.current || captured !== latestWallet.current.identityScope()) return;
      const currentReview = controller.getSnapshot();
      if (next?.policyCommitment !== status?.policyCommitment && currentReview.phase === 'review') controller.invalidate('The floor policy changed. Prepare a fresh review.');
      setStatus(next); setError(null); setEnabled(Boolean(next?.enabled)); setPrice(next ? formatIndexedAmount(next.floorRaw, 18) : ''); setAcknowledged(false);
    } catch (reason) {
      if (ticket === generation.current && captured === latestWallet.current.identityScope()) setError(reason instanceof Error ? reason.message : 'The private floor settings are unavailable.');
    } finally { if (ticket === generation.current) setLoading(false); }
  }
  useEffect(() => { void refresh(); return () => { generation.current += 1; }; }, [floorApi, collection]);
  useEffect(() => { controller.syncContext(); }, [controller, scope, wallet.network?.chainId, status?.deploymentId, Boolean(status), error]);
  useEffect(() => { if (state.phase !== 'review') return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [state.phase, state.review?.id]);
  const completedReview = useRef<string | null>(null);
  useEffect(() => {
    if (state.phase !== 'success' || !state.review || completedReview.current === state.review.id) return;
    completedReview.current = state.review.id; void refresh();
  }, [state.phase, state.review?.id]);
  useEffect(() => () => controller.invalidate('The private floor settings were closed.'), [controller]);
  function change(update: () => void) { controller.invalidate('The floor settings changed. Prepare a fresh review.'); setError(null); update(); }
  function prepare() {
    if (!ready || !acknowledged || !status || !wallet.account) return;
    try {
      const input = nftFloorPolicyRequest({ from: wallet.account.address, collection, enabled, price, eligible: status.eligible });
      setClock(Date.now()); void controller.prepare(input);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Check the floor amount before reviewing.'); }
  }

  if (!status) return null;
  return <section className="nft-launch-panel section-gap" aria-label="Private creator floor settings">
    <div className="section-header"><div><h3>Resale price floor</h3><p>Set a floor for new listings in your collection.</p></div><Badge>{status.enabled ? 'Enabled' : 'Disabled'}</Badge></div>
    <div className="review-rows"><InfoRow label="Current floor">{formatIndexedAmount(status.floorRaw, 18)} ETH</InfoRow><InfoRow label="Collection"><Address value={collection} full /></InfoRow></div>
    <p className="field-hint">If a seller enters less than the floor, the floor is added to their amount. Amounts at or above the floor stay unchanged. Sellers review the final price before approving. Existing listings keep their prices and can still be canceled.</p>
    {!status.eligible && <p className="data-notice">This creator wallet can disable its existing policy. Enabling or changing the floor requires current eligibility.</p>}
    {wallet.network?.chainId !== 31337 && <p className="data-notice">Switch to the test network (31337) to review this change.</p>}
    <div className="field-grid section-gap">
      <Field label="Protected floor"><select value={enabled ? 'enabled' : 'disabled'} disabled={busy || submitted || loading} onChange={event => change(() => setEnabled(event.target.value === 'enabled'))}><option value="disabled">Disabled</option><option value="enabled" disabled={!status.eligible}>Enabled</option></select></Field>
      {enabled && <Field label="Floor amount (test ETH)" required hint="Up to 18 decimal places."><input inputMode="decimal" value={price} disabled={!status.eligible || busy || submitted || loading} onChange={event => change(() => setPrice(event.target.value))} placeholder="0.01" /></Field>}
    </div>
    <label className="checkbox-field"><input type="checkbox" checked={acknowledged} disabled={busy || submitted || loading} onChange={event => { if (!event.target.checked) controller.invalidate('Local ETH acknowledgement was removed.'); setAcknowledged(event.target.checked); }} /><span>I understand this changes new listing prices on test chain 31337 and requires test ETH for gas.</span></label>
    {error && <ErrorState message={error} />}
    <div className="button-row section-gap"><Button type="button" variant="secondary" disabled={!ready || !acknowledged || busy || submitted || loading || (enabled && !status.eligible)} loading={state.phase === 'reviewing'} onClick={prepare}>Review floor change</Button><Button type="button" variant="ghost" disabled={busy || submitted} loading={loading} onClick={() => void refresh()}>Refresh settings</Button></div>
    {state.review && <div className="nft-launch-review section-gap">
      <div className="section-header"><h3>Review floor change</h3><Badge tone={state.phase === 'success' ? 'mint' : 'amber'}>{nftTransactionPhase(state.phase)}</Badge></div>
      <div className="review-rows">
        <InfoRow label="Network">Test network (31337), ETH</InfoRow><InfoRow label="From"><Address value={state.review.from} full /></InfoRow><InfoRow label="To"><Address value={state.review.to} full /></InfoRow>
        <InfoRow label="Transaction value">{formatIndexedAmount(state.review.value, 18)} ETH<small className="indexed-subline">{state.review.value} wei</small></InfoRow><InfoRow label="Estimated gas">{state.review.simulation.gasEstimate} gas units, paid separately</InfoRow>
        <NftReviewSummary summary={state.review.summary} action={state.review.action} />
        <InfoRow label="Review expiry">{new Date(state.review.expiresAt).toLocaleString()}{state.phase === 'review' ? `, ${expiresIn}s remaining` : ''}</InfoRow>
      </div>
      <NftTransactionData data={state.review.data} />
      {state.phase === 'review' && <div className="button-row"><Button type="button" disabled={!ready || !acknowledged || expiresIn === 0} onClick={() => void controller.approve()}>Approve in wallet</Button><Button type="button" variant="ghost" onClick={() => controller.invalidate('Floor change discarded.')}>Discard review</Button></div>}
      {state.phase === 'validating' && <p className="data-notice" role="status">Checking the floor change before wallet approval…</p>}
      {state.phase === 'signing' && <p className="data-notice" role="status">Waiting for approval in your linked creator wallet.</p>}
    </div>}
    {state.message && <div className="section-gap" aria-live="polite">{['error', 'rejected', 'reverted'].includes(state.phase) ? <ErrorState message={state.message} /> : <p className="data-notice">{state.message}</p>}</div>}
    {state.hash && <div className="nft-launch-receipt"><InfoRow label="Transaction hash"><span className="indexed-hash">{state.hash}</span></InfoRow><Button type="button" variant="secondary" disabled={busy} onClick={() => void controller.refreshReceipt()}>Check receipt</Button></div>}
  </section>;
}
