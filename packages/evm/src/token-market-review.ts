import { encodeAbiParameters, encodeFunctionData, keccak256, zeroAddress, type Address, type Hex } from 'viem';
import { parseAssetAmount, splitExecutionFee, TOKEN_SUPPLY_RAW, type FeeMode } from './economics';
import { BASE_SEPOLIA_GENESIS_HASH, nftNetworkForChainId } from './execution-network';
import { BASE_SEPOLIA_POOL_MANAGER, MARKET_TOKEN_ABI, TOKEN_MARKET_ABI, TOKEN_MARKET_FACTORY_ABI } from './token-market';

const INT128_MAX = (1n << 127n) - 1n;
const UINT160_MAX = (1n << 160n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const encoder = new TextEncoder();
/** Allows time to inspect immutable terms and complete pre-sign RPC checks. Maintenance remains capped at 60s on-chain. */
export const TOKEN_REVIEW_LIFETIME_SECONDS = 120n;

export class TokenMarketReviewError extends Error {
  constructor(readonly code: 'NETWORK' | 'IDENTITY' | 'TERMS' | 'AMOUNT' | 'QUOTE' | 'EXPIRED' | 'RECIPIENT') {
    super({ NETWORK: 'This token uses an unsupported test network.', IDENTITY: 'Refresh this token’s market details before continuing.',
      TERMS: 'Review the token’s name, symbol, fee and test ETH valuation.', AMOUNT: 'Enter a positive amount within the token’s supported precision.',
      QUOTE: 'Get a new trade quote before continuing.', EXPIRED: 'This quote has expired. Get a new quote.',
      RECIPIENT: 'Choose a wallet that can receive this asset.' }[code]);
    this.name = 'TokenMarketReviewError';
  }
}

function fail(code: TokenMarketReviewError['code']): never { throw new TokenMarketReviewError(code); }
function address(value: unknown): Address {
  if (typeof value !== 'string' || !/^0x[\da-f]{40}$/i.test(value) || value.toLowerCase() === zeroAddress) fail('IDENTITY');
  return value.toLowerCase() as Address;
}
function hash(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[\da-f]{64}$/i.test(value) || /^0x0+$/.test(value)) fail('IDENTITY');
  return value.toLowerCase() as Hex;
}
function uint(value: unknown, maximum = UINT256_MAX): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > maximum) fail('AMOUNT');
  return value;
}
function positive(value: unknown, maximum = INT128_MAX): bigint {
  const result = uint(value, maximum); if (!result) fail('AMOUNT'); return result;
}
function fee(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 500 || value % 10 !== 0) fail('TERMS');
  return value;
}
function mode(value: unknown): FeeMode { if (value !== 'creator' && value !== 'liquidity_burn') fail('TERMS'); return value; }
function network(chainId: unknown, genesisHash: unknown) {
  const result = nftNetworkForChainId(chainId); if (!result) fail('NETWORK');
  const genesis = hash(genesisHash);
  if (result.mode === 'base-sepolia' && genesis !== BASE_SEPOLIA_GENESIS_HASH) fail('NETWORK');
  return { network: Object.freeze(result), genesisHash: genesis };
}

export type TokenMarketReviewAnchor = {
  chainId: number; genesisHash: Hex; factory: Address; poolManager: Address; oracle: Address;
  market: Address; token: Address; creator: Address; platformRecipient: Address;
  executionFeeBps: number; feeMode: FeeMode; poolId: Hex;
  sqrtLowerX96: bigint; sqrtUpperX96: bigint;
  blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint;
};

