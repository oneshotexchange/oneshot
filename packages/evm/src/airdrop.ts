import {
  concatHex,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';

export const AIRDROP_CLAIM_DOMAIN = keccak256(stringToHex('ONESHOT_AIRDROP_CLAIM_V1'));

export const AIRDROP_TOKENOMICS = {
  totalSupplyWhole: 1_000_000_000,
  decimals: 8,
  totalSupplyRaw: 100_000_000_000_000_000n,
  airdropWhole: 510_000_000,
  airdropRaw: 51_000_000_000_000_000n,
  airdropGeneralWhole: 410_000_000,
  airdropGeneralRaw: 41_000_000_000_000_000n,
  airdropTop500Whole: 100_000_000,
  airdropTop500Raw: 10_000_000_000_000_000n,
  liquidityWhole: 250_000_000,
  liquidityRaw: 25_000_000_000_000_000n,
  teamWhole: 100_000_000,
  teamRaw: 10_000_000_000_000_000n,
  ecosystemWhole: 90_000_000,
  ecosystemRaw: 9_000_000_000_000_000n,
  treasuryWhole: 50_000_000,
  treasuryRaw: 5_000_000_000_000_000n,
  openingFdvUsd: 960_000,
  teamVestingDays: 730,
  claimLockDays: 7,
  claimUnlockDays: 7,
} as const;

export const ONESHOT_TOKEN_ABI = parseAbi([
  'constructor(string name_, string symbol_)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() pure returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function TOTAL_SUPPLY() view returns (uint256)',
  'function AIRDROP_ALLOCATION() view returns (uint256)',
  'function LIQUIDITY_ALLOCATION() view returns (uint256)',
  'function TEAM_ALLOCATION() view returns (uint256)',
  'function ECOSYSTEM_ALLOCATION() view returns (uint256)',
  'function TREASURY_ALLOCATION() view returns (uint256)',
  'function deployer() view returns (address)',
  'function deploymentChainId() view returns (uint256)',
  'function distributed() view returns (bool)',
  'function market() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function distributeOnce(address airdropDistributor, address liquidityMarket, address teamVesting, address ecosystemRecipient, address treasuryRecipient)',
  'function burn(uint256 amount)',
  'event SupplyDistributed(address indexed airdropDistributor, address indexed liquidityMarket, address indexed teamVesting, address ecosystemRecipient, address treasuryRecipient)',
]);

export const TEAM_VESTING_ABI = parseAbi([
  'constructor(address token_, address beneficiary_, uint64 startTimestamp_)',
  'function TOTAL_ALLOCATION() view returns (uint256)',
  'function VESTING_DAYS() view returns (uint256)',
  'function token() view returns (address)',
  'function beneficiary() view returns (address)',
  'function startTimestamp() view returns (uint64)',
  'function deploymentChainId() view returns (uint256)',
  'function released() view returns (uint256)',
  'function elapsedDays() view returns (uint256)',
  'function vestedAmount() view returns (uint256)',
  'function releasable() view returns (uint256)',
  'function release(address recipient) returns (uint256 amount)',
  'event TeamTokensReleased(address indexed recipient, uint256 amount, uint256 totalReleased)',
]);

export const AIRDROP_DISTRIBUTOR_ABI = parseAbi([
  'constructor(address token_, address admin_, uint64 claimDeadline_)',
  'function MAX_AIRDROP_SUPPLY() view returns (uint256)',
  'function LOCK_DURATION() view returns (uint64)',
  'function UNLOCK_DAYS() view returns (uint256)',
  'function CLAIM_DOMAIN() view returns (bytes32)',
  'function token() view returns (address)',
  'function admin() view returns (address)',
  'function deploymentChainId() view returns (uint256)',
  'function claimDeadline() view returns (uint64)',
  'function merkleRoot() view returns (bytes32)',
  'function totalCommitted() view returns (uint256)',
  'function totalClaimedInitiated() view returns (uint256)',
  'function totalWithdrawn() view returns (uint256)',
  'function schedules(address account) view returns (uint256 totalAmount, uint256 withdrawn, uint64 claimedAt)',
  'function claimLeaf(address account, uint256 amount) view returns (bytes32)',
  'function unlockedDaysOf(address account) view returns (uint256)',
  'function unlockedAmountOf(address account) view returns (uint256)',
  'function withdrawableOf(address account) view returns (uint256)',
  'function scheduleOf(address account) view returns (uint256 totalAmount, uint256 withdrawn, uint64 claimedAt, uint64 lockEndsAt, uint64 fullyUnlockedAt, uint256 unlockedDays, uint256 unlockedAmount, uint256 withdrawable)',
  'function activate(bytes32 root_, uint256 totalCommitted_)',
  'function initiateClaim(uint256 amount, bytes32[] proof)',
  'function withdraw(address recipient) returns (uint256 amount)',
  'function sweepUnclaimed(address recipient) returns (uint256 amount)',
  'event AirdropActivated(bytes32 indexed merkleRoot, uint256 totalCommitted)',
  'event ClaimInitiated(address indexed account, uint256 amount, uint64 claimedAt, uint64 lockEndsAt, uint64 fullyUnlockedAt)',
  'event TokensWithdrawn(address indexed account, address indexed recipient, uint256 amount, uint256 totalWithdrawnByAccount)',
  'event UnclaimedSwept(address indexed recipient, uint256 amount)',
  'error UnsupportedChain(uint256 chainId)',
  'error InvalidToken()',
  'error InvalidRecipient()',
  'error InvalidDeadline()',
  'error OnlyAdmin()',
  'error AlreadyActivated()',
  'error NotActivated()',
  'error InvalidRoot()',
  'error InvalidAmount()',
  'error InvalidProof()',
  'error AlreadyClaimed()',
  'error ClaimWindowClosed()',
  'error ClaimWindowOpen()',
  'error ExceedsCommitment()',
  'error InsufficientBalance()',
  'error NothingToWithdraw()',
  'error NothingToSweep()',
]);

export const PLATFORM_V4_MARKET_ABI = parseAbi([
  'function LIQUIDITY_ALLOCATION() view returns (uint256)',
  'function TARGET_OPENING_FDV_USD() view returns (uint256)',
  'function poolManager() view returns (address)',
  'function oracle() view returns (address)',
  'function token() view returns (address)',
  'function deploymentChainId() view returns (uint256)',
  'function executionFeeBps() view returns (uint16)',
  'function openingValuationNative() view returns (uint256)',
  'function effectiveOpeningValuationNative() view returns (uint256)',
  'function effectiveUpperValuationNative() view returns (uint256)',
  'function initialized() view returns (bool)',
  'function isMarketLaunch() view returns (bool)',
  'function lockedLiquidity() view returns (uint128)',
  'function poolId() view returns (bytes32)',
  'function poolState() view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function initialize()',
  'function buy(uint256 minimumTokensOut, address recipient, uint256 deadline, uint160 priceLimit) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokenAmount, uint256 minimumNetNativeOut, address recipient, uint256 deadline, uint160 priceLimit) returns (uint256 netNative)',
]);

function validNonzeroAddress(value: string, label: string): Address {
  if (!/^0x[\da-fA-F]{40}$/.test(value) || value.toLowerCase() === zeroAddress) {
    throw new Error(`${label} must be a nonzero EVM address.`);
  }
  return value.toLowerCase() as Address;
}

function parsePositiveAmount(value: bigint | string): bigint {
  const amount = typeof value === 'bigint' ? value : BigInt(value);
  if (amount <= 0n || amount > AIRDROP_TOKENOMICS.airdropRaw) {
    throw new Error('Airdrop allocation amount must be positive and within total supply.');
  }
  return amount;
}

/** Matches OneshotAirdropDistributor.claimLeaf(account, amount) identically. */
export function airdropClaimLeaf(
  chainId: number,
  distributor: Address,
  wallet: Address,
  amountRaw: bigint | string,
): Hex {
  if (!Number.isSafeInteger(chainId) || chainId < 1) {
    throw new Error('A positive chain ID is required.');
  }
  const amount = parsePositiveAmount(amountRaw);
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [
        AIRDROP_CLAIM_DOMAIN,
        BigInt(chainId),
        validNonzeroAddress(distributor, 'Distributor'),
        validNonzeroAddress(wallet, 'Claim wallet'),
        amount,
      ],
    ),
  );
  return keccak256(inner);
}

