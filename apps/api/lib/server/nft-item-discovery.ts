import {createHash} from 'node:crypto';
import type {NextRequest} from 'next/server';
import {parseAssetAmount,type IndexedNftContext,type IndexedNftItem,type IndexedListing,type IndexedNftPresentation} from '@oneshot/evm';
import {isAddress,isHash,manifestId} from '../../../indexer/src/manifest';
import type {Manifest} from '../../../indexer/src/types';
import type {SqlClient} from '../../../indexer/src/store';
import {ApiError} from './errors';
import {loadNftMetadataCatalog} from './nft-metadata-catalog';

type Trait={trait_type:string;value:string|number};
export type NftExplorerSelection={collection:string;q:string;serial:string|null;availability:'all'|'listed'|'unlisted';owner:string|null;minPrice:string|null;maxPrice:string|null;sort:'serial-asc'|'serial-desc'|'price-asc'|'price-desc';traits:Trait[];limit:number;cursor:string|null;scope:string};
type Cursor={v:1;manifest:string;block:string;hash:string;collection:string;scope:string;limit:number;after:string[];catalog:string|null};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const invalid=():never=>{throw new ApiError(503,'NFT_EXPLORER_DATA_INVALID','Collection items are temporarily unavailable. Refresh this collection and try again.');};
const bad=():never=>{throw new ApiError(400,'NFT_EXPLORER_INPUT_INVALID','Check the item search, filters or page selection and try again.');};
const stale=():never=>{throw new ApiError(409,'CURSOR_STALE','The collection changed. Refresh these items from the beginning.');};
const uint=(value:unknown,positive=false):string=>typeof value==='string'&&/^(0|[1-9]\d{0,77})$/.test(value)&&BigInt(value)<2n**256n&&(!positive||value!=='0')?value:invalid();
const addr=(value:unknown):string=>isAddress(value)&&!/^0x0{40}$/i.test(value)?value.toLowerCase():invalid();
const key=(trait:Trait)=>JSON.stringify([trait.trait_type,trait.value]);
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
export function parseNftExplorerSelection(request:NextRequest,collection:string):NftExplorerSelection{
  const query=request.nextUrl.searchParams,allowed=['q','availability','owner','minPrice','maxPrice','sort','traits','limit','cursor'];
  for(const name of query.keys())if(!allowed.includes(name)||query.getAll(name).length!==1)return bad();
  const q=(query.get('q')??'').trim();if(q.length>100||/[\u0000-\u001f\u007f]/.test(q))return bad();
  const serial=/^#?[1-9]\d{0,77}$/.test(q)?q.replace(/^#/,''):null;if(serial&&BigInt(serial)>=2n**256n)return bad();
  const availability=query.get('availability')??'all';if(!['all','listed','unlisted'].includes(availability))return bad();
  const owner=query.get('owner')?.toLowerCase()??null;if(owner&&(!isAddress(owner)||/^0x0{40}$/.test(owner))||query.has('owner')&&!owner)return bad();
  const price=(name:string)=>{const text=query.get(name);if(text===null)return null;try{if(text.length>118)return bad();return parseAssetAmount(text,18).toString();}catch{return bad();}};
  const minPrice=price('minPrice'),maxPrice=price('maxPrice'),sort=query.get('sort')??'serial-asc';
  if(!['serial-asc','serial-desc','price-asc','price-desc'].includes(sort)||minPrice!==null&&maxPrice!==null&&BigInt(minPrice)>BigInt(maxPrice)||availability!=='listed'&&(minPrice!==null||maxPrice!==null||sort.startsWith('price-')))return bad();
  const limitText=query.get('limit')??'20';if(!/^[1-9]\d?$/.test(limitText)||Number(limitText)>50)return bad();const limit=Number(limitText);
  const cursor=query.get('cursor');if(cursor!==null&&(!cursor||cursor.length>2048||!/^[\w-]+$/.test(cursor)))return bad();
  let traits:Trait[]=[];const raw=query.get('traits');
  if(raw!==null){try{
    if(!raw||raw.length>4096||!/^[\w-]+$/.test(raw))return bad();const bytes=Buffer.from(raw,'base64url');if(bytes.toString('base64url')!==raw)return bad();const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!Array.isArray(value)||value.length<1||value.length>10)return bad();
    for(const item of value){if(!object(item)||Object.keys(item).sort().join(',')!=='trait_type,value'||typeof item.trait_type!=='string'||item.trait_type.length>100||typeof item.value!=='string'&&typeof item.value!=='number'||typeof item.value==='string'&&item.value.length>200||typeof item.value==='number'&&!Number.isFinite(item.value))return bad();traits.push({trait_type:item.trait_type,value:typeof item.value==='number'&&Object.is(item.value,-0)?0:item.value});}
    traits=traits.sort((a,b)=>compare(key(a),key(b)));if(new Set(traits.map(key)).size!==traits.length||Buffer.from(JSON.stringify(traits)).toString('base64url')!==raw)return bad();
  }catch(error){if(error instanceof ApiError)throw error;return bad();}}
  const normalized={q:serial?`#${serial}`:q.toLowerCase(),availability,owner,minPrice,maxPrice,sort,traits},scope=createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return{collection,q,serial,availability:availability as NftExplorerSelection['availability'],owner,minPrice,maxPrice,sort:sort as NftExplorerSelection['sort'],traits,limit,cursor,scope};
}
function cursor(value:NftExplorerSelection,context:IndexedNftContext,catalog:string|null):Cursor|null{
  if(!value.cursor)return null;
  try{
    const bytes=Buffer.from(value.cursor,'base64url');if(bytes.toString('base64url')!==value.cursor)return bad();const parsed:unknown=JSON.parse(bytes.toString('utf8'));
    if(!object(parsed)||Object.keys(parsed).sort().join(',')!=='after,block,catalog,collection,hash,limit,manifest,scope,v'||parsed.v!==1||parsed.collection!==value.collection||parsed.scope!==value.scope||parsed.limit!==value.limit||typeof parsed.manifest!=='string'||!/^[a-f0-9]{64}$/.test(parsed.manifest)||typeof parsed.block!=='string'||!/^(0|[1-9]\d{0,77})$/.test(parsed.block)||!isHash(parsed.hash)||!Array.isArray(parsed.after)||parsed.after.length!==(value.sort.startsWith('price-')?2:1)||!parsed.after.every(item=>typeof item==='string'&&/^(0|[1-9]\d{0,77})$/.test(item))||(parsed.catalog!==null&&(typeof parsed.catalog!=='string'||!/^[a-f0-9]{64}$/.test(parsed.catalog))))return bad();
    if(parsed.manifest!==context.deploymentId||parsed.block!==context.checkpoint?.number||parsed.hash!==context.checkpoint.hash||parsed.catalog!==catalog)return stale();return parsed as Cursor;
  }catch(error){if(error instanceof ApiError)throw error;return bad();}
}
function provenance(value:Record<string,unknown>,row:Record<string,unknown>,prefix:string,manifest:Manifest,context:IndexedNftContext){
  const number=uint(value.lastBlockNumber);if(value.schemaVersion!==1||value.deploymentVersion!==manifest.deploymentVersion||value.chainId!==manifest.chainId||BigInt(number)<manifest.startBlock||BigInt(number)>BigInt(context.checkpoint!.number)||!isHash(value.lastBlockHash)||row[`${prefix}block_hash`]!==value.lastBlockHash||row[`${prefix}block_number`]!==number)return invalid();
}
/** One held SQL snapshot, at most1000 originals, and one fully verified public catalog.
 * Prices are current canonical escrow asks; metadata never comes from a private draft. */
