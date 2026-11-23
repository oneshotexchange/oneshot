// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OneshotToken} from "../src/OneshotToken.sol";
import {OneshotTeamVesting} from "../src/OneshotTeamVesting.sol";
import {OneshotAirdropDistributor} from "../src/OneshotAirdropDistributor.sol";
import {OneshotPlatformV4Market} from "../src/OneshotPlatformV4Market.sol";
import {OneshotV4Oracle, OneshotV4OracleDeployer} from "../src/OneshotV4Oracle.sol";

interface AirdropVm {
    function getCode(string calldata) external returns (bytes memory);
    function projectRoot() external view returns (string memory);
    function chainId(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

contract OneshotPlatformAirdropTest {
    using StateLibrary for IPoolManager;

    AirdropVm constant vm = AirdropVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant ADMIN = address(0xAD01);
    address constant TEAM = address(0x7EA1);
    address constant ECOSYSTEM = address(0xEC01);
    address constant TREASURY = address(0x78E1);
    address constant PLATFORM = address(0xB001);
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant CHARLIE = address(0xC4A7);
    address constant TRADER = address(0x78AD);

    IPoolManager manager;
    OneshotV4Oracle oracle;
    OneshotToken token;
    OneshotTeamVesting teamVesting;
    OneshotAirdropDistributor distributor;
    OneshotPlatformV4Market market;

    uint64 startTs = 1_000_000;
    uint64 claimDeadline;

    uint256 constant ALICE_AMT = 40_000 * 10 ** 8;
    uint256 constant BOB_AMT = 20_000 * 10 ** 8;
    uint256 constant CHARLIE_AMT = 150_000 * 10 ** 8;

    bytes32 root;
    bytes32[] aliceProof;
    bytes32[] bobProof;
    bytes32[] charlieProof;

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function setUp() public {
        vm.chainId(31337);
        vm.warp(startTs);
        claimDeadline = startTs + 30 days;

        bytes memory init = abi.encodePacked(
            vm.getCode(string.concat(vm.projectRoot(), "/core-out/PoolManager.sol/PoolManager.json")),
            abi.encode(address(this))
        );
        address deployed;
        assembly ("memory-safe") {
            deployed := create(0, add(init, 32), mload(init))
        }
        require(deployed.code.length != 0, "canonical core deploy");
        manager = IPoolManager(deployed);

        OneshotV4OracleDeployer deployer = new OneshotV4OracleDeployer();
        bytes32 hash = keccak256(abi.encodePacked(type(OneshotV4Oracle).creationCode, abi.encode(manager)));
        uint256 salt;
        while (
            uint160(address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(deployer), bytes32(salt), hash))))))
                & ((1 << 14) - 1) != 0x1040
        ) {
            salt++;
        }
        oracle = deployer.deploy(manager, bytes32(salt));

        token = new OneshotToken("oneshot", "ONE");
        teamVesting = new OneshotTeamVesting(IERC20(address(token)), TEAM, startTs);
        distributor = new OneshotAirdropDistributor(IERC20(address(token)), ADMIN, claimDeadline);
        market = new OneshotPlatformV4Market(
            manager,
            oracle,
            token,
            OneshotPlatformV4Market.Terms({
                creator: TREASURY,
                platform: PLATFORM,
                feeBps: 300,
                liquidityAndBurn: true,
                openingValuation: 960 ether,
                minProcessingNative: 0.01 ether
            })
        );

        token.distributeOnce(address(distributor), address(market), address(teamVesting), ECOSYSTEM, TREASURY);

        // Build 4-leaf Merkle tree (Alice, Bob, Charlie, padding zero duplicate = 3 nodes handled cleanly via 4 leaves)
        bytes32 lA = distributor.claimLeaf(ALICE, ALICE_AMT);
        bytes32 lB = distributor.claimLeaf(BOB, BOB_AMT);
        bytes32 lC = distributor.claimLeaf(CHARLIE, CHARLIE_AMT);
        bytes32 lD = distributor.claimLeaf(address(0xD00D), 1_000 * 10 ** 8);

        bytes32 nAB = _hashPair(lA, lB);
        bytes32 nCD = _hashPair(lC, lD);
        root = _hashPair(nAB, nCD);

        aliceProof = new bytes32[](2);
        aliceProof[0] = lB;
        aliceProof[1] = nCD;

        bobProof = new bytes32[](2);
        bobProof[0] = lA;
        bobProof[1] = nCD;

        charlieProof = new bytes32[](2);
        charlieProof[0] = lD;
        charlieProof[1] = nAB;

        vm.prank(ADMIN);
        distributor.activate(root, ALICE_AMT + BOB_AMT + CHARLIE_AMT + 1_000 * 10 ** 8);

        vm.deal(TRADER, 10_000 ether);
    }

    function testExactSupplyDistributionAndOneSided960kFdvLiquidity() public {
        require(token.totalSupply() == 1_000_000_000 * 10 ** 8);
        require(token.decimals() == 8);
        require(token.balanceOf(address(token)) == 0);
        require(token.balanceOf(address(distributor)) == 510_000_000 * 10 ** 8);
        require(token.balanceOf(address(teamVesting)) == 100_000_000 * 10 ** 8);
        require(token.balanceOf(ECOSYSTEM) == 90_000_000 * 10 ** 8);
        require(token.balanceOf(TREASURY) == 50_000_000 * 10 ** 8);

        // 25% LP locked inside Uniswap v4 PoolManager + rounding dust on market contract
        require(market.isMarketLaunch());
        require(token.balanceOf(address(manager)) + market.lockedRoundingDust() == 250_000_000 * 10 ** 8);
        require(address(market).balance == 0);
        require(market.TARGET_OPENING_FDV_USD() == 960_000);

        // Cannot distribute twice
        vm.expectRevert(OneshotToken.AlreadyDistributed.selector);
        token.distributeOnce(address(distributor), address(market), address(teamVesting), ECOSYSTEM, TREASURY);

        // Buy & sell work cleanly on one-sided $960k FDV pool
        vm.prank(TRADER);
        uint256 bought = market.buy{value: 5 ether}(1, TRADER, block.timestamp + 60, 0);
        require(bought > 0 && token.balanceOf(TRADER) == bought);

        vm.prank(TRADER);
        token.approve(address(market), bought / 2);
        vm.prank(TRADER);
        uint256 netOut = market.sell(bought / 2, 1, payable(TRADER), block.timestamp + 60, 0);
        require(netOut > 0);
    }

    function testTeamVesting24MonthLinearDailyUnlock() public {
        require(teamVesting.vestedAmount() == 0);
        require(teamVesting.releasable() == 0);

        vm.prank(TEAM);
        vm.expectRevert(OneshotTeamVesting.NothingToRelease.selector);
        teamVesting.release(TEAM);

        // Non-beneficiary blocked
        vm.warp(startTs + 10 days);
        vm.prank(ALICE);
        vm.expectRevert(OneshotTeamVesting.OnlyBeneficiary.selector);
        teamVesting.release(ALICE);

        // Day 1: 100M / 730
        vm.warp(startTs + 1 days);
        uint256 day1Expected = uint256(100_000_000 * 10 ** 8) / 730;
        require(teamVesting.vestedAmount() == day1Expected);
        vm.prank(TEAM);
        uint256 got1 = teamVesting.release(TEAM);
        require(got1 == day1Expected && token.balanceOf(TEAM) == day1Expected);

        // Day 365: half vested
        vm.warp(startTs + 365 days);
        require(teamVesting.vestedAmount() == 50_000_000 * 10 ** 8);
        vm.prank(TEAM);
        uint256 gotHalf = teamVesting.release(TEAM);
        require(got1 + gotHalf == 50_000_000 * 10 ** 8);

        // Day 730+: full 100M released with zero dust
        vm.warp(startTs + 730 days);
        vm.prank(TEAM);
        uint256 gotFinal = teamVesting.release(TEAM);
        require(got1 + gotHalf + gotFinal == 100_000_000 * 10 ** 8);
        require(token.balanceOf(address(teamVesting)) == 0);
        require(token.balanceOf(TEAM) == 100_000_000 * 10 ** 8);
    }

    function testAirdrop7DayLockThen7DayDailyUnlock() public {
        // Bad proofs & wrong amount revert
        vm.prank(ALICE);
        vm.expectRevert(OneshotAirdropDistributor.InvalidProof.selector);
        distributor.initiateClaim(ALICE_AMT + 1, aliceProof);

        vm.prank(BOB);
        vm.expectRevert(OneshotAirdropDistributor.InvalidProof.selector);
        distributor.initiateClaim(ALICE_AMT, aliceProof);

        // Alice initiates claim at startTs
        vm.prank(ALICE);
        distributor.initiateClaim(ALICE_AMT, aliceProof);

        // Cannot double-claim
        vm.prank(ALICE);
        vm.expectRevert(OneshotAirdropDistributor.AlreadyClaimed.selector);
        distributor.initiateClaim(ALICE_AMT, aliceProof);

        // Days 0..7: 100% locked
        vm.warp(startTs + 7 days - 1);
        require(distributor.withdrawableOf(ALICE) == 0);
        vm.warp(startTs + 7 days);
        require(distributor.withdrawableOf(ALICE) == 0);
        vm.prank(ALICE);
        vm.expectRevert(OneshotAirdropDistributor.NothingToWithdraw.selector);
        distributor.withdraw(ALICE);

        // Bob initiates claim 3 days later — independent schedule
        vm.warp(startTs + 3 days);
        vm.prank(BOB);
        distributor.initiateClaim(BOB_AMT, bobProof);

        // Day 8 from startTs: Alice unlocks 1/7; Bob is still in 7-day lock!
        vm.warp(startTs + 8 days);
        require(distributor.unlockedDaysOf(ALICE) == 1);
        require(distributor.unlockedDaysOf(BOB) == 0);
        require(distributor.withdrawableOf(ALICE) == ALICE_AMT / 7);
        require(distributor.withdrawableOf(BOB) == 0);

        vm.prank(ALICE);
        uint256 w1 = distributor.withdraw(ALICE);
        require(w1 == ALICE_AMT / 7);

        // Day 11 from startTs: Alice has unlocked 4/7 (since claimedAt=startTs), Bob has unlocked 1/7 (claimedAt=startTs+3d)
        vm.warp(startTs + 11 days);
        require(distributor.unlockedDaysOf(ALICE) == 4);
        require(distributor.unlockedDaysOf(BOB) == 1);
        vm.prank(ALICE);
        distributor.withdraw(ALICE);
        vm.prank(BOB);
        distributor.withdraw(BOB);

        // Sweep unclaimed after deadline preserves Alice's & Bob's remaining un-withdrawn tokens!
        (, uint256 aliceWithdrawn,,,,,,) = distributor.scheduleOf(ALICE);
        (, uint256 bobWithdrawn,,,,,,) = distributor.scheduleOf(BOB);
        vm.warp(claimDeadline + 1);
        vm.prank(ADMIN);
        uint256 swept = distributor.sweepUnclaimed(TREASURY);
        uint256 aliceRemaining = ALICE_AMT - aliceWithdrawn;
        uint256 bobRemaining = BOB_AMT - bobWithdrawn;
        require(swept == (510_000_000 * 10 ** 8) - (ALICE_AMT + BOB_AMT));
        require(token.balanceOf(address(distributor)) == aliceRemaining + bobRemaining);

        // Alice and Bob finish withdrawing exact 100% after sweepUnclaimed
        vm.prank(ALICE);
        distributor.withdraw(ALICE);
        vm.prank(BOB);
        distributor.withdraw(BOB);
        require(token.balanceOf(ALICE) == ALICE_AMT);
        require(token.balanceOf(BOB) == BOB_AMT);
        require(token.balanceOf(address(distributor)) == 0);
    }

    function testFuzzAirdropScheduleConservesEveryBaseUnit(uint64 waitBeforeWithdraw) public {
        vm.prank(CHARLIE);
        distributor.initiateClaim(CHARLIE_AMT, charlieProof);

        uint256 step1 = uint256(waitBeforeWithdraw) % 20 days;
        vm.warp(startTs + step1);
        uint256 w = distributor.withdrawableOf(CHARLIE);
        if (step1 < 8 days) {
            require(w == 0);
        } else {
            vm.prank(CHARLIE);
            distributor.withdraw(CHARLIE);
        }

        // Fast forward past full 14 days
        vm.warp(startTs + 14 days);
        uint256 rem = distributor.withdrawableOf(CHARLIE);
        if (rem > 0) {
            vm.prank(CHARLIE);
            distributor.withdraw(CHARLIE);
        }
        require(token.balanceOf(CHARLIE) == CHARLIE_AMT);
        require(distributor.withdrawableOf(CHARLIE) == 0);
    }

    function testSecurityInvariantsRejectUnsafeDeploymentsAndActivations() public {
        // Backdated or overflow-prone team vesting start timestamps revert
        vm.expectRevert(OneshotTeamVesting.InvalidStartTimestamp.selector);
        new OneshotTeamVesting(IERC20(address(token)), TEAM, startTs - 1);

        vm.expectRevert(OneshotTeamVesting.InvalidStartTimestamp.selector);
        new OneshotTeamVesting(IERC20(address(token)), TEAM, type(uint64).max - 10 days);

        // Overflow-prone airdrop deadline reverts
        vm.expectRevert(OneshotAirdropDistributor.InvalidDeadline.selector);
        new OneshotAirdropDistributor(IERC20(address(token)), ADMIN, type(uint64).max - 7 days);

        // Distributor activation after claimDeadline reverts ClaimWindowClosed
        OneshotToken freshToken = new OneshotToken("oneshot 2", "ONE2");
        OneshotTeamVesting freshVesting = new OneshotTeamVesting(IERC20(address(freshToken)), TEAM, startTs);
        OneshotAirdropDistributor freshDist =
            new OneshotAirdropDistributor(IERC20(address(freshToken)), ADMIN, startTs + 5 days);
        OneshotPlatformV4Market freshMarket = new OneshotPlatformV4Market(
            manager,
            oracle,
            freshToken,
            OneshotPlatformV4Market.Terms({
                creator: TREASURY,
                platform: PLATFORM,
                feeBps: 300,
                liquidityAndBurn: true,
                openingValuation: 960 ether,
                minProcessingNative: 0.01 ether
            })
        );

        // distributeOnce blocks EOA distributor or EOA teamVesting and protocol recipient overlap
        vm.expectRevert(OneshotToken.InvalidRecipient.selector);
        freshToken.distributeOnce(ALICE, address(freshMarket), address(freshVesting), ECOSYSTEM, TREASURY);

        vm.expectRevert(OneshotToken.InvalidRecipient.selector);
        freshToken.distributeOnce(address(freshDist), address(freshMarket), TEAM, ECOSYSTEM, TREASURY);

        vm.expectRevert(OneshotToken.InvalidRecipient.selector);
        freshToken.distributeOnce(
            address(freshDist), address(freshMarket), address(freshVesting), address(freshMarket), TREASURY
        );

        vm.expectRevert(OneshotToken.InvalidRecipient.selector);
        freshToken.distributeOnce(
            address(freshDist), address(freshMarket), address(freshVesting), ECOSYSTEM, address(freshDist)
        );

        // Valid distribution succeeds; late activate after claimDeadline reverts
        freshToken.distributeOnce(address(freshDist), address(freshMarket), address(freshVesting), ECOSYSTEM, TREASURY);
        vm.warp(startTs + 5 days + 1);
        vm.prank(ADMIN);
        vm.expectRevert(OneshotAirdropDistributor.ClaimWindowClosed.selector);
        freshDist.activate(root, ALICE_AMT);
    }
}
