import { readNftNetwork } from './nft-network';
import { readNftMarketplace } from './client-nft-marketplace';
import type { LocalLaunchNetwork } from './client-nft-launch';
import type { NftMarketplaceCapabilities } from './client-nft-marketplace';
export type NftOffer={id:string;collection:string;bidder:string;recipient:string;tokenId:string;unitPriceRaw:string;remaining:string;expiresAt:string;escrowRaw:string;expired:boolean};
export type NftOffersPage={items:NftOffer[];nextCursor:string|null;collection:string;deploymentId:string;network:LocalLaunchNetwork;marketplace:NftMarketplaceCapabilities;blockNumber:string;blockHash:string;blockTimestamp:string};
const uint=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9]\d{0,77})$/.test(v)&&BigInt(v)<2n**256n;
const address=(v:unknown):v is string=>typeof v==='string'&&/^0x[\da-f]{40}$/i.test(v)&&!/^0x0{40}$/i.test(v);
export function validateNftOffersPage(value:unknown,query:{collection:string;bidder?:string;tokenId?:string}):NftOffersPage{
  const fail=():never=>{throw new Error('Offers could not be verified. Refresh offers and try again.');};
  if(!value||typeof value!=='object')return fail();const p=value as NftOffersPage;
  if(!readNftNetwork(p.network)||!readNftMarketplace(p.marketplace)?.fundedOffers||!/^([a-f\d]{64})$/i.test(p.deploymentId)||p.collection?.toLowerCase()!==query.collection.toLowerCase()||!uint(p.blockNumber)||!uint(p.blockTimestamp)||!/^0x[\da-f]{64}$/i.test(p.blockHash)||!(p.nextCursor===null||typeof p.nextCursor==='string'&&p.nextCursor.length>0&&p.nextCursor.length<=2048)||!Array.isArray(p.items)||p.items.length>10)return fail();
  let previous=2n**256n;
  for(const i of p.items){
    if(!i||!uint(i.id)||i.id==='0'||BigInt(i.id)>=previous||!address(i.collection)||i.collection.toLowerCase()!==query.collection.toLowerCase()||!address(i.bidder)||!address(i.recipient)||!uint(i.tokenId)||!uint(i.unitPriceRaw)||i.unitPriceRaw==='0'||!uint(i.remaining)||BigInt(i.remaining)<1n||BigInt(i.remaining)>20n||i.tokenId!=='0'&&i.remaining!=='1'||!uint(i.expiresAt)||!uint(i.escrowRaw)||BigInt(i.escrowRaw)!==BigInt(i.unitPriceRaw)*BigInt(i.remaining)||typeof i.expired!=='boolean'||i.expired!==(BigInt(p.blockTimestamp)>BigInt(i.expiresAt))||query.bidder&&query.bidder.toLowerCase()!==i.bidder.toLowerCase()||query.tokenId&&i.tokenId!=='0'&&query.tokenId!==i.tokenId)return fail();
    previous=BigInt(i.id);
  }
  return p;
}
