import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  Copy,
  Gift,
  Heart,
  Loader2,
  RefreshCw,
  Repeat2,
  Search,
  Sparkles,
  Trophy,
  Wallet,
} from 'lucide-react';
import {
  computeAirdropUnlockSchedule,
  decodeAirdropScheduleOfResult,
  encodeAirdropInitiateClaimData,
  encodeAirdropScheduleOfData,
  encodeAirdropWithdrawData,
  formatIndexedAmount,
} from '@oneshot/evm';
import Link from './navigation';
import { OneshotLogo } from './brand';
import { ThemePicker } from './theme-picker';
import { useGenesisAuth } from './genesis-auth';
import { Badge, Button, ErrorState } from './ui';
import { AIRDROP_BOX_TIERS, AirdropVaultBox } from './airdrop-vault-box';
import {
  AIRDROP_ECOSYSTEM_POOL,
  AIRDROP_GENERAL_POOL,
  AIRDROP_LIQUIDITY_POOL,
  AIRDROP_MAX_POSTS,
  AIRDROP_TEAM_POOL,
  AIRDROP_TOP500_BRACKETS,
  AIRDROP_TOP500_POOL,
  AIRDROP_TOTAL_POOL,
  AIRDROP_TOTAL_SUPPLY,
  AIRDROP_TREASURY_POOL,
  computeRequiredProgressCount,
  type AirdropEligibilityResponse,
  type AirdropLeaderboardEntry,
  type AirdropMeResponse,
  type AirdropPublicCampaign,
} from '../lib/airdrop-schema';
import {
  airdropAccountRequest,
  checkWalletEligibility,
  clearAirdropReferral,
  createAirdropEnrollment,
  loadAirdropCampaign,
  loadAirdropLeaderboard,
  readAirdropReferral,
  requestAirdropWalletChallenge,
} from '../lib/client-airdrop-api';
import '../app/airdrop.css';

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

type OnChainSchedule = {
  totalAmount: bigint;
  withdrawn: bigint;
  claimedAt: number;
  lockEndsAt: number;
  fullyUnlockedAt: number;
  unlockedDays: number;
  unlockedAmount: bigint;
  withdrawable: bigint;
};

