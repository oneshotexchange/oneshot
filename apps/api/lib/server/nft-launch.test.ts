import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, zeroHash, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NFT_COLLECTION_ABI, NFT_FACTORY_ABI, NFT_MARKETPLACE_ABI, GUARDED_MARKETPLACE_ABI, prepareNftTerms, type createVerifiedRpc, type RpcReadMethod } from '@oneshot/evm';
import { parseManifest, manifestId } from '../../../indexer/src/manifest';
import { createNftLaunchRepository, NFT_REVIEW_NAMESPACE } from './nft-launch-store';
import { createNftLaunchProgressRepository } from './nft-launch-progress-store';
import { getRecord, putRecord } from './store';
import type { OneshotDraft } from '../../../web/lib/oneshot-draft-schema';
import type { OneshotSession } from './oneshot-auth';
import { ApiError } from './errors';
import { createNftLaunchService, nftReviewInput, type NftReview, type NftReviewInput } from './nft-launch';

const hash = (value: number): Hex => `0x${value.toString(16).padStart(64, '0')}`;
const address = (value: number): Address => `0x${value.toString(16).padStart(40, '0')}`;
const quantity = (value: bigint) => `0x${value.toString(16)}`;
const creator = address(10), other = address(20), collection = address(30), factory = address(40), marketplace = address(50), treasury = address(60);
const bytecode = '0x6001600055' as Hex;
const initialTime = BigInt(Date.parse('2030-01-01T00:00:00Z') / 1000);
const draftId = '10000000-0000-4000-8000-000000000001';
const session: OneshotSession = { provider: 'privy', userId: 'did:privy:creator', sessionId: 'session-one', expiresAt: 9_999_999_999, linkedAddresses: [creator, other] };
const manifest = parseManifest({ schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', mode: 'local', chainId: 31337,
  genesisHash: hash(100), startBlock: '1', anchorHash: hash(100), factory: { address: factory, codeHash: keccak256(bytecode) }, marketplace: { address: marketplace, codeHash: keccak256(bytecode) } });
const testRoot=path.resolve('.local/nft-launch-unit-tests');
const authorityKey=hash(555),authority=privateKeyToAccount(authorityKey).address.toLowerCase() as Address;
const guardedManifest=parseManifest({...JSON.parse(JSON.stringify({...manifest,startBlock:'1'})),deploymentVersion:'oneshot-nft-v2',listingAuthorization:{authority,salt:hash(333)}});
let directory:string;
beforeEach(async()=>{
  await mkdir(testRoot,{recursive:true}); directory=await mkdtemp(path.join(testRoot,'case-'));
  vi.stubEnv('NODE_ENV','test'); vi.stubEnv('DATABASE_URL',''); vi.stubEnv('ONESHOT_DATA_DIR',directory);
});

describe('public checkout without creator account access',()=>{
  const visitor:OneshotSession={...session,userId:'did:privy:visitor',sessionId:'visitor-session',linkedAddresses:[other]};
  const request=(changes:Partial<NftReviewInput>={}):NftReviewInput=>({from:other,collection,action:'mint',quantity:'1',localEthAcknowledged:true,...changes});
  it('reads exact frozen collection data without loading a private draft or exposing allowlist members',async()=>{
    const test=fixture();
    const info=await test.service.collection(collection);
    expect(info).toMatchObject({collection,creator,name:'Originals',symbol:'SHOT',opened:true,totalMintedRaw:'0',terms:{maxSupplyRaw:'10',royaltyBps:500,publicMint:{priceRaw:'123456789012345678'}}});
    expect(test.getDraft).not.toHaveBeenCalled();expect(test.verifySnapshot).not.toHaveBeenCalled();
    for(const hidden of ['allowlistAddresses','ownerUserId','did:privy:',draftId])expect(JSON.stringify(info)).not.toContain(hidden);
  });
  it('allows a different signed-in user to mint from on-chain public terms',async()=>{
    const test=fixture();test.state.chainTime+=86_400n;
    const reviewed=await test.service.review(request({quantity:'2'}),visitor);
    expect(reviewed).toMatchObject({scope:'public',draftId:collection,revision:0,from:other,value:'246913578024691356',summary:{stage:'public',quantity:'2',recipient:other}});
    expect(decodeFunctionData({abi:NFT_COLLECTION_ABI,data:reviewed.data})).toMatchObject({functionName:'mint',args:[2n,other,246913578024691356n,[]]});
    expect(test.getDraft).not.toHaveBeenCalled();expect(test.verifySnapshot).not.toHaveBeenCalled();
    await expect(test.service.review(request({draftId,expectedRevision:2}),visitor)).rejects.toMatchObject({code:'NOT_FOUND'});
  });
  it('keeps public actions bound to linked wallets, opened collections, and valid phases',async()=>{
    const test=fixture();
    await expect(test.service.review(request({from:creator}),visitor)).rejects.toMatchObject({code:'WALLET_NOT_LINKED'});
    await expect(test.service.review(request(),visitor)).rejects.toMatchObject({code:'NO_ACTIVE_STAGE'});
    test.state.opened=false;
    await expect(test.service.review(request(),visitor)).rejects.toMatchObject({code:'NOT_OPEN'});
    test.state.opened=true;test.state.registered=false;
    await expect(test.service.collection(collection)).rejects.toMatchObject({code:'UNKNOWN_COLLECTION'});
    expect(nftReviewInput.safeParse(request({action:'open'})).success).toBe(false);
    expect(nftReviewInput.safeParse(request({expectedRevision:2})).success).toBe(false);
  });
  it('serves only the selected linked wallet proof and refuses missing or mismatched allowlist material',async()=>{
    const test=fixture();
    test.state.draft.allowlistAddresses=[creator,other,address(777)];
    test.state.draft.allowlistStart=new Date(Number(initialTime+10n)*1000).toISOString();
    test.state.draft.allowlistEnd=new Date(Number(initialTime+100n)*1000).toISOString();
    test.state.draft.allowlistPrice='0.000000000000000001';test.state.chainTime+=20n;
    await expect(test.service.review(request(),visitor)).rejects.toMatchObject({code:'PROOF_UNAVAILABLE'});
    const plan=prepareNftTerms(test.state.draft,{chainId:31337,nativeDecimals:18,collection,nowSeconds:0n});
    const repository=createNftLaunchRepository(),deploymentId=manifestId(manifest);
    await repository.publish(`${deploymentId}:${collection}`,{deploymentId,collection,draft:test.state.draft,termsHash:plan.termsHash,openHash:hash(1000),blockHash:hash(109),blockNumber:'9'});
    const reviewed=await test.service.review(request(),visitor);
    expect(reviewed).toMatchObject({value:'1',summary:{stage:'allowlist'}});
    expect(decodeFunctionData({abi:NFT_COLLECTION_ABI,data:reviewed.data})).toMatchObject({args:[1n,other,1n,plan.allowlist.proofs[other]]});
    expect(JSON.stringify(reviewed)).not.toContain(address(777));expect(JSON.stringify(reviewed)).not.toContain('allowlistAddresses');
    await expect(test.service.review(request({from:address(888)}),{...visitor,linkedAddresses:[address(888)]})).rejects.toMatchObject({code:'NOT_ALLOWLISTED'});
    test.state.onchainTerms={...plan.terms,allowlistRoot:hash(666)};
    await expect(test.service.review(request(),visitor)).rejects.toMatchObject({code:'PROOF_UNAVAILABLE'});
  });
  it('rejects changed public listing prices before a second wallet prompt',async()=>{
    const test=fixture();test.state.listingSeller=creator;
    const reviewed=await test.service.review(request({action:'buy',listingId:'1'}),visitor);
    expect(reviewed.value).toBe(test.state.listingPrice.toString());
    test.state.listingPrice+=1n;
    await expect(test.service.validate(reviewed.id,reviewed.reviewHash,visitor)).rejects.toMatchObject({code:'REVIEW_CHANGED'});
  });
});

