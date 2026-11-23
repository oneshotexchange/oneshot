import {
  buildAirdropActivateTransaction,
  buildAirdropSweepTransaction,
  decodeAirdropDistributorState,
  encodeAirdropDistributorReadCalls,
  encodeErc20BalanceOfData,
  type AirdropActivateTransaction,
  type AirdropSweepTransaction,
} from '@oneshot/evm';
import type { Address, Hex } from 'viem';
import type { airdropService as defaultAirdropService } from '../../apps/api/lib/server/airdrop-service';
import type { AirdropCampaign } from '../../apps/web/lib/airdrop-schema';

export type AirdropOpsService = Pick<
  typeof defaultAirdropService,
  'adminSummary' | 'configure' | 'exportMerkle'
>;

export type AirdropRpcFetcher = typeof fetch;

export type SerializedDistributorState = {
  merkleRoot: Hex;
  activated: boolean;
  totalCommittedRaw: string;
  totalClaimedInitiatedRaw: string;
  totalWithdrawnRaw: string;
  claimDeadlineSec: number;
  admin: Address;
  token: Address;
  tokenBalanceRaw: string;
};

async function ethCallRpc(rpcUrl: string, to: Address, data: Hex, fetcher: AirdropRpcFetcher): Promise<Hex> {
  const url = new URL(rpcUrl);
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('RPC URL must use http or https.');
  }
  const response = await fetcher(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`RPC eth_call failed with HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (payload.error || typeof payload.result !== 'string' || !payload.result.startsWith('0x')) {
    throw new Error(payload.error?.message || 'Unexpected RPC eth_call response.');
  }
  return payload.result as Hex;
}

async function ethChainIdRpc(rpcUrl: string, fetcher: AirdropRpcFetcher): Promise<number> {
  const url = new URL(rpcUrl);
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('RPC URL must use http or https.');
  }
  const response = await fetcher(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`RPC eth_chainId failed with HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (payload.error || typeof payload.result !== 'string' || !/^0x[\da-fA-F]+$/.test(payload.result)) {
    throw new Error(payload.error?.message || 'Unexpected RPC eth_chainId response.');
  }
  return Number.parseInt(payload.result, 16);
}

export async function airdropOpsStatus(service: AirdropOpsService) {
  const summary = await service.adminSummary();
  return {
    ...summary,
    readiness: {
      snapshotLoaded: summary.snapshot.total > 0,
      campaignOpen: summary.campaign.state === 'open',
      campaignClosed: summary.campaign.state === 'closed',
      merklePublished: summary.publishedMerkle !== null,
      claimingOpen: summary.campaign.claimingOpen,
    },
  };
}

export async function airdropOpsSetState(
  service: AirdropOpsService,
  input: {
    state: 'open' | 'closed' | 'upcoming';
    actor: string;
    overrides?: Partial<
      Pick<
        AirdropCampaign,
        | 'opensAt'
        | 'closesAt'
        | 'tokenName'
        | 'tokenSymbol'
        | 'projectXId'
        | 'projectHandle'
        | 'announcementPostId'
        | 'baseWinnerTokens'
        | 'maxGeneralSlots'
        | 'dailyReadLimit'
        | 'tradeMissionEnabled'
        | 'minTradeNativeRaw'
        | 'claimDeadline'
        | 'snapshotCutoffAt'
        | 'liveLayerZeroLookup'
      >
    >;
  },
) {
  const { campaign } = await service.adminSummary();
  return service.configure(
    {
      ...campaign,
      ...input.overrides,
      state: input.state,
    },
    campaign.revision,
    input.actor,
  );
}

export async function airdropOpsExportMerkle(
  service: AirdropOpsService,
  input: {
    chainId: number;
    distributor: Address;
    publish: boolean;
    actor: string;
  },
): Promise<
  Awaited<ReturnType<AirdropOpsService['exportMerkle']>> & {
    activateTransaction: AirdropActivateTransaction | null;
  }
> {
  const exported = await service.exportMerkle(
    {
      chainId: input.chainId,
      distributor: input.distributor,
      publish: input.publish,
    },
    input.actor,
  );

  const activateTransaction =
    exported.recipientCount > 0 && BigInt(exported.totalCommittedRaw) > 0n
      ? buildAirdropActivateTransaction({
          chainId: exported.chainId,
          distributor: exported.distributor as Address,
          merkleRoot: exported.root,
          totalCommittedRaw: exported.totalCommittedRaw,
        })
      : null;

  return {
    ...exported,
    activateTransaction,
  };
}