function sessionStorageIfAvailable() {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function formatWalletProviderError(reason: unknown, fallback: string): string {
  const code =
    typeof reason === 'object' && reason !== null && 'code' in reason
      ? (reason as { code?: unknown }).code
      : undefined;
  if (code === 4001) return 'Request cancelled in your wallet.';
  if (code === 4902) return 'Add and switch to the required network in your wallet, then try again.';
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

export function AirdropPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const xLoginFailed = searchParams.get('x_login') === 'failed';

  useEffect(() => {
    const previous = document.title;
    document.title = 'oneshot | Token Airdrop';
    return () => {
      document.title = previous;
    };
  }, []);

  const auth = useGenesisAuth();
  const authRef = useRef(auth);
  authRef.current = auth;

  const identity =
    auth.authenticated && auth.userId
      ? `${auth.userId}:${auth.xAccount?.id || ''}:${auth.sessionId}`
      : null;
  const currentScope = useRef(identity);
  currentScope.current = identity;

  const [campaign, setCampaign] = useState<AirdropPublicCampaign | null>(null);
  const [campaignLoading, setCampaignLoading] = useState(true);
  const [campaignError, setCampaignError] = useState<string | null>(null);

  const [account, setAccount] = useState<{ scope: string; data: AirdropMeResponse } | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null);

  const [walletInput, setWalletInput] = useState('');
  const [eligibility, setEligibility] = useState<AirdropEligibilityResponse | null>(null);
  const [eligibilityError, setEligibilityError] = useState<string | null>(null);
  const [checkingWallet, setCheckingWallet] = useState<'input' | 'connect' | null>(null);
  const [peekTrigger, setPeekTrigger] = useState(0);

  const [postUrl, setPostUrl] = useState('');
  const [quotePostUrl, setQuotePostUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [referral, setReferral] = useState(() =>
    readAirdropReferral(window.location.search, sessionStorageIfAvailable()),
  );

  const [leaderboard, setLeaderboard] = useState<{ totalRanked: number; entries: AirdropLeaderboardEntry[] } | null>(
    null,
  );
  const [leaderboardOffset, setLeaderboardOffset] = useState(0);
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);

  const [onChainSchedule, setOnChainSchedule] = useState<OnChainSchedule | null>(null);
  const [claimingTx, setClaimingTx] = useState<'initiate' | 'withdraw' | null>(null);
  const [claimTxHash, setClaimTxHash] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [checkingClaimState, setCheckingClaimState] = useState(false);

  const mounted = useRef(true);
  const campaignReq = useRef(0);
  const accountReq = useRef(0);
  const leaderboardReq = useRef(0);
  const claimReq = useRef(0);
  const enrollment = useRef(createAirdropEnrollment());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      campaignReq.current++;
      accountReq.current++;
      leaderboardReq.current++;
      claimReq.current++;
    };
  }, []);

  const loadCampaign = useCallback(async () => {
    const req = ++campaignReq.current;
    setCampaignLoading(true);
    setCampaignError(null);
    try {
      const data = await loadAirdropCampaign();
      if (mounted.current && campaignReq.current === req) {
        setCampaign(data);
        return data;
      }
    } catch (reason) {
      if (mounted.current && campaignReq.current === req) {
        setCampaignError((reason as Error).message);
      }
    } finally {
      if (mounted.current && campaignReq.current === req) setCampaignLoading(false);
    }
    return null;
  }, []);

  const loadLeaderboard = useCallback(async (offset: number) => {
    const req = ++leaderboardReq.current;
    setLeaderboardLoading(true);
    setLeaderboardError(null);
    try {
      const data = await loadAirdropLeaderboard(offset, 25);
      if (mounted.current && leaderboardReq.current === req) {
        setLeaderboard(data);
      }
    } catch (reason) {
      if (mounted.current && leaderboardReq.current === req) {
        setLeaderboardError(
          reason instanceof Error && reason.message
            ? reason.message
            : 'Leaderboard rankings could not be loaded right now.',
        );
      }
    } finally {
      if (mounted.current && leaderboardReq.current === req) {
        setLeaderboardLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadCampaign();
  }, [loadCampaign]);

  useEffect(() => {
    void loadLeaderboard(leaderboardOffset);
  }, [leaderboardOffset, loadLeaderboard]);

  const refreshAccount = useCallback(async (signal?: AbortSignal) => {
    const scope = currentScope.current;
    if (!scope) return null;
    const req = ++accountReq.current;
    setAccountLoading(true);
    setAccountError(null);
    try {
      const data = await airdropAccountRequest('me', {
        sessionId: authRef.current.sessionId,
        scope: () => currentScope.current,
        signal,
      });
      if (mounted.current && currentScope.current === scope && accountReq.current === req) {
        setAccount({ scope, data });
        return data;
      }
    } catch (reason) {
      if (mounted.current && !signal?.aborted && currentScope.current === scope && accountReq.current === req) {
        setAccountError((reason as Error).message);
      }
    } finally {
      if (mounted.current && currentScope.current === scope && accountReq.current === req) {
        setAccountLoading(false);
      }
    }
    return null;
  }, []);

  useEffect(() => {
    setAccount(null);
    setAccountError(null);
    setEnrollmentError(null);
    setOnChainSchedule(null);
    setClaimTxHash(null);
    setClaimError(null);
    setBusy(null);
    setNotice('');
    accountReq.current++;
    claimReq.current++;
    const controller = new AbortController();
    if (identity) void refreshAccount(controller.signal);
    else setAccountLoading(false);
    return () => controller.abort();
  }, [identity, refreshAccount]);

  const enrollParticipant = useCallback(
    async (retry = false) => {
      const scope = identity;
      const result = await enrollment.current.start(
        {
          scope,
          currentScope: () => (mounted.current ? currentScope.current : null),
          authReady: auth.authenticated && !auth.isLoading,
          verifiedProfileId: auth.xAccount?.id || null,
          campaign,
          campaignLoading,
          campaignError: Boolean(campaignError),
          account,
          accountLoading,
          accountError: Boolean(accountError),
          busy: Boolean(busy),
          referral,
          sessionId: auth.sessionId,
          onStart: () => {
            accountReq.current++;
            setBusy('enroll');
            setEnrollmentError(null);
          },
        },
        retry,
      );
      if (result.state === 'skipped' || !mounted.current || currentScope.current !== scope) return;
      if (result.state === 'saved') {
        accountReq.current++;
        setAccount({ scope: result.scope, data: result.data });
        setAccountLoading(false);
        setEnrollmentError(null);
        clearAirdropReferral(sessionStorageIfAvailable());
        setReferral(null);
      } else if (result.state === 'failed') {
        setEnrollmentError('Your X account is connected, but your airdrop box could not be created. Please try again.');
      }
      setBusy(prev => (prev === 'enroll' ? null : prev));
    },
    [
      identity,
      auth.authenticated,
      auth.isLoading,
      auth.xAccount?.id,
      auth.sessionId,
      campaign,
      campaignLoading,
      campaignError,
      account,
      accountLoading,
      accountError,
      busy,
      referral,
    ],
  );

  useEffect(() => {
    void enrollParticipant(false);
  }, [enrollParticipant]);

  function removeInvitation() {
    clearAirdropReferral(sessionStorageIfAvailable());
    setReferral(null);
    setSearchParams(
      params => {
        params.delete('ref');
        return params;
      },
      { replace: true },
    );
  }

  const me = account?.scope === identity ? account.data : null;
  const participant = me?.participant || null;
  const tokenSymbol = campaign?.tokenSymbol || 'ONE';

  const readOnChainClaimState = useCallback(async () => {
    const distributor = campaign?.distributorAddress;
    const targetChain = campaign?.chainId;
    const wallet = participant?.wallet;
    if (!campaign?.claimingOpen || !distributor || !targetChain || !wallet) {
      setOnChainSchedule(null);
      return;
    }
    const provider = (window as { ethereum?: EthereumProvider }).ethereum;
    if (!provider || typeof provider.request !== 'function') return;
    const req = ++claimReq.current;
    const reqScope = currentScope.current;
    setCheckingClaimState(true);
    try {
      const chainHex = await provider.request({ method: 'eth_chainId' });
      if (typeof chainHex === 'string' && parseInt(chainHex, 16) !== targetChain) return;
      const callData = encodeAirdropScheduleOfData(wallet as `0x${string}`);
      const rawResult = await provider.request({
        method: 'eth_call',
        params: [{ to: distributor, data: callData }, 'latest'],
      });
      if (
        mounted.current &&
        claimReq.current === req &&
        currentScope.current === reqScope &&
        typeof rawResult === 'string' &&
        rawResult.startsWith('0x')
      ) {
        setOnChainSchedule(decodeAirdropScheduleOfResult(rawResult as `0x${string}`));
      }
    } catch {
      /* Wallet RPC may be unavailable until user switches network */
    } finally {
      if (mounted.current && claimReq.current === req) setCheckingClaimState(false);
    }
  }, [campaign?.claimingOpen, campaign?.distributorAddress, campaign?.chainId, participant?.wallet]);

  useEffect(() => {
    setOnChainSchedule(null);
    setClaimTxHash(null);
    setClaimError(null);
    void readOnChainClaimState();
  }, [readOnChainClaimState]);

  async function inspectAddress(addressToCheck: string, source: 'input' | 'connect') {
    const clean = addressToCheck.trim();
    if (!/^0x[\da-fA-F]{40}$/.test(clean)) {
      setEligibilityError('Enter a valid wallet address (0x...).');
      return;
    }
    setCheckingWallet(source);
    setEligibilityError(null);
    try {
      const result = await checkWalletEligibility(clean);
      if (!mounted.current) return;
      setEligibility(result);
      if (!participant?.wallet || participant.wallet.toLowerCase() === result.wallet.toLowerCase()) {
        setPeekTrigger(prev => prev + 1);
      }
    } catch (reason) {
      if (mounted.current) setEligibilityError((reason as Error).message);
    } finally {
      if (mounted.current) setCheckingWallet(null);
    }
  }

  async function connectAndPreviewWallet() {
    setEligibilityError(null);
    const provider = (window as { ethereum?: EthereumProvider }).ethereum;
    if (!provider || typeof provider.request !== 'function') {
      setEligibilityError('Open a browser wallet or paste your wallet address to check eligibility.');
      return;
    }
    setCheckingWallet('connect');
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const raw = Array.isArray(accounts) ? accounts[0] : null;
      if (typeof raw !== 'string' || !/^0x[\da-fA-F]{40}$/.test(raw)) {
        throw new Error('No wallet account was returned.');
      }
      setWalletInput(raw);
      await inspectAddress(raw, 'connect');
    } catch (reason) {
      if (mounted.current) {
        setEligibilityError(formatWalletProviderError(reason, 'Could not read wallet address.'));
        setCheckingWallet(null);
      }
    }
  }

  async function bindParticipantWallet() {
    if (busy || !isOpen || campaign?.merkleRoot) return;
    setAccountError(null);
    setNotice('');
    const provider = (window as { ethereum?: EthereumProvider }).ethereum;
    if (!provider || typeof provider.request !== 'function') {
      setAccountError('Open a browser wallet extension to sign and link your wallet.');
      return;
    }
    setBusy('wallet');
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const raw = Array.isArray(accounts) ? accounts[0] : null;
      if (typeof raw !== 'string' || !/^0x[\da-fA-F]{40}$/.test(raw)) {
        throw new Error('Unlock a wallet account and try again.');
      }
      const selected = raw.toLowerCase();
      const challenge = await requestAirdropWalletChallenge({
        wallet: selected,
        sessionId: authRef.current.sessionId,
        scope: () => currentScope.current,
      });
      const signature = await provider.request({ method: 'personal_sign', params: [challenge.message, selected] });
      if (typeof signature !== 'string' || !/^0x[\da-fA-F]{130}$/.test(signature)) {
        throw new Error('Unexpected signature format from wallet.');
      }
      const updated = await airdropAccountRequest('wallet', {
        body: { wallet: challenge.wallet, signature, expectedRevision: challenge.expectedRevision },
        sessionId: authRef.current.sessionId,
        scope: () => currentScope.current,
      });
      if (mounted.current && currentScope.current === identity) {
        setAccount({ scope: identity!, data: updated });
        setPeekTrigger(prev => prev + 1);
        setNotice('Wallet linked. Revealing your airdrop box allocation before locking for missions.');
        void loadCampaign();
      }
    } catch (reason) {
      if (mounted.current) {
        setAccountError(formatWalletProviderError(reason, 'Could not link wallet.'));
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function runAction(name: string, path: string, body: unknown, successNotice?: string) {
    if (!identity || busy) return;
    setBusy(name);
    setAccountError(null);
    setNotice('');
    try {
      const updated = await airdropAccountRequest(path, {
        body,
        sessionId: authRef.current.sessionId,
        scope: () => currentScope.current,
      });
      if (mounted.current && currentScope.current === identity) {
        setAccount({ scope: identity, data: updated });
        if (name === 'post') setPostUrl('');
        if (name === 'repost') setQuotePostUrl('');
        if (successNotice) setNotice(successNotice);
        void loadCampaign();
        void loadLeaderboard(leaderboardOffset);
      }
    } catch (reason) {
      if (mounted.current) setAccountError((reason as Error).message);
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function submitOnChainClaim(actionType: 'initiate' | 'withdraw') {
    if (!campaign?.distributorAddress || !campaign.chainId || !participant?.wallet) return;
    if (actionType === 'initiate' && !participant.claimProof) {
      setClaimError('Claim proof is not available for this wallet yet.');
      return;
    }
    if (actionType === 'initiate' && campaign.claimDeadline && Date.now() > Date.parse(campaign.claimDeadline)) {
      setClaimError('The claim window has closed.');
      return;
    }
    const provider = (window as { ethereum?: EthereumProvider }).ethereum;
    if (!provider || typeof provider.request !== 'function') {
      setClaimError('Connect your linked wallet to send this transaction.');
      return;
    }
    setClaimingTx(actionType);
    setClaimError(null);
    setClaimTxHash(null);
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${campaign.chainId.toString(16)}` }],
      });
      const verifiedChainHex = await provider.request({ method: 'eth_chainId' });
      if (typeof verifiedChainHex !== 'string' || parseInt(verifiedChainHex, 16) !== campaign.chainId) {
        throw new Error(`Switch your wallet network to chain ${campaign.chainId} before sending.`);
      }
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const active = (Array.isArray(accounts) ? accounts[0] : '') as string;
      if (active.toLowerCase() !== participant.wallet.toLowerCase()) {
        throw new Error(`Switch your wallet account to ${participant.wallet} to continue.`);
      }
      const data =
        actionType === 'initiate'
          ? encodeAirdropInitiateClaimData(
              participant.claimProof!.amountRaw,
              participant.claimProof!.proof as `0x${string}`[],
            )
          : encodeAirdropWithdrawData(participant.wallet as `0x${string}`);
      const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: participant.wallet, to: campaign.distributorAddress, data }],
      });
      if (typeof hash === 'string') {
        setClaimTxHash(hash);
        setNotice(
          actionType === 'initiate'
            ? 'Claim submitted. Waiting for confirmation.'
            : 'Withdrawal transaction submitted to your wallet.',
        );
      }
      for (const delayMs of [3500, 8000, 14000, 22000]) {
        window.setTimeout(() => {
          if (mounted.current) void readOnChainClaimState();
        }, delayMs);
      }
    } catch (reason) {
      setClaimError(formatWalletProviderError(reason, 'Transaction could not be completed.'));
    } finally {
      if (mounted.current) setClaimingTx(null);
    }
  }

  async function copyText(text: string, msg: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(msg);
    } catch {
      setNotice('Copy the link from the text box.');
    }
  }

  const displayedTier = participant?.wallet ? participant.tier : eligibility?.tier ?? null;
  const displayedBaseTokens = participant?.wallet
    ? participant.baseGeneralTokens
    : eligibility?.baseGeneralTokens ?? 0;
  const displayedBonusTokens = participant?.engagementBonusTokens ?? 0;
  const displayedTop500 = participant?.projectedTop500Tokens ?? 0;
  const requiredCompleted = participant ? computeRequiredProgressCount(participant) : 0;
  const isOpen = campaign?.state === 'open';
  const hasClaimed = Boolean(onChainSchedule && onChainSchedule.claimedAt > 0);
  const walletLockedForClaims = Boolean(campaign?.merkleRoot);

  const postIntent = `https://x.com/intent/post?text=${encodeURIComponent(
    `Exploring @${campaign?.projectHandle || 'oneshot'} — LayerZero airdrop & token launchpad.${me?.referralUrl ? `\n${me.referralUrl}` : ''}`,
  )}`;
  const announcementUrl = campaign?.announcementPostId
    ? `https://x.com/i/web/status/${campaign.announcementPostId}`
    : campaign?.projectHandle
      ? `https://x.com/${campaign.projectHandle}`
      : 'https://x.com';

  const unlockSchedule =
    hasClaimed && onChainSchedule
      ? computeAirdropUnlockSchedule({
          totalAmountRaw: onChainSchedule.totalAmount,
          claimedAtSec: onChainSchedule.claimedAt,
          withdrawnRaw: onChainSchedule.withdrawn,
          nowSec: Math.floor(Date.now() / 1000),
        })
      : null;

  return (
    <div className="airdrop-page">
      <a className="skip-link" href="#airdrop-missions">
        Skip to missions
      </a>

      <header className="airdrop-header">
        <Link href="/" className="brand" aria-label="oneshot home">
          <OneshotLogo />
        </Link>
        <nav aria-label="Airdrop navigation">
          <a href="#airdrop-missions" className="airdrop-header-anchor">
            Missions
          </a>
          <a href="#airdrop-leaderboard" className="airdrop-header-anchor">
            Top 500
          </a>
          <a href="#airdrop-distribution" className="airdrop-header-anchor">
            Distribution
          </a>
          <Link href="/">
            Back to app <ArrowUpRight size={14} />
          </Link>
          <ThemePicker />
          {auth.authenticated && (
            <button className="airdrop-signout" onClick={() => void auth.disconnect()}>
              Sign out
            </button>
          )}
        </nav>
      </header>

      <main>
        <section className="airdrop-hero">
          <div className="airdrop-hero-copy">
            <h1>
              Unlock your <em>{tokenSymbol}</em> airdrop box.
            </h1>
            <p>
              <strong>51% of total supply</strong> ({AIRDROP_TOTAL_POOL.toLocaleString()} {tokenSymbol}) is dedicated to
              LayerZero users and our Top 500 community leaderboard. Check your wallet to reveal your box, then finish
              four quick missions to unlock it.
            </p>

            <div className="airdrop-checker">
              <div className="airdrop-checker-row">
                <input
                  aria-label="Check wallet eligibility"
                  placeholder="Paste wallet address (0x...) or connect wallet"
                  value={walletInput}
                  onChange={e => setWalletInput(e.target.value)}
                  maxLength={42}
                />
                <Button
                  variant="secondary"
                  loading={checkingWallet === 'input'}
                  disabled={checkingWallet !== null}
                  onClick={() => void inspectAddress(walletInput, 'input')}
                >
                  <Search size={14} /> Check wallet
                </Button>
                <Button
                  loading={checkingWallet === 'connect'}
                  disabled={checkingWallet !== null}
                  onClick={() => void connectAndPreviewWallet()}
                >
                  <Wallet size={14} /> Connect &amp; reveal box
                </Button>
              </div>
              {eligibilityError && <ErrorState message={eligibilityError} />}
              {eligibility && (
                <div className="airdrop-checker-result" role="status">
                  {eligibility.tier === 'lz_winner' ? (
                    <>
                      <strong>LayerZero Airdrop Winner (100% Share):</strong>{' '}
                      {eligibility.baseGeneralTokens.toLocaleString()} {tokenSymbol} base (up to{' '}
                      {eligibility.maxGeneralTokens.toLocaleString()} {tokenSymbol} with +50% engagement bonus) + Top 500
                      leaderboard eligibility.
                    </>
                  ) : eligibility.tier === 'lz_user_5tx' ? (
                    <>
                      <strong>LayerZero User · 5+ Transactions (50% Share):</strong>{' '}
                      {eligibility.baseGeneralTokens.toLocaleString()} {tokenSymbol} base (up to{' '}
                      {eligibility.maxGeneralTokens.toLocaleString()} {tokenSymbol} with +50% engagement bonus) + Top 500
                      leaderboard eligibility.
                    </>
                  ) : (
                    <>
                      <strong>Top 500 Leaderboard Track:</strong> Not in the LayerZero snapshot, and fully eligible to
                      complete missions and compete for the{' '}
                      <strong>{AIRDROP_TOP500_POOL.toLocaleString()} {tokenSymbol} Top 500 pool</strong>.
                    </>
                  )}
                  {eligibility.generalPoolExhausted && eligibility.eligibleForGeneralPool && (
                    <p className="genesis-helper">
                      All {campaign?.maxGeneralSlots.toLocaleString() || '10,000'} LayerZero spots have been filled. You
                      can still complete missions to compete for the Top 500 leaderboard.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          <AirdropVaultBox
            tokenSymbol={tokenSymbol}
            tier={displayedTier}
            baseTokens={displayedBaseTokens}
            bonusTokens={displayedBonusTokens}
            projectedTop500Tokens={displayedTop500}
            requiredCompleted={requiredCompleted}
            slotNumber={participant?.reservedSlotNumber ?? null}
            walletConnected={Boolean(participant?.wallet || eligibility)}
            unlocked={Boolean(participant?.boxUnlockedAt)}
            peekTrigger={peekTrigger}
            checking={checkingWallet !== null}
          />
        </section>

        <section className="airdrop-metrics" aria-label="Airdrop pool metrics">
          <div className="airdrop-metric-card">
            <span>Airdrop Total (51%)</span>
            <strong>{AIRDROP_TOTAL_POOL.toLocaleString()}</strong>
            <small>41% LayerZero + 10% Top 500</small>
          </div>
          <div className="airdrop-metric-card">
            <span>LayerZero Pool (41%)</span>
            <strong>{AIRDROP_GENERAL_POOL.toLocaleString()}</strong>
            <small>
              {campaign
                ? `${campaign.reservedSlots.toLocaleString()} of ${campaign.maxGeneralSlots.toLocaleString()} spots filled`
                : 'Up to 10,000 spots'}
            </small>
          </div>
          <div className="airdrop-metric-card">
            <span>Top 500 Leaderboard (10%)</span>
            <strong>{AIRDROP_TOP500_POOL.toLocaleString()}</strong>
            <small>Open to all participants</small>
          </div>
          <div className="airdrop-metric-card">
            <span>Total Fixed Supply</span>
            <strong>{AIRDROP_TOTAL_SUPPLY.toLocaleString()}</strong>
            <small>Fixed supply · No further minting</small>
          </div>
        </section>

        <section className="airdrop-tiers-strip" aria-label="Airdrop box tiers">
          <div className="airdrop-tiers-head">
            <h2>Mystery Crate Tiers</h2>
            <span>
              Your box stays sealed as a Mystery Vault until you check your wallet — then opens to reveal your allocation
              before locking for mission verification.
            </span>
          </div>
          <div className="airdrop-tiers-grid">
            {AIRDROP_BOX_TIERS.map((item) => {
              const active = displayedTier === item.tier;
              return (
                <article
                  key={item.tier}
                  data-tier={item.tier}
                  className={`airdrop-tier-card ${active ? 'airdrop-tier-card-active' : ''}`}
                >
                  <div className="airdrop-tier-thumb">
                    <img
                      src={item.lockedImage}
                      alt={`${item.name} (${item.badge})`}
                      width={78}
                      height={78}
                      loading="lazy"
                    />
                  </div>
                  <div className="airdrop-tier-meta">
                    <div className="airdrop-tier-meta-top">
                      <strong>{item.name}</strong>
                      <span className="airdrop-tier-chip">{item.badge}</span>
                    </div>
                    <span className="airdrop-tier-qual">{item.qualification}</span>
                    <p>{item.shareLabel}</p>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section id="airdrop-missions" className="airdrop-workspace">
          <div className="airdrop-panel">
            <h2>Missions to unlock your box</h2>
            <p className="genesis-helper" style={{ marginTop: 6 }}>
              {campaignLoading
                ? 'Checking campaign status…'
                : campaignError
                  ? 'Campaign status is temporarily unavailable.'
                  : isOpen
                    ? 'Connect your X account, link your wallet, and finish the four required missions to unlock your box.'
                    : campaign?.state === 'closed'
                      ? 'Missions have closed. Review your allocation and claim status.'
                      : 'The mission window has not opened yet. Check back soon.'}
            </p>

            {campaignError && <ErrorState message={campaignError} retry={() => void loadCampaign()} />}
            {auth.error && <ErrorState message={auth.error} retry={() => void auth.refresh()} />}
            {xLoginFailed && <ErrorState message="X sign-in did not finish. Please connect X again." />}
            {accountError && (
              <ErrorState
                message={accountError}
                retry={() => {
                  void auth.refresh().then(() => refreshAccount());
                }}
              />
            )}
            {enrollmentError && <ErrorState message={enrollmentError} retry={() => void enrollParticipant(true)} />}
            {(accountLoading || busy === 'enroll') && (
              <p className="genesis-loading" role="status">
                <Loader2 size={15} className="spin" /> Loading your airdrop box…
              </p>
            )}
            {notice && (
              <p className="genesis-notice" role="status">
                {notice}
              </p>
            )}
            {!participant && referral && (
              <div className="airdrop-referral-note">
                <span>An invitation link is attached.</span>
                <button type="button" disabled={Boolean(busy)} onClick={removeInvitation}>
                  Remove invitation
                </button>
              </div>
            )}

            {/* Step 0: Connect X & Link Wallet */}
            <div className="airdrop-mission">
              <div className="airdrop-mission-head">
                <h3>
                  <span className="airdrop-step-num">Start</span>
                  Connect X and your wallet
                  {auth.xAccount && participant?.wallet && <Badge tone="mint">Ready</Badge>}
                </h3>
              </div>
              <p>
                Connect your X account and sign a free message with your wallet to check your LayerZero tier and save
                your progress.
              </p>
              <div className="airdrop-actions">
                {!auth.xAccount ? (
                  <Button
                    onClick={() => void auth.connectX({ returnTo: '/airdrop' })}
                    disabled={!auth.configured || auth.isLoading || Boolean(busy)}
                  >
                    Connect X <ArrowUpRight size={14} />
                  </Button>
                ) : (
                  <>
                    <Badge tone="mint">X: @{auth.xAccount.username}</Badge>
                    <Button
                      variant="ghost"
                      disabled={Boolean(busy)}
                      onClick={() => void auth.disconnect()}
                    >
                      Disconnect X
                    </Button>
                  </>
                )}
                {participant && (
                  <Button
                    variant={participant.wallet ? 'secondary' : 'primary'}
                    loading={busy === 'wallet'}
                    disabled={!isOpen || Boolean(busy) || walletLockedForClaims}
                    onClick={() => void bindParticipantWallet()}
                  >
                    <Wallet size={14} />{' '}
                    {participant.wallet
                      ? walletLockedForClaims
                        ? `Linked: ${participant.wallet.slice(0, 8)}…`
                        : `Switch wallet (${participant.wallet.slice(0, 8)}…)`
                      : 'Link wallet'}
                  </Button>
                )}
              </div>
              {auth.xAccount && !participant && !accountLoading && !accountError && !enrollmentError && !campaignLoading && !campaignError && (
                campaign?.state === 'upcoming' ? (
                  <p className="genesis-helper">
                    Your X account is connected. Wallet linking and quest verification will unlock here once the mission
                    window opens.
                  </p>
                ) : campaign?.state === 'closed' ? (
                  <p className="genesis-helper">Missions have closed for new participants.</p>
                ) : null
              )}
              {walletLockedForClaims && participant?.wallet && (
                <p className="genesis-helper">Wallet is locked for claiming.</p>
              )}
            </div>

            {/* Mission 1: Follow */}
            <div className="airdrop-mission">
              <div className="airdrop-mission-head">
                <h3>
                  <span className="airdrop-step-num">1</span>
                  Follow @{campaign?.projectHandle || 'oneshot'}
                  {participant?.checks.follow?.state === 'verified' ? (
                    <Badge tone="mint">Verified</Badge>
                  ) : (
                    <Badge tone="amber">Required</Badge>
                  )}
                </h3>
              </div>
              <p>Follow @{campaign?.projectHandle || 'oneshot'} on X for launch and claim updates.</p>
              {participant && (
                <div className="airdrop-actions">
                  {campaign?.projectHandle && (
                    <a
                      className="button button-secondary"
                      href={`https://x.com/${campaign.projectHandle}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open X <ArrowUpRight size={14} />
                    </a>
                  )}
                  <Button
                    variant="ghost"
                    loading={busy === 'follow'}
                    disabled={!isOpen || Boolean(busy)}
                    onClick={() => void runAction('follow', 'verify', { task: 'follow' }, 'Follow verified.')}
                  >
                    Check follow
                  </Button>
                </div>
              )}
              {participant?.checks.follow && <p className="genesis-helper">{participant.checks.follow.message}</p>}
            </div>

            {/* Mission 2: Like & Repost */}
            <div className="airdrop-mission">
              <div className="airdrop-mission-head">
                <h3>
                  <span className="airdrop-step-num">2</span>
                  Like and repost announcement
                  {participant?.checks.repost?.state === 'verified' ? (
                    <Badge tone="mint">Verified</Badge>
                  ) : (
                    <Badge tone="amber">Required</Badge>
                  )}
                </h3>
              </div>
              <p>Like and repost our announcement on X, then check your repost or paste your quote-post link.</p>
              {participant && (
                <>
                  <div className="airdrop-actions">
                    <a className="button button-secondary" href={announcementUrl} target="_blank" rel="noreferrer">
                      <Heart size={14} /> <Repeat2 size={14} /> Like &amp; Repost on X
                    </a>
                    <Button
                      variant="ghost"
                      loading={busy === 'repost'}
                      disabled={!isOpen || Boolean(busy)}
                      onClick={() =>
                        void runAction(
                          'repost',
                          'verify',
                          { task: 'repost', ...(quotePostUrl.trim() ? { postUrl: quotePostUrl.trim() } : {}) },
                          'Repost verified.',
                        )
                      }
                    >
                      Check repost
                    </Button>
                  </div>
                  <div className="airdrop-input-row">
                    <input
                      aria-label="Optional quote-post link"
                      placeholder="Optional quote-post link (https://x.com/...)"
                      value={quotePostUrl}
                      onChange={e => setQuotePostUrl(e.target.value)}
                      maxLength={512}
                    />
                  </div>
                </>
              )}
              {participant?.checks.repost && <p className="genesis-helper">{participant.checks.repost.message}</p>}
            </div>

            {/* Mission 3: Posts (1 required, up to 5) */}
            <div className="airdrop-mission">
              <div className="airdrop-mission-head">
                <h3>
                  <span className="airdrop-step-num">3</span>
                  Post about oneshot ({participant?.posts.length || 0} / {AIRDROP_MAX_POSTS})
                  {(participant?.posts.length || 0) >= 1 ? (
                    <Badge tone="mint">Verified</Badge>
                  ) : (
                    <Badge tone="amber">1 Required · Up to 5</Badge>
                  )}
                </h3>
              </div>
              <p>
                Publish 1 original post mentioning @{campaign?.projectHandle || 'oneshot'} to unlock your box. You can
                verify up to 5 posts—engagement adds up to a <strong>+50% bonus</strong> and raises your Top 500 rank.
              </p>
              {participant && (
                <>
                  <div className="airdrop-actions">
                    <a className="button button-secondary" href={postIntent} target="_blank" rel="noreferrer">
                      Write post on X <ArrowUpRight size={14} />
                    </a>
                    {participant.posts.length > 0 && (
                      <Button
                        variant="ghost"
                        loading={busy === 'refresh-engagement'}
                        disabled={!isOpen || Boolean(busy)}
                        onClick={() =>
                          void runAction('refresh-engagement', 'refresh-engagement', {}, 'Engagement updated.')
                        }
                      >
                        <RefreshCw size={13} /> Refresh engagement
                      </Button>
                    )}
                  </div>
                  {participant.posts.length < AIRDROP_MAX_POSTS && (
                    <div className="airdrop-input-row">
                      <input
                        aria-label="Public X post link"
                        placeholder="https://x.com/yourhandle/status/..."
                        value={postUrl}
                        onChange={e => setPostUrl(e.target.value)}
                        maxLength={512}
                      />
                      <Button
                        loading={busy === 'post'}
                        disabled={!isOpen || !postUrl.trim() || Boolean(busy)}
                        onClick={() =>
                          void runAction('post', 'verify', { task: 'post', postUrl: postUrl.trim() }, 'Post verified.')
                        }
                      >
                        Verify post
                      </Button>
                    </div>
                  )}
                  {participant.posts.length > 0 && (
                    <div className="airdrop-post-list">
                      {participant.posts.map((post, idx) => {
                        const safePostHref = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(post.postUrl)
                          ? post.postUrl
                          : `https://x.com/i/web/status/${post.postId}`;
                        return (
                          <div key={post.postId} className="airdrop-post-card">
                            <a href={safePostHref} target="_blank" rel="noreferrer" className="text-link">
                              Post #{idx + 1} <ArrowUpRight size={12} />
                            </a>
                            <div className="airdrop-post-metrics">
                              {post.metrics.likes} likes · {post.metrics.reposts} reposts · {post.metrics.replies} replies ·{' '}
                              {post.metrics.views.toLocaleString()} views · <strong>+{post.engagementScore} pts</strong>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Mission 4: Create a meme token */}
            <div className="airdrop-mission">
              <div className="airdrop-mission-head">
                <h3>
                  <span className="airdrop-step-num">4</span>
                  Create a meme token
                  {participant?.checks.create_token?.state === 'verified' ? (
                    <Badge tone="mint">Verified</Badge>
                  ) : (
                    <Badge tone="amber">Required</Badge>
                  )}
                </h3>
              </div>
              <p>Launch a meme token on oneshot using your linked wallet.</p>
              {participant && (
                <div className="airdrop-actions">
                  <Link href="/tokens/new" className="button button-secondary">
                    Launch a token <ArrowUpRight size={14} />
                  </Link>
                  <Button
                    variant="ghost"
                    loading={busy === 'create_token'}
                    disabled={!isOpen || !participant.wallet || Boolean(busy)}
                    onClick={() =>
                      void runAction('create_token', 'verify', { task: 'create_token' }, 'Token launch verified.')
                    }
                  >
                    Verify token launch
                  </Button>
                </div>
              )}
              {participant?.checks.create_token && (
                <p className="genesis-helper">{participant.checks.create_token.message}</p>
              )}
            </div>

            {/* Mission 5: Invite friends */}
            <div className="airdrop-mission">
              <div className="airdrop-mission-head">
                <h3>
                  <span className="airdrop-step-num">+</span>
                  Invite friends
                  <Badge tone="neutral">Bonus</Badge>
                </h3>
              </div>
              <p>
                Share your invitation link. Each friend who connects X, links a wallet, follows, and verifies 1 post
                earns you <strong>+150 points</strong> toward the Top 500 leaderboard.
              </p>
              {me?.referralUrl && (
                <div className="airdrop-input-row">
                  <input aria-label="Your personal referral link" value={me.referralUrl} readOnly />
                  <Button
                    variant="secondary"
                    onClick={() => void copyText(me.referralUrl!, 'Invitation link copied.')}
                  >
                    <Copy size={14} /> Copy link
                  </Button>
                </div>
              )}
              {participant && (
                <p className="genesis-helper">
                  Qualified friends: <strong>{participant.qualifiedReferrals}</strong>
                </p>
              )}
            </div>

            {/* Mission 6: Rendered ONLY when enabled by admin */}
            {campaign?.tradeMissionEnabled && (
              <div className="airdrop-mission">
                <div className="airdrop-mission-head">
                  <h3>
                    <span className="airdrop-step-num">+</span>
                    Trade meme tokens
                    {participant?.checks.trade_token?.state === 'verified' ? (
                      <Badge tone="mint">Verified</Badge>
                    ) : (
                      <Badge tone="amber">Bonus</Badge>
                    )}
                  </h3>
                </div>
                <p>
                  Buy or sell at least {formatIndexedAmount(campaign.minTradeNativeRaw, 18)} native volume on oneshot
                  token markets.
                </p>
                {participant && (
                  <div className="airdrop-actions">
                    <Link href="/tokens" className="button button-secondary">
                      Trade tokens <ArrowUpRight size={14} />
                    </Link>
                    <Button
                      variant="ghost"
                      loading={busy === 'trade_token'}
                      disabled={!isOpen || !participant.wallet || Boolean(busy)}
                      onClick={() =>
                        void runAction('trade_token', 'verify', { task: 'trade_token' }, 'Trading volume verified.')
                      }
                    >
                      Check trade volume
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right rail: Box Breakdown + Claim Panel */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div className="airdrop-panel">
              <h2>Your box breakdown</h2>
              {!participant ? (
                <p className="genesis-helper" style={{ marginTop: 12 }}>
                  Connect your X account and link your wallet to save mission progress and reserve your spot.
                </p>
              ) : (
                <div style={{ marginTop: 14, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="info-row">
                    <span>Required missions</span>
                    <strong>{requiredCompleted} / 4 complete</strong>
                  </div>
                  <div className="info-row">
                    <span>LayerZero allocation</span>
                    <strong>
                      {participant.reservedGeneralTokens.toLocaleString()} {tokenSymbol}
                    </strong>
                  </div>
                  <div className="info-row">
                    <span>Engagement boost</span>
                    <strong>
                      +{(participant.engagementBonusBps / 100).toFixed(1)}% ({participant.engagementScore} score)
                    </strong>
                  </div>
                  <div className="info-row">
                    <span>Leaderboard score</span>
                    <strong>{participant.totalScore.toLocaleString()} pts</strong>
                  </div>
                  <div className="info-row">
                    <span>Current rank</span>
                    <strong>{participant.rank ? `#${participant.rank}` : 'Unlocks after 4 missions'}</strong>
                  </div>
                  <div className="info-row">
                    <span>Projected Top 500 reward</span>
                    <strong>
                      {participant.projectedTop500Tokens.toLocaleString()} {tokenSymbol}
                    </strong>
                  </div>
                  <div className="info-row">
                    <span>Total estimated airdrop</span>
                    <strong>
                      {participant.totalProjectedTokens.toLocaleString()} {tokenSymbol}
                    </strong>
                  </div>
                </div>
              )}
            </div>

            <div className="airdrop-panel">
              <h2>{hasClaimed ? 'Claim & unlock progress' : 'Claim tokens'}</h2>
              {!hasClaimed ? (
                <>
                  <p className="genesis-helper" style={{ marginTop: 8 }}>
                    When claiming opens, claim your allocation directly to your linked wallet. Network fees apply.
                  </p>
                  {!campaign?.claimingOpen || !participant?.claimProof ? (
                    <p className="genesis-helper" style={{ marginTop: 14 }}>
                      {participant?.boxUnlockedAt
                        ? 'Your box is unlocked and your allocation is saved. Return here to claim when claiming opens.'
                        : 'Finish the four required missions to unlock your box and lock in your allocation.'}
                    </p>
                  ) : (
                    <div style={{ marginTop: 16 }}>
                      {claimError && <ErrorState message={claimError} />}
                      {claimTxHash && <p className="genesis-notice">Transaction sent: {claimTxHash.slice(0, 14)}…</p>}
                      <p className="genesis-helper">
                        Claimable allocation:{' '}
                        <strong>
                          {formatIndexedAmount(participant.claimProof.amountRaw, 8)} {tokenSymbol}
                        </strong>
                      </p>
                      <Button
                        className="full-width"
                        style={{ marginTop: 12 }}
                        loading={claimingTx === 'initiate'}
                        onClick={() => void submitOnChainClaim('initiate')}
                      >
                        <Gift size={15} /> Claim tokens
                      </Button>
                      <Button
                        variant="ghost"
                        className="full-width"
                        style={{ marginTop: 8 }}
                        loading={checkingClaimState}
                        onClick={() => void readOnChainClaimState()}
                      >
                        <RefreshCw size={13} /> Refresh claim status
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <div style={{ marginTop: 12 }}>
                  <p className="genesis-helper" style={{ marginBottom: 12 }}>
                    Your claimed tokens lock for 7 days from claim time, then unlock equally over the following 7 days.
                  </p>
                  {claimError && <ErrorState message={claimError} />}
                  {claimTxHash && <p className="genesis-notice">Transaction sent: {claimTxHash.slice(0, 14)}…</p>}
                  <div className="info-row">
                    <span>Total claimed</span>
                    <strong>
                      {formatIndexedAmount(onChainSchedule!.totalAmount.toString(), 8)} {tokenSymbol}
                    </strong>
                  </div>
                  <div className="info-row">
                    <span>Unlocked so far</span>
                    <strong>
                      {onChainSchedule!.unlockedDays} / 7 days (
                      {formatIndexedAmount(onChainSchedule!.unlockedAmount.toString(), 8)} {tokenSymbol})
                    </strong>
                  </div>
                  <div className="info-row">
                    <span>Available to withdraw</span>
                    <strong>
                      {formatIndexedAmount(onChainSchedule!.withdrawable.toString(), 8)} {tokenSymbol}
                    </strong>
                  </div>
                  <div className="airdrop-schedule-days">
                    {Array.from({ length: 7 }, (_, i) => {
                      const unlocked = onChainSchedule!.unlockedDays >= i + 1;
                      return (
                        <div key={i} className={`schedule-day ${unlocked ? 'schedule-day-unlocked' : ''}`}>
                          Day {8 + i}
                          <br />
                          {unlocked ? <Check size={11} /> : 'Locked'}
                        </div>
                      );
                    })}
                  </div>
                  {unlockSchedule && (
                    <p className="genesis-helper">
                      {unlockSchedule.phase === 'fully_unlocked'
                        ? 'All 7 daily unlocks are complete.'
                        : `Next daily unlock: ${new Date(unlockSchedule.nextUnlockAtSec * 1000).toLocaleString()}`}
                    </p>
                  )}
                  <Button
                    className="full-width"
                    style={{ marginTop: 12 }}
                    disabled={onChainSchedule!.withdrawable === 0n}
                    loading={claimingTx === 'withdraw'}
                    onClick={() => void submitOnChainClaim('withdraw')}
                  >
                    Withdraw available {tokenSymbol}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Top 500 Leaderboard */}
        <section id="airdrop-leaderboard" className="airdrop-section airdrop-panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <h2>
                <Trophy size={18} style={{ verticalAlign: 'middle', marginRight: 8 }} />
                Top 500 Leaderboard ({AIRDROP_TOP500_POOL.toLocaleString()} {tokenSymbol})
              </h2>
              <p className="genesis-helper">
                Open to all LayerZero and community participants. Unlock your box to join the live rankings.
              </p>
            </div>
            <Badge tone="mint">{leaderboard?.totalRanked ?? 0} ranked</Badge>
          </div>

          <div className="airdrop-brackets">
            {AIRDROP_TOP500_BRACKETS.map(bracket => (
              <div key={bracket.label} className="airdrop-bracket-card">
                <span>{bracket.label}</span>
                <strong>
                  {bracket.perUserTokens.toLocaleString()} {tokenSymbol}
                </strong>
                <span>each ({bracket.subtotalTokens.toLocaleString()} pool)</span>
              </div>
            ))}
          </div>

          {leaderboardError && (
            <ErrorState message={leaderboardError} retry={() => void loadLeaderboard(leaderboardOffset)} />
          )}

          {leaderboardLoading && !leaderboard && !leaderboardError ? (
            <p className="genesis-loading">
              <Loader2 size={15} className="spin" /> Loading leaderboard…
            </p>
          ) : !leaderboardError && !leaderboard?.entries.length ? (
            <p className="genesis-helper">
              No participants have unlocked their box yet. Complete the four required missions to claim Rank #1.
            </p>
          ) : leaderboard?.entries.length ? (
            <>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Account</th>
                      <th>Tier</th>
                      <th>Posts</th>
                      <th>Engagement</th>
                      <th>Invites</th>
                      <th>Score</th>
                      <th>Top 500 Reward</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.entries.map(row => (
                      <tr key={`${row.rank}-${row.username}`}>
                        <td>#{row.rank}</td>
                        <td>
                          <strong>@{row.username}</strong> <span className="muted">({row.walletMasked})</span>
                        </td>
                        <td>
                          {row.tier === 'lz_winner'
                            ? 'LZ Winner'
                            : row.tier === 'lz_user_5tx'
                              ? 'LZ 5+ Txs'
                              : 'Community'}
                        </td>
                        <td>
                          {row.postsCount} / {AIRDROP_MAX_POSTS}
                        </td>
                        <td>{row.engagementScore.toLocaleString()}</td>
                        <td>{row.qualifiedReferrals}</td>
                        <td>
                          <strong>{row.totalScore.toLocaleString()}</strong>
                        </td>
                        <td>
                          <strong>
                            {row.projectedTop500Tokens.toLocaleString()} {tokenSymbol}
                          </strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="airdrop-actions" style={{ marginTop: 16 }}>
                <Button
                  variant="secondary"
                  disabled={leaderboardOffset === 0}
                  onClick={() => setLeaderboardOffset(v => Math.max(0, v - 25))}
                >
                  <ArrowLeft size={14} /> Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={leaderboardOffset + 25 >= leaderboard.totalRanked}
                  onClick={() => setLeaderboardOffset(v => v + 25)}
                >
                  Next <ArrowRight size={14} />
                </Button>
              </div>
            </>
          ) : null}
        </section>

        {/* Supply Distribution & FAQ */}
        <section id="airdrop-distribution" className="airdrop-section airdrop-panel">
          <h2>
            <Sparkles size={17} style={{ verticalAlign: 'middle', marginRight: 8 }} />
            {tokenSymbol} Supply Distribution
          </h2>
          <p className="genesis-helper">
            Fixed total supply of <strong>{AIRDROP_TOTAL_SUPPLY.toLocaleString()} {tokenSymbol}</strong>, distributed across
            community airdrop rewards, market liquidity, contributors, ecosystem growth, and protocol reserves.
          </p>

          <div className="airdrop-distribution-bar" role="img" aria-label="Supply distribution bar">
            <div style={{ width: '41%', background: 'var(--accent)' }} title="41% LayerZero Airdrop" />
            <div style={{ width: '10%', background: 'var(--positive)' }} title="10% Top 500 Leaderboard" />
            <div style={{ width: '25%', background: 'var(--amber)' }} title="25% Market Liquidity" />
            <div style={{ width: '10%', background: 'var(--subtle)' }} title="10% Core Contributors (24-month daily linear)" />
            <div style={{ width: '9%', background: 'var(--muted)' }} title="9% Ecosystem Development" />
            <div style={{ width: '5%', background: 'var(--line-strong, var(--line))' }} title="5% Protocol Treasury" />
          </div>

          <div className="airdrop-distribution-grid">
            <div className="info-row">
              <span>
                <i className="airdrop-swatch" style={{ background: 'var(--accent)' }} />
                41% LayerZero Airdrop
              </span>
              <strong>
                {AIRDROP_GENERAL_POOL.toLocaleString()} {tokenSymbol}
              </strong>
            </div>
            <div className="info-row">
              <span>
                <i className="airdrop-swatch" style={{ background: 'var(--positive)' }} />
                10% Top 500 Leaderboard
              </span>
              <strong>
                {AIRDROP_TOP500_POOL.toLocaleString()} {tokenSymbol}
              </strong>
            </div>
            <div className="info-row">
              <span>
                <i className="airdrop-swatch" style={{ background: 'var(--amber)' }} />
                25% Market Liquidity
              </span>
              <strong>
                {AIRDROP_LIQUIDITY_POOL.toLocaleString()} {tokenSymbol}
              </strong>
            </div>
            <div className="info-row">
              <span>
                <i className="airdrop-swatch" style={{ background: 'var(--subtle)' }} />
                10% Core Contributors (Daily linear over 24 months)
              </span>
              <strong>
                {AIRDROP_TEAM_POOL.toLocaleString()} {tokenSymbol}
              </strong>
            </div>
            <div className="info-row">
              <span>
                <i className="airdrop-swatch" style={{ background: 'var(--muted)' }} />
                9% Ecosystem Development
              </span>
              <strong>
                {AIRDROP_ECOSYSTEM_POOL.toLocaleString()} {tokenSymbol}
              </strong>
            </div>
            <div className="info-row">
              <span>
                <i className="airdrop-swatch" style={{ background: 'var(--line-strong, var(--line))' }} />
                5% Protocol Treasury
              </span>
              <strong>
                {AIRDROP_TREASURY_POOL.toLocaleString()} {tokenSymbol}
              </strong>
            </div>
          </div>

          <div className="airdrop-faq" style={{ marginTop: 22 }}>
            <details>
              <summary>How is my airdrop calculated?</summary>
              <p>
                LayerZero airdrop winners receive a 100% base share and past LayerZero users with 5 or more
                transactions receive a 50% base share. Post engagement adds up to +50% on top of your base share and
                earns points toward the Top 500 leaderboard.
              </p>
            </details>
            <details>
              <summary>What if my wallet is not on the LayerZero list?</summary>
              <p>
                Anyone can connect X, link a wallet, finish the four required missions, publish up to 5 posts, and
                invite friends to compete for the {AIRDROP_TOP500_POOL.toLocaleString()} {tokenSymbol} Top 500
                leaderboard pool.
              </p>
            </details>
            <details>
              <summary>Do I need to pay anything to unlock my box?</summary>
              <p>
                Connecting X and linking your wallet with a signature are free. Launching a meme token and claiming
                tokens later use standard network fees.
              </p>
            </details>
          </div>
        </section>
      </main>

      <footer className="airdrop-footer">
        <Link href="/" className="brand" aria-label="oneshot home">
          <OneshotLogo />
        </Link>
        <span>oneshot Token Airdrop · LayerZero &amp; Community</span>
        <Link href="/settings">
          Account settings <ArrowUpRight size={14} />
        </Link>
      </footer>
    </div>
  );
}
