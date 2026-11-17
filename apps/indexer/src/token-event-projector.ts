import {decodeEventLog,encodeAbiParameters,encodeEventTopics,keccak256,parseAbi,zeroAddress,type AbiEvent,type Address,type Hex} from 'viem';
import {TOKEN_MARKET_FACTORY_ABI,TOKEN_MARKET_ABI,MARKET_TOKEN_ABI} from '@oneshot/evm';
import {isAddress,isData,isHash} from './manifest';
import {IndexerError,type Block,type RawLog,type ProjectionValue} from './types';
import type {TokenManifest} from './token-manifest';
import type {TokenEventTransaction,TokenMarketAnalytics,VerifiedTokenRegistration} from './token-event-types';

export const TOKEN_POOL_EVENTS=parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
]);
const factoryEvents=TOKEN_MARKET_FACTORY_ABI.filter((item):item is Extract<typeof item,{type:'event'}>=>item.type==='event');
const marketEvents=TOKEN_MARKET_ABI.filter((item):item is Extract<typeof item,{type:'event'}>=>item.type==='event'&&item.name==='Trade');
const transferEvents=MARKET_TOKEN_ABI.filter((item):item is Extract<typeof item,{type:'event'}>=>item.type==='event'&&item.name==='Transfer');
const fail=(code='TOKEN_EVENT_INVALID'):never=>{throw new IndexerError(code);};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const address=(value:unknown,nonzero=true):Address=>isAddress(value)&&(!nonzero||value.toLowerCase()!==zeroAddress)?value.toLowerCase() as Address:fail();
const hash=(value:unknown):Hex=>isHash(value)?value.toLowerCase() as Hex:fail();
const uint=(value:unknown,bits=256):bigint=>typeof value==='bigint'&&value>=0n&&value<2n**BigInt(bits)?value:fail();
const signed=(value:unknown,bits:number):bigint=>typeof value==='bigint'&&value>=-(2n**BigInt(bits-1))&&value<2n**BigInt(bits-1)?value:fail();
const decimal=(value:unknown):bigint=>typeof value==='string'&&/^(0|[1-9]\d{0,255})$/.test(value)?BigInt(value):fail('TOKEN_EVENT_PROJECTION_INVALID');
const sum=(value:unknown,added:bigint)=>{const result=decimal(value)+added;if(result<0n||result.toString().length>256)return fail('TOKEN_EVENT_PROJECTION_INVALID');return result.toString();};
const eventId=(log:RawLog)=>`${log.transactionHash.toLowerCase()}:${log.logIndex}`;
const balanceId=(token:string,wallet:string)=>`${token}:${wallet}`;
const events=(abi:readonly AbiEvent[],log:RawLog)=>{
  const selected=abi.find(item=>encodeEventTopics({abi:[item],eventName:item.name})[0]?.toLowerCase()===log.topics[0]?.toLowerCase());
  if(!selected)return null;
  try{
    const decoded=decodeEventLog({abi:[selected],data:log.data,topics:[...log.topics] as [Hex,...Hex[]],strict:true}),args=decoded.args as Record<string,unknown>;
    const topics=encodeEventTopics({abi:[selected],eventName:selected.name,args});
    const plain=selected.inputs.filter(input=>!input.indexed),data=encodeAbiParameters(plain,plain.map(input=>args[input.name!]));
    if(data.toLowerCase()!==log.data.toLowerCase()||topics.length!==log.topics.length||topics.some((topic,index)=>typeof topic!=='string'||topic.toLowerCase()!==log.topics[index].toLowerCase()))return fail();
    return{name:selected.name,args};
  }catch{return fail();}
};
export function normalizeTokenRegistration(input:unknown):VerifiedTokenRegistration{
  if(!object(input)||input.tokenDecimals!==8||input.initialSupplyRaw!=='100000000000000000'||!Number.isSafeInteger(input.executionFeeBps)
    ||Number(input.executionFeeBps)<100||Number(input.executionFeeBps)>500||Number(input.executionFeeBps)%10!==0||typeof input.liquidityAndBurn!=='boolean')return fail('TOKEN_EVENT_REGISTRATION_INVALID');
  return{market:address(input.market),token:address(input.token),creator:address(input.creator),poolId:hash(input.poolId),executionFeeBps:Number(input.executionFeeBps),liquidityAndBurn:input.liquidityAndBurn,
    tokenDecimals:8,initialSupplyRaw:'100000000000000000',observedMarketCodeHash:hash(input.observedMarketCodeHash),observedTokenCodeHash:hash(input.observedTokenCodeHash)};
}
/** Bound provenance before any projection writes. Zero-transfer and repeated-second blocks remain valid. */
export function validateTokenEventLogs(block:Block,logs:readonly RawLog[]):RawLog[]{
  if(typeof block.number!=='bigint'||block.number<0n||block.number>=2n**256n||!isHash(block.hash)||!isHash(block.parentHash)||typeof block.timestamp!=='bigint'||block.timestamp<0n||block.timestamp>=2n**256n
    ||!Array.isArray(logs)||logs.length>10000)return fail('TOKEN_EVENT_SOURCE_LIMIT');
  const ordered=[...logs].sort((a,b)=>a.logIndex-b.logIndex),positions=new Set<number>(),transactions=new Map<string,number>();let bytes=0,previous:RawLog|undefined;
  for(const log of ordered){
    if(!isAddress(log.address)||!isData(log.data)||log.data.length>131074||!Array.isArray(log.topics)||log.topics.length<1||log.topics.length>4||!log.topics.every(isHash)
      ||log.blockNumber!==block.number||!isHash(log.blockHash)||log.blockHash.toLowerCase()!==block.hash.toLowerCase()||!isHash(log.transactionHash)
      ||!Number.isSafeInteger(log.transactionIndex)||log.transactionIndex<0||!Number.isSafeInteger(log.logIndex)||log.logIndex<0||log.logIndex>2147483647||positions.has(log.logIndex))return fail();
    bytes+=log.data.length+log.topics.length*66;if(bytes>16*1024*1024)return fail('TOKEN_EVENT_SOURCE_LIMIT');positions.add(log.logIndex);
    const tx=log.transactionHash.toLowerCase();if(transactions.has(tx)&&transactions.get(tx)!==log.transactionIndex)return fail();transactions.set(tx,log.transactionIndex);
    if(previous&&(log.transactionIndex<previous.transactionIndex||log.transactionIndex===previous.transactionIndex&&tx!==previous.transactionHash.toLowerCase()))return fail();
    previous=log;
  }
  return ordered;
}
/** Discover first, then obtain hash-selected runtime proofs before committing this block. */
export function discoverTokenEventMarkets(manifest:TokenManifest,block:Block,input:readonly RawLog[]){
  return validateTokenEventLogs(block,input).flatMap(log=>{
    if(log.address.toLowerCase()!==manifest.factory.address)return[];const decoded=events(factoryEvents,log);if(decoded?.name!=='MarketCreated')return[];
    return[{market:address(decoded.args.market),token:address(decoded.args.token),creator:address(decoded.args.creator),poolId:hash(decoded.args.poolId)}];
  });
}
export function tokenMarketAnalytics(value:ProjectionValue|null,manifest:TokenManifest,id:string):TokenMarketAnalytics{
  if(!value||value.schemaVersion!==1||value.market!==id||value.chainId!==manifest.chainId||typeof value.initialized!=='boolean'||typeof value.initialMintSeen!=='boolean')return fail('TOKEN_EVENT_PROJECTION_INVALID');
  normalizeTokenRegistration(value);
  const fields=['observedSupplyRaw','mintedRaw','burnedRaw','holderCount','oneshotTrades','oneshotBuys','oneshotSells','oneshotGrossNativeVolumeRaw','oneshotExecutionFeesRaw','poolSwaps','poolNativeVolumeRaw','poolTokenVolumeRaw','createdBlockNumber','lastBlockNumber'];
  for(const field of fields)decimal(value[field]);
  const supply=decimal(value.observedSupplyRaw),minted=decimal(value.mintedRaw),burned=decimal(value.burnedRaw);
  if(minted!==(value.initialMintSeen?100000000000000000n:0n)||burned>minted||supply!==minted-burned||decimal(value.holderCount)>supply
    ||decimal(value.oneshotTrades)!==decimal(value.oneshotBuys)+decimal(value.oneshotSells)||decimal(value.oneshotExecutionFeesRaw)>decimal(value.oneshotGrossNativeVolumeRaw)
    ||decimal(value.lastBlockNumber)<decimal(value.createdBlockNumber)||!isHash(value.createdBlockHash)||!isHash(value.createdTransactionHash)||!isHash(value.lastBlockHash)
    ||!Number.isSafeInteger(value.createdLogIndex)||Number(value.createdLogIndex)<0||Number(value.createdLogIndex)>2147483647)return fail('TOKEN_EVENT_PROJECTION_INVALID');
  if(value.initialized){if(typeof value.sqrtPriceX96Raw!=='string'||decimal(value.sqrtPriceX96Raw)===0n||decimal(value.sqrtPriceX96Raw)>=2n**160n
    ||!Number.isInteger(value.tick)||Number(value.tick)<-887272||Number(value.tick)>887272||!isHash(value.priceBlockHash)||decimal(value.priceBlockNumber)>decimal(value.lastBlockNumber))return fail('TOKEN_EVENT_PROJECTION_INVALID');}
  else if(value.sqrtPriceX96Raw!==null||value.tick!==null||value.priceBlockNumber!==null||value.priceBlockHash!==null)return fail('TOKEN_EVENT_PROJECTION_INVALID');
  if(decimal(value.poolSwaps)>0n){if(decimal(value.lastSwapLiquidityRaw)>=2n**128n||!Number.isInteger(value.lastSwapFeePips)||Number(value.lastSwapFeePips)<0||Number(value.lastSwapFeePips)>1000000)return fail('TOKEN_EVENT_PROJECTION_INVALID');}
  else if(value.lastSwapLiquidityRaw!==null||value.lastSwapFeePips!==null)return fail('TOKEN_EVENT_PROJECTION_INVALID');
  return value as TokenMarketAnalytics;
}
async function market(tx:TokenEventTransaction,manifest:TokenManifest,id:string):Promise<TokenMarketAnalytics>{
  return tokenMarketAnalytics(await tx.get('markets',id),manifest,id);
}
async function record(tx:TokenEventTransaction,manifest:TokenManifest,block:Block,log:RawLog,kind:string,fields:ProjectionValue){
  const id=eventId(log);if(await tx.get('events',id))return fail('TOKEN_EVENT_DUPLICATE');
  await tx.put('events',id,{schemaVersion:1,chainId:manifest.chainId,kind,source:log.address.toLowerCase(),blockNumber:block.number.toString(),blockHash:block.hash,
    timestamp:block.timestamp.toString(),transactionHash:log.transactionHash.toLowerCase(),transactionIndex:log.transactionIndex,logIndex:log.logIndex,...fields});
}
async function transferBalance(tx:TokenEventTransaction,token:Address,wallet:Address,delta:bigint,block:Block,analytics:TokenMarketAnalytics){
  const id=balanceId(token,wallet),before=await tx.get('balances',id),old=before?decimal(before.balanceRaw):0n,next=old+delta;
  if(before&&(before.schemaVersion!==1||before.token!==token||before.wallet!==wallet||!isHash(before.lastBlockHash)||decimal(before.lastBlockNumber)>block.number))return fail('TOKEN_EVENT_PROJECTION_INVALID');
  if(next<0n||next>BigInt(analytics.initialSupplyRaw))return fail('TOKEN_EVENT_BALANCE_UNDERFLOW');
  const summary=await tx.get('wallets',wallet),count=summary?decimal(summary.holdingsCount):await tx.countWalletHoldings(wallet);
  if(summary&&(summary.schemaVersion!==1||summary.wallet!==wallet||!isHash(summary.lastBlockHash)||decimal(summary.lastBlockNumber)>block.number))return fail('TOKEN_EVENT_PROJECTION_INVALID');
  const nextCount=count+(old===0n&&next>0n?1n:old>0n&&next===0n?-1n:0n);if(nextCount<0n)return fail('TOKEN_EVENT_PROJECTION_INVALID');
  await tx.put('wallets',wallet,{schemaVersion:1,wallet,holdingsCount:nextCount.toString(),lastBlockNumber:block.number.toString(),lastBlockHash:block.hash});
  if(old===0n&&next>0n)analytics.holderCount=sum(analytics.holderCount,1n);if(old>0n&&next===0n)analytics.holderCount=sum(analytics.holderCount,-1n);
  await tx.put('balances',id,{schemaVersion:1,token,wallet,balanceRaw:next.toString(),lastBlockNumber:block.number.toString(),lastBlockHash:block.hash});
}