describe('durable review service recovery',()=>{
  it('loads an unsigned review in a new service instance and recovers a broadcast after signing expiry and re-login',async()=>{
    const test=fixture(),reviewed=await test.service.review(test.input(),session);
    const second=createNftLaunchService(test.dependencies);
    await expect(second.validate(reviewed.id,reviewed.reviewHash,session)).resolves.toMatchObject({id:reviewed.id});
    const hash=test.mined(reviewed);
    await second.submitted(reviewed.id,reviewed.reviewHash,hash,session);
    await expect(second.validate(reviewed.id,reviewed.reviewHash,session)).rejects.toMatchObject({code:'ALREADY_SUBMITTED'});
    test.state.now+=120_001;
    const renewed={...session,sessionId:'new-session'},third=createNftLaunchService(test.dependencies);
    expect(await third.recover(reviewed.id,renewed)).toMatchObject({transactionHash:hash,outcome:'submitted'});
    await expect(third.receipt(reviewed.id,hash,renewed)).resolves.toMatchObject({status:'confirmed'});
    expect(await third.transactions(renewed)).toMatchObject({items:[{review:{id:reviewed.id},transactionHash:hash,outcome:'confirmed'}]});
    await expect(third.recover(reviewed.id,{...renewed,userId:'did:privy:foreign'})).rejects.toMatchObject({code:'REVIEW_NOT_FOUND'});
    await expect(third.recover(reviewed.id,{...renewed,linkedAddresses:[other]})).rejects.toMatchObject({code:'WALLET_NOT_LINKED'});
  });
  it('detects saved call corruption before receipt polling or exposing recovery data',async()=>{
    const test=fixture(),reviewed=await test.service.review(test.input(),session);
    const saved=await getRecord(NFT_REVIEW_NAMESPACE,reviewed.id);saved.review.value='1';
    await putRecord(NFT_REVIEW_NAMESPACE,reviewed.id,saved);
    await expect(test.service.recover(reviewed.id,session)).rejects.toMatchObject({code:'TRANSACTION_INTEGRITY'});
    await expect(test.service.receipt(reviewed.id,hash(900),session)).rejects.toMatchObject({code:'TRANSACTION_INTEGRITY'});
  });
  it('downgrades a stored confirmation when its transaction disappears from the canonical chain',async()=>{
    const test=fixture(),reviewed=await test.service.review(test.input(),session),hash=test.mined(reviewed);
    await test.service.receipt(reviewed.id,hash,session);
    expect(await test.service.recover(reviewed.id,session)).toMatchObject({outcome:'confirmed'});
    test.state.transaction=null;
    await expect(test.service.receipt(reviewed.id,hash,session)).resolves.toMatchObject({status:'pending'});
    expect(await createNftLaunchService(test.dependencies).recover(reviewed.id,session)).toMatchObject({transactionHash:hash,outcome:'submitted'});
  });
});
afterEach(async()=>{
  vi.unstubAllEnvs();
  if (!path.resolve(directory).startsWith(testRoot+path.sep)) throw new Error('Unsafe launch test cleanup.');
  await rm(directory,{recursive:true,force:true});
});

