import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from 'viem';
import {
  AIRDROP_DISTRIBUTOR_ABI,
  AIRDROP_TOKENOMICS,
  ONESHOT_TOKEN_ABI,
  encodeAirdropDistributorReadCalls,
  encodeErc20BalanceOfData,
} from '@oneshot/evm';
import { memoryAirdropStore } from '../apps/api/lib/server/airdrop-store';
import { createAirdropService } from '../apps/api/lib/server/airdrop-service';
import type { AirdropVerifier } from '../apps/api/lib/server/airdrop-verification';
import type { GenesisSession } from '../apps/api/lib/server/genesis-auth';
import { AIRDROP_CONSENT_VERSION } from '../apps/web/lib/airdrop-schema';
import {
  airdropOpsExportMerkle,
  airdropOpsOpenClaims,
  airdropOpsSetState,
  airdropOpsStatus,
  airdropOpsSweepPlan,
} from './lib/airdrop-ops';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Step 3 Airdrop campaign operations workflow', () => {
  const accWinner = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  const distributor = '0x7777777777777777777777777777777777777777' as Address;
  const tokenAddr = '0x8888888888888888888888888888888888888888' as Address;
  const adminAddr = '0x9999999999999999999999999999999999999999' as Address;
  const treasury = '0x6666666666666666666666666666666666666666' as Address;

  it('walks snapshot -> open -> close -> Merkle publish + activate tx -> verified RPC open-claims -> sweep plan', async () => {
    vi.stubEnv('X_OAUTH_CLIENT_ID', 'ops-client-id');
    const now = Date.parse('2026-11-23T00:00:00Z');
    const store = memoryAirdropStore();
    const verifier: AirdropVerifier = {
      projectHandle: vi.fn(async () => 'oneshot'),
      verifyFollow: vi.fn(async () => ({
        state: 'verified' as const,
        message: 'Following @oneshot',
        checkedAt: new Date(now).toISOString(),
      })),
      verifyRepost: vi.fn(async () => ({
        state: 'verified' as const,
        message: 'Repost verified',
        checkedAt: new Date(now).toISOString(),
      })),
      verifyPost: vi.fn(async (profile, _c, postUrl) => ({
        postId: postUrl.split('/').pop()!,
        postUrl,
        metrics: { likes: 10, reposts: 2, replies: 1, views: 200 },
        engagementScore: 33,
      })),
      refreshPost: vi.fn(async () => ({
        metrics: { likes: 10, reposts: 2, replies: 1, views: 200 },
        engagementScore: 33,
      })),
      verifyCreatedToken: vi.fn(async () => ({
        state: 'verified' as const,
        message: 'Token created',
        checkedAt: new Date(now).toISOString(),
        evidenceId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      })),
      verifyTradeVolume: vi.fn(async () => ({
        state: 'needs_action' as const,
        message: 'No volume yet',
        checkedAt: new Date(now).toISOString(),
      })),
    };

    const service = createAirdropService({
      store,
      verifier,
      now: () => now,
      webOrigin: () => 'https://oneshot.example.com',
    });

    await service.importSnapshot(
      { mode: 'replace', csvText: `address,isEligible,zroAllocation\n${accWinner.address},true,1200` },
      'cli:test',
    );
    expect((await airdropOpsStatus(service)).readiness).toMatchObject({
      snapshotLoaded: true,
      campaignOpen: false,
      merklePublished: false,
      claimingOpen: false,
    });

    await airdropOpsSetState(service, {
      state: 'open',
      actor: 'cli:test',
      overrides: { projectXId: '100', projectHandle: 'oneshot', announcementPostId: '9001' },
    });

    const session: GenesisSession = {
      provider: 'x',
      userId: 'x:1',
      sessionId: 'sess-1',
      expiresAt: 9_999_999_999,
      linkedAddresses: [],
      xAccount: { id: '1', username: 'alice', name: 'Alice', avatarUrl: null },
    };
    await service.enroll(session, AIRDROP_CONSENT_VERSION);
    const challenge = await service.walletChallenge(session, accWinner.address);
    const sig = await accWinner.signMessage({ message: challenge.message });
    await service.bindWallet(session, {
      wallet: accWinner.address,
      signature: sig,
      expectedRevision: challenge.expectedRevision,
    });
    await service.verifyMission(session, 'follow');
    await service.verifyMission(session, 'repost');
    await service.verifyMission(session, 'post', 'https://x.com/alice/status/123');
    await service.verifyMission(session, 'create_token');

    await airdropOpsSetState(service, { state: 'closed', actor: 'cli:test' });

    const exported = await airdropOpsExportMerkle(service, {
      chainId: 84532,
      distributor,
      publish: true,
      actor: 'cli:test',
    });
    expect(exported.published).toBe(true);
    expect(exported.recipientCount).toBe(1);
    expect(exported.activateTransaction).not.toBeNull();
    const decodedActivate = decodeFunctionData({
      abi: AIRDROP_DISTRIBUTOR_ABI,
      data: exported.activateTransaction!.data,
    });
    expect(decodedActivate.functionName).toBe('activate');
    expect(decodedActivate.args).toEqual([exported.root, BigInt(exported.totalCommittedRaw)]);

    // Wrong root confirmation must reject cleanly before touching campaign
    await expect(
      airdropOpsOpenClaims(service, { confirmOnchainRoot: ('0x' + '11'.repeat(32)) as Hex, actor: 'cli:test' }),
    ).rejects.toThrow(/does not match/);

    const readCalls = encodeAirdropDistributorReadCalls();
    const balanceCall = encodeErc20BalanceOfData(distributor);
    let rpcChainHex: Hex = '0x14a34'; // 84532
    const mockRpc = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: Array<{ to?: string; data?: Hex }> };
      if (body.method === 'eth_chainId') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: rpcChainHex }), { status: 200 });
      }
      const { to, data } = body.params[0]!;
      let result: Hex = '0x';
      if (to?.toLowerCase() === distributor.toLowerCase()) {
        if (data === readCalls.merkleRoot) {
          result = encodeFunctionResult({
            abi: AIRDROP_DISTRIBUTOR_ABI,
            functionName: 'merkleRoot',
            result: exported.root,
          });
        } else if (data === readCalls.totalCommitted) {
          result = encodeFunctionResult({
            abi: AIRDROP_DISTRIBUTOR_ABI,
            functionName: 'totalCommitted',
            result: BigInt(exported.totalCommittedRaw),
          });
        } else if (data === readCalls.totalClaimedInitiated) {
          result = encodeFunctionResult({
            abi: AIRDROP_DISTRIBUTOR_ABI,
            functionName: 'totalClaimedInitiated',
            result: 0n,
          });
        } else if (data === readCalls.totalWithdrawn) {
          result = encodeFunctionResult({ abi: AIRDROP_DISTRIBUTOR_ABI, functionName: 'totalWithdrawn', result: 0n });
        } else if (data === readCalls.claimDeadline) {
          result = encodeFunctionResult({
            abi: AIRDROP_DISTRIBUTOR_ABI,
            functionName: 'claimDeadline',
            result: 1_800_000_000n,
          });
        } else if (data === readCalls.admin) {
          result = encodeFunctionResult({ abi: AIRDROP_DISTRIBUTOR_ABI, functionName: 'admin', result: adminAddr });
        } else if (data === readCalls.token) {
          result = encodeFunctionResult({ abi: AIRDROP_DISTRIBUTOR_ABI, functionName: 'token', result: tokenAddr });
        }
      } else if (to?.toLowerCase() === tokenAddr.toLowerCase() && data === balanceCall) {
        result = encodeFunctionResult({
          abi: ONESHOT_TOKEN_ABI,
          functionName: 'balanceOf',
          result: AIRDROP_TOKENOMICS.airdropRaw,
        });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
    }) as unknown as typeof fetch;

    // Wrong RPC chain ID (e.g. mainnet 0x1 instead of published 84532) must abort cleanly
    rpcChainHex = '0x1';
    await expect(
      airdropOpsOpenClaims(service, {
        confirmOnchainRoot: exported.root,
        actor: 'cli:test',
        rpcUrl: 'https://rpc.oneshot.example',
        fetcher: mockRpc,
      }),
    ).rejects.toThrow(/chainId \(1\) does not match expected chainId \(84532\)/);

    rpcChainHex = '0x14a34';
    const opened = await airdropOpsOpenClaims(service, {
      confirmOnchainRoot: exported.root,
      actor: 'cli:test',
      rpcUrl: 'https://rpc.oneshot.example',
      fetcher: mockRpc,
    });
    expect(opened.campaign.claimingOpen).toBe(true);
    expect(opened.onChain?.activated).toBe(true);

    const sweep = airdropOpsSweepPlan({ chainId: 84532, distributor, recipient: treasury });
    const decodedSweep = decodeFunctionData({ abi: AIRDROP_DISTRIBUTOR_ABI, data: sweep.data });
    expect(decodedSweep.functionName).toBe('sweepUnclaimed');
    expect(decodedSweep.args).toEqual([treasury]);
  });
});
