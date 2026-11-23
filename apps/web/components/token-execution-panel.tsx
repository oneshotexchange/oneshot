import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatIndexedAmount, parseAssetAmount, type IndexedTokenContext, type IndexedTokenMarket, type TokenExecutionReview, type TokenExecutionStatus, type TokenTransactionIntent } from '@oneshot/evm';
import type { Address } from 'viem';
import { useWallet } from '../lib/client-wallet';
import { createTokenExecutionApi, createTokenExecutionController, type TokenExecutionContext, type TokenExecutionState } from '../lib/client-token-execution';
import { createTokenPendingStore, TOKEN_PENDING_STORAGE_KEY } from '../lib/client-token-pending';
import { draftCanLaunchOnNetwork, nativeAssetLabel, nftExplorerHref, nftNetworkLabel, readNftNetwork } from '../lib/nft-network';
import type { TokenDraft } from '../lib/token-drafts';
import { Address as DisplayAddress, Badge, Button, ButtonLink, ErrorState, Field, InfoRow, Loading, SafetyNote, Tabs } from './ui';
import { WalletButton } from './wallet-button';
import '../app/token-markets.css';

const busy = (state: TokenExecutionState) => ['reviewing', 'validating', 'signing', 'confirming'].includes(state.phase);
const unresolved = (state: TokenExecutionState) => Boolean(state.hash && state.receipt?.status !== 'confirmed' && state.receipt?.status !== 'reverted');
const native = (value: string, label = 'test ETH') => `${formatIndexedAmount(value, 18)} ${label}`;
const tokens = (value: string, symbol: string) => `${formatIndexedAmount(value, 8)} ${symbol}`;
const percent = (value: string, decimals: number) => `${formatIndexedAmount(value, decimals)}%`;
const actions = { launch: 'Launch token', approve: 'Approve token amount', buy: 'Buy tokens', sell: 'Sell tokens', claim: 'Claim proceeds', maintain: 'Process fees' };

/** Testnet availability and the exact public source are checked before wallet/network guidance. */
export type TokenExecutionAccess = 'unavailable' | 'checking' | 'pricing' | 'wallet-unavailable' | 'sign-in' | 'wallet' | 'network' | 'ready';
export function tokenExecutionAccess(input: { status: TokenExecutionStatus | null; failed: boolean; snapshot?: IndexedTokenContext; pricingMatches: boolean; configured: boolean; authenticated: boolean; connected: boolean; scope: string | null; chainId: number | null }): TokenExecutionAccess {
  if (input.failed) return 'unavailable';
  if (!input.status) return 'checking';
  if (!input.status.enabled || !readNftNetwork(input.status.network)) return 'unavailable';
  if (input.snapshot && (!input.snapshot.available || input.snapshot.deploymentId !== input.status.deploymentId || input.snapshot.network?.chainId !== input.status.network.chainId || input.snapshot.source?.factory.address !== input.status.factory)) return 'unavailable';
  if (!input.pricingMatches) return 'pricing';
  if (!input.configured) return 'wallet-unavailable';
  if (!input.authenticated) return 'sign-in';
  if (!input.connected || !input.scope) return 'wallet';
  if (input.chainId !== input.status.network.chainId) return 'network';
  return 'ready';
}

