// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {OneshotMarketToken} from "./OneshotMarketToken.sol";
import {OneshotV4Oracle} from "./OneshotV4Oracle.sol";
import {OneshotV4Math} from "./OneshotV4Math.sol";

/// @notice One testnet token, one immutable v4 principal position, and explicit oneshot executions.
/// No owner/proxy/arbitrary call/approval/removal/range-change path exists. The AMM
/// position is owned directly by this contract, not by a transferable position NFT.
contract OneshotV4Market is IUnlockCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    uint24 public constant LP_FEE = 2500;
    int24 public constant TICK_SPACING = 10;
    uint256 public constant MIN_PROCESSING_NATIVE = 0.01 ether;
    uint256 public constant MAX_MAINTENANCE_LIFETIME = 60;
    int24 public constant MAX_ORACLE_TICK_DEVIATION = 50;
    uint32 public constant ORACLE_WINDOW = 300;
    address public constant BASE_SEPOLIA_POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
    bytes32 public constant POSITION_SALT = keccak256("ONESHOT_LOCKED_PRINCIPAL_V1");
    IPoolManager public immutable poolManager;
    OneshotV4Oracle public immutable oracle;
    OneshotMarketToken public immutable token;
    address public immutable factory;
    address public immutable creator;
    address public immutable platformRecipient;
    uint256 public immutable deploymentChainId;
    uint16 public immutable executionFeeBps;
    bool public immutable liquidityAndBurn;
    uint256 public immutable openingValuationNative;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    uint160 public immutable sqrtLowerX96;
    uint160 public immutable sqrtUpperX96;
    PoolId public immutable poolId;
    bool public initialized;
    uint128 public lockedLiquidity;
    uint256 public lockedRoundingDust;
    mapping(address => uint256) public pending;
    uint256 public totalPending;
    uint256 public pendingLpNative;
    uint256 public pendingLpToken;
    uint256 public pendingLiquidityNative;
    uint256 public pendingLiquidityToken;
    uint256 public pendingBurnNative;
    bytes32 private _callbackHash;

    enum Operation { Liquidity, Swap }
    struct Call { Operation operation; uint128 liquidity; bool nativeToToken; uint256 amount; uint256 minimum; uint160 limit; }
    struct Modification { uint256 nativePrincipal; uint256 tokenPrincipal; uint256 nativeFee; uint256 tokenFee; }
    struct Terms { address creator; address platform; uint16 feeBps; bool liquidityAndBurn; uint256 openingValuation; }
    error UnsupportedTestChain(uint256 chainId);
    error InvalidProtocol();
    error InvalidTerms();
    error OnlyFactory();
    error AlreadyInitialized();
    error MarketNotInitialized();
    error InvalidAmount();
    error InvalidRecipient();
    error Deadline();
    error InvalidPriceLimit();
    error PartialFill();
    error Slippage();
    error UnauthorizedCallback();
    error InvalidDelta();
    error PaymentFailed();
    error NothingToClaim();
    error BudgetTooSmall();
    error OracleDeviation();
    error InsolventAccounting();

    event MarketInitialized(uint128 liquidity, uint256 lockedDust);
    event Trade(address indexed trader, address indexed recipient, bool buy, uint256 tokens, uint256 grossNative, uint256 netNative, uint256 executionFee);
    event RevenueAllocated(uint256 total, uint256 platform, uint256 creator, uint256 liquidity, uint256 burn);
    event LpFeesCollected(uint256 nativeAmount, uint256 tokenAmount);
    event Claimed(address indexed beneficiary, address indexed recipient, uint256 amount);
    event LiquidityLocked(uint128 added, uint256 nativePrincipal, uint256 tokenPrincipal);
    event MaintenanceProcessed(uint256 tokenFeesConverted, uint256 nativeFromConversion, uint128 liquidityAdded, uint256 tokensBurned);

    constructor(IPoolManager manager, OneshotV4Oracle oracle_, string memory name, string memory symbol, Terms memory terms) {
        if (block.chainid != 31337 && block.chainid != 84532) revert UnsupportedTestChain(block.chainid);
        if (address(manager).code.length == 0 || address(oracle_).code.length == 0 || address(oracle_.poolManager()) != address(manager)
            || (block.chainid == 84532 && address(manager) != BASE_SEPOLIA_POOL_MANAGER)) revert InvalidProtocol();
        if (terms.creator == address(0) || terms.platform == address(0) || terms.feeBps < 100 || terms.feeBps > 500 || terms.feeBps % 10 != 0) revert InvalidTerms();
        poolManager = manager; oracle = oracle_; factory = msg.sender; creator = terms.creator; platformRecipient = terms.platform;
        deploymentChainId = block.chainid; executionFeeBps = terms.feeBps; liquidityAndBurn = terms.liquidityAndBurn;
        openingValuationNative = terms.openingValuation;
        (int24 lower, int24 upper) = OneshotV4Math.ticks(terms.openingValuation);
        tickLower = lower; tickUpper = upper;
        sqrtLowerX96 = TickMath.getSqrtPriceAtTick(lower); sqrtUpperX96 = TickMath.getSqrtPriceAtTick(upper);
        token = new OneshotMarketToken(name, symbol);
        poolId = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), LP_FEE, TICK_SPACING, IHooks(address(oracle_))).toId();
    }

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), LP_FEE, TICK_SPACING, IHooks(address(oracle)));
    }

    function poolState() external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee) {
        return poolManager.getSlot0(poolId);
    }

    /// @notice Atomic factory launch, after constructor completion so v4 can call this contract's callback.
    function initialize() external nonReentrant {
        if (msg.sender != factory) revert OnlyFactory();
        if (initialized) revert AlreadyInitialized();
        _chain(); initialized = true;
        poolManager.initialize(poolKey(), sqrtUpperX96);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmount1(sqrtLowerX96, sqrtUpperX96, token.INITIAL_SUPPLY());
        if (liquidity == 0 || liquidity > uint128(type(int128).max)) revert InvalidAmount();
        Modification memory change = _modify(liquidity);
        if (change.nativePrincipal != 0 || change.nativeFee != 0 || change.tokenFee != 0) revert InvalidDelta();
        lockedLiquidity = liquidity;
        lockedRoundingDust = token.balanceOf(address(this));
        if (change.tokenPrincipal + lockedRoundingDust != token.INITIAL_SUPPLY()) revert InsolventAccounting();
        emit MarketInitialized(liquidity, lockedRoundingDust);
    }

    function isMarketLaunch() external view returns (bool) { return initialized && lockedLiquidity != 0; }
    function effectiveOpeningValuationNative() external view returns (uint256) { return OneshotV4Math.quote(sqrtUpperX96, token.INITIAL_SUPPLY(), false); }
    function effectiveUpperValuationNative() external view returns (uint256) { return OneshotV4Math.quote(sqrtLowerX96, token.INITIAL_SUPPLY(), false); }

    function buy(uint256 minimumTokensOut, address recipient, uint256 deadline, uint160 priceLimit) external payable nonReentrant returns (uint256 tokensOut) {
        _ready(); _deadline(deadline); _recipient(recipient);
        uint256 fee = Math.mulDiv(msg.value, executionFeeBps, 10_000);
        uint256 net = msg.value - fee;
        tokensOut = _swap(true, net, minimumTokensOut, _priceLimit(true, priceLimit));
        _allocate(fee);
        if (!token.transfer(recipient, tokensOut)) revert PaymentFailed();
        _solvent();
        emit Trade(msg.sender, recipient, true, tokensOut, msg.value, net, fee);
    }

    function sell(uint256 tokenAmount, uint256 minimumNetNativeOut, address payable recipient, uint256 deadline, uint160 priceLimit) external nonReentrant returns (uint256 netNative) {
        _ready(); _deadline(deadline); _recipient(recipient);
        uint256 balance = token.balanceOf(address(this));
        if (!token.transferFrom(msg.sender, address(this), tokenAmount) || token.balanceOf(address(this)) - balance != tokenAmount) revert PaymentFailed();
        uint256 gross = _swap(false, tokenAmount, 1, _priceLimit(false, priceLimit));
        uint256 fee = Math.mulDiv(gross, executionFeeBps, 10_000);
        netNative = gross - fee;
        if (netNative < minimumNetNativeOut) revert Slippage();
        _allocate(fee); _pay(recipient, netNative); _solvent();
        emit Trade(msg.sender, recipient, false, tokenAmount, gross, netNative, fee);
    }

    function claimTo(address payable recipient) external nonReentrant {
        _recipient(recipient);
        uint256 amount = pending[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pending[msg.sender] = 0; totalPending -= amount;
        _pay(recipient, amount); _solvent();
        emit Claimed(msg.sender, recipient, amount);
    }

    /// @notice Fee collection never removes principal and requires no oracle or external recipient call.
    function collectFees() external nonReentrant { _ready(); _collect(); _solvent(); }

    /// @notice Permissionless bounded testnet maintenance. Insufficient observations or
    /// unsafe execution reverts atomically, preserving every pending asset and liability.
    function process(uint256 maximumNativeBudget, uint256 maximumTokenBudget, uint256 deadline) external nonReentrant {
        _ready(); _deadline(deadline);
        if (deadline > block.timestamp + MAX_MAINTENANCE_LIFETIME || maximumNativeBudget == 0 || maximumTokenBudget == 0) revert Deadline();
        int24 mean = oracle.consult(poolId, ORACLE_WINDOW);
        uint160 referencePrice = TickMath.getSqrtPriceAtTick(mean);
        _oracleGuard(mean);
        _collect();
        uint256 totalBudget = pendingLpNative + pendingLiquidityNative + pendingBurnNative
            + OneshotV4Math.quote(referencePrice, pendingLpToken + pendingLiquidityToken, false);
        if (totalBudget < MIN_PROCESSING_NATIVE) revert BudgetTooSmall();
        uint256 converted = Math.min(pendingLpToken, maximumTokenBudget);
        uint256 nativeConverted;
        if (converted != 0) {
            nativeConverted = _maintenanceSwap(false, converted, mean, referencePrice);
            pendingLpToken -= converted; pendingLpNative += nativeConverted;
        }
        if (pendingLpToken == 0 && pendingLpNative != 0) {
            uint256 earned = pendingLpNative; pendingLpNative = 0; _allocate(earned);
        }
        (uint128 added, uint256 nativeSpent) = _reinvest(maximumNativeBudget, maximumTokenBudget - converted, mean, referencePrice);
        uint256 burnBudget = Math.min(pendingBurnNative, maximumNativeBudget - nativeSpent);
        uint256 burned;
        if (burnBudget != 0) {
            burned = _maintenanceSwap(true, burnBudget, mean, referencePrice);
            pendingBurnNative -= burnBudget;
            token.burn(burned);
        }
        _solvent();
        emit MaintenanceProcessed(converted, nativeConverted, added, burned);
    }

    function _reinvest(uint256 maximumNative, uint256 maximumTokens, int24 mean, uint160 referencePrice) private returns (uint128 added, uint256 spent) {
        uint256 nativeBudget = Math.min(pendingLiquidityNative, maximumNative);
        uint256 tokenBudget = Math.min(pendingLiquidityToken, maximumTokens);
        if (nativeBudget == 0 && tokenBudget == 0) return (0, 0);
        _oracleGuard(mean);
        (uint160 current,,,) = poolManager.getSlot0(poolId);
        uint256 toSwap = _reinvestmentSwap(current, nativeBudget, tokenBudget);
        if (toSwap != 0) {
            uint256 acquired = _maintenanceSwap(true, toSwap, mean, referencePrice);
            pendingLiquidityNative -= toSwap; pendingLiquidityToken += acquired;
            nativeBudget -= toSwap; tokenBudget += acquired; spent = toSwap;
        }
        (current,,,) = poolManager.getSlot0(poolId);
        added = LiquidityAmounts.getLiquidityForAmounts(current, sqrtLowerX96, sqrtUpperX96, nativeBudget, tokenBudget);
        if (added == 0) return (0, spent);
        if (added > uint128(type(int128).max) || uint256(lockedLiquidity) + added > uint128(type(int128).max)) revert InvalidAmount();
        Modification memory change = _modify(added);
        if (change.nativePrincipal > nativeBudget || change.tokenPrincipal > tokenBudget) revert Slippage();
        pendingLiquidityNative -= change.nativePrincipal; pendingLiquidityToken -= change.tokenPrincipal;
        pendingLpNative += change.nativeFee; pendingLpToken += change.tokenFee;
        spent += change.nativePrincipal;
        lockedLiquidity += added;
        emit LiquidityLocked(added, change.nativePrincipal, change.tokenPrincipal);
    }

    /// Current-range inventory ratio, followed by actual post-swap liquidity sizing.
    /// Price movement/rounding can leave inventory pending; it is never sent to a recipient or burned as dust.
    function _reinvestmentSwap(uint160 current, uint256 nativeBudget, uint256 tokenBudget) private view returns (uint256) {
        if (current <= sqrtLowerX96) return 0;
        if (current >= sqrtUpperX96) return nativeBudget;
        uint256 tokenWeight = FullMath.mulDiv(current - sqrtLowerX96, 1 << 96, current);
        uint256 nativeWeight = FullMath.mulDiv(sqrtUpperX96 - current, 1 << 96, sqrtUpperX96);
        uint256 denominator = tokenWeight + nativeWeight;
        uint256 desired = FullMath.mulDiv(nativeBudget, tokenWeight, denominator);
        uint256 existing = FullMath.mulDiv(OneshotV4Math.quote(current, tokenBudget, false), nativeWeight, denominator);
        return desired > existing ? desired - existing : 0;
    }

    function _maintenanceSwap(bool buy_, uint256 amount, int24 mean, uint160 referencePrice) private returns (uint256 output) {
        _oracleGuard(mean);
        uint256 minimum = Math.mulDiv(OneshotV4Math.quote(referencePrice, amount, buy_), 9900, 10_000);
        if (minimum == 0) revert BudgetTooSmall();
        int24 boundary = buy_ ? mean - MAX_ORACLE_TICK_DEVIATION : mean + MAX_ORACLE_TICK_DEVIATION;
        if (boundary < tickLower) boundary = tickLower;
        if (boundary > tickUpper) boundary = tickUpper;
        output = _swap(buy_, amount, minimum, TickMath.getSqrtPriceAtTick(boundary));
        _oracleGuard(mean);
    }

    function _oracleGuard(int24 mean) private view {
        (uint160 price, int24 current,,) = poolManager.getSlot0(poolId);
        int256 difference = int256(current) - mean;
        if (difference < -MAX_ORACLE_TICK_DEVIATION || difference > MAX_ORACLE_TICK_DEVIATION || price < sqrtLowerX96 || price > sqrtUpperX96) revert OracleDeviation();
    }

    function _collect() private {
        Modification memory change = _modify(0);
        if (change.nativePrincipal != 0 || change.tokenPrincipal != 0) revert InvalidDelta();
        pendingLpNative += change.nativeFee; pendingLpToken += change.tokenFee;
        emit LpFeesCollected(change.nativeFee, change.tokenFee);
    }

    function _allocate(uint256 total) private {
        if (total == 0) return;
        uint256 platform = Math.mulDiv(total, 2000, 10_000);
        uint256 destination = total - platform;
        pending[platformRecipient] += platform; totalPending += platform;
        uint256 liq; uint256 burn; uint256 creatorAmount;
        if (liquidityAndBurn) {
            liq = Math.mulDiv(destination, 7500, 10_000); burn = destination - liq;
            pendingLiquidityNative += liq; pendingBurnNative += burn;
        } else { creatorAmount = destination; pending[creator] += destination; totalPending += destination; }
        emit RevenueAllocated(total, platform, creatorAmount, liq, burn);
    }

    function _modify(uint128 liquidity) private returns (Modification memory) {
        return abi.decode(_unlock(Call(Operation.Liquidity, liquidity, false, 0, 0, 0)), (Modification));
    }

    function _swap(bool nativeToToken, uint256 amount, uint256 minimum, uint160 limit) private returns (uint256) {
        if (amount == 0 || amount > uint256(uint128(type(int128).max)) || minimum == 0) revert InvalidAmount();
        return abi.decode(_unlock(Call(Operation.Swap, 0, nativeToToken, amount, minimum, limit)), (uint256));
    }

    function _unlock(Call memory call_) private returns (bytes memory result) {
        if (_callbackHash != bytes32(0)) revert UnauthorizedCallback();
        bytes memory data = abi.encode(call_);
        _callbackHash = keccak256(data);
        result = poolManager.unlock(data);
        if (_callbackHash != bytes32(0)) revert UnauthorizedCallback();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || _callbackHash == bytes32(0) || _callbackHash != keccak256(data)) revert UnauthorizedCallback();
        _callbackHash = bytes32(0);
        Call memory call_ = abi.decode(data, (Call));
        if (call_.operation == Operation.Liquidity) {
            (BalanceDelta delta, BalanceDelta fees) = poolManager.modifyLiquidity(poolKey(), ModifyLiquidityParams(tickLower, tickUpper, int256(uint256(call_.liquidity)), POSITION_SALT), bytes(""));
            BalanceDelta principal = delta - fees;
            if (principal.amount0() > 0 || principal.amount1() > 0 || fees.amount0() < 0 || fees.amount1() < 0) revert InvalidDelta();
            Modification memory change = Modification(uint256(-int256(principal.amount0())), uint256(-int256(principal.amount1())), uint256(int256(fees.amount0())), uint256(int256(fees.amount1())));
            _settle(delta);
            return abi.encode(change);
        }
        BalanceDelta swapDelta = poolManager.swap(poolKey(), SwapParams(call_.nativeToToken, -int256(call_.amount), call_.limit), bytes(""));
        int128 input = call_.nativeToToken ? swapDelta.amount0() : swapDelta.amount1();
        int128 output = call_.nativeToToken ? swapDelta.amount1() : swapDelta.amount0();
        if (input >= 0 || uint256(-int256(input)) != call_.amount) revert PartialFill();
        if (output <= 0 || uint256(int256(output)) < call_.minimum) revert Slippage();
        _settle(swapDelta);
        return abi.encode(uint256(int256(output)));
    }

    function _settle(BalanceDelta delta) private {
        int128 nativeDelta = delta.amount0(); int128 tokenDelta = delta.amount1();
        if (nativeDelta < 0) {
            poolManager.sync(Currency.wrap(address(0)));
            uint256 nativeAmount = uint256(-int256(nativeDelta));
            if (poolManager.settle{value: nativeAmount}() != nativeAmount) revert InvalidDelta();
        } else if (nativeDelta > 0) poolManager.take(Currency.wrap(address(0)), address(this), uint256(int256(nativeDelta)));
        if (tokenDelta < 0) {
            uint256 amount = uint256(-int256(tokenDelta));
            poolManager.sync(Currency.wrap(address(token)));
            if (!token.transfer(address(poolManager), amount) || poolManager.settle() != amount) revert InvalidDelta();
        } else if (tokenDelta > 0) poolManager.take(Currency.wrap(address(token)), address(this), uint256(int256(tokenDelta)));
    }

    function _priceLimit(bool buy_, uint160 limit) private view returns (uint160) {
        if (limit == 0) return buy_ ? sqrtLowerX96 : sqrtUpperX96;
        if (limit < sqrtLowerX96 || limit > sqrtUpperX96) revert InvalidPriceLimit();
        return limit;
    }
    function _deadline(uint256 deadline) private view { if (deadline < block.timestamp) revert Deadline(); }
    function _chain() private view { if (block.chainid != deploymentChainId) revert UnsupportedTestChain(block.chainid); }
    function _ready() private view { _chain(); if (!initialized) revert MarketNotInitialized(); }
    function _recipient(address recipient) private view { if (recipient == address(0) || recipient == address(this) || recipient == address(poolManager)) revert InvalidRecipient(); }
    function _pay(address payable recipient, uint256 amount) private { (bool paid,) = recipient.call{value: amount}(""); if (!paid) revert PaymentFailed(); }
    function _solvent() private view {
        if (address(this).balance < totalPending + pendingLpNative + pendingLiquidityNative + pendingBurnNative
            || token.balanceOf(address(this)) < lockedRoundingDust + pendingLpToken + pendingLiquidityToken) revert InsolventAccounting();
    }
    receive() external payable { if (msg.sender != address(poolManager)) revert UnauthorizedCallback(); }
}

