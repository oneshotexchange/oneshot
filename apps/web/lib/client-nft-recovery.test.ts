import {describe,it,expect} from 'vitest';
import {createNftPendingStore,type PendingNftTransaction} from './client-nft-recovery';
const now=Date.parse('2026-10-23T12:00:00Z');
const record:PendingNftTransaction={userId:'account-a',from:`0x${'ab'.repeat(20)}`,deploymentId:'deployment-one',reviewId:'review-one',reviewHash:`0x${'12'.repeat(32)}`,hash:`0x${'34'.repeat(32)}`,createdAt:new Date(now).toISOString()};
function memory(initial='[]'){let value=initial;return {getItem:()=>value,setItem:(_key:string,next:string)=>{value=next;},value:()=>value};}
describe('browser NFT broadcast fallback',()=>{
  it('survives a new store instance and only returns the requested owner and selected wallet',()=>{
    const storage=memory(),store=createNftPendingStore(storage,()=>now);expect(store.remember(record)).toBe(true);
    const restarted=createNftPendingStore(storage,()=>now+1000);expect(restarted.list('account-a',record.from.toUpperCase())).toEqual([record]);expect(restarted.list('account-b')).toEqual([]);expect(restarted.list('account-a',`0x${'cd'.repeat(20)}`)).toEqual([]);
    restarted.forget('account-b',record.reviewId);expect(restarted.list('account-a')).toHaveLength(1);restarted.forget('account-a',record.reviewId);expect(restarted.list('account-a')).toEqual([]);
    expect(storage.value()).not.toContain('token');expect(storage.value()).not.toContain('data');
  });
  it('deduplicates a review and bounds valid records while dropping malformed, future and expired entries',()=>{
    const storage=memory(JSON.stringify([{...record,hash:'bad'},{...record,createdAt:new Date(now+1).toISOString()},{...record,createdAt:new Date(now-31*86400000).toISOString()}])),store=createNftPendingStore(storage,()=>now);
    expect(store.list('account-a')).toEqual([]);for(let index=0;index<105;index++)store.remember({...record,reviewId:`review-${index}`});expect(store.list('account-a')).toHaveLength(100);
    store.remember({...record,reviewId:'review-104',hash:`0x${'56'.repeat(32)}`});expect(store.list('account-a')).toHaveLength(100);expect(store.list('account-a').at(-1)?.hash).toBe(`0x${'56'.repeat(32)}`);
  });
  it('fails safely when storage is denied or corrupted',()=>{
    expect(createNftPendingStore(null,()=>now).remember(record)).toBe(false);expect(createNftPendingStore(memory('not-json'),()=>now).list('account-a')).toEqual([]);
    const denied=createNftPendingStore({getItem:()=>{throw new Error('denied');},setItem:()=>{throw new Error('full');}},()=>now);expect(denied.list('account-a')).toEqual([]);expect(denied.remember(record)).toBe(false);
  });
});
