import {decodeFunctionResult,encodeFunctionData,encodeFunctionResult,encodeEventTopics,keccak256,type Address,type Hex} from 'viem';
import {TOKEN_MARKET_FACTORY_ABI,type RpcReadMethod,type RpcVerification} from '@oneshot/evm';
import {isAddress,isData,isHash} from './manifest';
import {IndexerError,type Block,type RawLog} from './types';
import type {TokenManifest} from './token-manifest';
import {VerifiedTokenSource} from './token-source';
import {discoverTokenEventMarkets,normalizeTokenRegistration,TOKEN_POOL_EVENTS,validateTokenEventLogs} from './token-event-projector';
import type {VerifiedTokenRegistration} from './token-event-types';

export const TOKEN_EVENT_LIMITS={maximumMarkets:1024,maximumNewMarkets:4,maximumLogs:10000,maximumReads:768,timeoutMs:45000} as const;
type Rpc={verification:RpcVerification;readRpc(method:RpcReadMethod,params?:readonly unknown[]):Promise<unknown>};
const fail=(code='TOKEN_EVENT_RPC_INVALID'):never=>{throw new IndexerError(code);};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const quantity=(value:unknown):bigint=>typeof value==='string'&&/^0x(?:0|[1-9a-f][\da-f]{0,63})$/i.test(value)?BigInt(value):fail();
const same=(a:Block,b:Block)=>a.number===b.number&&a.hash===b.hash&&a.parentHash===b.parentHash&&a.timestamp===b.timestamp;
const factoryTopic=encodeEventTopics({abi:TOKEN_MARKET_FACTORY_ABI,eventName:'MarketCreated'})[0]!;
const poolTopics=TOKEN_POOL_EVENTS.map(event=>encodeEventTopics({abi:[event],eventName:event.name})[0]!);

