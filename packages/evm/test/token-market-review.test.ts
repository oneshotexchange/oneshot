import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, keccak256, zeroAddress, type Address, type Hex } from 'viem';
import { BASE_SEPOLIA_GENESIS_HASH } from '../src/execution-network';
import { BASE_SEPOLIA_POOL_MANAGER, MARKET_TOKEN_ABI, TOKEN_MARKET_ABI, TOKEN_MARKET_FACTORY_ABI, tokenDexSwapFee } from '../src/token-market';
import { prepareTokenApprovalCall, prepareTokenLaunchCall, prepareTokenTradeCall, tokenMarketReviewAnchor, type TokenMarketReviewAnchor } from '../src/token-market-review';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const anchor: TokenMarketReviewAnchor = {
  chainId: 84532, genesisHash: BASE_SEPOLIA_GENESIS_HASH, factory: a(1), poolManager: BASE_SEPOLIA_POOL_MANAGER, oracle: a(3),
  market: a(4), token: a(5), creator: a(6), platformRecipient: a(7), executionFeeBps: 150, feeMode: 'creator',
  poolId: keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}], [zeroAddress,a(5),2500,10,a(3)])),
  sqrtLowerX96: 100n, sqrtUpperX96: 10000n, blockNumber: 1000n, blockHash: h(1), blockTimestamp: 10000n,
};
const buy = () => ({ anchor, quote: { side: 'buy' as const, poolInputRaw: 985000000000000000n, poolOutputRaw: 1234567890n, blockHash: anchor.blockHash },
  amount: '1', side: 'buy' as const, from: a(10), recipient: a(11), slippageBps: 100, now: 10001n });

describe('token market exact transaction preparation', () => {
  it('combines direction-specific protocol and LP fees with v4 integer rounding',()=>{
    expect(tokenDexSwapFee(1000|(500<<12),'buy')).toEqual({protocolFeePips:1000,lpFeePips:2500,totalDexFeePips:3498});
    expect(tokenDexSwapFee(1000|(500<<12),'sell')).toEqual({protocolFeePips:500,lpFeePips:2500,totalDexFeePips:2999});
    expect(tokenDexSwapFee(0,'buy').totalDexFeePips).toBe(2500);
    for(const invalid of [-1,0.5,0xffffff+1,1001,1001<<12])expect(()=>tokenDexSwapFee(invalid,'buy')).toThrow();
  });
  it('binds native buy value, fee, minimum, recipient, deadline and immutable range', () => {
    const call = prepareTokenTradeCall(buy());
    expect(call.network.chainId).toBe(84532); expect(call.value).toBe(10n**18n); expect(call.to).toBe(anchor.market);
    expect(call.summary.quotedExecutionFeeRaw).toBe(15000000000000000n);
    expect(call.summary.minimumReceiveRaw).toBe(1222222211n);
    expect(decodeFunctionData({ abi:TOKEN_MARKET_ABI, data:call.data })).toEqual({functionName:'buy',args:[1222222211n,a(11),10120n,100n]});
    expect(call.summary.protocolFeeMayApply).toBe(true); expect(Object.isFrozen(call.summary)).toBe(true);
  });
  it('charges sell execution fees from gross native output and places the net minimum in calldata', () => {
    const call = prepareTokenTradeCall({ ...buy(), side:'sell', amount:'12.34567890',
      quote:{side:'sell',poolInputRaw:1234567890n,poolOutputRaw:101n,blockHash:anchor.blockHash} });
    expect(call.value).toBe(0n); expect(call.summary.quotedExecutionFeeRaw).toBe(1n);
    expect(call.summary.quotedReceiveRaw).toBe(100n); expect(call.summary.minimumReceiveRaw).toBe(99n);
    expect(decodeFunctionData({abi:TOKEN_MARKET_ABI,data:call.data})).toEqual({functionName:'sell',args:[1234567890n,99n,a(11),10120n,10000n]});
  });
  it('requires full quoted input and the exact canonical block and direction', () => {
    for (const quote of [ { ...buy().quote,poolInputRaw:984999999999999999n }, { ...buy().quote,blockHash:h(2) },
      { ...buy().quote,side:'sell' as const }, { ...buy().quote,poolOutputRaw:0n } ]) expect(()=>prepareTokenTradeCall({...buy(),quote})).toThrow();
  });
  it('rejects expired, future-dated and imprecise amounts before a wallet request', () => {
    for (const now of [9999n,10120n,10121n]) expect(()=>prepareTokenTradeCall({...buy(),now})).toThrow(/expired/i);
    expect(prepareTokenTradeCall({...buy(),now:10119n}).deadline).toBe(10120n);
    for (const amount of ['1e18','-1','0','1.0000000000000000001']) expect(()=>prepareTokenTradeCall({...buy(),amount})).toThrow();
    expect(()=>prepareTokenTradeCall({...buy(),side:'sell',amount:'0.000000001'})).toThrow();
    for (const slippageBps of [-1,0.1,1001,Infinity]) expect(()=>prepareTokenTradeCall({...buy(),slippageBps})).toThrow();
  });
  it('rejects redirected pool identity, unsupported chains, wrong genesis and invalid fee schedules', () => {
    for (const changed of [{chainId:8453},{genesisHash:h(3)},{poolManager:a(9)},{token:a(9)}, {executionFeeBps:155},
      {executionFeeBps:99},{executionFeeBps:501},{feeMode:'other'},{sqrtLowerX96:10000n},{poolId:h(7)}]) {
      expect(()=>tokenMarketReviewAnchor({...anchor,...changed} as TokenMarketReviewAnchor)).toThrow();
    }
    expect(tokenMarketReviewAnchor({...anchor,chainId:31337,genesisHash:h(123),poolManager:a(2)}).network.mode).toBe('local');
  });
  it('keeps exact approval separate, limited to the selected market and token amount', () => {
    const call=prepareTokenApprovalCall(anchor,a(10),'12.3456789');
    expect(call.to).toBe(anchor.token); expect(call.value).toBe(0n);
    expect(decodeFunctionData({abi:MARKET_TOKEN_ABI,data:call.data})).toEqual({functionName:'approve',args:[anchor.market,1234567890n]});
    expect(call.allowanceRaw).toBe(1234567890n);
  });
  it('rejects pool and protocol contracts as recipients and invalid price boundaries', () => {
    for (const recipient of [zeroAddress,anchor.market,anchor.token,anchor.poolManager,anchor.factory,anchor.oracle]) expect(()=>prepareTokenTradeCall({...buy(),recipient})).toThrow();
    for (const priceLimit of [0n,99n,10001n]) expect(()=>prepareTokenTradeCall({...buy(),priceLimit})).toThrow();
  });
});