/** Validate an already code/authority-verified server snapshot; this helper makes no RPC calls. */
export function tokenMarketReviewAnchor(input: TokenMarketReviewAnchor) {
  const selected = network(input.chainId, input.genesisHash);
  const factory = address(input.factory); const poolManager = address(input.poolManager); const oracle = address(input.oracle);
  const market = address(input.market); const token = address(input.token);
  if (selected.network.mode === 'base-sepolia' && poolManager !== BASE_SEPOLIA_POOL_MANAGER.toLowerCase()) fail('IDENTITY');
  if (new Set([factory, poolManager, oracle, market, token]).size !== 5) fail('IDENTITY');
  const sqrtLowerX96 = positive(input.sqrtLowerX96, UINT160_MAX); const sqrtUpperX96 = positive(input.sqrtUpperX96, UINT160_MAX);
  if (sqrtLowerX96 >= sqrtUpperX96) fail('IDENTITY');
  const poolId = keccak256(encodeAbiParameters([
    {type:'address'}, {type:'address'}, {type:'uint24'}, {type:'int24'}, {type:'address'},
  ], [zeroAddress, token, 2500, 10, oracle]));
  if (hash(input.poolId) !== poolId) fail('IDENTITY');
  return Object.freeze({ ...selected, factory, poolManager, oracle, market, token, poolId,
    creator: address(input.creator), platformRecipient: address(input.platformRecipient),
    executionFeeBps: fee(input.executionFeeBps), feeMode: mode(input.feeMode), sqrtLowerX96, sqrtUpperX96,
    blockNumber: uint(input.blockNumber), blockHash: hash(input.blockHash), blockTimestamp: uint(input.blockTimestamp),
  });
}

export type TokenLaunchDraft = {
  pricingNetwork?: 'zero' | 'base-sepolia'; name: string; symbol: string;
  openingValuation: string; executionFeeBps: number; feeMode: FeeMode;
};
export type TokenLaunchPreview = {
  tickLower: number; tickUpper: number; sqrtLowerX96: bigint; sqrtUpperX96: bigint;
  effectiveOpeningValuationNative: bigint; effectiveUpperValuationNative: bigint;
};

/** The preview must be read from factory.previewTerms at the same verified block as its simulation. */
export function prepareTokenLaunchCall(input: {
  draft: TokenLaunchDraft; chainId: number; genesisHash: Hex; factory: Address; from: Address; preview: TokenLaunchPreview;
}) {
  const selected = network(input.chainId, input.genesisHash);
  if (selected.network.mode === 'base-sepolia' && input.draft.pricingNetwork !== 'base-sepolia') fail('TERMS');
  const { draft, preview } = input;
  const name = typeof draft.name === 'string' ? draft.name.trim() : ''; const symbol = typeof draft.symbol === 'string' ? draft.symbol.trim() : '';
  if (!name || !symbol || encoder.encode(name).length > 64 || encoder.encode(symbol).length > 16 || /[\u0000-\u001f\u007f]/.test(name + symbol)) fail('TERMS');
  let openingValuation: bigint;
  try { openingValuation = positive(parseAssetAmount(draft.openingValuation, 18), UINT256_MAX / 1000n); } catch { fail('TERMS'); }
  if (!Number.isInteger(preview.tickLower) || !Number.isInteger(preview.tickUpper) || preview.tickLower < -887270 || preview.tickUpper > 887270
    || preview.tickLower % 10 !== 0 || preview.tickUpper % 10 !== 0 || preview.tickLower >= preview.tickUpper
    || positive(preview.sqrtLowerX96, UINT160_MAX) >= positive(preview.sqrtUpperX96, UINT160_MAX)
    || positive(preview.effectiveOpeningValuationNative, UINT256_MAX) < openingValuation || positive(preview.effectiveUpperValuationNative, UINT256_MAX) <= preview.effectiveOpeningValuationNative) fail('TERMS');
  const executionFeeBps = fee(draft.executionFeeBps); const feeMode = mode(draft.feeMode);
  return Object.freeze({ ...selected, from: address(input.from), to: address(input.factory), value: 0n,
    data: encodeFunctionData({ abi: TOKEN_MARKET_FACTORY_ABI, functionName: 'createMarket', args: [name, symbol, executionFeeBps, feeMode === 'liquidity_burn', openingValuation] }),
    terms: Object.freeze({ name, symbol, executionFeeBps, feeMode, openingValuationNative: openingValuation, initialSupplyRaw: TOKEN_SUPPLY_RAW, tokenDecimals: 8 as const,
      tickLower: preview.tickLower, tickUpper: preview.tickUpper, sqrtLowerX96: preview.sqrtLowerX96, sqrtUpperX96: preview.sqrtUpperX96,
      effectiveOpeningValuationNative: preview.effectiveOpeningValuationNative, effectiveUpperValuationNative: preview.effectiveUpperValuationNative }),
  });
}

export type TokenPoolQuote = {
  side: 'buy' | 'sell'; poolInputRaw: bigint; poolOutputRaw: bigint; blockHash: Hex;
};

