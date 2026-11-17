import type {IndexedTokenMarket} from '../../../packages/evm/src/indexed-tokens';
import {isAddress,isHash} from './manifest';
import {IndexerError,type Block} from './types';
export type TokenSnapshot={block:Block;markets:IndexedTokenMarket[]};
const fail=():never=>{throw new IndexerError('TOKEN_DATA_INVALID');};
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const addr=(x:unknown)=>isAddress(x)&&!/^0x0{40}$/i.test(x)?x.toLowerCase():fail();
const hash=(x:unknown)=>isHash(x)?x.toLowerCase():fail();
function amount(x:unknown,bits=256,positive=false){
  if(typeof x!=='string'||!/^(0|[1-9]\d{0,77})$/.test(x)||BigInt(x)>=2n**BigInt(bits)||positive&&BigInt(x)===0n)return fail();return x;
}
/** Whitelist storage records again at the public boundary; malformed data is never an empty market. */
export function tokenMarketDto(input:unknown):IndexedTokenMarket {
  if(!object(input)||input.schemaVersion!==1||typeof input.name!=='string'||!input.name||Buffer.byteLength(input.name)>64
    ||typeof input.symbol!=='string'||!input.symbol||Buffer.byteLength(input.symbol)>16||input.tokenDecimals!==8
    ||!Number.isSafeInteger(input.executionFeeBps)||Number(input.executionFeeBps)<100||Number(input.executionFeeBps)>500||Number(input.executionFeeBps)%10!==0
    ||typeof input.liquidityAndBurn!=='boolean'||input.lpFeePips!==2500||input.tickSpacing!==10
    ||!Number.isSafeInteger(input.tickLower)||!Number.isSafeInteger(input.tickUpper)||Number(input.tickLower)<-887272||Number(input.tickUpper)>887272
    ||Number(input.tickLower)>=Number(input.tickUpper)||Number(input.tickLower)%10!==0||Number(input.tickUpper)%10!==0)return fail();
  const initialSupplyRaw=amount(input.initialSupplyRaw),totalSupplyRaw=amount(input.totalSupplyRaw);
  if(initialSupplyRaw!=='100000000000000000'||BigInt(totalSupplyRaw)>BigInt(initialSupplyRaw))return fail();
  const openingValuationNativeRaw=amount(input.openingValuationNativeRaw,256,true),effectiveOpeningValuationNativeRaw=amount(input.effectiveOpeningValuationNativeRaw,256,true),effectiveUpperValuationNativeRaw=amount(input.effectiveUpperValuationNativeRaw,256,true);
  if(BigInt(effectiveUpperValuationNativeRaw)<=BigInt(effectiveOpeningValuationNativeRaw))return fail();
  const lockedRoundingDustRaw=amount(input.lockedRoundingDustRaw);
  if(BigInt(lockedRoundingDustRaw)>BigInt(initialSupplyRaw))return fail();
  const market=addr(input.market),token=addr(input.token);
  if(market===token)return fail();
  return{schemaVersion:1,market,token,creator:addr(input.creator),platformRecipient:addr(input.platformRecipient),name:input.name,symbol:input.symbol,tokenDecimals:8,
    initialSupplyRaw,totalSupplyRaw,executionFeeBps:Number(input.executionFeeBps),liquidityAndBurn:input.liquidityAndBurn,
    openingValuationNativeRaw,effectiveOpeningValuationNativeRaw,effectiveUpperValuationNativeRaw,poolId:hash(input.poolId),lpFeePips:2500,tickSpacing:10,
    tickLower:Number(input.tickLower),tickUpper:Number(input.tickUpper),lockedLiquidityRaw:amount(input.lockedLiquidityRaw,128,true),lockedRoundingDustRaw,
    observedMarketCodeHash:hash(input.observedMarketCodeHash),observedTokenCodeHash:hash(input.observedTokenCodeHash)};
}
export function validateTokenSnapshot(snapshot:TokenSnapshot):TokenSnapshot {
  const block=snapshot.block;
  if(typeof block?.number!=='bigint'||block.number<0n||block.number>=2n**256n||!isHash(block.hash)||!isHash(block.parentHash)
    ||typeof block.timestamp!=='bigint'||block.timestamp<0n||!Array.isArray(snapshot.markets)||snapshot.markets.length>25)return fail();
  const markets=snapshot.markets.map(tokenMarketDto);
  if(new Set(markets.map(x=>x.market)).size!==markets.length||new Set(markets.map(x=>x.token)).size!==markets.length||new Set(markets.map(x=>x.poolId)).size!==markets.length)return fail();
  return{block:{...block,hash:block.hash.toLowerCase() as typeof block.hash,parentHash:block.parentHash.toLowerCase() as typeof block.parentHash},markets};
}