function hashPair(a: Hex, b: Hex): Hex {
  return keccak256(concatHex(a < b ? [a, b] : [b, a]));
}

export type AirdropMerkleEntryInput = {
  wallet: string;
  amountRaw: bigint | string;
};

export type AirdropMerkleTree = {
  root: Hex;
  totalCommittedRaw: bigint;
  entries: { wallet: Address; amountRaw: bigint; proof: Hex[] }[];
  proofs: Record<string, { amountRaw: string; proof: Hex[] }>;
};

export function buildAirdropMerkleTree(
  rawEntries: readonly AirdropMerkleEntryInput[],
  chainId: number,
  distributor: Address,
): AirdropMerkleTree {
  if (rawEntries.length > 15_000) {
    throw new Error('Airdrop tree must contain at most 15,000 wallets.');
  }
  const dist = validNonzeroAddress(distributor, 'Distributor');
  const byWallet = new Map<Address, bigint>();
  for (const item of rawEntries) {
    const wallet = validNonzeroAddress(item.wallet, 'Claim wallet');
    if (byWallet.has(wallet)) {
      throw new Error(`Duplicate wallet in Merkle export: ${wallet}`);
    }
    byWallet.set(wallet, parsePositiveAmount(item.amountRaw));
  }
  const sorted = [...byWallet.entries()]
    .map(([wallet, amountRaw]) => ({ wallet, amountRaw }))
    .sort((a, b) => a.wallet.localeCompare(b.wallet));

  const totalCommittedRaw = sorted.reduce((sum, entry) => sum + entry.amountRaw, 0n);
  if (totalCommittedRaw > AIRDROP_TOKENOMICS.airdropRaw) {
    throw new Error('Total committed airdrop tokens exceed the 510,000,000 token cap.');
  }

  if (!sorted.length) {
    return { root: zeroHash, totalCommittedRaw: 0n, entries: [], proofs: {} };
  }

  const levels: Hex[][] = [
    sorted.map(entry => airdropClaimLeaf(chainId, dist, entry.wallet, entry.amountRaw)),
  ];
  while (levels.at(-1)!.length > 1) {
    const level = levels.at(-1)!;
    const next: Hex[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(index + 1 < level.length ? hashPair(level[index]!, level[index + 1]!) : level[index]!);
    }
    levels.push(next);
  }

  const proofs: Record<string, { amountRaw: string; proof: Hex[] }> = {};
  const entries = sorted.map((entry, index) => {
    const proof: Hex[] = [];
    let position = index;
    for (const level of levels.slice(0, -1)) {
      const sibling = position % 2 === 0 ? position + 1 : position - 1;
      if (sibling < level.length) proof.push(level[sibling]!);
      position = Math.floor(position / 2);
    }
    proofs[entry.wallet] = { amountRaw: entry.amountRaw.toString(), proof };
    return { wallet: entry.wallet, amountRaw: entry.amountRaw, proof };
  });

  return {
    root: levels.at(-1)![0]!,
    totalCommittedRaw,
    entries,
    proofs,
  };
}

