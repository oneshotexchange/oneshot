// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OneshotChainPolicy} from "./OneshotChainPolicy.sol";

/// @notice Merkle airdrop distributor enforcing a 7-day lock from each user's claim initiation,
/// followed by 7 daily linear unlock tranches (100% unlocked at claimedAt + 14 days).
contract OneshotAirdropDistributor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_AIRDROP_SUPPLY = 510_000_000 * 10 ** 8;
    uint64 public constant LOCK_DURATION = 7 days;
    uint256 public constant UNLOCK_DAYS = 7;
    bytes32 public constant CLAIM_DOMAIN = keccak256("ONESHOT_AIRDROP_CLAIM_V1");

    struct ClaimSchedule {
        uint256 totalAmount;
        uint256 withdrawn;
        uint64 claimedAt;
    }

    IERC20 public immutable token;
    address public immutable admin;
    uint256 public immutable deploymentChainId;
    uint64 public immutable claimDeadline;

    bytes32 public merkleRoot;
    uint256 public totalCommitted;
    uint256 public totalClaimedInitiated;
    uint256 public totalWithdrawn;
    mapping(address => ClaimSchedule) public schedules;

    error UnsupportedChain(uint256 chainId);
    error InvalidToken();
    error InvalidRecipient();
    error InvalidDeadline();
    error OnlyAdmin();
    error AlreadyActivated();
    error NotActivated();
    error InvalidRoot();
    error InvalidAmount();
    error InvalidProof();
    error AlreadyClaimed();
    error ClaimWindowClosed();
    error ClaimWindowOpen();
    error ExceedsCommitment();
    error InsufficientBalance();
    error NothingToWithdraw();
    error NothingToSweep();

    event AirdropActivated(bytes32 indexed merkleRoot, uint256 totalCommitted);
    event ClaimInitiated(
        address indexed account, uint256 amount, uint64 claimedAt, uint64 lockEndsAt, uint64 fullyUnlockedAt
    );
    event TokensWithdrawn(
        address indexed account, address indexed recipient, uint256 amount, uint256 totalWithdrawnByAccount
    );
    event UnclaimedSwept(address indexed recipient, uint256 amount);

    constructor(IERC20 token_, address admin_, uint64 claimDeadline_) {
        if (!OneshotChainPolicy.isSupportedChain(block.chainid)) revert UnsupportedChain(block.chainid);
        if (address(token_).code.length == 0) revert InvalidToken();
        if (admin_ == address(0) || admin_ == address(this)) revert InvalidRecipient();
        uint64 totalScheduleSpan = LOCK_DURATION + uint64(UNLOCK_DAYS * 1 days);
        if (claimDeadline_ <= block.timestamp || claimDeadline_ > type(uint64).max - totalScheduleSpan) {
            revert InvalidDeadline();
        }

        token = token_;
        admin = admin_;
        deploymentChainId = block.chainid;
        claimDeadline = claimDeadline_;
    }

    function activate(bytes32 root_, uint256 totalCommitted_) external {
        if (block.chainid != deploymentChainId) revert UnsupportedChain(block.chainid);
        if (msg.sender != admin) revert OnlyAdmin();
        if (merkleRoot != bytes32(0)) revert AlreadyActivated();
        if (block.timestamp > claimDeadline) revert ClaimWindowClosed();
        if (root_ == bytes32(0)) revert InvalidRoot();
        if (
            totalCommitted_ == 0 || totalCommitted_ > MAX_AIRDROP_SUPPLY
                || token.balanceOf(address(this)) < totalCommitted_
        ) {
            revert InsufficientBalance();
        }

        merkleRoot = root_;
        totalCommitted = totalCommitted_;

        emit AirdropActivated(root_, totalCommitted_);
    }

    function claimLeaf(address account, uint256 amount) public view returns (bytes32) {
        return keccak256(
            bytes.concat(keccak256(abi.encode(CLAIM_DOMAIN, deploymentChainId, address(this), account, amount)))
        );
    }

    /// @notice Initiates the caller's airdrop claim and starts their personal 7-day lock + 7-day daily unlock clock.
    function initiateClaim(uint256 amount, bytes32[] calldata proof) external nonReentrant {
        if (block.chainid != deploymentChainId) revert UnsupportedChain(block.chainid);
        if (merkleRoot == bytes32(0)) revert NotActivated();
        if (block.timestamp > claimDeadline) revert ClaimWindowClosed();

        ClaimSchedule storage schedule = schedules[msg.sender];
        if (schedule.claimedAt != 0) revert AlreadyClaimed();
        if (amount == 0) revert InvalidAmount();
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, claimLeaf(msg.sender, amount))) revert InvalidProof();
        if (totalClaimedInitiated + amount > totalCommitted) revert ExceedsCommitment();

        uint256 reservedAfter = (totalClaimedInitiated - totalWithdrawn) + amount;
        if (token.balanceOf(address(this)) < reservedAfter) revert InsufficientBalance();

        uint64 now_ = uint64(block.timestamp);
        schedule.totalAmount = amount;
        schedule.claimedAt = now_;
        totalClaimedInitiated += amount;

        emit ClaimInitiated(
            msg.sender,
            amount,
            now_,
            now_ + LOCK_DURATION,
            now_ + LOCK_DURATION + uint64(UNLOCK_DAYS * 1 days)
        );
    }

    function unlockedDaysOf(address account) public view returns (uint256) {
        ClaimSchedule storage schedule = schedules[account];
        if (schedule.claimedAt == 0) return 0;
        uint256 lockEnd = uint256(schedule.claimedAt) + LOCK_DURATION;
        if (block.timestamp < lockEnd) return 0;
        uint256 days_ = (block.timestamp - lockEnd) / 1 days;
        return days_ >= UNLOCK_DAYS ? UNLOCK_DAYS : days_;
    }

    function unlockedAmountOf(address account) public view returns (uint256) {
        ClaimSchedule storage schedule = schedules[account];
        if (schedule.claimedAt == 0) return 0;
        uint256 days_ = unlockedDaysOf(account);
        if (days_ == 0) return 0;
        if (days_ >= UNLOCK_DAYS) return schedule.totalAmount;
        return Math.mulDiv(schedule.totalAmount, days_, UNLOCK_DAYS);
    }

    function withdrawableOf(address account) public view returns (uint256) {
        uint256 unlocked = unlockedAmountOf(account);
        uint256 withdrawn = schedules[account].withdrawn;
        return unlocked > withdrawn ? unlocked - withdrawn : 0;
    }

    function scheduleOf(address account)
        external
        view
        returns (
            uint256 totalAmount,
            uint256 withdrawn,
            uint64 claimedAt,
            uint64 lockEndsAt,
            uint64 fullyUnlockedAt,
            uint256 unlockedDays,
            uint256 unlockedAmount,
            uint256 withdrawable
        )
    {
        ClaimSchedule storage schedule = schedules[account];
        totalAmount = schedule.totalAmount;
        withdrawn = schedule.withdrawn;
        claimedAt = schedule.claimedAt;
        if (claimedAt != 0) {
            lockEndsAt = claimedAt + LOCK_DURATION;
            fullyUnlockedAt = claimedAt + LOCK_DURATION + uint64(UNLOCK_DAYS * 1 days);
        }
        unlockedDays = unlockedDaysOf(account);
        unlockedAmount = unlockedAmountOf(account);
        withdrawable = withdrawableOf(account);
    }

    /// @notice Withdraws any unlocked daily tranches for the caller, even after claimDeadline or sweepUnclaimed.
    function withdraw(address recipient) external nonReentrant returns (uint256 amount) {
        if (block.chainid != deploymentChainId) revert UnsupportedChain(block.chainid);
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();

        amount = withdrawableOf(msg.sender);
        if (amount == 0) revert NothingToWithdraw();

        schedules[msg.sender].withdrawn += amount;
        totalWithdrawn += amount;
        token.safeTransfer(recipient, amount);

        emit TokensWithdrawn(msg.sender, recipient, amount, schedules[msg.sender].withdrawn);
    }

    /// @notice Sweeps uninitiated tokens after claimDeadline while strictly preserving all initiated claims.
    function sweepUnclaimed(address recipient) external nonReentrant returns (uint256 amount) {
        if (block.chainid != deploymentChainId) revert UnsupportedChain(block.chainid);
        if (msg.sender != admin) revert OnlyAdmin();
        if (block.timestamp <= claimDeadline) revert ClaimWindowOpen();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();

        uint256 reserved = totalClaimedInitiated - totalWithdrawn;
        uint256 balance = token.balanceOf(address(this));
        if (balance <= reserved) revert NothingToSweep();

        amount = balance - reserved;
        token.safeTransfer(recipient, amount);

        emit UnclaimedSwept(recipient, amount);
    }
}
