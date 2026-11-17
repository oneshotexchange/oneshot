import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';
import { describe,it,expect } from 'vitest';
import { PostgresIndexerStore } from '../../../indexer/src/store';
import { createIndexedNftReader } from './indexed-nfts';
import { api } from './http';
import { manifestId } from '../../../indexer/src/manifest';
import { v3Manifest,at,appendV3,market,collection } from '../../../indexer/test/nft-v3-fixture';
const url=process.env.ONESHOT_API_TEST_DATABASE_URL;
describe.skipIf(!url)('V3 PostgreSQL projections and public totals',()=>{
  it('keeps funded offers separate, counts accepted sales once, detects tampering and reverses reorgs',async()=>{
    const pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:5000}),store=new PostgresIndexerStore(pool);
    const manifest={...v3Manifest,factory:{...v3Manifest.factory,codeHash:`0x${randomBytes(32).toString('hex')}` as `0x${string}`}},id=manifestId(manifest);let head=3;
    const source={verify:async()=>{},height:async()=>BigInt(head),block:async(n:bigint)=>at(Number(n)),logs:async()=>[],offerAccounting:async()=>({escrow:'10000',pending:'10000',balance:'20000'})};
    const reader=createIndexedNftReader({pool:()=>pool,source:async()=>source,loadManifest:async()=>manifest,env:()=>({ONESHOT_INDEXER_READS_ENABLED:'true',ONESHOT_NETWORK:'local',DATABASE_URL:url,ONESHOT_INDEXER_MANIFEST_PATH:'test'}),contentResolver:()=>async()=>null});
    const read=()=>api(req=>reader(req))(new NextRequest(`http://localhost/api/oneshot/indexed/collections/${collection}`),{});
    try{
      await store.initialize(id);for(let n=1;n<=3;n++)await appendV3(store,n,manifest);
      const response=await read();expect(response.status).toBe(200);const body=await response.json();expect(body.marketStats).toMatchObject({completedSales:'1',secondaryVolumeRaw:'10000',activeListings:'0',lowestListingPriceRaw:null});
      await store.transaction(async tx=>{const sales=await tx.list('offer-sales');const key=Object.keys(sales)[0];await tx.put('offer-sales',key,{...sales[key],totalPrice:'999'});await tx.append(at(4),[]);});head=4;
      expect((await read()).status).toBe(503);
      await store.transaction(tx=>tx.rollbackHead());head=3;expect((await read()).status).toBe(200);
      await store.transaction(tx=>tx.rollbackHead());const offer=await store.transaction(tx=>tx.get('offers','1'));expect(offer?.remaining).toBe('2');expect(await store.transaction(tx=>tx.list('offer-sales'))).toEqual({});
      const rows=await pool.query('SELECT count(*)::int AS n FROM oneshot_evm_offer_projections WHERE manifest_id=$1',[id]);expect(rows.rows[0].n).toBe(2);
    }finally{
      for(const table of ['oneshot_evm_logs','oneshot_evm_journal','oneshot_evm_projections','oneshot_evm_offer_projections','oneshot_evm_deployments'])await pool.query(`DELETE FROM ${table} WHERE manifest_id=$1`,[id]);
      await store.close();
    }
  });
});
