// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {OneshotMarketToken} from "../src/OneshotMarketToken.sol";
import {OneshotV4Market, OneshotV4MarketFactory} from "../src/OneshotV4Market.sol";
import {OneshotV4Oracle, OneshotV4OracleDeployer} from "../src/OneshotV4Oracle.sol";
import {OneshotV4Quoter} from "../src/OneshotV4Quoter.sol";

interface V4Vm {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function getCode(string calldata) external returns (bytes memory);
    function projectRoot() external view returns (string memory);
    function chainId(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function getNonce(address) external view returns (uint64);
}

/// @dev Independent external router demonstrates that the observation hook does
/// not levy oneshot fees on other routers or mutate the token's transfer rules.
contract V4ExternalRouter is IUnlockCallback {
    IPoolManager immutable manager;
    constructor(IPoolManager manager_) { manager = manager_; }
    function swap(PoolKey memory key, bool buy, uint256 amount, uint160 limit) external payable returns (uint256) {
        return abi.decode(manager.unlock(abi.encode(key, buy, amount, limit, msg.sender)), (uint256));
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager));
        (PoolKey memory key, bool buy, uint256 amount, uint160 limit, address recipient) = abi.decode(data, (PoolKey, bool, uint256, uint160, address));
        BalanceDelta delta = manager.swap(key, SwapParams(buy, -int256(amount), limit), "");
        int128 input = buy ? delta.amount0() : delta.amount1();
        int128 output = buy ? delta.amount1() : delta.amount0();
        require(input < 0 && uint256(-int256(input)) == amount && output > 0);
        Currency inputCurrency = buy ? key.currency0 : key.currency1;
        manager.sync(inputCurrency);
        if (buy) manager.settle{value: amount}();
        else {
            require(OneshotMarketToken(Currency.unwrap(inputCurrency)).transferFrom(recipient, address(manager), amount));
            manager.settle();
        }
        manager.take(buy ? key.currency1 : key.currency0, recipient, uint256(int256(output)));
        return abi.encode(uint256(int256(output)));
    }
}

contract RejectNativeV4 {
    function claim(OneshotV4Market market, address payable recipient) external { market.claimTo(recipient); }
    receive() external payable { revert(); }
}

contract ReenterNativeV4 {
    OneshotV4Market public market;
    bool public rejectedReentry;
    function sell(OneshotV4Market market_, uint256 amount) external {
        market = market_; market_.token().approve(address(market_), amount);
        market_.sell(amount, 1, payable(address(this)), block.timestamp, 0);
    }
    receive() external payable {
        (bool ok,) = address(market).call(abi.encodeCall(market.claimTo, (payable(address(this)))));
        rejectedReentry = !ok;
    }
}

