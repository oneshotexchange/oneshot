import { z } from 'zod';
import type { Address } from 'viem';
import { GUARDED_MARKETPLACE_V3_ABI, type NftExecutionNetwork } from '@oneshot/evm';
import { readFundedOffer, nftMarketplaceCapabilities, type V3Reader } from './nft-v3-execution';
import type { Manifest, Block } from '../../../indexer/src/types';
import { ApiError } from './errors';

const uint=z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(v=>BigInt(v)<2n**256n);
const address=z.string().regex(/^0x[\da-f]{40}$/i).transform(v=>v.toLowerCase() as Address);
export const offerQuery=z.object({collection:address,bidder:address.optional(),tokenId:uint.optional(),cursor:z.string().min(1).max(2048).optional()}).strict();
const cursorSchema=z.object({v:z.literal(1),deploymentId:z.string().regex(/^[a-f0-9]{64}$/),blockNumber:uint,blockHash:z.string().regex(/^0x[\da-f]{64}$/),nextId:uint,scope:z.string().max(200)}).strict();
export function readOfferCursor(value:string|undefined){
  if(!value)return null;
  try{if(!/^[\w-]+$/.test(value))throw new Error();const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)throw new Error();return cursorSchema.parse(JSON.parse(bytes.toString('utf8')));}
  catch{throw new ApiError(400,'OFFER_CURSOR_INVALID','Refresh offers from the first page.');}
}
export function offerScope(query:z.infer<typeof offerQuery>){return JSON.stringify([query.collection,query.bidder??'',query.tokenId??'']);}
/** Bounded scan of immutable offer slots at one held canonical block. No floor policy is public. */
export async function readNftOfferPage(o:{query:z.infer<typeof offerQuery>;manifest:Manifest;deploymentId:string;network:NftExecutionNetwork;block:Block;read:V3Reader}){
  if(o.manifest.deploymentVersion!=='oneshot-nft-v3')throw new ApiError(409,'OFFERS_UNAVAILABLE','Funded offers are unavailable for this collection. Browse its listings instead.');
  const market=o.manifest.marketplace.address,scope=offerScope(o.query),cursor=readOfferCursor(o.query.cursor);
  if(cursor&&(cursor.deploymentId!==o.deploymentId||cursor.scope!==scope||cursor.blockNumber!==o.block.number.toString()||cursor.blockHash!==o.block.hash))throw new ApiError(409,'OFFER_CURSOR_STALE','The offers checkpoint changed. Refresh from the first page.');
  const next=await o.read(market,GUARDED_MARKETPLACE_V3_ABI,'nextOfferId') as bigint;
  if(typeof next!=='bigint'||next<1n||next>=2n**256n)throw new ApiError(503,'OFFERS_UNAVAILABLE','Offers could not be loaded. Try again.');
  let id=cursor?BigInt(cursor.nextId):next-1n;
  if(id>=next)throw new ApiError(400,'OFFER_CURSOR_INVALID','Refresh offers from the first page.');
  const items=[];let scanned=0;
  while(id>0n&&scanned<50&&items.length<10){
    const offer=await readFundedOffer(o.read,market,id.toString());id--;scanned++;
    if(offer.collection!==o.query.collection||o.query.bidder&&offer.bidder!==o.query.bidder||o.query.tokenId&&offer.tokenId!=='0'&&offer.tokenId!==o.query.tokenId)continue;
    // Closed slots retain their original immutable price and recipient, but are not available offers.
    if(offer.remaining==='0')continue;
    items.push({...offer,expired:o.block.timestamp>BigInt(offer.expiresAt)});
  }
  const nextCursor=id>0n?Buffer.from(JSON.stringify({v:1,deploymentId:o.deploymentId,blockNumber:o.block.number.toString(),blockHash:o.block.hash,nextId:id.toString(),scope})).toString('base64url'):null;
  return {items,nextCursor,collection:o.query.collection,deploymentId:o.deploymentId,network:o.network,marketplace:nftMarketplaceCapabilities(o.manifest),blockNumber:o.block.number.toString(),blockHash:o.block.hash,blockTimestamp:o.block.timestamp.toString()};
}
