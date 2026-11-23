import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, zeroAddress, type Address, type Hex } from 'viem';
import { BASE_SEPOLIA_GENESIS_HASH, BASE_SEPOLIA_POOL_MANAGER, MARKET_TOKEN_ABI, TOKEN_MARKET_ABI, TOKEN_MARKET_FACTORY_ABI, TOKEN_MARKET_QUOTER_ABI } from '@oneshot/evm';
import { parseTokenManifest, tokenManifestId } from '../../../indexer/src/token-manifest';
import { createTokenExecutionService, tokenExecutionInput, type TokenExecutionChain, type TokenExecutionInput } from './token-execution';
import { createTokenExecutionRepository } from './token-execution-store';
import type { OneshotSession } from './oneshot-auth';

const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const time=Date.parse('2026-11-16T10:00:00Z'),timestamp=BigInt(time/1000);
const session:OneshotSession={provider:'privy',userId:'account-a',sessionId:'session-a',expiresAt:time/1000+600,linkedAddresses:[a(10)]};
let directory:string;
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'oneshot-token-execution-'));vi.stubEnv('NODE_ENV','test');vi.stubEnv('ONESHOT_DATA_DIR',directory);});
afterEach(async()=>{vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});});
function fixture(){
  const manifest=parseTokenManifest({schemaVersion:1,deploymentVersion:'oneshot-v4-market-v1',mode:'base-sepolia',chainId:84532,genesisHash:BASE_SEPOLIA_GENESIS_HASH,startBlock:'1',anchorHash:BASE_SEPOLIA_GENESIS_HASH,
    factory:{address:a(1),codeHash:h(10)},poolManager:{address:BASE_SEPOLIA_POOL_MANAGER,codeHash:h(11)},oracle:{address:a(3),codeHash:h(12)},quoter:{address:a(8),codeHash:h(13)}});
  const block={number:100n,hash:h(100),parentHash:h(99),timestamp};
  const state={clock:time+1000,allowance:100000000000n,balance:100000000000n,quote:1000000000n,chainMoved:false,simulationFails:false,registered:true,
    transaction:null as unknown,receipt:null as unknown,claimable:100n,protocolFee:0};
  const poolId=keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}],[zeroAddress,a(5),2500,10,a(3)]));
  const snapshot={token:a(5),creator:a(6),platformRecipient:a(7),executionFeeBps:150,liquidityAndBurn:false,poolId};
  const readRpc=vi.fn(async(method:string,params:readonly unknown[]=[])=>{
    if(method==='eth_getTransactionByHash')return state.transaction;
    if(method==='eth_getTransactionReceipt')return state.receipt;
    if(method!=='eth_call')throw new Error('Unexpected RPC');
    const input=params[0] as {to:Address;data:Hex};
    expect(params[1]).toEqual({blockHash:block.hash,requireCanonical:true});
    const abi=input.to===a(1)?TOKEN_MARKET_FACTORY_ABI:input.to===a(5)?MARKET_TOKEN_ABI:input.to===a(8)?TOKEN_MARKET_QUOTER_ABI:TOKEN_MARKET_ABI;
    const call=decodeFunctionData({abi,data:input.data});
    const result=call.functionName==='sqrtLowerX96'?100n:call.functionName==='sqrtUpperX96'?10000n:call.functionName==='allowance'?state.allowance:call.functionName==='balanceOf'?state.balance:
      call.functionName==='poolState'?[1000n,0,state.protocolFee,2500]:call.functionName==='quoteSwap'?state.quote:call.functionName==='pending'?state.claimable:call.functionName==='previewTerms'?[-80000,-10000,100n,10000n,1251000000000000000n,1251000000000000000000n]:undefined;
    return encodeFunctionResult({abi,functionName:call.functionName,result} as never);
  });
  const simulateCall=vi.fn(async(_call:{from:string;to:string;data:string;value:string},_anchor:{number:string;hash:string})=>{if(state.simulationFails)throw new Error('secret provider URL');return{result:'0x',gasEstimate:'120000'};});
  const source={verifyMarket:vi.fn(async()=>{if(!state.registered)throw new Error('unregistered');return snapshot;}),block:vi.fn(async(number:bigint)=>({...block,number,hash:state.chainMoved?h(999):h(Number(number)),parentHash:h(Number(number)-1)}))};
  const chain={manifest,deploymentId:tokenManifestId(manifest),network:{mode:'base-sepolia',chainId:84532,name:'Base Sepolia',nativeSymbol:'ETH',nativeDecimals:18},block,rpc:{readRpc,simulateCall},source} as unknown as TokenExecutionChain;
  const repository=createTokenExecutionRepository({database:()=>null});
  const service=createTokenExecutionService({connect:async()=>chain,now:()=>state.clock,repository});
  const input=(change:Record<string,unknown>={}):TokenExecutionInput=>({action:'buy',from:a(10),market:a(4),amount:'1',slippageBps:100,testEthAcknowledged:true,expectedChainId:84532,expectedDeploymentId:chain.deploymentId,...change} as TokenExecutionInput);
  return{service,state,input,chain,readRpc,simulateCall,source,repository};
}

