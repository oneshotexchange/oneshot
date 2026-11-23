import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatIndexedAmount, parseAssetAmount } from '@oneshot/evm';
import { useWallet, type WalletState } from '../lib/client-wallet';
import { createReviewedNftExecutionApi, createReviewedNftExecutionController, createReviewedNftPendingStore, reviewedNftActionAvailable, reviewedNftExecutionBusy, reviewedNftUnresolved, type ReviewedNftExecutionContext, type ReviewedNftExecutionState } from '../lib/client-reviewed-nft-execution';
import { reviewedNftExecutionInputSchema, type ReviewedNftExecutionInput, type ReviewedNftExecutionRecord, type ReviewedNftExecutionReview, type ReviewedNftExecutionStatus } from '../lib/reviewed-nft-execution';
import type { ReviewedListing } from '../lib/reviewed-nft-data';
import { nftExplorerHref } from '../lib/nft-network';
import { Address, Badge, Button, ErrorState, Field, InfoRow, SafetyNote } from './ui';
import { WalletButton } from './wallet-button';
import '../app/reviewed-nft-transactions.css';

type Action = ReviewedNftExecutionInput['action'];
type Props = { collection: string; tokenId: string; listing?: ReviewedListing | null; burned?: boolean; deploymentId: string; onRefresh(): void };
const actions: Record<Action, string> = { list: 'List NFT', buy: 'Buy NFT', cancel: 'Cancel listing', claim: 'Claim payouts' };
const amount = (raw: string) => `${formatIndexedAmount(raw, 18)} test ETH`;
const network = (chainId: number | null | undefined) => chainId === 84532 ? 'Base Sepolia testnet (84532)' : chainId === 31337 ? 'Local test network (31337)' : 'Test network unavailable';
export type ReviewedNftAccess = 'checking' | 'unavailable' | 'wallet-unavailable' | 'sign-in' | 'wallet' | 'network' | 'ready';

/** Availability comes before wallet guidance. A readable collection is not an execution capability. */
export function reviewedNftExecutionAccess(input: { status: ReviewedNftExecutionStatus | null; failed: boolean; deploymentId: string; action: Action; configured: boolean; authenticated: boolean; connected: boolean; scope: string | null; chainId: number | null }): ReviewedNftAccess {
  if (input.failed) return 'unavailable';
  if (!input.status) return 'checking';
  if (!reviewedNftActionAvailable(input.status, input.action) || input.status.deploymentId !== input.deploymentId) return 'unavailable';
  if (!input.configured) return 'wallet-unavailable';
  if (!input.authenticated) return 'sign-in';
  if (!input.connected || !input.scope) return 'wallet';
  if (input.chainId !== input.status.network?.chainId) return 'network';
  return 'ready';
}

export function ReviewedNftExecutionGuidance({ access, chainId, action, onRefresh }: { access: ReviewedNftAccess; chainId?: number | null; action: Action; onRefresh(): void }) {
  if (access === 'ready') return null;
  if (access === 'checking') return <p role="status">Checking transaction availability…</p>;
  if (access === 'unavailable') return <div className="reviewed-tx-notice"><p>{action === 'list' || action === 'buy' ? 'Listing and buying are currently unavailable for this collection.' : `${actions[action]} is currently unavailable.`} You can still check saved transactions below.</p><Button variant="secondary" onClick={onRefresh}>Refresh availability</Button></div>;
  if (access === 'wallet-unavailable') return <p>Wallet connection is currently unavailable. Try again later, or keep browsing this collection.</p>;
  if (access === 'network') return <p>Switch your selected wallet to {network(chainId)} before preparing a review. No network change happens automatically.</p>;
  return <p>{access === 'sign-in' ? 'Sign in and connect a linked Ethereum wallet to prepare a transaction review.' : 'Connect a wallet linked to your account to prepare a transaction review.'}</p>;
}

