import { createHash } from 'node:crypto';
import { afterEach,describe, expect, it, vi } from 'vitest';
import { stableJson } from './media';
import { buildNftMetadataCatalog, loadNftMetadataCatalog, nftCatalogPresentations, rebuildNftMetadataCatalog, verifyNftMetadataCatalog,writeNftMetadataCatalog, NFT_METADATA_CATALOG_NAMESPACE } from './nft-metadata-catalog';
import * as store from './store';
import type { SqlClient } from '../../../indexer/src/store';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
afterEach(()=>vi.restoreAllMocks());
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(finish=>{resolve=finish;});return{promise,resolve};}
async function abortStalled<T>(pending:Promise<T>,controller:AbortController){
  let guard:ReturnType<typeof setTimeout>|undefined;
  const abort=setTimeout(()=>controller.abort(),5);
  try{return await Promise.race([pending.catch(error=>error),new Promise<string>(resolve=>{guard=setTimeout(()=>resolve('deadline-not-observed'),250);})]);}
  finally{clearTimeout(abort);if(guard)clearTimeout(guard);}
}
const settleLate=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function fixture(count=3){
  const imageHash=sha('sanitized image'),original=Array.from({length:count},(_,index)=>({serial:index+1,metadataJson:stableJson({name:`Original #${index+1}`,image:`https://api.oneshot.app/api/media/${imageHash}.webp`,attributes:[{trait_type:'Level',value:index===0?7:'7'}]})}));
  const items=original.map(item=>({serial:item.serial,metadataId:`${sha(item.metadataJson)}.json`,metadataHash:sha(item.metadataJson),imageHash})),manifestHash=sha(stableJson({items})),snapshot={manifestHash,items};
  const catalog=buildNftMetadataCatalog(manifestHash,snapshot,original);
  return {original,items,manifestHash,snapshot,catalog};
}
describe('complete verified NFT metadata catalog',()=>{
  it('binds every exact original JSON byte string to the immutable serial map and preserves typed traits',()=>{
    const f=fixture(),verified=verifyNftMetadataCatalog(f.catalog,f.manifestHash,f.snapshot),presentations=nftCatalogPresentations(verified,f.snapshot);
    expect(presentations.get('1')?.attributes).toEqual([{trait_type:'Level',value:7}]);expect(presentations.get('2')?.attributes).toEqual([{trait_type:'Level',value:'7'}]);
    expect(JSON.stringify([...presentations.values()])).not.toMatch(/ownerUserId|private|provider|createdAt/);
  });
  it.each(['omitted','duplicated','reordered','changed','foreign-image','different-snapshot'] as const)('refuses %s catalog content',change=>{
    const f=fixture(),copy=structuredClone(f.catalog);
    if(change==='omitted')copy.items.pop();if(change==='duplicated')copy.items[1]=copy.items[0];if(change==='reordered')copy.items.reverse();if(change==='changed')copy.items[0].metadataJson='{}';
    if(change==='foreign-image')copy.items[0].metadataJson=copy.items[0].metadataJson.replace('api.oneshot.app','private.attacker.test');
    expect(()=>verifyNftMetadataCatalog(copy,change==='different-snapshot'?'a'.repeat(64):f.manifestHash,f.snapshot)).toThrow();
  });
  it('enforces metadata budgets and cancellation before publishing a derived catalog',async()=>{
    const f=fixture(),controller=new AbortController();controller.abort();expect(()=>verifyNftMetadataCatalog(f.catalog,f.manifestHash,f.snapshot,controller.signal)).toThrow();
    const large=structuredClone(f.catalog);large.items[0].metadataJson+=' '.repeat(256*1024);expect(()=>verifyNftMetadataCatalog(large,f.manifestHash,f.snapshot)).toThrow();
    const write=vi.fn();await expect(rebuildNftMetadataCatalog(f.manifestHash,{signal:controller.signal,write})).rejects.toMatchObject({code:'NFT_CATALOG_TIMEOUT'});expect(write).not.toHaveBeenCalled();
  });
  it('never writes a partial reconstruction or fetches arbitrary metadata URLs',async()=>{
    const f=fixture(),write=vi.fn(async()=>f.catalog),media=vi.fn(async(id:string)=>({buffer:Buffer.from(f.original[f.items.findIndex(item=>item.metadataId===id)].metadataJson),mimeType:'application/json'}));
    const record=vi.fn(async(namespace:string,id:string):Promise<unknown>=>namespace==='oneshot_snapshots'?f.snapshot:namespace===NFT_METADATA_CATALOG_NAMESPACE?null:id===f.items[2].metadataId?null:{mimeType:'application/json'});
    const fetch=vi.spyOn(globalThis,'fetch');
    try{await expect(rebuildNftMetadataCatalog(f.manifestHash,{record,media,write})).rejects.toMatchObject({code:'NFT_CATALOG_INVALID'});expect(write).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();}
    finally{fetch.mockRestore();}
  });
  it('distinguishes a missing catalog from a failed SQL read and a tampered catalog',async()=>{
    const f=fixture();let rows:Record<string,unknown>[]=[];
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('to_regclass')?[{available:true}]:rows,rowCount:rows.length}));
    const client={query,release:()=>{}} as SqlClient;
    expect(await loadNftMetadataCatalog(client,f.manifestHash)).toBeNull();
    rows=[{namespace:'oneshot_snapshots',value:f.snapshot},{namespace:NFT_METADATA_CATALOG_NAMESPACE,value:{...f.catalog,items:[]}}];await expect(loadNftMetadataCatalog(client,f.manifestHash)).rejects.toMatchObject({code:'NFT_CATALOG_INVALID'});
    query.mockRejectedValueOnce(new Error('database transport details'));await expect(loadNftMetadataCatalog(client,f.manifestHash)).rejects.toThrow('database transport');
    rows=[{namespace:'oneshot_snapshots',value:f.snapshot},{namespace:NFT_METADATA_CATALOG_NAMESPACE,value:f.catalog}];expect((await loadNftMetadataCatalog(client,f.manifestHash))?.presentations.size).toBe(3);
  });
  it.each(['oneshot_snapshots',NFT_METADATA_CATALOG_NAMESPACE,'media'])('bounds stalled %s record reads and never resumes later I/O after cancellation',async blocked=>{
    const f=fixture(),controller=new AbortController(),late=deferred<unknown>(),started=deferred<void>();
    const record=vi.fn(async(namespace:string):Promise<unknown>=>{if(namespace===blocked){started.resolve();return late.promise;}return namespace==='oneshot_snapshots'?f.snapshot:namespace===NFT_METADATA_CATALOG_NAMESPACE?null:{mimeType:'application/json'};});
    const media=vi.fn(),write=vi.fn(),pending=rebuildNftMetadataCatalog(f.manifestHash,{signal:controller.signal,record,media,write});
    await started.promise;expect(await abortStalled(pending,controller)).toMatchObject({code:'NFT_CATALOG_TIMEOUT'});const calls=record.mock.calls.length;
    late.resolve(blocked==='oneshot_snapshots'?f.snapshot:blocked===NFT_METADATA_CATALOG_NAMESPACE?null:{mimeType:'application/json'});await settleLate();
    expect(record).toHaveBeenCalledTimes(calls);expect(media).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();
  });
  it('bounds stalled metadata bytes and never starts the next item or a write after late completion',async()=>{
    const f=fixture(),controller=new AbortController(),late=deferred<{buffer:Buffer;mimeType:string}>(),started=deferred<void>();
    const record=vi.fn(async(namespace:string):Promise<unknown>=>namespace==='oneshot_snapshots'?f.snapshot:namespace===NFT_METADATA_CATALOG_NAMESPACE?null:{mimeType:'application/json'});
    const media=vi.fn(async()=>{started.resolve();return late.promise;}),write=vi.fn(),pending=rebuildNftMetadataCatalog(f.manifestHash,{signal:controller.signal,record,media,write});
    await started.promise;expect(await abortStalled(pending,controller)).toMatchObject({code:'NFT_CATALOG_TIMEOUT'});const calls=record.mock.calls.length;
    late.resolve({buffer:Buffer.from(f.original[0].metadataJson),mimeType:'application/json'});await settleLate();expect(record).toHaveBeenCalledTimes(calls);expect(media).toHaveBeenCalledOnce();expect(write).not.toHaveBeenCalled();
  });
  it('bounds a stalled catalog writer without treating a late write acknowledgement as success',async()=>{
    const f=fixture(),controller=new AbortController(),late=deferred<typeof f.catalog>(),started=deferred<void>();
    const record=vi.fn(async(namespace:string):Promise<unknown>=>namespace==='oneshot_snapshots'?f.snapshot:namespace===NFT_METADATA_CATALOG_NAMESPACE?null:{mimeType:'application/json'});
    const media=vi.fn(async(id:string)=>({buffer:Buffer.from(f.original[f.items.findIndex(item=>item.metadataId===id)].metadataJson),mimeType:'application/json'})),write=vi.fn(async()=>{started.resolve();return late.promise;});
    const pending=rebuildNftMetadataCatalog(f.manifestHash,{signal:controller.signal,record,media,write});await started.promise;expect(await abortStalled(pending,controller)).toMatchObject({code:'NFT_CATALOG_TIMEOUT'});
    late.resolve(f.catalog);await settleLate();expect(write).toHaveBeenCalledOnce();expect(media).toHaveBeenCalledTimes(f.items.length);
  });
  it('bounds pending compare-and-set repair after independently verifying all stored metadata',async()=>{
    const f=fixture(),controller=new AbortController(),late=deferred<boolean>(),started=deferred<void>();
    const repair=vi.spyOn(store,'compareAndSetRecord').mockImplementation(async()=>{started.resolve();return late.promise;}),put=vi.spyOn(store,'putIfAbsent').mockResolvedValue(f.catalog);
    const record=vi.fn(async(namespace:string):Promise<unknown>=>namespace==='oneshot_snapshots'?f.snapshot:namespace===NFT_METADATA_CATALOG_NAMESPACE?{invalid:true}:{mimeType:'application/json'});
    const media=vi.fn(async(id:string)=>({buffer:Buffer.from(f.original[f.items.findIndex(item=>item.metadataId===id)].metadataJson),mimeType:'application/json'}));
    const pending=rebuildNftMetadataCatalog(f.manifestHash,{signal:controller.signal,record,media});await started.promise;expect(media).toHaveBeenCalledTimes(f.items.length);expect(await abortStalled(pending,controller)).toMatchObject({code:'NFT_CATALOG_TIMEOUT'});
    late.resolve(true);await settleLate();expect(repair).toHaveBeenCalledOnce();expect(put).not.toHaveBeenCalled();
  });
  it.each(['snapshot','publish'])('bounds default catalog %s I/O and prevents follow-up writes after a late read',async stage=>{
    const f=fixture(),controller=new AbortController(),late=deferred<unknown>(),started=deferred<void>();
    const read=vi.spyOn(store,'getRecord').mockImplementation(async()=>{if(stage==='snapshot'){started.resolve();return late.promise;}return f.snapshot;});
    const write=vi.spyOn(store,'putIfAbsent').mockImplementation(async()=>{started.resolve();return late.promise;});
    const pending=writeNftMetadataCatalog(f.catalog,controller.signal);await started.promise;expect(await abortStalled(pending,controller)).toMatchObject({code:'NFT_CATALOG_TIMEOUT'});
    late.resolve(stage==='snapshot'?f.snapshot:f.catalog);await settleLate();expect(read).toHaveBeenCalledOnce();expect(write).toHaveBeenCalledTimes(stage==='snapshot'?0:1);
  });
  it.each(['existence','catalog'])('bounds held SQL %s waits without converting a stalled lookup into missing metadata',async stage=>{
    const f=fixture(),controller=new AbortController(),late=deferred<{rows:Record<string,unknown>[];rowCount:number}>(),started=deferred<void>();
    const query=vi.fn(async(sql:string)=>{if(stage==='existence'||!sql.includes('to_regclass')){started.resolve();return late.promise;}return{rows:[{available:true}],rowCount:1};});
    const pending=loadNftMetadataCatalog({query,release:()=>{}} as SqlClient,f.manifestHash,controller.signal);await started.promise;expect(await abortStalled(pending,controller)).toMatchObject({code:'NFT_CATALOG_TIMEOUT'});const calls=query.mock.calls.length;
    late.resolve(stage==='existence'?{rows:[{available:true}],rowCount:1}:{rows:[{namespace:'oneshot_snapshots',value:f.snapshot},{namespace:NFT_METADATA_CATALOG_NAMESPACE,value:f.catalog}],rowCount:2});await settleLate();expect(query).toHaveBeenCalledTimes(calls);
  });
  it('preserves the original storage/media/write error when the operation was not cancelled',async()=>{
    const f=fixture(),error=new Error('Original internal failure'),record=async(namespace:string):Promise<unknown>=>namespace==='oneshot_snapshots'?f.snapshot:namespace===NFT_METADATA_CATALOG_NAMESPACE?null:{mimeType:'application/json'};
    await expect(rebuildNftMetadataCatalog(f.manifestHash,{record:async()=>{throw error;}})).rejects.toBe(error);
    await expect(rebuildNftMetadataCatalog(f.manifestHash,{record,media:async()=>{throw error;}})).rejects.toBe(error);
    const media=async(id:string)=>({buffer:Buffer.from(f.original[f.items.findIndex(item=>item.metadataId===id)].metadataJson),mimeType:'application/json'});
    await expect(rebuildNftMetadataCatalog(f.manifestHash,{record,media,write:async()=>{throw error;}})).rejects.toBe(error);
  });
});
