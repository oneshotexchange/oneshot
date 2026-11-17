import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {createIndexedTokenReader} from './indexed-tokens';
import {api} from './http';
import {tokenFixture,tokenHash,tokenAddress} from '../../../indexer/test/token-fixture';
import {tokenManifestJson} from '../../../indexer/src/token-manifest';
import {oneshotApi} from './oneshot-api';
import * as auth from './oneshot-auth';
import type {SqlPool} from '../../../indexer/src/store';
beforeEach(()=>vi.stubEnv('NEXT_PUBLIC_APP_URL','http://localhost'));
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
async function fixture(){
  const chain=tokenFixture({base:true}),snapshot=await chain.source.snapshot(chain.manifest);
  const env:Record<string,string|undefined>={ONESHOT_TOKEN_INDEXER_READS_ENABLED:'true',ONESHOT_NETWORK:'base-sepolia',DATABASE_URL:'postgresql://unused-unit-only',ONESHOT_TOKEN_INDEXER_MANIFEST_PATH:'unit-only.json'};
  const rows=snapshot.markets.map((value,ordinal)=>({ordinal,market:value.market,token:value.token,value}));
  const state={rows,count:1,failSql:false};
  const query=vi.fn(async(sql:string,values?:unknown[])=>{
    if(state.failSql&&sql.startsWith('SELECT'))throw new Error('private-db-secret');
    if(sql.startsWith('SELECT manifest'))return{rows:[{manifest:tokenManifestJson(chain.manifest)}],rowCount:1};
    if(sql.startsWith('SELECT block_number'))return{rows:[{block_number:'3',block_hash:snapshot.block.hash,parent_hash:snapshot.block.parentHash,block_timestamp:snapshot.block.timestamp.toString(),market_count:state.count}],rowCount:1};
    if(sql.startsWith('SELECT count'))return{rows:[{count:String(state.rows.length)}],rowCount:1};
    if(sql.startsWith('SELECT ordinal')){
      const result=sql.includes('market=$3')?state.rows.filter(row=>row.market===values?.[2]):sql.includes('ordinal>')?state.rows.filter(row=>row.ordinal>Number(values?.at(-2))):state.rows;
      return{rows:result,rowCount:result.length};
    }
    return{rows:[],rowCount:0};
  });
  const release=vi.fn(),pool=vi.fn<()=>SqlPool|null>(()=>({connect:async()=>({query,release})}));
  const loadManifest=vi.fn(async()=>chain.manifest),source=vi.fn(async()=>chain.source);
  const reader=createIndexedTokenReader({env:()=>env,pool,loadManifest,source});
  const read=(suffix='',method='GET')=>api(request=>reader(request))(new NextRequest(`http://localhost/api/oneshot/token-indexed/markets${suffix}`,{method}),{});
  return{...chain,snapshot,env,state,query,release,pool,loadManifest,source,read};
}
describe('public canonical token read boundary',()=>{
  it('serves exact Base snapshots with token8/native18 and no inferred trading figures or private extras',async()=>{
    const f=await fixture();Object.assign(f.state.rows[0].value,{privateEndpoint:'https://secret'});
    const response=await f.read();expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
    const body=await response.json();expect(body.context).toMatchObject({schemaVersion:1,available:true,network:{mode:'base-sepolia',chainId:84532,nativeSymbol:'ETH',nativeDecimals:18},readonly:true,finalized:false,kind:'canonical-contract-snapshot'});
    expect(body.items[0]).toMatchObject({market:f.market,token:f.token,tokenDecimals:8,totalSupplyRaw:'100000000000000000'});
    expect(JSON.stringify(body)).not.toMatch(/privateEndpoint|https:\/\/secret|spotPrice|volume|holders|Aptos/);
    expect(f.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');expect(f.query).toHaveBeenCalledWith('COMMIT');expect(f.release).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.some(([sql])=>/CREATE|INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
  });
  it('binds cursors to search, limit, manifest and checkpoint and searches the complete checkpoint literally',async()=>{
    const f=await fixture();f.state.count=2;f.state.rows.push({ordinal:1,market:tokenAddress(20),token:tokenAddress(21),value:{...f.state.rows[0].value,market:tokenAddress(20),token:tokenAddress(21)}});
    f.state.rows[1].value.poolId=tokenHash(555);
    const first=await(await f.read('?limit=1&q=canonical')).json();expect(first.items).toHaveLength(1);expect(first.nextCursor).toBeTypeOf('string');
    expect((await(await f.read('?q=%25_')).json()).items).toEqual([]);
    expect((await f.read(`?limit=1&q=other&cursor=${first.nextCursor}`)).status).toBe(400);
    expect((await f.read(`?limit=2&q=canonical&cursor=${first.nextCursor}`)).status).toBe(400);
    const second=await(await f.read(`?limit=1&q=canonical&cursor=${first.nextCursor}`)).json();expect(second.items[0].market).toBe(tokenAddress(20));
    const cursor=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString());cursor.hash=tokenHash(999);
    expect((await f.read(`?limit=1&q=canonical&cursor=${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`)).status).toBe(409);
  });
  it('requires exact requested market detail and treats an unknown market as404',async()=>{
    const f=await fixture(),response=await f.read(`/${f.market}`);expect(response.status).toBe(200);expect((await response.json()).market.market).toBe(f.market);
    expect((await f.read(`/${tokenAddress(999)}`)).status).toBe(404);
    expect((await f.read(`/${f.market}?q=anything`)).status).toBe(400);
  });
  it('keeps explicit disabled state separate from SQL failure and incomplete snapshot rows',async()=>{
    const f=await fixture();f.env.ONESHOT_TOKEN_INDEXER_READS_ENABLED='false';
    const disabled=await f.read();expect((await disabled.json()).context).toMatchObject({enabled:false,available:false,network:null,checkpoint:null});expect(f.pool).not.toHaveBeenCalled();
    f.env.ONESHOT_TOKEN_INDEXER_READS_ENABLED='true';f.state.count=2;
    expect((await f.read()).status).toBe(503);expect(f.query).toHaveBeenCalledWith('ROLLBACK');
    f.state.count=1;f.state.failSql=true;const failed=await f.read();expect(failed.status).toBe(503);expect(JSON.stringify(await failed.json())).not.toMatch(/private-db-secret|items/);
  });
  it('does not hide a corrupt row behind a search with no matches',async()=>{
    const f=await fixture();f.state.rows[0].value.totalSupplyRaw='01';
    const response=await f.read('?q=missing');expect(response.status).toBe(503);expect(await response.json()).not.toHaveProperty('items');
  });
  it('rejects profile mismatch and malformed inputs before database work',async()=>{
    const f=await fixture();
    for(const suffix of ['?limit=26','?limit=01','?q=a&q=b','?q=%00','?cursor=bad','/not-address'])expect((await f.read(suffix)).status).toBeGreaterThanOrEqual(400);
    expect(f.pool).not.toHaveBeenCalled();
    f.env.ONESHOT_NETWORK='local';expect((await f.read()).status).toBe(503);expect(f.pool).not.toHaveBeenCalled();
    expect((await f.read('','POST')).status).toBe(405);
  });
  it('routes public token snapshots before account authentication without reviving legacy token routes',async()=>{
    vi.stubEnv('ONESHOT_TOKEN_INDEXER_READS_ENABLED','false');
    const session=vi.spyOn(auth,'requireOneshotSession').mockRejectedValue(new Error('No auth expected'));
    const response=await oneshotApi(new NextRequest('http://localhost/api/oneshot/token-indexed/markets'),{});
    expect(response.status).toBe(200);expect(session).not.toHaveBeenCalled();expect((await response.json()).context.available).toBe(false);
  });
});
