import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {describe,expect,it} from 'vitest';
import {NextRequest} from 'next/server';
import {tokenFixture,tokenHash} from '../../../indexer/test/token-fixture';
import {PostgresTokenSnapshotStore,syncTokenSnapshot} from '../../../indexer/src/token-store';
import {tokenManifestId} from '../../../indexer/src/token-manifest';
import {createIndexedTokenReader} from './indexed-tokens';
import {api} from './http';
import type {SqlPool} from '../../../indexer/src/store';

// Explicit disposable test database only; never falls back to DATABASE_URL.
const databaseUrl=process.env.ONESHOT_INDEXER_TEST_DATABASE_URL;
async function withDatabase(run:(fixture:Awaited<ReturnType<typeof setup>>)=>Promise<void>,base=false){
  const fixture=await setup(base);try{await run(fixture);}finally{
    try{await fixture.pool.query('DELETE FROM oneshot_evm_token_checkpoints WHERE manifest_id=$1',[fixture.id]);await fixture.pool.query('DELETE FROM oneshot_evm_token_deployments WHERE manifest_id=$1',[fixture.id]);}finally{await fixture.pool.end();}
  }
}
async function setup(base:boolean){
  if(!databaseUrl)throw new Error('Explicit test database required');
  const unique=`0x${randomBytes(20).toString('hex')}` as const;
  const f=tokenFixture({base,factory:unique,genesis:`0x${randomBytes(32).toString('hex')}`}),id=tokenManifestId(f.manifest);
  const pool=new Pool({connectionString:databaseUrl,max:3,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,statement_timeout:10000}),store=new PostgresTokenSnapshotStore(pool);
  try{await store.initialize(f.manifest);}catch(error){await pool.end();throw error;}
  const env={ONESHOT_TOKEN_INDEXER_READS_ENABLED:'true',ONESHOT_NETWORK:f.manifest.mode,DATABASE_URL:databaseUrl,ONESHOT_TOKEN_INDEXER_MANIFEST_PATH:'injected-token-test.json'};
  const reader=(override:SqlPool=pool)=>createIndexedTokenReader({env:()=>env,pool:()=>override,loadManifest:async()=>f.manifest,source:async()=>f.source});
  const read=(suffix='',override?:SqlPool)=>api(request=>reader(override)(request))(new NextRequest(`http://localhost/api/oneshot/token-indexed/markets${suffix}`),{});
  return{...f,id,pool,store,read};
}
const body=async(response:Response)=>{expect(response.status).toBe(200);return response.json();};
describe.skipIf(!databaseUrl)('real PostgreSQL isolated token snapshots',()=>{
  it('registers idempotently and reads a pinned Base snapshot with exact supply, full-search and runtime source identity',async()=>{
    await withDatabase(async f=>{
      expect((await body(await f.read())).context.available).toBe(false);
      await syncTokenSnapshot(f.source,f.store,f.manifest);await f.store.initialize(f.manifest);
      const listed=await body(await f.read('?q=canonical'));
      expect(listed.context).toMatchObject({deploymentId:f.id,network:{mode:'base-sepolia',chainId:84532},source:{quoter:f.manifest.quoter},checkpoint:{number:'3'},finalized:false});
      expect(listed.items[0]).toMatchObject({market:f.market,tokenDecimals:8,totalSupplyRaw:'100000000000000000'});
      expect((await body(await f.read('?q=%25_'))).items).toEqual([]);
      expect((await body(await f.read(`/${f.market}`))).market.market).toBe(f.market);
      const count=await f.pool.query('SELECT count(*)::text AS count FROM oneshot_evm_token_deployments WHERE manifest_id=$1',[f.id]);expect(count.rows[0].count).toBe('1');
    },true);
  });
  it('keeps snapshot records immutable, rejects concurrent writers and preserves the previous state on scan failure',async()=>{
    await withDatabase(async f=>{
      const initial=await f.source.snapshot(f.manifest);await syncTokenSnapshot(f.source,f.store,f.manifest);
      await f.store.commit(f.manifest,initial,initial.block,initial.block);
      await expect(f.store.commit(f.manifest,{...initial,markets:[{...initial.markets[0],name:'Changed at same block'}]},initial.block,initial.block)).rejects.toMatchObject({code:'TOKEN_CHECKPOINT_INVALID'});
      f.state.head=4n;f.state.totalSupply-=1n;await syncTokenSnapshot(f.source,f.store,f.manifest);
      const current=await body(await f.read());expect(current.context.checkpoint.number).toBe('4');expect(current.items[0].totalSupplyRaw).toBe('99999999999999999');
      await expect(f.store.commit(f.manifest,initial,initial.block,initial.block)).rejects.toMatchObject({code:'CONCURRENT_SYNC'});
      f.state.count=26n;await expect(syncTokenSnapshot(f.source,f.store,f.manifest,25)).rejects.toMatchObject({code:'TOKEN_SOURCE_LIMIT'});
      expect((await body(await f.read())).context.checkpoint.number).toBe('4');
      f.state.count=1n;
      for(const number of [9n,10n,99n,100n]){f.state.head=number;await syncTokenSnapshot(f.source,f.store,f.manifest);
        expect((await f.store.heads(f.manifest))[0].number).toBe(number);
        expect((await body(await f.read())).context.checkpoint.number).toBe(number.toString());}
    });
  });
  it('rejects orphaned public reads, replaces only the orphaned token branch and fails behind writers closed',async()=>{
    await withDatabase(async f=>{
      await syncTokenSnapshot(f.source,f.store,f.manifest);f.state.head=4n;await syncTokenSnapshot(f.source,f.store,f.manifest);
      f.state.hashes.set(4n,tokenHash(999));
      const stale=await f.read();expect(stale.status).toBe(409);expect(await stale.json()).not.toHaveProperty('items');
      f.state.head=5n;f.state.totalSupply-=7n;
      const replaced=await syncTokenSnapshot(f.source,f.store,f.manifest);expect(replaced.orphaned).toBe(1);
      const rows=await f.pool.query('SELECT block_number::text FROM oneshot_evm_token_checkpoints WHERE manifest_id=$1 ORDER BY block_number',[f.id]);expect(rows.rows.map(row=>row.block_number)).toEqual(['3','5']);
      const current=await body(await f.read());expect(current.context.checkpoint.number).toBe('5');expect(current.items[0].totalSupplyRaw).toBe('99999999999999993');
      f.state.head=3n;await expect(syncTokenSnapshot(f.source,f.store,f.manifest)).rejects.toMatchObject({code:'TOKEN_SOURCE_BEHIND'});
      expect((await f.store.heads(f.manifest))[0].number).toBe(5n);
    });
  });
  it('holds a complete checkpoint during a concurrent commit and rejects corrupted/missing snapshot records',async()=>{
    await withDatabase(async f=>{
      await syncTokenSnapshot(f.source,f.store,f.manifest);
      let reached!:()=>void,resume!:()=>void;const paused=new Promise<void>(resolve=>{reached=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
      const observed:SqlPool={async connect(){const client=await f.pool.connect();return{release:()=>client.release(),async query(sql,values){const result=await client.query(sql,values);if(sql.startsWith('SELECT block_number')){reached();await gate;}return result;}};}};
      const reading=f.read('',observed);
      try{await Promise.race([paused,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Token checkpoint barrier timeout')),5000).unref())]);f.state.head=4n;f.state.totalSupply-=1n;await syncTokenSnapshot(f.source,f.store,f.manifest);}finally{resume();}
      const held=await body(await reading);expect(held.context.checkpoint.number).toBe('3');expect(held.items[0].totalSupplyRaw).toBe('100000000000000000');
      await f.pool.query('DELETE FROM oneshot_evm_token_market_snapshots WHERE manifest_id=$1 AND block_number=4',[f.id]);
      const broken=await f.read();expect(broken.status).toBe(503);expect(await broken.json()).not.toHaveProperty('items');
    });
  });
});