describe('token launch test ETH terms', () => {
  const input = () => ({ chainId:84532,genesisHash:BASE_SEPOLIA_GENESIS_HASH,factory:a(1),from:a(10),
    draft:{pricingNetwork:'base-sepolia' as const,name:'Example',symbol:'EX',openingValuation:'1.25',executionFeeBps:150,feeMode:'liquidity_burn' as const},
    preview:{tickLower:-80000,tickUpper:-10000,sqrtLowerX96:100n,sqrtUpperX96:10000n,effectiveOpeningValuationNative:1251000000000000000n,effectiveUpperValuationNative:1251000000000000000000n},
  });
  it('encodes a zero-native-principal launch and displays the factory-aligned bounds', () => {
    const call=prepareTokenLaunchCall(input());
    expect(call.value).toBe(0n); expect(call.terms.initialSupplyRaw).toBe(100000000000000000n);
    expect(call.terms.tokenDecimals).toBe(8); expect(call.terms.effectiveOpeningValuationNative).toBe(input().preview.effectiveOpeningValuationNative);
    expect(decodeFunctionData({abi:TOKEN_MARKET_FACTORY_ABI,data:call.data})).toEqual({functionName:'createMarket',args:['Example','EX',150,true,1250000000000000000n]});
  });
  it('requires explicit Base pricing instead of retargeting a legacy Zero amount', () => {
    for (const pricingNetwork of [undefined,'zero'] as const) expect(()=>prepareTokenLaunchCall({...input(),draft:{...input().draft,pricingNetwork}})).toThrow();
  });
  it('limits UTF-8 bytes and frozen fee increments', () => {
    for (const changed of [{name:'🟢'.repeat(17)},{symbol:'🟢'.repeat(5)},{executionFeeBps:101},{openingValuation:'0'}, {name:'bad\nname'}])
      expect(()=>prepareTokenLaunchCall({...input(),draft:{...input().draft,...changed}})).toThrow();
  });
  it('copies only the reviewed preview fields, preserving its own economics and name', () => {
    const call=prepareTokenLaunchCall({...input(),preview:{...input().preview,name:'Injected',executionFeeBps:500} as ReturnType<typeof input>['preview']});
    expect(call.terms.name).toBe('Example'); expect(call.terms.executionFeeBps).toBe(150);
  });
});
