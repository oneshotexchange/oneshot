// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {OneshotFixedSupplyToken} from "../src/OneshotFixedSupplyToken.sol";
import {OneshotLaunchPolicy} from "../src/OneshotLaunchPolicy.sol";
import {OneshotLocalOnly} from "../src/OneshotLocalOnly.sol";
import {OneshotTokenFoundation} from "../src/OneshotTokenFoundation.sol";
import {OneshotTokenFoundationFactory} from "../src/OneshotTokenFoundationFactory.sol";

interface FoundationVm {
    function expectRevert(bytes calldata revertData) external;
    function prank(address sender) external;
    function chainId(uint256 chainId_) external;
}

contract OneshotTokenFoundationTest {
    FoundationVm private constant vm = FoundationVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant CREATOR = address(0xC0FFEE);
    address private constant TREASURY = address(0xBEEF);
    address private constant BUYER = address(0xABCD);
    uint256 private constant SUPPLY = 100_000_000_000_000_000;

    function _foundation(OneshotTokenFoundationFactory factory, uint256 openingValuation)
        private
        returns (OneshotTokenFoundation)
    {
        vm.prank(CREATOR);
        return factory.createFoundation(
            "oneshot local token", "SHOT", 300, OneshotLaunchPolicy.DestinationMode.LiquidityAndBurn, openingValuation
        );
    }

    function testAllInitialSupplyAllocatedToPermanentCustody() public {
        OneshotTokenFoundationFactory factory = new OneshotTokenFoundationFactory(TREASURY);
        OneshotTokenFoundation foundation = _foundation(factory, 123_456);
        OneshotFixedSupplyToken token = foundation.token();
        require(factory.isFoundation(address(foundation)), "registered foundation");
        require(token.totalSupply() == SUPPLY && token.decimals() == 8, "one billion eight decimals");
        require(token.balanceOf(address(foundation)) == SUPPLY, "all initial allocation custody");
        require(token.initialAllocationCustody() == address(foundation), "custody recorded");
        require(token.balanceOf(CREATOR) == 0 && token.balanceOf(TREASURY) == 0, "no creator or platform allocation");
        require(token.balanceOf(address(factory)) == 0, "no factory allocation");
        require(address(foundation).balance == 0, "zero native principal");
        require(
            !foundation.isMarketLaunch() && foundation.liquidityAdapter() == address(0), "honest integration status"
        );
        require(
            foundation.policy().creator() == CREATOR && foundation.policy().platformRecipient() == TREASURY,
            "frozen recipients"
        );
        require(foundation.policy().openingValuationNative() == 123_456, "chosen valuation");
    }

    function testCustodyCannotWithdrawTransferApproveReRangeOrBindAdapter() public {
        OneshotTokenFoundationFactory factory = new OneshotTokenFoundationFactory(TREASURY);
        OneshotTokenFoundation foundation = _foundation(factory, 1);
        OneshotFixedSupplyToken token = foundation.token();
        bytes[7] memory attempts = [
            abi.encodeWithSignature("withdraw(address,uint256)", address(token), SUPPLY),
            abi.encodeWithSignature("rescueToken(address,address,uint256)", address(token), CREATOR, SUPPLY),
            abi.encodeWithSignature("transferPosition(address)", CREATOR),
            abi.encodeWithSignature("approve(address,uint256)", CREATOR, SUPPLY),
            abi.encodeWithSignature("setLiquidityAdapter(address)", CREATOR),
            abi.encodeWithSignature("rerange(int24,int24)", int24(1), int24(2)),
            abi.encodeWithSignature(
                "execute(address,bytes)",
                address(token),
                abi.encodeWithSignature("transfer(address,uint256)", CREATOR, SUPPLY)
            )
        ];
        for (uint256 i; i < attempts.length; ++i) {
            vm.prank(CREATOR);
            (bool succeeded,) = address(foundation).call(attempts[i]);
            require(!succeeded, "no custody escape entrypoint");
        }
        require(
            token.balanceOf(address(foundation)) == SUPPLY && token.allowance(address(foundation), CREATOR) == 0,
            "principal retained"
        );
    }

    function testTokenTransferHasNoTaxAndHolderBurnOnlyReducesSupply() public {
        // Standalone token isolates ERC-20 behavior. Registered foundation custody has
        // no actual path to make these transfers or burns; its supply remains locked.
        OneshotFixedSupplyToken token = new OneshotFixedSupplyToken("ERC20 behavior unit test", "UNIT");
        token.transfer(CREATOR, 101);
        require(token.balanceOf(CREATOR) == 101 && token.balanceOf(address(this)) == SUPPLY - 101, "untaxed transfer");
        vm.prank(CREATOR);
        token.approve(BUYER, 51);
        vm.prank(BUYER);
        token.transferFrom(CREATOR, BUYER, 51);
        require(token.balanceOf(CREATOR) == 50 && token.balanceOf(BUYER) == 51, "untaxed allowance transfer");
        vm.prank(BUYER);
        token.burn(50);
        require(token.totalSupply() == SUPPLY - 50 && token.balanceOf(BUYER) == 1, "burn reduces current supply");
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, BUYER, uint256(1), uint256(2))
        );
        vm.prank(BUYER);
        token.burn(2);
        (bool canMint,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", BUYER, 1));
        (bool canBurnOther,) = address(token).call(abi.encodeWithSignature("burnFrom(address,uint256)", CREATOR, 1));
        require(!canMint && !canBurnOther && token.totalSupply() == SUPPLY - 50, "no mint or privileged burn");
    }

    function testFuzzHolderBurnConservesSupply(uint256 rawBurn) public {
        OneshotFixedSupplyToken token = new OneshotFixedSupplyToken("burn test", "BURN");
        uint256 amount = rawBurn % (SUPPLY + 1);
        token.transfer(BUYER, amount);
        vm.prank(BUYER);
        token.burn(amount);
        require(token.totalSupply() == SUPPLY - amount, "supply reduced by exact burn");
        require(
            token.balanceOf(BUYER) == 0 && token.balanceOf(address(this)) == SUPPLY - amount,
            "balances conserve after burn"
        );
    }

    function testFactoryCannotChangePriorTerms() public {
        OneshotTokenFoundationFactory factory = new OneshotTokenFoundationFactory(TREASURY);
        OneshotTokenFoundation first = _foundation(factory, 7);
        OneshotTokenFoundation second = _foundation(factory, 999);
        require(address(first) != address(second), "distinct immutable allocations");
        require(
            first.policy().openingValuationNative() == 7 && second.policy().openingValuationNative() == 999,
            "valuation chosen per allocation"
        );
        (bool changed,) = address(factory).call(abi.encodeWithSignature("setPlatformRecipient(address)", CREATOR));
        require(!changed && factory.platformRecipient() == TREASURY, "treasury immutable");
        require(first.policy().platformRecipient() == TREASURY, "existing policy immutable");
    }

    function testFoundationContractsRejectNonLocalChain() public {
        vm.chainId(1);
        bytes memory expected = abi.encodeWithSelector(OneshotLocalOnly.LocalDevelopmentOnly.selector, uint256(1));
        vm.expectRevert(expected);
        new OneshotTokenFoundationFactory(TREASURY);
        vm.expectRevert(expected);
        new OneshotFixedSupplyToken("not deployable", "NO");
        vm.expectRevert(expected);
        new OneshotTokenFoundation(
            "not deployable", "NO", CREATOR, TREASURY, 300, OneshotLaunchPolicy.DestinationMode.Creator, 1
        );
        vm.chainId(31_337);
    }

    function testRejectsInvalidMetadataAndPlatformRecipient() public {
        vm.expectRevert(abi.encodeWithSelector(OneshotTokenFoundationFactory.InvalidPlatformRecipient.selector));
        new OneshotTokenFoundationFactory(address(0));
        vm.expectRevert(abi.encodeWithSelector(OneshotFixedSupplyToken.InvalidTokenMetadata.selector));
        new OneshotFixedSupplyToken("", "SHOT");
        vm.expectRevert(abi.encodeWithSelector(OneshotFixedSupplyToken.InvalidTokenMetadata.selector));
        new OneshotFixedSupplyToken("name", "");
        vm.expectRevert(abi.encodeWithSelector(OneshotFixedSupplyToken.InvalidTokenMetadata.selector));
        new OneshotFixedSupplyToken("name", "12345678901234567");
    }
}