function useTokenExecution(selection: string, target: { market?: IndexedTokenMarket; snapshot?: IndexedTokenContext; draft?: TokenDraft }) {
  const wallet = useWallet(), latest = useRef(wallet); latest.current = wallet;
  const api = useMemo(() => createTokenExecutionApi({ identityScope: () => latest.current.identityScope(), getAccessToken: () => latest.current.getAccessToken() }), []);
  const pending = useMemo(() => createTokenPendingStore(), []);
  const [attempt, setAttempt] = useState(0), [availability, setAvailability] = useState<{ key: string; status: TokenExecutionStatus | null; failed: boolean } | null>(null);
  const availabilityKey = JSON.stringify([target.market?.market || 'launch', target.snapshot?.deploymentId, target.snapshot?.network?.chainId, target.snapshot?.source?.factory.address]);
  useEffect(() => {
    let active = true; const abort = new AbortController(); setAvailability(null);
    void api.status(abort.signal).then(status => { if (active) setAvailability({ key: availabilityKey, status, failed: false }); }).catch(() => { if (active) setAvailability({ key: availabilityKey, status: null, failed: true }); });
    return () => { active = false; abort.abort(); };
  }, [api, availabilityKey, attempt]);
  const status = availability?.key === availabilityKey ? availability.status : null, scope = wallet.identityScope();
  const pricingMatches = !target.draft || draftCanLaunchOnNetwork(target.draft, status?.enabled ? status.network : null);
  const access = tokenExecutionAccess({ status, failed: availability?.key === availabilityKey && availability.failed, snapshot: target.snapshot, pricingMatches, configured: wallet.configured, authenticated: wallet.authenticated, connected: wallet.connected, scope, chainId: wallet.network?.chainId || null });
  const context = useRef<TokenExecutionContext>({ identityScope: null, userId: null, from: null, chainId: null, deploymentId: null, ready: false, selection });
  context.current = {
    identityScope: scope, userId: wallet.userId, from: wallet.account?.address || null, chainId: wallet.network?.chainId || null, deploymentId: status?.enabled ? status.deploymentId : null, ready: access === 'ready', selection,
    ...(status?.enabled ? { factory: status.factory } : {}), ...(target.market ? { market: target.market.market, token: target.market.token, executionFeeBps: target.market.executionFeeBps, feeMode: target.market.liquidityAndBurn ? 'liquidity_burn' : 'creator' } : {})
  };
  const controller = useMemo(() => createTokenExecutionController({ api, context: () => context.current, pending, sendEvmTransaction: transaction => latest.current.sendEvmTransaction(transaction) }), [api, pending]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot), key = JSON.stringify(context.current);
  useEffect(() => { controller.syncContext(); }, [controller, key]);
  useEffect(() => () => controller.invalidate(), [controller]);
  const [storageVersion, setStorageVersion] = useState(0);
  useEffect(() => { const changed = (event: StorageEvent) => { if (event.key === null || event.key === TOKEN_PENDING_STORAGE_KEY) setStorageVersion(value => value + 1); }; window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed); }, []);
  const saved = useMemo(() => wallet.authenticated && wallet.userId && wallet.account ? pending.list(wallet.userId, wallet.account.address, wallet.network?.chainId, status?.enabled ? status.deploymentId : target.snapshot?.deploymentId || undefined, target.market?.market || (status?.enabled ? status.factory : undefined)) : [], [pending, wallet.authenticated, wallet.userId, wallet.account?.address, wallet.network?.chainId, status, target.market?.market, target.snapshot?.deploymentId, storageVersion, state.phase, state.hash]);
  return { wallet, status, access, controller, state, saved, key, refresh: () => { setAvailability(null); setAttempt(value => value + 1); } };
}