export function ReviewedNftReviewTerms({ review }: { review: ReviewedNftExecutionReview }) {
  return <div className="reviewed-tx-terms">
    <InfoRow label="Network">{network(review.chainId)}</InfoRow>
    <InfoRow label="From"><Address value={review.from} full /></InfoRow>
    {review.action !== 'claim' && <><InfoRow label="Collection"><Address value={review.terms.collection} full /></InfoRow><InfoRow label="Token ID">{review.terms.tokenId}</InfoRow></>}
    {review.action === 'list' || review.action === 'buy' ? <>
      <InfoRow label="Total sale price">{amount(review.terms.totalPriceRaw)}</InfoRow>
      <InfoRow label="Platform fee (2%, included)">{amount(review.terms.platformFeeRaw)}</InfoRow>
      <InfoRow label="Creator royalty (included)">{amount(review.terms.royaltyRaw)}</InfoRow>
      {review.terms.royaltyRaw !== '0' && <InfoRow label="Royalty recipient"><Address value={review.terms.royaltyRecipient} full /></InfoRow>}
      <InfoRow label="Seller payout">{amount(review.terms.sellerProceedsRaw)}</InfoRow>
      <p className="field-hint">The fee and royalty come from the total price. Network gas is additional. Payouts are claimed in a separate transaction.</p>
    </> : null}
    {review.action === 'list' ? <p className="field-hint">This transfers this NFT into marketplace custody at the price shown. It does not grant approval over other NFTs. Cancel the listing to return the NFT.</p>
      : review.action === 'buy' ? <><InfoRow label="NFT recipient"><Address value={review.terms.recipient} full /></InfoRow><p className="field-hint">This pays the full sale price and transfers the NFT to this recipient in one transaction.</p></>
        : review.action === 'cancel' ? <><InfoRow label="NFT return recipient"><Address value={review.terms.recipient} full /></InfoRow><p className="field-hint">This removes the listing and transfers the NFT to the return recipient.</p></>
          : <><InfoRow label="Observed available payouts">{amount(review.terms.amountRaw)}</InfoRow><InfoRow label="Payout recipient"><Address value={review.terms.recipient} full /></InfoRow><p className="field-hint">Claim all available payouts to {review.terms.recipient}. The final amount may change before confirmation.</p></>}
    <InfoRow label="Transaction value">{amount(review.value)}</InfoRow>
    <InfoRow label="Estimated gas units">{review.simulation.gasEstimate}</InfoRow>
    <p className="field-hint">Gas units are an estimate, not a gas price. Review the network fee in your wallet.</p>
    <details><summary>Transaction details</summary><InfoRow label="Review ID">{review.id}</InfoRow><InfoRow label="To"><Address value={review.to} full /></InfoRow><InfoRow label="Wallet transaction nonce">{review.nonce}</InfoRow><InfoRow label="Value (wei)">{review.value}</InfoRow><InfoRow label="Review expires">{new Date(review.expiresAt).toISOString()}</InfoRow><InfoRow label="Simulation block">{review.simulation.blockNumber}</InfoRow><p className="field-hint">Transaction data</p><code className="reviewed-tx-data">{review.data}</code></details>
  </div>;
}

export function ReviewedNftTransactionResult({ state, canApprove, onApprove, onDiscard, onCheck }: { state: ReviewedNftExecutionState; canApprove: boolean; onApprove(): void; onDiscard(): void; onCheck(): void }) {
  const busy = reviewedNftExecutionBusy(state), link = state.hash && nftExplorerHref(state.review?.chainId, state.hash, 'tx');
  return <div className="reviewed-tx-result" aria-live="polite" aria-busy={busy}>
    {state.message && <p role={state.phase === 'error' || state.phase === 'rejected' ? 'alert' : 'status'}>{state.message}</p>}
    {state.storageWarning && <p role="alert" className="field-hint">{state.storageWarning}</p>}
    {state.review && <><h3>{state.hash ? 'Transaction receipt' : 'Review transaction'}</h3><ReviewedNftReviewTerms review={state.review} /></>}
    {busy && <p role="status">{state.phase === 'reviewing' ? 'Preparing your transaction review…' : state.phase === 'revalidating' ? 'Checking current transaction terms…' : state.phase === 'signing' ? 'Review the request in your wallet.' : 'Checking the saved transaction receipt…'}</p>}
    {state.hash && <div className="reviewed-tx-reference"><InfoRow label="Review ID">{state.review?.id}</InfoRow><InfoRow label="Transaction hash">{link ? <a href={link} target="_blank" rel="noreferrer">{state.hash}</a> : state.hash}</InfoRow><p className="field-hint">Keep the review ID and transaction hash if you leave this page.</p></div>}
    {state.record?.canonicalReceipt && <><InfoRow label="Last checked receipt block">{state.record.canonicalReceipt.blockNumber}</InfoRow><InfoRow label="Receipt block hash">{state.record.canonicalReceipt.blockHash}</InfoRow><p className="field-hint">Recent confirmations can change. Check the receipt again for its current status.</p></>}
    <div className="button-row">
      {state.phase === 'review' && <><Button disabled={!canApprove} onClick={onApprove}>Approve in wallet</Button><Button variant="ghost" onClick={onDiscard}>Discard review</Button></>}
      {state.hash && <Button variant="secondary" disabled={busy} onClick={onCheck}>Check receipt</Button>}
    </div>
  </div>;
}