describe('wallet-owned Base token transaction reviews',()=>{
  it('requires explicit network acknowledgement, deployment and linked wallet before any read',async()=>{
    const f=fixture();
    expect(tokenExecutionInput.safeParse({...f.input(),testEthAcknowledged:undefined,localEthAcknowledged:true}).success).toBe(false);
    await expect(f.service.review(f.input({from:a(11)}),session)).rejects.toMatchObject({code:'WALLET_NOT_LINKED'});
    await expect(f.service.review(f.input({expectedChainId:31337}),session)).rejects.toMatchObject({code:'TOKEN_REVIEW_CHANGED'});
    expect(f.readRpc).not.toHaveBeenCalled();expect(f.simulateCall).not.toHaveBeenCalled();
  });
  it('quotes exact net input before simulating the complete native buy and storing its review',async()=>{
    const f=fixture(),review=await f.service.review(f.input(),session);
    expect(review).toMatchObject({action:'buy',chainId:84532,from:a(10),to:a(4),value:'1000000000000000000',summary:{minimumReceiveRaw:'990000000',quotedExecutionFeeRaw:'15000000000000000'}});
    expect(f.simulateCall).toHaveBeenCalledWith({from:a(10),to:a(4),data:review.data,value:'0xde0b6b3a7640000'},{number:'0x64',hash:h(100)});
    expect((await f.repository.get(review.id,session.userId,f.state.clock)).review).toEqual(review);
    expect(review.reviewHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('requires balance and exact market allowance for a sale without asking for a wallet signature',async()=>{
    const f=fixture();f.state.balance=0n;
    await expect(f.service.review(f.input({action:'sell',amount:'1'}),session)).rejects.toMatchObject({code:'TOKEN_BALANCE_LOW'});
    f.state.balance=100000000n;f.state.allowance=99999999n;
    await expect(f.service.review(f.input({action:'sell',amount:'1'}),session)).rejects.toMatchObject({code:'TOKEN_APPROVAL_REQUIRED'});
    expect(f.simulateCall).not.toHaveBeenCalled();
  });
  it('prepares a separate limited token allowance and a net-native sale review',async()=>{
    const f=fixture(),approval=await f.service.review(f.input({action:'approve',amount:'2.5',slippageBps:undefined}) as unknown,session).catch(()=>null);
    // Strict action bodies do not accept fields from another action, including undefined own properties.
    expect(approval).toBeNull();
    const {slippageBps:_slippage,recipient:_recipient,...base}=f.input() as Extract<TokenExecutionInput,{action:'buy'|'sell'}>;
    const limited=await f.service.review({...base,action:'approve',amount:'2.5'},session);
    expect(decodeFunctionData({abi:MARKET_TOKEN_ABI,data:limited.data})).toEqual({functionName:'approve',args:[a(4),250000000n]});
    f.state.quote=101n;const sold=await f.service.review(f.input({action:'sell',amount:'1'}),session);
    expect(sold.summary).toMatchObject({grossNativeRaw:'101',quotedExecutionFeeRaw:'1',minimumReceiveRaw:'99'});
  });
  it('re-simulates the original reviewed minimum after prices move',async()=>{
    const f=fixture(),review=await f.service.review(f.input(),session);f.state.quote=1n;
    await expect(f.service.validate(review.id,review.reviewHash,session)).resolves.toEqual(review);
    expect(f.simulateCall.mock.calls.at(-1)?.[0]).toEqual({from:review.from,to:review.to,data:review.data,value:'0xde0b6b3a7640000'});
  });
  it('rejects validation if receipt tracking binds the review while simulation is in flight',async()=>{
    const f=fixture(),review=await f.service.review(f.input(),session);
    let release!:()=>void,entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    f.simulateCall.mockImplementationOnce(async()=>{entered();await waiting;return{result:'0x',gasEstimate:'120000'};});
    const validation=f.service.validate(review.id,review.reviewHash,session);
    await started;await f.repository.update(review.id,session.userId,h(111),'submitted',f.state.clock);release();
    await expect(validation).rejects.toMatchObject({code:'TOKEN_REVIEW_CHANGED'});
  });
  it('discloses the actual directional pool fee and requires a new review if it changes',async()=>{
    const f=fixture();f.state.protocolFee=1000;const review=await f.service.review(f.input(),session);
    expect(review.summary).toMatchObject({protocolFeePips:'1000',lpFeePips:'2500',totalDexFeePips:'3498'});
    f.state.protocolFee=0;await expect(f.service.validate(review.id,review.reviewHash,session)).rejects.toMatchObject({code:'TOKEN_REVIEW_CHANGED'});
  });
  it('rejects stale, reorganized, mismatched and cross-session signing reviews',async()=>{
    const f=fixture(),review=await f.service.review(f.input(),session);
    await expect(f.service.validate(review.id,'f'.repeat(64),session)).rejects.toMatchObject({code:'TOKEN_REVIEW_CHANGED'});
    await expect(f.service.validate(review.id,review.reviewHash,{...session,sessionId:'new-session'})).rejects.toMatchObject({code:'TOKEN_REVIEW_CHANGED'});
    f.state.chainMoved=true;await expect(f.service.validate(review.id,review.reviewHash,session)).rejects.toMatchObject({code:'TOKEN_REVIEW_CHANGED'});
    f.state.chainMoved=false;f.state.clock=time+120000;
    await expect(f.service.validate(review.id,review.reviewHash,session)).rejects.toMatchObject({code:'TOKEN_QUOTE_EXPIRED'});
  });
  it('returns useful safe errors for a failed simulation and never stores it',async()=>{
    const f=fixture();f.state.simulationFails=true;
    await expect(f.service.review(f.input(),session)).rejects.toMatchObject({code:'TOKEN_SIMULATION_FAILED'});
    expect(JSON.stringify(await f.service.status())).not.toContain('secret');
  });
  it('reads factory-aligned launch bounds before simulating a token-only launch',async()=>{
    const f=fixture(),base=f.input();const common={from:base.from,testEthAcknowledged:true,expectedChainId:base.expectedChainId,expectedDeploymentId:base.expectedDeploymentId};
    const reviewed=await f.service.review({...common,action:'launch',draft:{pricingNetwork:'base-sepolia',name:'Example',symbol:'EX',openingValuation:'1.25',executionFeeBps:150,feeMode:'creator'}},session);
    expect(reviewed.value).toBe('0');expect(reviewed.to).toBe(a(1));
    expect(reviewed.summary.effectiveOpeningValuationNativeRaw).toBe('1251000000000000000');
    await expect(f.service.validate(reviewed.id,reviewed.reviewHash,session)).resolves.toEqual(reviewed);
  });
  it('keeps proceeds claims available to their owner and rejects unsafe recipients',async()=>{
    const f=fixture(),base=f.input();const common={from:base.from,market:a(4),testEthAcknowledged:true,expectedChainId:84532,expectedDeploymentId:base.expectedDeploymentId,action:'claim'};
    const reviewed=await f.service.review(common,session);expect(reviewed.summary.claimableNativeRaw).toBe('100');
    await expect(f.service.review({...common,recipient:a(4)},session)).rejects.toMatchObject({code:'TOKEN_RECIPIENT_INVALID'});
    f.state.claimable=0n;await expect(f.service.review(common,session)).rejects.toMatchObject({code:'TOKEN_NOTHING_TO_CLAIM'});
  });
  it('prepares permissionless maintenance capped at 60 seconds and reports unready oracle cleanly',async()=>{
    const f=fixture(),base=f.input();
    f.readRpc.mockImplementation(async(method:string,params:readonly unknown[]=[])=>{
      if(method==='eth_getTransactionByHash')return f.state.transaction;
      if(method==='eth_getTransactionReceipt')return f.state.receipt;
      if(method!=='eth_call')throw new Error('Unexpected RPC');
      const input=params[0] as {to:Address;data:Hex};
      const abi=input.to===a(1)?TOKEN_MARKET_FACTORY_ABI:input.to===a(5)?MARKET_TOKEN_ABI:input.to===a(8)?TOKEN_MARKET_QUOTER_ABI:TOKEN_MARKET_ABI;
      const call=decodeFunctionData({abi,data:input.data});
      const result=call.functionName==='sqrtLowerX96'?100n:call.functionName==='sqrtUpperX96'?10000n
        :call.functionName==='pendingLpNative'?1000n:call.functionName==='pendingLpToken'?2000n
        :call.functionName==='pendingLiquidityNative'?3000n:call.functionName==='pendingLiquidityToken'?4000n
        :call.functionName==='pendingBurnNative'?5000n:undefined;
      return encodeFunctionResult({abi,functionName:call.functionName,result} as never);
    });
    const common={from:base.from,market:a(4),testEthAcknowledged:true,expectedChainId:84532,expectedDeploymentId:base.expectedDeploymentId};
    const reviewed=await f.service.review({...common,action:'maintain',maximumNativeBudget:'1',maximumTokenBudget:'1000'},session);
    expect(reviewed.value).toBe('0');
    expect(Date.parse(reviewed.expiresAt)-f.state.clock).toBeLessThanOrEqual(60_000);
    expect(reviewed.summary).toMatchObject({executionFeeBps:'0',maintenanceLifetimeSeconds:'60',pendingLpNativeRaw:'1000',pendingLpTokenRaw:'2000',pendingLiquidityNativeRaw:'3000',pendingLiquidityTokenRaw:'4000',pendingBurnNativeRaw:'5000'});
    await expect(f.service.validate(reviewed.id,reviewed.reviewHash,session)).resolves.toEqual(reviewed);
    f.state.simulationFails=true;
    await expect(f.service.review({...common,action:'maintain',maximumNativeBudget:'1',maximumTokenBudget:'1000'},session)).rejects.toMatchObject({code:'TOKEN_MAINTENANCE_NOT_READY'});
  });
});

describe('token receipt recovery',()=>{
  async function submitted(){const f=fixture(),review=await f.service.review(f.input(),session),tx=h(111);
    f.state.transaction={hash:tx,from:review.from,to:review.to,input:review.data,value:'0xde0b6b3a7640000',chainId:'0x14a34',blockNumber:'0x65',blockHash:h(101)};
    f.state.receipt={transactionHash:tx,from:review.from,to:review.to,status:'0x1',blockNumber:'0x65',blockHash:h(101)};return{...f,review,tx};}
  it('matches the full transaction and canonical receipt; confirmation remains explicitly unfinalized',async()=>{
    const f=await submitted();await expect(f.service.receipt(f.review.id,f.tx,session)).resolves.toMatchObject({status:'confirmed',blockNumber:'101',blockHash:h(101),finalized:false});
    await expect(f.service.recover(f.review.id,{...session,sessionId:'renewed',linkedAddresses:[]})).resolves.toMatchObject({transactionHash:f.tx,outcome:'confirmed'});
    await expect(f.service.validate(f.review.id,f.review.reviewHash,session)).rejects.toMatchObject({code:'TOKEN_REVIEW_CHANGED'});
  });
  it('rejects redirected recipient/calldata/value/network before binding the transaction hash',async()=>{
    for(const changed of [{from:a(11)},{to:a(11)},{input:'0x1234'},{value:'0x1'},{chainId:'0x1'}]){
      const f=await submitted();f.state.transaction={...(f.state.transaction as object),...changed};
      await expect(f.service.receipt(f.review.id,f.tx,session)).rejects.toMatchObject({code:'TOKEN_TRANSACTION_MISMATCH'});
      expect((await f.repository.get(f.review.id,session.userId,f.state.clock)).transactionHash).toBeUndefined();
    }
  });
  it('returns pending when the receipt is absent or its block becomes noncanonical',async()=>{
    const f=await submitted();f.state.receipt=null;await expect(f.service.receipt(f.review.id,f.tx,session)).resolves.toMatchObject({status:'pending'});
    f.state.receipt={transactionHash:f.tx,from:f.review.from,to:f.review.to,status:'0x1',blockNumber:'0x65',blockHash:h(101)};f.state.chainMoved=true;
    await expect(f.service.receipt(f.review.id,f.tx,session)).resolves.toMatchObject({status:'pending'});
    expect((await f.repository.get(f.review.id,session.userId,f.state.clock)).outcome).toBe('submitted');
  });
  it('keeps an unknown hash unbound and marks a canonical failed receipt reverted',async()=>{
    const f=await submitted();f.state.transaction=null;
    await expect(f.service.receipt(f.review.id,f.tx,session)).resolves.toMatchObject({status:'pending'});
    expect((await f.repository.get(f.review.id,session.userId,f.state.clock)).transactionHash).toBeUndefined();
    const g=await submitted();g.state.receipt={...(g.state.receipt as object),status:'0x0'};
    await expect(g.service.receipt(g.review.id,g.tx,session)).resolves.toMatchObject({status:'reverted'});
  });
  it('cannot bind an earlier identical launch or approval to a fresh review',async()=>{
    for(const action of ['launch','approve'] as const){
      const f=fixture(),base=f.input();
      const common={from:base.from,testEthAcknowledged:true,expectedChainId:base.expectedChainId,expectedDeploymentId:base.expectedDeploymentId};
      const intent=action==='launch'?{...common,action,draft:{pricingNetwork:'base-sepolia',name:'Example',symbol:'EX',openingValuation:'1.25',executionFeeBps:150,feeMode:'creator'}}
        :{...common,action,market:a(4),amount:'1'};
      const review=await f.service.review(intent,session),tx=h(action==='launch'?120:121);
      for(const blockNumber of ['0x63','0x64']){
        f.state.transaction={hash:tx,from:review.from,to:review.to,input:review.data,value:'0x0',chainId:'0x14a34',blockNumber,blockHash:h(Number(BigInt(blockNumber)))};
        f.state.receipt={transactionHash:tx,from:review.from,to:review.to,status:'0x1',blockNumber,blockHash:h(Number(BigInt(blockNumber)))};
        await expect(f.service.receipt(review.id,tx,session)).rejects.toMatchObject({code:'TOKEN_TRANSACTION_PREDATES_REVIEW'});
        expect((await f.repository.get(review.id,session.userId,f.state.clock)).transactionHash).toBeUndefined();
      }
    }
  });
  it('tracks an exact pending call but cannot confirm a later returned receipt from the reviewed block',async()=>{
    const f=await submitted();
    f.state.transaction={...(f.state.transaction as object),blockNumber:null,blockHash:null};f.state.receipt=null;
    await expect(f.service.receipt(f.review.id,f.tx,session)).resolves.toMatchObject({status:'pending'});
    expect((await f.repository.get(f.review.id,session.userId,f.state.clock)).transactionHash).toBe(f.tx);
    f.state.receipt={transactionHash:f.tx,from:f.review.from,to:f.review.to,status:'0x1',blockNumber:'0x64',blockHash:h(100)};
    await expect(f.service.receipt(f.review.id,f.tx,session)).rejects.toMatchObject({code:'TOKEN_TRANSACTION_PREDATES_REVIEW'});
    expect((await f.repository.get(f.review.id,session.userId,f.state.clock)).outcome).toBe('submitted');
  });
  it('can recover a genuinely newer transaction after the signing review expires',async()=>{
    const f=await submitted();f.state.clock=time+120000;
    await expect(f.service.receipt(f.review.id,f.tx,session)).resolves.toMatchObject({status:'confirmed',blockNumber:'101'});
    expect((await f.service.recover(f.review.id,session)).outcome).toBe('confirmed');
  });
});