describe('private protected minimum on the guarded marketplace',()=>{
  const policyInput=(enabled=true,price='5'):NftReviewInput=>({from:creator,collection,action:'policy',floorEnabled:enabled,floorPrice:price,localEthAcknowledged:true});
  async function enable(test:ReturnType<typeof fixture>,price='5') {
    const reviewed=await test.service.review(policyInput(true,price),session);
    const before=reviewed.data;test.state.chainTime+=1n;
    expect((await test.service.validate(reviewed.id,reviewed.reviewHash,session)).data).toBe(before);
    const decoded=decodeFunctionData({abi:GUARDED_MARKETPLACE_ABI,data:reviewed.data});
    expect(decoded.functionName).toBe('setPolicyCommitment');
    test.state.policyCommitment=decoded.args![1] as Hex;
    return reviewed;
  }
  it('only exposes settings to the actual linked creator on v2, including before mint opens',async()=>{
    const test=fixture({},true);test.state.opened=false;
    expect(await test.service.floor(collection,creator,session)).toMatchObject({eligible:true,enabled:false,floorRaw:'0',guarded:true});
    await expect(test.service.floor(collection,other,session)).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(test.service.floor(collection,creator,{...session,linkedAddresses:[other]})).rejects.toMatchObject({code:'WALLET_NOT_LINKED'});
    await expect(fixture().service.floor(collection,creator,session)).rejects.toMatchObject({code:'NOT_FOUND'});
    test.env.ONESHOT_FLOOR_CREATORS='';
    await expect(test.service.floor(collection,creator,session)).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(test.service.review(policyInput(),session)).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(test.service.review({...policyInput(),from:other},session)).rejects.toMatchObject({code:'NOT_FOUND'});
  });
  it('applies exact below/equal/above arithmetic in public and owned listing paths and preserves quoted permits',async()=>{
    const test=fixture({},true);await enable(test);
    for(const [price,expected] of [['4','9'],['5','5'],['6','6'],['0','5'],['0.000000000000000001','5.000000000000000001']]) {
      for(const owned of [false,true]) {
        const request:NftReviewInput={from:creator,collection,tokenId:'1',action:'list',price,localEthAcknowledged:true,...(owned?{draftId,expectedRevision:2}:{})};
        const reviewed=await test.service.review(request,session),decoded=decodeFunctionData({abi:GUARDED_MARKETPLACE_ABI,data:reviewed.data});
        const raw=(text:string)=>{const [whole,fraction='']=text.split('.');return BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,'0'));};
        expect(decoded.functionName).toBe('listAuthorized');expect(decoded.args!.slice(0,5)).toEqual([collection,1n,raw(expected),0n,test.state.policyCommitment]);
        expect(reviewed.summary).toMatchObject({enteredPriceRaw:raw(price).toString(),floorPriceRaw:(5n*10n**18n).toString(),priceRaw:raw(expected).toString()});
        test.state.chainTime+=1n;
        expect((await test.service.validate(reviewed.id,reviewed.reviewHash,session)).data).toBe(reviewed.data);
      }
    }
    const publicInfo=JSON.stringify(await test.service.collection(collection));
    for(const hidden of ['floorRaw','floorPriceRaw','policyCommitment','eligible',authorityKey])expect(publicInfo).not.toContain(hidden);
  });
  it('invalidates old quotes after a policy change, nonce consumption or chain-time expiry',async()=>{
    const test=fixture({},true);await enable(test);
    const request:NftReviewInput={from:creator,collection,tokenId:'1',action:'list',price:'4',localEthAcknowledged:true};
    const reviewed=await test.service.review(request,session),original=test.state.policyCommitment;
    test.state.policyCommitment=zeroHash;
    await expect(test.service.validate(reviewed.id,reviewed.reviewHash,session)).rejects.toMatchObject({code:'REVIEW_CHANGED'});
    test.state.policyCommitment=original;test.state.listingNonce=1n;
    await expect(test.service.validate(reviewed.id,reviewed.reviewHash,session)).rejects.toMatchObject({code:'REVIEW_CHANGED'});
    test.state.listingNonce=0n;test.state.chainTime+=121n;
    await expect(test.service.validate(reviewed.id,reviewed.reviewHash,session)).rejects.toMatchObject({code:'REVIEW_EXPIRED'});
  });
  it('keeps existing protection after eligibility removal and permits only disabling',async()=>{
    const test=fixture({},true);await enable(test);test.env.ONESHOT_FLOOR_CREATORS='';
    expect(await test.service.floor(collection,creator,session)).toMatchObject({eligible:false,enabled:true,floorRaw:(5n*10n**18n).toString()});
    const reviewed=await test.service.review({from:creator,collection,tokenId:'1',action:'list',price:'4',localEthAcknowledged:true},session);
    expect(reviewed.summary.priceRaw).toBe((9n*10n**18n).toString());
    await expect(test.service.review(policyInput(true,'6'),session)).rejects.toMatchObject({code:'NOT_FOUND'});
    const disabled=await test.service.review(policyInput(false,'0'),session);
    expect(disabled.summary).toMatchObject({floorEnabled:'false',floorPriceRaw:'0'});
  });
  it('fails guarded admission closed without the right authority but leaves existing orders usable',async()=>{
    const test=fixture({ONESHOT_LISTING_AUTHORITY_PRIVATE_KEY:undefined},true);
    await expect(test.service.review({from:creator,collection,tokenId:'1',action:'list',price:'4',localEthAcknowledged:true},session)).rejects.toMatchObject({code:'LISTING_AUTHORITY_UNAVAILABLE'});
    await expect(test.service.review(policyInput(),session)).rejects.toMatchObject({code:'LISTING_AUTHORITY_UNAVAILABLE'});
    expect((await test.service.review({from:creator,collection,listingId:'1',action:'buy',localEthAcknowledged:true},session)).value).toBe(test.state.listingPrice.toString());
    expect(nftReviewInput.safeParse({...policyInput(),draftId,expectedRevision:2}).success).toBe(false);
    expect(nftReviewInput.safeParse({...policyInput(),action:'list'}).success).toBe(false);
  });
  it('validates an already signed settings permit if the authority key later becomes unavailable',async()=>{
    const test=fixture({},true),reviewed=await test.service.review(policyInput(),session);
    test.env.ONESHOT_LISTING_AUTHORITY_PRIVATE_KEY=undefined;
    expect((await test.service.validate(reviewed.id,reviewed.reviewHash,session)).data).toBe(reviewed.data);
    await expect(test.service.review(policyInput(),session)).rejects.toMatchObject({code:'LISTING_AUTHORITY_UNAVAILABLE'});
  });
});