export function TokenExecutionSummary({ review, symbol }: { review: TokenExecutionReview; symbol: string }) {
  const summary = review.summary;
  const unit = nativeAssetLabel(review.network);
  return <div className="review-rows">
    {review.action === 'launch' ? <><InfoRow label="Token">{summary.name} ({summary.symbol})</InfoRow><InfoRow label="Initial supply">{tokens(summary.initialSupplyRaw, summary.symbol)}</InfoRow><InfoRow label="Opening valuation">{native(summary.openingValuationNativeRaw, unit)}</InfoRow><InfoRow label="Effective opening valuation">{native(summary.effectiveOpeningValuationNativeRaw, unit)}</InfoRow><InfoRow label="Effective upper valuation">{native(summary.effectiveUpperValuationNativeRaw, unit)}</InfoRow><InfoRow label="Execution fee">{percent(summary.executionFeeBps, 2)}</InfoRow><InfoRow label="Fee destination">{summary.feeMode === 'creator' ? 'Creator proceeds' : 'Liquidity and burn'}</InfoRow><p className="field-hint">The initial supply remains locked in the market and its liquidity position. The launch sends no {unit} as liquidity principal. Network gas is still required. The range and execution fee become fixed.</p></>
      : review.action === 'approve' ? <><InfoRow label="Token amount allowed">{tokens(summary.allowanceRaw, symbol)}</InfoRow><InfoRow label="Spender"><DisplayAddress value={summary.spender} full /></InfoRow><p className="field-hint">This allowance permits the market to transfer up to this token amount. Selling requires a separate transaction review and approval.</p></>
        : review.action === 'claim' ? <><InfoRow label="Available proceeds">{native(summary.claimableNativeRaw, unit)}</InfoRow><InfoRow label="Payout recipient"><DisplayAddress value={summary.recipient} full /></InfoRow><p className="field-hint">Transfers the available {unit} proceeds to the recipient shown.</p></>
          : review.action === 'maintain' ? <>
            <InfoRow label="Max native spending budget">{native(summary.maximumNativeBudgetRaw, unit)}</InfoRow>
            <InfoRow label="Max token conversion budget">{tokens(summary.maximumTokenBudgetRaw, symbol)}</InfoRow>
            <InfoRow label="Pending LP fees (native)">{native(summary.pendingLpNativeRaw, unit)}</InfoRow>
            <InfoRow label="Pending LP fees (token)">{tokens(summary.pendingLpTokenRaw, symbol)}</InfoRow>
            <InfoRow label="Pending liquidity budget (native)">{native(summary.pendingLiquidityNativeRaw, unit)}</InfoRow>
            <InfoRow label="Pending liquidity budget (token)">{tokens(summary.pendingLiquidityTokenRaw, symbol)}</InfoRow>
            <InfoRow label="Pending burn budget (native)">{native(summary.pendingBurnNativeRaw, unit)}</InfoRow>
            <InfoRow label="Execution fee">0%</InfoRow>
            <p className="field-hint">Converts LP token fees, allocates revenue, and processes liquidity and burn budgets within a 5-minute price window, max 1% slippage, and a 60-second review deadline. Network gas is additional.</p>
          </>
            : <><InfoRow label={review.action === 'buy' ? `Total ${unit} input` : 'Token input'}>{review.action === 'buy' ? native(summary.amountRaw, unit) : tokens(summary.amountRaw, symbol)}</InfoRow>
              {review.action === 'sell' && <InfoRow label="Quoted proceeds before execution fee">{native(summary.grossNativeRaw, unit)}</InfoRow>}
              <InfoRow label="Quoted execution fee">{native(summary.quotedExecutionFeeRaw, unit)} ({percent(summary.executionFeeBps, 2)})</InfoRow>
              <InfoRow label="Quoted receive">{review.action === 'buy' ? tokens(summary.quotedReceiveRaw, symbol) : native(summary.quotedReceiveRaw, unit)}</InfoRow>
              <InfoRow label="Minimum receive">{review.action === 'buy' ? tokens(summary.minimumReceiveRaw, symbol) : native(summary.minimumReceiveRaw, unit)}</InfoRow>
              <InfoRow label="Total pool swap fee">{percent(summary.totalDexFeePips, 4)}</InfoRow><InfoRow label="Pool LP fee">{percent(summary.lpFeePips, 4)}</InfoRow><InfoRow label="Directional pool protocol fee">{percent(summary.protocolFeePips, 4)}</InfoRow>
              <InfoRow label="Asset recipient"><DisplayAddress value={summary.recipient} full /></InfoRow><p className="field-hint">{review.action === 'buy' ? `The execution fee comes from your ${unit} input.` : `The execution fee is deducted from gross ${unit} proceeds.`} The total pool fee includes the LP and directional protocol fees and is already included in the quote. Network gas is additional. Actual output may change within your reviewed minimum; a trade that cannot use the full input reverts.</p></>}
  </div>;
}

