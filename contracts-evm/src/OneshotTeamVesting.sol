// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OneshotChainPolicy} from "./OneshotChainPolicy.sol";

/// @notice Immutable 24-month (730-day) daily linear team vesting for 10% (100M) of OneshotToken supply.
contract OneshotTeamVesting is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TOTAL_ALLOCATION = 100_000_000 * 10 ** 8;
    uint256 public constant VESTING_DAYS = 730;

    IERC20 public immutable token;
    address public immutable beneficiary;
    uint64 public immutable startTimestamp;
    uint256 public immutable deploymentChainId;

    uint256 public released;

    error UnsupportedChain(uint256 chainId);
    error InvalidToken();
    error InvalidRecipient();
    error InvalidStartTimestamp();
    error OnlyBeneficiary();
    error NothingToRelease();

    event TeamTokensReleased(address indexed recipient, uint256 amount, uint256 totalReleased);

    constructor(IERC20 token_, address beneficiary_, uint64 startTimestamp_) {
        if (!OneshotChainPolicy.isSupportedChain(block.chainid)) revert UnsupportedChain(block.chainid);
        if (address(token_).code.length == 0) revert InvalidToken();
        if (beneficiary_ == address(0) || beneficiary_ == address(this)) revert InvalidRecipient();
        uint64 maxStart = type(uint64).max - uint64(VESTING_DAYS * 1 days);
        if (startTimestamp_ == 0) {
            if (block.timestamp > maxStart) revert InvalidStartTimestamp();
        } else if (startTimestamp_ < block.timestamp || startTimestamp_ > maxStart) {
            revert InvalidStartTimestamp();
        }

        token = token_;
        beneficiary = beneficiary_;
        startTimestamp = startTimestamp_ == 0 ? uint64(block.timestamp) : startTimestamp_;
        deploymentChainId = block.chainid;
    }

    function elapsedDays() public view returns (uint256) {
        if (block.timestamp <= startTimestamp) return 0;
        uint256 days_ = (block.timestamp - startTimestamp) / 1 days;
        return days_ >= VESTING_DAYS ? VESTING_DAYS : days_;
    }

    function vestedAmount() public view returns (uint256) {
        uint256 days_ = elapsedDays();
        if (days_ >= VESTING_DAYS) return TOTAL_ALLOCATION;
        return Math.mulDiv(TOTAL_ALLOCATION, days_, VESTING_DAYS);
    }

    function releasable() public view returns (uint256) {
        uint256 vested = vestedAmount();
        uint256 due = vested > released ? vested - released : 0;
        uint256 balance = token.balanceOf(address(this));
        return due < balance ? due : balance;
    }

    function release(address recipient) external nonReentrant returns (uint256 amount) {
        if (block.chainid != deploymentChainId) revert UnsupportedChain(block.chainid);
        if (msg.sender != beneficiary) revert OnlyBeneficiary();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();

        amount = releasable();
        if (amount == 0) revert NothingToRelease();

        released += amount;
        token.safeTransfer(recipient, amount);

        emit TeamTokensReleased(recipient, amount, released);
    }
}