export type AirdropUnlockSchedule = {
  phase: 'locked' | 'unlocking' | 'fully_unlocked';
  lockEndsAtSec: number;
  fullyUnlockedAtSec: number;
  nextUnlockAtSec: number;
  unlockedDays: number;
  unlockedAmountRaw: bigint;
  withdrawableRaw: bigint;
  remainingLockedRaw: bigint;
};

/** Exact mirror of OneshotAirdropDistributor's 7-day lock + 7 daily linear tranches. */
export function computeAirdropUnlockSchedule(input: {
  totalAmountRaw: bigint;
  claimedAtSec: number;
  withdrawnRaw: bigint;
  nowSec: number;
}): AirdropUnlockSchedule {
  const { totalAmountRaw, claimedAtSec, withdrawnRaw, nowSec } = input;
  const day = 86_400;
  const lockDuration = AIRDROP_TOKENOMICS.claimLockDays * day;
  const unlockDays = AIRDROP_TOKENOMICS.claimUnlockDays;

  if (claimedAtSec <= 0 || totalAmountRaw <= 0n) {
    return {
      phase: 'locked',
      lockEndsAtSec: 0,
      fullyUnlockedAtSec: 0,
      nextUnlockAtSec: 0,
      unlockedDays: 0,
      unlockedAmountRaw: 0n,
      withdrawableRaw: 0n,
      remainingLockedRaw: totalAmountRaw > 0n ? totalAmountRaw : 0n,
    };
  }

  const lockEndsAtSec = claimedAtSec + lockDuration;
  const fullyUnlockedAtSec = lockEndsAtSec + unlockDays * day;

  if (nowSec < lockEndsAtSec) {
    return {
      phase: 'locked',
      lockEndsAtSec,
      fullyUnlockedAtSec,
      nextUnlockAtSec: lockEndsAtSec + day,
      unlockedDays: 0,
      unlockedAmountRaw: 0n,
      withdrawableRaw: 0n,
      remainingLockedRaw: totalAmountRaw,
    };
  }

  const elapsedDays = Math.min(unlockDays, Math.floor((nowSec - lockEndsAtSec) / day));
  const unlockedAmountRaw =
    elapsedDays >= unlockDays
      ? totalAmountRaw
      : (totalAmountRaw * BigInt(elapsedDays)) / BigInt(unlockDays);
  const withdrawableRaw = unlockedAmountRaw > withdrawnRaw ? unlockedAmountRaw - withdrawnRaw : 0n;
  const remainingLockedRaw = totalAmountRaw > unlockedAmountRaw ? totalAmountRaw - unlockedAmountRaw : 0n;

  if (elapsedDays >= unlockDays) {
    return {
      phase: 'fully_unlocked',
      lockEndsAtSec,
      fullyUnlockedAtSec,
      nextUnlockAtSec: fullyUnlockedAtSec,
      unlockedDays: unlockDays,
      unlockedAmountRaw,
      withdrawableRaw,
      remainingLockedRaw: 0n,
    };
  }

  return {
    phase: elapsedDays === 0 ? 'locked' : 'unlocking',
    lockEndsAtSec,
    fullyUnlockedAtSec,
    nextUnlockAtSec: lockEndsAtSec + (elapsedDays + 1) * day,
    unlockedDays: elapsedDays,
    unlockedAmountRaw,
    withdrawableRaw,
    remainingLockedRaw,
  };
}

