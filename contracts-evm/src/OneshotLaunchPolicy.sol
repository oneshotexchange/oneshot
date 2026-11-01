// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Immutable economics in raw native-asset units; this contract moves no assets.
/// @dev An opening valuation is a proposed term, not a pool price or proof of liquidity.
contract OneshotLaunchPolicy {
    enum DestinationMode {
        Creator,
        LiquidityAndBurn
    }

    struct RevenueSplit {
        uint256 total;
        uint256 platform;
        uint256 destination;
        uint256 creator;
        uint256 liquidity;
        uint256 burn;
    }

    struct ExecutionQuote {
        uint256 grossNative;
        uint256 netNative;
        RevenueSplit fee;
    }

    error InvalidRecipient();
    error ExecutionFeeOutOfBounds(uint16 feeBps);
    error InvalidOpeningValuation();

    uint256 public constant BPS = 10_000;
    uint16 public constant PLATFORM_SHARE_BPS = 2_000;
    uint16 public constant LIQUIDITY_SHARE_BPS = 7_500;
    uint16 public constant MIN_EXECUTION_FEE_BPS = 100;
    uint16 public constant MAX_EXECUTION_FEE_BPS = 500;
    uint256 public constant PRICE_RANGE_MULTIPLIER = 1_000;

    address public immutable creator;
    address public immutable platformRecipient;
    uint16 public immutable executionFeeBps;
    DestinationMode public immutable destinationMode;
    uint256 public immutable openingValuationNative;
    uint256 public immutable upperValuationNative;

    constructor(
        address creator_,
        address platformRecipient_,
        uint16 executionFeeBps_,
        DestinationMode destinationMode_,
        uint256 openingValuationNative_
    ) {
        if (creator_ == address(0) || platformRecipient_ == address(0)) {
            revert InvalidRecipient();
        }
        if (executionFeeBps_ < MIN_EXECUTION_FEE_BPS || executionFeeBps_ > MAX_EXECUTION_FEE_BPS) {
            revert ExecutionFeeOutOfBounds(executionFeeBps_);
        }
        if (openingValuationNative_ == 0 || openingValuationNative_ > type(uint256).max / PRICE_RANGE_MULTIPLIER) {
            revert InvalidOpeningValuation();
        }
        creator = creator_;
        platformRecipient = platformRecipient_;
        executionFeeBps = executionFeeBps_;
        destinationMode = destinationMode_;
        openingValuationNative = openingValuationNative_;
        upperValuationNative = openingValuationNative_ * PRICE_RANGE_MULTIPLIER;
    }

    /// @notice Buy: gross is the buyer's total input; net is available for the pool.
    /// Sell: gross is actual pool output; net is payable to the seller.
    /// @dev A future swap integration must supply actual amounts, not a pre-trade estimate.
    function quoteExecution(uint256 grossNative) external view returns (ExecutionQuote memory quote) {
        uint256 fee = Math.mulDiv(grossNative, executionFeeBps, BPS);
        quote = ExecutionQuote(grossNative, grossNative - fee, splitRevenue(fee));
    }

    /// @notice Split collected execution fees OR actual net native LP earnings after conversion.
    /// @dev Platform rounds down; destination receives its remainder. Burn receives the
    /// liquidity/burn remainder. All base units are conserved, including tiny amounts.
    /// This computes budgets; it does not claim a conversion, add liquidity, or burn tokens.
    function splitRevenue(uint256 amount) public view returns (RevenueSplit memory split) {
        split.total = amount;
        split.platform = Math.mulDiv(amount, PLATFORM_SHARE_BPS, BPS);
        split.destination = amount - split.platform;
        if (destinationMode == DestinationMode.Creator) {
            split.creator = split.destination;
        } else {
            split.liquidity = Math.mulDiv(split.destination, LIQUIDITY_SHARE_BPS, BPS);
            split.burn = split.destination - split.liquidity;
        }
    }
}
