import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, type Abi, type Address, type Hex } from 'viem';
import { NFT_COLLECTION_ABI, NFT_FACTORY_ABI, NFT_MARKETPLACE_ABI, GUARDED_MARKETPLACE_ABI, type createVerifiedRpc, type RpcReadMethod } from '@oneshot/evm';
import { parseManifest, manifestId } from '../../../indexer/src/manifest';
import { createNftLaunchService, nftReviewInput, type NftReview } from './nft-launch';
import type { OneshotSession } from './oneshot-auth';
import { createNftEarningsController } from '../../../web/lib/client-nft-earnings';

const address=(value:number):Address=>`0x${value.toString(16).padStart(40,'0')}`;
const hash=(value:number):Hex=>`0x${value.toString(16).padStart(64,'0')}`;
const quantity=(value:bigint)=>`0x${value.toString(16)}`;
const factory=address(1),marketplace=address(2),treasury=address(3),wallet=address(10),recipient=address(11);
const bytecode='0x6001600055' as Hex;
const session:OneshotSession={provider:'privy',userId:'did:privy:earnings',sessionId:'session-one',expiresAt:9_999_999_999,linkedAddresses:[wallet,treasury]};
const testRoot=resolve('.local/nft-earnings-unit-tests');
let directory='';
beforeEach(async()=>{
  await mkdir(testRoot,{recursive:true});directory=await mkdtemp(join(testRoot,'case-'));
  vi.stubEnv('NODE_ENV','test');vi.stubEnv('DATABASE_URL','');vi.stubEnv('ONESHOT_DATA_DIR',directory);
});
afterEach(async()=>{
  vi.unstubAllEnvs();const target=resolve(directory);
  if(dirname(target)!==testRoot || !basename(target).startsWith('case-'))throw new Error('Unsafe earnings fixture cleanup.');
  await rm(target,{recursive:true,force:true});
});

