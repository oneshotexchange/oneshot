import { describe,it,expect } from 'vitest';
import { MemoryIndexerStore } from '../src/store';
import { syncIndexer } from '../src/engine';
import { projectLogs } from '../src/events';
import { manifestId } from '../src/manifest';
import { v3Manifest,at,v3Logs,appendV3,market,collection,forwarded } from './nft-v3-fixture';
describe('V3 canonical journal accounting',()=>{
  it('projects partial fills, forwarded receiver transfers, refunds and claims without double counting',async()=>{
    const store=new MemoryIndexerStore();await store.initialize(manifestId(v3Manifest));
    for(let n=1;n<=5;n++)await appendV3(store,n);
    const state=(await store.snapshot()).projection;
    expect(state['offer-accounting'][market]).toMatchObject({escrow:'0',pending:'10000',inflows:'20000',claimed:'10000'});
    expect(state.offers['1']).toMatchObject({remaining:'0',status:'cancelled',refund:'10000'});
    expect(state.items[`${collection}:1`]).toMatchObject({owner:forwarded,activeListingId:null,escrowRelease:null});
    expect(state.listings['1']).toMatchObject({status:'offer-filled',totalPrice:'10000',originalAsk:'20000'});expect(Object.values(state['offer-sales'])).toHaveLength(1);
    await store.transaction(tx=>tx.rollbackHead());await store.transaction(tx=>tx.rollbackHead());await store.transaction(tx=>tx.rollbackHead());
    const restored=(await store.snapshot()).projection;
    expect(restored['offer-accounting'][market]).toMatchObject({escrow:'20000',pending:'0',claimed:'0'});expect(restored.offers['1'].remaining).toBe('2');expect(restored.listings['1'].status).toBe('active');expect(restored['offer-sales']).toEqual({});
  });
  it('rejects missing transfer proofs and rolls back the entire block',async()=>{
    const store=new MemoryIndexerStore();await store.initialize(manifestId(v3Manifest));await appendV3(store,1);await appendV3(store,2);const before=await store.snapshot();
    await expect(appendV3(store,3,v3Manifest,v3Logs(3).slice(2))).rejects.toMatchObject({code:'OFFER_TRANSFER_MISSING'});expect(await store.snapshot()).toEqual(before);
    await expect(store.transaction(tx=>projectLogs(tx,v3Manifest,v3Logs(3)))).rejects.toMatchObject({code:'EVENT_BLOCK_REQUIRED'});
  });
  it('refuses a missing market event or accounting drift before committing its checkpoint',async()=>{
    const store=new MemoryIndexerStore();const source={verify:async()=>{},height:async()=>2n,block:async(n:bigint)=>at(Number(n)),logs:async(block:ReturnType<typeof at>,addresses:readonly string[])=>v3Logs(Number(block.number)).filter(log=>addresses.includes(log.address)),offerAccounting:async()=>({escrow:'0',pending:'0',balance:'20000'})};
    await expect(syncIndexer(source,store,v3Manifest)).rejects.toMatchObject({code:'OFFER_ACCOUNTING_MISMATCH'});expect((await store.snapshot()).blocks).toHaveLength(1);expect((await store.snapshot()).projection.offers).toEqual({});
  });
});
