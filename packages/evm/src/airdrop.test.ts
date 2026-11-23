import { describe, expect, it } from 'vitest';
import { concatHex, decodeFunctionData, encodeFunctionResult, keccak256, zeroHash, type Hex } from 'viem';
import {
  AIRDROP_DISTRIBUTOR_ABI,
  AIRDROP_TOKENOMICS,
  ONESHOT_TOKEN_ABI,
  airdropClaimLeaf,
  buildAirdropActivateTransaction,
  buildAirdropMerkleTree,
  buildAirdropSweepTransaction,
  computeAirdropUnlockSchedule,
  decodeAirdropDistributorState,
  encodeAirdropActivateData,
  encodeAirdropDistributorReadCalls,
  encodeAirdropSweepUnclaimedData,
  encodeErc20BalanceOfData,
} from './airdrop';

function verifyProof(proof: readonly Hex[], root: Hex, leaf: Hex): boolean {
  let computed = leaf;
  for (const item of proof) {
    computed = keccak256(concatHex(computed < item ? [computed, item] : [item, computed]));
  }
  return computed === root;
}

describe('Airdrop Merkle tree and 7d lock / 7d daily unlock SDK', () => {
  const distributor = '0x1111111111111111111111111111111111111111' as const;
  const alice = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
  const bob = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
  const charlie = '0xcccccccccccccccccccccccccccccccccccccccc' as const;

  it('builds verifiable sorted-pair Merkle proofs bound to chainId and distributor', () => {
    const tree = buildAirdropMerkleTree(
      [
        { wallet: `0x${charlie.slice(2).toUpperCase()}`, amountRaw: 15_000_000_000_000n },
        { wallet: alice, amountRaw: 4_000_000_000_000n },
        { wallet: bob, amountRaw: 2_000_000_000_000n },
      ],
      84532,
      distributor,
    );

    expect(tree.totalCommittedRaw).toBe(21_000_000_000_000n);
    expect(tree.entries.map(e => e.wallet)).toEqual([alice, bob, charlie]);

    for (const entry of tree.entries) {
      const leaf = airdropClaimLeaf(84532, distributor, entry.wallet, entry.amountRaw);
      expect(verifyProof(entry.proof, tree.root, leaf)).toBe(true);
      // Different chainId or distributor must fail verification
      const wrongChainLeaf = airdropClaimLeaf(31337, distributor, entry.wallet, entry.amountRaw);
      expect(verifyProof(entry.proof, tree.root, wrongChainLeaf)).toBe(false);
    }
  });

  it('rejects duplicate wallets, zero amounts, and exceeding the 510M cap', () => {
    expect(() =>
      buildAirdropMerkleTree(
        [
          { wallet: alice, amountRaw: 100n },
          { wallet: `0x${alice.slice(2).toUpperCase()}`, amountRaw: 200n },
        ],
        31337,
        distributor,
      ),
    ).toThrow(/Duplicate wallet/);

    expect(() =>
      buildAirdropMerkleTree([{ wallet: alice, amountRaw: 0n }], 31337, distributor),
    ).toThrow(/positive/);

    expect(() =>
      buildAirdropMerkleTree(
        [
          { wallet: alice, amountRaw: AIRDROP_TOKENOMICS.airdropRaw },
          { wallet: bob, amountRaw: 1n },
        ],
        31337,
        distributor,
      ),
    ).toThrow(/510,000,000/);
  });

  it('computes exact 7-day lock followed by 7 daily linear tranches', () => {
    const total = 7_000_000_000_000n;
    const claimedAt = 1_000_000;
    const day = 86_400;

    // Day 0 -> Day 7: fully locked
    expect(
      computeAirdropUnlockSchedule({ totalAmountRaw: total, claimedAtSec: claimedAt, withdrawnRaw: 0n, nowSec: claimedAt }),
    ).toMatchObject({ phase: 'locked', unlockedDays: 0, unlockedAmountRaw: 0n, withdrawableRaw: 0n, remainingLockedRaw: total });

    expect(
      computeAirdropUnlockSchedule({ totalAmountRaw: total, claimedAtSec: claimedAt, withdrawnRaw: 0n, nowSec: claimedAt + 7 * day }),
    ).toMatchObject({ phase: 'locked', unlockedDays: 0, unlockedAmountRaw: 0n, withdrawableRaw: 0n, nextUnlockAtSec: claimedAt + 8 * day });

    // Day 8: 1/7 unlocked
    const d8 = computeAirdropUnlockSchedule({
      totalAmountRaw: total,
      claimedAtSec: claimedAt,
      withdrawnRaw: 0n,
      nowSec: claimedAt + 8 * day,
    });
    expect(d8.phase).toBe('unlocking');
    expect(d8.unlockedDays).toBe(1);
    expect(d8.unlockedAmountRaw).toBe(1_000_000_000_000n);
    expect(d8.withdrawableRaw).toBe(1_000_000_000_000n);
    expect(d8.remainingLockedRaw).toBe(6_000_000_000_000n);

    // Day 11 with 1/7 already withdrawn
    const d11 = computeAirdropUnlockSchedule({
      totalAmountRaw: total,
      claimedAtSec: claimedAt,
      withdrawnRaw: 1_000_000_000_000n,
      nowSec: claimedAt + 11 * day,
    });
    expect(d11.unlockedDays).toBe(4);
    expect(d11.unlockedAmountRaw).toBe(4_000_000_000_000n);
    expect(d11.withdrawableRaw).toBe(3_000_000_000_000n);

    // Day 14+: 100% unlocked
    const d14 = computeAirdropUnlockSchedule({
      totalAmountRaw: total,
      claimedAtSec: claimedAt,
      withdrawnRaw: 4_000_000_000_000n,
      nowSec: claimedAt + 14 * day,
    });
    expect(d14.phase).toBe('fully_unlocked');
    expect(d14.unlockedDays).toBe(7);
    expect(d14.unlockedAmountRaw).toBe(total);
    expect(d14.withdrawableRaw).toBe(3_000_000_000_000n);
    expect(d14.remainingLockedRaw).toBe(0n);
  });

  it('builds and validates admin activate, sweepUnclaimed, and distributor read call helpers', () => {
    const root = ('0x' + 'ab'.repeat(32)) as Hex;
    const tokenAddr = '0x2222222222222222222222222222222222222222' as const;
    const recipient = '0x3333333333333333333333333333333333333333' as const;

    const activateTx = buildAirdropActivateTransaction({
      chainId: 84532,
      distributor,
      merkleRoot: root,
      totalCommittedRaw: 4_000_000_000_000n,
    });
    expect(activateTx.to).toBe(distributor);
    expect(activateTx.value).toBe('0x0');
    const decodedActivate = decodeFunctionData({ abi: AIRDROP_DISTRIBUTOR_ABI, data: activateTx.data });
    expect(decodedActivate.functionName).toBe('activate');
    expect(decodedActivate.args).toEqual([root, 4_000_000_000_000n]);

    const sweepTx = buildAirdropSweepTransaction({ chainId: 84532, distributor, recipient });
    const decodedSweep = decodeFunctionData({ abi: AIRDROP_DISTRIBUTOR_ABI, data: sweepTx.data });
    expect(decodedSweep.functionName).toBe('sweepUnclaimed');
    expect(decodedSweep.args).toEqual([recipient]);

    expect(() => encodeAirdropActivateData(zeroHash, 100n)).toThrow(/nonzero/);
    expect(() => encodeAirdropSweepUnclaimedData('0x0000000000000000000000000000000000000000')).toThrow(/nonzero/);

    const reads = encodeAirdropDistributorReadCalls();
    expect(decodeFunctionData({ abi: AIRDROP_DISTRIBUTOR_ABI, data: reads.merkleRoot }).functionName).toBe('merkleRoot');
    expect(decodeFunctionData({ abi: ONESHOT_TOKEN_ABI, data: encodeErc20BalanceOfData(distributor) }).args).toEqual([
      distributor,
    ]);

    const decodedState = decodeAirdropDistributorState({
      merkleRoot: encodeFunctionResult({ abi: AIRDROP_DISTRIBUTOR_ABI, functionName: 'merkleRoot', result: root }),
      totalCommitted: encodeFunctionResult({
        abi: AIRDROP_DISTRIBUTOR_ABI,
        functionName: 'totalCommitted',
        result: 4_000_000_000_000n,
      }),
      totalClaimedInitiated: encodeFunctionResult({
        abi: AIRDROP_DISTRIBUTOR_ABI,
        functionName: 'totalClaimedInitiated',
        result: 1_000_000_000_000n,
      }),
      totalWithdrawn: encodeFunctionResult({
        abi: AIRDROP_DISTRIBUTOR_ABI,
        functionName: 'totalWithdrawn',
        result: 0n,
      }),
      claimDeadline: encodeFunctionResult({
        abi: AIRDROP_DISTRIBUTOR_ABI,
        functionName: 'claimDeadline',
        result: 2_000_000n,
      }),
      admin: encodeFunctionResult({ abi: AIRDROP_DISTRIBUTOR_ABI, functionName: 'admin', result: recipient }),
      token: encodeFunctionResult({ abi: AIRDROP_DISTRIBUTOR_ABI, functionName: 'token', result: tokenAddr }),
      tokenBalance: encodeFunctionResult({
        abi: ONESHOT_TOKEN_ABI,
        functionName: 'balanceOf',
        result: AIRDROP_TOKENOMICS.airdropRaw,
      }),
    });
    expect(decodedState).toMatchObject({
      merkleRoot: root,
      activated: true,
      totalCommittedRaw: 4_000_000_000_000n,
      claimDeadlineSec: 2_000_000,
      admin: recipient,
      token: tokenAddr,
      tokenBalanceRaw: AIRDROP_TOKENOMICS.airdropRaw,
    });
  });
});