export function encodeAirdropInitiateClaimData(amountRaw: bigint | string, proof: readonly Hex[]): Hex {
  return encodeFunctionData({
    abi: AIRDROP_DISTRIBUTOR_ABI,
    functionName: 'initiateClaim',
    args: [typeof amountRaw === 'bigint' ? amountRaw : BigInt(amountRaw), [...proof]],
  });
}

export function encodeAirdropWithdrawData(recipient: Address): Hex {
  return encodeFunctionData({
    abi: AIRDROP_DISTRIBUTOR_ABI,
    functionName: 'withdraw',
    args: [validNonzeroAddress(recipient, 'Recipient')],
  });
}

export function encodeAirdropScheduleOfData(account: Address): Hex {
  return encodeFunctionData({
    abi: AIRDROP_DISTRIBUTOR_ABI,
    functionName: 'scheduleOf',
    args: [validNonzeroAddress(account, 'Account')],
  });
}

export function decodeAirdropScheduleOfResult(data: Hex) {
  const [totalAmount, withdrawn, claimedAt, lockEndsAt, fullyUnlockedAt, unlockedDays, unlockedAmount, withdrawable] =
    decodeFunctionResult({
      abi: AIRDROP_DISTRIBUTOR_ABI,
      functionName: 'scheduleOf',
      data,
    });
  return {
    totalAmount,
    withdrawn,
    claimedAt: Number(claimedAt),
    lockEndsAt: Number(lockEndsAt),
    fullyUnlockedAt: Number(fullyUnlockedAt),
    unlockedDays: Number(unlockedDays),
    unlockedAmount,
    withdrawable,
  };
}

function validBytes32Root(value: string): Hex {
  if (!/^0x[\da-fA-F]{64}$/.test(value) || value.toLowerCase() === zeroHash) {
    throw new Error('Merkle root must be a nonzero 32-byte hex string.');
  }
  return value.toLowerCase() as Hex;
}

