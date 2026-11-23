import {
  decodeAbiParameters, decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData,
  hashTypedData, parseAbi, parseAbiParameters, zeroAddress, zeroHash, type Abi, type AbiEvent, type Address, type Hex,
} from 'viem';
import { parseReviewedNftManifest, reviewedNftManifestId, reviewedNftManifestJson, type ReviewedNftManifest } from '../../../../packages/evm/src/reviewed-nft';
import { REVIEWED_NFT_MARKETPLACE_ABI } from '../../../../packages/evm/src/reviewed-nft-abi';
import { reviewedNftExecutionReviewSchema, type ReviewedNftExecutionReview } from '../../../web/lib/reviewed-nft-execution';

/** Minimal immutable review fields consumed by the pure matcher. Additional
 * account/session/review-store fields belong to the calling execution service.
 */
type ReviewedNftReceiptReview = {
  action:'list'|'buy'|'cancel'|'claim'; chainId:31337|84532; deploymentId:string;
  from:Address; to:Address; data:Hex; value:string; nonce:string; marketplace:Address;
  collection:Address|null; tokenId:string|null; listingId:string|null; recipient:Address;
  intentBytes?:Hex;
  summary:{priceRaw?:string|null;royaltyRaw?:string|null;royaltyRecipient?:Address|null;seller?:Address|null;
    reviewVersion?:string|null;runtimeCodeHash?:Hex|null;intentHash?:Hex|null;claimRaw?:string|null};
};
export type ReviewedNftReceiptEvidence = {status:'confirmed'|'reverted';blockNumber:string;blockHash:Hex;actualClaimRaw?:string;listingId?:string};
type Row = Record<string,unknown>;
type Log = {address:Address;data:Hex;topics:Hex[];logIndex:bigint};
const object=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);
const hash=(value:unknown):value is Hex=>typeof value==='string'&&/^0x[\da-f]{64}$/i.test(value)&&value.toLowerCase()!==zeroHash;
const data=(value:unknown):value is Hex=>typeof value==='string'&&/^0x(?:[\da-f]{2})*$/i.test(value);
const address=(value:unknown):value is Address=>typeof value==='string'&&/^0x[\da-f]{40}$/i.test(value);
const uint=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9]\d{0,77})$/.test(value)&&BigInt(value)<2n**256n;
const positive=(value:unknown):value is string=>uint(value)&&value!=='0';
const equal=(left:unknown,right:unknown)=>typeof left==='string'&&typeof right==='string'&&left.toLowerCase()===right.toLowerCase();
const quantity=(value:unknown):bigint|null=>typeof value==='string'&&/^0x(?:0|[1-9a-f][\da-f]{0,63})$/i.test(value)?BigInt(value):null;
const nonzero=(value:unknown):value is Address=>address(value)&&value.toLowerCase()!==zeroAddress;
const MAX_LOGS=10_000,MAX_LOG_BYTES=16*1024*1024;
const nftAbi=parseAbi(['function safeTransferFrom(address from,address to,uint256 tokenId,bytes data)','event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
const intentParameters=parseAbiParameters('address seller,address collection,uint256 tokenId,uint256 totalPrice,address royaltyRecipient,uint256 royaltyAmount,uint256 reviewVersion,uint256 nonce,uint256 deadline,uint256 chainId,address marketplace,bytes32 deploymentSalt');
const intentTypes={ListingIntent:[
  {name:'seller',type:'address'},{name:'collection',type:'address'},{name:'tokenId',type:'uint256'},{name:'totalPrice',type:'uint256'},
  {name:'royaltyRecipient',type:'address'},{name:'royaltyAmount',type:'uint256'},{name:'reviewVersion',type:'uint256'},
  {name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'},{name:'chainId',type:'uint256'},
  {name:'marketplace',type:'address'},{name:'deploymentSalt',type:'bytes32'},
]} as const;

function reviewedCall(review:ReviewedNftExecutionReview,manifest:ReviewedNftManifest):ReviewedNftReceiptReview|null {
  const base={...review,summary:{},collection:null,tokenId:null,listingId:null,recipient:review.from} as ReviewedNftReceiptReview;
  if(review.action==='list') {
    const t=review.terms,i=t.intent;
    const encoded=encodeAbiParameters(intentParameters,[i.seller,i.collection,BigInt(i.tokenId),BigInt(i.totalPrice),i.royaltyRecipient,BigInt(i.royaltyAmount),
      BigInt(i.reviewVersion),BigInt(i.nonce),BigInt(i.deadline),BigInt(i.chainId),i.marketplace,i.deploymentSalt]);
    if(!equal(i.deploymentSalt,manifest.marketplaceSalt))return null;
    base.collection=t.collection;base.tokenId=t.tokenId;base.recipient=manifest.marketplace.address;base.intentBytes=encoded;
    base.summary={priceRaw:t.totalPriceRaw,royaltyRaw:t.royaltyRaw,royaltyRecipient:t.royaltyRecipient,seller:t.seller,reviewVersion:t.reviewVersion,runtimeCodeHash:t.runtimeCodeHash,intentHash:t.intentHash};
    if(!equal(review.data,encodeFunctionData({abi:nftAbi,functionName:'safeTransferFrom',args:[review.from,manifest.marketplace.address,BigInt(t.tokenId),encoded]})))return null;
  } else if(review.action==='buy') {
    const t=review.terms;
    base.collection=t.collection;base.tokenId=t.tokenId;base.listingId=t.listingId;base.recipient=t.recipient;
    base.summary={priceRaw:t.totalPriceRaw,royaltyRaw:t.royaltyRaw,royaltyRecipient:t.royaltyRecipient,seller:t.seller,reviewVersion:t.reviewVersion,runtimeCodeHash:t.runtimeCodeHash};
    if(!equal(review.data,encodeFunctionData({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'buy',args:[BigInt(t.listingId),BigInt(t.totalPriceRaw),t.recipient]})))return null;
  } else if(review.action==='cancel') {
    const t=review.terms;
    base.collection=t.collection;base.tokenId=t.tokenId;base.listingId=t.listingId;base.recipient=t.recipient;base.summary={seller:t.seller};
    const cancelTo=encodeFunctionData({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'cancelTo',args:[BigInt(t.listingId),t.recipient]});
    const cancel=encodeFunctionData({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'cancel',args:[BigInt(t.listingId)]});
    if(!equal(review.data,cancelTo)&&(!equal(t.recipient,review.from)||!equal(review.data,cancel)))return null;
  } else {
    base.recipient=review.terms.recipient;base.summary={claimRaw:review.terms.amountRaw};
    if(!equal(review.data,encodeFunctionData({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'claimTo',args:[review.terms.recipient]})))return null;
  }
  return base;
}

function call(abi:Abi,input:Hex) {
  const decoded=decodeFunctionData({abi,data:input});
  if(!equal(encodeFunctionData({abi,functionName:decoded.functionName,args:decoded.args}),input))return null;
  return decoded;
}
/** Exact ABI re-encoding prevents trailing words, dirty addresses and a
 * permissive decoder from changing the meaning of the receipt wire bytes.
 */
function event(log:Log,abi:Abi):{name:string;args:Row}|null {
  try {
    const decoded=decodeEventLog({abi,data:log.data,topics:log.topics as [Hex,...Hex[]],strict:true});
    const definition=abi.find(value=>value.type==='event'&&value.name===decoded.eventName) as AbiEvent|undefined;
    if(!definition||typeof decoded.eventName!=='string'||!object(decoded.args))return null;
    const fields=definition.inputs.filter(input=>!input.indexed),args=decoded.args;
    const topics=encodeEventTopics({abi:[definition],eventName:definition.name,args});
    if(!topics.every(value=>typeof value==='string'))return null;
    if(!equal(encodeAbiParameters(fields,fields.map(input=>args[input.name!])),log.data)
      ||JSON.stringify((topics as Hex[]).map(value=>value.toLowerCase()))!==JSON.stringify(log.topics.map(value=>value.toLowerCase())))return null;
    return{name:decoded.eventName,args};
  } catch {return null;}
}
function header(review:ReviewedNftReceiptReview,transaction:unknown,receipt:unknown) {
  if(!object(transaction)||!object(receipt)||!hash(transaction.hash)||!hash(transaction.blockHash)||!hash(receipt.transactionHash)||!hash(receipt.blockHash)
    ||!equal(transaction.hash,receipt.transactionHash)||!equal(transaction.blockHash,receipt.blockHash)
    ||!nonzero(transaction.from)||!nonzero(transaction.to)||!equal(transaction.from,review.from)||!equal(transaction.to,review.to)
    ||!equal(receipt.from,review.from)||!equal(receipt.to,review.to)||!data(transaction.input)||!equal(transaction.input,review.data)
    ||quantity(transaction.value)!==BigInt(review.value)||quantity(transaction.nonce)!==BigInt(review.nonce)||quantity(transaction.chainId)!==BigInt(review.chainId)
    ||receipt.contractAddress!==undefined&&receipt.contractAddress!==null)return null;
  const number=quantity(transaction.blockNumber),index=quantity(transaction.transactionIndex);
  if(number===null||number<1n||number>2n**64n-1n||index===null||index>2_147_483_647n
    ||quantity(receipt.blockNumber)!==number||quantity(receipt.transactionIndex)!==index
    ||(receipt.status!=='0x0'&&receipt.status!=='0x1')||!Array.isArray(receipt.logs)||receipt.logs.length>MAX_LOGS)return null;
  const logs:Log[]=[];let previous=-1n,bytes=0;
  for(const value of receipt.logs) {
    if(!object(value)||!nonzero(value.address)||value.removed!==false||!equal(value.transactionHash,transaction.hash)
      ||!equal(value.blockHash,transaction.blockHash)||quantity(value.blockNumber)!==number||quantity(value.transactionIndex)!==index
      ||!data(value.data)||value.data.length>131_074||!Array.isArray(value.topics)||value.topics.length>4
      ||!value.topics.every(topic=>typeof topic==='string'&&/^0x[\da-f]{64}$/i.test(topic)))return null;
    const logIndex=quantity(value.logIndex);
    if(logIndex===null||logIndex<=previous||logIndex>2_147_483_647n)return null;
    bytes+=(value.data.length-2)/2+value.topics.length*32+160;if(bytes>MAX_LOG_BYTES)return null;previous=logIndex;
    logs.push({address:value.address.toLowerCase() as Address,data:value.data,topics:value.topics as Hex[],logIndex});
  }
  return{status:receipt.status==='0x1'?'confirmed' as const:'reverted' as const,blockNumber:number.toString(),blockHash:receipt.blockHash.toLowerCase() as Hex,logs};
}

function listed(review:ReviewedNftReceiptReview,manifest:ReviewedNftManifest,args:Row) {
  const decoded=call(nftAbi,review.data);
  if(!decoded||decoded.functionName!=='safeTransferFrom'||!decoded.args)return false;
  const [from,to,id,bytes]=decoded.args as readonly [Address,Address,bigint,Hex];
  if(!equal(from,review.from)||!equal(to,manifest.marketplace.address)||id.toString()!==review.tokenId||!data(bytes)||bytes.length!==770||!equal(bytes,review.intentBytes))return false;
  const intent=decodeAbiParameters(intentParameters,bytes);
  if(!equal(encodeAbiParameters(intentParameters,intent),bytes))return false;
  const [seller,collection,tokenId,totalPrice,royaltyRecipient,royaltyAmount,reviewVersion,nonce,deadline,chainId,marketplace,deploymentSalt]=intent;
  const s=review.summary;
  if(!equal(seller,review.from)||!equal(s.seller,review.from)||!equal(collection,review.collection)||tokenId!==id
    ||!positive(s.priceRaw)||totalPrice.toString()!==s.priceRaw||!uint(s.royaltyRaw)||royaltyAmount.toString()!==s.royaltyRaw
    ||royaltyAmount>totalPrice/10n||!equal(royaltyRecipient,s.royaltyRecipient)||royaltyAmount>0n&&(!nonzero(royaltyRecipient)||equal(royaltyRecipient,marketplace))
    ||!positive(s.reviewVersion)||reviewVersion.toString()!==s.reviewVersion||chainId!==BigInt(manifest.chainId)
    ||!equal(marketplace,manifest.marketplace.address)||!equal(deploymentSalt,manifest.marketplaceSalt)||!hash(s.runtimeCodeHash)||!hash(s.intentHash))return false;
  const intentHash=hashTypedData({domain:{name:'OneshotReviewedMarketplace',version:'1',chainId:manifest.chainId,verifyingContract:manifest.marketplace.address},
    primaryType:'ListingIntent',types:intentTypes,message:{seller,collection,tokenId,totalPrice,royaltyRecipient,royaltyAmount,reviewVersion,nonce,deadline,chainId,marketplace,deploymentSalt}});
  return equal(intentHash,s.intentHash)&&typeof args.listingId==='bigint'&&args.listingId>0n
    &&(review.listingId===null||args.listingId.toString()===review.listingId)&&equal(args.collection,collection)&&args.tokenId===tokenId
    &&equal(args.seller,seller)&&args.totalPrice===totalPrice&&equal(args.royaltyRecipient,royaltyRecipient)&&args.royaltyAmount===royaltyAmount
    &&args.reviewVersion===reviewVersion&&equal(args.runtimeCodeHash,s.runtimeCodeHash)&&equal(args.intentHash,intentHash);
}
function settlement(review:ReviewedNftReceiptReview,args:Row) {
  const decoded=call(REVIEWED_NFT_MARKETPLACE_ABI,review.data);
  if(!decoded||!decoded.args)return false;
  const values=decoded.args as readonly unknown[],s=review.summary;
  if(review.action==='buy') {
    if(decoded.functionName!=='buy'||values[0]!==BigInt(review.listingId!)||values[1]!==BigInt(s.priceRaw!)||!equal(values[2],review.recipient)
      ||!positive(s.priceRaw)||!uint(s.royaltyRaw)||!nonzero(s.seller)||equal(s.seller,review.from)||!address(s.royaltyRecipient))return false;
    const price=BigInt(s.priceRaw),royalty=BigInt(s.royaltyRaw),fee=price*200n/10_000n;
    return royalty<=price/10n&&BigInt(review.value)===price&&args.listingId===values[0]&&equal(args.buyer,review.from)&&equal(args.recipient,review.recipient)
      &&args.totalPrice===price&&args.platformFee===fee&&equal(args.royaltyRecipient,s.royaltyRecipient)&&args.royaltyAmount===royalty&&args.sellerProceeds===price-fee-royalty;
  }
  if(review.action==='cancel') {
    return (decoded.functionName==='cancelTo'&&values[0]===BigInt(review.listingId!)&&equal(values[1],review.recipient)
      ||decoded.functionName==='cancel'&&values[0]===BigInt(review.listingId!)&&equal(review.recipient,review.from))
      &&equal(s.seller,review.from)&&args.listingId===BigInt(review.listingId!)&&equal(args.seller,review.from)&&equal(args.recipient,review.recipient);
  }
  return decoded.functionName==='claimTo'&&equal(values[0],review.recipient)&&positive(s.claimRaw)
    &&equal(args.account,review.from)&&equal(args.recipient,review.recipient)&&typeof args.amount==='bigint'&&args.amount>0n;
}

/** Pure receipt evidence only. The caller must independently fetch/recheck the
 * canonical block and bind the submitted hash to its owned review. No lookup,
 * signature, broadcast, confirmation-depth or finality claim happens here.
 */
export function matchesReviewedNftReceipt(input:{review:ReviewedNftExecutionReview;manifest:ReviewedNftManifest;transaction:unknown;receipt:unknown}):ReviewedNftReceiptEvidence|null {
  try {
    const parsed=reviewedNftExecutionReviewSchema.safeParse(input.review);
    if(!parsed.success)return null;
    const wire=parsed.data,manifest=parseReviewedNftManifest(reviewedNftManifestJson(input.manifest));
    if(!equal(wire.registry,manifest.registry.address)||wire.network.mode!==manifest.mode)return null;
    const review=reviewedCall(wire,manifest);if(!review)return null;
    if(!object(review)||!object(review.summary)||!['list','buy','cancel','claim'].includes(review.action)||!uint(review.value)||!uint(review.nonce)
      ||!nonzero(review.from)||!nonzero(review.to)||!nonzero(review.recipient)||equal(review.recipient,manifest.marketplace.address)&&review.action!=='list'
      ||!equal(review.marketplace,manifest.marketplace.address)||review.chainId!==manifest.chainId||review.deploymentId!==reviewedNftManifestId(manifest)
      ||!data(review.data)||review.data.length>32_770||review.action!=='buy'&&review.value!=='0')return null;
    if(review.action==='claim') {
      if(!equal(review.to,manifest.marketplace.address)||review.collection!==null||review.tokenId!==null||review.listingId!==null)return null;
    } else if(!nonzero(review.collection)||!uint(review.tokenId)||review.action!=='list'&&!positive(review.listingId)
      ||!equal(review.to,review.action==='list'?review.collection:manifest.marketplace.address))return null;
    const found=header(review,input.transaction,input.receipt);
    if(!found||BigInt(found.blockNumber)<manifest.startBlock)return null;
    if(found.status==='reverted')return found.logs.length===0?{status:found.status,blockNumber:found.blockNumber,blockHash:found.blockHash}:null;
    const marketLogs=found.logs.filter(log=>equal(log.address,manifest.marketplace.address));
    if(marketLogs.length!==1)return null;
    const market=event(marketLogs[0],REVIEWED_NFT_MARKETPLACE_ABI),expected={list:'Listed',buy:'Sold',cancel:'Cancelled',claim:'Claimed'};
    if(!market||market.name!==expected[review.action])return null;
    if(!(review.action==='list'?listed(review,manifest,market.args):settlement(review,market.args)))return null;
    if(review.action!=='claim') {
      const transfers: {from:Address;to:Address;index:bigint}[]=[];
      for(const log of found.logs.filter(log=>equal(log.address,review.collection))) {
        if(!equal(log.topics[0],encodeEventTopics({abi:nftAbi,eventName:'Transfer'})[0]))continue;
        const transfer=event(log,nftAbi);if(!transfer)return null;
        if(transfer.args.tokenId===BigInt(review.tokenId!))transfers.push({from:transfer.args.from as Address,to:transfer.args.to as Address,index:log.logIndex});
      }
      const from=review.action==='list'?review.from:manifest.marketplace.address,to=review.action==='list'?manifest.marketplace.address:review.recipient;
      if(transfers.length===0||!equal(transfers[0].from,from)||!equal(transfers[0].to,to)||transfers[0].index>=marketLogs[0].logIndex)return null;
      if(review.action==='list'&&transfers.length!==1)return null;
      for(let index=1;index<transfers.length;index++) {
        if(!equal(transfers[index].from,transfers[index-1].to)||equal(transfers[index].from,manifest.marketplace.address)||transfers[index].index>=marketLogs[0].logIndex)return null;
      }
    }
    return{status:found.status,blockNumber:found.blockNumber,blockHash:found.blockHash,
      ...(review.action==='claim'?{actualClaimRaw:(market.args.amount as bigint).toString()}:{}),
      ...(review.action==='list'?{listingId:(market.args.listingId as bigint).toString()}:{}),
    };
  } catch {return null;}
}