export async function airdropOpsVerifyOnChainDistributor(input: {
  rpcUrl: string;
  expectedChainId?: number;
  distributor: Address;
  expectedRoot: Hex;
  expectedCommittedRaw: bigint | string;
  fetcher?: AirdropRpcFetcher;
}): Promise<SerializedDistributorState> {
  const fetcher = input.fetcher || fetch;
  const calls = encodeAirdropDistributorReadCalls();

  const [merkleRoot, totalCommitted, totalClaimedInitiated, totalWithdrawn, claimDeadline, admin, token, actualChainId] =
    await Promise.all([
      ethCallRpc(input.rpcUrl, input.distributor, calls.merkleRoot, fetcher),
      ethCallRpc(input.rpcUrl, input.distributor, calls.totalCommitted, fetcher),
      ethCallRpc(input.rpcUrl, input.distributor, calls.totalClaimedInitiated, fetcher),
      ethCallRpc(input.rpcUrl, input.distributor, calls.totalWithdrawn, fetcher),
      ethCallRpc(input.rpcUrl, input.distributor, calls.claimDeadline, fetcher),
      ethCallRpc(input.rpcUrl, input.distributor, calls.admin, fetcher),
      ethCallRpc(input.rpcUrl, input.distributor, calls.token, fetcher),
      input.expectedChainId !== undefined ? ethChainIdRpc(input.rpcUrl, fetcher) : Promise.resolve(null),
    ]);

  if (input.expectedChainId !== undefined && actualChainId !== input.expectedChainId) {
    throw new Error(`On-chain RPC chainId (${actualChainId}) does not match expected chainId (${input.expectedChainId}).`);
  }

  const initialState = decodeAirdropDistributorState({
    merkleRoot,
    totalCommitted,
    totalClaimedInitiated,
    totalWithdrawn,
    claimDeadline,
    admin,
    token,
  });

  const tokenBalance = await ethCallRpc(
    input.rpcUrl,
    initialState.token,
    encodeErc20BalanceOfData(input.distributor),
    fetcher,
  );

  const state = decodeAirdropDistributorState({
    merkleRoot,
    totalCommitted,
    totalClaimedInitiated,
    totalWithdrawn,
    claimDeadline,
    admin,
    token,
    tokenBalance,
  });

  if (state.merkleRoot.toLowerCase() !== input.expectedRoot.toLowerCase()) {
    throw new Error(
      `On-chain distributor merkleRoot (${state.merkleRoot}) does not match expected root (${input.expectedRoot}).`,
    );
  }
  const expectedRaw = BigInt(input.expectedCommittedRaw);
  if (state.totalCommittedRaw < expectedRaw) {
    throw new Error(
      `On-chain totalCommitted (${state.totalCommittedRaw}) is below expected commitment (${expectedRaw}).`,
    );
  }
  if ((state.tokenBalanceRaw ?? 0n) < expectedRaw) {
    throw new Error(
      `Distributor token balance (${state.tokenBalanceRaw ?? 0n}) is below expected commitment (${expectedRaw}).`,
    );
  }

  return {
    merkleRoot: state.merkleRoot,
    activated: state.activated,
    totalCommittedRaw: state.totalCommittedRaw.toString(),
    totalClaimedInitiatedRaw: state.totalClaimedInitiatedRaw.toString(),
    totalWithdrawnRaw: state.totalWithdrawnRaw.toString(),
    claimDeadlineSec: state.claimDeadlineSec,
    admin: state.admin,
    token: state.token,
    tokenBalanceRaw: (state.tokenBalanceRaw ?? 0n).toString(),
  };
}

export async function airdropOpsOpenClaims(
  service: AirdropOpsService,
  input: {
    confirmOnchainRoot: Hex;
    actor: string;
    claimDeadline?: string | null;
    rpcUrl?: string;
    fetcher?: AirdropRpcFetcher;
  },
) {
  const summary = await service.adminSummary();
  const merkle = summary.publishedMerkle;
  if (!merkle) {
    throw new Error('Publish the finalized Merkle tree before opening claims.');
  }
  if (merkle.root.toLowerCase() !== input.confirmOnchainRoot.toLowerCase()) {
    throw new Error(
      `Confirmed root ${input.confirmOnchainRoot} does not match published Merkle root ${merkle.root}.`,
    );
  }

  let onChain: SerializedDistributorState | null = null;
  if (input.rpcUrl) {
    onChain = await airdropOpsVerifyOnChainDistributor({
      rpcUrl: input.rpcUrl,
      expectedChainId: merkle.chainId,
      distributor: merkle.distributor as Address,
      expectedRoot: merkle.root as Hex,
      expectedCommittedRaw: merkle.totalCommittedRaw,
      fetcher: input.fetcher,
    });
  }

  const nextDeadline =
    input.claimDeadline !== undefined
      ? input.claimDeadline
      : summary.campaign.claimDeadline ||
        (onChain && onChain.claimDeadlineSec > 0 ? new Date(onChain.claimDeadlineSec * 1000).toISOString() : null);

  const updated = await service.configure(
    {
      ...summary.campaign,
      state: 'closed',
      chainId: merkle.chainId,
      distributorAddress: merkle.distributor.toLowerCase(),
      claimingOpen: true,
      claimDeadline: nextDeadline,
    },
    summary.campaign.revision,
    input.actor,
  );

  return {
    campaign: updated,
    publishedMerkle: merkle,
    onChain,
  };
}

export function airdropOpsSweepPlan(input: {
  chainId: number;
  distributor: Address;
  recipient: Address;
}): AirdropSweepTransaction {
  return buildAirdropSweepTransaction(input);
}
