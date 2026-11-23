import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, encodeFunctionResult, type Abi, type Address, type Hex } from 'viem';
import { createVerifiedRpc, networkConfig, nftExecutionNetwork, prepareTokenApprovalCall, prepareTokenLaunchCall, prepareTokenMaintenanceCall, prepareTokenTradeCall,
  parseAssetAmount, splitExecutionFee, tokenDexSwapFee, TOKEN_MAINTENANCE_LIFETIME_SECONDS, TOKEN_REVIEW_LIFETIME_SECONDS, TOKEN_MARKET_FACTORY_ABI, TOKEN_MARKET_ABI, TOKEN_MARKET_QUOTER_ABI, MARKET_TOKEN_ABI,
  type NetworkConfig, type TokenMarketReviewAnchor, type NftExecutionNetwork } from '@oneshot/evm';
import { parseTokenManifest, tokenManifestId, type TokenManifest } from '../../../indexer/src/token-manifest';
import { VerifiedTokenSource } from '../../../indexer/src/token-source';
import type { Block } from '../../../indexer/src/types';
import { assertLinkedEvmAddress, type OneshotSession } from './oneshot-auth';
import { ApiError } from './errors';
import { stableJson } from './media';
import { tokenExecutionRepository, type TokenExecutionReview } from './token-execution-store';

const address=z.string().regex(/^0x[\da-fA-F]{40}$/).transform(value=>value.toLowerCase() as Address).refine(value=>!/^0x0{40}$/.test(value));
const amount=z.string().max(100).regex(/^(0|[1-9]\d*)(?:\.\d+)?$/);
const common={from:address,testEthAcknowledged:z.literal(true),expectedChainId:z.union([z.literal(31337),z.literal(84532)]),expectedDeploymentId:z.string().regex(/^[\da-f]{64}$/)};
const marketFields={market:address,recipient:address.optional()};
export const tokenExecutionInput=z.discriminatedUnion('action',[
  z.object({...common,action:z.literal('launch'),draft:z.object({pricingNetwork:z.enum(['zero','base-sepolia']),name:z.string().max(100),symbol:z.string().max(32),openingValuation:amount,executionFeeBps:z.number().int(),feeMode:z.enum(['creator','liquidity_burn'])}).strict()}).strict(),
  z.object({...common,...marketFields,action:z.enum(['buy','sell']),amount,slippageBps:z.number().int().min(0).max(1000)}).strict(),
  z.object({...common,market:address,action:z.literal('approve'),amount}).strict(),
  z.object({...common,...marketFields,action:z.literal('claim')}).strict(),
  z.object({...common,market:address,action:z.literal('maintain'),maximumNativeBudget:amount,maximumTokenBudget:amount}).strict(),
]);
export type TokenExecutionInput=z.infer<typeof tokenExecutionInput>;
type Rpc=Awaited<ReturnType<typeof createVerifiedRpc>>;
export type TokenExecutionChain={manifest:TokenManifest;deploymentId:string;rpc:Rpc;source:VerifiedTokenSource;block:Block;network:NftExecutionNetwork};
type Dependencies={environment?:()=>Record<string,string|undefined>;now?:()=>number;rpc?:(config:NetworkConfig)=>Promise<Rpc>;
  loadManifest?:(path:string)=>Promise<TokenManifest>;connect?:()=>Promise<TokenExecutionChain>;repository?:typeof tokenExecutionRepository};