/// @dev Immutable, non-executable creation-code storage. The leading STOP makes
/// the bytes inert; no method can change or destroy this contract's code.
contract OneshotV4CreationCode {
    constructor(bytes memory code) {
        bytes memory inert = abi.encodePacked(hex"00", code);
        assembly ("memory-safe") { return(add(inert, 32), mload(inert)) }
    }
}

contract OneshotV4MarketFactory {
    IPoolManager public immutable poolManager;
    OneshotV4Oracle public immutable oracle;
    address public immutable platformRecipient;
    address public immutable creationCodeFirst;
    address public immutable creationCodeSecond;
    uint256 public immutable creationCodeLength;
    uint256 private immutable _firstLength;
    mapping(address => bool) public isMarket;
    mapping(address => address) public marketForToken;
    address[] public markets;
    error InvalidProtocol();
    error UnsupportedTestChain(uint256 chainId);
    error DeploymentFailed();
    event MarketCreated(address indexed market, address indexed token, address indexed creator, bytes32 poolId);

    constructor(IPoolManager manager, OneshotV4Oracle oracle_, address platform) {
        if (block.chainid != 31337 && block.chainid != 84532) revert UnsupportedTestChain(block.chainid);
        if (platform == address(0) || address(manager).code.length == 0 || address(oracle_).code.length == 0
            || address(oracle_.poolManager()) != address(manager)
            || (block.chainid == 84532 && address(manager) != 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408)) revert InvalidProtocol();
        poolManager = manager; oracle = oracle_; platformRecipient = platform;
        bytes memory code = type(OneshotV4Market).creationCode;
        uint256 split = code.length / 2;
        bytes memory first = new bytes(split);
        bytes memory second = new bytes(code.length - split);
        for (uint256 i; i < split; i++) first[i] = code[i];
        for (uint256 i; i < second.length; i++) second[i] = code[split + i];
        creationCodeFirst = address(new OneshotV4CreationCode(first));
        creationCodeSecond = address(new OneshotV4CreationCode(second));
        creationCodeLength = code.length; _firstLength = split;
    }

    function createMarket(string calldata name, string calldata symbol, uint16 feeBps, bool liquidityAndBurn, uint256 openingValuationNative) external returns (OneshotV4Market market) {
        market = _deploy(abi.encode(poolManager, oracle, name, symbol, OneshotV4Market.Terms(msg.sender, platformRecipient, feeBps, liquidityAndBurn, openingValuationNative)));
        market.initialize();
        address token = address(market.token());
        isMarket[address(market)] = true; marketForToken[token] = address(market); markets.push(address(market));
        emit MarketCreated(address(market), token, msg.sender, PoolId.unwrap(market.poolId()));
    }

    function _deploy(bytes memory arguments) private returns (OneshotV4Market market) {
        bytes memory code = new bytes(creationCodeLength);
        address first = creationCodeFirst; address second = creationCodeSecond;
        uint256 split = _firstLength; uint256 length = creationCodeLength;
        assembly ("memory-safe") {
            extcodecopy(first, add(code, 32), 1, split)
            extcodecopy(second, add(add(code, 32), split), 1, sub(length, split))
        }
        bytes memory initialization = abi.encodePacked(code, arguments);
        address deployed;
        assembly ("memory-safe") { deployed := create(0, add(initialization, 32), mload(initialization)) }
        if (deployed == address(0)) {
            assembly ("memory-safe") {
                let length_ := returndatasize()
                if length_ { returndatacopy(0, 0, length_) revert(0, length_) }
            }
            revert DeploymentFailed();
        }
        market = OneshotV4Market(payable(deployed));
    }
    function marketCount() external view returns (uint256) { return markets.length; }

    function previewTerms(uint256 openingValuationNative) external pure returns (int24 lower, int24 upper, uint160 sqrtLower, uint160 sqrtUpper, uint256 effectiveOpeningValuationNative, uint256 effectiveUpperValuationNative) {
        (lower, upper) = OneshotV4Math.ticks(openingValuationNative);
        sqrtLower = TickMath.getSqrtPriceAtTick(lower); sqrtUpper = TickMath.getSqrtPriceAtTick(upper);
        effectiveOpeningValuationNative = OneshotV4Math.quote(sqrtUpper, 100_000_000_000_000_000, false);
        effectiveUpperValuationNative = OneshotV4Math.quote(sqrtLower, 100_000_000_000_000_000, false);
    }
}