export function ReviewedNftTransactions(props: Props) {
  const wallet = useWallet(), scope = wallet.identityScope();
  // Private history and form values cannot survive an account/wallet identity change.
  const key = JSON.stringify([scope, wallet.userId, wallet.account?.address?.toLowerCase(), props.collection, props.tokenId, props.deploymentId]);
  return <ReviewedNftTransactionSession key={key} {...props} wallet={wallet} />;
}

function ReviewedNftTransactionSession({ collection, tokenId, listing, burned = false, deploymentId, onRefresh, wallet }: Props & { wallet: WalletState }) {
  const latest = useRef(wallet); latest.current = wallet;
  const api = useMemo(() => createReviewedNftExecutionApi({ identityScope: () => latest.current.identityScope(), getAccessToken: () => latest.current.getAccessToken() }), []);
  const pending = useMemo(() => createReviewedNftPendingStore(), []);
  const [availability, setAvailability] = useState<{ status: ReviewedNftExecutionStatus | null; failed: boolean } | null>(null), [attempt, setAttempt] = useState(0);
  const [action, setAction] = useState<Action>(burned ? 'claim' : listing?.status === 'active' ? listing.seller === wallet.account?.address?.toLowerCase() ? 'cancel' : 'buy' : 'list');
  const [price, setPrice] = useState(''), [recipient, setRecipient] = useState(wallet.account?.address || ''), [ack, setAck] = useState(false), [inputError, setInputError] = useState<string | null>(null);
  const status = availability?.status || null, from = wallet.account?.address?.toLowerCase() || null, scope = wallet.identityScope();
  const access = reviewedNftExecutionAccess({ status, failed: availability?.failed === true, deploymentId, action, configured: wallet.configured && !wallet.unavailableReason, authenticated: wallet.authenticated, connected: wallet.connected, scope, chainId: wallet.network?.chainId || null });
  const context = useRef<ReviewedNftExecutionContext>(null!);
  context.current = { identityScope: scope, userId: wallet.userId, from, chainId: wallet.network?.chainId || null, ready: access === 'ready', status, selection: JSON.stringify([collection, tokenId, deploymentId, action, price, recipient, ack]), collection, tokenId, listing };
  const controller = useMemo(() => createReviewedNftExecutionController({ api, pending, context: () => context.current, sendEvmTransaction: transaction => latest.current.sendEvmTransaction(transaction) }), [api, pending]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot), contextKey = JSON.stringify(context.current), busy = reviewedNftExecutionBusy(state), locked = busy || reviewedNftUnresolved(state);
  const [storageVersion, setStorageVersion] = useState(0), [recoverId, setRecoverId] = useState(''), [recoverHash, setRecoverHash] = useState('');
  const [history, setHistory] = useState<{ items: ReviewedNftExecutionRecord[]; cursor: string | null; loading: boolean; failed: boolean } | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController(); let active = true; setAvailability(null);
    void api.status(abort.signal).then(value => { if (active) setAvailability({ status: value, failed: false }); }).catch(() => { if (active) setAvailability({ status: null, failed: true }); });
    return () => { active = false; abort.abort(); };
  }, [api, attempt]);
  useEffect(() => { controller.syncContext(); }, [controller, contextKey]);
  useEffect(() => {
    if (burned && action !== 'claim') {
      controller.invalidate('This NFT has been burned. Only payout claims remain available.');
      setAction('claim');
      setAck(false);
    }
  }, [burned, action, controller]);
  useEffect(() => () => { controller.invalidate(); historyRequest.current?.abort(); }, [controller]);
  useEffect(() => { const changed = () => setStorageVersion(value => value + 1); window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed); }, []);
  const saved = useMemo(() => wallet.authenticated && wallet.userId && from ? pending.list(wallet.userId, { from, deploymentId }) : [], [pending, wallet.authenticated, wallet.userId, from, deploymentId, storageVersion, state.phase, state.hash]);
  const storageWarning = pending.warning(), canRecover = Boolean(wallet.authenticated && scope && from);
  function edit(change: () => void) { controller.invalidate('The transaction inputs changed. Prepare a fresh review.'); setInputError(null); change(); }
  function prepare() {
    if (access !== 'ready' || !status?.network || !from || !ack || locked) return;
    const common = { action, from, expectedChainId: status.network.chainId, expectedDeploymentId: deploymentId, testEthAcknowledged: true };
    const input = action === 'claim' ? { ...common, recipient: recipient.trim().toLowerCase() }
      : action === 'list' ? { ...common, collection, tokenId, price: price.trim() }
        : { ...common, collection, tokenId, listingId: listing?.listingId, recipient: recipient.trim().toLowerCase(), ...(action === 'buy' ? { expectedTotalPriceRaw: listing?.totalPriceRaw } : {}) };
    const parsed = reviewedNftExecutionInputSchema.safeParse(input);
    try { if (!parsed.success || parsed.data.action === 'list' && parseAssetAmount(parsed.data.price, 18) <= 0n) throw new Error(); } catch { setInputError('Enter a positive test ETH price or a valid recipient wallet, then review again.'); return; }
    void controller.prepare(parsed.data);
  }
  async function loadHistory(more = false) {
    if (!canRecover || !from || more && (!history?.cursor || history.items.length >= 100)) return;
    historyRequest.current?.abort(); const abort = new AbortController(); historyRequest.current = abort;
    const previous = more ? history?.items || [] : [];
    setHistory({ items: previous, cursor: more ? history?.cursor || null : null, loading: true, failed: false });
    try {
      const page = await api.history(from, more ? history?.cursor || undefined : undefined, abort.signal); abort.signal.throwIfAborted();
      if (historyRequest.current !== abort) return;
      if (previous.some(record => page.items.some(next => next.review.id === record.review.id))) throw new Error();
      setHistory({ items: [...previous, ...page.items], cursor: page.nextCursor, loading: false, failed: false });
    } catch { if (!abort.signal.aborted && historyRequest.current === abort) setHistory({ items: previous, cursor: null, loading: false, failed: true }); }
  }
  const optionActions: Action[] = burned ? ['claim'] : listing?.status === 'active' ? ['buy', 'cancel', 'claim'] : ['list', 'claim'];
  const selectedListingMatches = (action !== 'buy' && action !== 'cancel') || listing?.status === 'active' && listing.collection === collection && listing.tokenId === tokenId && listing.marketplace === status?.marketplace;
  return <section className="panel reviewed-nft-transactions section-gap" aria-label="NFT transactions">
    <div className="section-header"><div><h2>Manage this NFT</h2><p>Review the exact transaction before approving it in your wallet.</p></div><Badge tone="amber">Test ETH</Badge></div>
    {burned && <p className="field-hint">This NFT has been burned. Only payout claims and saved transaction checks remain available.</p>}
    <Field label="Action"><select value={action} disabled={locked} onChange={event => edit(() => { setAction(event.target.value as Action); setAck(false); })}>{[...new Set([action, ...optionActions])].map(value => <option value={value} key={value}>{actions[value]}</option>)}</select></Field>
    <ReviewedNftExecutionGuidance access={access} chainId={status?.network?.chainId} action={action} onRefresh={() => { controller.invalidate('Availability is being refreshed. Prepare a fresh review afterward.'); setAvailability(null); setAttempt(value => value + 1); }} />
    {(access === 'sign-in' || access === 'wallet') && <WalletButton />}
    {access === 'ready' && <><p className="field-hint">{network(status?.network?.chainId)}. Test-network assets have no monetary value.</p>
      {!selectedListingMatches ? <ErrorState message="The listing changed. Refresh the NFT before reviewing this action." retry={onRefresh} /> : <>
        {action === 'list' ? <Field label="Total sale price (test ETH)" hint="Up to 18 decimals. The 2% platform fee and creator royalty come from this price."><input inputMode="decimal" value={price} maxLength={97} disabled={locked} onChange={event => edit(() => setPrice(event.target.value))} placeholder="0.0" /></Field>
          : <Field label={action === 'buy' ? 'NFT recipient' : action === 'cancel' ? 'NFT return recipient' : 'Payout recipient'} hint="Check this address carefully. The transaction uses the recipient shown."><input autoComplete="off" spellCheck={false} value={recipient} maxLength={42} disabled={locked} onChange={event => edit(() => setRecipient(event.target.value))} /></Field>}
        {action === 'buy' && listing && <InfoRow label="Listed total price">{amount(listing.totalPriceRaw)}</InfoRow>}
        <label className="checkbox-field section-gap"><input type="checkbox" checked={ack} disabled={locked} onChange={event => edit(() => setAck(event.target.checked))} /><span>I understand this uses {network(status?.network?.chainId)} and test ETH. I will check the recipient and network gas before approving.</span></label>
        {inputError && <p role="alert">{inputError}</p>}<Button disabled={!ack || locked} loading={state.phase === 'reviewing'} onClick={prepare}>Review {actions[action].toLowerCase()}</Button>
      </>}
    </>}
    <ReviewedNftTransactionResult state={state} canApprove={access === 'ready' && ack && selectedListingMatches} onApprove={() => void controller.approve()} onDiscard={() => controller.invalidate('Review discarded.')} onCheck={() => void controller.checkReceipt()} />
    {state.phase === 'confirmed' && <Button variant="secondary" onClick={onRefresh}>Refresh NFT records</Button>}
    <details className="reviewed-tx-recovery"><summary>Check a saved transaction</summary><p className="field-hint">A receipt check does not send a transaction. Sign in with the account and linked wallet that created the review.</p>
      {!canRecover ? <p>Connect your account’s linked wallet to open private transaction records.</p> : <>
        {storageWarning && <p role="alert">{storageWarning}</p>}
        {saved.length > 0 && <ul className="reviewed-tx-saved">{saved.map(item => <li key={item.reviewId}><span>{network(item.chainId)}<br />Review {item.reviewId}<br /><code>{item.hash}</code></span><Button variant="secondary" disabled={busy || reviewedNftUnresolved(state) && state.review?.id !== item.reviewId} onClick={() => void controller.recover(item.reviewId, item.hash)}>Check receipt</Button></li>)}</ul>}
        <div className="reviewed-tx-fields"><Field label="Review ID"><input value={recoverId} maxLength={36} disabled={locked} onChange={event => setRecoverId(event.target.value)} /></Field><Field label="Transaction hash" hint="Optional when the submitted hash is already saved in your account."><input value={recoverHash} maxLength={66} disabled={locked} onChange={event => setRecoverHash(event.target.value)} /></Field></div>
        <Button variant="secondary" disabled={locked || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(recoverId.trim()) || Boolean(recoverHash.trim() && !/^0x[\da-f]{64}$/i.test(recoverHash.trim()))} onClick={() => void controller.recover(recoverId.trim().toLowerCase(), recoverHash.trim().toLowerCase() || undefined)}>Check saved review</Button>
        <div className="section-header section-gap"><div><h3>Your NFT transactions</h3><p>Saved status from the last check. Check a receipt for its current confirmation.</p></div><Button variant="secondary" disabled={history?.loading || busy} onClick={() => void loadHistory()}>Refresh transaction history</Button></div>
        {history?.loading && <p role="status">Loading saved transactions…</p>}{history?.failed && <ErrorState message="Transaction history could not be loaded. Refresh history to try again." retry={() => void loadHistory()} />}
        {history && !history.loading && !history.failed && !history.items.length && <p>No saved transactions for this wallet.</p>}
        {history?.items.map(item => <article className="reviewed-tx-history" key={item.review.id}><div><strong>{actions[item.review.action]}</strong><p>{network(item.review.chainId)} · Last checked: {item.outcome === 'review' ? 'Not submitted' : item.outcome}</p><p className="field-hint">{item.review.action !== 'claim' ? `${item.review.terms.collection} · Token ID ${item.review.terms.tokenId}` : `Payout recipient ${item.review.terms.recipient}`}</p><p className="field-hint">Review {item.review.id}<br />{item.transactionHash || 'No transaction hash saved'}</p><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toISOString()}</time></div><Button variant="secondary" disabled={busy || reviewedNftUnresolved(state) && state.review?.id !== item.review.id} onClick={() => { setRecoverId(item.review.id); setRecoverHash(item.transactionHash || ''); void controller.recover(item.review.id, item.transactionHash || undefined); }}>Check saved review</Button></article>)}
        {history?.cursor && !history.failed && history.items.length < 100 && <Button variant="secondary" disabled={history.loading || busy} onClick={() => void loadHistory(true)}>Load more transactions</Button>}
        {history?.cursor && history.items.length >= 100 && <p className="field-hint">Showing the first 100 saved transactions. Use a review ID to check an older transaction.</p>}
      </>}
    </details>
    <SafetyNote>Each listing, purchase, cancellation and payout claim is a separate transaction. Connecting a wallet or checking a receipt does not send one.</SafetyNote>
  </section>;
}