export function encodeAirdropActivateData(merkleRoot: Hex, totalCommittedRaw: bigint | string): Hex {
  const root = validBytes32Root(merkleRoot);
  const amount = parsePositiveAmount(totalCommittedRaw);
  return encodeFunctionData({
    abi: AIRDROP_DISTRIBUTOR_ABI,
    functionName: 'activate',
    args: [root, amount],
  });
}

export function encodeAirdropSweepUnclaimedData(recipient: Address): Hex {
  return encodeFunctionData({
    abi: AIRDROP_DISTRIBUTOR_ABI,
    functionName: 'sweepUnclaimed',
    args: [validNonzeroAddress(recipient, 'Recipient')],
  });
}

export function encodeErc20BalanceOfData(account: Address): Hex {
  return encodeFunctionData({
    abi: ONESHOT_TOKEN_ABI,
    functionName: 'balanceOf',
    args: [validNonzeroAddress(account, 'Account')],
  });
}

export function encodeAirdropDistributorReadCalls(): {
  merkleRoot: Hex;
  totalCommitted: Hex;
  totalClaimedInitiated: Hex;
  totalWithdrawn: Hex;
  claimDeadline: Hex;
  admin: Hex;
  token: Hex;
} {
  return {
    merkleRoot: encodeFunctionData({ abi: AIRDROP_DISTRIBUTOR_ABI, functionName: 'merkleRoot' }),
    totalCommitted: encodeFunctionData({ abi: AIRDROP_DISTRIBUTOR_ABI, functionName: 'totalCommitted' }),
    totalClaimedInitiated: encodeFunctionData({ abi: AIRDROP_DISTRIBUTOR_ABI, functionName: 'totalClaimedInitiated' }),
    totalWithdrawn: encodeFunctionData({ abi: AIRDROP_DISTRIBUTOR_ABI, functionName: 'totalWithdrawn' }),
    claimDeadline: encodeFunctionData({ abi: AIRDROP_DISTRIBUTOR_ABI, functionName: 'claimDeadline' }),
    admin: encodeFunctionData({ abi: AIRDROP_DISTRIBUTOR_ABI, functionName: 'admin' }),
    token: encodeFunctionData({ abi: AIRDROP_DISTRIBUTOR_ABI, functionName: 'token' }),
  };
}

export type AirdropDistributorState = {
  merkleRoot: Hex;
  activated: boolean;
  totalCommittedRaw: bigint;
  totalClaimedInitiatedRaw: bigint;
  totalWithdrawnRaw: bigint;
  claimDeadlineSec: number;
  admin: Address;
  token: Address;
  tokenBalanceRaw?: bigint;
};

export function decodeAirdropDistributorState(results: {
  merkleRoot: Hex;
  totalCommitted: Hex;
  totalClaimedInitiated: Hex;
  totalWithdrawn: Hex;
  claimDeadline: Hex;
  admin: Hex;
  token: Hex;
  tokenBalance?: Hex;
}): AirdropDistributorState {
  const merkleRoot = decodeFunctionResult({
    abi: AIRDROP_DISTRIBUTOR_ABI,
    functionName: 'merkleRoot',
    data: results.merkleRoot,
  }).toLowerCase() as Hex;
  const totalCommittedRaw = decodeFunctionResult({
    abi: AIRDROP_DISTRIBUTOR_ABI,
    functionName: 'totalCommitted',
    data: results.totalCommitted,
  });
  const totalClaimedInitiatedRaw = decodeFunctionResult({
    abi: AIRDROP_DISTRIBUTOR_ABI,
    functionName: 'totalClaimedInitiated',
    data: results.totalClaimedInitiated,
  });
  const totalWithdrawnRaw = decodeFunctionResult({
    abi: AIRDROP_DISTRIBUTOR_ABI,
    functionName: 'totalWithdrawn',
    data: results.totalWithdrawn,
  });
  const claimDeadline = decodeFunctionResult({
    abi: AIRDROP_DISTRIBUTOR_ABI,
    functionName: 'claimDeadline',
    data: results.claimDeadline,
  });
  const admin = decodeFunctionResult({
    abi: AIRDROP_DISTRIBUTOR_ABI,
    functionName: 'admin',
    data: results.admin,
  }).toLowerCase() as Address;
  const token = decodeFunctionResult({
    abi: AIRDROP_DISTRIBUTOR_ABI,
    functionName: 'token',
    data: results.token,
  }).toLowerCase() as Address;

  const tokenBalanceRaw = results.tokenBalance
    ? decodeFunctionResult({
        abi: ONESHOT_TOKEN_ABI,
        functionName: 'balanceOf',
        data: results.tokenBalance,
      })
    : undefined;

  return {
    merkleRoot,
    activated: merkleRoot !== zeroHash,
    totalCommittedRaw,
    totalClaimedInitiatedRaw,
    totalWithdrawnRaw,
    claimDeadlineSec: Number(claimDeadline),
    admin,
    token,
    ...(tokenBalanceRaw !== undefined ? { tokenBalanceRaw } : {}),
  };
}

