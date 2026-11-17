import {describe,expect,it,vi} from 'vitest';
import {analyticsFixture,MemoryTokenEventAdapter} from './token-event-fixture';
import {tokenHash as h} from './token-fixture';
import {syncTokenEvents} from '../src/token-event-worker';
import {normalizeTokenRegistration} from '../src/token-event-projector';
import type {Block,ProjectionValue} from '../src/types';

async function fixture(){
  const f=await analyticsFixture(),memory=new MemoryTokenEventAdapter(),journal=new Map<bigint,{block:Block;before:Map<string,ProjectionValue>}>();
  const state={height:2n,failed:false,replacement:false},head=()=>[...journal.values()].at(-1)?.block??null;
  const store={initialize:vi.fn(async()=>{}),head:async()=>head(),block:async(number:bigint)=>journal.get(number)?.block??null,
    registrations:async(after:string|null,limit:number)=>[...memory.state].filter(([key])=>key.startsWith('markets:')).map(([,value])=>normalizeTokenRegistration(value)).filter(value=>!after||value.market>after).sort((a,b)=>a.market.localeCompare(b.market)).slice(0,limit),
    applyBlock:vi.fn(async(block:Block,logs:readonly Parameters<typeof memory.apply>[2][number][],registrations:readonly unknown[]=[])=>{const before=structuredClone(memory.state);await memory.apply(f.manifest,block,logs,registrations);journal.set(block.number,{block,before});return{applied:true,created:registrations.length,logs:logs.length};}),
    rollbackHead:vi.fn(async(expected?:Block)=>{const current=head();if(!current||expected&&expected.hash!==current.hash)throw new Error('Concurrent test head');memory.state=journal.get(current.number)!.before;journal.delete(current.number);return current;})};
  const canonical=(number:bigint)=>number===0n?{number:0n,hash:f.manifest.anchorHash,parentHash:h(0),timestamp:1700000000n}:number===1n?f.first:number===2n&&state.replacement?f.block(2,h(333),f.first.hash):f.block(Number(number));
  const source={height:async()=>state.height,block:vi.fn(async(number:bigint)=>canonical(number)),verify:vi.fn(async()=>({block:canonical(state.height),platformRecipient:f.platform})),
    capture:vi.fn(async(_manifest:unknown,block:Block)=>{if(state.failed)throw new Error('private-provider');return{block,logs:block.number===1n?f.creation:state.replacement?[]:f.swaps,registrations:block.number===1n?[normalizeTokenRegistration(f.registered)]:[],reads:1};})};
  return{...f,memory,journal,store,source,state};
}
describe('bounded canonical token event worker',()=>{
  it('resumes complete blocks across bounded passes and never commits a failed capture',async()=>{
    const f=await fixture();expect(await syncTokenEvents(f.source,f.store,f.manifest,{maximumBlocks:1,confirmations:0})).toMatchObject({applied:1,complete:false,checkpoint:'1'});
    f.state.failed=true;await expect(syncTokenEvents(f.source,f.store,f.manifest,{confirmations:0})).rejects.toThrow('private-provider');expect((await f.store.head())?.number).toBe(1n);expect(f.store.applyBlock).toHaveBeenCalledOnce();
    f.state.failed=false;expect(await syncTokenEvents(f.source,f.store,f.manifest,{confirmations:0})).toMatchObject({applied:1,complete:true,checkpoint:'2'});expect(f.memory.get('markets',f.market)?.poolNativeVolumeRaw).toBe('1010');
  });
  it('plans a canonical common ancestor before reversing orphans and replacing their balances and prices',async()=>{
    const f=await fixture();await syncTokenEvents(f.source,f.store,f.manifest,{confirmations:0});f.state.replacement=true;
    const result=await syncTokenEvents(f.source,f.store,f.manifest,{confirmations:0});expect(result).toMatchObject({orphaned:1,applied:1,checkpoint:'2'});expect((await f.store.head())?.hash).toBe(h(333));expect(f.memory.get('markets',f.market)).toMatchObject({poolNativeVolumeRaw:'0',oneshotTrades:'0',holderCount:'2',priceBlockHash:f.first.hash});
  });
  it('refuses a lagging provider and a failed boundary check before any rollback',async()=>{
    const f=await fixture();await syncTokenEvents(f.source,f.store,f.manifest,{confirmations:0});f.state.height=1n;
    await expect(syncTokenEvents(f.source,f.store,f.manifest,{confirmations:0})).rejects.toMatchObject({code:'TOKEN_SOURCE_BEHIND'});expect(f.store.rollbackHead).not.toHaveBeenCalled();
    f.state.height=2n;f.state.replacement=true;f.source.block.mockRejectedValueOnce(new Error('private-provider'));
    await expect(syncTokenEvents(f.source,f.store,f.manifest,{confirmations:0})).rejects.toThrow('private-provider');expect(f.store.rollbackHead).not.toHaveBeenCalled();expect((await f.store.head())?.hash).toBe(f.next.hash);
  });
});