/** Exact-input quote amounts come from the reverting on-chain quoter, never a spot-price calculation. */
export function prepareTokenTradeCall(input: {
  anchor: TokenMarketReviewAnchor; quote: TokenPoolQuote; amount: string; side: 'buy' | 'sell';
  from: Address; recipient: Address; slippageBps: number; now: bigint; priceLimit?: bigint;
}) {
  const anchor = tokenMarketReviewAnchor(input.anchor);
  if (input.side !== 'buy' && input.side !== 'sell') fail('QUOTE');
  if (input.quote.side !== input.side || hash(input.quote.blockHash) !== anchor.blockHash) fail('QUOTE');
  const now = uint(input.now); const deadline = anchor.blockTimestamp + TOKEN_REVIEW_LIFETIME_SECONDS;
  if (now < anchor.blockTimestamp || now >= deadline) fail('EXPIRED');
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 1000) fail('QUOTE');
  let amount: bigint;
  try { amount = positive(parseAssetAmount(input.amount, input.side === 'buy' ? 18 : 8)); } catch { fail('AMOUNT'); }
  const from = address(input.from); const recipient = address(input.recipient);
  if ([anchor.market, anchor.poolManager, anchor.token, anchor.factory, anchor.oracle].includes(recipient)) fail('RECIPIENT');
  const poolInput = positive(input.quote.poolInputRaw); const poolOutput = positive(input.quote.poolOutputRaw);
  const native = splitExecutionFee(input.side === 'buy' ? amount : poolOutput, anchor.executionFeeBps, anchor.feeMode);
  if (poolInput !== (input.side === 'buy' ? native.net : amount)) fail('QUOTE');
  const quotedReceive = input.side === 'buy' ? poolOutput : native.net;
  const minimumReceive = quotedReceive * BigInt(10_000 - input.slippageBps) / 10_000n;
  if (minimumReceive === 0n) fail('AMOUNT');
  const priceLimit = input.priceLimit === undefined ? (input.side === 'buy' ? anchor.sqrtLowerX96 : anchor.sqrtUpperX96) : positive(input.priceLimit, UINT160_MAX);
  if (priceLimit < anchor.sqrtLowerX96 || priceLimit > anchor.sqrtUpperX96) fail('QUOTE');
  const data = input.side === 'buy'
    ? encodeFunctionData({ abi: TOKEN_MARKET_ABI, functionName: 'buy', args: [minimumReceive, recipient, deadline, priceLimit] })
    : encodeFunctionData({ abi: TOKEN_MARKET_ABI, functionName: 'sell', args: [amount, minimumReceive, recipient, deadline, priceLimit] });
  return Object.freeze({ network: anchor.network, genesisHash: anchor.genesisHash, blockNumber: anchor.blockNumber, blockHash: anchor.blockHash,
    from, to: anchor.market, value: input.side === 'buy' ? amount : 0n, data, deadline,
    summary: Object.freeze({ side: input.side, token: anchor.token, recipient, amountRaw: amount, poolInputRaw: poolInput,
      quotedReceiveRaw: quotedReceive, minimumReceiveRaw: minimumReceive, grossNativeRaw: native.gross,
      quotedExecutionFeeRaw: native.fee, executionFeeBps: anchor.executionFeeBps, feeMode: anchor.feeMode,
      lpFeePips: 2500, protocolFeeMayApply: true, gasPaidSeparately: true, fullInputRequired: true,
    }),
  });
}

/** Exact allowance, bound to this market. Existing approvals are never silently increased to infinity. */
export function prepareTokenApprovalCall(anchorInput: TokenMarketReviewAnchor, fromInput: Address, tokenAmount: string) {
  const anchor = tokenMarketReviewAnchor(anchorInput); let amount: bigint;
  try { amount = positive(parseAssetAmount(tokenAmount, 8)); } catch { fail('AMOUNT'); }
  return Object.freeze({ network: anchor.network, genesisHash: anchor.genesisHash, from: address(fromInput), to: anchor.token, value: 0n,
    data: encodeFunctionData({ abi: MARKET_TOKEN_ABI, functionName: 'approve', args: [anchor.market, amount] }),
    spender: anchor.market, allowanceRaw: amount,
  });
}
