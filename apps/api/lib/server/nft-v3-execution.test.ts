import { describe,it,expect,vi } from 'vitest';
import { decodeFunctionData, zeroHash, type Address, type Hex } from 'viem';
import { GUARDED_MARKETPLACE_V3_ABI, nftNetworkForChainId, type NftTerms } from '@oneshot/evm';
import { buildNftV3Call, nftMarketplaceCapabilities } from './nft-v3-execution';
import { readNftOfferPage } from './nft-offer-page';
import { nftReviewInput, type NftReview, type NftReviewInput } from './nft-launch';
import type { Manifest } from '../../../indexer/src/types';
const a=(v:number)=>`0x${v.toString(16).padStart(40,'0')}` as Address,h=(v:number)=>`0x${v.toString(16).padStart(64,'0')}` as Hex;
const market=a(1),collection=a(2),seller=a(3),bidder=a(4),recipient=a(5),factory=a(6);
const manifest:Manifest={schemaVersion:1,deploymentVersion:'oneshot-nft-v3',mode:'local',chainId:31337,genesisHash:h(1),startBlock:1n,anchorHash:h(1),factory:{address:factory,codeHash:h(2)},marketplace:{address:market,codeHash:h(3)},listingAuthorization:{authority:a(7),salt:h(8)}};
function fixture(){
  const state={remaining:2n,price:10000n,expiry:2000n,owner:seller,active:0n,nonce:0n,floor:'0',next:3n};
  const read=vi.fn(async(to:Address,_abi:unknown,name:string,args:readonly unknown[]=[]):Promise<unknown>=>{
    if(name==='offers')return [collection,bidder,recipient,0n,state.price,state.remaining,state.expiry];
    if(name==='nextOfferId')return state.next;
    if(name==='ownerOf')return state.owner;
    if(name==='activeListing')return state.active;
    if(name==='listings')return [collection,seller,BigInt(args[0] as bigint),20000n,true];
    if(name==='policyCommitment')return zeroHash;
    if(name==='offerAcceptanceNonces')return state.nonce;
    throw new Error(`Unexpected read ${to} ${name}`);
  });
  const policies={resolve:vi.fn(async()=>({floorRaw:state.floor})),signOffer:vi.fn(async(..._args:unknown[])=>`0x${'11'.repeat(65)}` as Hex)};
  const options={manifest,from:seller,block:{number:2n,hash:h(2),parentHash:h(1),timestamp:1000n},deploymentId:'a'.repeat(64),network:nftNetworkForChainId(31337)!,read,
    collection:vi.fn(async()=>({creator:seller,opened:true,name:'Originals',symbol:'SHOT',terms:{royaltyBps:500} as NftTerms})),policies:policies as unknown as Parameters<typeof buildNftV3Call>[0]['policies']};
  const call=(patch:Partial<NftReviewInput>,previous?:NftReview)=>buildNftV3Call({...options,input:{from:seller,collection,action:'offer-create',price:'0.00000000000001',quantity:'2',expiresAt:'1500',localEthAcknowledged:true,...patch},previous});
  return {state,read,policies,options,call};
}
describe('funded marketplace exact execution',()=>{
  it('funds the full quantity at the entered price and fixed recipient without an authority permit',async()=>{
    const f=fixture(),call=await f.call({recipient});expect(call.value).toBe('20000');expect(call.summary.escrowRaw).toBe('20000');
    expect(decodeFunctionData({abi:GUARDED_MARKETPLACE_V3_ABI,data:call.data})).toMatchObject({functionName:'createOffer',args:[collection,0n,10000n,2n,recipient,1500n]});expect(f.policies.signOffer).not.toHaveBeenCalled();
  });
  it.each([{quantity:'21'},{quantity:'2',tokenId:'1'},{price:'0'},{price:'0.0000000000000000001'},{expiresAt:'1000'},{expiresAt:'2593001'},{recipient:market}])('rejects invalid funded terms %j',async patch=>{await expect(fixture().call(patch)).rejects.toBeTruthy();});
  it('keeps old marketplace capabilities off and rejects new actions there',async()=>{
    const f=fixture(),old={...manifest,deploymentVersion:'oneshot-nft-v2' as const};expect(nftMarketplaceCapabilities(old)).toMatchObject({version:2,fundedOffers:false,batchBuy:false});await expect(buildNftV3Call({...f.options,manifest:old,input:{from:seller,collection,action:'offer-cancel',offerId:'1'}})).rejects.toMatchObject({code:'MARKET_ACTION_UNAVAILABLE'});
  });
  it('cancels without collection/policy access and identifies the bidder refund balance',async()=>{
    const f=fixture();f.policies.resolve.mockRejectedValue(new Error('authority offline'));f.options.collection.mockRejectedValue(new Error('metadata offline'));
    const call=await f.call({action:'offer-cancel',from:bidder,offerId:'1'}).catch(e=>e);
    // The authenticated sender is supplied separately by the launch service.
    await expect(f.call({action:'offer-cancel',offerId:'1'})).rejects.toMatchObject({code:'NOT_BIDDER'});
    const good=await buildNftV3Call({...f.options,from:bidder,input:{from:bidder,collection,action:'offer-cancel',offerId:'1'}});
    expect(good.summary).toMatchObject({releasedAmountRaw:'20000',claimBeneficiary:bidder});expect(f.policies.resolve).not.toHaveBeenCalled();expect(f.options.collection).not.toHaveBeenCalled();
  });
  it('uses strict expiry release while acceptance permits the expiry boundary',async()=>{
    const f=fixture();f.state.expiry=1000n;await expect(f.call({action:'offer-expire',offerId:'1'})).rejects.toMatchObject({code:'OFFER_NOT_EXPIRED'});
    await expect(f.call({action:'offer-accept',offerId:'1',tokenId:'1'})).resolves.toMatchObject({summary:{permitDeadline:'1000'}});
    f.state.expiry=999n;await expect(f.call({action:'offer-expire',offerId:'1'})).resolves.toMatchObject({value:'0'});
    await expect(f.call({action:'offer-accept',offerId:'1',tokenId:'1'})).rejects.toMatchObject({code:'OFFER_CHANGED'});
  });
  it('signs the exact price and settlement without leaking or raising a protected minimum',async()=>{
    const f=fixture();f.state.floor='10001';await expect(f.call({action:'offer-accept',offerId:'1',tokenId:'1'})).rejects.toMatchObject({code:'OFFER_NOT_ACCEPTABLE'});expect(f.policies.signOffer).not.toHaveBeenCalled();
    f.state.floor='10000';const call=await f.call({action:'offer-accept',offerId:'1',tokenId:'1'});
    expect(call.summary).toMatchObject({totalPriceRaw:'10000',platformFeeRaw:'200',royaltyRaw:'500',sellerProceedsRaw:'9300',recipient,bidder});expect(JSON.stringify(call)).not.toContain('floor');
    expect(f.policies.signOffer.mock.calls[0]?.[2]).toMatchObject({seller,offerId:1n,collection,tokenId:1n,totalPrice:10000n,nonce:0n,deadline:1120n});
    const previous={...call,data:call.data} as NftReview;f.state.nonce=1n;await expect(f.call({action:'offer-accept',offerId:'1',tokenId:'1'},previous)).rejects.toMatchObject({code:'REVIEW_CHANGED'});
  });
  it('checks ownership and closes an existing seller listing at the offer price',async()=>{
    const f=fixture();f.state.owner=market;await expect(f.call({action:'offer-accept',offerId:'1',tokenId:'1'})).rejects.toMatchObject({code:'NOT_OWNER'});
    f.state.active=1n;expect((await f.call({action:'offer-accept',offerId:'1',tokenId:'1'})).summary.replacedListingId).toBe('1');
  });
  it('caps an atomic batch at its exact sum with per-item fee rounding',async()=>{
    const f=fixture();f.state.owner=market;f.read.mockImplementation(async(_to,_abi,name,args=[])=>name==='listings'?[collection,bidder,args[0],101n,true]:name==='ownerOf'?market:name==='activeListing'?args[1]:null);
    const call=await f.call({action:'buy-batch',collection:undefined,contract:market,listingIds:['1','2'],recipient});expect(call.value).toBe('202');expect(call.summary).toMatchObject({platformFeeRaw:'4',royaltyRaw:'10',sellerProceedsRaw:'188',quantity:'2'});
    expect(decodeFunctionData({abi:GUARDED_MARKETPLACE_V3_ABI,data:call.data})).toMatchObject({functionName:'buyBatch',args:[[1n,2n],202n,recipient]});
    await expect(f.call({action:'buy-batch',contract:market,listingIds:['1','1']})).rejects.toMatchObject({code:'INVALID_BATCH'});
  });
  it('requires collection/action identifiers and preserves strict input validation',()=>{
    expect(nftReviewInput.safeParse({from:seller,action:'buy-batch',contract:market,listingIds:['1','1'],localEthAcknowledged:true}).success).toBe(false);
    expect(nftReviewInput.safeParse({from:seller,collection,action:'offer-accept',localEthAcknowledged:true}).success).toBe(false);
  });
});
describe('bounded canonical offer pages',()=>{
  it('returns exact reserved balances and calculates expiry from the held chain time',async()=>{
    const f=fixture();f.state.expiry=999n;const page=await readNftOfferPage({...f.options,query:{collection}});expect(page.items.map(v=>v.id)).toEqual(['2','1']);expect(page.items[0]).toMatchObject({escrowRaw:'20000',expired:true});expect(page.nextCursor).toBeNull();
  });
  it('binds pagination to filter, deployment and checkpoint and bounds sparse scans',async()=>{
    const f=fixture();f.state.next=200n;const page=await readNftOfferPage({...f.options,query:{collection,bidder:seller}});expect(page.items).toEqual([]);expect(f.read).toHaveBeenCalledTimes(51);expect(page.nextCursor).toBeTruthy();
    await expect(readNftOfferPage({...f.options,query:{collection,cursor:page.nextCursor!}})).rejects.toMatchObject({code:'OFFER_CURSOR_STALE'});
    await expect(readNftOfferPage({...f.options,query:{collection,cursor:'{bad'}})).rejects.toMatchObject({code:'OFFER_CURSOR_INVALID'});
  });
});
