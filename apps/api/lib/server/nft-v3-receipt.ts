import { decodeEventLog, encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { GUARDED_MARKETPLACE_V3_ABI } from '@oneshot/evm';
import type { NftReview } from './nft-launch';

const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown)=>typeof v==='bigint'?v.toString():typeof v==='string'?v.toLowerCase():'';
/** Every selected purchase must settle, with exact reviewed prices and recipient. */
export function nftV3ReceiptMatches(review:NftReview,logs:unknown[],hash:Hex,blockHash:Hex):boolean{
  const expected:Record<string,string>={'offer-create':'OfferCreated','offer-accept':'OfferAccepted','offer-cancel':'OfferCancelled','offer-expire':'OfferExpired','buy-batch':'Sold'};
  const event=expected[review.action];if(!event)return false;
  const s=review.summary,matched=new Set<string>();let count=0;
  for(const log of logs){
    if(!record(log)||text(log.address)!==review.to||text(log.transactionHash)!==hash||text(log.blockHash)!==blockHash||log.removed===true||typeof log.data!=='string'||!Array.isArray(log.topics))continue;
    try{
      const decoded=decodeEventLog({abi:GUARDED_MARKETPLACE_V3_ABI,data:log.data as Hex,topics:log.topics as [Hex,...Hex[]],strict:true});
      if(decoded.eventName!==event)continue;
      const definition=GUARDED_MARKETPLACE_V3_ABI.find(v=>v.type==='event'&&v.name===event);
      if(!definition||definition.type!=='event')continue;
      const a=decoded.args as Record<string,unknown>,fields=definition.inputs.filter(v=>!('indexed' in v&&v.indexed));
      if(encodeAbiParameters(fields,fields.map(v=>a[v.name!])).toLowerCase()!==log.data.toLowerCase()||JSON.stringify(encodeEventTopics({abi:[definition],eventName:definition.name,args:a}).map(text))!==JSON.stringify(log.topics.map(text)))continue;
      if(event==='Sold'){
        const id=text(a.listingId),ids=s.listingIds?.split(',')??[];
        if(!ids.includes(id)||matched.has(id)||text(a.buyer)!==review.from||text(a.recipient)!==s.recipient||text(a.totalPrice)!==s[`listing:${id}`])return false;
        matched.add(id);
      }else{
        const equals=(key:string,want:string|undefined)=>want!==undefined&&text(a[key])===want.toLowerCase();
        if(event==='OfferCreated'&&(!equals('collection',s.collection)||!equals('bidder',review.from)||!equals('recipient',s.recipient)||!equals('tokenId',s.tokenId)||!equals('unitPrice',s.unitPriceRaw)||!equals('quantity',s.quantity)||!equals('expiry',s.expiresAt)||!/^\d+$/.test(text(a.offerId))||BigInt(text(a.offerId))===0n))return false;
        if(event==='OfferAccepted'&&(!equals('offerId',s.offerId)||!equals('collection',s.collection)||!equals('seller',review.from)||!equals('tokenId',s.tokenId)||!equals('bidder',s.bidder)||!equals('recipient',s.recipient)||!equals('totalPrice',s.totalPriceRaw)||!equals('platformFee',s.platformFeeRaw)||!equals('royalty',s.royaltyRaw)||!equals('sellerProceeds',s.sellerProceedsRaw)||!equals('replacedListingId',s.replacedListingId)))return false;
        if((event==='OfferCancelled'||event==='OfferExpired')&&(!equals('offerId',s.offerId)||!equals('bidder',s.claimBeneficiary)||!equals('quantity',s.quantity)||!equals('refund',s.releasedAmountRaw)||event==='OfferExpired'&&!equals('caller',review.from)))return false;
      }
      count++;
    }catch{continue;}
  }
  return event==='Sold'?matched.size===(s.listingIds?.split(',').length??0)&&count===matched.size:count===1;
}