contract OneshotV4MarketTest {
    using StateLibrary for IPoolManager;
    V4Vm constant vm = V4Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant CREATOR = address(0xC001);
    address constant PLATFORM = address(0xB001);
    address constant TRADER = address(0xA001);
    IPoolManager manager;
    OneshotV4Oracle oracle;
    OneshotV4MarketFactory factory;
    OneshotV4Market market;
    OneshotMarketToken token;

    function setUp() public {
        vm.chainId(31337); vm.warp(10_000);
        bytes memory init = abi.encodePacked(vm.getCode(string.concat(vm.projectRoot(), "/core-out/PoolManager.sol/PoolManager.json")), abi.encode(address(this)));
        address deployed;
        assembly ("memory-safe") { deployed := create(0, add(init, 32), mload(init)) }
        require(deployed.code.length != 0, "canonical core deploy");
        manager = IPoolManager(deployed);
        OneshotV4OracleDeployer deployer = new OneshotV4OracleDeployer();
        bytes32 hash = keccak256(abi.encodePacked(type(OneshotV4Oracle).creationCode, abi.encode(manager)));
        uint256 salt;
        while (uint160(address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(deployer), bytes32(salt), hash)))))) & ((1 << 14) - 1) != 0x1040) salt++;
        oracle = deployer.deploy(manager, bytes32(salt));
        factory = new OneshotV4MarketFactory(manager, oracle, PLATFORM, 0.01 ether);
        vm.prank(CREATOR); market = factory.createMarket("Test coin", "TEST", 300, false, 1000 ether);
        token = market.token(); vm.deal(TRADER, 1_000_000 ether); vm.deal(address(this), 1_000_000 ether);
    }

    function testTokenOnlyLaunchIsRegisteredAndPrincipalPermanentlyLocked() public view {
        require(factory.isMarket(address(market)) && factory.marketForToken(address(token)) == address(market));
        require(factory.marketCount() == 1 && factory.markets(0) == address(market));
        require(token.decimals() == 8 && token.totalSupply() == 1_000_000_000 * 10 ** 8);
        require(token.balanceOf(CREATOR) == 0 && token.balanceOf(PLATFORM) == 0);
        require(token.balanceOf(address(manager)) + market.lockedRoundingDust() == token.totalSupply());
        require(token.balanceOf(address(market)) == market.lockedRoundingDust());
        require(address(market).balance == 0 && market.lockedLiquidity() > 0);
        (uint128 actualPosition,,) = manager.getPositionInfo(market.poolId(), address(market), market.tickLower(), market.tickUpper(), market.POSITION_SALT());
        require(actualPosition == market.lockedLiquidity());
        require(market.tickLower() % 10 == 0 && market.tickUpper() % 10 == 0);
        (uint160 price,, uint24 protocolFee, uint24 lpFee) = manager.getSlot0(market.poolId());
        require(price == market.sqrtUpperX96() && protocolFee == 0 && lpFee == 2500);
        uint256 lowerVal = market.effectiveOpeningValuationNative();
        uint256 upperVal = market.effectiveUpperValuationNative();
        require(lowerVal >= 1000 ether && lowerVal < 1001 ether);
        require(upperVal >= 1_000_000 ether && upperVal < 1_001_001 ether);
    }

    function testInclusiveBuySellTwentyEightyAndClaimsUseActualGross() public {
        uint256 amount = 1 ether;
        uint256 fee = amount * 300 / 10_000;
        vm.prank(TRADER); uint256 received = market.buy{value: amount}(1, TRADER, block.timestamp, 0);
        require(received == token.balanceOf(TRADER) && received > 0);
        require(market.pending(PLATFORM) == fee / 5 && market.pending(CREATOR) == fee - fee / 5);
        require(market.totalPending() == fee && address(market).balance == fee);
        uint256 beforePending = market.totalPending();
        uint256 beforeBalance = TRADER.balance;
        vm.startPrank(TRADER); token.approve(address(market), received / 2);
        uint256 net = market.sell(received / 2, 1, payable(TRADER), block.timestamp, 0); vm.stopPrank();
        uint256 sellFee = market.totalPending() - beforePending;
        uint256 gross = net + sellFee;
        require(sellFee == gross * 300 / 10_000 && TRADER.balance - beforeBalance == net);
        require(market.pending(PLATFORM) == fee / 5 + sellFee / 5);
        require(market.pending(CREATOR) == fee - fee / 5 + sellFee - sellFee / 5);
        uint256 creatorAmount = market.pending(CREATOR);
        vm.prank(CREATOR); market.claimTo(payable(CREATOR));
        require(CREATOR.balance == creatorAmount && market.pending(CREATOR) == 0);
        vm.prank(PLATFORM); market.claimTo(payable(PLATFORM));
        require(market.totalPending() == 0 && address(market).balance == 0);
    }

    function testExactFillPriceBoundaryAndMinimumRevertWholeBuyAndSell() public {
        uint256 initialSupply = token.balanceOf(address(manager));
        vm.expectRevert(OneshotV4Market.PartialFill.selector);
        market.buy{value: 1_000_000 ether}(1, address(this), block.timestamp, 0);
        require(token.balanceOf(address(manager)) == initialSupply && market.totalPending() == 0);
        vm.expectRevert(OneshotV4Market.Slippage.selector);
        market.buy{value: 1 ether}(type(uint256).max, address(this), block.timestamp, 0);
        uint256 bought = market.buy{value: 1 ether}(1, address(this), block.timestamp, 0);
        token.approve(address(market), bought);
        vm.expectRevert(OneshotV4Market.Slippage.selector);
        market.sell(bought / 2, 1 ether, payable(address(this)), block.timestamp, 0);
        require(token.balanceOf(address(this)) == bought);
        (uint160 current, int24 tick,,) = manager.getSlot0(market.poolId());
        uint160 sellLimit = TickMath.getSqrtPriceAtTick(tick + 1);
        require(sellLimit > current);
        vm.expectRevert(OneshotV4Market.PartialFill.selector);
        market.sell(bought, 1, payable(address(this)), block.timestamp, sellLimit);
        require(token.balanceOf(address(this)) == bought);
    }

    function testOtherRouterTradesAndTransfersHaveNoOneshotTax() public {
        V4ExternalRouter router = new V4ExternalRouter(manager);
        PoolKey memory key = market.poolKey();
        uint160 lower = market.sqrtLowerX96(); uint160 upper = market.sqrtUpperX96();
        vm.prank(TRADER);
        uint256 got = router.swap{value: 1 ether}(key, true, 1 ether, lower);
        require(token.balanceOf(TRADER) == got && market.totalPending() == 0);
        vm.startPrank(TRADER); token.transfer(CREATOR, got / 3); token.approve(address(router), got / 3);
        router.swap(key, false, got / 3, upper); vm.stopPrank();
        require(token.balanceOf(CREATOR) == got / 3 && market.totalPending() == 0);
        require(token.totalSupply() == token.INITIAL_SUPPLY());
        market.collectFees();
        require(market.pendingLpNative() > 0 && market.pendingLpToken() > 0 && market.totalPending() == 0);
    }

    function testOptionalRevenueSplitAndPermissionlessMaintenanceAddsLiquidityAndBurns() public {
        vm.prank(CREATOR); market = factory.createMarket("Burn coin", "BURN", 300, true, 1000 ether); token = market.token();
        uint128 initialLiquidity = market.lockedLiquidity();
        uint256 initialDust = market.lockedRoundingDust();
        vm.prank(TRADER); market.buy{value: 1 ether}(1, TRADER, block.timestamp, 0);
        require(market.pending(PLATFORM) == 0.006 ether && market.pending(CREATOR) == 0);
        require(market.pendingLiquidityNative() == 0.018 ether && market.pendingBurnNative() == 0.006 ether);
        vm.expectRevert(OneshotV4Oracle.OracleNotReady.selector);
        market.process(1 ether, type(uint128).max, block.timestamp + 60);
        require(market.pendingLiquidityNative() == 0.018 ether && market.pendingBurnNative() == 0.006 ether);
        vm.warp(block.timestamp + 300);
        vm.prank(address(0x1234)); market.process(1 ether, type(uint128).max, block.timestamp + 60);
        require(market.lockedLiquidity() > initialLiquidity && token.totalSupply() < token.INITIAL_SUPPLY());
        require(market.lockedRoundingDust() == initialDust && token.balanceOf(address(market)) >= initialDust);
        require(market.pendingBurnNative() == 0 && market.pending(CREATOR) == 0);
        require(address(market).balance >= market.totalPending() + market.pendingLpNative() + market.pendingLiquidityNative() + market.pendingBurnNative());
    }

    function testLpEarningsConvertToNativeBeforeTwentyEightyAllocation() public {
        vm.prank(TRADER); uint256 got = market.buy{value: 10 ether}(1, TRADER, block.timestamp, 0);
        vm.startPrank(TRADER); token.approve(address(market), got / 2); market.sell(got / 2, 1, payable(TRADER), block.timestamp, 0); vm.stopPrank();
        market.collectFees();
        uint256 pendingBefore = market.totalPending();
        uint256 tokenFees = market.pendingLpToken();
        uint256 nativeFees = market.pendingLpNative();
        require(tokenFees > 0 && nativeFees > 0);
        vm.warp(block.timestamp + 300);
        market.process(1 ether, tokenFees, block.timestamp + 60);
        require(market.pendingLpToken() == 0 && market.pendingLpNative() == 0);
        require(market.totalPending() > pendingBefore + nativeFees);
    }

    function testOracleRetainsMoreThan256SecondsAndSamplesOncePerTimestamp() public {
        vm.prank(TRADER); market.buy{value: 1 ether}(1, TRADER, block.timestamp, 0);
        for (uint256 i; i < 310; i++) {
            vm.warp(block.timestamp + 1);
            vm.prank(TRADER); market.buy{value: 0.000001 ether}(1, TRADER, block.timestamp, 0);
        }
        (,,,, uint16 count) = oracle.states(market.poolId());
        require(count == 311 && oracle.CARDINALITY() == 1024);
        int24 mean = oracle.consult(market.poolId(), 300);
        (, int24 spot,,) = manager.getSlot0(market.poolId());
        require(mean >= spot && mean <= spot + 2);
        vm.prank(TRADER); market.buy{value: 0.000001 ether}(1, TRADER, block.timestamp, 0);
        (,,,, uint16 repeatedCount) = oracle.states(market.poolId()); require(repeatedCount == count);
    }

    function testPreinitializingMissingTokenOrByUnrelatedSenderIsRejected() public {
        PoolKey memory key = market.poolKey(); key.currency1 = Currency.wrap(address(0xDEAD));
        uint160 upper = market.sqrtUpperX96();
        vm.expectRevert(); manager.initialize(key, upper);
        OneshotMarketToken unrelated = new OneshotMarketToken("Other", "OTH");
        key.currency1 = Currency.wrap(address(unrelated));
        vm.prank(TRADER); vm.expectRevert(); manager.initialize(key, upper);
        require(market.initialized());
    }

    function testUnavailableOracleDeadlineDeviationAndSmallBudgetsPreserveAssets() public {
        vm.expectRevert(OneshotV4Market.Deadline.selector); market.process(1 ether, 1, block.timestamp + 61);
        vm.warp(block.timestamp + 300);
        vm.expectRevert(OneshotV4Market.BudgetTooSmall.selector); market.process(1 ether, 1, block.timestamp + 60);
        vm.prank(TRADER); market.buy{value: 10 ether}(1, TRADER, block.timestamp, 0);
        uint256 nativeBefore = address(market).balance; uint256 pendingBefore = market.totalPending();
        vm.expectRevert(OneshotV4Market.OracleDeviation.selector); market.process(1 ether, type(uint128).max, block.timestamp + 60);
        require(address(market).balance == nativeBefore && market.totalPending() == pendingBefore);
    }

    function testHolderBurnAndInvalidLaunchTermsCannotChangeExistingMarket() public {
        uint256 bought = market.buy{value: 1 ether}(1, address(this), block.timestamp, 0);
        uint256 initial = token.totalSupply(); token.burn(bought / 3);
        require(token.totalSupply() == initial - bought / 3 && token.balanceOf(address(this)) == bought - bought / 3);
        uint16[4] memory badFees = [uint16(0), uint16(99), uint16(501), uint16(111)];
        for (uint256 i; i < badFees.length; i++) {
            vm.expectRevert(OneshotV4Market.InvalidTerms.selector); factory.createMarket("Bad", "BAD", badFees[i], false, 1000 ether);
        }
        vm.expectRevert(OneshotMarketToken.InvalidMetadata.selector); factory.createMarket("", "BAD", 100, false, 1000 ether);
        vm.expectRevert(); factory.createMarket("Bad", "BAD", 100, false, 0);
        require(factory.marketCount() == 1 && market.executionFeeBps() == 300 && !market.liquidityAndBurn());
    }

    function _rejectFactoryMetadata(string memory name, string memory symbol) private {
        uint256 count = factory.marketCount(); uint64 nonce = vm.getNonce(address(factory));
        require(nonce > 0 && nonce < 128);
        address nextMarket = address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(factory), bytes1(uint8(nonce)))))));
        address nextToken = address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", nextMarket, hex"01")))));
        PoolId futurePool = PoolId.wrap(keccak256(abi.encode(address(0), nextToken, uint24(2500), int24(10), address(oracle))));
        uint128 existingLiquidity = market.lockedLiquidity();
        vm.recordLogs(); vm.expectRevert(OneshotMarketToken.InvalidMetadata.selector);
        factory.createMarket(name, symbol, 300, false, 1000 ether);
        require(vm.getRecordedLogs().length == 0, "invalid launch emitted events");
        require(factory.marketCount() == count && vm.getNonce(address(factory)) == nonce, "invalid launch changed registry");
        require(!factory.isMarket(nextMarket) && factory.marketForToken(nextToken) == address(0));
        require(nextMarket.code.length == 0 && nextToken.code.length == 0, "invalid launch left code");
        (uint160 price,,, uint24 fee) = manager.getSlot0(futurePool);
        require(price == 0 && fee == 0, "invalid launch initialized pool");
        require(market.lockedLiquidity() == existingLiquidity, "existing principal changed");
    }

    function testFactoryRejectsEveryAsciiControlInEitherMetadataFieldAtomically() public {
        for (uint256 i; i < 33; i++) {
            bytes1 control = bytes1(uint8(i == 32 ? 127 : i));
            string memory invalid = string(abi.encodePacked("Visible", control, "text"));
            _rejectFactoryMetadata(invalid, "GOOD"); _rejectFactoryMetadata("Good token", invalid);
        }
    }

    function testFactoryRejectsEveryEcmaTrimOnlyUnicodeMetadataFieldAtomically() public {
        bytes[] memory spaces = new bytes[](20);
        spaces[0]=hex"20"; spaces[1]=hex"c2a0"; spaces[2]=hex"e19a80";
        spaces[3]=hex"e28080"; spaces[4]=hex"e28081"; spaces[5]=hex"e28082"; spaces[6]=hex"e28083";
        spaces[7]=hex"e28084"; spaces[8]=hex"e28085"; spaces[9]=hex"e28086"; spaces[10]=hex"e28087";
        spaces[11]=hex"e28088"; spaces[12]=hex"e28089"; spaces[13]=hex"e2808a"; spaces[14]=hex"e280a8";
        spaces[15]=hex"e280a9"; spaces[16]=hex"e280af"; spaces[17]=hex"e2819f"; spaces[18]=hex"e38080"; spaces[19]=hex"efbbbf";
        for (uint256 i; i < spaces.length; i++) {
            string memory invalid = string(abi.encodePacked(hex"20", spaces[i], hex"c2a0"));
            _rejectFactoryMetadata(invalid, "GOOD"); _rejectFactoryMetadata("Good token", invalid);
        }
    }

    function testFactoryRejectsMalformedUtf8AfterVisibleContentAtomically() public {
        bytes[] memory invalid = new bytes[](22);
        invalid[0]=hex"80"; invalid[1]=hex"bf"; invalid[2]=hex"c0af"; invalid[3]=hex"c1bf";
        invalid[4]=hex"e08080"; invalid[5]=hex"e09fbf"; invalid[6]=hex"f0808080"; invalid[7]=hex"f08fbfbf";
        invalid[8]=hex"eda080"; invalid[9]=hex"edbfbf"; invalid[10]=hex"f4908080"; invalid[11]=hex"f5808080";
        invalid[12]=hex"fe"; invalid[13]=hex"ff"; invalid[14]=hex"c2"; invalid[15]=hex"e0a0"; invalid[16]=hex"f09080";
        invalid[17]=hex"c241"; invalid[18]=hex"e28241"; invalid[19]=hex"f09f41a9"; invalid[20]=hex"f89f92a980"; invalid[21]=hex"fc8080808080";
        for (uint256 i; i < invalid.length; i++) {
            string memory text = string(abi.encodePacked("Visible", invalid[i]));
            _rejectFactoryMetadata(text, "GOOD"); _rejectFactoryMetadata("Good token", text);
        }
    }

    function testFactoryAcceptsUnicodeAndEmojiAndExactByteLimits() public {
        string memory name = unicode"একশট 🚀"; string memory symbol = unicode"মিম";
        OneshotV4Market created = factory.createMarket(name, symbol, 300, false, 1000 ether);
        require(keccak256(bytes(created.token().name())) == keccak256(bytes(name)));
        require(keccak256(bytes(created.token().symbol())) == keccak256(bytes(symbol)));
        require(created.initialized() && created.lockedLiquidity() > 0 && factory.isMarket(address(created)));
        bytes memory longestName = new bytes(64);
        for (uint256 i; i < longestName.length; i++) longestName[i] = bytes1("A");
        string memory longestSymbol = string(abi.encodePacked("ABCDEFGHIJKL", hex"f09f9a80"));
        created = factory.createMarket(string(longestName), longestSymbol, 300, true, 1000 ether);
        require(bytes(created.token().name()).length == 64 && bytes(created.token().symbol()).length == 16);
        _rejectFactoryMetadata(string(abi.encodePacked(longestName, "A")), "GOOD");
        _rejectFactoryMetadata("Good token", string(abi.encodePacked(longestSymbol, "A")));
        require(factory.marketCount() == 3);
    }

    function testFactoryAcceptsValidUtf8ScalarBoundariesWithoutAsciiRestriction() public {
        bytes[] memory valid = new bytes[](7);
        valid[0]=hex"c280"; valid[1]=hex"e0a080"; valid[2]=hex"ed9fbf"; valid[3]=hex"ee8080";
        valid[4]=hex"efbfbf"; valid[5]=hex"f0908080"; valid[6]=hex"f48fbfbf";
        for (uint256 i; i < valid.length; i++) {
            string memory text = string(abi.encodePacked("A", valid[i]));
            OneshotV4Market created = factory.createMarket(text, text, 100, false, 1000 ether);
            require(factory.isMarket(address(created)) && created.isMarketLaunch());
            require(keccak256(bytes(created.token().name())) == keccak256(bytes(text)));
        }
    }

    function testFactoryRejectsInitialBomButPreservesEmbeddedAndTrailingBom() public {
        string memory initial = string(abi.encodePacked(hex"efbbbf", "Visible"));
        _rejectFactoryMetadata(initial, "GOOD"); _rejectFactoryMetadata("Good token", initial);
        string memory embedded = string(abi.encodePacked("A", hex"efbbbf", "B", hex"efbbbf"));
        OneshotV4Market created = factory.createMarket(embedded, embedded, 300, false, 1000 ether);
        require(keccak256(bytes(created.token().name())) == keccak256(bytes(embedded)));
        require(keccak256(bytes(created.token().symbol())) == keccak256(bytes(embedded)));
    }

    function testSellReceiverRejectsReentryAndRejectedPaymentRollsBack() public {
        ReenterNativeV4 recipient = new ReenterNativeV4();
        uint256 bought = market.buy{value: 1 ether}(1, address(recipient), block.timestamp, 0);
        recipient.sell(market, bought / 2); require(recipient.rejectedReentry());
        uint256 otherBought = market.buy{value: 1 ether}(1, address(this), block.timestamp, 0);
        token.approve(address(market), otherBought);
        RejectNativeV4 rejecting = new RejectNativeV4();
        uint256 beforePending = market.totalPending();
        (uint160 beforePrice,,,) = manager.getSlot0(market.poolId());
        vm.expectRevert(OneshotV4Market.PaymentFailed.selector);
        market.sell(otherBought / 2, 1, payable(address(rejecting)), block.timestamp, 0);
        (uint160 afterPrice,,,) = manager.getSlot0(market.poolId());
        require(beforePrice == afterPrice && market.totalPending() == beforePending && token.balanceOf(address(this)) == otherBought);
    }

    function testOracleRingWrapAndExpiredHistoryNeverFallbackToSpot() public {
        vm.prank(TRADER); market.buy{value: 1 ether}(1, TRADER, block.timestamp, 0);
        for (uint256 i; i < 1050; i++) {
            vm.warp(block.timestamp + 1);
            vm.prank(TRADER); market.buy{value: 0.000001 ether}(1, TRADER, block.timestamp, 0);
        }
        (,,, uint16 index, uint16 count) = oracle.states(market.poolId());
        require(count == 1024 && index == 1050 % 1024);
        int24 mean = oracle.consult(market.poolId(), 300);
        (, int24 spot,,) = manager.getSlot0(market.poolId());
        require(mean >= spot && mean <= spot + 2);
        PoolId id = market.poolId();
        vm.expectRevert(OneshotV4Oracle.OracleNotReady.selector); oracle.consult(id, 1100);
    }

    function testFuzzInclusiveBuyFeeConservation(uint96 inputSeed) public {
        uint256 input = 10 ** 12 + uint256(inputSeed) % (1 ether);
        market.buy{value: input}(1, address(this), block.timestamp, 0);
        uint256 fee = input * 300 / 10_000;
        require(address(market).balance == fee && market.totalPending() == fee);
        require(market.pending(PLATFORM) == fee / 5 && market.pending(CREATOR) == fee - fee / 5);
    }

    function testCallbacksAdmissionAndPrincipalMutationSelectorsAreUnavailable() public {
        vm.expectRevert(OneshotV4Market.UnauthorizedCallback.selector); market.unlockCallback("");
        vm.expectRevert(OneshotV4Market.OnlyFactory.selector); market.initialize();
        bytes4[6] memory selectors = [bytes4(keccak256("withdraw()")), bytes4(keccak256("rescue(address,uint256)")), bytes4(keccak256("transferOwnership(address)")), bytes4(keccak256("approve(address,uint256)")), bytes4(keccak256("setRange(int24,int24)")), bytes4(keccak256("removeLiquidity(uint128)"))];
        for (uint256 i; i < selectors.length; i++) { (bool ok,) = address(market).call(abi.encodeWithSelector(selectors[i])); require(!ok); }
        vm.prank(TRADER); market.buy{value: 1 ether}(1, TRADER, block.timestamp, 0);
        vm.chainId(84532);
        vm.expectRevert(abi.encodeWithSelector(OneshotV4Market.UnsupportedTestChain.selector, 84532)); market.buy{value: 1 ether}(1, address(this), block.timestamp, 0);
        vm.prank(CREATOR); market.claimTo(payable(CREATOR)); require(CREATOR.balance > 0);
    }

    function testSupportedChainsRejectWrongBaseProtocolAndMainnets() public {
        vm.chainId(84532); vm.expectRevert(OneshotV4MarketFactory.InvalidProtocol.selector);
        new OneshotV4MarketFactory(manager, oracle, PLATFORM, 0.01 ether);
        vm.chainId(8453); vm.expectRevert(abi.encodeWithSelector(OneshotV4MarketFactory.UnsupportedTestChain.selector, 8453));
        new OneshotV4MarketFactory(manager, oracle, PLATFORM, 0.01 ether);
        vm.chainId(1); vm.expectRevert(abi.encodeWithSelector(OneshotV4MarketFactory.UnsupportedTestChain.selector, 1));
        new OneshotV4MarketFactory(manager, oracle, PLATFORM, 0.01 ether);
        vm.chainId(543210); vm.expectRevert(abi.encodeWithSelector(OneshotV4MarketFactory.UnsupportedTestChain.selector, 543210));
        new OneshotV4MarketFactory(manager, oracle, PLATFORM, 0.01 ether);
        vm.chainId(33001);
        bytes memory init = abi.encodePacked(vm.getCode(string.concat(vm.projectRoot(), "/core-out/PoolManager.sol/PoolManager.json")), abi.encode(address(this)));
        address deployed;
        assembly ("memory-safe") { deployed := create(0, add(init, 32), mload(init)) }
        require(deployed.code.length != 0, "canonical core deploy");
        IPoolManager zeroManager = IPoolManager(deployed);
        address deployer = address(new OneshotV4OracleDeployer());
        bytes memory code = abi.encodePacked(type(OneshotV4Oracle).creationCode, abi.encode(zeroManager));
        bytes32 initHash = keccak256(code);
        bytes32 salt;
        for (uint256 i; i < 100_000; i++) {
            salt = bytes32(i);
            address predicted = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initHash)))));
            if (uint160(predicted) & ((1 << 14) - 1) == (1 << 12) | (1 << 6)) break;
        }
        OneshotV4Oracle zeroOracle = OneshotV4OracleDeployer(deployer).deploy(zeroManager, salt);
        OneshotV4MarketFactory zeroFactory = new OneshotV4MarketFactory(zeroManager, zeroOracle, PLATFORM, 1 ether);
        require(zeroFactory.minProcessingNative() == 1 ether);
        OneshotV4Market zeroMarket = zeroFactory.createMarket("Zero Token", "ZTEST", 300, true, 1000 ether);
        require(zeroMarket.deploymentChainId() == 33001 && zeroMarket.minProcessingNative() == 1 ether);
        zeroMarket.buy{value: 1 ether}(1, address(this), block.timestamp, 0);
        vm.warp(block.timestamp + 300);
        vm.expectRevert(OneshotV4Market.BudgetTooSmall.selector);
        zeroMarket.process(1 ether, type(uint128).max, block.timestamp + 60);
    }

    function testRejectedClaimPreservesLiabilityAndCanBeRoutedElsewhere() public {
        RejectNativeV4 receiver = new RejectNativeV4();
        OneshotV4MarketFactory otherFactory = new OneshotV4MarketFactory(manager, oracle, address(receiver), 0.01 ether);
        OneshotV4Market other = otherFactory.createMarket("Other", "OTHER", 300, false, 1000 ether);
        other.buy{value: 1 ether}(1, address(this), block.timestamp, 0);
        uint256 owed = other.pending(address(receiver));
        vm.expectRevert(OneshotV4Market.PaymentFailed.selector); receiver.claim(other, payable(address(receiver)));
        require(other.pending(address(receiver)) == owed);
        receiver.claim(other, payable(PLATFORM)); require(PLATFORM.balance == owed);
    }

    function testFactoryAndMarketRuntimeAndInitcodeWithinProtocolLimits() public view {
        require(address(factory).code.length <= 24_576 && address(market).code.length <= 24_576);
        require(address(oracle).code.length <= 24_576 && address(token).code.length <= 24_576);
        require(type(OneshotV4MarketFactory).creationCode.length < 49_152 && type(OneshotV4Market).creationCode.length < 49_152);
        require(factory.creationCodeFirst().code.length < 24_576 && factory.creationCodeSecond().code.length < 24_576);
    }

    function testFactoryPreviewMatchesActualFrozenTickAlignedTerms() public view {
        (int24 lower, int24 upper, uint160 sqrtLower, uint160 sqrtUpper, uint256 effectiveOpening, uint256 effectiveUpper) = factory.previewTerms(1000 ether);
        require(lower == market.tickLower() && upper == market.tickUpper());
        require(sqrtLower == market.sqrtLowerX96() && sqrtUpper == market.sqrtUpperX96());
        require(effectiveOpening == market.effectiveOpeningValuationNative() && effectiveUpper == market.effectiveUpperValuationNative());
    }

    function testBoundedMaintenanceCannotSpendMoreThanNativeCap() public {
        market = factory.createMarket("Bounded", "BOUND", 300, true, 1000 ether); token = market.token();
        market.buy{value: 1 ether}(1, address(this), block.timestamp, 0);
        vm.warp(block.timestamp + 300);
        uint256 managerNative = address(manager).balance;
        uint128 liquidityBefore = market.lockedLiquidity();
        market.process(0.005 ether, type(uint128).max, block.timestamp + 60);
        require(market.lockedLiquidity() > liquidityBefore);
        require(address(manager).balance <= managerNative + 0.005 ether);
        require(market.pendingLiquidityNative() > 0.012 ether && market.pendingBurnNative() > 0.005 ether);
    }

    function testPartialLpConversionHonorsTokenBudgetAndDefersAllocation() public {
        vm.prank(TRADER); uint256 bought = market.buy{value: 10 ether}(1, TRADER, block.timestamp, 0);
        vm.startPrank(TRADER); token.approve(address(market), bought / 2); market.sell(bought / 2, 1, payable(TRADER), block.timestamp, 0); vm.stopPrank();
        market.collectFees();
        uint256 initialTokenFees = market.pendingLpToken(); uint256 initialNativeFees = market.pendingLpNative();
        uint256 owedBefore = market.totalPending(); uint128 principalBefore = market.lockedLiquidity();
        vm.warp(block.timestamp + 300);
        uint256 maximumTokens = initialTokenFees / 2;
        market.process(1 ether, maximumTokens, block.timestamp + 60);
        require(market.pendingLpToken() == initialTokenFees - maximumTokens);
        require(market.pendingLpNative() > initialNativeFees && market.totalPending() == owedBefore);
        require(market.lockedLiquidity() == principalBefore);
        market.process(1 ether, initialTokenFees, block.timestamp + 60);
        require(market.pendingLpToken() == 0 && market.pendingLpNative() == 0 && market.totalPending() > owedBefore);
    }

    function testMaintenanceNativeBudgetCountsSwapAndNewPrincipalTogether() public {
        market = factory.createMarket("Bounded", "BOUND", 300, true, 1000 ether); token = market.token();
        market.buy{value: 1 ether}(1, address(this), block.timestamp, 0); vm.warp(block.timestamp + 300);
        uint256 nativeCap = 0.005 ether;
        vm.recordLogs(); market.process(nativeCap, type(uint128).max, block.timestamp + 60);
        V4Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 swapNative; uint256 principalNative;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(manager) && logs[i].topics[0] == keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")) {
                (int128 nativeDelta,,,,,) = abi.decode(logs[i].data, (int128,int128,uint160,uint128,int24,uint24));
                if (nativeDelta < 0) swapNative += uint256(-int256(nativeDelta));
            }
            if (logs[i].emitter == address(market) && logs[i].topics[0] == keccak256("LiquidityLocked(uint128,uint256,uint256)")) {
                (, principalNative,) = abi.decode(logs[i].data, (uint128,uint256,uint256));
            }
        }
        require(swapNative > 0 && principalNative > 0 && swapNative + principalNative <= nativeCap);
    }

    function testProtocolFeeCanChangeUpstreamButExactQuoteAndExecutionStillAgree() public {
        manager.setProtocolFeeController(address(this));
        manager.setProtocolFee(market.poolKey(), uint24((1000 << 12) | 1000));
        (,, uint24 protocolFee, uint24 lpFee) = manager.getSlot0(market.poolId());
        require(protocolFee != 0 && lpFee == 2500);
        (,, uint24 visibleProtocolFee, uint24 visibleLpFee) = market.poolState();
        require(visibleProtocolFee == protocolFee && visibleLpFee == lpFee);
        OneshotV4Quoter quoter = new OneshotV4Quoter(factory);
        uint256 quote = quoter.quoteSwap(market, true, 0.97 ether, 0);
        uint256 bought = market.buy{value: 1 ether}(quote, address(this), block.timestamp, 0);
        require(quote == bought && market.totalPending() == 0.03 ether);
    }

    function testCreationCodeChunksAreInertAndCannotAlterFutureMarketBytecode() public {
        address first = factory.creationCodeFirst(); address second = factory.creationCodeSecond();
        bytes32 firstHash = first.codehash; bytes32 secondHash = second.codehash;
        bytes memory creation = type(OneshotV4Market).creationCode;
        require(first.code.length + second.code.length == creation.length + 2);
        require(first.code[0] == 0 && second.code[0] == 0);
        (bool okFirst,) = first.call(abi.encodeWithSignature("selfdestruct(address)", TRADER));
        (bool okSecond,) = second.call(abi.encodeWithSignature("replace(bytes)", hex"ff"));
        require(okFirst && okSecond && first.codehash == firstHash && second.codehash == secondHash);
        OneshotV4Market next = factory.createMarket("Immutable", "IMM", 500, true, 3000 ether);
        require(next.factory() == address(factory) && address(next.poolManager()) == address(manager));
        require(next.executionFeeBps() == 500 && next.liquidityAndBurn() && next.openingValuationNative() == 3000 ether);
        require(next.isMarketLaunch() && factory.isMarket(address(next)) && address(next.token().market()) == address(next));
        require(first.codehash == firstHash && second.codehash == secondHash);
    }

    function testQuoterMatchesBuyAndSellWithoutMovingAssetsOrOracleState() public {
        OneshotV4Quoter quoter = new OneshotV4Quoter(factory);
        PoolId id = market.poolId();
        uint256 poolNative = 0.97 ether;
        (uint160 beforePrice, int24 beforeTick,,) = manager.getSlot0(id);
        vm.warp(block.timestamp + 301);
        uint256 quoted = quoter.quoteSwap(market, true, poolNative, 0);
        (uint160 afterPrice, int24 afterTick,,) = manager.getSlot0(id);
        require(beforePrice == afterPrice && beforeTick == afterTick);
        (,,,, uint16 count) = oracle.states(id); require(count == 1);
        require(address(quoter).balance == 0 && token.balanceOf(address(quoter)) == 0 && market.totalPending() == 0);
        uint256 bought = market.buy{value: 1 ether}(quoted, address(this), block.timestamp, 0);
        require(quoted == bought);
        uint256 sellQuoted = quoter.quoteSwap(market, false, bought / 2, 0);
        token.approve(address(market), bought / 2);
        uint256 soldNet = market.sell(bought / 2, sellQuoted - sellQuoted * 300 / 10_000, payable(address(this)), block.timestamp, 0);
        require(soldNet == sellQuoted - sellQuoted * 300 / 10_000);
        require(address(quoter).balance == 0 && token.balanceOf(address(quoter)) == 0);
    }

    function testQuoterRejectsPartialFillsUnregisteredMarketsAndUnexpectedCallbacks() public {
        OneshotV4Quoter quoter = new OneshotV4Quoter(factory);
        vm.expectRevert(OneshotV4Quoter.PartialFill.selector); quoter.quoteSwap(market, true, 1_000_000 ether, 0);
        vm.expectRevert(OneshotV4Quoter.UnauthorizedCallback.selector); quoter.unlockCallback("");
        vm.expectRevert(OneshotV4Quoter.InvalidMarket.selector); quoter.quoteSwap(OneshotV4Market(payable(address(this))), true, 1, 0);
        vm.expectRevert(OneshotV4Quoter.InvalidAmount.selector); quoter.quoteSwap(market, true, 0, 0);
        uint160 invalid = market.sqrtLowerX96() - 1;
        vm.expectRevert(OneshotV4Quoter.InvalidPriceLimit.selector); quoter.quoteSwap(market, true, 1, invalid);
        require(market.totalPending() == 0 && token.balanceOf(address(this)) == 0);
    }
    receive() external payable {}
}