export function TokenExecutionResult({ state, symbol, canApprove, onApprove, onDiscard, onReceipt }: { state: TokenExecutionState; symbol: string; canApprove: boolean; onApprove(): void; onDiscard(): void; onReceipt(): void }) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { if (state.phase !== 'review') return; setClock(Date.now()); const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [state.phase, state.review?.id]);
  const expired = Boolean(state.review && Date.parse(state.review.expiresAt) <= clock), href = state.hash && state.review ? nftExplorerHref(state.review.chainId, state.hash, 'tx') : null;
  return <>
    {state.review && <div className="nft-launch-review section-gap"><div className="section-header"><h3>{actions[state.review.action]}</h3><Badge>Transaction review</Badge></div><TokenExecutionSummary review={state.review} symbol={symbol} />
      <InfoRow label="Network">{nftNetworkLabel(state.review.network)}</InfoRow><InfoRow label="Signing wallet"><DisplayAddress value={state.review.from} full /></InfoRow><InfoRow label="Wallet transaction recipient"><DisplayAddress value={state.review.to} full /></InfoRow><InfoRow label="Wallet transaction value">{native(state.review.value, nativeAssetLabel(state.review.network))}</InfoRow><InfoRow label="Gas estimate">{state.review.simulation.gasEstimate} gas units</InfoRow><p className="field-hint">Simulated at block {state.review.simulation.blockNumber}. Your wallet shows the final network gas cost.</p>
      <details className="token-transaction-data"><summary>Transaction data</summary><code>{state.review.data}</code></details>
      <InfoRow label="Review ID"><span className="indexed-hash">{state.review.id}</span></InfoRow>
      {state.phase === 'review' && <><p className="field-hint">{expired ? 'This review expired. Prepare a new review.' : `Review expires at ${new Date(state.review.expiresAt).toLocaleTimeString()}.`}</p><div className="button-row section-gap"><Button disabled={!canApprove || expired} onClick={onApprove}>Approve in wallet</Button><Button variant="ghost" onClick={onDiscard}>Discard review</Button></div></>}
    </div>}
    {state.message && <div className="section-gap" role="status">{['error', 'rejected', 'reverted'].includes(state.phase) ? <ErrorState message={state.message} /> : <p className="data-notice">{state.message}</p>}</div>}
    {state.storageWarning && <ErrorState message={state.storageWarning} />}
    {state.hash && <div className="section-gap"><InfoRow label="Transaction hash">{href ? <a className="text-link indexed-hash" href={href} target="_blank" rel="noopener noreferrer">{state.hash}</a> : <span className="indexed-hash">{state.hash}</span>}</InfoRow><Button variant="secondary" loading={state.phase === 'confirming'} disabled={busy(state) && state.phase !== 'confirming'} onClick={onReceipt}>Check receipt</Button>
      {state.review?.action === 'launch' && state.receipt?.status === 'confirmed' && state.receipt.createdMarket && <div className="button-row section-gap"><ButtonLink href={`/tokens/${state.receipt.createdMarket.market}`} variant="secondary">View your token market</ButtonLink></div>}
    </div>}
  </>;
}

export function TokenExecutionAccessGuidance({ access, status, onRefresh, walletAction }: { access: ReturnType<typeof tokenExecutionAccess>; status: TokenExecutionStatus | null; onRefresh(): void; walletAction?: React.ReactNode }) {
  if (access === 'checking') return <Loading rows={1} />;
  if (access === 'unavailable') return <><p className="data-notice">Token transactions are unavailable right now. You can review market terms or save a draft.</p><Button variant="secondary" onClick={onRefresh}>Check availability</Button></>;
  if (access === 'pricing') return <p className="data-notice">This draft keeps its planned ZRO valuation. Create a Base Sepolia copy and enter a test ETH valuation before launching.</p>;
  if (access === 'wallet-unavailable') return <p className="data-notice">Wallet connection is unavailable. You can keep browsing and save a draft.</p>;
  if (access !== 'ready') return <div className="button-row section-gap">{walletAction ?? <WalletButton />}<p className="field-hint">{access === 'network' ? `Select ${nftNetworkLabel(status?.enabled ? status.network : null)} in your wallet, then prepare a new review.` : access === 'sign-in' ? 'Sign in to review a transaction.' : 'Connect a linked wallet to continue.'}</p></div>;
  return null;
}
function SavedTransactions({ execution }: { execution: ReturnType<typeof useTokenExecution> }) {
  if (!execution.saved.length) return null;
  return <div className="section-gap"><h3>Pending transactions on this device</h3><p className="field-hint">Checking a receipt never requests another wallet submission.</p>{execution.saved.map(item => <div className="nft-recovery-row" key={item.reviewId}><div><strong>{actions[item.action]}</strong><span className="indexed-hash">{item.hash}</span><span className="indexed-subline">Review ID: {item.reviewId}</span></div><Button variant="secondary" disabled={execution.access !== 'ready' || busy(execution.state)} onClick={() => void execution.controller.recover(item.reviewId, item.hash)}>Check transaction</Button></div>)}</div>;
}