const unavailable=():never=>{throw new ApiError(503,'TOKEN_EXECUTION_UNAVAILABLE','Token transactions are currently unavailable. You can save a draft or explore tokens and return later.');};
const changed=():never=>{throw new ApiError(409,'TOKEN_REVIEW_CHANGED','The network or market changed. Get a new transaction review.');};
const predatesReview=():never=>{throw new ApiError(409,'TOKEN_TRANSACTION_PREDATES_REVIEW','Choose the transaction sent after this review. An earlier transaction cannot complete a new review.');};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const hash=(value:unknown):Hex=>{if(typeof value!=='string'||!/^0x[\da-f]{64}$/i.test(value))return unavailable();return value.toLowerCase() as Hex;};
const raw=(value:unknown):bigint=>{if(typeof value!=='bigint'||value<0n||value>=2n**256n)return unavailable();return value;};
const quantity=(value:unknown):bigint=>{if(typeof value!=='string'||!/^0x(?:0|[1-9a-f][\da-f]{0,63})$/i.test(value))return unavailable();return BigInt(value);};
const hex=(value:bigint)=>`0x${value.toString(16)}`;
const digest=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex');
const reviewDigest=(review:TokenExecutionReview)=>{const {reviewHash:_ignored,...payload}=review;return digest(payload);};
async function loadManifest(path:string){const file=await open(path,'r');try{
  if((await file.stat()).size>16384)throw new Error();const bytes=Buffer.alloc(16385),read=await file.read(bytes,0,bytes.length,0);
  if(read.bytesRead>16384)throw new Error();return parseTokenManifest(JSON.parse(bytes.subarray(0,read.bytesRead).toString('utf8')));
}finally{await file.close();}}

