import { describe,it,expect } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, type AbiEvent, type Address, type Hex } from 'viem';
import { GUARDED_MARKETPLACE_V3_ABI } from '@oneshot/evm';
import type { NftReview } from './nft-launch';
import { nftV3ReceiptMatches } from './nft-v3-receipt';
const a=(v:string)=>`0x${v.repeat(40)}` as Address,h=(v:string)=>`0x${v.repeat(64)}` as Hex;
const review={action:'buy-batch',to:a('1'),from:a('2'),summary:{listingIds:'1,2','listing:1':'101','listing:2':'202',recipient:a('3')}} as unknown as NftReview;
function event(name:string,args:Record<string,unknown>){const definition=GUARDED_MARKETPLACE_V3_ABI.find(v=>v.type==='event'&&v.name===name) as AbiEvent,fields=definition.inputs.filter(v=>!v.indexed);return {address:review.to,transactionHash:h('a'),blockHash:h('b'),removed:false,topics:encodeEventTopics({abi:[definition],eventName:name,args}),data:encodeAbiParameters(fields,fields.map(v=>args[v.name!]))};}
const sold=(id:bigint,price:bigint,patch:Record<string,unknown>={})=>event('Sold',{listingId:id,buyer:review.from,recipient:a('3'),totalPrice:price,platformFee:price*200n/10000n,royalty:0n,sellerProceeds:price-price*200n/10000n,...patch});
describe('V3 canonical receipt settlement',()=>{
  it('requires every reviewed purchase exactly once',()=>{const one=sold(1n,101n),two=sold(2n,202n);expect(nftV3ReceiptMatches(review,[one,two],h('a'),h('b'))).toBe(true);for(const logs of [[one],[one,one],[one,two,two],[one,sold(3n,202n)]])expect(nftV3ReceiptMatches(review,logs,h('a'),h('b'))).toBe(false);});
  it.each([{totalPrice:203n},{buyer:a('4')},{recipient:a('4')}])('rejects changed sale settlement',patch=>{expect(nftV3ReceiptMatches(review,[sold(1n,101n),sold(2n,202n,patch)],h('a'),h('b'))).toBe(false);});
  it.each([{address:a('4')},{transactionHash:h('c')},{blockHash:h('c')},{removed:true},{data:`${sold(2n,202n).data}00`}])('rejects wrong provenance/encoding',patch=>{expect(nftV3ReceiptMatches(review,[sold(1n,101n),{...sold(2n,202n),...patch}],h('a'),h('b'))).toBe(false);});
  it('confirms exact offer funding, recipient, quantity and expiry',()=>{
    const summary={collection:a('4'),recipient:a('3'),tokenId:'0',unitPriceRaw:'100',quantity:'2',expiresAt:'2000'},r={...review,action:'offer-create',summary} as NftReview;
    const args={offerId:1n,collection:a('4'),bidder:review.from,recipient:a('3'),tokenId:0n,unitPrice:100n,quantity:2n,expiry:2000n};
    expect(nftV3ReceiptMatches(r,[event('OfferCreated',args)],h('a'),h('b'))).toBe(true);
    expect(nftV3ReceiptMatches(r,[event('OfferCreated',{...args,quantity:1n})],h('a'),h('b'))).toBe(false);
  });
});
