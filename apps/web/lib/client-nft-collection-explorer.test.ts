import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { NftItemDiscoveryResponse, IndexedNftItem } from '@oneshot/evm';
import { IndexedReadError } from './client-indexed-api';
import { createNftCollectionExploreLoader, emptyNftItemFilters, encodeNftTraitFilters, nftCollectionExplorePath, nftItemFiltersFromSearch, nftItemFiltersSearch, nftManualTraitValue, nftTraitNameOptionValue, normalizeNftItemFilters, validateNftCollectionExplore } from './client-nft-collection-explorer';
import { NftCollectionExplorerResults, NftTraitNameSelect } from '../components/nft-collection-explorer';
const collection=`0x${'1'.repeat(40)}`,owner=`0x${'2'.repeat(40)}`,market=`0x${'3'.repeat(40)}`,deployment='a'.repeat(64),content='b'.repeat(64);
const context={enabled:true,available:true,reason:null,deploymentId:deployment,network:{mode:'local' as const,chainId:31337 as const,name:'Local Anvil' as const,nativeSymbol:'ETH' as const,nativeDecimals:18 as const},checkpoint:{number:'100',hash:`0x${'c'.repeat(64)}`,timestamp:'1700000000'},readonly:true as const,finalized:false as const};
const filters=emptyNftItemFilters(),expected={collection,deploymentId:deployment,chainId:31337,filters};
function item(serial:string,price?:string):IndexedNftItem{return{id:`${collection}:${serial}`,collection,tokenId:serial,owner:price?market:owner,burned:false,listing:price?{id:serial,collection,tokenId:serial,totalPriceRaw:price,seller:owner,status:'active',buyer:null,recipient:null,platformFeeRaw:null,royaltyRaw:null,sellerProceedsRaw:null}:null,presentation:{manifestHash:content,tokenId:serial,name:`Nebula #${serial}`,description:'',imagePath:`/api/media/${content}.webp`,metadataPath:`/api/oneshot/metadata/${content}/${serial}`,attributes:[{trait_type:'Level',value:7}]}};}
function page(serials=['1','2'],matching='2',cursor:string|null=null):NftItemDiscoveryResponse{return{context,collection,items:serials.map(value=>item(value)),nextCursor:cursor,discovery:{totalItems:'40',matchingItems:matching,metadataFilters:{available:true,reason:null},facets:[{trait_type:'Level',value:7,count:'40'}],facetsTruncated:false,facetScope:'minted-unburned-collection'}};}
const fetcher=(run:(url:string)=>Promise<unknown>)=>run as Parameters<typeof createNftCollectionExploreLoader>[1];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(complete => { resolve = complete; }); return { promise, resolve }; }
describe('complete collection filters and URL state',()=>{
  it('preserves deployment context and exact human ETH prices while removing old pagination',()=>{
    const next=nftItemFiltersSearch(`deployment=${deployment}&cursor=old&unrelated=kept`,{...filters,query:' Nebula %_ ',minPrice:'9007199.254740993123456789',maxPrice:'9007199.254740993123456790',sort:'price-asc',owner:owner.toUpperCase().replace('0X','0x')});
    expect(next.get('deployment')).toBe(deployment);expect(next.get('cursor')).toBeNull();expect(next.get('unrelated')).toBe('kept');
    const parsed=nftItemFiltersFromSearch(next.toString());expect(parsed).toMatchObject({query:'Nebula %_',availability:'listed',minPrice:'9007199.254740993123456789',maxPrice:'9007199.25474099312345679',owner});
    const api=new URL(nftCollectionExplorePath(collection,parsed),'https://oneshot.invalid');expect(api.searchParams.get('deployment')).toBeNull();expect(api.searchParams.get('q')).toBe('Nebula %_');expect(api.searchParams.get('limit')).toBe('20');
  });
  it('anchors Apply and Clear URLs from a bare collection entry to its verified deployment',()=>{
    const applied=nftItemFiltersSearch('unrelated=kept&cursor=obsolete',{...filters,query:'Nebula'},deployment);
    expect(applied.get('deployment')).toBe(deployment);expect(applied.get('q')).toBe('Nebula');expect(applied.get('cursor')).toBeNull();
    const cleared=nftItemFiltersSearch(applied.toString(),filters,deployment);
    expect(cleared.get('deployment')).toBe(deployment);expect(cleared.get('q')).toBeNull();expect(cleared.get('unrelated')).toBe('kept');
    const alreadyScoped=nftItemFiltersSearch(`deployment=${deployment}`,{...filters,query:'#2'},deployment);
    expect(alreadyScoped.getAll('deployment')).toEqual([deployment]);
    expect(new URL(nftCollectionExplorePath(collection,nftItemFiltersFromSearch(alreadyScoped.toString())),'https://oneshot.invalid').searchParams.has('deployment')).toBe(false);
  });
  it.each([`deployment=${'d'.repeat(64)}`,'deployment=broken',`deployment=${deployment}&deployment=${deployment}`])('never replaces supplied collection authority while changing filters: %s',search=>{
    expect(()=>nftItemFiltersSearch(search,filters,deployment)).toThrow('network changed');
  });
  it('requires a verified deployment before anchoring customer filter links',()=>{
    expect(()=>nftItemFiltersSearch('',filters,'')).toThrow('network is unavailable');
    expect(()=>nftItemFiltersSearch('',filters,'not-a-deployment')).toThrow('network is unavailable');
  });
  it.each(['q=a&q=b','sort=cheap','availability=all&maxPrice=-1','minPrice=1.0000000000000000001','minPrice=2&maxPrice=1','owner=0x0','availability=unlisted&minPrice=1','traits=not-json'])('rejects ambiguous or invalid filters: %s',search=>expect(()=>nftItemFiltersFromSearch(search)).toThrow());
  it('keeps Unicode typed traits in canonical order, including empty and multiline committed strings',()=>{
    const selected=normalizeNftItemFilters({...filters,traits:[{trait_type:'রং',value:'নীল'},{trait_type:'Level',value:'7'},{trait_type:'Level',value:7},{trait_type:'',value:'line\nvalue'}]});
    const encoded=encodeNftTraitFilters(selected.traits);expect(nftItemFiltersFromSearch(`traits=${encoded}`).traits).toEqual(selected.traits);expect(selected.traits).toHaveLength(4);
    expect(()=>normalizeNftItemFilters({...filters,traits:[{trait_type:'Level',value:7},{trait_type:'Level',value:7}]})).toThrow();
  });
  it('keeps an unnamed native trait distinct from the select placeholder and all other native names',()=>{
    const names=['','Color','""','রং','line\nname'];
    expect(new Set(names.map(nftTraitNameOptionValue)).size).toBe(names.length);
    for(const name of names){const encoded=nftTraitNameOptionValue(name);expect(encoded).not.toBe('');expect(JSON.parse(encoded)).toBe(name);}
    const html=renderToStaticMarkup(createElement(NftTraitNameSelect,{names,value:nftTraitNameOptionValue(''),onChange:()=>{}}));
    expect(html).toContain('<option value="">Choose a trait</option>');
    expect(html).toContain('<option value="&quot;&quot;" selected="">(Unnamed trait)</option>');
    expect(html.match(/selected=""/g)).toHaveLength(1);
  });
  it.each(['9007199254740993','9007199254740992','0.10000000000000001','1e-400','NaN','Infinity','01','1.'])('does not silently round or reinterpret manual numeric traits: %s',value=>expect(()=>nftManualTraitValue(value,'number')).toThrow());
  it('distinguishes manually entered text from valid numeric metadata values',()=>{
    expect(nftManualTraitValue('7','string')).toBe('7');expect(nftManualTraitValue('7','number')).toBe(7);expect(nftManualTraitValue('-2.50','number')).toBe(-2.5);expect(nftManualTraitValue('1e3','number')).toBe(1000);expect(nftManualTraitValue('-0','number')).toBe(0);
  });
});
describe('collection response and continuation boundaries',()=>{
  it('accepts the API’s exact canonical timestamp, collection, complete counts and presentation',()=>expect(validateNftCollectionExplore(page(),expected).items).toHaveLength(2));
  it('accepts a matching 79-digit numeric NFT name as metadata search rather than a serial',()=>{
    const name='1'.repeat(79),value=page(['1'],'1'),selected={...expected,filters:{...filters,query:name}};
    value.items[0].presentation!.name=name;
    expect(nftItemFiltersFromSearch(`q=${name}`).query).toBe(name);
    expect(validateNftCollectionExplore(value,selected).items[0].tokenId).toBe('1');
    value.items[0].presentation!.name='Different artwork';
    expect(()=>validateNftCollectionExplore(value,selected)).toThrow();
    value.discovery!.metadataFilters={available:false,reason:'Names and traits are unavailable.'};value.discovery!.facets=[];value.items[0].presentation=null;
    expect(()=>validateNftCollectionExplore(value,selected)).toThrow();
  });
  it.each(['network','checkpoint','count','duplicate','name','trait','price','presentation','missing-tail'] as const)('rejects a mismatched or unreadable %s result',change=>{
    const value=structuredClone(page());let selected={...expected};
    if(change==='network')value.context.deploymentId='d'.repeat(64);if(change==='checkpoint')value.context.checkpoint!.timestamp='not-time';if(change==='count')value.discovery!.totalItems='1001';if(change==='duplicate')value.items[1]=value.items[0];
    if(change==='name')selected={...expected,filters:{...filters,query:'Other artwork'}};if(change==='trait')selected={...expected,filters:{...filters,traits:[{trait_type:'Level',value:'7'}]}};
    if(change==='price'){selected={...expected,filters:{...filters,availability:'listed'}};}if(change==='presentation')value.items[0].presentation=null;if(change==='missing-tail')value.discovery!.matchingItems='3';
    expect(()=>validateNftCollectionExplore(value,selected)).toThrow();
  });
  it('preserves unavailable context and permits serial browsing when name/trait coverage is missing',()=>{
    const unavailable={...page([], '0'),context:{...context,enabled:false,available:false,network:null,deploymentId:null,checkpoint:null},discovery:null};expect(validateNftCollectionExplore(unavailable,expected).context.available).toBe(false);
    const missing=page(['1'],'1');missing.discovery!.metadataFilters={available:false,reason:'Names and traits are unavailable.'};missing.discovery!.facets=[];missing.items[0].presentation=null;
    expect(validateNftCollectionExplore(missing,{...expected,filters:{...filters,query:'#1'}}).items).toHaveLength(1);expect(()=>validateNftCollectionExplore(missing,{...expected,filters:{...filters,query:'Nebula'}})).toThrow();
  });
  it('joins complete pages without duplicates and rejects overlapping or incomplete continuation',async()=>{
    const first=page(['1','2'],'4','next'),second=page(['3','4'],'4');
    const run=vi.fn(async(url:string)=>url.includes('cursor=')?second:first),loader=createNftCollectionExploreLoader(expected,fetcher(run));
    await loader.open('/api/explore');await loader.loadMore();expect(loader.snapshot().data?.items.map(v=>v.tokenId)).toEqual(['1','2','3','4']);expect(loader.snapshot().error).toBeNull();
    const wrong=page(['2','3'],'4'),bad=createNftCollectionExploreLoader(expected,fetcher(async url=>url.includes('cursor=')?wrong:first));await bad.open('/api/explore');await bad.loadMore();expect(bad.snapshot().data?.items).toHaveLength(2);expect(bad.snapshot().error).toContain('verified');
  });
  it('restarts stale cursors and does not merge a different checkpoint',async()=>{
    let firstCalls=0;const run=async(url:string)=>{if(url.includes('cursor='))throw new IndexedReadError(409,'CURSOR_STALE','Changed');firstCalls++;return page(['1','2'],'4','next');};
    const loader=createNftCollectionExploreLoader(expected,fetcher(run));await loader.open('/api/explore');await loader.loadMore();expect(firstCalls).toBe(2);expect(loader.snapshot().notice).toContain('refreshed');expect(loader.snapshot().data?.items).toHaveLength(2);
  });
  it('retains a useful retry after a rejected initial fetch instead of an empty success',async()=>{
    const loader=createNftCollectionExploreLoader(expected,fetcher(async()=>{throw new Error('Could not connect to oneshot. Check your connection and try again.');}));await loader.open('/api/explore');expect(loader.snapshot().data).toBeNull();expect(loader.snapshot().error).toContain('connection');
  });
  it('discards an obsolete first response after Refresh before it can replace continuation guards',async()=>{
    const obsolete=deferred<NftItemDiscoveryResponse>();let firstCalls=0;
    const loader=createNftCollectionExploreLoader(expected,fetcher(async url=>{
      if(url.includes('cursor='))return page(['3','4'],'4');
      firstCalls++;return firstCalls===1?obsolete.promise:page(['1','2'],'4','next');
    }));
    const first=loader.open('/api/explore');await loader.refresh();
    obsolete.resolve(page(['1','2'],'6','obsolete-next'));await first;await loader.loadMore();
    expect(firstCalls).toBe(2);expect(loader.snapshot().data?.items.map(value=>value.tokenId)).toEqual(['1','2','3','4']);
    expect(loader.snapshot().error).toBeNull();expect(loader.snapshot().notice).toBeNull();
  });
  it('discards an obsolete continuation after Refresh before it can advance the active guard',async()=>{
    const obsolete=deferred<NftItemDiscoveryResponse>();let continuations=0;
    const loader=createNftCollectionExploreLoader(expected,fetcher(async url=>{
      if(!url.includes('cursor='))return page(['1','2'],'4','next');
      continuations++;return continuations===1?obsolete.promise:page(['3','4'],'4');
    }));
    await loader.open('/api/explore');const pending=loader.loadMore();await loader.refresh();
    obsolete.resolve(page(['3','4'],'4'));await pending;await loader.loadMore();
    expect(continuations).toBe(2);expect(loader.snapshot().data?.items.map(value=>value.tokenId)).toEqual(['1','2','3','4']);expect(loader.snapshot().error).toBeNull();
  });
});
describe('collection result customer states',()=>{
  const callbacks={onRefresh:()=>{},onRefreshCollection:()=>{},onLoadMore:()=>{},onClear:()=>{},renderItems:()=>null};
  it('separates unavailable data, no matching NFTs and a failed response with recovery actions',()=>{
    const render=(data:NftItemDiscoveryResponse|null,error:string|null,filtered=true)=>renderToStaticMarkup(createElement(NftCollectionExplorerResults,{...callbacks,data,error,loading:false,loadingMore:false,notice:null,filtered}));
    expect(render(null,null)).toContain('Collection items are unavailable');expect(render(page([],'0'),null)).toContain('No NFTs match these filters');const failed=render(null,'Could not connect. Try again.');expect(failed).toContain('Clear filters');expect(failed).toContain('Refresh collection');expect(failed).not.toContain('No NFTs match');
    const empty=page([],'0');empty.discovery!.totalItems='0';empty.discovery!.facets=[];
    const unfiltered=render(empty,null,false);expect(unfiltered).toContain('No NFTs to show');expect(unfiltered).toContain('no minted, unburned NFTs at this checkpoint');expect(unfiltered).not.toContain('No NFTs minted yet');
  });
});
