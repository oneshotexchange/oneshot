// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OneshotLaunchPolicy} from "../src/OneshotLaunchPolicy.sol";

interface PolicyVm {
    function expectRevert(bytes calldata revertData) external;
}

contract OneshotLaunchPolicyTest {
    PolicyVm private constant vm = PolicyVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant CREATOR = address(0xC0FFEE);
    address private constant TREASURY = address(0xBEEF);

    function _policy(uint16 fee, OneshotLaunchPolicy.DestinationMode mode, uint256 valuation)
        private
        returns (OneshotLaunchPolicy)
    {
        return new OneshotLaunchPolicy(CREATOR, TREASURY, fee, mode, valuation);
    }

    function testTermsAreChosenPerDeploymentAndStayDistinct() public {
        OneshotLaunchPolicy first = _policy(100, OneshotLaunchPolicy.DestinationMode.Creator, 123);
        OneshotLaunchPolicy second = _policy(500, OneshotLaunchPolicy.DestinationMode.LiquidityAndBurn, 456);
        require(first.creator() == CREATOR && first.platformRecipient() == TREASURY, "recipients");
        require(first.openingValuationNative() == 123 && first.upperValuationNative() == 123_000, "first valuation");
        require(second.openingValuationNative() == 456 && second.upperValuationNative() == 456_000, "second valuation");
        require(first.executionFeeBps() == 100 && second.executionFeeBps() == 500, "fee snapshots");
        require(first.destinationMode() == OneshotLaunchPolicy.DestinationMode.Creator, "first mode");
        (bool canChangeFee,) = address(first).call(abi.encodeWithSignature("setExecutionFeeBps(uint16)", 500));
        (bool canChangeValuation,) =
            address(first).call(abi.encodeWithSignature("setOpeningValuationNative(uint256)", 999));
        (bool canChangeTreasury,) =
            address(first).call(abi.encodeWithSignature("setPlatformRecipient(address)", address(1)));
        require(!canChangeFee && !canChangeValuation && !canChangeTreasury, "no setters");
        require(first.openingValuationNative() == 123 && first.executionFeeBps() == 100, "terms unchanged");
    }

    function testRejectsFeeAndValuationBounds() public {
        vm.expectRevert(abi.encodeWithSelector(OneshotLaunchPolicy.ExecutionFeeOutOfBounds.selector, uint16(99)));
        _policy(99, OneshotLaunchPolicy.DestinationMode.Creator, 1);
        vm.expectRevert(abi.encodeWithSelector(OneshotLaunchPolicy.ExecutionFeeOutOfBounds.selector, uint16(501)));
        _policy(501, OneshotLaunchPolicy.DestinationMode.Creator, 1);
        vm.expectRevert(abi.encodeWithSelector(OneshotLaunchPolicy.InvalidOpeningValuation.selector));
        _policy(100, OneshotLaunchPolicy.DestinationMode.Creator, 0);
        vm.expectRevert(abi.encodeWithSelector(OneshotLaunchPolicy.InvalidOpeningValuation.selector));
        _policy(100, OneshotLaunchPolicy.DestinationMode.Creator, type(uint256).max / 1_000 + 1);
        OneshotLaunchPolicy max = _policy(100, OneshotLaunchPolicy.DestinationMode.Creator, type(uint256).max / 1_000);
        require(max.upperValuationNative() / 1_000 == max.openingValuationNative(), "max allowed valuation");
    }

    function testRejectsMissingRecipients() public {
        vm.expectRevert(abi.encodeWithSelector(OneshotLaunchPolicy.InvalidRecipient.selector));
        new OneshotLaunchPolicy(address(0), TREASURY, 100, OneshotLaunchPolicy.DestinationMode.Creator, 1);
        vm.expectRevert(abi.encodeWithSelector(OneshotLaunchPolicy.InvalidRecipient.selector));
        new OneshotLaunchPolicy(CREATOR, address(0), 100, OneshotLaunchPolicy.DestinationMode.Creator, 1);
    }

    function testRoundingVectorsConserveAllNativeUnits() public {
        OneshotLaunchPolicy creatorPolicy = _policy(300, OneshotLaunchPolicy.DestinationMode.Creator, 1);
        OneshotLaunchPolicy compoundPolicy = _policy(300, OneshotLaunchPolicy.DestinationMode.LiquidityAndBurn, 1);
        uint256[9] memory amounts = [uint256(0), 1, 2, 4, 5, 99, 101, 90_071_992_547_409_931, type(uint256).max];
        for (uint256 i; i < amounts.length; ++i) {
            _assertRevenue(creatorPolicy, amounts[i], false);
            _assertRevenue(compoundPolicy, amounts[i], true);
        }
        OneshotLaunchPolicy.ExecutionQuote memory quote = compoundPolicy.quoteExecution(10_000);
        require(quote.grossNative == 10_000 && quote.netNative == 9_700 && quote.fee.total == 300, "inclusive fee");
        require(quote.fee.platform == 60 && quote.fee.liquidity == 180 && quote.fee.burn == 60, "fee destinations");
        require(compoundPolicy.quoteExecution(1).fee.total == 0, "sub-unit fee floors to zero");
    }

    function testEarningsSplitDoesNotChargeExecutionFeeAgain() public {
        OneshotLaunchPolicy policy = _policy(500, OneshotLaunchPolicy.DestinationMode.LiquidityAndBurn, 1);
        OneshotLaunchPolicy.RevenueSplit memory split = policy.splitRevenue(10_000);
        require(split.total == 10_000 && split.platform == 2_000, "whole converted earnings");
        require(split.liquidity == 6_000 && split.burn == 2_000, "earnings distribution");
    }

    function testFuzzExecutionConservation(uint256 gross, uint16 rawFee, bool compound) public {
        uint16 fee = uint16(uint256(rawFee) % 401 + 100);
        OneshotLaunchPolicy policy = _policy(
            fee,
            compound
                ? OneshotLaunchPolicy.DestinationMode.LiquidityAndBurn
                : OneshotLaunchPolicy.DestinationMode.Creator,
            1
        );
        OneshotLaunchPolicy.ExecutionQuote memory quote = policy.quoteExecution(gross);
        // Independent overflow-safe quotient/remainder calculation, including max uint256.
        uint256 expectedFee = (gross / 10_000) * fee + ((gross % 10_000) * fee) / 10_000;
        require(quote.fee.total == expectedFee, "floor execution fee");
        require(quote.netNative + quote.fee.total == gross, "inclusive gross conservation");
        require(quote.grossNative == gross && quote.netNative <= gross, "quote bounds");
        _assertRevenue(policy, expectedFee, compound);
    }

    function testFuzzRevenueConservation(uint256 amount, bool compound) public {
        OneshotLaunchPolicy policy = _policy(
            300,
            compound
                ? OneshotLaunchPolicy.DestinationMode.LiquidityAndBurn
                : OneshotLaunchPolicy.DestinationMode.Creator,
            1
        );
        _assertRevenue(policy, amount, compound);
    }

    function _assertRevenue(OneshotLaunchPolicy policy, uint256 amount, bool compound) private view {
        OneshotLaunchPolicy.RevenueSplit memory split = policy.splitRevenue(amount);
        require(split.total == amount, "revenue total");
        require(split.platform == amount / 5, "platform floor twenty percent");
        require(split.platform + split.destination == amount, "platform and destination conserve");
        require(split.creator + split.liquidity + split.burn == split.destination, "destination conserves");
        if (compound) {
            uint256 expectedLiquidity = (split.destination / 4) * 3 + ((split.destination % 4) * 3) / 4;
            require(split.creator == 0 && split.liquidity == expectedLiquidity, "liquidity floor seventy five percent");
            require(split.burn == split.destination - split.liquidity, "burn owns remainder");
        } else {
            require(split.creator == split.destination && split.liquidity == 0 && split.burn == 0, "creator mode");
        }
    }
}