function fixture(environment: Record<string, string | undefined> = {}, guarded=false) {
  const selectedManifest=guarded?guardedManifest:manifest;
  const draft: OneshotDraft = { id: draftId, ownerUserId: session.userId, revision: 2, status: 'prepared', createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z',
    name: 'Originals', symbol: 'SHOT', description: 'A prepared collection', maxSupply: 10, royaltyBps: 500, publicPrice: '0.123456789012345678', allowlistPrice: '0', perWalletLimit: 2,
    publicStart: '2030-01-02T00:00:00Z', publicEnd: '2030-01-03T00:00:00Z', allowlistAddresses: [], creatorWallet: creator, metadataMode: 'upload',
    snapshot: { manifestHash: 'ab'.repeat(32), contentHash: `0x${'ab'.repeat(32)}`, baseUri: `https://media.oneshot.app/api/oneshot/metadata/${'ab'.repeat(32)}/`, collectionUri: `https://media.oneshot.app/api/media/${'cd'.repeat(32)}.json`, itemCount: 10, preparedAt: '2030-01-01T00:00:00Z' } };
  const state = {
    draft, now: Number(initialTime * 1000n), chainTime: initialTime, head: 10n, code: bytecode,
    blockHashes: new Map<bigint, Hex>(), collectionCreator: creator, collectionName: draft.name, collectionSymbol: draft.symbol!, registered: true,
    onchainTerms: undefined as ReturnType<typeof prepareNftTerms>['terms'] | undefined, opened:true, minted:0n,
    listingPrice: 2_000_000_000_000_000_000n, listingActive: true, listingSeller: other,
    policyCommitment:zeroHash as Hex,listingNonce:0n,
    transaction: null as Record<string, unknown> | null, transactionReceipt: null as Record<string, unknown> | null,
  };
  const blockHash = (number: bigint) => state.blockHashes.get(number) ?? hash(Number(number) + 100);
  const readRpc = vi.fn(async (method: RpcReadMethod, params: readonly unknown[] = []): Promise<unknown> => {
    if (method === 'eth_getBlockByNumber') {
      const number = BigInt(params[0] as string);
      return { number: quantity(number), hash: blockHash(number), parentHash: hash(Number(number) + 99), timestamp: quantity(state.chainTime) };
    }
    if (method === 'eth_blockNumber') return quantity(state.head);
    if (method === 'eth_getCode') return state.code;
    if (method === 'eth_getTransactionByHash') return state.transaction;
    if (method === 'eth_getTransactionReceipt') return state.transactionReceipt;
    if (method !== 'eth_call') throw new Error(`Unexpected RPC method: ${method}`);
    const call = params[0] as { to: Address; data: Hex };
    const abi: Abi = call.to === factory ? NFT_FACTORY_ABI : call.to === marketplace ? (guarded?GUARDED_MARKETPLACE_ABI:NFT_MARKETPLACE_ABI) : NFT_COLLECTION_ABI;
    const { functionName } = decodeFunctionData({ abi, data: call.data });
    let result: unknown;
    switch (functionName) {
      case 'factory': result = factory; break;
      case 'listingAuthority': result = authority; break;
      case 'deploymentSalt': result = hash(333); break;
      case 'policyCommitment': result = state.policyCommitment; break;
      case 'listingNonces': result = state.listingNonce; break;
      case 'treasury': result = treasury; break;
      case 'isCollection': result = state.registered; break;
      case 'creator': result = state.collectionCreator; break;
      case 'name': result = state.collectionName; break;
      case 'symbol': result = state.collectionSymbol; break;
      case 'opened': result = state.opened; break;
      case 'totalMinted': result = state.minted; break;
      case 'terms': result = state.onchainTerms ?? prepareNftTerms(state.draft, { chainId: 31337, nativeDecimals: 18, collection, nowSeconds: 0n }).terms; break;
      case 'ownerOf': result = creator; break;
      case 'pending': result = 10n; break;
      case 'listings': result = [collection, state.listingSeller, 1n, state.listingPrice, state.listingActive]; break;
      default: throw new Error(`Unexpected contract read: ${functionName}`);
    }
    return encodeFunctionResult({ abi, functionName, result });
  });
  const simulateCall = vi.fn(async (_call: { from: string; to: string; data: string; value: string }, _block: { number: string; hash: string }) => ({ result: '0x', gasEstimate: '140000' }));
  const verified = { verification: { mode: 'local', chainId: 31337, genesisHash: manifest.genesisHash, latestBlock: 10n, checkedAt: '2030-01-01T00:00:00Z', provider: { label: 'custom', verifiedSupport: false }, genesisMatched: null }, readRpc, simulateCall } as Awaited<ReturnType<typeof createVerifiedRpc>>;
  const rpc = vi.fn(async () => verified);
  const loadManifest = vi.fn(async () => selectedManifest);
  const getDraft = vi.fn(async (_id: string, identity: OneshotSession) => {
    if (_id!==state.draft.id || identity.userId !== state.draft.ownerUserId || state.draft.status==='deleted') throw new ApiError(404, 'NOT_FOUND', 'Draft not found.');
    return structuredClone(state.draft);
  });
  const verifySnapshot = vi.fn(async (_draft: OneshotDraft): Promise<void> => undefined);
  const env:Record<string,string|undefined> = { ONESHOT_LOCAL_NFT_EXECUTION_ENABLED: 'true', ONESHOT_NETWORK: 'local', ONESHOT_LOCAL_RPC_URL: 'http://127.0.0.1:8545', ONESHOT_INDEXER_MANIFEST_PATH: 'test-local-manifest.json',ONESHOT_FLOOR_CREATORS:creator,ONESHOT_LISTING_AUTHORITY_PRIVATE_KEY:authorityKey, ...environment };
  const progressRepository=createNftLaunchProgressRepository();
  const dependencies={ environment: () => env, rpc, loadManifest, getDraft, verifySnapshot, now: () => state.now, progressRepository };
  const service = createNftLaunchService(dependencies);
  const input = (changes: Partial<NftReviewInput> = {}): NftReviewInput => ({ draftId, expectedRevision: 2, from: creator, action: 'create', localEthAcknowledged: true, ...changes });
  function mined(review: NftReview, blockNumber = 11n) {
    const txHash = hash(900);
    state.transaction = { hash: txHash, from: review.from, to: review.to, input: review.data, value: quantity(BigInt(review.value)), chainId: '0x7a69', blockNumber: quantity(blockNumber), blockHash: blockHash(blockNumber) };
    state.transactionReceipt = { transactionHash: txHash, blockNumber: quantity(blockNumber), blockHash: blockHash(blockNumber), status: '0x1', logs: [{ address: factory,
      topics: encodeEventTopics({ abi: NFT_FACTORY_ABI, eventName: 'CollectionCreated', args: { collection, creator } }),
      data: encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [state.draft.name, state.draft.symbol!]) }] };
    return txHash;
  }
  return { state, env, service, dependencies, progressRepository, rpc, verified, readRpc, simulateCall, loadManifest, getDraft, verifySnapshot, input, mined };
}