export function TokenTradePanel({ market, context, onRefresh }: { market: IndexedTokenMarket; context: IndexedTokenContext; onRefresh(): void }) {
  const [side, setSide] = useState('buy'), [amount, setAmount] = useState(''), [slippage, setSlippage] = useState(100), [maxNativeBudget, setMaxNativeBudget] = useState('1'), [maxTokenBudget, setMaxTokenBudget] = useState('10000000'), [ack, setAck] = useState(false);
  const execution = useTokenExecution(JSON.stringify([side, amount, slippage, maxNativeBudget, maxTokenBudget]), { market, snapshot: context }), locked = busy(execution.state) || unresolved(execution.state);
  const unit = nativeAssetLabel(execution.status?.enabled ? execution.status.network : context.network);
  useEffect(() => setAck(false), [execution.key]);
  const validAmount = (() => {
    if (side === 'claim') return true;
    if (side === 'maintain') {
      try {
        const nat = parseAssetAmount(maxNativeBudget, 18), tok = parseAssetAmount(maxTokenBudget, 8);
        return nat > 0n && nat < 2n ** 127n && tok > 0n && tok < 2n ** 127n;
      } catch { return false; }
    }
    try { const raw = parseAssetAmount(amount, side === 'buy' ? 18 : 8); return raw > 0n && raw < 2n ** 127n; } catch { return false; }
  })();
  const changed = (callback: () => void) => { execution.controller.invalidate('Trade details changed. Prepare a new review.'); setAck(false); callback(); };
  function prepare(action: 'buy' | 'sell' | 'approve' | 'claim' | 'maintain') {
    if (!ack || !validAmount || execution.access !== 'ready' || !execution.status?.enabled || !execution.wallet.account) return;
    const common = { from: execution.wallet.account.address as Address, testEthAcknowledged: true as const, expectedChainId: execution.status.network.chainId, expectedDeploymentId: execution.status.deploymentId, market: market.market as Address };
    const input: TokenTransactionIntent = action === 'claim' ? { ...common, action }
      : action === 'maintain' ? { ...common, action, maximumNativeBudget: maxNativeBudget.trim(), maximumTokenBudget: maxTokenBudget.trim() }
        : action === 'approve' ? { ...common, action, amount } : { ...common, action, amount, slippageBps: slippage };
    void execution.controller.prepare(input);
  }
  return <section className="panel token-execution-panel section-gap" aria-label="Token trading"><div className="section-header"><div><h2>Trade {market.symbol}</h2><p>Get a current review before approving a network transaction.</p></div><Badge tone="amber">{unit === 'test ETH' ? 'Test ETH' : unit}</Badge></div><TokenExecutionAccessGuidance access={execution.access} status={execution.status} onRefresh={execution.refresh} />
    {execution.access === 'ready' && <><Tabs tabs={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }, { value: 'claim', label: 'Claim proceeds' }, { value: 'maintain', label: 'Process fees' }]} active={side} onChange={value => { if (!locked) changed(() => setSide(value)); }} />
      {side !== 'claim' && side !== 'maintain' && <div className="field-grid section-gap"><Field label={side === 'buy' ? `${unit} to spend` : `${market.symbol} amount`} hint={side === 'buy' ? 'Up to 18 decimals. The execution fee comes from this input.' : 'Up to 8 decimals. Token approval and sale are separate transactions.'}><input value={amount} disabled={locked} maxLength={100} inputMode="decimal" onChange={event => changed(() => setAmount(event.target.value))} placeholder="0.0" /></Field><Field label="Slippage tolerance" hint="Sets the minimum amount you accept in the review."><select value={slippage} disabled={locked} onChange={event => changed(() => setSlippage(Number(event.target.value)))}><option value={50}>0.5%</option><option value={100}>1%</option><option value={200}>2%</option><option value={500}>5%</option></select></Field></div>}
      {side === 'maintain' && <div className="field-grid section-gap"><Field label="Max native spending budget" hint={`Caps ${unit} spent on liquidity and burns during this pass.`}><input value={maxNativeBudget} disabled={locked} maxLength={100} inputMode="decimal" onChange={event => changed(() => setMaxNativeBudget(event.target.value))} placeholder="1" /></Field><Field label={`Max ${market.symbol} conversion budget`} hint="Caps accumulated LP token fees converted (8 decimals). Requires 5-minute TWAP window and minimum budget."><input value={maxTokenBudget} disabled={locked} maxLength={100} inputMode="decimal" onChange={event => changed(() => setMaxTokenBudget(event.target.value))} placeholder="10000000" /></Field></div>}
      <label className="checkbox-field section-gap"><input type="checkbox" checked={ack} disabled={locked} onChange={event => { if (!event.target.checked) execution.controller.invalidate('Test ETH acknowledgement removed.'); setAck(event.target.checked); }} /><span>I understand this uses {nftNetworkLabel(execution.status?.enabled ? execution.status.network : null)}. I will review fees, the recipient and network gas before approving.</span></label>
      <div className="button-row"><Button disabled={!ack || !validAmount || locked} onClick={() => prepare(side as 'buy' | 'sell' | 'claim' | 'maintain')}>{side === 'buy' ? 'Review buy' : side === 'sell' ? 'Review sale' : side === 'maintain' ? 'Review fee processing' : 'Review claim'}</Button>{side === 'sell' && <Button variant="secondary" disabled={!ack || !validAmount || locked} onClick={() => prepare('approve')}>Review token approval</Button>}</div>
    </>}
    <TokenExecutionResult state={execution.state} symbol={market.symbol} canApprove={execution.access === 'ready' && ack} onApprove={() => void execution.controller.approve()} onDiscard={() => execution.controller.invalidate('Review discarded.')} onReceipt={() => void execution.controller.refreshReceipt()} />
    {execution.state.phase === 'confirmed' && <Button variant="secondary" onClick={onRefresh}>Refresh market terms</Button>}
    <SavedTransactions execution={execution} /><SafetyNote>Test-network assets have no monetary value. Each approval, trade and claim is a separate transaction.</SafetyNote>
  </section>;
}