/** Caller must provide a transactional adapter; every error rolls the entire block back. */
export async function projectTokenEvents(tx:TokenEventTransaction,manifest:TokenManifest,block:Block,input:readonly RawLog[],registrationInputs:readonly unknown[]){
  const logs=validateTokenEventLogs(block,input);
  if(!Array.isArray(registrationInputs)||registrationInputs.length>1000)return fail('TOKEN_EVENT_SOURCE_LIMIT');
  const registrations=registrationInputs.map(normalizeTokenRegistration),byMarket=new Map(registrations.map(value=>[value.market,value]));
  if(byMarket.size!==registrations.length)return fail('TOKEN_EVENT_REGISTRATION_INVALID');
  const created=new Set<Address>();
  // Constructor mint and pool initialization precede MarketCreated in the same transaction.
  for(const log of logs){
    if(log.address.toLowerCase()!==manifest.factory.address)continue;const decoded=events(factoryEvents,log);if(!decoded||decoded.name!=='MarketCreated')continue;
    const id=address(decoded.args.market),token=address(decoded.args.token),creator=address(decoded.args.creator),poolId=hash(decoded.args.poolId),registration=byMarket.get(id);
    if(!registration||registration.token!==token||registration.creator!==creator||registration.poolId!==poolId||created.has(id)||await tx.get('markets',id)||await tx.get('tokens',token)||await tx.get('pools',poolId))return fail('TOKEN_EVENT_REGISTRATION_INVALID');
    const analytics:TokenMarketAnalytics={...registration,schemaVersion:1,chainId:manifest.chainId,initialized:false,initialMintSeen:false,observedSupplyRaw:'0',mintedRaw:'0',burnedRaw:'0',holderCount:'0',
      oneshotTrades:'0',oneshotBuys:'0',oneshotSells:'0',oneshotGrossNativeVolumeRaw:'0',oneshotExecutionFeesRaw:'0',poolSwaps:'0',poolNativeVolumeRaw:'0',poolTokenVolumeRaw:'0',
      sqrtPriceX96Raw:null,tick:null,lastSwapLiquidityRaw:null,lastSwapFeePips:null,priceBlockNumber:null,priceBlockHash:null,
      createdBlockNumber:block.number.toString(),createdBlockHash:block.hash,createdTransactionHash:log.transactionHash.toLowerCase() as Hex,createdLogIndex:log.logIndex,
      lastBlockNumber:block.number.toString(),lastBlockHash:block.hash};
    await tx.put('markets',id,analytics);await tx.put('tokens',token,{market:id});await tx.put('pools',poolId,{market:id});created.add(id);
  }
  if(created.size!==registrations.length)return fail('TOKEN_EVENT_REGISTRATION_INVALID');
  for(const log of logs){
    const source=log.address.toLowerCase() as Address;
    if(source===manifest.factory.address){const decoded=events(factoryEvents,log);if(decoded?.name==='MarketCreated')await record(tx,manifest,block,log,'market-created',{market:address(decoded.args.market),token:address(decoded.args.token),creator:address(decoded.args.creator),poolId:hash(decoded.args.poolId)});continue;}
    if(source===manifest.poolManager.address){
      const decoded=events(TOKEN_POOL_EVENTS,log);if(!decoded)continue;const poolId=hash(decoded.args.id),link=await tx.get('pools',poolId);if(!link)continue;
      const analytics=await market(tx,manifest,String(link.market)),sqrt=uint(decoded.args.sqrtPriceX96,160),tick=decoded.args.tick;
      if(analytics.poolId!==poolId)return fail('TOKEN_EVENT_PROJECTION_INVALID');
      if(sqrt===0n||!Number.isInteger(tick)||Number(tick)<-887272||Number(tick)>887272)return fail();
      if(decoded.name==='Initialize'){
        const expectedPool=keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}],[zeroAddress,analytics.token,2500,10,manifest.oracle.address]));
        if(analytics.initialized||poolId!==expectedPool||address(decoded.args.currency0,false)!==zeroAddress||address(decoded.args.currency1)!==analytics.token||decoded.args.fee!==2500||decoded.args.tickSpacing!==10||address(decoded.args.hooks)!==manifest.oracle.address)return fail();
        analytics.initialized=true;await record(tx,manifest,block,log,'pool-initialized',{market:analytics.market,poolId,sqrtPriceX96Raw:sqrt.toString(),tick:Number(tick)});
      }else{
        if(!analytics.initialized)return fail();const amount0=signed(decoded.args.amount0,128),amount1=signed(decoded.args.amount1,128),liquidity=uint(decoded.args.liquidity,128),fee=decoded.args.fee;
        if(!Number.isInteger(fee)||Number(fee)<0||Number(fee)>1000000)return fail();
        analytics.poolSwaps=sum(analytics.poolSwaps,1n);analytics.poolNativeVolumeRaw=sum(analytics.poolNativeVolumeRaw,amount0<0n?-amount0:amount0);analytics.poolTokenVolumeRaw=sum(analytics.poolTokenVolumeRaw,amount1<0n?-amount1:amount1);
        analytics.lastSwapLiquidityRaw=liquidity.toString();analytics.lastSwapFeePips=Number(fee);
        await record(tx,manifest,block,log,'pool-swap',{market:analytics.market,poolId,poolSender:address(decoded.args.sender),trader:null,recipient:null,
          amount0Raw:amount0.toString(),amount1Raw:amount1.toString(),sqrtPriceX96Raw:sqrt.toString(),liquidityRaw:liquidity.toString(),tick:Number(tick),feePips:Number(fee)});
      }
      analytics.sqrtPriceX96Raw=sqrt.toString();analytics.tick=Number(tick);analytics.priceBlockNumber=block.number.toString();analytics.priceBlockHash=block.hash;analytics.lastBlockNumber=block.number.toString();analytics.lastBlockHash=block.hash;
      await tx.put('markets',analytics.market,analytics);continue;
    }
    const tokenLink=await tx.get('tokens',source);
    if(tokenLink){
      const decoded=events(transferEvents,log);if(!decoded)continue;const analytics=await market(tx,manifest,String(tokenLink.market)),from=address(decoded.args.from,false),to=address(decoded.args.to,false),value=uint(decoded.args.value);
      if(analytics.token!==source)return fail('TOKEN_EVENT_PROJECTION_INVALID');
      if(from===zeroAddress&&to===zeroAddress)return fail();
      if(from===zeroAddress){if(analytics.initialMintSeen||!created.has(analytics.market)||to!==analytics.market||value!==BigInt(analytics.initialSupplyRaw))return fail('TOKEN_EVENT_MINT_INVALID');analytics.initialMintSeen=true;analytics.observedSupplyRaw=sum(analytics.observedSupplyRaw,value);analytics.mintedRaw=sum(analytics.mintedRaw,value);await transferBalance(tx,source,to,value,block,analytics);}
      else if(to===zeroAddress){await transferBalance(tx,source,from,-value,block,analytics);analytics.observedSupplyRaw=sum(analytics.observedSupplyRaw,-value);analytics.burnedRaw=sum(analytics.burnedRaw,value);}
      else if(from===to){const balance=await tx.get('balances',balanceId(source,from));if((balance?decimal(balance.balanceRaw):0n)<value)return fail('TOKEN_EVENT_BALANCE_UNDERFLOW');await transferBalance(tx,source,from,0n,block,analytics);}
      else{await transferBalance(tx,source,from,-value,block,analytics);await transferBalance(tx,source,to,value,block,analytics);}
      analytics.lastBlockNumber=block.number.toString();analytics.lastBlockHash=block.hash;await tx.put('markets',analytics.market,analytics);
      await record(tx,manifest,block,log,'token-transfer',{market:analytics.market,token:source,from,to,amountRaw:value.toString(),mint:from===zeroAddress,burn:to===zeroAddress});continue;
    }
    const known=await tx.get('markets',source);if(!known)continue;const decoded=events(marketEvents,log);if(!decoded)continue;
    const analytics=await market(tx,manifest,source),gross=uint(decoded.args.grossNative),net=uint(decoded.args.netNative),fee=uint(decoded.args.executionFee),tokens=uint(decoded.args.tokens),buy=decoded.args.buy;
    if(typeof buy!=='boolean'||gross===0n||net===0n||tokens===0n||net+fee!==gross||fee!==gross*BigInt(analytics.executionFeeBps)/10000n)return fail('TOKEN_EVENT_TRADE_INVALID');
    analytics.oneshotTrades=sum(analytics.oneshotTrades,1n);analytics.oneshotBuys=sum(analytics.oneshotBuys,buy?1n:0n);analytics.oneshotSells=sum(analytics.oneshotSells,buy?0n:1n);
    analytics.oneshotGrossNativeVolumeRaw=sum(analytics.oneshotGrossNativeVolumeRaw,gross);analytics.oneshotExecutionFeesRaw=sum(analytics.oneshotExecutionFeesRaw,fee);analytics.lastBlockNumber=block.number.toString();analytics.lastBlockHash=block.hash;await tx.put('markets',source,analytics);
    await record(tx,manifest,block,log,'oneshot-trade',{market:source,token:analytics.token,trader:address(decoded.args.trader),recipient:address(decoded.args.recipient),buy,tokensRaw:tokens.toString(),grossNativeRaw:gross.toString(),netNativeRaw:net.toString(),executionFeeRaw:fee.toString()});
  }
  for(const id of created){const analytics=await market(tx,manifest,id);if(!analytics.initialMintSeen||!analytics.initialized||decimal(analytics.mintedRaw)!==BigInt(analytics.initialSupplyRaw))return fail('TOKEN_EVENT_CREATION_INCOMPLETE');}
  return{logs:logs.length,created:created.size};
}