type Snapshot={count:bigint;marketAmount:bigint;collectionBase:bigint};
function fixture(guarded=false) {
  const manifest=parseManifest({schemaVersion:1,deploymentVersion:guarded?'oneshot-nft-v2':'oneshot-nft-v1',mode:'local',chainId:31337,
    genesisHash:hash(1000),startBlock:'1',anchorHash:hash(1000),factory:{address:factory,codeHash:keccak256(bytecode)},marketplace:{address:marketplace,codeHash:keccak256(bytecode)},
    ...(guarded?{listingAuthorization:{authority:address(5),salt:hash(555)}}:{})});
  const state={head:20n,now:1_900_000_000_000,blocks:new Map<bigint,Hex>(),snapshots:new Map<bigint,Snapshot>([[20n,{count:12n,marketAmount:9007199254740993123456789n,collectionBase:9007199254740993000000000n}]]),
    collectionFactory:factory,collectionTreasury:treasury,registered:true,duplicate:false,reorgDuringPending:false,expireDuringPending:false,
    transaction:null as Record<string,unknown>|null,receipt:null as Record<string,unknown>|null};
  const blockHash=(height:bigint)=>state.blocks.get(height)??hash(Number(height)+1000);
  const readRpc=vi.fn(async(method:RpcReadMethod,params:readonly unknown[]=[]):Promise<unknown>=>{
    if(method==='eth_getBlockByNumber') {const height=BigInt(params[0] as string);return {number:quantity(height),hash:blockHash(height),parentHash:blockHash(height===0n?0n:height-1n),timestamp:quantity(1_900_000_000n+height)};}
    if(method==='eth_blockNumber')return quantity(state.head);
    if(method==='eth_getCode')return bytecode;
    if(method==='eth_getTransactionByHash')return state.transaction;
    if(method==='eth_getTransactionReceipt')return state.receipt;
    if(method!=='eth_call')throw new Error(`Unexpected method ${method}`);
    const call=params[0] as {to:Address;data:Hex},tag=params[1] as string|{blockHash:string};
    const at=typeof tag==='object'?[...state.snapshots.keys()].find(height=>hash(Number(height)+1000)===tag.blockHash)??state.head:state.head;
    const snapshot=state.snapshots.get(at)??state.snapshots.get(20n)!;
    const abi:Abi=call.to===factory?NFT_FACTORY_ABI:call.to===marketplace?(guarded?GUARDED_MARKETPLACE_ABI:NFT_MARKETPLACE_ABI):NFT_COLLECTION_ABI;
    const decoded=decodeFunctionData({abi,data:call.data}),args=decoded.args as readonly unknown[]|undefined;
    let value:unknown;
    switch(decoded.functionName) {
      case 'factory':value=call.to===marketplace?factory:state.collectionFactory;break;
      case 'treasury':value=call.to===factory||call.to===marketplace?treasury:state.collectionTreasury;break;
      case 'listingAuthority':value=address(5);break;
      case 'deploymentSalt':value=hash(555);break;
      case 'collectionCount':value=snapshot.count;break;
      case 'collections':value=address(state.duplicate?100:100+Number(args![0]));break;
      case 'isCollection':value=state.registered;break;
      case 'name':value=`Collection ${parseInt(call.to.slice(2),16)-100}`;break;
      case 'opened':value=call.to!==address(100);break;
      case 'pending': {
        const index=parseInt(call.to.slice(2),16)-100;
        value=call.to===marketplace?snapshot.marketAmount:index===0?0n:snapshot.collectionBase+BigInt(index)+(args![0]===treasury?100n:0n);
        if(state.reorgDuringPending)state.blocks.set(at,hash(9999));
        if(state.expireDuringPending)state.now=session.expiresAt*1000;
        break;
      }
      default:throw new Error(`Unexpected contract read ${decoded.functionName}`);
    }
    return encodeFunctionResult({abi,functionName:decoded.functionName,result:value});
  });
  const simulateCall=vi.fn(async()=>({result:'0x',gasEstimate:'50000'}));
  const verified={verification:{mode:'local',chainId:31337,genesisHash:manifest.genesisHash,latestBlock:20n,checkedAt:'2030-01-01T00:00:00Z',provider:{label:'custom',verifiedSupport:false},genesisMatched:null},readRpc,simulateCall} as Awaited<ReturnType<typeof createVerifiedRpc>>;
  const rpc=vi.fn(async()=>verified),loadManifest=vi.fn(async()=>manifest);
  const getDraft=vi.fn(async()=>{throw new Error('Earnings must not read a private creator draft.');});
  const verifySnapshot=vi.fn(async()=>{throw new Error('Earnings must not read private snapshot state.');});
  const env:Record<string,string|undefined>={ONESHOT_LOCAL_NFT_EXECUTION_ENABLED:'true',ONESHOT_NETWORK:'local',ONESHOT_LOCAL_RPC_URL:'http://127.0.0.1:8545',ONESHOT_INDEXER_MANIFEST_PATH:'injected-local-manifest.json'};
  const dependencies={environment:()=>env,now:()=>state.now,loadManifest,rpc,getDraft,verifySnapshot};
  const service=createNftLaunchService(dependencies);
  function calls(name:string,target?:Address) {return readRpc.mock.calls.filter(([method,params])=>{
    if(method!=='eth_call')return false;
    const call=params![0] as {to:Address;data:Hex};if(target&&call.to!==target)return false;
    try{return decodeFunctionData({abi:call.to===factory?NFT_FACTORY_ABI:call.to===marketplace?NFT_MARKETPLACE_ABI:NFT_COLLECTION_ABI,data:call.data}).functionName===name;}catch{return false;}
  });}
  function mined(review:NftReview) {
    const txHash=hash(900),height=21n;state.head=height;
    state.transaction={hash:txHash,from:review.from,to:review.to,input:review.data,value:'0x0',chainId:'0x7a69',blockNumber:quantity(height),blockHash:blockHash(height)};
    state.receipt={transactionHash:txHash,blockNumber:quantity(height),blockHash:blockHash(height),status:'0x1',logs:[{address:marketplace,
      topics:encodeEventTopics({abi:NFT_MARKETPLACE_ABI,eventName:'Claimed',args:{account:wallet,recipient}}),data:encodeAbiParameters([{type:'uint256'}],[BigInt(review.summary.claimAmountRaw)])}]};
    return txHash;
  }
  return {state,manifest,service,env,dependencies,readRpc,simulateCall,rpc,loadManifest,getDraft,verifySnapshot,calls,mined};
}
function editCursor(cursor:string,changes:Record<string,unknown>) {return Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(cursor,'base64url').toString()),...changes})).toString('base64url');}

