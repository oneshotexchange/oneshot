import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { Check, Copy, Download, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import {
  buildAirdropActivateTransaction,
  buildAirdropSweepTransaction,
  decodeAirdropDistributorState,
  encodeAirdropDistributorReadCalls,
  encodeErc20BalanceOfData,
  formatIndexedAmount,
  type AirdropDistributorState,
} from '@oneshot/evm';
import { apiUrl } from '../lib/api-url';
import { customerErrorDetails, customerFetch, customerResponseJson } from '../lib/customer-http';
import {
  AIRDROP_GENERAL_POOL,
  AIRDROP_GENERAL_SLOT_CAP,
  airdropCampaignSchema,
  airdropPostId,
  detectSnapshotCsvHeader,
  type AirdropCampaign,
  type AirdropSnapshotTier,
} from '../lib/airdrop-schema';
import { Badge, Button, ErrorState, Field } from './ui';
import '../app/airdrop.css';

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_ROOT = '0x0000000000000000000000000000000000000000000000000000000000000000';

function buildSnapshotCsvChunks(csvText: string, maxRows = 15_000, maxChars = 1_600_000): string[] {
  const lines = csvText.split(/\r?\n/);
  let headerLine: string | null = null;
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    const clean = rawLine.replace(/^\uFEFF/, '').trim();
    if (!clean || clean.startsWith('#')) continue;
    if (headerLine === null && dataLines.length === 0 && detectSnapshotCsvHeader(clean)) {
      headerLine = clean;
      continue;
    }
    dataLines.push(clean);
  }

  if (!dataLines.length) return [csvText];

  const chunks: string[] = [];
  let bucket: string[] = [];
  let chars = headerLine ? headerLine.length + 1 : 0;

  for (const line of dataLines) {
    if (bucket.length > 0 && (bucket.length >= maxRows || chars + line.length + 1 > maxChars)) {
      chunks.push(headerLine ? `${headerLine}\n${bucket.join('\n')}` : bucket.join('\n'));
      bucket = [];
      chars = headerLine ? headerLine.length + 1 : 0;
    }
    bucket.push(line);
    chars += line.length + 1;
  }
  if (bucket.length > 0) {
    chunks.push(headerLine ? `${headerLine}\n${bucket.join('\n')}` : bucket.join('\n'));
  }
  return chunks;
}

async function ethCallProvider(provider: EthereumProvider, to: string, data: `0x${string}`): Promise<`0x${string}`> {
  const result = await provider.request({
    method: 'eth_call',
    params: [{ to, data }, 'latest'],
  });
  if (typeof result !== 'string' || !result.startsWith('0x')) {
    throw new Error('Unexpected response while reading the distributor contract.');
  }
  return result as `0x${string}`;
}

const summarySchema = z.object({
  campaign: airdropCampaignSchema,
  snapshot: z.object({ total: z.number(), winners: z.number(), fiveTx: z.number() }),
  reservedSlots: z.number(),
  reservedGeneralTokens: z.number(),
  totalParticipants: z.number(),
  unlockedBoxes: z.number(),
  boundWallets: z.number(),
  publishedMerkle: z
    .object({
      root: z.string(),
      chainId: z.number(),
      distributor: z.string(),
      totalCommittedRaw: z.string(),
      publishedAt: z.string(),
      recipientCount: z.number(),
    })
    .nullable(),
  oauthConfigured: z.boolean(),
  providerConfigured: z.boolean(),
  databaseConfigured: z.boolean(),
});

type AdminSummary = z.infer<typeof summarySchema>;

const merkleExportResultSchema = z.object({
  root: z.string(),
  chainId: z.number(),
  distributor: z.string(),
  recipientCount: z.number(),
  totalCommittedRaw: z.string(),
  published: z.boolean(),
  allocations: z.record(
    z.string(),
    z.object({
      amountRaw: z.string(),
      proof: z.array(z.string()),
    }),
  ),
});

type MerkleExportResult = z.infer<typeof merkleExportResultSchema>;

async function adminAirdropRequest<T>(path: string, token: string, body?: unknown): Promise<T> {
  const response = await customerFetch(apiUrl('/api/admin/airdrop' + path), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  });
  const value = await customerResponseJson(response);
  if (!response.ok) {
    throw new Error(customerErrorDetails(value).message || 'Could not update airdrop settings.');
  }
  return value as T;
}

