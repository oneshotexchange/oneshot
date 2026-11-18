import {createHash} from 'node:crypto';
import type {IndexedNftPresentation} from '@oneshot/evm';
import {metadataItemSchema} from '../../../web/lib/oneshot-draft-schema';
import {isPublicMetadataOrigin} from '../../../web/lib/oneshot-origin';
import {ApiError} from './errors';
import {getRecord,putIfAbsent,compareAndSetRecord} from './store';
import {readMedia} from './media';
import {verifiedNftSnapshot} from './nft-snapshot';
import type {SqlClient} from '../../../indexer/src/store';

export const NFT_METADATA_CATALOG_NAMESPACE='oneshot_nft_catalogs';
export const NFT_METADATA_CATALOG_LIMITS={items:1000,itemBytes:256*1024,metadataBytes:20*1024*1024,recordBytes:48*1024*1024} as const;
export type NftMetadataCatalog={schemaVersion:1;manifestHash:string;items:{serial:number;metadataJson:string}[]};
type Snapshot=ReturnType<typeof verifiedNftSnapshot>;
type CatalogDependencies={record:(namespace:string,id:string)=>Promise<unknown>;media:(id:string,record:unknown,maximumBytes:number,signal:AbortSignal)=>Promise<{buffer:Buffer;mimeType:string}>;write:(catalog:NftMetadataCatalog,signal?:AbortSignal)=>Promise<NftMetadataCatalog>;signal?:AbortSignal};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw new ApiError(503,'NFT_CATALOG_INVALID','Collection metadata filters are temporarily unavailable. Please refresh this collection later.');};
function active(signal?:AbortSignal){if(signal?.aborted)throw new ApiError(504,'NFT_CATALOG_TIMEOUT','Collection metadata filters could not be checked in time. Please try again.');}
/** Bound pending I/O too, even if its transport does not settle after cancellation.
 * A late result cannot resume this workflow. Already-dispatched mutations are not undone. */
async function bounded<T>(signal:AbortSignal,operation:()=>Promise<T>):Promise<T>{
  active(signal);let abort:()=>void=()=>{};
  const interrupted=new Promise<never>((_resolve,reject)=>{
    abort=()=>{try{active(signal);}catch(error){reject(error);}};
    signal.addEventListener('abort',abort,{once:true});
  });
  try{
    active(signal);
    const pending=Promise.resolve().then(()=>{active(signal);return operation();});
    const result=await Promise.race([pending,interrupted]);active(signal);return result;
  }finally{signal.removeEventListener('abort',abort);}
}
function snapshot(value:unknown,manifestHash:string){try{return verifiedNftSnapshot(value,manifestHash);}catch{return fail();}}

/** Every original JSON byte string is rehashed against the immutable serial map.
 * This catalog is never authoritative without the canonical opened contentHash. */
export function verifyNftMetadataCatalog(value:unknown,manifestHash:string,committed:Snapshot,signal?:AbortSignal):NftMetadataCatalog{
  active(signal);const proof=snapshot(committed,manifestHash);
  if(!object(value)||Object.keys(value).sort().join(',')!=='items,manifestHash,schemaVersion'||value.schemaVersion!==1||value.manifestHash!==manifestHash||!Array.isArray(value.items)||value.items.length!==proof.items.length||value.items.length>NFT_METADATA_CATALOG_LIMITS.items)return fail();
  let bytes=0;
  for(let index=0;index<value.items.length;index++){
    active(signal);const item=value.items[index],expected=proof.items[index];
    if(!object(item)||Object.keys(item).sort().join(',')!=='metadataJson,serial'||item.serial!==index+1||typeof item.metadataJson!=='string')return fail();
    const size=Buffer.byteLength(item.metadataJson);bytes+=size;
    if(size>NFT_METADATA_CATALOG_LIMITS.itemBytes||bytes>NFT_METADATA_CATALOG_LIMITS.metadataBytes||createHash('sha256').update(item.metadataJson,'utf8').digest('hex')!==expected.metadataHash)return fail();
    let parsed:unknown;try{parsed=JSON.parse(item.metadataJson);}catch{return fail();}
    const metadata=metadataItemSchema.safeParse(parsed);if(!metadata.success)return fail();
    let image:URL;try{image=new URL(metadata.data.image);}catch{return fail();}
    if(!isPublicMetadataOrigin(image.origin)||image.username||image.password||image.search||image.hash||image.pathname!==`/api/media/${expected.imageHash}.webp`)return fail();
  }
  active(signal);
  if(Buffer.byteLength(JSON.stringify(value))>NFT_METADATA_CATALOG_LIMITS.recordBytes)return fail();
  return value as NftMetadataCatalog;
}
export function buildNftMetadataCatalog(manifestHash:string,committed:Snapshot,items:NftMetadataCatalog['items'],signal?:AbortSignal){
  const catalog:NftMetadataCatalog={schemaVersion:1,manifestHash,items:items.map(item=>({serial:item.serial,metadataJson:item.metadataJson}))};
  return verifyNftMetadataCatalog(catalog,manifestHash,committed,signal);
}
/** Presentation derives only from already verified original metadata. Never reads a private draft. */
export function nftCatalogPresentations(catalog:NftMetadataCatalog,committed:Snapshot,signal?:AbortSignal):Map<string,IndexedNftPresentation>{
  const map=new Map<string,IndexedNftPresentation>();
  for(const item of catalog.items){active(signal);const metadata=metadataItemSchema.parse(JSON.parse(item.metadataJson)),expected=committed.items[item.serial-1];map.set(String(item.serial),{manifestHash:catalog.manifestHash,tokenId:String(item.serial),name:metadata.name,description:metadata.description??'',imagePath:`/api/media/${expected.imageHash}.webp`,metadataPath:`/api/oneshot/metadata/${catalog.manifestHash}/${item.serial}`,attributes:(metadata.attributes??[]).map(value=>({trait_type:value.trait_type,value:value.value}))});}
  return map;
}
/** Publish an immutable derived copy. A corrupt existing copy requires explicit independently verified repair. */
export async function writeNftMetadataCatalog(catalog:NftMetadataCatalog,signal:AbortSignal=AbortSignal.timeout(60000)):Promise<NftMetadataCatalog>{
  active(signal);const committed=snapshot(await bounded(signal,()=>getRecord('oneshot_snapshots',catalog.manifestHash)),catalog.manifestHash);verifyNftMetadataCatalog(catalog,catalog.manifestHash,committed,signal);active(signal);
  const stored=await bounded(signal,()=>{active(signal);return putIfAbsent(NFT_METADATA_CATALOG_NAMESPACE,catalog.manifestHash,catalog);});return verifyNftMetadataCatalog(stored,catalog.manifestHash,committed,signal);
}
/** Only public explorer callers bind this lookup to an opened canonical collection.
 * No schema creation, writes, provider URLs or per-item media reads occur here. */