export type AirdropActivateTransaction = {
  chainId: number;
  to: Address;
  data: Hex;
  value: '0x0';
  functionSignature: 'activate(bytes32,uint256)';
  merkleRoot: Hex;
  totalCommittedRaw: string;
};

export function buildAirdropActivateTransaction(input: {
  chainId: number;
  distributor: Address;
  merkleRoot: Hex;
  totalCommittedRaw: bigint | string;
}): AirdropActivateTransaction {
  if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) {
    throw new Error('A positive chain ID is required.');
  }
  const to = validNonzeroAddress(input.distributor, 'Distributor');
  const merkleRoot = validBytes32Root(input.merkleRoot);
  const amount = parsePositiveAmount(input.totalCommittedRaw);
  return {
    chainId: input.chainId,
    to,
    data: encodeAirdropActivateData(merkleRoot, amount),
    value: '0x0',
    functionSignature: 'activate(bytes32,uint256)',
    merkleRoot,
    totalCommittedRaw: amount.toString(),
  };
}

export type AirdropSweepTransaction = {
  chainId: number;
  to: Address;
  data: Hex;
  value: '0x0';
  functionSignature: 'sweepUnclaimed(address)';
  recipient: Address;
};

export function buildAirdropSweepTransaction(input: {
  chainId: number;
  distributor: Address;
  recipient: Address;
}): AirdropSweepTransaction {
  if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) {
    throw new Error('A positive chain ID is required.');
  }
  const to = validNonzeroAddress(input.distributor, 'Distributor');
  const recipient = validNonzeroAddress(input.recipient, 'Recipient');
  return {
    chainId: input.chainId,
    to,
    data: encodeAirdropSweepUnclaimedData(recipient),
    value: '0x0',
    functionSignature: 'sweepUnclaimed(address)',
    recipient,
  };
}

export const LAYERZERO_ARBITRUM_CHAIN_ID = 42161;
export const LAYERZERO_ZRO_CLAIM_ARBITRUM_ADDRESS = '0xd6b6a6701303b5ea36fa0edf7389b562d8f894db' as Address;
export const LAYERZERO_DEFAULT_ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';
export const LAYERZERO_FALLBACK_ARBITRUM_RPC_URL = 'https://arbitrum-one-rpc.publicnode.com';
export const LAYERZERO_DEFAULT_SCAN_API_URL = 'https://scan.layerzero-api.com/v1';

export const LAYERZERO_ZRO_CLAIM_ABI = parseAbi([
  'function zroClaimed(address user) view returns (uint256 amount)',
  'event Claim(address claimer, uint256 expectedAmount, uint256 actualAmount, address to)',
  'event ClaimRemote(address claimer, uint256 expectedAmount, uint256 actualAmount, uint32 dstEid, address to)',
]);

export function encodeLayerZeroZroClaimedData(wallet: Address): Hex {
  return encodeFunctionData({
    abi: LAYERZERO_ZRO_CLAIM_ABI,
    functionName: 'zroClaimed',
    args: [validNonzeroAddress(wallet, 'Wallet')],
  });
}

export function decodeLayerZeroZroClaimedResult(data: Hex): bigint {
  return decodeFunctionResult({
    abi: LAYERZERO_ZRO_CLAIM_ABI,
    functionName: 'zroClaimed',
    data,
  });
}