export async function readNftExplorer(client:SqlClient,selection:NftExplorerSelection,manifest:Manifest,context:IndexedNftContext,resolve:(hash:string,serial:string)=>Promise<IndexedNftPresentation|null>){
  const deadline=Date.now()+5000,signal=AbortSignal.timeout(5000),active=()=>{if(signal.aborted||Date.now()>deadline)throw new ApiError(504,'NFT_EXPLORER_TIMEOUT','Collection items could not be checked in time. Please try again.');},identity=manifestId(manifest),collection=selection.collection;
  const collectionRow=(await client.query("SELECT p.value,j.block_number::text AS c_block_number,j.block_hash AS c_block_hash FROM oneshot_evm_projections p LEFT JOIN oneshot_evm_journal j ON j.manifest_id=p.manifest_id AND j.block_number=(p.value->>'lastBlockNumber')::numeric WHERE p.manifest_id=$1 AND p.kind='collections' AND p.entity_id=$2",[identity,collection])).rows[0];active();
  if(!collectionRow)throw new ApiError(404,'INDEXED_RECORD_NOT_FOUND','This collection is not present at the indexed checkpoint.');if(!object(collectionRow.value))return invalid();const collectionValue=collectionRow.value;
  provenance(collectionValue,collectionRow,'c_',manifest,context);if(collectionValue.address!==collection||collectionValue.factory!==manifest.factory.address||typeof collectionValue.opened!=='boolean'||typeof collectionValue.configured!=='boolean')return invalid();
  const totalMinted=uint(collectionValue.totalMinted);if(BigInt(totalMinted)>1000n)return invalid();
  const contentHash=collectionValue.contentHash;
  let catalog:Awaited<ReturnType<typeof loadNftMetadataCatalog>>=null;
  if(collectionValue.opened){
    if(!collectionValue.configured||!isHash(contentHash)||/^0x0{64}$/i.test(contentHash)||!isHash(collectionValue.termsHash))return invalid();
    const openings=(await client.query("SELECT a.value,j.block_hash FROM oneshot_evm_projections a LEFT JOIN oneshot_evm_journal j ON j.manifest_id=a.manifest_id AND j.block_number=(a.value->>'blockNumber')::numeric WHERE a.manifest_id=$1 AND a.kind='activity' AND a.value->>'source'=$2 AND a.value->>'eventName'='CollectionOpened' LIMIT 2",[identity,collection])).rows;active();
    if(openings.length!==1||!object(openings[0].value)||!object(openings[0].value.args)||openings[0].value.schemaVersion!==1||openings[0].value.deploymentVersion!==manifest.deploymentVersion||openings[0].value.chainId!==manifest.chainId||openings[0].value.source!==collection||openings[0].value.args.contentHash!==contentHash||openings[0].value.args.termsHash!==collectionValue.termsHash||openings[0].block_hash!==openings[0].value.blockHash||BigInt(uint(openings[0].value.blockNumber))<manifest.startBlock||BigInt(uint(openings[0].value.blockNumber))>BigInt(context.checkpoint!.number))return invalid();
    catalog=await loadNftMetadataCatalog(client,contentHash.slice(2).toLowerCase(),signal);active();
    if(catalog&&catalog.catalog.items.length<Number(totalMinted))return invalid();
  }else if(totalMinted!=='0')return invalid();
  if((selection.q&&!selection.serial||selection.traits.length)&&!catalog)throw new ApiError(503,'NFT_METADATA_FILTERS_UNAVAILABLE','Name and trait filters are temporarily unavailable for this collection. Clear those filters or try again later.');
  const rows=(await client.query(`SELECT p.entity_id,p.value,ij.block_number::text AS i_block_number,ij.block_hash AS i_block_hash,l.value AS listing_value,lj.block_number::text AS l_block_number,lj.block_hash AS l_block_hash,a.value AS listing_action
    FROM oneshot_evm_projections p LEFT JOIN oneshot_evm_journal ij ON ij.manifest_id=p.manifest_id AND ij.block_number=(p.value->>'lastBlockNumber')::numeric
    LEFT JOIN oneshot_evm_projections l ON l.manifest_id=p.manifest_id AND l.kind='listings' AND l.entity_id=p.value->>'activeListingId'
    LEFT JOIN oneshot_evm_journal lj ON lj.manifest_id=l.manifest_id AND lj.block_number=(l.value->>'lastBlockNumber')::numeric
    LEFT JOIN oneshot_evm_projections a ON a.manifest_id=l.manifest_id AND a.kind='activity' AND a.entity_id=(l.value->>'lastTransactionHash')||':'||(l.value->>'lastLogIndex')
    WHERE p.manifest_id=$1 AND p.kind='items' AND p.value->>'collection'=$2 AND p.value->'minted'='true'::jsonb LIMIT 1001`,[identity,collection])).rows;active();
  if(rows.length!==Number(totalMinted))return invalid();
  const serials=new Set<string>(),all:IndexedNftItem[]=[];
  for(const row of rows){
    active();if(!object(row.value))return invalid();const value=row.value,serial=uint(value.tokenId,true);provenance(value,row,'i_',manifest,context);
    if(value.collection!==collection||row.entity_id!==`${collection}:${serial}`||serials.has(serial)||BigInt(serial)>BigInt(totalMinted)||value.minted!==true||typeof value.burned!=='boolean'||(value.burned?value.owner!==null:!isAddress(value.owner)||/^0x0{40}$/i.test(value.owner)))return invalid();serials.add(serial);if(value.burned)continue;
    let listing:IndexedListing|null=null;const stored=row.listing_value;
    if(object(stored)&&stored.status==='active'&&stored.collection===collection&&stored.tokenId===serial&&stored.listingId===value.activeListingId&&value.owner===manifest.marketplace.address){
      provenance(stored,row,'l_',manifest,context);const action=row.listing_action;
      if(!object(action)||!object(action.args)||action.schemaVersion!==1||action.deploymentVersion!==manifest.deploymentVersion||action.chainId!==manifest.chainId||action.eventName!=='Listed'||action.source!==manifest.marketplace.address||action.blockNumber!==stored.lastBlockNumber||action.blockHash!==stored.lastBlockHash||action.transactionHash!==stored.lastTransactionHash||action.logIndex!==stored.lastLogIndex||action.args.collection!==collection||action.args.tokenId!==serial||action.args.listingId!==stored.listingId||action.args.seller!==stored.seller||action.args.totalPrice!==stored.totalPrice)return invalid();
      listing={id:uint(stored.listingId,true),collection,tokenId:serial,seller:addr(stored.seller),totalPriceRaw:uint(stored.totalPrice,true),status:'active',buyer:null,recipient:null,platformFeeRaw:null,royaltyRaw:null,sellerProceedsRaw:null};
    }
    all.push({id:String(row.entity_id),collection,tokenId:serial,owner:addr(value.owner),burned:false,listing,presentation:catalog?.presentations.get(serial)??null});
  }
  const facets=new Map<string,{trait_type:string;value:string|number;count:bigint}>();
  if(catalog)for(const item of all){const presentation=catalog.presentations.get(item.tokenId);if(!presentation)return invalid();for(const encoded of new Set(presentation.attributes.map(key))){const trait=JSON.parse(encoded) as [string,string|number],previous=facets.get(encoded);facets.set(encoded,{trait_type:trait[0],value:trait[1],count:(previous?.count??0n)+1n});}}
  const facetRows=[...facets].sort(([a],[b])=>compare(a,b)),types=new Set<string>(),perType=new Map<string,number>(),visible:{trait_type:string;value:string|number;count:string}[]=[];let facetsTruncated=false;
  for(const[,facet]of facetRows){active();if(!types.has(facet.trait_type)){if(types.size>=32){facetsTruncated=true;continue;}types.add(facet.trait_type);}const count=perType.get(facet.trait_type)??0;if(count>=30){facetsTruncated=true;continue;}perType.set(facet.trait_type,count+1);visible.push({...facet,count:facet.count.toString()});}
  const traitGroups=new Map<string,Set<string>>();for(const trait of selection.traits){if(!traitGroups.has(trait.trait_type))traitGroups.set(trait.trait_type,new Set());traitGroups.get(trait.trait_type)!.add(key(trait));}
  const matches=all.filter(item=>{
    if(selection.serial?item.tokenId!==selection.serial:selection.q&&!item.presentation!.name.toLowerCase().includes(selection.q.toLowerCase()))return false;
    if(selection.availability==='listed'&&!item.listing||selection.availability==='unlisted'&&item.listing)return false;
    if(selection.owner&&(item.listing?.seller??item.owner)!==selection.owner)return false;
    if(selection.minPrice!==null&&(!item.listing||BigInt(item.listing.totalPriceRaw)<BigInt(selection.minPrice))||selection.maxPrice!==null&&(!item.listing||BigInt(item.listing.totalPriceRaw)>BigInt(selection.maxPrice)))return false;
    const attributes=new Set((item.presentation?.attributes??[]).map(key));for(const group of traitGroups.values())if(![...group].some(value=>attributes.has(value)))return false;return true;
  });
  matches.sort((a,b)=>{if(selection.sort.startsWith('price-')){const left=BigInt(a.listing!.totalPriceRaw),right=BigInt(b.listing!.totalPriceRaw);if(left!==right)return(left<right?-1:1)*(selection.sort==='price-asc'?1:-1);}const left=BigInt(a.tokenId),right=BigInt(b.tokenId);return(left<right?-1:left>right?1:0)*(selection.sort==='serial-desc'?-1:1);});
  const after=(item:IndexedNftItem)=>selection.sort.startsWith('price-')?[item.listing!.totalPriceRaw,item.tokenId]:[item.tokenId],catalogId=catalog?.catalog.manifestHash??null,previous=cursor(selection,context,catalogId);let start=0;
  if(previous){const index=matches.findIndex(item=>JSON.stringify(after(item))===JSON.stringify(previous.after));if(index<0)return bad();start=index+1;}
  const items=matches.slice(start,start+selection.limit),hasMore=start+items.length<matches.length,nextCursor=hasMore?Buffer.from(JSON.stringify({v:1,manifest:identity,block:context.checkpoint!.number,hash:context.checkpoint!.hash,collection,scope:selection.scope,limit:selection.limit,after:after(items.at(-1)!),catalog:catalogId} satisfies Cursor)).toString('base64url'):null;
  if(!catalog&&typeof contentHash==='string')for(const item of items){active();item.presentation=await resolve(contentHash,item.tokenId);}
  active();return{context,collection,items,nextCursor,discovery:{totalItems:String(all.length),matchingItems:String(matches.length),metadataFilters:{available:!!catalog,reason:catalog?null:'Name and trait filters are unavailable until this collection’s committed metadata is ready.'},facets:visible,facetsTruncated,facetScope:'minted-unburned-collection' as const}};
}