export async function loadNftMetadataCatalog(client:SqlClient,manifestHash:string,signal:AbortSignal=AbortSignal.timeout(5000)){
  active(signal);if(!/^[a-f0-9]{64}$/.test(manifestHash))return fail();
  const exists=await bounded(signal,()=>client.query("SELECT to_regclass('b20_app_records') IS NOT NULL AS available"));if(exists.rows[0]?.available!==true)return null;
  const rows=(await bounded(signal,()=>client.query("SELECT namespace,CASE WHEN octet_length(value::text)<=$3 THEN value ELSE NULL END AS value,octet_length(value::text) AS bytes FROM b20_app_records WHERE (namespace='oneshot_snapshots' OR namespace=$2) AND id=$1",[manifestHash,NFT_METADATA_CATALOG_NAMESPACE,NFT_METADATA_CATALOG_LIMITS.recordBytes]))).rows;
  active(signal);const stored=rows.find(row=>row.namespace===NFT_METADATA_CATALOG_NAMESPACE),proof=rows.find(row=>row.namespace==='oneshot_snapshots');
  if(!stored)return null;if(!proof||!stored.value||!proof.value)return fail();
  const committed=snapshot(proof.value,manifestHash),catalog=verifyNftMetadataCatalog(stored.value,manifestHash,committed,signal);
  return{catalog,committed,presentations:nftCatalogPresentations(catalog,committed,signal)};
}
/** Explicit bounded backfill/repair from stored hash-verified media only. */
export async function rebuildNftMetadataCatalog(manifestHash:string,overrides:Partial<CatalogDependencies>={}):Promise<NftMetadataCatalog>{
  const deps:CatalogDependencies={record:getRecord,media:(id,record,maximumBytes,signal)=>readMedia(id,{record:async()=>record,maximumBytes,signal}),write:writeNftMetadataCatalog,...overrides};
  const signal=deps.signal??AbortSignal.timeout(60000);active(signal);const committed=snapshot(await bounded(signal,()=>deps.record('oneshot_snapshots',manifestHash)),manifestHash),previous=await bounded(signal,()=>deps.record(NFT_METADATA_CATALOG_NAMESPACE,manifestHash)),items:NftMetadataCatalog['items']=[];let bytes=0;
  for(const item of committed.items){
    active(signal);const record=await bounded(signal,()=>deps.record('media',item.metadataId));if(!record)return fail();
    const maximumBytes=Math.min(NFT_METADATA_CATALOG_LIMITS.itemBytes,NFT_METADATA_CATALOG_LIMITS.metadataBytes-bytes);if(maximumBytes<=0)return fail();
    const blob=await bounded(signal,()=>deps.media(item.metadataId,record,maximumBytes,signal));active(signal);
    if(blob.mimeType!=='application/json'||blob.buffer.length>maximumBytes||createHash('sha256').update(blob.buffer).digest('hex')!==item.metadataHash)return fail();
    let metadataJson:string;try{metadataJson=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(blob.buffer);}catch{return fail();}
    bytes+=blob.buffer.length;items.push({serial:item.serial,metadataJson});
  }
  const catalog=buildNftMetadataCatalog(manifestHash,committed,items,signal);active(signal);
  if(overrides.write)return bounded(signal,()=>{active(signal);return deps.write(catalog,signal);});
  if(previous!==null&&previous!==undefined){
    try{return verifyNftMetadataCatalog(previous,manifestHash,committed,signal);}catch(error){active(signal);if(!(error instanceof ApiError)||error.code!=='NFT_CATALOG_INVALID')throw error;}
    if(!await bounded(signal,()=>{active(signal);return compareAndSetRecord(NFT_METADATA_CATALOG_NAMESPACE,manifestHash,previous,catalog);}))throw new ApiError(409,'NFT_CATALOG_CHANGED','Collection metadata changed during repair. Retry the catalog rebuild.');
    return catalog;
  }
  return bounded(signal,()=>{active(signal);return deps.write(catalog,signal);});
}
