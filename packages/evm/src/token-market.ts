import { parseAbi } from 'viem';

/** Testnet protocol identity. A constant is not proof that code is deployed at an address. */
export const BASE_SEPOLIA_POOL_MANAGER = '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408' as const;
export const TOKEN_MARKET_LP_FEE_PIPS = 2500;
export const TOKEN_MARKET_TICK_SPACING = 10;

/** v4 takes the direction's protocol fee first, then the static LP fee on the remainder. */
export function tokenDexSwapFee(packedProtocolFee:number,side:'buy'|'sell'){
  if(!Number.isInteger(packedProtocolFee)||packedProtocolFee<0||packedProtocolFee>0xffffff||!['buy','sell'].includes(side))throw new RangeError('Invalid pool fee.');
  const buyFee=packedProtocolFee&0xfff,sellFee=packedProtocolFee>>>12;
  if(buyFee>1000||sellFee>1000)throw new RangeError('Invalid pool protocol fee.');
  const protocolFeePips=side==='buy'?buyFee:sellFee;
  return{protocolFeePips,lpFeePips:TOKEN_MARKET_LP_FEE_PIPS,totalDexFeePips:protocolFeePips+TOKEN_MARKET_LP_FEE_PIPS-Math.floor(protocolFeePips*TOKEN_MARKET_LP_FEE_PIPS/1000000)};
}

/** OneshotV4MarketFactory, including the immutable deployment authorities. */
export const TOKEN_MARKET_FACTORY_ABI = parseAbi([
  'function poolManager() view returns (address)',
  'function oracle() view returns (address)',
  'function platformRecipient() view returns (address)',
  'function minProcessingNative() view returns (uint256)',
  'function isMarket(address) view returns (bool)',
  'function marketForToken(address) view returns (address)',
  'function markets(uint256) view returns (address)',
  'function marketCount() view returns (uint256)',
  'function previewTerms(uint256 openingValuationNative) pure returns (int24 lower, int24 upper, uint160 sqrtLower, uint160 sqrtUpper, uint256 effectiveOpeningValuationNative, uint256 effectiveUpperValuationNative)',
  'function createMarket(string name, string symbol, uint16 feeBps, bool liquidityAndBurn, uint256 openingValuationNative) returns (address market)',
  'event MarketCreated(address indexed market, address indexed token, address indexed creator, bytes32 poolId)',
  'error InvalidProtocol()', 'error UnsupportedTestChain(uint256 chainId)',
]);

/** Reviewed against OneshotV4Market.sol. Values are raw native/token amounts. */
export const TOKEN_MARKET_ABI = parseAbi([
  'function poolManager() view returns (address)',
  'function oracle() view returns (address)',
  'function factory() view returns (address)',
  'function token() view returns (address)',
  'function creator() view returns (address)',
  'function platformRecipient() view returns (address)',
  'function deploymentChainId() view returns (uint256)',
  'function minProcessingNative() view returns (uint256)',
  'function executionFeeBps() view returns (uint16)',
  'function liquidityAndBurn() view returns (bool)',
  'function openingValuationNative() view returns (uint256)',
  'function tickLower() view returns (int24)',
  'function tickUpper() view returns (int24)',
  'function sqrtLowerX96() view returns (uint160)',
  'function sqrtUpperX96() view returns (uint160)',
  'function poolId() view returns (bytes32)',
  'function poolKey() view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))',
  'function poolState() view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function initialized() view returns (bool)',
  'function isMarketLaunch() view returns (bool)',
  'function lockedLiquidity() view returns (uint128)',
  'function lockedRoundingDust() view returns (uint256)',
  'function effectiveOpeningValuationNative() view returns (uint256)',
  'function effectiveUpperValuationNative() view returns (uint256)',
  'function pending(address) view returns (uint256)',
  'function totalPending() view returns (uint256)',
  'function pendingLpNative() view returns (uint256)',
  'function pendingLpToken() view returns (uint256)',
  'function pendingLiquidityNative() view returns (uint256)',
  'function pendingLiquidityToken() view returns (uint256)',
  'function pendingBurnNative() view returns (uint256)',
  'function buy(uint256 minimumTokensOut, address recipient, uint256 deadline, uint160 priceLimit) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokenAmount, uint256 minimumNetNativeOut, address recipient, uint256 deadline, uint160 priceLimit) returns (uint256 netNative)',
  'function claimTo(address recipient)',
  'function collectFees()',
  'function process(uint256 maximumNativeBudget, uint256 maximumTokenBudget, uint256 deadline)',
  'event MarketInitialized(uint128 liquidity, uint256 lockedDust)',
  'event Trade(address indexed trader, address indexed recipient, bool buy, uint256 tokens, uint256 grossNative, uint256 netNative, uint256 executionFee)',
  'event RevenueAllocated(uint256 total, uint256 platform, uint256 creator, uint256 liquidity, uint256 burn)',
  'event LpFeesCollected(uint256 nativeAmount, uint256 tokenAmount)',
  'event Claimed(address indexed beneficiary, address indexed recipient, uint256 amount)',
  'event LiquidityLocked(uint128 added, uint256 nativePrincipal, uint256 tokenPrincipal)',
  'event MaintenanceProcessed(uint256 tokenFeesConverted, uint256 nativeFromConversion, uint128 liquidityAdded, uint256 tokensBurned)',
  'error UnsupportedTestChain(uint256 chainId)', 'error InvalidProtocol()', 'error InvalidTerms()',
  'error OnlyFactory()', 'error AlreadyInitialized()', 'error MarketNotInitialized()',
  'error InvalidAmount()', 'error InvalidRecipient()', 'error Deadline()', 'error InvalidPriceLimit()',
  'error PartialFill()', 'error Slippage()', 'error UnauthorizedCallback()', 'error InvalidDelta()',
  'error PaymentFailed()', 'error NothingToClaim()', 'error BudgetTooSmall()', 'error OracleDeviation()',
  'error InsolventAccounting()', 'error ReentrancyGuardReentrantCall()',
]);

export const MARKET_TOKEN_ABI = parseAbi([
  'function name() view returns (string)', 'function symbol() view returns (string)',
  'function decimals() pure returns (uint8)', 'function INITIAL_SUPPLY() view returns (uint256)',
  'function totalSupply() view returns (uint256)', 'function market() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  'function burn(uint256 amount)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);

/** Reverting simulation; call through eth_call. No balance or allowance is needed. */
export const TOKEN_MARKET_QUOTER_ABI = parseAbi([
  'constructor(address factory_)',
  'function factory() view returns (address)', 'function poolManager() view returns (address)',
  'function quoteSwap(address market, bool buy, uint256 poolInput, uint160 priceLimit) returns (uint256 output)',
  'error InvalidFactory()', 'error InvalidMarket()', 'error InvalidAmount()', 'error InvalidPriceLimit()',
  'error UnauthorizedCallback()', 'error PartialFill()', 'error NoOutput()', 'error MalformedQuote()',
  'error QuoteResult(uint256 actualInput, uint256 output)',
]);