describe('resumable private creator launch progress',()=>{
  const selection=(launchId?:string)=>({expectedRevision:2,from:creator,...(launchId?{launchId}:{})});
  async function created(test:ReturnType<typeof fixture>) {
    const review=await test.service.review(test.input(),session),createHash=test.mined(review);
    test.state.head=11n;test.state.opened=false;
    await test.service.receipt(review.id,createHash,session);
    return {review,createHash};
  }
  it('persists a verified create once with original review time and restores it after review retention',async()=>{
    const test=fixture(),{review,createHash}=await created(test),saved=await test.progressRepository.get(review.id);
    expect(saved).toMatchObject({id:review.id,owner:session.userId,draftId,revision:2,deploymentId:manifestId(manifest),from:creator,collection,createHash,blockNumber:'11',blockHash:hash(111),createdAt:Number(initialTime)*1000});
    test.state.now+=1000;
    await test.service.receipt(review.id,createHash,session);
    expect(await test.progressRepository.get(review.id)).toEqual(saved);
    test.state.now+=31*86_400_000;
    await expect(test.service.recover(review.id,session)).rejects.toMatchObject({code:'REVIEW_NOT_FOUND'});
    const restarted=createNftLaunchService(test.dependencies);
    const result=await restarted.progress(draftId,selection(review.id),{...session,sessionId:'renewed-session'});
    expect(result.selected).toMatchObject({id:review.id,collection,phase:'configured',nextAction:'open',termsMatch:true});
    expect(result.items).toEqual([{id:review.id,collection,createHash,createdAt:new Date(Number(initialTime)*1000).toISOString()}]);
    for(const hidden of ['owner','allowlistAddresses','snapshot','floorRaw','sessionId','privateKey','did:privy:']) expect(JSON.stringify(result)).not.toContain(hidden);
  });
  it('requires explicit selection even with one saved collection and performs no writes or simulations in progress',async()=>{
    const test=fixture(),{review}=await created(test),save=vi.spyOn(test.progressRepository,'save');
    test.simulateCall.mockClear();
    const initial=await test.service.progress(draftId,selection(),session);
    expect(initial.selected).toBeNull();expect(initial.items).toHaveLength(1);
    expect((await test.service.progress(draftId,selection(review.id),session)).selected?.phase).toBe('configured');
    expect(save).not.toHaveBeenCalled();expect(test.simulateCall).not.toHaveBeenCalled();
  });
  it('offers only retained unassociated create broadcasts as pending recovery candidates',async()=>{
    const test=fixture(),review=await test.service.review(test.input(),session),createHash=hash(900);
    await test.service.submitted(review.id,review.reviewHash,createHash,session);
    const result=await test.service.progress(draftId,selection(),session);
    expect(result).toMatchObject({items:[],selected:null,pending:[{reviewId:review.id,hash:createHash}]});
    test.mined(review);test.state.head=11n;
    await test.service.receipt(review.id,createHash,session);
    expect((await test.service.progress(draftId,selection(),session)).pending).toEqual([]);
  });
  it.each(['account','unlinked','creator','revision','unprepared','snapshot','expired'] as const)('checks %s before initializing chain access',async mode=>{
    const test=fixture();let identity=session;let input=selection();
    if(mode==='account')identity={...session,userId:'did:privy:foreign'};
    if(mode==='unlinked')identity={...session,linkedAddresses:[other]};
    if(mode==='creator')input={...input,from:other};
    if(mode==='revision')input={...input,expectedRevision:3};
    if(mode==='unprepared')test.state.draft.status='draft';
    if(mode==='snapshot')test.state.draft.snapshot=undefined;
    if(mode==='expired')identity={...session,expiresAt:Number(initialTime)};
    await expect(test.service.progress(draftId,input,identity)).rejects.toBeDefined();
    expect(test.loadManifest).not.toHaveBeenCalled();expect(test.rpc).not.toHaveBeenCalled();
  });
  it('does not reveal an association through another draft, revision, creator or deployment',async()=>{
    const test=fixture(),{review}=await created(test);
    const variants=[{id:'10000000-0000-4000-8000-000000000002'}, {revision:3}, {creatorWallet:other}];
    for(const fields of variants) {
      const original=structuredClone(test.state.draft);Object.assign(test.state.draft,fields);
      const from=test.state.draft.creatorWallet!,revision=test.state.draft.revision;
      await expect(test.service.progress(test.state.draft.id,{expectedRevision:revision,from,launchId:review.id},session)).rejects.toMatchObject({code:'LAUNCH_NOT_FOUND'});
      Object.assign(test.state.draft,original);
    }
    test.loadManifest.mockResolvedValue({...manifest,startBlock:2n,anchorHash:hash(101)});
    const none=await test.service.progress(draftId,selection(),session);
    expect(none.items).toEqual([]);
    await expect(test.service.progress(draftId,selection(review.id),session)).rejects.toMatchObject({code:'LAUNCH_NOT_FOUND'});
  });
  it('derives created/configured/opened from exact current terms, and blocks expired unopened schedules',async()=>{
    const test=fixture(),{review}=await created(test),plan=prepareNftTerms(test.state.draft,{chainId:31337,nativeDecimals:18,collection,nowSeconds:0n});
    test.state.onchainTerms={...plan.terms,maxSupply:0n};
    expect((await test.service.progress(draftId,selection(review.id),session)).selected).toMatchObject({phase:'created',nextAction:'configure',termsMatch:false});
    test.state.onchainTerms=plan.terms;
    expect((await test.service.progress(draftId,selection(review.id),session)).selected).toMatchObject({phase:'configured',nextAction:'open',termsMatch:true});
    test.state.chainTime=plan.summary.firstStart+1n;
    expect((await test.service.progress(draftId,selection(review.id),session)).selected).toMatchObject({phase:'schedule-expired',nextAction:null,termsMatch:true});
    test.state.opened=true;
    expect((await test.service.progress(draftId,selection(review.id),session)).selected).toMatchObject({phase:'opened',nextAction:null,termsMatch:true});
  });
  it.each(['identity','factory','terms','event','transaction'] as const)('does not unlock steps when canonical %s differs from the saved launch',async field=>{
    const test=fixture(),{review}=await created(test);
    if(field==='identity')test.state.collectionName='Another collection';
    if(field==='factory')test.state.registered=false;
    if(field==='terms'){test.state.opened=true;test.state.onchainTerms={...prepareNftTerms(test.state.draft,{chainId:31337,nativeDecimals:18,collection,nowSeconds:0n}).terms,contentHash:hash(999)};}
    if(field==='event')test.state.transactionReceipt!.logs=[];
    if(field==='transaction')test.state.transaction!.from=other;
    expect((await test.service.progress(draftId,selection(review.id),session)).selected).toMatchObject({phase:'mismatch',nextAction:null});
  });
  it('reports missing receipts as pending and never changes the permanent association in GET progress',async()=>{
    const test=fixture(),{review}=await created(test),save=vi.spyOn(test.progressRepository,'save');
    test.state.transactionReceipt=null;
    expect((await test.service.progress(draftId,selection(review.id),session)).selected).toMatchObject({phase:'pending',nextAction:null});
    expect(save).not.toHaveBeenCalled();
  });
  it('marks orphaned creations read-only and repairs provenance only through explicit canonical receipt reconciliation',async()=>{
    const test=fixture(),{review,createHash}=await created(test),previous=await test.progressRepository.get(review.id);
    test.state.blockHashes.set(11n,hash(999));test.state.head=12n;
    const save=vi.spyOn(test.progressRepository,'save');
    expect((await test.service.progress(draftId,selection(review.id),session)).selected).toMatchObject({phase:'orphaned',nextAction:null});
    expect(save).not.toHaveBeenCalled();
    test.mined(review,12n);
    await test.service.receipt(review.id,createHash,session);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({blockNumber:'12',blockHash:hash(112)}),previous);
    expect((await test.service.progress(draftId,selection(review.id),session)).selected?.phase).toBe('configured');
  });
  it('refuses replacement provenance while the prior creation block remains canonical',async()=>{
    const test=fixture(),{review,createHash}=await created(test),previous=await test.progressRepository.get(review.id);
    test.mined(review,12n);test.state.head=12n;
    await expect(test.service.receipt(review.id,createHash,session)).rejects.toMatchObject({code:'LAUNCH_ASSOCIATION_CHANGED'});
    expect(await test.progressRepository.get(review.id)).toEqual(previous);
  });
  it('reconciles the same create hash below the original review height only after its simulation was orphaned',async()=>{
    const test=fixture(),{review,createHash}=await created(test),previous=await test.progressRepository.get(review.id);
    test.state.head=9n;test.mined(review,9n);
    const save=vi.spyOn(test.progressRepository,'save');
    await expect(test.service.receipt(review.id,createHash,session)).resolves.toMatchObject({status:'confirmed',blockNumber:'9',collection});
    expect(save).toHaveBeenCalledWith(expect.objectContaining({blockNumber:'9',createHash}),previous);
    expect((await test.service.progress(draftId,selection(review.id),session)).selected).toMatchObject({phase:'configured',blockNumber:'9'});
  });
  it('does not treat a failed prior-block lookup as proof allowing association replacement',async()=>{
    const test=fixture(),{review,createHash}=await created(test),previous=await test.progressRepository.get(review.id);
    test.mined(review,12n);test.state.head=12n;
    const original=test.readRpc.getMockImplementation()!;
    test.readRpc.mockImplementation(async(method,params=[])=>{if(method==='eth_getBlockByNumber'&&params[0]==='0xb')throw new Error('old block unavailable');return original(method,params);});
    await expect(test.service.receipt(review.id,createHash,session)).rejects.toThrow('old block unavailable');
    expect(await test.progressRepository.get(review.id)).toEqual(previous);
  });
  it('rechecks the captured canonical checkpoint after reading current terms',async()=>{
    const test=fixture(),{review}=await created(test),original=test.readRpc.getMockImplementation()!;
    test.readRpc.mockImplementation(async(method,params=[])=>{
      const value=await original(method,params);
      if(method==='eth_call') {
        const call=params[0] as {to:Address;data:Hex};
        if(call.to===collection && decodeFunctionData({abi:NFT_COLLECTION_ABI,data:call.data}).functionName==='terms')test.state.blockHashes.set(11n,hash(999));
      }
      return value;
    });
    await expect(test.service.progress(draftId,selection(review.id),session)).rejects.toMatchObject({code:'CHAIN_MOVED'});
  });
});