describe('fresh canonical wallet proceeds',()=>{
  it.each([false,true])('reads exact aggregate market credits once and ten registered collection sources for guarded=%s',async guarded=>{
    const test=fixture(guarded),page=await test.service.earnings({from:wallet},session);
    expect(page).toMatchObject({deploymentId:manifestId(test.manifest),wallet,blockNumber:'20',blockHash:hash(1020),marketplace:{contract:marketplace,amountRaw:'9007199254740993123456789'},scannedCount:10,totalCollectionsRaw:'12'});
    expect(page.collections).toHaveLength(10);expect(page.collections[0]).toEqual({contract:address(100),name:'Collection 0',opened:false,amountRaw:'0'});
    expect(page.collections[1].amountRaw).toBe('9007199254740993000000001');
    expect(test.calls('pending',marketplace)).toHaveLength(1);expect(test.calls('collections')).toHaveLength(10);
    expect(test.calls('pending').every(([,params])=>(params![1] as {blockHash:string}).blockHash===hash(1020))).toBe(true);
    expect(test.getDraft).not.toHaveBeenCalled();expect(test.verifySnapshot).not.toHaveBeenCalled();expect(test.simulateCall).not.toHaveBeenCalled();
    for(const hidden of ['userId','sessionId','allowlistAddresses','floorRaw','ONESHOT_','private-rpc'])expect(JSON.stringify(page)).not.toContain(hidden);
  });
  it('pins subsequent pages to the first canonical block even after new collections and payments arrive',async()=>{
    const test=fixture(),first=await test.service.earnings({from:wallet},session);
    test.state.head=21n;test.state.snapshots.set(21n,{count:14n,marketAmount:1n,collectionBase:2n});test.readRpc.mockClear();
    const second=await test.service.earnings({from:wallet,cursor:first.nextCursor!},session);
    expect(second).toMatchObject({blockNumber:'20',blockHash:first.blockHash,marketplace:first.marketplace,scannedCount:12,totalCollectionsRaw:'12',nextCursor:null});
    expect(second.collections.map(item=>item.contract)).toEqual([address(110),address(111)]);
    expect(test.calls('pending',marketplace)).toHaveLength(1);
    const fresh=await test.service.earnings({from:wallet},session);expect(fresh).toMatchObject({blockNumber:'21',totalCollectionsRaw:'14',marketplace:{amountRaw:'1'}});
  });
  it('discovers treasury proceeds in every collection without relying on creator ownership or NFT holdings',async()=>{
    const test=fixture(),page=await test.service.earnings({from:treasury},session);
    expect(page.wallet).toBe(treasury);expect(page.collections).toHaveLength(10);
    expect(page.collections[1].amountRaw).toBe('9007199254740993000000101');
    expect(test.getDraft).not.toHaveBeenCalled();
  });
  it('keeps global marketplace proceeds visible when no collections exist',async()=>{
    const test=fixture();test.state.snapshots.get(20n)!.count=0n;
    const page=await test.service.earnings({from:wallet},session);
    expect(page).toMatchObject({collections:[],scannedCount:0,totalCollectionsRaw:'0',nextCursor:null,marketplace:{amountRaw:'9007199254740993123456789'}});
    expect(test.calls('collections')).toHaveLength(0);expect(test.calls('pending',marketplace)).toHaveLength(1);
  });
  it('bounds large registry counts with exact string amounts and ten discovery reads',async()=>{
    const test=fixture();test.state.snapshots.get(20n)!.count=2n**200n;
    const page=await test.service.earnings({from:wallet},session);
    expect(page.totalCollectionsRaw).toBe((2n**200n).toString());expect(page.scannedCount).toBe(10);expect(test.calls('collections')).toHaveLength(10);
  });
  it('loads actual service pages through the client controller with cumulative scans and one aggregate market balance',async()=>{
    const test=fixture();test.state.snapshots.get(20n)!.count=25n;
    const fetcher=vi.fn(async(input:{wallet:string;cursor?:string})=>test.service.earnings({from:input.wallet,cursor:input.cursor},session));
    const controller=createNftEarningsController(fetcher);
    await controller.open({identityScope:'earnings-account-session',wallet,deploymentId:manifestId(test.manifest)});
    expect(controller.snapshot()).toMatchObject({error:null,data:{scannedCount:10,collections:expect.any(Array)}});
    test.state.head=21n;test.state.snapshots.set(21n,{count:30n,marketAmount:1n,collectionBase:2n});
    await controller.loadMore();
    expect(controller.snapshot()).toMatchObject({error:null,data:{scannedCount:20,blockNumber:'20',totalCollectionsRaw:'25'}});
    expect(controller.snapshot().data?.collections).toHaveLength(20);
    await controller.loadMore();
    expect(controller.snapshot()).toMatchObject({error:null,data:{scannedCount:25,blockNumber:'20',totalCollectionsRaw:'25',nextCursor:null,marketplace:{amountRaw:'9007199254740993123456789'}}});
    expect(controller.snapshot().data?.collections).toHaveLength(25);
    expect(new Set(controller.snapshot().data?.collections.map(item=>item.contract)).size).toBe(25);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('rejects unsafe cursor offsets or cumulative scan counts while preserving uint256 registry totals',async()=>{
    const test=fixture();test.state.snapshots.get(20n)!.count=2n**200n;
    const first=await test.service.earnings({from:wallet},session);
    const safeAligned=BigInt(Number.MAX_SAFE_INTEGER)/10n*10n;
    for(const offset of [safeAligned.toString(),(safeAligned+10n).toString()]) {
      test.readRpc.mockClear();
      await expect(test.service.earnings({from:wallet,cursor:editCursor(first.nextCursor!,{offset})},session)).rejects.toMatchObject({code:'EARNINGS_CURSOR_INVALID'});
      expect(test.calls('pending')).toHaveLength(0);expect(test.calls('collections')).toHaveLength(0);
    }
  });
  it.each(['unlinked','expired','wrong-profile'] as const)('rejects %s without a proceeds read',async mode=>{
    const test=fixture();if(mode==='wrong-profile')test.env.ONESHOT_NETWORK='zero';
    const identity=mode==='expired'?{...session,expiresAt:1}:mode==='unlinked'?{...session,linkedAddresses:[treasury]}:session;
    await expect(test.service.earnings({from:wallet},identity)).rejects.toBeDefined();expect(test.calls('pending')).toHaveLength(0);
    if(mode!=='wrong-profile'){expect(test.rpc).not.toHaveBeenCalled();expect(test.loadManifest).not.toHaveBeenCalled();}
  });
  it.each(['not-json','%%%',Buffer.from('{}').toString('base64url'),'e30='])('rejects malformed cursor %s before chain access',async cursor=>{
    const test=fixture();await expect(test.service.earnings({from:wallet,cursor},session)).rejects.toMatchObject({code:'EARNINGS_CURSOR_INVALID'});expect(test.rpc).not.toHaveBeenCalled();
  });
  it.each([{offset:'0'},{offset:'11'},{offset:'12'},{offset:'-10'},{extra:'private'},{wallet:treasury}])('rejects invalid cursor scope or page structure %j',async changes=>{
    const test=fixture(),first=await test.service.earnings({from:wallet},session);test.rpc.mockClear();
    await expect(test.service.earnings({from:wallet,cursor:editCursor(first.nextCursor!,changes)},session)).rejects.toMatchObject({code:'EARNINGS_CURSOR_INVALID'});expect(test.rpc).not.toHaveBeenCalled();
  });
  it.each([{deploymentId:'a'.repeat(64)},{blockNumber:'21'},{blockNumber:'0'},{blockHash:hash(999)},{count:'13'}])('refuses altered or noncanonical cursor evidence %j',async changes=>{
    const test=fixture(),first=await test.service.earnings({from:wallet},session);test.readRpc.mockClear();
    await expect(test.service.earnings({from:wallet,cursor:editCursor(first.nextCursor!,changes)},session)).rejects.toMatchObject({code:'EARNINGS_CURSOR_STALE'});expect(test.calls('pending')).toHaveLength(0);
  });
  it('rejects an actual reorganization of the pinned cursor block and a reorg during pending reads',async()=>{
    const test=fixture(),first=await test.service.earnings({from:wallet},session);test.state.blocks.set(20n,hash(999));
    await expect(test.service.earnings({from:wallet,cursor:first.nextCursor!},session)).rejects.toMatchObject({code:'EARNINGS_CURSOR_STALE'});
    const during=fixture();during.state.reorgDuringPending=true;
    await expect(during.service.earnings({from:wallet},session)).rejects.toMatchObject({code:'EARNINGS_CURSOR_STALE'});
  });
  it.each(['factory','treasury','registration','duplicate'] as const)('refuses a %s mismatch instead of presenting a misleading zero source',async field=>{
    const test=fixture();if(field==='factory')test.state.collectionFactory=address(999);if(field==='treasury')test.state.collectionTreasury=address(999);if(field==='registration')test.state.registered=false;if(field==='duplicate')test.state.duplicate=true;
    await expect(test.service.earnings({from:wallet},session)).rejects.toMatchObject({code:field==='duplicate'?'RPC_DATA_INVALID':'COLLECTION_MISMATCH'});
  });
  it('rechecks session expiry after RPC awaits and does not turn provider failure into zero earnings',async()=>{
    const test=fixture();test.state.expireDuringPending=true;
    await expect(test.service.earnings({from:wallet},session)).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    const failed=fixture(),original=failed.readRpc.getMockImplementation()!;
    failed.readRpc.mockImplementation(async(method,params=[])=>{
      const call=params[0] as {to?:Address;data?:Hex}|undefined;
      if(method==='eth_call'&&call?.to===marketplace&&decodeFunctionData({abi:NFT_MARKETPLACE_ABI,data:call.data!}).functionName==='pending')throw new Error('provider unavailable');
      return original(method,params);
    });
    await expect(failed.service.earnings({from:wallet},session)).rejects.toThrow();
  });
});

describe('standalone reviewed marketplace claims',()=>{
  const input=()=>({action:'claim' as const,from:wallet,contract:marketplace,recipient,localEthAcknowledged:true as const});
  it('simulates and reviews the exact global claim without collection metadata or creator access',async()=>{
    const test=fixture();test.state.snapshots.get(20n)!.count=0n;
    const review=await test.service.review(input(),session);
    expect(review).toMatchObject({scope:'public',draftId:marketplace,revision:0,to:marketplace,value:'0',summary:{contract:marketplace,recipient,claimAmountRaw:'9007199254740993123456789'}});
    expect(decodeFunctionData({abi:NFT_MARKETPLACE_ABI,data:review.data})).toMatchObject({functionName:'claimTo',args:[recipient]});
    expect(test.getDraft).not.toHaveBeenCalled();expect(test.verifySnapshot).not.toHaveBeenCalled();expect(test.calls('collections')).toHaveLength(0);
    expect(test.simulateCall).toHaveBeenCalledOnce();
    const transactionHash=test.mined(review);await test.service.submitted(review.id,review.reviewHash,transactionHash,session);
    await expect(createNftLaunchService(test.dependencies).receipt(review.id,transactionHash,{...session,sessionId:'renewed'})).resolves.toMatchObject({status:'confirmed',hash:transactionHash});
  });
  it('keeps amount changes behind a fresh review and rejects exhausted proceeds',async()=>{
    const test=fixture(),review=await test.service.review(input(),session);
    test.state.snapshots.get(20n)!.marketAmount+=1n;
    await expect(test.service.validate(review.id,review.reviewHash,session)).rejects.toMatchObject({code:'REVIEW_CHANGED'});
    test.state.snapshots.get(20n)!.marketAmount=0n;
    await expect(test.service.review(input(),session)).rejects.toMatchObject({code:'NOTHING_TO_CLAIM'});
  });
  it.each([factory,address(100),address(999)])('refuses a standalone nonmarket contract %s before reading pending',async contract=>{
    const test=fixture();await expect(test.service.review({...input(),contract},session)).rejects.toMatchObject({code:'INVALID_CONTRACT'});expect(test.calls('pending')).toHaveLength(0);
  });
  it('keeps all other public operations collection-bound and requires local acknowledgment, linked ownership and a valid recipient',async()=>{
    expect(nftReviewInput.safeParse({...input(),action:'mint'}).success).toBe(false);
    expect(nftReviewInput.safeParse({...input(),action:'claim',contract:undefined}).success).toBe(false);
    expect(nftReviewInput.safeParse({...input(),localEthAcknowledged:false}).success).toBe(false);
    const test=fixture();await expect(test.service.review({...input(),from:recipient},session)).rejects.toMatchObject({code:'WALLET_NOT_LINKED'});
    await expect(test.service.review({...input(),recipient:marketplace},session)).rejects.toMatchObject({code:'INVALID_RECIPIENT'});
  });
});
