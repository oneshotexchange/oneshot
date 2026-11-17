import { describe,it,expect } from 'vitest';
import { encodeFunctionData } from 'viem';
import { GUARDED_MARKETPLACE_V3_ABI } from '@oneshot/evm';
import { validNftMarketReview } from './client-nft-market-review';
import { validateNftOffersPage } from './client-nft-offers';
import type { NftLaunchContext,NftLaunchRequest,NftLaunchReview } from './client-nft-launch';
const market=`0x${'1'.repeat(40)}` as const,collection=`0x${'2'.repeat(40)}` as const,from=`0x${'3'.repeat(40)}` as const;
const context={scope:'public',marketplace:{address:market,version:3,fundedOffers:true,batchBuy:true},expectedListings:[{id:'1',collection,tokenId:'1',totalPriceRaw:'101'}]} as NftLaunchContext;
const input:NftLaunchRequest={action:'buy-batch',from,contract:market,listingIds:['1']};
const review={scope:'public',revision:0,to:market,value:'101',data:encodeFunctionData({abi:GUARDED_MARKETPLACE_V3_ABI,functionName:'buyBatch',args:[[1n],101n,from]}),summary:{totalPriceRaw:'101',quantity:'1',recipient:from}} as unknown as NftLaunchReview;
describe('funded marketplace review boundaries',()=>{
  it('allows only the selected listing IDs, sum and recipient at the verified V3 marketplace',()=>{expect(validNftMarketReview(input,review,context)).toBe(true);});
  it.each([{to:collection},{value:'102'},{revision:1},{data:`${review.data}00`},{data:encodeFunctionData({abi:GUARDED_MARKETPLACE_V3_ABI,functionName:'buyBatch',args:[[2n],101n,from]})},{summary:{...review.summary,totalPriceRaw:'102'}}])('rejects changed payable review %j',patch=>{expect(validNftMarketReview(input,{...review,...patch},context)).toBe(false);});
  it('rejects unavailable capability and stale saved prices',()=>{expect(validNftMarketReview(input,review,{...context,marketplace:{...context.marketplace!,version:2,batchBuy:false,fundedOffers:false}})).toBe(false);expect(validNftMarketReview(input,review,{...context,expectedListings:[{...context.expectedListings![0],totalPriceRaw:'102'}]})).toBe(false);});
  it('validates funded offer arithmetic and never mistakes invalid data for an empty page',()=>{
    const page={collection,deploymentId:'a'.repeat(64),network:{mode:'local',chainId:31337,nativeSymbol:'ETH',nativeDecimals:18},marketplace:context.marketplace,blockNumber:'1',blockHash:`0x${'a'.repeat(64)}`,blockTimestamp:'1000',nextCursor:null,items:[{id:'1',collection,bidder:from,recipient:from,tokenId:'0',unitPriceRaw:'101',remaining:'2',escrowRaw:'202',expiresAt:'2000',expired:false}]};
    expect(validateNftOffersPage(page,{collection}).items).toHaveLength(1);
    for(const patch of [{items:null},{items:[{...page.items[0],escrowRaw:'201'}]},{items:[{...page.items[0],expired:true}]},{items:[page.items[0],page.items[0]]}])expect(()=>validateNftOffersPage({...page,...patch},{collection})).toThrow('verified');
    expect(()=>validateNftOffersPage(page,{collection,bidder:market})).toThrow();
  });
});
