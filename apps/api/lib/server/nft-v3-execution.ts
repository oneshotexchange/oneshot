import { decodeFunctionData, encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { GUARDED_MARKETPLACE_V3_ABI as ABI, NFT_COLLECTION_ABI, parseAssetAmount, applyProtectedFloor, splitNftSettlement, type NftExecutionNetwork, type NftTerms } from '@oneshot/evm';
import type { Manifest, Block } from '../../../indexer/src/types';
import type { NftReviewInput, NftReview } from './nft-launch';
import type { createNftFloorPolicyService } from './nft-floor-policy';
import { ApiError } from './errors';

const fail=(code:string,message:string):never=>{throw new ApiError(409,code,message);};
export function nftMarketplaceCapabilities(manifest:Manifest){
  const version:1|2|3=manifest.deploymentVersion==='oneshot-nft-v3'?3:manifest.deploymentVersion==='oneshot-nft-v2'?2:1;
  return {address:manifest.marketplace.address,version,fundedOffers:version===3,batchBuy:version===3};
}
export type V3Reader=(to:Address,abi:Abi,name:string,args?:readonly unknown[])=>Promise<unknown>;
export type FundedOffer={id:string;collection:Address;bidder:Address;recipient:Address;tokenId:string;unitPriceRaw:string;remaining:string;expiresAt:string;escrowRaw:string};
export async function readFundedOffer(read:V3Reader,market:Address,id:string):Promise<FundedOffer>{
  const value=await read(market,ABI,'offers',[BigInt(id)]) as readonly [Address,Address,Address,bigint,bigint,bigint,bigint];
  if(!Array.isArray(value)||value.length!==7||!value.slice(0,3).every(v=>typeof v==='string'&&/^0x[\da-f]{40}$/i.test(v))||!value.slice(3).every(v=>typeof v==='bigint'&&v>=0n&&v<2n**256n))return fail('OFFER_UNAVAILABLE','This offer could not be verified. Refresh offers.');
  const [collection,bidder,recipient,tokenId,price,remaining,expiry]=value;
  if(/^0x0{40}$/i.test(collection)||price===0n||remaining>20n||price*remaining>=2n**256n)return fail('OFFER_UNAVAILABLE','This offer could not be verified. Refresh offers.');
  return {id,collection:collection.toLowerCase() as Address,bidder:bidder.toLowerCase() as Address,recipient:recipient.toLowerCase() as Address,tokenId:tokenId.toString(),unitPriceRaw:price.toString(),remaining:remaining.toString(),expiresAt:expiry.toString(),escrowRaw:(price*remaining).toString()};
}
type Options={input:NftReviewInput;from:Address;manifest:Manifest;block:Block;deploymentId:string;network:NftExecutionNetwork;read:V3Reader;
  collection:(address:Address)=>Promise<{creator:Address;opened:boolean;name:string;symbol:string;terms:NftTerms}>;
  policies:ReturnType<typeof createNftFloorPolicyService>;previous?:NftReview};
export async function buildNftV3Call(o:Options){
  const {input,from,manifest,block,read,policies}=o;
  if(manifest.deploymentVersion!=='oneshot-nft-v3')return fail('MARKET_ACTION_UNAVAILABLE','This marketplace does not support funded offers or multi-item checkout.');
  const market=manifest.marketplace.address,recipient=input.recipient??from;
  const summary:Record<string,string>={nativeAsset:`${o.network.name} test ETH (18 decimals)`};
  let data:Hex,value=0n;
  const result=()=>({scope:'public' as const,draftId:input.collection??market,revision:0,from,to:market,data,value:value.toString(),action:input.action,summary});
  const validRecipient=(collection?:string)=>{if(recipient===market||recipient===collection)fail('INVALID_RECIPIENT','Choose a wallet that can receive the NFTs.');};
  if(input.action==='buy-batch'){
    if(input.contract!==market||!input.listingIds?.length||input.listingIds.length>20||new Set(input.listingIds).size!==input.listingIds.length)return fail('INVALID_BATCH','Choose 1–20 distinct listings from this marketplace.');
    validRecipient();let platform=0n,royalty=0n,seller=0n;
    for(const id of input.listingIds){
      const [collection,owner,tokenId,price,active]=await read(market,ABI,'listings',[BigInt(id)]) as readonly [Address,Address,bigint,bigint,boolean];
      validRecipient(collection.toLowerCase());
      if(!active||owner.toLowerCase()===from||price<=0n)return fail('LISTING_CHANGED','One of your selected listings changed. Refresh your cart.');
      const state=await o.collection(collection.toLowerCase() as Address);
      if(!state.opened||String(await read(collection,NFT_COLLECTION_ABI,'ownerOf',[tokenId])).toLowerCase()!==market||await read(market,ABI,'activeListing',[collection,tokenId])!==BigInt(id))return fail('LISTING_CHANGED','One of your selected listings changed. Refresh your cart.');
      const split=splitNftSettlement(price,state.terms.royaltyBps);value+=price;platform+=split.platform;royalty+=split.royalty;seller+=split.seller;
      summary[`listing:${id}`]=price.toString();
    }
    if(value>=2n**256n)return fail('PRICE_OVERFLOW','Choose fewer NFTs for this purchase.');
    Object.assign(summary,{listingIds:input.listingIds.join(','),quantity:String(input.listingIds.length),recipient,totalPriceRaw:value.toString(),platformFeeRaw:platform.toString(),royaltyRaw:royalty.toString(),sellerProceedsRaw:seller.toString(),effect:'Buy every selected NFT in one transaction. If any purchase fails, the entire purchase reverts.'});
    data=encodeFunctionData({abi:ABI,functionName:'buyBatch',args:[input.listingIds.map(BigInt),value,recipient]});return result();
  }
  const collection=input.collection!;summary.collection=collection;
  if(input.action==='offer-create'){
    const state=await o.collection(collection);if(!state.opened)return fail('NOT_OPEN','Offers are available after this collection opens.');
    validRecipient(collection);
    let price:bigint;try{price=parseAssetAmount(input.price??'',18);}catch{return fail('INVALID_PRICE','Enter an exact ETH amount with at most 18 decimals.');}
    const quantity=BigInt(input.quantity??'0'),expiry=BigInt(input.expiresAt??'0'),tokenId=BigInt(input.tokenId??'0');
    if(price<=0n||quantity<1n||quantity>20n||tokenId>0n&&quantity!==1n)return fail('INVALID_OFFER','Choose a positive price and 1–20 NFTs. Item offers are for one NFT.');
    if(expiry<=block.timestamp||expiry>block.timestamp+30n*86400n)return fail('INVALID_OFFER_EXPIRY','Choose an offer expiry within the next 30 days.');
    if(tokenId>0n)await read(collection,NFT_COLLECTION_ABI,'ownerOf',[tokenId]);
    value=price*quantity;if(value>=2n**256n)return fail('PRICE_OVERFLOW','The offer total is too large.');
    Object.assign(summary,{unitPriceRaw:price.toString(),quantity:quantity.toString(),tokenId:tokenId.toString(),expiresAt:expiry.toString(),escrowRaw:value.toString(),recipient,effect:'Reserve the full offer amount now. Cancellation releases unused funds to your marketplace balance; claim them in a separate transaction.'});
    data=encodeFunctionData({abi:ABI,functionName:'createOffer',args:[collection,tokenId,price,quantity,recipient,expiry]});return result();
  }
  const offer=await readFundedOffer(read,market,input.offerId!);
  if(offer.collection!==collection||offer.remaining==='0')return fail('OFFER_CHANGED','This offer is no longer available. Refresh offers.');
  Object.assign(summary,{offerId:offer.id});
  if(input.action==='offer-cancel'||input.action==='offer-expire'){
    if(input.action==='offer-cancel'&&offer.bidder!==from)return fail('NOT_BIDDER','Select the wallet that funded this offer.');
    if(input.action==='offer-expire'&&block.timestamp<=BigInt(offer.expiresAt))return fail('OFFER_NOT_EXPIRED','This offer has not expired at the checked block.');
    Object.assign(summary,{quantity:offer.remaining,releasedAmountRaw:offer.escrowRaw,claimBeneficiary:offer.bidder,effect:'Release all unused offer funds to the bidder’s marketplace balance. The bidder can claim that balance separately.'});
    data=encodeFunctionData({abi:ABI,functionName:input.action==='offer-cancel'?'cancelOffer':'releaseExpiredOffer',args:[BigInt(offer.id)]});return result();
  }
  if(input.action!=='offer-accept'||!input.tokenId)return fail('INVALID_ACTION','Choose an NFT to accept this offer.');
  const tokenId=BigInt(input.tokenId),price=BigInt(offer.unitPriceRaw);
  if(offer.bidder===from||BigInt(offer.expiresAt)<block.timestamp||offer.tokenId!=='0'&&offer.tokenId!==input.tokenId)return fail('OFFER_CHANGED','This offer cannot be accepted for the selected NFT. Refresh offers.');
  const state=await o.collection(collection);if(!state.opened)return fail('NOT_OPEN','This collection has not opened.');
  const active=await read(market,ABI,'activeListing',[collection,tokenId]) as bigint;
  const owner=String(await read(collection,NFT_COLLECTION_ABI,'ownerOf',[tokenId])).toLowerCase();
  if(active>0n){const listing=await read(market,ABI,'listings',[active]) as readonly [Address,Address,bigint,bigint,boolean];if(!listing[4]||listing[0].toLowerCase()!==collection||listing[1].toLowerCase()!==from||listing[2]!==tokenId||owner!==market)return fail('NOT_OWNER','Select the wallet that owns this NFT or its listing.');}
  else if(owner!==from)return fail('NOT_OWNER','Select the wallet that owns this NFT.');
  const commitment=await read(market,ABI,'policyCommitment',[collection]) as Hex,nonce=await read(market,ABI,'offerAcceptanceNonces',[from]) as bigint;
  const policy=await policies.resolve({deploymentId:o.deploymentId,collection,creator:state.creator},commitment);
  if(applyProtectedFloor(price,BigInt(policy.floorRaw)).listingRaw!==price)return fail('OFFER_NOT_ACCEPTABLE','This offer cannot currently be accepted. Choose another offer or create a listing.');
  let old:readonly unknown[]|undefined;
  if(o.previous){try{const decoded=decodeFunctionData({abi:ABI,data:o.previous.data});if(decoded.functionName!=='acceptOffer')throw new Error();old=decoded.args;}catch{return fail('REVIEW_CHANGED','Prepare a fresh offer acceptance review.');}}
  const deadline=old?old[4] as bigint:(block.timestamp+120n<BigInt(offer.expiresAt)?block.timestamp+120n:BigInt(offer.expiresAt));
  if(old&&(old[0]!==BigInt(offer.id)||old[1]!==tokenId||old[2]!==nonce||old[3]!==commitment)||deadline<block.timestamp)return fail('REVIEW_CHANGED','This offer authorization changed or expired. Prepare a fresh review.');
  const signature=old?old[5] as Hex:await policies.signOffer(market,manifest.listingAuthorization.authority,{seller:from,offerId:BigInt(offer.id),collection,tokenId,totalPrice:price,nonce,policyCommitment:commitment,deadline,deploymentSalt:manifest.listingAuthorization.salt},o.network.chainId);
  const split=splitNftSettlement(price,state.terms.royaltyBps);
  Object.assign(summary,{tokenId:input.tokenId,totalPriceRaw:price.toString(),bidder:offer.bidder,recipient:offer.recipient,nonce:nonce.toString(),policyCommitment:commitment,permitDeadline:deadline.toString(),replacedListingId:active.toString(),platformFeeRaw:split.platform.toString(),royaltyRaw:split.royalty.toString(),sellerProceedsRaw:split.seller.toString(),effect:'Transfer this NFT to the offer’s fixed recipient. Sale proceeds become claimable; an existing listing closes automatically.'});
  data=encodeFunctionData({abi:ABI,functionName:'acceptOffer',args:[BigInt(offer.id),tokenId,nonce,commitment,deadline,signature]});return result();
}