/** Read-only, hash-selected per-block capture. The caller commits only a complete returned block. */
export class VerifiedTokenEventSource{
  private readonly contracts:VerifiedTokenSource;
  constructor(private readonly rpc:Rpc){this.contracts=new VerifiedTokenSource(rpc);}
  height(){return this.contracts.height();}
  block(number:bigint){return this.contracts.block(number);}
  verify(manifest:TokenManifest,at?:Block){return this.contracts.verify(manifest,at);}
  async capture(manifest:TokenManifest,block:Block,known:readonly VerifiedTokenRegistration[],verifiedTarget:Block){
    // The quoter can be deployed after the factory. Core proof belongs to a fixed,
    // canonical target; every creation is additionally proved at its own exact hash.
    if(!Array.isArray(known)||known.length>TOKEN_EVENT_LIMITS.maximumMarkets||block.number>verifiedTarget.number)return fail('TOKEN_EVENT_SOURCE_LIMIT');
    const registrations=known.map(normalizeTokenRegistration),selected=new Map(registrations.map(value=>[value.market,value]));
    if(selected.size!==known.length||new Set(registrations.map(value=>value.token)).size!==known.length||new Set(registrations.map(value=>value.poolId)).size!==known.length)return fail('TOKEN_EVENT_REGISTRATION_INVALID');
    let active=true,reads=0,bytes=0;const deadline=Date.now()+TOKEN_EVENT_LIMITS.timeoutMs;
    const readRpc=async(method:RpcReadMethod,params:readonly unknown[]=[])=>{
      if(!active||Date.now()>=deadline||++reads>TOKEN_EVENT_LIMITS.maximumReads)return fail('TOKEN_EVENT_SOURCE_LIMIT');
      return this.rpc.readRpc(method,params);
    };
    const contracts=new VerifiedTokenSource({verification:this.rpc.verification,readRpc});
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{active=false;reject(new IndexerError('TOKEN_EVENT_SOURCE_LIMIT'));},TOKEN_EVENT_LIMITS.timeoutMs);});
    const run=async()=>{
      if(block.number<manifest.startBlock||!same(await contracts.block(block.number),block))return fail('TOKEN_CHAIN_MOVED');
      await contracts.verify(manifest,verifiedTarget);
      for(const contract of [manifest.factory,manifest.poolManager,manifest.oracle]){
        const code=await readRpc('eth_getCode',[contract.address,{blockHash:block.hash,requireCanonical:true}]);
        if(!isData(code)||code==='0x'||code.length>131074||keccak256(code)!==contract.codeHash)return fail('TOKEN_CONTRACT_CODE_MISMATCH');
      }
      const fetchLogs=async(addresses:readonly Address[],topics?:readonly unknown[])=>{
        const result=await readRpc('eth_getLogs',[{address:addresses,blockHash:block.hash,...(topics?{topics}:{})}]);
        if(!Array.isArray(result)||result.length>TOKEN_EVENT_LIMITS.maximumLogs)return fail('TOKEN_EVENT_SOURCE_LIMIT');
        return result.map((value):RawLog=>{
          if(!object(value)||!isAddress(value.address)||!addresses.includes(value.address.toLowerCase() as Address)||value.removed!==false
            ||!isData(value.data)||value.data.length>131074||!isHash(value.blockHash)||value.blockHash.toLowerCase()!==block.hash||quantity(value.blockNumber)!==block.number
            ||!isHash(value.transactionHash)||!Array.isArray(value.topics)||value.topics.length<1||value.topics.length>4||!value.topics.every(isHash))return fail();
          const logTopics=value.topics.map(topic=>topic.toLowerCase() as Hex);
          if(topics?.some((expected,index)=>expected!==null&&!(Array.isArray(expected)?expected:[expected]).some(topic=>typeof topic==='string'&&topic.toLowerCase()===logTopics[index])))return fail();
          const transactionIndex=quantity(value.transactionIndex),logIndex=quantity(value.logIndex);
          if(transactionIndex>BigInt(Number.MAX_SAFE_INTEGER)||logIndex>2147483647n)return fail();
          bytes+=value.data.length+logTopics.length*66;if(bytes>16*1024*1024)return fail('TOKEN_EVENT_SOURCE_LIMIT');
          return{address:value.address.toLowerCase() as Address,data:value.data.toLowerCase() as Hex,topics:logTopics,blockNumber:block.number,blockHash:block.hash,transactionHash:value.transactionHash.toLowerCase() as Hex,transactionIndex:Number(transactionIndex),logIndex:Number(logIndex)};
        });
      };
      const factoryLogs=await fetchLogs([manifest.factory.address],[factoryTopic]),discovered=discoverTokenEventMarkets(manifest,block,factoryLogs);
      if(discovered.length>TOKEN_EVENT_LIMITS.maximumNewMarkets||known.length+discovered.length>TOKEN_EVENT_LIMITS.maximumMarkets)return fail('TOKEN_EVENT_SOURCE_LIMIT');
      const newRegistrations:VerifiedTokenRegistration[]=[];
      for(const found of discovered){
        if(selected.has(found.market))return fail('TOKEN_EVENT_REGISTRATION_INVALID');
        const proof=normalizeTokenRegistration(await contracts.verifyHistoricalMarket(manifest,found.market,block,verifiedTarget));
        if(proof.token!==found.token||proof.creator!==found.creator||proof.poolId!==found.poolId)return fail('TOKEN_EVENT_REGISTRATION_INVALID');
        selected.set(proof.market,proof);newRegistrations.push(proof);
      }
      const all=[...selected.values()];
      if(new Set(all.flatMap(value=>[value.market,value.token])).size!==all.length*2||new Set(all.map(value=>value.poolId)).size!==all.length)return fail('TOKEN_EVENT_REGISTRATION_INVALID');
      const countData=await readRpc('eth_call',[{to:manifest.factory.address,data:encodeFunctionData({abi:TOKEN_MARKET_FACTORY_ABI,functionName:'marketCount'})},{blockHash:block.hash,requireCanonical:true}]);
      if(!isData(countData))return fail();
      let count:bigint;try{count=decodeFunctionResult({abi:TOKEN_MARKET_FACTORY_ABI,functionName:'marketCount',data:countData});if(encodeFunctionResult({abi:TOKEN_MARKET_FACTORY_ABI,functionName:'marketCount',result:count}).toLowerCase()!==countData.toLowerCase())return fail();}catch{return fail();}
      if(count!==BigInt(all.length))return fail('TOKEN_EVENT_REGISTRY_INCOMPLETE');
      const addresses=all.flatMap(value=>[value.market,value.token]),logs=[...factoryLogs];
      for(let offset=0;offset<addresses.length;offset+=8){logs.push(...await fetchLogs(addresses.slice(offset,offset+8)));if(logs.length>TOKEN_EVENT_LIMITS.maximumLogs)return fail('TOKEN_EVENT_SOURCE_LIMIT');}
      // Pool topics avoid unrelated global PoolManager traffic and include both
      // constructor initialization and swaps made through external routers.
      for(let offset=0;offset<all.length;offset+=8){logs.push(...await fetchLogs([manifest.poolManager.address],[poolTopics,all.slice(offset,offset+8).map(value=>value.poolId)]));if(logs.length>TOKEN_EVENT_LIMITS.maximumLogs)return fail('TOKEN_EVENT_SOURCE_LIMIT');}
      const ordered=validateTokenEventLogs(block,logs);
      if(!same(await contracts.block(block.number),block)||!same(await contracts.block(verifiedTarget.number),verifiedTarget))return fail('TOKEN_CHAIN_MOVED');
      return{block,logs:ordered,registrations:newRegistrations,reads};
    };
    try{return await Promise.race([run(),timeout]);}finally{active=false;if(timer)clearTimeout(timer);}
  }
}
