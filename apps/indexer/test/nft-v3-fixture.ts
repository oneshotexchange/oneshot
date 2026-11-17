import { encodeAbiParameters, encodeEventTopics, zeroAddress, type AbiEvent, type Address, type Hex } from 'viem';
import { collectionEvents,factoryEvents,offerMarketplaceEvents,projectLogs } from '../src/events';
import type { Block,IndexerStore,Manifest,RawLog } from '../src/types';
export const address=(v:number)=>`0x${v.toString(16).padStart(40,'0')}` as Address,hash=(v:number)=>`0x${v.toString(16).padStart(64,'0')}` as Hex;
export const factory=address(1),market=address(2),collection=address(3),seller=address(4),bidder=address(5),recipient=address(6),forwarded=address(7);
export const v3Manifest:Manifest={schemaVersion:1,deploymentVersion:'oneshot-nft-v3',mode:'local',chainId:31337,genesisHash:hash(100),startBlock:1n,anchorHash:hash(100),factory:{address:factory,codeHash:hash(20)},marketplace:{address:market,codeHash:hash(21)},listingAuthorization:{authority:address(8),salt:hash(22)}};
export function at(n:number):Block{return {number:BigInt(n),hash:hash(100+n),parentHash:hash(99+n),timestamp:1000n+BigInt(n)};}
export function v3Logs(n:number):RawLog[]{
  const result:RawLog[]=[],block=at(n);
  const event=(abi:readonly AbiEvent[],source:Address,name:string,args:Record<string,unknown>)=>{const def=abi.find(v=>v.name===name)!,fields=def.inputs.filter(v=>!v.indexed);result.push({address:source,topics:encodeEventTopics({abi:[def],eventName:name,args}) as Hex[],data:encodeAbiParameters(fields,fields.map(v=>args[v.name!])),blockNumber:block.number,blockHash:block.hash,transactionHash:hash(500+n),transactionIndex:0,logIndex:result.length});};
  const transfer=(from:Address,to:Address,id=1n)=>event(collectionEvents,collection,'Transfer',{from,to,tokenId:id});
  if(n===1){event(factoryEvents,factory,'CollectionCreated',{collection,creator:seller,name:'Originals',symbol:'SHOT'});event(collectionEvents,collection,'TermsConfigured',{termsHash:hash(30)});event(collectionEvents,collection,'CollectionOpened',{termsHash:hash(30),contentHash:hash(31)});transfer(zeroAddress,seller);transfer(zeroAddress,seller,2n);event(collectionEvents,collection,'Minted',{payer:seller,recipient:seller,firstTokenId:1n,quantity:2n,totalPrice:0n,platformFee:0n,creatorProceeds:0n,allowlistStage:false});}
  if(n===2){event(offerMarketplaceEvents,market,'OfferCreated',{offerId:1n,collection,bidder,recipient,tokenId:0n,unitPrice:10000n,quantity:2n,expiry:3000n});transfer(seller,market);event(offerMarketplaceEvents,market,'Listed',{listingId:1n,collection,tokenId:1n,seller,totalPrice:20000n});}
  if(n===3){transfer(market,recipient);transfer(recipient,forwarded);event(offerMarketplaceEvents,market,'OfferAccepted',{offerId:1n,collection,tokenId:1n,seller,bidder,recipient,totalPrice:10000n,platformFee:200n,royalty:500n,sellerProceeds:9300n,replacedListingId:1n});}
  if(n===4)event(offerMarketplaceEvents,market,'OfferCancelled',{offerId:1n,bidder,quantity:1n,refund:10000n});
  if(n===5)event(offerMarketplaceEvents,market,'Claimed',{account:bidder,recipient:bidder,amount:10000n});
  return result;
}
export async function appendV3(store:IndexerStore,n:number,manifest=v3Manifest,logs=v3Logs(n)){await store.transaction(async tx=>{await projectLogs(tx,manifest,logs,at(n));await tx.append(at(n),logs);});}
