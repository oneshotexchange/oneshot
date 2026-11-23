import { describe,expect,it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, hashTypedData, parseAbi, parseAbiParameters, zeroAddress, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { parseReviewedNftManifest, reviewedNftManifestId } from '../../../../packages/evm/src/reviewed-nft';
import { REVIEWED_NFT_MARKETPLACE_ABI } from '../../../../packages/evm/src/reviewed-nft-abi';
import { reviewedNftExecutionReviewSchema, type ReviewedNftExecutionReview } from '../../../web/lib/reviewed-nft-execution';
import { matchesReviewedNftReceipt } from './reviewed-nft-receipt';

const address=(v:string)=>`0x${v.repeat(40)}` as Address,hash=(v:string)=>`0x${v.repeat(64)}` as Hex;
const factory=address('1'),registry=address('2'),marketplace=address('3'),seller=address('4'),buyer=address('5'),royalty=address('6'),recipient=address('7'),collection=address('8'),third=address('9');
const manifest=parseReviewedNftManifest({schemaVersion:1,deploymentVersion:'oneshot-reviewed-erc721-v1',mode:'local',chainId:31337,genesisHash:hash('1'),startBlock:'1',anchorHash:hash('1'),
  oneshotFactory:{address:factory,codeHash:hash('2')},registry:{address:registry,codeHash:hash('3')},marketplace:{address:marketplace,codeHash:hash('4')},
  treasury:address('a'),reviewAuthority:address('b'),registrySalt:hash('5'),marketplaceSalt:hash('6')});
const nftAbi=parseAbi(['function safeTransferFrom(address from,address to,uint256 tokenId,bytes data)','event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
const parameters=parseAbiParameters('address seller,address collection,uint256 tokenId,uint256 totalPrice,address royaltyRecipient,uint256 royaltyAmount,uint256 reviewVersion,uint256 nonce,uint256 deadline,uint256 chainId,address marketplace,bytes32 deploymentSalt');
const listingTypes={ListingIntent:parameters.map(p=>({name:p.name!,type:p.type}))};
const quantity=(v:number)=>`0x${v.toString(16)}`;
type RawLog={address:Address;data:Hex;topics:unknown[];blockNumber:string;blockHash:Hex;transactionHash:Hex;transactionIndex:string;logIndex:string;removed:boolean};
function event(abi:Abi,name:string,args:Record<string,unknown>,source:Address,index:number):RawLog {
  const definition=abi.find(v=>v.type==='event'&&v.name===name) as AbiEvent,fields=definition.inputs.filter(v=>!v.indexed);
  return{address:source,data:encodeAbiParameters(fields,fields.map(v=>args[v.name!])),topics:encodeEventTopics({abi:[definition],eventName:name,args}),
    blockNumber:'0xa',blockHash:hash('b'),transactionHash:hash('a'),transactionIndex:'0x2',logIndex:quantity(index),removed:false};
}
const transfer=(from:Address,to:Address,index=1,tokenId=0n)=>event(nftAbi,'Transfer',{from,to,tokenId},collection,index);
const trade={collection,tokenId:'0',seller,totalPriceRaw:'101',platformFeeRaw:'2',royaltyRecipient:royalty,royaltyRaw:'7',sellerProceedsRaw:'92',reviewVersion:'1',runtimeCodeHash:hash('c')};
function fixture(action:ReviewedNftExecutionReview['action']='buy') {
  const base={schemaVersion:1,kind:'reviewed-external-nft-execution',id:'11111111-1111-4111-8111-111111111111',reviewHash:'a'.repeat(64),
    deploymentId:reviewedNftManifestId(manifest),chainId:31337,network:{mode:'local',chainId:31337,name:'Local Anvil',nativeSymbol:'ETH',nativeDecimals:18},marketplace,registry,
    from:action==='buy'?buyer:seller,to:action==='list'?collection:marketplace,data:'0x',value:action==='buy'?'101':'0',nonce:'7',expiresAt:'2026-11-21T00:00:00.000Z',
    simulation:{blockNumber:'9',blockHash:hash('e'),blockTimestamp:'100',gasEstimate:'200000'}};
  let raw:unknown,args:Record<string,unknown>,logs:RawLog[];
  if(action==='list') {
    const intent={seller,collection,tokenId:'0',totalPrice:'101',royaltyRecipient:royalty,royaltyAmount:'7',reviewVersion:'1',nonce:'2',deadline:'2000',chainId:31337,marketplace,deploymentSalt:manifest.marketplaceSalt};
    const encoded=encodeAbiParameters(parameters,[seller,collection,0n,101n,royalty,7n,1n,2n,2000n,31337n,marketplace,manifest.marketplaceSalt]);
    const intentHash=hashTypedData({domain:{name:'OneshotReviewedMarketplace',version:'1',chainId:31337,verifyingContract:marketplace},primaryType:'ListingIntent',types:listingTypes,
      message:{...intent,tokenId:0n,totalPrice:101n,royaltyAmount:7n,reviewVersion:1n,nonce:2n,deadline:2000n,chainId:31337n}});
    raw={...base,action,terms:{...trade,intent,intentHash},data:encodeFunctionData({abi:nftAbi,functionName:'safeTransferFrom',args:[seller,marketplace,0n,encoded]})};
    args={listingId:123n,collection,tokenId:0n,seller,totalPrice:101n,royaltyRecipient:royalty,royaltyAmount:7n,reviewVersion:1n,runtimeCodeHash:trade.runtimeCodeHash,intentHash};
    logs=[transfer(seller,marketplace),event(REVIEWED_NFT_MARKETPLACE_ABI,'Listed',args,marketplace,2)];
  } else if(action==='buy') {
    raw={...base,action,terms:{...trade,listingId:'123',recipient},data:encodeFunctionData({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'buy',args:[123n,101n,recipient]})};
    args={listingId:123n,buyer,recipient,totalPrice:101n,platformFee:2n,royaltyRecipient:royalty,royaltyAmount:7n,sellerProceeds:92n};
    logs=[transfer(marketplace,recipient),event(REVIEWED_NFT_MARKETPLACE_ABI,'Sold',args,marketplace,2)];
  } else if(action==='cancel') {
    raw={...base,action,terms:{collection,tokenId:'0',listingId:'123',seller,recipient},data:encodeFunctionData({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'cancelTo',args:[123n,recipient]})};
    args={listingId:123n,seller,recipient};logs=[transfer(marketplace,recipient),event(REVIEWED_NFT_MARKETPLACE_ABI,'Cancelled',args,marketplace,2)];
  } else {
    raw={...base,action,terms:{account:seller,recipient,amountRaw:'100',allPending:true},data:encodeFunctionData({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'claimTo',args:[recipient]})};
    args={account:seller,recipient,amount:100n};logs=[event(REVIEWED_NFT_MARKETPLACE_ABI,'Claimed',args,marketplace,1)];
  }
  const review=reviewedNftExecutionReviewSchema.parse(raw);
  const transaction:Record<string,unknown>={hash:hash('a'),blockNumber:'0xa',blockHash:hash('b'),transactionIndex:'0x2',nonce:'0x7',chainId:'0x7a69',from:review.from,to:review.to,input:review.data,value:action==='buy'?'0x65':'0x0'};
  const receipt:Record<string,unknown>={transactionHash:hash('a'),blockNumber:'0xa',blockHash:hash('b'),transactionIndex:'0x2',from:review.from,to:review.to,status:'0x1',contractAddress:null,logs};
  return{review,manifest,transaction,receipt,args,logs};
}
const match=(f:ReturnType<typeof fixture>)=>matchesReviewedNftReceipt(f);
function replaceEvent(f:ReturnType<typeof fixture>,patch:Record<string,unknown>) {
  const names={list:'Listed',buy:'Sold',cancel:'Cancelled',claim:'Claimed'},index=f.review.action==='claim'?1:2;
  const replacement=event(REVIEWED_NFT_MARKETPLACE_ABI,names[f.review.action],{...f.args,...patch},marketplace,index);
  f.receipt.logs=[...(f.review.action==='claim'?[]:[f.logs[0]]),replacement];
}

describe('exact reviewed external NFT transaction receipts',()=>{
  it.each(['list','buy','cancel','claim'] as const)('confirms %s only from its exact reviewed transaction and settlement',action=>{
    const f=fixture(action),evidence=match(f);
    expect(evidence).toMatchObject({status:'confirmed',blockNumber:'10',blockHash:hash('b')});
    if(action==='list')expect(evidence?.listingId).toBe('123');
    if(action==='claim')expect(evidence?.actualClaimRaw).toBe('100');
  });
  it('binds to the native factory/registry/market deployment without accepting a native manifest alias',()=>{
    const f=fixture();
    for(const patch of [{deploymentId:'f'.repeat(64)},{marketplace:third},{registry:third},{chainId:84532}])expect(match({...f,review:{...f.review,...patch} as ReviewedNftExecutionReview})).toBeNull();
    expect(match({...f,manifest:{...manifest,marketplaceSalt:hash('f')}})).toBeNull();
  });
  it.each(['from','to','input','value','nonce','chainId','hash','blockHash','blockNumber','transactionIndex'])('rejects a changed transaction %s',field=>{
    const f=fixture(),replacement:Record<string,unknown>={from:third,to:third,input:'0x1234',value:'0x66',nonce:'0x8',chainId:'0x14a34',hash:hash('f'),blockHash:hash('f'),blockNumber:'0xb',transactionIndex:'0x3'};
    f.transaction[field]=replacement[field];expect(match(f)).toBeNull();
  });
  it.each(['from','to','transactionHash','blockHash','blockNumber','transactionIndex','status','contractAddress'])('rejects contradictory receipt %s',field=>{
    const f=fixture(),replacement:Record<string,unknown>={from:third,to:third,transactionHash:hash('f'),blockHash:hash('f'),blockNumber:'0xb',transactionIndex:'0x3',status:'success',contractAddress:third};
    f.receipt[field]=replacement[field];expect(match(f)).toBeNull();
  });
  it.each(['0x00','0x01','0x-1',null,10])('rejects malformed mined quantities %s',value=>{
    const f=fixture();f.receipt.blockNumber=value;f.transaction.blockNumber=value;expect(match(f)).toBeNull();
  });
  it.each(['list','buy','cancel','claim'] as const)('distinguishes reverted %s without making settlement claims',action=>{
    const f=fixture(action);f.receipt.status='0x0';f.receipt.logs=[];
    expect(match(f)).toEqual({status:'reverted',blockNumber:'10',blockHash:hash('b')});
    f.receipt.logs=f.logs;expect(match(f)).toBeNull();
  });
  it('accepts a same-height replacement fork using the exact reviewed account nonce',()=>{
    const f=fixture();f.review.simulation.blockNumber='10';f.review.simulation.blockHash=hash('e');
    expect(match(f)?.status).toBe('confirmed');f.transaction.nonce='0x6';expect(match(f)).toBeNull();
  });
  it.each([{address:third},{removed:true},{removed:undefined},{transactionHash:hash('f')},{blockHash:hash('f')},{blockNumber:'0xb'},{transactionIndex:'0x3'},{logIndex:'0x01'},{data:'0x0'},{topics:[hash('1'),hash('2'),hash('3'),hash('4'),hash('5')]}])('rejects changed transfer provenance/encoding %j',patch=>{
    const f=fixture();f.receipt.logs=[{...f.logs[0],...patch},f.logs[1]];expect(match(f)).toBeNull();
  });
  it('validates unrelated callback log metadata, duplicates and receipt log order too',()=>{
    const f=fixture(),foreign={...f.logs[0],address:third,data:'0x' as Hex,topics:[],logIndex:'0x0'};
    f.receipt.logs=[foreign,...f.logs];expect(match(f)?.status).toBe('confirmed');
    f.receipt.logs=[{...foreign,transactionHash:hash('f')},...f.logs];expect(match(f)).toBeNull();
    f.receipt.logs=[f.logs[0],f.logs[0],f.logs[1]];expect(match(f)).toBeNull();
    f.receipt.logs=[f.logs[1],f.logs[0]];expect(match(f)).toBeNull();
  });
  it.each(['list','buy','cancel','claim'] as const)('requires exactly one %s marketplace settlement',action=>{
    const f=fixture(action),last=f.logs.at(-1)!;
    f.receipt.logs=f.logs.slice(0,-1);expect(match(f)).toBeNull();
    f.receipt.logs=[...f.logs,{...last,logIndex:'0x3'}];expect(match(f)).toBeNull();
    f.receipt.logs=[...f.logs.slice(0,-1),{...last,address:third}];expect(match(f)).toBeNull();
    f.receipt.logs=[...f.logs.slice(0,-1),{...last,data:(last.data+'00') as Hex}];expect(match(f)).toBeNull();
  });
  it.each(['buy','cancel'] as const)('allows the recipient to forward or burn %s delivery before settlement',action=>{
    const f=fixture(action),settled={...f.logs[1],logIndex:'0x3'};
    f.receipt.logs=[f.logs[0],transfer(recipient,third,2),settled];expect(match(f)?.status).toBe('confirmed');
    f.receipt.logs=[f.logs[0],transfer(recipient,zeroAddress,2),settled];expect(match(f)?.status).toBe('confirmed');
    f.receipt.logs=[f.logs[0],transfer(third,recipient,2),settled];expect(match(f)).toBeNull();
    f.receipt.logs=[f.logs[0],f.logs[1],transfer(recipient,third,3)];expect(match(f)).toBeNull();
  });
  it('does not accept a sold/listed item without the exact item transfer',()=>{
    const f=fixture();
    f.receipt.logs=[transfer(marketplace,recipient,1,1n),f.logs[1]];expect(match(f)).toBeNull();
    f.receipt.logs=[transfer(seller,recipient),f.logs[1]];expect(match(f)).toBeNull();
    f.receipt.logs=[transfer(marketplace,third),f.logs[1]];expect(match(f)).toBeNull();
  });
  it('requires the item to remain in listing custody throughout the listing transaction',()=>{
    const f=fixture('list');f.receipt.logs=[...f.logs,transfer(marketplace,third,3)];expect(match(f)).toBeNull();
  });
  it.each([{listingId:0n},{collection:third},{tokenId:1n},{seller:third},{totalPrice:102n},{royaltyRecipient:third},{royaltyAmount:8n},{reviewVersion:2n},{runtimeCodeHash:hash('f')},{intentHash:hash('f')}])('binds every Listed field %#',patch=>{
    const f=fixture('list');replaceEvent(f,patch);expect(match(f)).toBeNull();
  });
  it('returns the actual allocated listing ID instead of assuming the review owned the global counter',()=>{
    const f=fixture('list');replaceEvent(f,{listingId:124n});expect(match(f)?.listingId).toBe('124');
  });
  it('binds every full intent field and canonical transfer calldata to the reviewed list intent',()=>{
    const fields={seller:third,collection:third,tokenId:'1',totalPrice:'102',royaltyRecipient:third,royaltyAmount:'8',reviewVersion:'2',nonce:'3',deadline:'2001',chainId:84532,marketplace:third,deploymentSalt:hash('f')};
    for(const [key,value] of Object.entries(fields)) {
      const f=fixture('list');if(f.review.action!=='list')throw new Error();
      (f.review.terms.intent as Record<string,unknown>)[key]=value;expect(match(f),key).toBeNull();
    }
    const f=fixture('list');f.transaction.input=f.review.data+'00';f.review.data=f.transaction.input as Hex;expect(match(f)).toBeNull();
  });
  it.each([{listingId:124n},{buyer:third},{recipient:third},{totalPrice:102n},{platformFee:3n},{royaltyRecipient:third},{royaltyAmount:8n},{sellerProceeds:91n}])('binds every Sold settlement field %#',patch=>{
    const f=fixture();replaceEvent(f,patch);expect(match(f)).toBeNull();
  });
  it('matches a full uint256 sparse token ID and exact price above Number.MAX_SAFE_INTEGER',()=>{
    const f=fixture(),price=9_007_199_254_741_093n,fee=price*200n/10_000n,royalty=price/10n,id=(2n**256n-1n).toString();
    if(f.review.action!=='buy')throw new Error();
    f.review.terms={...f.review.terms,tokenId:id,totalPriceRaw:price.toString(),platformFeeRaw:fee.toString(),royaltyRaw:royalty.toString(),sellerProceedsRaw:(price-fee-royalty).toString()};
    f.review.value=price.toString();f.review.data=encodeFunctionData({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'buy',args:[123n,price,recipient]});
    f.transaction.input=f.review.data;f.transaction.value=`0x${price.toString(16)}`;
    f.receipt.logs=[transfer(marketplace,recipient,1,BigInt(id)),event(REVIEWED_NFT_MARKETPLACE_ABI,'Sold',{...f.args,totalPrice:price,platformFee:fee,royaltyAmount:royalty,sellerProceeds:price-fee-royalty},marketplace,2)];
    expect(match(f)?.status).toBe('confirmed');
  });
  it('allows the cancel shorthand only when delivery returns to the seller',()=>{
    const f=fixture('cancel');if(f.review.action!=='cancel')throw new Error();
    f.review.terms.recipient=seller;f.review.data=encodeFunctionData({abi:REVIEWED_NFT_MARKETPLACE_ABI,functionName:'cancel',args:[123n]});f.transaction.input=f.review.data;
    f.receipt.logs=[transfer(marketplace,seller),event(REVIEWED_NFT_MARKETPLACE_ABI,'Cancelled',{listingId:123n,seller,recipient:seller},marketplace,2)];expect(match(f)?.status).toBe('confirmed');
    f.review.terms.recipient=recipient;expect(match(f)).toBeNull();
  });
  it.each([{listingId:124n},{seller:third},{recipient:third}])('binds every Cancelled field %#',patch=>{
    const f=fixture('cancel');replaceEvent(f,patch);expect(match(f)).toBeNull();
  });
  it('confirms actual all-pending claims after intervening credits or withdrawals',()=>{
    for(const amount of [1n,99n,101n,2n**200n]) {
      const f=fixture('claim');replaceEvent(f,{amount});expect(match(f)?.actualClaimRaw).toBe(amount.toString());
    }
    const f=fixture('claim');replaceEvent(f,{amount:0n});expect(match(f)).toBeNull();
  });
  it.each([{account:third},{recipient:third}])('requires the exact claim account/recipient %j',patch=>{
    const f=fixture('claim');replaceEvent(f,patch);expect(match(f)).toBeNull();
  });
  it('does not relax calldata or review field binding for a reverted transaction',()=>{
    const f=fixture('claim');f.receipt.status='0x0';f.receipt.logs=[];
    f.transaction.input='0x12345678';f.review.data='0x12345678';expect(match(f)).toBeNull();
  });
});
