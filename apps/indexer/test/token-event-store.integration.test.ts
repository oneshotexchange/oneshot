import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {describe,expect,it} from 'vitest';
import {zeroAddress,type Address,type Hex} from 'viem';
import {PostgresTokenEventStore} from '../src/token-event-store';
import {syncTokenEvents} from '../src/token-event-worker';
import {normalizeTokenRegistration} from '../src/token-event-projector';
import {parseTokenManifest,tokenManifestId,type TokenManifest} from '../src/token-manifest';
import {analyticsFixture,analyticsLog,parseEvidenceBlock,evidenceRegistrations} from './token-event-fixture';
import {tokenHash as h} from './token-fixture';

const databaseUrl=process.env.ONESHOT_INDEXER_TEST_DATABASE_URL;
async function withStore(manifest:TokenManifest,run:(value:{pool:Pool;store:PostgresTokenEventStore;id:string})=>Promise<void>){
  if(!databaseUrl)throw new Error('Explicit disposable test database required');
  const pool=new Pool({connectionString:databaseUrl,max:3,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,statement_timeout:10000}),store=new PostgresTokenEventStore(pool),id=tokenManifestId(manifest);let initialized=false;
  try{await store.initialize(manifest);initialized=true;await run({pool,store,id});}
  finally{try{if(initialized){await pool.query('DELETE FROM oneshot_evm_token_event_journal WHERE manifest_id=$1',[id]);await pool.query('DELETE FROM oneshot_evm_token_event_projections WHERE manifest_id=$1',[id]);await pool.query('DELETE FROM oneshot_evm_token_event_deployments WHERE manifest_id=$1',[id]);}}finally{await pool.end();}}
}
const uniqueFixture=()=>analyticsFixture({factory:`0x${randomBytes(20).toString('hex')}` as Address,genesis:`0x${randomBytes(32).toString('hex')}` as Hex});
describe.skipIf(!databaseUrl)('real PostgreSQL canonical token event journal',()=>{
  it('registers additively and commits each exact input once without double-counting pool and oneshot volume',async()=>{
    const f=await uniqueFixture();await withStore(f.manifest,async({pool,store,id})=>{
      await store.initialize(f.manifest);expect(await store.applyBlock(f.first,f.creation,[f.registered])).toMatchObject({applied:true,created:1});
      expect(await store.applyBlock(f.first,f.creation,[f.registered])).toMatchObject({applied:false});
      await store.applyBlock(f.next,f.swaps);
      expect(await store.projection('markets',f.market)).toMatchObject({poolNativeVolumeRaw:'1010',oneshotGrossNativeVolumeRaw:'1000',holderCount:'3'});
      expect((await pool.query('SELECT count(*)::text AS count FROM oneshot_evm_token_event_logs WHERE manifest_id=$1',[id])).rows[0].count).toBe('9');
      await expect(store.applyBlock(f.next,f.swaps.slice(1))).rejects.toMatchObject({code:'TOKEN_EVENT_INPUT_CHANGED'});
      expect((await store.head())?.number).toBe(2n);
    });
  });
  it('rolls back failed blocks and reverses supply, holders, raw logs and orphaned prices atomically',async()=>{
    const f=await uniqueFixture();await withStore(f.manifest,async({pool,store,id})=>{
      await store.applyBlock(f.first,f.creation,[f.registered]);await store.applyBlock(f.next,f.swaps);const before=await store.projection('markets',f.market),walletBefore=await store.projection('wallets',f.buyer);
      const third=f.block(3);
      await expect(store.applyBlock(third,[analyticsLog(third,f.token,'Transfer',{from:f.other,to:f.buyer,value:1n},0)])).rejects.toMatchObject({code:'TOKEN_EVENT_BALANCE_UNDERFLOW'});
      expect((await store.head())?.number).toBe(2n);expect(await store.projection('markets',f.market)).toEqual(before);
      await store.applyBlock(third,[analyticsLog(third,f.token,'Transfer',{from:f.buyer,to:zeroAddress,value:8n},0)]);
      expect(await store.projection('markets',f.market)).toMatchObject({burnedRaw:'8',observedSupplyRaw:(f.supply-8n).toString()});
      await expect(store.rollbackHead(f.block(4))).rejects.toMatchObject({code:'CONCURRENT_SYNC'});
      await store.rollbackHead(third);expect(await store.projection('markets',f.market)).toEqual(before);expect(await store.projection('wallets',f.buyer)).toEqual(walletBefore);
      const replacement=f.block(3,h(333),f.next.hash);
      await store.applyBlock(replacement,[analyticsLog(replacement,f.poolManager,'Swap',{id:f.registered.poolId,sender:f.router,amount0:2n,amount1:-1n,sqrtPriceX96:1n<<96n,liquidity:777n,tick:0,fee:2500},0)]);
      expect(await store.projection('markets',f.market)).toMatchObject({poolNativeVolumeRaw:'1012',burnedRaw:'0',priceBlockHash:replacement.hash});
      await store.rollbackHead(replacement);await store.rollbackHead(f.next);await store.rollbackHead(f.first);
      expect(await store.head()).toBeNull();expect(await store.projection('markets',f.market)).toBeNull();
      expect(await store.projection('wallets',f.buyer)).toBeNull();expect(await store.projection('wallets',f.poolManager)).toBeNull();
      expect((await pool.query('SELECT count(*)::text AS count FROM oneshot_evm_token_event_logs WHERE manifest_id=$1',[id])).rows[0].count).toBe('0');
    });
  });
  it('serializes concurrent writers for one deployment without replaying balances or events',async()=>{
    const f=await uniqueFixture();await withStore(f.manifest,async({pool,store})=>{
      const second=new PostgresTokenEventStore(pool);await second.initialize(f.manifest);
      const results=await Promise.all([store.applyBlock(f.first,f.creation,[f.registered]),second.applyBlock(f.first,f.creation,[f.registered])]);
      expect(results.map(value=>value.applied).sort()).toEqual([false,true]);expect(await store.projection('markets',f.market)).toMatchObject({holderCount:'2',mintedRaw:f.supply.toString()});
      const fresh=new PostgresTokenEventStore(pool),other=parseTokenManifest({...f.manifest,startBlock:f.manifest.startBlock.toString(),quoter:{...f.manifest.quoter,codeHash:h(987)}});
      const registration=await Promise.allSettled([fresh.initialize(f.manifest),fresh.initialize(other)]);
      expect(registration[0].status).toBe('fulfilled');expect(registration[1]).toMatchObject({status:'rejected',reason:{code:'TOKEN_MANIFEST_MISMATCH'}});
      for(let number=2;number<=100;number++){await store.applyBlock(f.block(number),[]);if([9,10,99,100].includes(number))expect((await store.head())?.number).toBe(BigInt(number));}
    });
  });
  it('replays actual local-chain receipts and an orphan/replacement branch, matching captured on-chain total supply',async()=>{
    const evidence=JSON.parse(await readFile(new URL('./fixtures/token-event-rehearsal.json',import.meta.url),'utf8')),manifest=parseTokenManifest(evidence.manifest);
    await withStore(manifest,async({pool,store,id})=>{
      for(const raw of evidence.blocks){const{block,logs}=parseEvidenceBlock(raw);await store.applyBlock(block,logs,evidenceRegistrations(manifest,block,logs,evidence.registrations));}
      for(const proof of evidence.registrations){
        const market=await store.projection('markets',proof.market);expect(market?.observedSupplyRaw).toBe(proof.totalSupplyRaw);
        const balances=(await pool.query("SELECT COALESCE(sum((value->>'balanceRaw')::numeric),0)::text AS supply,count(*) FILTER(WHERE (value->>'balanceRaw')::numeric>0)::text AS holders FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 AND kind='balances' AND value->>'token'=$2",[id,proof.token])).rows[0];
        expect(balances).toEqual({supply:market!.observedSupplyRaw,holders:market!.holderCount});
      }
      for(const raw of [...evidence.blocks].reverse())if(BigInt(raw.number)>BigInt(evidence.commonAncestor.number))await store.rollbackHead(parseEvidenceBlock(raw).block);
      expect((await store.head())?.hash).toBe(evidence.commonAncestor.hash);
      const before=(await pool.query('SELECT kind,entity_id,value FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 ORDER BY kind,entity_id',[id])).rows;
      for(const raw of evidence.orphanBranch){const{block,logs}=parseEvidenceBlock(raw);await store.applyBlock(block,logs,evidenceRegistrations(manifest,block,logs,evidence.registrations));}
      for(const raw of [...evidence.orphanBranch].reverse()){await store.rollbackHead(parseEvidenceBlock(raw).block);}
      expect((await pool.query('SELECT kind,entity_id,value FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 ORDER BY kind,entity_id',[id])).rows).toEqual(before);
      for(const raw of evidence.replacementBranch){const{block,logs}=parseEvidenceBlock(raw);await store.applyBlock(block,logs,evidenceRegistrations(manifest,block,logs,evidence.registrations));}
      const last=parseEvidenceBlock(evidence.replacementBranch.at(-1)).block;expect((await store.head())?.hash).toBe(last.hash);
      expect((await store.projection('markets',evidence.registrations[0].market))?.priceBlockHash).toBe(last.hash);
      const oldHashes=evidence.orphanBranch.map((raw:Record<string,unknown>)=>raw.hash);
      const old=await pool.query("SELECT count(*)::text AS count FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 AND kind='events' AND value->>'blockHash'=ANY($2::text[])",[id,oldHashes]);expect(old.rows[0].count).toBe('0');
    });
  });
  it('ingests captured real-chain blocks in bounded passes and replaces a reorg through the worker without partial block state',async()=>{
    const evidence=JSON.parse(await readFile(new URL('./fixtures/token-event-rehearsal.json',import.meta.url),'utf8'));
    const manifest=parseTokenManifest({...evidence.manifest,quoter:{...evidence.manifest.quoter,codeHash:`0x${randomBytes(32).toString('hex')}`}});
    await withStore(manifest,async({store})=>{
      const state={replacement:false,failed:false},height=BigInt(evidence.blocks.at(-1).number);
      const row=(number:bigint)=>{const branch=state.replacement?evidence.replacementBranch:evidence.orphanBranch;return branch.find((raw:Record<string,unknown>)=>BigInt(raw.number as string)===number)??evidence.blocks.find((raw:Record<string,unknown>)=>BigInt(raw.number as string)===number);};
      const source={height:async()=>height,block:async(number:bigint)=>parseEvidenceBlock(row(number)).block,
        verify:async(_manifest:unknown,block?:import('../src/types').Block)=>{if(!block||parseEvidenceBlock(row(block.number)).block.hash!==block.hash)throw new Error('Fixture canonicality mismatch');return{block,platformRecipient:evidence.registrations[0].platformRecipient};},
        capture:async(_manifest:unknown,block:import('../src/types').Block)=>{if(state.failed)throw new Error('Injected unavailable source');const value=parseEvidenceBlock(row(block.number));return{...value,registrations:evidenceRegistrations(manifest,value.block,value.logs,evidence.registrations).map(normalizeTokenRegistration),reads:1};}};
      expect(await syncTokenEvents(source,store,manifest,{maximumBlocks:8,confirmations:0})).toMatchObject({applied:8,complete:false});
      const before=await store.head();state.failed=true;await expect(syncTokenEvents(source,store,manifest,{maximumBlocks:8,confirmations:0})).rejects.toThrow('Injected unavailable source');expect(await store.head()).toEqual(before);state.failed=false;
      while(!(await syncTokenEvents(source,store,manifest,{maximumBlocks:8,confirmations:0})).complete){}
      expect((await store.head())?.hash).toBe(evidence.orphanBranch.at(-1).hash);expect(await store.registrations()).toHaveLength(2);
      state.replacement=true;expect(await syncTokenEvents(source,store,manifest,{maximumBlocks:8,confirmations:0})).toMatchObject({orphaned:1,applied:1,complete:true});
      expect((await store.head())?.hash).toBe(evidence.replacementBranch.at(-1).hash);
      for(const proof of evidence.registrations)expect((await store.projection('markets',proof.market))?.observedSupplyRaw).toBe(proof.totalSupplyRaw);
    });
  });
});