export function AirdropAdmin({ token }: { token: string }) {
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [campaign, setCampaign] = useState<AirdropCampaign | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const [csvText, setCsvText] = useState('');
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [defaultTier, setDefaultTier] = useState<'auto' | AirdropSnapshotTier>('auto');
  const [importProgress, setImportProgress] = useState('');
  const [importing, setImporting] = useState(false);

  const [chainInput, setChainInput] = useState('84532');
  const [distributorInput, setDistributorInput] = useState('');
  const [merkleResult, setMerkleResult] = useState<MerkleExportResult | null>(null);
  const [merkleBusy, setMerkleBusy] = useState(false);

  const [distributorState, setDistributorState] = useState<AirdropDistributorState | null>(null);
  const [onChainBusy, setOnChainBusy] = useState<string | null>(null);
  const [onChainTxHash, setOnChainTxHash] = useState<string | null>(null);
  const [sweepRecipient, setSweepRecipient] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const value = summarySchema.parse(await adminAirdropRequest('', token));
      setSummary(value);
      setCampaign(value.campaign);
      if (value.campaign.chainId) setChainInput(String(value.campaign.chainId));
      if (value.campaign.distributorAddress) setDistributorInput(value.campaign.distributorAddress);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load airdrop administration.');
    } finally {
      setBusy(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (next: Partial<AirdropCampaign>) =>
    setCampaign(prev => (prev ? { ...prev, ...next } : null));

  async function saveCampaign() {
    if (!campaign || !summary) return;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await adminAirdropRequest('/campaign', token, {
        expectedRevision: summary.campaign.revision,
        campaign,
      });
      await load();
      setNotice('Airdrop campaign settings saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save airdrop campaign.');
    } finally {
      setBusy(false);
    }
  }

  async function runSnapshotImport() {
    if (!csvText.trim()) return;
    setImporting(true);
    setImportProgress('');
    setError(null);
    setNotice('');
    let currentBatch = 0;
    let totalBatches = 1;
    try {
      const chunks = buildSnapshotCsvChunks(csvText);
      totalBatches = chunks.length;
      let importedTotal = 0;
      let latest = { imported: 0, total: 0, winners: 0, fiveTx: 0 };

      for (let idx = 0; idx < chunks.length; idx++) {
        currentBatch = idx + 1;
        setImportProgress(
          chunks.length > 1 ? `Importing batch ${idx + 1} / ${chunks.length}…` : 'Importing snapshot…',
        );
        const batchMode = idx === 0 ? importMode : 'merge';
        const result = await adminAirdropRequest<{ imported: number; total: number; winners: number; fiveTx: number }>(
          '/snapshot',
          token,
          {
            mode: batchMode,
            csvText: chunks[idx],
            ...(defaultTier !== 'auto' ? { defaultTier } : {}),
          },
        );
        importedTotal += result.imported;
        latest = result;
      }

      setCsvText('');
      await load();
      setNotice(
        `Imported ${importedTotal.toLocaleString()} snapshot rows across ${chunks.length} batch(es). Total snapshot: ${latest.total.toLocaleString()} (${latest.winners.toLocaleString()} LZ winners, ${latest.fiveTx.toLocaleString()} 5+ tx users).`,
      );
    } catch (reason) {
      const msg = reason instanceof Error ? reason.message : 'Snapshot import failed.';
      setError(
        totalBatches > 1 && currentBatch > 1
          ? `Batch ${currentBatch} / ${totalBatches} failed (earlier batches already imported): ${msg}`
          : msg,
      );
    } finally {
      setImportProgress('');
      setImporting(false);
    }
  }

  async function handleExportMerkle(publish: boolean) {
    setMerkleBusy(true);
    setError(null);
    setNotice('');
    try {
      const chainId = Number(chainInput.trim());
      if (!Number.isSafeInteger(chainId) || chainId < 1) {
        throw new Error('Enter a valid positive chain ID.');
      }
      const distributor = distributorInput.trim();
      if (!/^0x[\da-fA-F]{40}$/.test(distributor)) {
        throw new Error('Enter a valid OneshotAirdropDistributor contract address.');
      }
      const exported = merkleExportResultSchema.parse(
        await adminAirdropRequest('/merkle-export', token, { chainId, distributor, publish }),
      );
      setMerkleResult(exported);
      if (publish) {
        await load();
        setNotice(`Published Merkle root ${exported.root} for ${exported.recipientCount.toLocaleString()} wallets.`);
      } else {
        setNotice(`Computed preview Merkle root ${exported.root} for ${exported.recipientCount.toLocaleString()} wallets.`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Merkle export failed.');
    } finally {
      setMerkleBusy(false);
    }
  }

  function downloadMerkleJson() {
    if (!merkleResult) return;
    const blob = new Blob([JSON.stringify(merkleResult, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `oneshot-airdrop-merkle-${merkleResult.chainId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function ensureWalletOnChain(targetChainId: number): Promise<EthereumProvider> {
    const provider = (window as { ethereum?: EthereumProvider }).ethereum;
    if (!provider || typeof provider.request !== 'function') {
      throw new Error('Open a browser wallet extension to inspect or sign distributor transactions.');
    }
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${targetChainId.toString(16)}` }],
    });
    const chainHex = await provider.request({ method: 'eth_chainId' });
    if (typeof chainHex !== 'string' || parseInt(chainHex, 16) !== targetChainId) {
      throw new Error(`Switch your wallet network to chain ${targetChainId} first.`);
    }
    return provider;
  }

  async function checkOnChainDistributor() {
    const targetChainId = summary?.publishedMerkle?.chainId ?? campaign?.chainId ?? Number(chainInput.trim());
    const targetDistributor = (
      summary?.publishedMerkle?.distributor ??
      campaign?.distributorAddress ??
      distributorInput.trim()
    ).toLowerCase();
    if (!Number.isSafeInteger(targetChainId) || targetChainId < 1) {
      setError('Enter a valid target Chain ID first.');
      return;
    }
    if (!/^0x[\da-f]{40}$/.test(targetDistributor) || targetDistributor === ZERO_ADDRESS) {
      setError('Enter a valid OneshotAirdropDistributor address first.');
      return;
    }

    setOnChainBusy('check');
    setError(null);
    setNotice('');
    try {
      const provider = await ensureWalletOnChain(targetChainId);
      const calls = encodeAirdropDistributorReadCalls();
      const [merkleRoot, totalCommitted, totalClaimedInitiated, totalWithdrawn, claimDeadline, admin, tokenHex] =
        await Promise.all([
          ethCallProvider(provider, targetDistributor, calls.merkleRoot),
          ethCallProvider(provider, targetDistributor, calls.totalCommitted),
          ethCallProvider(provider, targetDistributor, calls.totalClaimedInitiated),
          ethCallProvider(provider, targetDistributor, calls.totalWithdrawn),
          ethCallProvider(provider, targetDistributor, calls.claimDeadline),
          ethCallProvider(provider, targetDistributor, calls.admin),
          ethCallProvider(provider, targetDistributor, calls.token),
        ]);
      const initial = decodeAirdropDistributorState({
        merkleRoot,
        totalCommitted,
        totalClaimedInitiated,
        totalWithdrawn,
        claimDeadline,
        admin,
        token: tokenHex,
      });
      const tokenBalance = await ethCallProvider(
        provider,
        initial.token,
        encodeErc20BalanceOfData(targetDistributor as `0x${string}`),
      );
      const state = decodeAirdropDistributorState({
        merkleRoot,
        totalCommitted,
        totalClaimedInitiated,
        totalWithdrawn,
        claimDeadline,
        admin,
        token: tokenHex,
        tokenBalance,
      });
      setDistributorState(state);
      setNotice('On-chain distributor status refreshed.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not read on-chain distributor status.');
    } finally {
      setOnChainBusy(null);
    }
  }

  async function activateOnChainDistributor() {
    if (!summary?.publishedMerkle) return;
    setOnChainBusy('activate');
    setError(null);
    setNotice('');
    setOnChainTxHash(null);
    try {
      const provider = await ensureWalletOnChain(summary.publishedMerkle.chainId);
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const active = (Array.isArray(accounts) ? accounts[0] : '') as string;
      if (!/^0x[\da-fA-F]{40}$/.test(active)) {
        throw new Error('Unlock an EVM wallet account to submit activate().');
      }
      if (distributorState && distributorState.activated) {
        throw new Error('Distributor is already activated on-chain.');
      }
      if (distributorState && distributorState.admin.toLowerCase() !== active.toLowerCase()) {
        throw new Error(`Switch your wallet to the distributor admin account (${distributorState.admin}).`);
      }
      const tx = buildAirdropActivateTransaction({
        chainId: summary.publishedMerkle.chainId,
        distributor: summary.publishedMerkle.distributor as `0x${string}`,
        merkleRoot: summary.publishedMerkle.root as `0x${string}`,
        totalCommittedRaw: summary.publishedMerkle.totalCommittedRaw,
      });
      const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: active, to: tx.to, data: tx.data }],
      });
      if (typeof hash === 'string') {
        setOnChainTxHash(hash);
        setNotice(`activate() transaction submitted (${hash.slice(0, 14)}…). Refresh status after confirmation.`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not submit activate() transaction.');
    } finally {
      setOnChainBusy(null);
    }
  }

  async function sweepUnclaimedOnChain() {
    const targetChainId = summary?.publishedMerkle?.chainId ?? campaign?.chainId;
    const targetDistributor = summary?.publishedMerkle?.distributor ?? campaign?.distributorAddress;
    if (!targetChainId || !targetDistributor) return;
    const recipient = sweepRecipient.trim();
    if (!/^0x[\da-fA-F]{40}$/.test(recipient) || recipient.toLowerCase() === ZERO_ADDRESS) {
      setError('Enter a valid nonzero sweep recipient address.');
      return;
    }
    setOnChainBusy('sweep');
    setError(null);
    setNotice('');
    setOnChainTxHash(null);
    try {
      const provider = await ensureWalletOnChain(targetChainId);
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const active = (Array.isArray(accounts) ? accounts[0] : '') as string;
      if (!/^0x[\da-fA-F]{40}$/.test(active)) {
        throw new Error('Unlock an EVM wallet account to submit sweepUnclaimed().');
      }
      if (distributorState && distributorState.admin.toLowerCase() !== active.toLowerCase()) {
        throw new Error(`Switch your wallet to the distributor admin account (${distributorState.admin}).`);
      }
      const tx = buildAirdropSweepTransaction({
        chainId: targetChainId,
        distributor: targetDistributor as `0x${string}`,
        recipient: recipient as `0x${string}`,
      });
      const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: active, to: tx.to, data: tx.data }],
      });
      if (typeof hash === 'string') {
        setOnChainTxHash(hash);
        setNotice(`sweepUnclaimed() transaction submitted (${hash.slice(0, 14)}…).`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not submit sweepUnclaimed() transaction.');
    } finally {
      setOnChainBusy(null);
    }
  }

  function downloadActivateTxJson() {
    if (!summary?.publishedMerkle) return;
    const tx = buildAirdropActivateTransaction({
      chainId: summary.publishedMerkle.chainId,
      distributor: summary.publishedMerkle.distributor as `0x${string}`,
      merkleRoot: summary.publishedMerkle.root as `0x${string}`,
      totalCommittedRaw: summary.publishedMerkle.totalCommittedRaw,
    });
    const blob = new Blob([JSON.stringify(tx, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `oneshot-distributor-activate-${tx.chainId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function copyOperatorValue(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${label} copied to clipboard.`);
    } catch {
      setError(`Could not copy ${label.toLowerCase()}.`);
    }
  }

  const rootMatchesPublished = Boolean(
    summary?.publishedMerkle &&
      distributorState &&
      distributorState.merkleRoot.toLowerCase() === summary.publishedMerkle.root.toLowerCase(),
  );
  const distributorFunded = Boolean(
    summary?.publishedMerkle &&
      distributorState?.tokenBalanceRaw !== undefined &&
      distributorState.tokenBalanceRaw >= BigInt(summary.publishedMerkle.totalCommittedRaw),
  );
  const claimDeadlinePassed = Boolean(
    distributorState && distributorState.claimDeadlineSec > 0 && Date.now() / 1000 > distributorState.claimDeadlineSec,
  );

  return (
    <section className="genesis-admin">
      <div className="genesis-admin-heading">
        <div>
          <h2>Token Airdrop &amp; LayerZero Snapshot</h2>
          <p className="genesis-helper">
            {summary
              ? `${summary.reservedSlots.toLocaleString()} / ${AIRDROP_GENERAL_SLOT_CAP.toLocaleString()} general slots · ${summary.reservedGeneralTokens.toLocaleString()} / ${AIRDROP_GENERAL_POOL.toLocaleString()} general tokens · ${summary.unlockedBoxes.toLocaleString()} unlocked boxes · ${summary.totalParticipants.toLocaleString()} participants`
              : 'Loading airdrop administration…'}
          </p>
        </div>
        <Button variant="secondary" onClick={() => void load()} loading={busy}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>

      {error && <ErrorState message={error} retry={() => void load()} />}
      {notice && <p className="genesis-notice" role="status">{notice}</p>}

      {summary && campaign && (
        <>
          <div className="airdrop-actions" style={{ marginBottom: 14 }} aria-label="Airdrop launch checklist">
            <Badge tone={summary.snapshot.total > 0 ? 'mint' : 'amber'}>
              1. Snapshot: {summary.snapshot.total > 0 ? `${summary.snapshot.total.toLocaleString()} wallets` : 'Pending'}
            </Badge>
            <Badge tone={campaign.state === 'open' || campaign.state === 'closed' ? 'mint' : 'amber'}>
              2. Missions: {campaign.state === 'open' ? 'Open' : campaign.state === 'closed' ? 'Closed' : 'Upcoming'}
            </Badge>
            <Badge tone={summary.publishedMerkle ? 'mint' : 'amber'}>
              3. Merkle Root: {summary.publishedMerkle ? 'Published' : 'Pending'}
            </Badge>
            <Badge tone={rootMatchesPublished ? 'mint' : 'neutral'}>
              4. Contract Active: {rootMatchesPublished ? 'Verified on-chain' : 'Pending check'}
            </Badge>
            <Badge tone={campaign.claimingOpen ? 'mint' : 'neutral'}>
              5. Claims: {campaign.claimingOpen ? 'Open' : 'Closed'}
            </Badge>
          </div>

          <div className="airdrop-admin-grid">
            <div className="panel">
              <h3>Campaign window &amp; X settings</h3>
              <Field label="Campaign state">
                <select
                  value={campaign.state}
                  onChange={e => patch({ state: e.target.value as AirdropCampaign['state'] })}
                >
                  <option value="upcoming">Upcoming</option>
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                </select>
              </Field>
              <Field label="Opens at (UTC)">
                <input
                  type="datetime-local"
                  value={campaign.opensAt?.slice(0, 16) || ''}
                  onChange={e =>
                    patch({ opensAt: e.target.value ? new Date(e.target.value + 'Z').toISOString() : null })
                  }
                />
              </Field>
              <Field label="Closes at (UTC)">
                <input
                  type="datetime-local"
                  value={campaign.closesAt?.slice(0, 16) || ''}
                  onChange={e =>
                    patch({ closesAt: e.target.value ? new Date(e.target.value + 'Z').toISOString() : null })
                  }
                />
              </Field>
              <Field label="Token name">
                <input
                  value={campaign.tokenName}
                  onChange={e => patch({ tokenName: e.target.value })}
                  maxLength={64}
                />
              </Field>
              <Field label="Token symbol">
                <input
                  value={campaign.tokenSymbol}
                  onChange={e => patch({ tokenSymbol: e.target.value })}
                  maxLength={16}
                />
              </Field>
              <Field label="Official X handle">
                <input
                  value={campaign.projectHandle}
                  onChange={e => patch({ projectHandle: e.target.value.replace(/^@/, '') })}
                  maxLength={15}
                  placeholder="oneshot"
                />
              </Field>
              <Field label="Official numeric X ID (optional, auto-filled from handle on open)">
                <input
                  value={campaign.projectXId}
                  onChange={e => patch({ projectXId: e.target.value })}
                  inputMode="numeric"
                  placeholder="Auto-resolved from X handle"
                  maxLength={32}
                />
              </Field>
              <Field label="Announcement X post URL or ID (for Like &amp; Repost)">
                <input
                  value={campaign.announcementPostId}
                  onChange={e => {
                    const raw = e.target.value.trim();
                    const extracted = airdropPostId(raw);
                    patch({ announcementPostId: extracted ?? raw });
                  }}
                  placeholder="Paste X announcement URL or numeric post ID"
                  maxLength={512}
                />
                {/^\d{1,32}$/.test(campaign.announcementPostId) && (
                  <span className="genesis-helper">Post ID: {campaign.announcementPostId}</span>
                )}
              </Field>
            </div>

            <div className="panel">
              <h3>Allocation, future trade mission &amp; contracts</h3>
              <Field label="Base winner tokens (5+ tx tier gets 50%)">
                <input
                  type="number"
                  min={1000}
                  max={500000}
                  value={campaign.baseWinnerTokens}
                  onChange={e => patch({ baseWinnerTokens: Number(e.target.value) })}
                />
              </Field>
              <Field label="Max general lock-in slots (up to 10,000)">
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={campaign.maxGeneralSlots}
                  onChange={e => patch({ maxGeneralSlots: Number(e.target.value) })}
                />
              </Field>
              <Field label="Daily GetXAPI read limit">
                <input
                  type="number"
                  min={0}
                  max={200000}
                  value={campaign.dailyReadLimit}
                  onChange={e => patch({ dailyReadLimit: Number(e.target.value) })}
                />
              </Field>
              <label className="genesis-helper">
                <input
                  type="checkbox"
                  checked={campaign.tradeMissionEnabled}
                  onChange={e => patch({ tradeMissionEnabled: e.target.checked })}
                />{' '}
                Enable future meme-token trade volume mission
              </label>
              <Field label="Min trade volume (raw native wei)">
                <input
                  value={campaign.minTradeNativeRaw}
                  onChange={e => patch({ minTradeNativeRaw: e.target.value })}
                  inputMode="numeric"
                />
              </Field>
              <label className="genesis-helper">
                <input
                  type="checkbox"
                  checked={campaign.claimingOpen}
                  onChange={e => patch({ claimingOpen: e.target.checked })}
                />{' '}
                On-chain claiming window open (requires Closed campaign state + matching published Merkle root)
              </label>
              <Field label="Distributor contract address">
                <input
                  value={campaign.distributorAddress || ''}
                  onChange={e => patch({ distributorAddress: e.target.value.trim() || null })}
                  placeholder="0x..."
                  maxLength={42}
                />
              </Field>
              <Field label="Campaign Chain ID (for claims)">
                <input
                  type="number"
                  min={1}
                  value={campaign.chainId ?? ''}
                  onChange={e =>
                    patch({
                      chainId:
                        e.target.value.trim() && Number.isSafeInteger(Number(e.target.value))
                          ? Number(e.target.value)
                          : null,
                    })
                  }
                  placeholder="84532"
                />
              </Field>
              <label className="genesis-helper">
                <input
                  type="checkbox"
                  checked={campaign.liveLayerZeroLookup}
                  onChange={e => patch({ liveLayerZeroLookup: e.target.checked })}
                />{' '}
                Enable live LayerZero verification (Arbitrum ZRO claim contract + LayerZero Scan API, auto-cached to DB)
              </label>
              <Field label="LayerZero 5+ tx historical cutoff (UTC)">
                <input
                  type="datetime-local"
                  value={campaign.snapshotCutoffAt?.slice(0, 16) || ''}
                  onChange={e =>
                    patch({ snapshotCutoffAt: e.target.value ? new Date(e.target.value + 'Z').toISOString() : null })
                  }
                />
              </Field>
              <p className="genesis-helper">
                X OAuth: {summary.oauthConfigured ? 'Configured' : 'Missing'} · GetXAPI:{' '}
                {summary.providerConfigured ? 'Configured' : 'Missing'} · Database:{' '}
                {summary.databaseConfigured ? 'PostgreSQL' : 'Local dev store'}
              </p>
            </div>
          </div>

          <div className="genesis-task-actions">
            <Button onClick={() => void saveCampaign()} disabled={busy}>
              Save airdrop settings
            </Button>
          </div>

          <div className="airdrop-admin-grid" style={{ marginTop: 20 }}>
            <div className="panel">
              <h3>Import LayerZero Snapshot</h3>
              <p className="genesis-helper">
                Snapshot wallets: <strong>{summary.snapshot.total.toLocaleString()}</strong> (
                {summary.snapshot.winners.toLocaleString()} LZ winners · {summary.snapshot.fiveTx.toLocaleString()} LZ 5+ tx)
              </p>
              <Field label="Import mode">
                <select value={importMode} onChange={e => setImportMode(e.target.value as 'merge' | 'replace')}>
                  <option value="merge">Merge with existing snapshot</option>
                  <option value="replace">Replace entire snapshot</option>
                </select>
              </Field>
              <Field label="Default tier (when CSV has no tier column)">
                <select
                  value={defaultTier}
                  onChange={e => setDefaultTier(e.target.value as 'auto' | AirdropSnapshotTier)}
                >
                  <option value="auto">Auto-detect from CSV columns</option>
                  <option value="lz_winner">LayerZero Winner (100% Share)</option>
                  <option value="lz_user_5tx">LayerZero 5+ Tx User (50% Share)</option>
                </select>
              </Field>
              <Field label="Upload CSV / TXT file (up to 50 MB in browser; use CLI for multi-million-row files)">
                <input
                  type="file"
                  accept=".csv,.txt"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.size > 50_000_000) {
                      setError('Snapshot file exceeds 50 MB in browser. Use `npm run airdrop:import-snapshot` CLI.');
                      e.target.value = '';
                      return;
                    }
                    void file.text().then(text => setCsvText(text));
                  }}
                />
              </Field>
              <Field label="Paste CSV lines (supports wallet,tier[,txCount], LayerZero allocation exports, or Dune tx_count)">
                <textarea
                  rows={5}
                  value={csvText}
                  onChange={e => setCsvText(e.target.value)}
                  placeholder="wallet,tier,txCount&#10;0x...,lz_winner,14&#10;0x...,lz_user_5tx,6"
                />
              </Field>
              <div className="genesis-task-actions">
                <Button onClick={() => void runSnapshotImport()} loading={importing} disabled={!csvText.trim()}>
                  <Upload size={14} /> {importProgress || 'Import snapshot'}
                </Button>
              </div>
            </div>

            <div className="panel">
              <h3>Merkle Tree Generator &amp; Publishing</h3>
              {summary.publishedMerkle ? (
                <p className="genesis-helper">
                  Published root: <code>{summary.publishedMerkle.root}</code> ({summary.publishedMerkle.recipientCount}{' '}
                  wallets on chain {summary.publishedMerkle.chainId})
                </p>
              ) : (
                <p className="genesis-helper">No Merkle tree has been published yet.</p>
              )}
              <Field label="Target Chain ID">
                <input
                  value={chainInput}
                  onChange={e => setChainInput(e.target.value)}
                  inputMode="numeric"
                  placeholder="84532"
                />
              </Field>
              <Field label="OneshotAirdropDistributor address">
                <input
                  value={distributorInput}
                  onChange={e => setDistributorInput(e.target.value)}
                  placeholder="0x..."
                  maxLength={42}
                />
              </Field>
              <div className="genesis-task-actions">
                <Button variant="secondary" loading={merkleBusy} onClick={() => void handleExportMerkle(false)}>
                  Preview Merkle root
                </Button>
                <Button loading={merkleBusy} onClick={() => void handleExportMerkle(true)}>
                  Publish proofs
                </Button>
                {merkleResult && (
                  <Button variant="ghost" onClick={downloadMerkleJson}>
                    <Download size={14} /> Download JSON
                  </Button>
                )}
              </div>
              {merkleResult && (
                <div className="genesis-helper" style={{ marginTop: 12 }}>
                  <Badge tone="mint">{merkleResult.recipientCount.toLocaleString()} recipients</Badge>{' '}
                  <span>Root: <code>{merkleResult.root}</code></span>
                </div>
              )}
            </div>
          </div>

          {(summary.publishedMerkle || campaign.distributorAddress) && (
            <div className="panel" style={{ marginTop: 20 }}>
              <h3>On-Chain Distributor Activation &amp; Sweep</h3>
              {onChainTxHash && (
                <p className="genesis-notice" role="status">
                  Submitted transaction: <code>{onChainTxHash}</code>
                </p>
              )}
              {summary.publishedMerkle ? (
                <p className="genesis-helper">
                  Published root: <code>{summary.publishedMerkle.root}</code> · Committed:{' '}
                  <strong>{formatIndexedAmount(summary.publishedMerkle.totalCommittedRaw, 8)}</strong>{' '}
                  {campaign.tokenSymbol} across {summary.publishedMerkle.recipientCount.toLocaleString()} wallets on
                  chain {summary.publishedMerkle.chainId}.
                </p>
              ) : (
                <p className="genesis-helper">
                  Distributor: <code>{campaign.distributorAddress}</code> (publish Merkle proofs before activating).
                </p>
              )}

              {distributorState && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                  <div className="info-row">
                    <span>On-chain Merkle root</span>
                    <strong>
                      {distributorState.merkleRoot === ZERO_ROOT ? (
                        'Not activated yet'
                      ) : rootMatchesPublished ? (
                        <Badge tone="mint">
                          <Check size={11} /> Matches published root
                        </Badge>
                      ) : (
                        <Badge tone="amber">Mismatch ({distributorState.merkleRoot.slice(0, 12)}…)</Badge>
                      )}
                    </strong>
                  </div>
                  <div className="info-row">
                    <span>Distributor token balance</span>
                    <strong>
                      {distributorState.tokenBalanceRaw !== undefined
                        ? `${formatIndexedAmount(distributorState.tokenBalanceRaw.toString(), 8)} ${campaign.tokenSymbol}`
                        : 'Unknown'}{' '}
                      {summary.publishedMerkle && (
                        <Badge tone={distributorFunded ? 'mint' : 'amber'}>
                          {distributorFunded ? 'Funded' : 'Insufficient balance'}
                        </Badge>
                      )}
                    </strong>
                  </div>
                  <div className="info-row">
                    <span>Claimed / Withdrawn</span>
                    <strong>
                      {formatIndexedAmount(distributorState.totalClaimedInitiatedRaw.toString(), 8)} claimed ·{' '}
                      {formatIndexedAmount(distributorState.totalWithdrawnRaw.toString(), 8)} withdrawn
                    </strong>
                  </div>
                  <div className="info-row">
                    <span>Admin · Claim deadline</span>
                    <strong>
                      <code>{distributorState.admin}</code> ·{' '}
                      {distributorState.claimDeadlineSec > 0
                        ? new Date(distributorState.claimDeadlineSec * 1000).toISOString()
                        : 'Not set'}
                    </strong>
                  </div>
                </div>
              )}

              <div className="genesis-task-actions" style={{ marginTop: 14 }}>
                <Button
                  variant="secondary"
                  loading={onChainBusy === 'check'}
                  disabled={Boolean(onChainBusy)}
                  onClick={() => void checkOnChainDistributor()}
                >
                  <ShieldCheck size={14} /> Check contract status
                </Button>
                {summary.publishedMerkle && (
                  <>
                    <Button
                      loading={onChainBusy === 'activate'}
                      disabled={Boolean(onChainBusy) || rootMatchesPublished}
                      onClick={() => void activateOnChainDistributor()}
                    >
                      Activate distributor on-chain
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        try {
                          const tx = buildAirdropActivateTransaction({
                            chainId: summary.publishedMerkle!.chainId,
                            distributor: summary.publishedMerkle!.distributor as `0x${string}`,
                            merkleRoot: summary.publishedMerkle!.root as `0x${string}`,
                            totalCommittedRaw: summary.publishedMerkle!.totalCommittedRaw,
                          });
                          void copyOperatorValue(tx.data, 'activate() calldata');
                        } catch (reason) {
                          setError(reason instanceof Error ? reason.message : 'Could not build activate() calldata.');
                        }
                      }}
                    >
                      <Copy size={13} /> Copy activate() calldata
                    </Button>
                    <Button variant="ghost" onClick={downloadActivateTxJson}>
                      <Download size={13} /> Download unsigned activate TX JSON
                    </Button>
                  </>
                )}
              </div>

              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
                <Field label="Post-deadline sweep recipient (0x...) — only unclaimed tokens after claimDeadline">
                  <input
                    value={sweepRecipient}
                    onChange={e => setSweepRecipient(e.target.value)}
                    placeholder="0x..."
                    maxLength={42}
                  />
                </Field>
                <div className="genesis-task-actions">
                  <Button
                    variant="secondary"
                    loading={onChainBusy === 'sweep'}
                    disabled={Boolean(onChainBusy) || !claimDeadlinePassed || !sweepRecipient.trim()}
                    onClick={() => void sweepUnclaimedOnChain()}
                  >
                    Sweep unclaimed tokens
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={
                      !sweepRecipient.trim() ||
                      !/^0x[\da-fA-F]{40}$/.test(sweepRecipient.trim()) ||
                      /^0x0{40}$/i.test(sweepRecipient.trim()) ||
                      !(
                        summary.publishedMerkle?.distributor ||
                        (campaign.distributorAddress && campaign.distributorAddress !== ZERO_ADDRESS)
                      )
                    }
                    onClick={() => {
                      try {
                        const targetChainId = summary.publishedMerkle?.chainId ?? campaign.chainId ?? 1;
                        const targetDistributor = (summary.publishedMerkle?.distributor ??
                          campaign.distributorAddress) as `0x${string}`;
                        if (!targetDistributor || targetDistributor === ZERO_ADDRESS) {
                          throw new Error('Set a valid OneshotAirdropDistributor address first.');
                        }
                        const tx = buildAirdropSweepTransaction({
                          chainId: targetChainId,
                          distributor: targetDistributor,
                          recipient: sweepRecipient.trim() as `0x${string}`,
                        });
                        void copyOperatorValue(tx.data, 'sweepUnclaimed() calldata');
                      } catch (reason) {
                        setError(reason instanceof Error ? reason.message : 'Could not build sweepUnclaimed() calldata.');
                      }
                    }}
                  >
                    <Copy size={13} /> Copy sweepUnclaimed() calldata
                  </Button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
