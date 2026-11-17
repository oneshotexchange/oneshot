import {encodeAbiParameters,encodeEventTopics,parseAbi,zeroAddress,type AbiEvent,type Address,type Hex} from 'viem';
import {tokenAddress as a,tokenHash as h,tokenFixture} from './token-fixture';
import type {Block,ProjectionValue,RawLog} from '../src/types';
import {projectTokenEvents,discoverTokenEventMarkets} from '../src/token-event-projector';
import type {TokenEventKind,TokenEventTransaction} from '../src/token-event-types';
import type {TokenManifest} from '../src/token-manifest';
const wire=parseAbi([
  'event MarketCreated(address indexed market,address indexed token,address indexed creator,bytes32 poolId)',
  'event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)',
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
  'event Trade(address indexed trader,address indexed recipient,bool buy,uint256 tokens,uint256 grossNative,uint256 netNative,uint256 executionFee)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
export function analyticsLog(block:Block,source:Address,name:string,args:Record<string,unknown>,index:number,transactionIndex=0):RawLog{
  const event=wire.find(item=>item.name===name)! as AbiEvent,plain=event.inputs.filter(item=>!item.indexed);
  return{address:source,data:encodeAbiParameters(plain,plain.map(item=>args[item.name!])),topics:encodeEventTopics({abi:[event],eventName:name,args}) as Hex[],
    blockNumber:block.number,blockHash:block.hash,transactionHash:h(Number(block.number)*100+transactionIndex),transactionIndex,logIndex:index};
}
export class MemoryTokenEventAdapter{
  state=new Map<string,ProjectionValue>();
  get(kind:TokenEventKind,id:string){return structuredClone(this.state.get(`${kind}:${id}`)??null);}
  async apply(manifest:TokenManifest,block:Block,logs:readonly RawLog[],registrations:readonly unknown[]=[]){
    const staged=structuredClone(this.state),tx:TokenEventTransaction={get:async(kind,id)=>structuredClone(staged.get(`${kind}:${id}`)??null),put:async(kind,id,value)=>{staged.set(`${kind}:${id}`,structuredClone(value));},countWalletHoldings:async(wallet)=>BigInt([...staged].filter(([key,value])=>key.startsWith('balances:')&&value.wallet===wallet&&BigInt(value.balanceRaw as string)>0n).length)};
    const result=await projectTokenEvents(tx,manifest,block,logs,registrations);this.state=staged;return result;
  }
}
export async function analyticsFixture(options:Parameters<typeof tokenFixture>[0]={}){
  const f=tokenFixture(options),registered=(await f.source.snapshot(f.manifest)).markets[0],store=new MemoryTokenEventAdapter();
  const block=(n:number,hash=h(n),parentHash=h(n-1)):Block=>({number:BigInt(n),hash,parentHash,timestamp:1700000000n+BigInt(n)});
  const first=block(1,h(1),f.manifest.anchorHash),supply=100000000000000000n;
  const creation=[analyticsLog(first,f.token,'Transfer',{from:zeroAddress,to:f.market,value:supply},0),
    analyticsLog(first,f.poolManager,'Initialize',{id:registered.poolId,currency0:zeroAddress,currency1:f.token,fee:2500,tickSpacing:10,hooks:f.oracle,sqrtPriceX96:1n<<96n,tick:0},1),
    analyticsLog(first,f.token,'Transfer',{from:f.market,to:f.poolManager,value:supply-3n},2),
    analyticsLog(first,f.factory,'MarketCreated',{market:f.market,token:f.token,creator:f.creator,poolId:registered.poolId},3)];
  const next=block(2),buyer=a(20),router=a(21),other=a(22);
  const swaps=[analyticsLog(next,f.poolManager,'Swap',{id:registered.poolId,sender:f.market,amount0:-990n,amount1:100n,sqrtPriceX96:(1n<<96n)-1n,liquidity:777n,tick:-1,fee:2500},0),
    analyticsLog(next,f.token,'Transfer',{from:f.poolManager,to:buyer,value:100n},1),
    analyticsLog(next,f.market,'Trade',{trader:buyer,recipient:buyer,buy:true,tokens:100n,grossNative:1000n,netNative:990n,executionFee:10n},2),
    analyticsLog(next,f.token,'Transfer',{from:buyer,to:f.poolManager,value:2n},3,1),
    analyticsLog(next,f.poolManager,'Swap',{id:registered.poolId,sender:router,amount0:20n,amount1:-2n,sqrtPriceX96:(1n<<96n)+1n,liquidity:777n,tick:1,fee:2500},4,1)];
  return{...f,registered,store,block,creation,first,next,swaps,buyer,router,other,supply};
}
export function parseEvidenceBlock(raw:Record<string,unknown>){
  const block:Block={number:BigInt(raw.number as string),hash:raw.hash as Hex,parentHash:raw.parentHash as Hex,timestamp:BigInt(raw.timestamp as string)};
  const logs=(raw.logs as Record<string,unknown>[]).map(log=>{
    if(log.removed!==false)throw new Error('Removed log in canonical evidence');return{...log,blockNumber:BigInt(log.blockNumber as string)} as unknown as RawLog;
  });return{block,logs};
}
export function evidenceRegistrations(manifest:TokenManifest,block:Block,logs:RawLog[],registrations:Record<string,unknown>[]){
  const markets=discoverTokenEventMarkets(manifest,block,logs);return markets.map(created=>{const proof=registrations.find(value=>value.market===created.market);if(!proof)throw new Error('Missing verified registration in evidence');return proof;});
}