export function TokenLaunchReview({ draft, termsReviewed = true }: { draft: TokenDraft; termsReviewed?: boolean }) {
  const execution = useTokenExecution(JSON.stringify([draft, termsReviewed]), { draft }), [ack, setAck] = useState(false);
  useEffect(() => setAck(false), [execution.key]);
  const validValuation = (() => { try { return parseAssetAmount(draft.openingValuation, 18) > 0n; } catch { return false; } })();
  return <section className="panel token-execution-panel section-gap" aria-label="Token launch transaction"><div className="section-header"><h2>Launch your token</h2><Badge tone="amber">Test network</Badge></div><TokenExecutionAccessGuidance access={execution.access} status={execution.status} onRefresh={execution.refresh} />
    {execution.access === 'ready' && <>{!termsReviewed && <p className="data-notice">Review and confirm the planned terms above before preparing a launch transaction.</p>}{!validValuation && <p className="data-notice">Enter a positive opening valuation before preparing a launch review.</p>}<label className="checkbox-field section-gap"><input type="checkbox" checked={ack} disabled={!termsReviewed || busy(execution.state) || unresolved(execution.state)} onChange={event => { if (!event.target.checked) execution.controller.invalidate('Launch acknowledgement removed.'); setAck(event.target.checked); }} /><span>I have reviewed these launch terms. Launching creates a token and permanently locks its fee, range and supply terms.</span></label><Button disabled={!termsReviewed || !ack || !validValuation || busy(execution.state) || unresolved(execution.state)} onClick={() => {
      if (!execution.status?.enabled || !execution.wallet.account || !termsReviewed || !ack || !validValuation) return;
      void execution.controller.prepare({
        action: 'launch', from: execution.wallet.account.address as Address, testEthAcknowledged: true, expectedChainId: execution.status.network.chainId, expectedDeploymentId: execution.status.deploymentId,
        draft: { pricingNetwork: draft.pricingNetwork === 'base-sepolia' ? 'base-sepolia' : 'zero', name: draft.name, symbol: draft.symbol, openingValuation: draft.openingValuation, executionFeeBps: Math.round(draft.fee * 100), feeMode: draft.mode }
      });
    }}>Review launch transaction</Button></>}
    <TokenExecutionResult state={execution.state} symbol={draft.symbol} canApprove={execution.access === 'ready' && termsReviewed && ack && validValuation} onApprove={() => void execution.controller.approve()} onDiscard={() => execution.controller.invalidate('Review discarded.')} onReceipt={() => void execution.controller.refreshReceipt()} /><SavedTransactions execution={execution} />
  </section>;
}