describe('local NFT transaction review boundary', () => {
  it.each([{ ONESHOT_NETWORK: 'zero' }, { ONESHOT_NETWORK: undefined }, { ONESHOT_LOCAL_NFT_EXECUTION_ENABLED: undefined }, { ONESHOT_LOCAL_NFT_EXECUTION_ENABLED: 'false' }])('keeps execution closed without the exact local opt-in: %j', async override => {
    const test = fixture(override);
    expect(await test.service.status()).toMatchObject({ enabled: false, network: null });
    await expect(test.service.review(test.input(), session)).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    expect(test.loadManifest).not.toHaveBeenCalled(); expect(test.rpc).not.toHaveBeenCalled(); expect(test.getDraft).not.toHaveBeenCalled(); expect(test.verifySnapshot).not.toHaveBeenCalled();
  });
  it('requires explicit Local ETH acknowledgement and rejects caller-supplied calldata/value', async () => {
    const test = fixture();
    await expect(test.service.review({ ...test.input(), localEthAcknowledged: false }, session)).rejects.toThrow();
    await expect(test.service.review({ ...test.input(), data: '0x1234', value: '1', to: other }, session)).rejects.toThrow();
    expect(test.getDraft).not.toHaveBeenCalled(); expect(test.rpc).not.toHaveBeenCalled();
  });
  it('returns validation issues for malformed integer fields instead of throwing conversion errors', () => {
    const test = fixture();
    for (const field of ['tokenId', 'listingId', 'quantity']) {
      for (const value of ['abc', '1.5', '-1', '0', '0x1', (1n << 256n).toString()]) {
        expect(nftReviewInput.safeParse({ ...test.input(), [field]: value }).success).toBe(false);
      }
    }
  });
  it('rejects expired sessions and unlinked senders before accessing account drafts', async () => {
    const test = fixture();
    await expect(test.service.review(test.input(), { ...session, expiresAt: test.state.now / 1000 })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(test.service.review(test.input({ from: address(999) }), session)).rejects.toMatchObject({ code: 'WALLET_NOT_LINKED' });
    expect(test.getDraft).not.toHaveBeenCalled();
  });
  it('binds creator actions to the saved creator even when another wallet is linked', async () => {
    const test = fixture();
    await expect(test.service.review(test.input({ from: other }), session)).rejects.toMatchObject({ code: 'CREATOR_REQUIRED' });
    expect(test.simulateCall).not.toHaveBeenCalled();
  });
  it('rejects revised drafts and failed stored snapshot verification before simulation', async () => {
    const test = fixture();
    await expect(test.service.review(test.input({ expectedRevision: 1 }), session)).rejects.toMatchObject({ code: 'DRAFT_CHANGED' });
    expect(test.verifySnapshot).not.toHaveBeenCalled();
    test.verifySnapshot.mockRejectedValue(new ApiError(503, 'CONTENT_INTEGRITY', 'Stored metadata failed its content check.'));
    await expect(test.service.review(test.input(), session)).rejects.toMatchObject({ code: 'CONTENT_INTEGRITY' });
    expect(test.verifySnapshot).toHaveBeenCalledWith(test.state.draft);
    expect(test.simulateCall).not.toHaveBeenCalled();
  });
  it('rejects missing symbols, unprepared status and inconsistent snapshot supply without simulation', async () => {
    const test = fixture();
    test.state.draft.symbol = undefined;
    await expect(test.service.review(test.input(), session)).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
    test.state.draft.symbol = 'SHOT'; test.state.draft.status = 'draft';
    await expect(test.service.review(test.input(), session)).rejects.toMatchObject({ code: 'DRAFT_NOT_PREPARED' });
    test.state.draft.status = 'prepared'; test.state.draft.snapshot!.itemCount = 9;
    await expect(test.service.review(test.input(), session)).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    expect(test.simulateCall).not.toHaveBeenCalled();
  });
  it('redacts deployment verification failures and refuses a code-hash mismatch', async () => {
    const test = fixture(); test.state.code = '0x00';
    await expect(test.service.review(test.input(), session)).rejects.toMatchObject({ code: 'DEPLOYMENT_UNAVAILABLE' });
    expect(test.simulateCall).not.toHaveBeenCalled();
    test.loadManifest.mockRejectedValue(new Error('private-key-in-manifest-path'));
    const status = await test.service.status();
    expect(JSON.stringify(status)).not.toContain('private-key'); expect(status.enabled).toBe(false);
  });
  it('derives and simulates only the verified factory call with zero value', async () => {
    const test = fixture(); const review = await test.service.review(test.input(), session);
    expect(review).toMatchObject({ chainId: 31337, from: creator, to: factory, value: '0', revision: 2, action: 'create', network: { mode: 'local', nativeSymbol: 'ETH', nativeDecimals: 18 }, simulation: { blockNumber: '10', blockHash: hash(110), gasEstimate: '140000' } });
    expect(decodeFunctionData({ abi: NFT_FACTORY_ABI, data: review.data })).toMatchObject({ functionName: 'createCollection', args: ['Originals', 'SHOT'] });
    expect(test.simulateCall).toHaveBeenCalledWith({ from: creator, to: factory, data: review.data, value: '0x0' }, { number: '0xa', hash: hash(110) });
    expect(test.readRpc.mock.calls.every(([method]) => !String(method).startsWith('eth_send'))).toBe(true);
  });
  it('binds exact 18-decimal mint totals and calldata to the reviewed recipient', async () => {
    const test = fixture(); test.state.chainTime = BigInt(Date.parse('2030-01-02T00:00:01Z') / 1000);
    const review = await test.service.review(test.input({ action: 'mint', collection, quantity: '2', recipient: other }), session);
    expect(review.value).toBe('246913578024691356');
    expect(decodeFunctionData({ abi: NFT_COLLECTION_ABI, data: review.data })).toMatchObject({ functionName: 'mint', args: [2n, other, 246913578024691356n, []] });
    expect(test.simulateCall.mock.calls[0][0].value).toBe(quantity(246913578024691356n));
    const pinnedReads = test.readRpc.mock.calls.filter(([method, params]) => method === 'eth_call' && typeof params?.[1] === 'object');
    expect(pinnedReads.length).toBeGreaterThan(0);
    expect(pinnedReads.every(([, params]) => JSON.stringify(params?.[1]) === JSON.stringify({ blockHash: hash(110), requireCanonical: true }))).toBe(true);
  });
  it('rejects an unregistered collection and changed onchain terms', async () => {
    const test = fixture(); test.state.registered = false;
    await expect(test.service.review(test.input({ action: 'configure', collection }), session)).rejects.toMatchObject({ code: 'UNKNOWN_COLLECTION' });
    test.state.registered = true;
    test.state.onchainTerms = { ...prepareNftTerms(test.state.draft, { chainId: 31337, nativeDecimals: 18, collection, nowSeconds: 0n }).terms, royaltyBps: 0 };
    await expect(test.service.review(test.input({ action: 'open', collection }), session)).rejects.toMatchObject({ code: 'TERMS_CHANGED' });
    expect(test.simulateCall).not.toHaveBeenCalled();
  });
  it('refuses a draft revision changed during simulation and a reorged simulated block', async () => {
    const changed = fixture(); changed.simulateCall.mockImplementation(async () => { changed.state.draft.revision++; return { result: '0x', gasEstimate: '140000' }; });
    await expect(changed.service.review(changed.input(), session)).rejects.toMatchObject({ code: 'DRAFT_CHANGED' });
    const reorged = fixture(); reorged.simulateCall.mockImplementation(async () => { reorged.state.blockHashes.set(10n, hash(777)); return { result: '0x', gasEstimate: '140000' }; });
    await expect(reorged.service.review(reorged.input(), session)).rejects.toMatchObject({ code: 'CHAIN_MOVED' });
  });
  it('rejects a session that expires during simulation and redacts simulation failures', async () => {
    const expired = fixture();
    expired.simulateCall.mockImplementation(async () => { expired.state.now += 2000; return { result: '0x', gasEstimate: '140000' }; });
    await expect(expired.service.review(expired.input(), { ...session, expiresAt: Number(initialTime) + 1 })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const failed = fixture(); failed.simulateCall.mockRejectedValue(new Error('private-rpc-provider-secret'));
    await expect(failed.service.review(failed.input(), session)).rejects.toMatchObject({ code: 'SIMULATION_FAILED' });
    try { await failed.service.review(failed.input(), session); } catch (error) { expect(String(error)).not.toContain('provider-secret'); }
  });
  it('scopes validation to the exact user, Privy session, linked sender and review hash', async () => {
    const test = fixture(); const review = await test.service.review(test.input(), session);
    for (const identity of [{ ...session, userId: 'did:privy:other' }, { ...session, sessionId: 'new-session' }]) await expect(test.service.validate(review.id, review.reviewHash, identity)).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
    await expect(test.service.validate(review.id, hash(123), session)).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
    await expect(test.service.validate(review.id, review.reviewHash, { ...session, linkedAddresses: [other] })).rejects.toMatchObject({ code: 'WALLET_NOT_LINKED' });
    const calls = test.simulateCall.mock.calls.length;
    test.state.now += 120_000;
    await expect(test.service.validate(review.id, review.reviewHash, session)).rejects.toMatchObject({ code: 'REVIEW_EXPIRED' });
    expect(test.simulateCall).toHaveBeenCalledTimes(calls);
  });
  it('resimulates validation and rejects a changed listing price instead of refreshing its value silently', async () => {
    const test = fixture(); const review = await test.service.review(test.input({ action: 'buy', collection, listingId: '1', recipient: creator }), session);
    expect(review.value).toBe('2000000000000000000');
    await expect(test.service.validate(review.id, review.reviewHash, session)).resolves.toMatchObject({ id: review.id, value: review.value });
    test.state.listingPrice += 1n;
    await expect(test.service.validate(review.id, review.reviewHash, session)).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
  });
});

describe('reviewed local NFT receipts', () => {
  function guardedMined(test:ReturnType<typeof fixture>,review:NftReview,blockNumber:bigint) {
    const transactionHash=test.mined(review,blockNumber);
    const policy=review.action==='policy';
    test.state.transactionReceipt!.logs=[{
      address:marketplace,
      topics:policy?encodeEventTopics({abi:GUARDED_MARKETPLACE_ABI,eventName:'PolicyCommitted',args:{
        collection,previousCommitment:review.summary.previousCommitment as Hex,commitment:review.summary.policyCommitment as Hex,
      }}):encodeEventTopics({abi:GUARDED_MARKETPLACE_ABI,eventName:'Listed',args:{listingId:1n,collection,tokenId:1n}}),
      data:policy?'0x':encodeAbiParameters([{type:'address'},{type:'uint256'}],[review.from,BigInt(review.summary.priceRaw)]),
    }];
    return transactionHash;
  }
  const guardedInput=(action:'policy'|'list'):NftReviewInput=>({from:creator,collection,action,localEthAcknowledged:true,
    ...(action==='policy'?{floorEnabled:true,floorPrice:'5'}:{tokenId:'1',price:'4'})});

  it.each(['policy','list'] as const)('recovers an exact guarded %s receipt at or below an orphaned simulation height',async action=>{
    for(const height of [9n,10n]) {
      const test=fixture({},true),review=await test.service.review(guardedInput(action),session);
      test.state.blockHashes.set(10n,hash(777));
      const transactionHash=guardedMined(test,review,height);
      await expect(test.service.receipt(review.id,transactionHash,session)).resolves.toMatchObject({status:'confirmed',blockNumber:height.toString()});
      expect(await test.service.recover(review.id,session)).toMatchObject({outcome:'confirmed',transactionHash});
    }
  });

  it.each(['policy','list'] as const)('rejects an old guarded %s receipt while the simulation block remains canonical',async action=>{
    for(const height of [9n,10n]) {
      const test=fixture({},true),review=await test.service.review(guardedInput(action),session);
      const transactionHash=guardedMined(test,review,height);
      await expect(test.service.receipt(review.id,transactionHash,session)).rejects.toMatchObject({code:'RECEIPT_TOO_OLD'});
      expect(await test.service.recover(review.id,session)).toMatchObject({outcome:'submitted'});
    }
  });

  it.each(['policy','list'] as const)('does not treat an RPC failure as proof that a guarded %s simulation was orphaned',async action=>{
    const test=fixture({},true),review=await test.service.review(guardedInput(action),session);
    const transactionHash=guardedMined(test,review,9n);
    test.state.head=11n;
    const original=test.readRpc.getMockImplementation()!;
    test.readRpc.mockImplementation(async(method,params=[])=>{
      if(method==='eth_getBlockByNumber'&&params[0]==='0xa')throw new Error('simulation block unavailable');
      return original(method,params);
    });
    await expect(test.service.receipt(review.id,transactionHash,session)).rejects.toThrow('simulation block unavailable');
    expect(await test.service.recover(review.id,session)).toMatchObject({outcome:'submitted'});
  });

  it('tracks pending, reverted and canonical confirmed transactions after signing review expiry', async () => {
    const test = fixture(); const review = await test.service.review(test.input(), session); const txHash = hash(900);
    await expect(test.service.receipt(review.id, txHash, session)).resolves.toMatchObject({ status: 'pending', hash: txHash });
    test.mined(review); test.state.transactionReceipt!.status = '0x0';
    await expect(test.service.receipt(review.id, txHash, session)).resolves.toMatchObject({ status: 'reverted', blockNumber: '11' });
    test.state.transactionReceipt!.status = '0x1'; test.state.now += 120_001;
    await expect(test.service.receipt(review.id, txHash, session)).resolves.toMatchObject({ status: 'confirmed', collection, blockNumber: '11' });
    await expect(test.service.receipt(review.id, hash(901), session)).rejects.toMatchObject({ code: 'TRANSACTION_CHANGED' });
  });
  it.each(['from', 'to', 'input', 'value', 'chainId', 'hash'] as const)('rejects a transaction whose %s differs from the reviewed call', async field => {
    const test = fixture(); const review = await test.service.review(test.input(), session); const txHash = test.mined(review);
    test.state.transaction![field] = { from: other, to: marketplace, input: '0x1234', value: '0x1', chainId: '0x1', hash: hash(901) }[field];
    await expect(test.service.receipt(review.id, txHash, session)).rejects.toMatchObject({ code: 'TRANSACTION_MISMATCH' });
  });
  it('refuses a transaction already mined at or before the review block', async () => {
    for (const block of [9n, 10n]) {
      const test = fixture(); const review = await test.service.review(test.input(), session); const txHash = test.mined(review, block);
      await expect(test.service.receipt(review.id, txHash, session)).rejects.toMatchObject({ code: 'RECEIPT_TOO_OLD' });
    }
  });
  it('rejects a stale canonical block and a receipt without its action event', async () => {
    const reorged = fixture(); const review = await reorged.service.review(reorged.input(), session); const txHash = reorged.mined(review);
    reorged.state.blockHashes.set(11n, hash(888));
    await expect(reorged.service.receipt(review.id, txHash, session)).rejects.toMatchObject({ code: 'RECEIPT_REORGED' });
    const missing = fixture(); const missingReview = await missing.service.review(missing.input(), session); const missingHash = missing.mined(missingReview);
    missing.state.transactionReceipt!.logs = [];
    await expect(missing.service.receipt(missingReview.id, missingHash, session)).rejects.toMatchObject({ code: 'RECEIPT_EVENT_MISSING' });
  });
  it('recovers confirmations after re-login but rejects another account and a different deployment', async () => {
    const test = fixture(); const review = await test.service.review(test.input(), session); const txHash = test.mined(review);
    await expect(test.service.receipt(review.id, txHash, { ...session, sessionId: 'new-session' })).resolves.toMatchObject({status:'confirmed'});
    await expect(test.service.receipt(review.id, txHash, { ...session, userId:'did:privy:foreign' })).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
    await expect(test.service.receipt(review.id, txHash, { ...session, expiresAt: Number(initialTime) })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    test.loadManifest.mockResolvedValue({ ...manifest, startBlock: 2n, anchorHash: hash(101) });
    await expect(test.service.receipt(review.id, txHash, session)).rejects.toMatchObject({ code: 'DEPLOYMENT_CHANGED' });
  });
});