/** Builds and revalidates wallet-owned calls. The service has no signing or transaction-submission capability. */
export function createTokenExecutionService(deps:Dependencies={}){
  const environment=deps.environment??(()=>process.env),now=deps.now??Date.now,repository=deps.repository??tokenExecutionRepository;
  async function connect():Promise<TokenExecutionChain>{
    if(deps.connect)return deps.connect();
    try{
      const env=environment(),config=networkConfig(env),network=nftExecutionNetwork(config);
      if(!network||!(network.mode==='local'?env.ONESHOT_LOCAL_TOKEN_EXECUTION_ENABLED==='true':env.ONESHOT_BASE_SEPOLIA_TOKEN_EXECUTION_ENABLED==='true')||!env.ONESHOT_TOKEN_INDEXER_MANIFEST_PATH)return unavailable();
      const manifest=await(deps.loadManifest??loadManifest)(env.ONESHOT_TOKEN_INDEXER_MANIFEST_PATH);
      if(manifest.mode!==network.mode||manifest.chainId!==network.chainId)return unavailable();
      const rpc=await(deps.rpc??createVerifiedRpc)(config),source=new VerifiedTokenSource(rpc),verified=await source.verify(manifest);
      return{manifest,deploymentId:tokenManifestId(manifest),rpc,source,block:verified.block,network};
    }catch{return unavailable();}
  }
  async function call(chain:TokenExecutionChain,to:Address,abi:Abi,functionName:string,args:readonly unknown[]=[]):Promise<unknown>{
    try{
      const result=await chain.rpc.readRpc('eth_call',[{to,data:encodeFunctionData({abi,functionName,args})},{blockHash:chain.block.hash,requireCanonical:true}]);
      if(typeof result!=='string'||!/^0x(?:[\da-f]{2})*$/i.test(result))return unavailable();
      const decoded=decodeFunctionResult({abi,functionName,data:result as Hex});
      if(encodeFunctionResult({abi,functionName,result:decoded}).toLowerCase()!==result.toLowerCase())return unavailable();return decoded;
    }catch{return unavailable();}
  }
  async function canonical(chain:TokenExecutionChain){const block=await chain.source.block(chain.block.number);
    if(block.hash!==chain.block.hash||block.timestamp!==chain.block.timestamp||block.parentHash!==chain.block.parentHash)return changed();}
  function expected(chain:TokenExecutionChain,input:TokenExecutionInput){if(input.expectedChainId!==chain.network.chainId||input.expectedDeploymentId!==chain.deploymentId)return changed();}
  async function anchor(chain:TokenExecutionChain,market:Address):Promise<TokenMarketReviewAnchor>{
    const state=await chain.source.verifyMarket(chain.manifest,market,chain.block);
    return{chainId:chain.network.chainId,genesisHash:chain.manifest.genesisHash,factory:chain.manifest.factory.address,poolManager:chain.manifest.poolManager.address,
      oracle:chain.manifest.oracle.address,market,token:address.parse(state.token),creator:address.parse(state.creator),platformRecipient:address.parse(state.platformRecipient),
      executionFeeBps:state.executionFeeBps,feeMode:state.liquidityAndBurn?'liquidity_burn':'creator',poolId:hash(state.poolId),
      sqrtLowerX96:raw(await call(chain,market,TOKEN_MARKET_ABI,'sqrtLowerX96')),sqrtUpperX96:raw(await call(chain,market,TOKEN_MARKET_ABI,'sqrtUpperX96')),
      blockNumber:chain.block.number,blockHash:chain.block.hash,blockTimestamp:chain.block.timestamp};
  }
  async function dexFees(chain:TokenExecutionChain,market:Address,side:'buy'|'sell'){
    const state=await call(chain,market,TOKEN_MARKET_ABI,'poolState');
    if(!Array.isArray(state)||state.length!==4||state[3]!==2500)return unavailable();
    try{return tokenDexSwapFee(state[2],side);}catch{return unavailable();}
  }
  async function build(chain:TokenExecutionChain,input:TokenExecutionInput){
    const from=input.from;let to:Address,data:Hex,value:bigint,summary:Record<string,string>;
    let deadline=chain.block.timestamp+TOKEN_REVIEW_LIFETIME_SECONDS;
    if(input.action==='launch'){
      const preview=await call(chain,chain.manifest.factory.address,TOKEN_MARKET_FACTORY_ABI,'previewTerms',[parseAssetAmount(input.draft.openingValuation,18)]);
      if(!Array.isArray(preview)||preview.length!==6)return unavailable();
      const prepared=prepareTokenLaunchCall({draft:input.draft,chainId:chain.network.chainId,genesisHash:chain.manifest.genesisHash,factory:chain.manifest.factory.address,from,
        preview:{tickLower:preview[0],tickUpper:preview[1],sqrtLowerX96:preview[2],sqrtUpperX96:preview[3],effectiveOpeningValuationNative:preview[4],effectiveUpperValuationNative:preview[5]}});
      ({to,data,value}=prepared);summary={name:prepared.terms.name,symbol:prepared.terms.symbol,initialSupplyRaw:prepared.terms.initialSupplyRaw.toString(),tokenDecimals:'8',
        executionFeeBps:String(prepared.terms.executionFeeBps),feeMode:prepared.terms.feeMode,openingValuationNativeRaw:prepared.terms.openingValuationNative.toString(),
        effectiveOpeningValuationNativeRaw:prepared.terms.effectiveOpeningValuationNative.toString(),effectiveUpperValuationNativeRaw:prepared.terms.effectiveUpperValuationNative.toString(),
        initialNativePrincipalRaw:'0',principalLocked:'true',fixedRange:'true',lpFeePips:'2500',protocolFeeMayApply:'true',gasPaidSeparately:'true'};
    }else{
      const state=await anchor(chain,input.market);
      if(input.action==='approve'){
        const prepared=prepareTokenApprovalCall(state,from,input.amount);({to,data,value}=prepared);
        summary={token:state.token,market:state.market,spender:prepared.spender,allowanceRaw:prepared.allowanceRaw.toString(),gasPaidSeparately:'true'};
      }else if(input.action==='claim'){
        const pending=raw(await call(chain,input.market,TOKEN_MARKET_ABI,'pending',[from]));
        if(!pending)throw new ApiError(409,'TOKEN_NOTHING_TO_CLAIM','This wallet has no proceeds to claim from this token.');
        const recipient=input.recipient??from;
        if([state.market,state.token,state.poolManager,state.factory,state.oracle].includes(recipient))throw new ApiError(400,'TOKEN_RECIPIENT_INVALID','Choose a wallet that can receive test ETH.');
        to=input.market;value=0n;data=encodeFunctionData({abi:TOKEN_MARKET_ABI,functionName:'claimTo',args:[recipient]});summary={market:to,recipient,claimableNativeRaw:pending.toString(),gasPaidSeparately:'true'};
      }else if(input.action==='maintain'){
        const pendingLpNativeRaw=raw(await call(chain,input.market,TOKEN_MARKET_ABI,'pendingLpNative')).toString();
        const pendingLpTokenRaw=raw(await call(chain,input.market,TOKEN_MARKET_ABI,'pendingLpToken')).toString();
        const pendingLiquidityNativeRaw=raw(await call(chain,input.market,TOKEN_MARKET_ABI,'pendingLiquidityNative')).toString();
        const pendingLiquidityTokenRaw=raw(await call(chain,input.market,TOKEN_MARKET_ABI,'pendingLiquidityToken')).toString();
        const pendingBurnNativeRaw=raw(await call(chain,input.market,TOKEN_MARKET_ABI,'pendingBurnNative')).toString();
        const prepared=prepareTokenMaintenanceCall({anchor:state,from,maximumNativeBudget:input.maximumNativeBudget,maximumTokenBudget:input.maximumTokenBudget,nativeDecimals:chain.network.nativeDecimals,now:BigInt(Math.floor(now()/1000))});
        ({to,data,value,deadline}=prepared);
        summary={...prepared.summary,pendingLpNativeRaw,pendingLpTokenRaw,pendingLiquidityNativeRaw,pendingLiquidityTokenRaw,pendingBurnNativeRaw};
      }else{
        const amount=parseAssetAmount(input.amount,input.action==='buy'?18:8),poolInput=input.action==='buy'?splitExecutionFee(amount,state.executionFeeBps,state.feeMode).net:amount;
        if(input.action==='sell'){
          const balance=raw(await call(chain,state.token,MARKET_TOKEN_ABI,'balanceOf',[from]));
          if(balance<amount)throw new ApiError(409,'TOKEN_BALANCE_LOW','This wallet does not have enough tokens for this sale.');
          const allowance=raw(await call(chain,state.token,MARKET_TOKEN_ABI,'allowance',[from,input.market]));
          if(allowance<amount)throw new ApiError(409,'TOKEN_APPROVAL_REQUIRED','Approve this token amount, then review the sale.');
        }
        const priceLimit=input.action==='buy'?state.sqrtLowerX96:state.sqrtUpperX96;
        let output:bigint;
        try{output=raw(await call(chain,chain.manifest.quoter.address,TOKEN_MARKET_QUOTER_ABI,'quoteSwap',[input.market,input.action==='buy',poolInput,priceLimit]));}
        catch{throw new ApiError(409,'TOKEN_QUOTE_UNAVAILABLE','A quote is unavailable for this amount. Refresh or try a smaller amount.');}
        const prepared=prepareTokenTradeCall({anchor:state,quote:{side:input.action,poolInputRaw:poolInput,poolOutputRaw:output,blockHash:chain.block.hash},
          amount:input.amount,side:input.action,from,recipient:input.recipient??from,slippageBps:input.slippageBps,now:BigInt(Math.floor(now()/1000)),priceLimit});
        ({to,data,value,deadline}=prepared);summary=Object.fromEntries(Object.entries({...prepared.summary,...await dexFees(chain,input.market,input.action)}).map(([key,item])=>[key,String(item)]));
      }
    }
    await canonical(chain);const lifetimeSeconds=input.action==='maintain'?TOKEN_MAINTENANCE_LIFETIME_SECONDS:TOKEN_REVIEW_LIFETIME_SECONDS;
    const expiresAt=Math.min(Number(deadline)*1000,now()+Number(lifetimeSeconds)*1000);
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=now())throw new ApiError(409,'TOKEN_QUOTE_EXPIRED','This quote expired. Refresh and try again.');
    let simulation:Awaited<ReturnType<Rpc['simulateCall']>>;
    try{simulation=await chain.rpc.simulateCall({from,to,data,value:hex(value)},{number:hex(chain.block.number),hash:chain.block.hash});}
    catch{
      if(input.action==='maintain')throw new ApiError(409,'TOKEN_MAINTENANCE_NOT_READY','Fee processing is not ready yet. Pending fees stay safe until the 5-minute price window, deviation guard and minimum budget are met.');
      throw new ApiError(409,'TOKEN_SIMULATION_FAILED','This transaction could not complete with the current balance, price or market state. Refresh its review and check your wallet balance.');
    }
    return{to,data,value:value.toString(),summary,expiresAt:new Date(expiresAt).toISOString(),simulation:{blockNumber:chain.block.number.toString(),blockHash:chain.block.hash,gasEstimate:simulation.gasEstimate}};
  }
  async function status(){try{const chain=await connect();return{enabled:true,network:chain.network,deploymentId:chain.deploymentId,factory:chain.manifest.factory.address,reason:null};}
    catch{return{enabled:false,network:null,deploymentId:null,factory:null,reason:'Token transactions are currently unavailable. You can save a draft and return later.'};}}
  async function review(rawInput:unknown,session:OneshotSession){
    const input=tokenExecutionInput.parse(rawInput);assertLinkedEvmAddress(session,input.from);
    const chain=await connect();expected(chain,input);const prepared=await build(chain,input),createdAt=now();
    if(Date.parse(prepared.expiresAt)<=createdAt)throw new ApiError(409,'TOKEN_QUOTE_EXPIRED','This quote expired. Refresh and try again.');
    const review:TokenExecutionReview={id:randomUUID(),reviewHash:'',action:input.action,chainId:chain.network.chainId,deploymentId:chain.deploymentId,network:chain.network,from:input.from,...prepared};
    review.reviewHash=reviewDigest(review);await repository.create({owner:session.userId,session:session.sessionId,createdAt,review,intent:input},createdAt);return review;
  }
  async function validate(id:string,expectedHash:string,session:OneshotSession){
    const stored=await repository.get(id,session.userId,now()),review=stored.review;
    assertLinkedEvmAddress(session,review.from);
    if(stored.session!==session.sessionId||review.reviewHash!==expectedHash||reviewDigest(review)!==review.reviewHash||stored.transactionHash)return changed();
    if(Date.parse(review.expiresAt)<=now())throw new ApiError(409,'TOKEN_QUOTE_EXPIRED','This review expired. Get a new review before approving.');
    const input=tokenExecutionInput.parse(stored.intent),chain=await connect();expected(chain,input);
    if(input.from!==review.from||input.action!==review.action)return changed();
    // Revalidate registry/code/immutable terms and exact original calldata. A new quote must never silently replace a reviewed minimum.
    if(input.action!=='launch')await anchor(chain,input.market);
    if(input.action==='buy'||input.action==='sell'){
      const fees=await dexFees(chain,input.market,input.action);
      if(String(fees.totalDexFeePips)!==review.summary.totalDexFeePips||String(fees.protocolFeePips)!==review.summary.protocolFeePips)return changed();
    }
    const oldBlock=await chain.source.block(BigInt(review.simulation.blockNumber));if(oldBlock.hash!==review.simulation.blockHash)return changed();
    if(input.action==='launch'){
      const refreshed=await build(chain,input);if(refreshed.data!==review.data||refreshed.to!==review.to||refreshed.value!==review.value||digest(refreshed.summary)!==digest(review.summary))return changed();
    }
    try{await chain.rpc.simulateCall({from:review.from,to:review.to,data:review.data,value:hex(BigInt(review.value))},{number:hex(chain.block.number),hash:chain.block.hash});}
    catch{throw new ApiError(409,'TOKEN_SIMULATION_FAILED','The price, balance or market state changed. Get a new review.');}
    if(Date.parse(review.expiresAt)<=now())throw new ApiError(409,'TOKEN_QUOTE_EXPIRED','This review expired. Get a new review.');
    const latest=await repository.get(id,session.userId,now());
    if(latest.transactionHash||latest.review.reviewHash!==review.reviewHash)return changed();
    return review;
  }
  async function recover(id:string,session:OneshotSession){
    const stored=await repository.get(id,session.userId,now());
    if(reviewDigest(stored.review)!==stored.review.reviewHash)return changed();
    return{review:stored.review,transactionHash:stored.transactionHash??null,outcome:stored.outcome??null};
  }
  async function receipt(id:string,transactionHash:Hex,session:OneshotSession){
    transactionHash=hash(transactionHash);const stored=await repository.get(id,session.userId,now()),review=stored.review;
    if(stored.transactionHash&&stored.transactionHash!==transactionHash)throw new ApiError(409,'TOKEN_TRANSACTION_CHANGED','This review is tracking a different transaction.');
    if(reviewDigest(review)!==review.reviewHash)return changed();const chain=await connect();
    if(chain.deploymentId!==review.deploymentId||chain.network.chainId!==review.chainId)return changed();
    const transaction=await chain.rpc.readRpc('eth_getTransactionByHash',[transactionHash]);
    if(transaction===null)return{reviewId:id,hash:transactionHash,status:'pending' as const,reason:'This transaction has not appeared on the network yet. Check again shortly.'};
    if(!object(transaction)||hash(transaction.hash)!==transactionHash||typeof transaction.from!=='string'||transaction.from.toLowerCase()!==review.from
      ||typeof transaction.to!=='string'||transaction.to.toLowerCase()!==review.to||typeof transaction.input!=='string'||transaction.input.toLowerCase()!==review.data||quantity(transaction.value)!==BigInt(review.value)
      ||quantity(transaction.chainId)!==BigInt(review.chainId))throw new ApiError(409,'TOKEN_TRANSACTION_MISMATCH','This transaction does not match the reviewed wallet call.');
    // The reviewed call was simulated against an already mined checkpoint. A
    // transaction in that checkpoint or an earlier block cannot be its result,
    // even when a repeated launch/approval has exactly the same calldata.
    const reviewedBlock=BigInt(review.simulation.blockNumber);
    if(transaction.blockNumber!==null&&transaction.blockNumber!==undefined&&quantity(transaction.blockNumber)<=reviewedBlock)return predatesReview();
    await repository.update(id,session.userId,transactionHash,'submitted',now());
    const receipt=await chain.rpc.readRpc('eth_getTransactionReceipt',[transactionHash]);
    if(receipt===null)return{reviewId:id,hash:transactionHash,status:'pending' as const,reason:'Waiting for a transaction receipt. Check again shortly.'};
    if(!object(receipt))return unavailable();
    if(quantity(receipt.blockNumber)<=reviewedBlock)return predatesReview();
    if(hash(receipt.transactionHash)!==transactionHash||typeof receipt.from!=='string'||receipt.from.toLowerCase()!==review.from
      ||typeof receipt.to!=='string'||receipt.to.toLowerCase()!==review.to||hash(receipt.blockHash)!==hash(transaction.blockHash)
      ||quantity(receipt.blockNumber)!==quantity(transaction.blockNumber)||!['0x0','0x1'].includes(String(receipt.status)))return unavailable();
    const mined=await chain.source.block(quantity(receipt.blockNumber));
    if(mined.hash!==hash(receipt.blockHash))return{reviewId:id,hash:transactionHash,status:'pending' as const,reason:'The transaction’s confirmation changed. Check again shortly.'};
    const outcome=receipt.status==='0x1'?'confirmed':'reverted';let createdMarket:{market:Address;token:Address}|undefined;
    if(outcome==='confirmed'&&review.action==='launch'){
      if(!Array.isArray(receipt.logs)||receipt.logs.length>1000)return unavailable();
      const created:Array<{market:Address;token:Address;creator:Address}>=[];
      for(const log of receipt.logs){
        if(!object(log)||typeof log.address!=='string'||log.address.toLowerCase()!==chain.manifest.factory.address)continue;
        try{const decoded=decodeEventLog({abi:TOKEN_MARKET_FACTORY_ABI,eventName:'MarketCreated',data:log.data as Hex,topics:log.topics as [Hex,...Hex[]],strict:true});
          created.push({market:address.parse(decoded.args.market),token:address.parse(decoded.args.token),creator:address.parse(decoded.args.creator)});
        }catch{continue;}
      }
      if(created.length!==1||created[0]!.creator!==review.from)return unavailable();const found=created[0]!;
      const state=await chain.source.verifyMarket(chain.manifest,found.market,mined),intent=tokenExecutionInput.parse(stored.intent);
      if(intent.action!=='launch'||state.token!==found.token||state.creator!==review.from||state.name!==intent.draft.name.trim()||state.symbol!==intent.draft.symbol.trim()
        ||state.executionFeeBps!==intent.draft.executionFeeBps||state.liquidityAndBurn!==(intent.draft.feeMode==='liquidity_burn')
        ||state.openingValuationNativeRaw!==review.summary.openingValuationNativeRaw||state.effectiveOpeningValuationNativeRaw!==review.summary.effectiveOpeningValuationNativeRaw
        ||state.effectiveUpperValuationNativeRaw!==review.summary.effectiveUpperValuationNativeRaw)return unavailable();
      createdMarket={market:found.market,token:found.token};
    }
    await repository.update(id,session.userId,transactionHash,outcome,now());
    return{reviewId:id,hash:transactionHash,status:outcome,blockNumber:mined.number.toString(),blockHash:mined.hash,finalized:false as const,...(createdMarket?{createdMarket}:{})};
  }
  return{status,review,validate,receipt,recover};
}
export const tokenExecution=createTokenExecutionService();
