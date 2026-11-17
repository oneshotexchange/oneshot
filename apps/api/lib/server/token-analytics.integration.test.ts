import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {NextRequest} from 'next/server';
import {describe,expect,it,vi} from 'vitest';
import {encodeAbiParameters,keccak256,zeroAddress,type Address} from 'viem';
import {createTokenAnalyticsReader} from './token-analytics';
import {createTokenWalletReader} from './token-wallets';
import {api} from './http';
import {PostgresTokenEventStore} from '../../../indexer/src/token-event-store';
import {parseTokenManifest,tokenManifestId} from '../../../indexer/src/token-manifest';
import {MemoryTokenEventAdapter,analyticsLog,parseEvidenceBlock,evidenceRegistrations} from '../../../indexer/test/token-event-fixture';
import {tokenMarketDto} from '../../../indexer/src/token-snapshot';
import {tokenAddress as a,tokenHash as h} from '../../../indexer/test/token-fixture';
import type {Block} from '../../../indexer/src/types';
import type {SqlPool} from '../../../indexer/src/store';

const databaseUrl=process.env.ONESHOT_INDEXER_TEST_DATABASE_URL;
async function setup(extraMarket=false){
  if(!databaseUrl)throw new Error('Explicit disposable test database required');
  const evidence=JSON.parse(await readFile(new URL('../../../indexer/test/fixtures/token-event-rehearsal.json',import.meta.url),'utf8'));
  // Each API test gets its own manifest fingerprint. RPC is an explicit injected
  // proof fixture; this is not a claim that the modified identity is deployed.
  const manifest=parseTokenManifest({...evidence.manifest,quoter:{...evidence.manifest.quoter,codeHash:`0x${randomBytes(32).toString('hex')}`}}),id=tokenManifestId(manifest);
  if(extraMarket){
    // One explicit synthetic third market tests SQL keyset pagination beyond the
    // two-market actual capture. It is never asserted to exist on a real chain.
    const parent=parseEvidenceBlock(evidence.blocks.at(-1)).block,block={number:parent.number+1n,hash:h(9900),parentHash:parent.hash,timestamp:parent.timestamp+1n},market=a(9100),token=a(9101),creator=evidence.registrations[0].creator as Address;
    const poolId=keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}],[zeroAddress,token,2500,10,manifest.oracle.address])),supply=100000000000000000n;
    const logs=[analyticsLog(block,token,'Transfer',{from:zeroAddress,to:market,value:supply},0),analyticsLog(block,manifest.poolManager.address,'Initialize',{id:poolId,currency0:zeroAddress,currency1:token,fee:2500,tickSpacing:10,hooks:manifest.oracle.address,sqrtPriceX96:1n<<96n,tick:0},1),analyticsLog(block,token,'Transfer',{from:market,to:manifest.poolManager.address,value:supply-3n},2),analyticsLog(block,manifest.factory.address,'MarketCreated',{market,token,creator,poolId},3)];
    evidence.blocks.push({...block,number:block.number.toString(),timestamp:block.timestamp.toString(),logs:logs.map(log=>({...log,blockNumber:log.blockNumber.toString(),removed:false}))});evidence.registrations.push({...evidence.registrations[0],market,token,creator,poolId,name:'Synthetic paging fixture',symbol:'PAGE',totalSupplyRaw:supply.toString()});
  }
  const pool=new Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,statement_timeout:10000}),store=new PostgresTokenEventStore(pool),memory=new MemoryTokenEventAdapter();
  const blocks=new Map<bigint,Block>(),supplies=new Map<bigint,Map<string,string>>(),walletBalances=new Map<bigint,Map<string,string>>();
  for(const raw of evidence.blocks){const{block,logs}=parseEvidenceBlock(raw);blocks.set(block.number,block);await memory.apply(manifest,block,logs,evidenceRegistrations(manifest,block,logs,evidence.registrations));supplies.set(block.number,new Map(evidence.registrations.filter((proof:Record<string,unknown>)=>memory.get('markets',proof.market as string)).map((proof:Record<string,unknown>)=>[proof.market as string,memory.get('markets',proof.market as string)!.observedSupplyRaw as string])));walletBalances.set(block.number,new Map([...memory.state].filter(([key])=>key.startsWith('balances:')).map(([,value])=>[`${value.token}:${value.wallet}`,value.balanceRaw as string])));}
  const latest=blocks.get(BigInt(evidence.blocks.at(-1).number))!;
  const state={height:latest.number+3n,reorg:false,privateError:false,wrongBalance:false};
  const source={verify:vi.fn(async(_manifest:unknown,block?:Block)=>{if(state.privateError)throw new Error('secret-provider-url');if(!block||blocks.get(block.number)?.hash!==block.hash||state.reorg)throw{code:'TOKEN_CHAIN_MOVED'};return{block};}),
    verifyMarket:vi.fn(async(_manifest:unknown,market:string,block:Block)=>{await source.verify(_manifest,block);const proof=evidence.registrations.find((row:Record<string,unknown>)=>row.market===market);if(!proof)throw{code:'TOKEN_MARKET_UNREGISTERED'};return tokenMarketDto({...proof,totalSupplyRaw:supplies.get(block.number)!.get(market),privateKey:'must-never-escape'});}),
    height:async()=>state.height,block:async(number:bigint)=>{const block=blocks.get(number);if(!block)throw new Error('Missing fixture block');return state.reorg?{...block,hash:h(999)}:block;}};
  const walletSource={...source,verifyWalletBalances:vi.fn(async(_manifest:unknown,markets:readonly Address[],wallet:Address,block:Block)=>Promise.all(markets.map(async market=>{const proof=await source.verifyMarket(_manifest,market,block),balance=walletBalances.get(block.number)!.get(`${proof.token}:${wallet}`)??'0';return{market:proof,balanceRaw:(BigInt(balance)+(state.wrongBalance?1n:0n)).toString()};})))};
  const env:Record<string,string|undefined>={ONESHOT_TOKEN_ANALYTICS_READS_ENABLED:'true',ONESHOT_NETWORK:manifest.mode,DATABASE_URL:databaseUrl,ONESHOT_TOKEN_INDEXER_MANIFEST_PATH:'injected-test-only'};
  const reader=(override:SqlPool=pool)=>createTokenAnalyticsReader({env:()=>env,pool:()=>override,loadManifest:async()=>manifest,source:async()=>source});
  const market=evidence.registrations[0].market as string;
  const read=(suffix='',override?:SqlPool)=>api(request=>reader(override)(request))(new NextRequest(`http://localhost/api/oneshot/token-analytics/markets/${market}${suffix}`),{});
  const readWallet=(wallet:string,suffix='',override:SqlPool=pool)=>{const reader=createTokenWalletReader({env:()=>env,pool:()=>override,loadManifest:async()=>manifest,source:async()=>walletSource});return api(request=>reader(request))(new NextRequest(`http://localhost/api/oneshot/token-analytics/wallets/${wallet}${suffix}`),{});};
  const replay=async()=>{for(const raw of evidence.blocks){const{block,logs}=parseEvidenceBlock(raw);await store.applyBlock(block,logs,evidenceRegistrations(manifest,block,logs,evidence.registrations));}};
  try{await store.initialize(manifest);}catch(error){await pool.end();throw error;}
  return{pool,store,manifest,id,evidence,blocks,source,walletSource,walletBalances,state,env,read,readWallet,replay,market,latest,async close(){try{await pool.query('DELETE FROM oneshot_evm_token_event_journal WHERE manifest_id=$1',[id]);await pool.query('DELETE FROM oneshot_evm_token_event_projections WHERE manifest_id=$1',[id]);await pool.query('DELETE FROM oneshot_evm_token_event_deployments WHERE manifest_id=$1',[id]);}finally{await pool.end();}}};
}
async function withFixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>,extraMarket=false){const f=await setup(extraMarket);try{await run(f);}finally{await f.close();}}
const body=async(response:Response)=>{expect(response.status).toBe(200);return response.json();};
describe.skipIf(!databaseUrl)('real PostgreSQL canonical token analytics API',()=>{
  it('serves captured actual-chain totals, exact sqrt price ratio, checkpoint identity and explicit non-finalized lag',async()=>withFixture(async f=>{
    expect((await body(await f.read())).context.available).toBe(false);await f.replay();
    const response=await f.read(),value=await body(response);expect(response.headers.get('cache-control')).toBe('no-store');
    expect(value.context).toMatchObject({kind:'canonical-event-journal',available:true,deploymentId:f.id,checkpoint:{number:f.latest.number.toString(),hash:f.latest.hash},observedHeadNumber:f.state.height.toString(),lagBlocks:'3',finalized:false});
    const market=await f.store.projection('markets',f.market);expect(value.analytics).toMatchObject({observedSupplyRaw:market!.observedSupplyRaw,burnedRaw:market!.burnedRaw,poolNativeVolumeRaw:market!.poolNativeVolumeRaw,oneshotGrossNativeVolumeRaw:market!.oneshotGrossNativeVolumeRaw,holderScope:'all-nonzero-balance-addresses'});
    const price=value.analytics.price,sqrt=BigInt(price.sqrtPriceX96Raw);expect(price.nativeRawPerWholeToken).toEqual({numerator:((1n<<192n)*100000000n).toString(),denominator:(sqrt*sqrt).toString()});
    expect(JSON.stringify(value)).not.toMatch(/privateKey|secret-provider|Aptos|ZRO|pnl/i);expect(f.source.verifyMarket).toHaveBeenCalledWith(f.manifest,f.market,f.latest);
  }));
  it('paginates canonical all-route swaps and separate oneshot trades with unknown external identities and bound cursors',async()=>withFixture(async f=>{
    await f.replay();const first=await body(await f.read('/trades?limit=1'));expect(first.items).toHaveLength(1);expect(first.items[0]).toMatchObject({kind:'pool-swap',trader:null,recipient:null});expect(first.nextCursor).toBeTypeOf('string');
    const next=await body(await f.read(`/trades?limit=1&cursor=${first.nextCursor}`));expect(next.items[0].id).not.toBe(first.items[0].id);
    const own=await body(await f.read('/trades?kind=oneshot-trade&limit=50'));expect(own.items.length).toBeGreaterThan(0);for(const trade of own.items)expect(trade).toMatchObject({kind:'oneshot-trade',trader:expect.stringMatching(/^0x/),recipient:expect.stringMatching(/^0x/)});
    expect((await f.read(`/trades?limit=2&cursor=${first.nextCursor}`)).status).toBe(400);expect((await f.read(`/trades?kind=oneshot-trade&limit=1&cursor=${first.nextCursor}`)).status).toBe(400);
    const stale=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString());stale.hash=h(999);expect((await f.read(`/trades?limit=1&cursor=${Buffer.from(JSON.stringify(stale)).toString('base64url')}`)).status).toBe(409);
  }));
  it('returns only positive holder balances and rejects a missing ledger row instead of a successful empty page',async()=>withFixture(async f=>{
    await f.replay();let cursor:string|null=null;const holders=[];
    do{const value=await body(await f.read(`/holders?limit=1${cursor?`&cursor=${cursor}`:''}`));holders.push(...value.items);cursor=value.nextCursor;}while(cursor);
    const detail=await body(await f.read());expect(holders.length.toString()).toBe(detail.analytics.holderCount);expect(holders.reduce((sum,row)=>sum+BigInt(row.balanceRaw),0n).toString()).toBe(detail.analytics.observedSupplyRaw);
    expect(holders.every(row=>BigInt(row.balanceRaw)>0n&&row.wallet!==a(0))).toBe(true);
    await f.pool.query("DELETE FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 AND kind='balances' AND value->>'wallet'=$2 AND value->>'token'=$3",[f.id,holders[0].wallet,detail.market.token]);
    const failed=await f.read('/holders');expect(failed.status).toBe(503);expect(await failed.json()).not.toHaveProperty('items');
  }));
  it('holds a single read checkpoint across a concurrent canonical commit and rejects orphaned or corrupted public data',async()=>withFixture(async f=>{
    await f.replay();let reached!:()=>void,resume!:()=>void;const paused=new Promise<void>(resolve=>{reached=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
    const observed:SqlPool={async connect(){const client=await f.pool.connect();return{release:()=>client.release(),async query(sql,values){const result=await client.query(sql,values);if(sql.startsWith('SELECT block_number')&&sql.includes('ORDER BY')){reached();await gate;}return result;}};}};
    const pending=f.read('',observed);await Promise.race([paused,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Checkpoint barrier timeout')),5000).unref())]);
    try{await f.store.rollbackHead(f.latest);}finally{resume();}
    expect((await body(await pending)).context.checkpoint.hash).toBe(f.latest.hash);
    const last=parseEvidenceBlock(f.evidence.blocks.at(-1));await f.store.applyBlock(last.block,last.logs,evidenceRegistrations(f.manifest,last.block,last.logs,f.evidence.registrations));
    f.state.reorg=true;expect((await f.read()).status).toBe(409);f.state.reorg=false;
    await f.pool.query("UPDATE oneshot_evm_token_event_projections SET value=jsonb_set(value,'{sqrtPriceX96Raw}','\"1\"'::jsonb) WHERE manifest_id=$1 AND kind='markets' AND entity_id=$2",[f.id,f.market]);
    expect((await f.read()).status).toBe(503);
  }));
  it('keeps disabled, not-found, malformed and infrastructure failures distinct without leaking diagnostics',async()=>withFixture(async f=>{
    f.env.ONESHOT_TOKEN_ANALYTICS_READS_ENABLED='false';expect((await body(await f.read())).context).toMatchObject({enabled:false,available:false,source:null,checkpoint:null});f.env.ONESHOT_TOKEN_ANALYTICS_READS_ENABLED='true';
    for(const suffix of ['?limit=1','/trades?kind=bad','/trades?limit=51','/holders?kind=all','/trades?cursor=bad'])expect((await f.read(suffix)).status).toBe(400);
    await f.replay();f.state.privateError=true;const failed=await f.read();expect(failed.status).toBe(503);expect(JSON.stringify(await failed.json())).not.toMatch(/secret-provider|items|analytics/);f.state.privateError=false;
    const reader=createTokenAnalyticsReader({env:()=>f.env,pool:()=>f.pool,loadManifest:async()=>f.manifest,source:async()=>f.source});
    const missing=await api(request=>reader(request))(new NextRequest(`http://localhost/api/oneshot/token-analytics/markets/${a(999)}`),{});expect(missing.status).toBe(404);
    await f.pool.query("DELETE FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 AND kind='markets' AND entity_id=$2",[f.id,f.market]);expect((await f.read()).status).toBe(503);
  }));
  it('serves exact positive public-wallet holdings from the actual transfer/burn/self-transfer capture, with successful empty distinguished',async()=>withFixture(async f=>{
    await f.replay();const trades=(await body(await f.read('/trades?kind=oneshot-trade&limit=50'))).items,trader=trades[0].trader;
    const response=await body(await f.readWallet(trader));expect(response).toMatchObject({wallet:trader,scope:'registered-token-markets',context:{available:true,kind:'canonical-event-journal',checkpoint:{hash:f.latest.hash}}});
    const expected=[...f.walletBalances.get(f.latest.number)!].filter(([key,value])=>key.endsWith(`:${trader}`)&&BigInt(value)>0n);expect(response.holdingCount).toBe(expected.length.toString());expect(response.items.length).toBe(expected.length);
    for(const item of response.items){expect(item.balanceRaw).toBe(f.walletBalances.get(f.latest.number)!.get(`${item.market.token}:${trader}`));expect(BigInt(item.lastBalanceBlockNumber)).toBeLessThanOrEqual(f.latest.number);expect(BigInt(item.price.nativeRawPerWholeToken.denominator)).toBe(BigInt(item.price.sqrtPriceX96Raw)**2n);}
    const empty=await body(await f.readWallet(a(999)));expect(empty).toMatchObject({context:{available:true},holdingCount:'0',items:[],nextCursor:null});expect(JSON.stringify(response)).not.toMatch(/cash|pnl|usd|private/i);
    const manager=await body(await f.readWallet(f.manifest.poolManager.address));expect(manager.holdingCount).toBe('2');expect(manager.items).toHaveLength(2);expect(f.walletSource.verifyWalletBalances).toHaveBeenCalledWith(f.manifest,expect.any(Array),f.manifest.poolManager.address,f.latest);
  }));
  it('paginates a three-market wallet with deployment/checkpoint/wallet/limit bindings and at most five proofs per page',async()=>withFixture(async f=>{
    await f.replay();const wallet=f.manifest.poolManager.address,first=await body(await f.readWallet(wallet,'?limit=2'));expect(first.items).toHaveLength(2);expect(first.holdingCount).toBe('3');expect(first.nextCursor).toBeTypeOf('string');
    const second=await body(await f.readWallet(wallet,`?limit=2&cursor=${first.nextCursor}`));expect(second.items).toHaveLength(1);expect(second.nextCursor).toBeNull();expect(new Set([...first.items,...second.items].map(row=>row.market.token)).size).toBe(3);
    expect((await f.readWallet(wallet,`?limit=3&cursor=${first.nextCursor}`)).status).toBe(400);expect((await f.readWallet(a(999),`?limit=2&cursor=${first.nextCursor}`)).status).toBe(400);
    const cursor=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString());cursor.hash=h(999);expect((await f.readWallet(wallet,`?limit=2&cursor=${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`)).status).toBe(409);
    for(const call of f.walletSource.verifyWalletBalances.mock.calls)expect(call[1].length).toBeLessThanOrEqual(5);
  },true));
  it('fails wallet ledger loss, on-chain balance mismatch and pre-coverage journals without presenting empty holdings',async()=>withFixture(async f=>{
    await f.replay();const wallet=f.manifest.poolManager.address;f.state.wrongBalance=true;const mismatch=await f.readWallet(wallet);expect(mismatch.status).toBe(503);expect(await mismatch.json()).not.toHaveProperty('items');f.state.wrongBalance=false;
    await f.pool.query('UPDATE oneshot_evm_token_event_journal SET producer_version=1 WHERE manifest_id=$1 AND block_number=$2::numeric',[f.id,f.latest.number.toString()]);expect((await f.readWallet(a(999))).status).toBe(503);expect((await f.read()).status).toBe(200);
    await f.pool.query('UPDATE oneshot_evm_token_event_journal SET producer_version=2 WHERE manifest_id=$1',[f.id]);
    await f.pool.query("DELETE FROM oneshot_evm_token_event_projections WHERE manifest_id=$1 AND kind='balances' AND value->>'wallet'=$2",[f.id,wallet]);const missing=await f.readWallet(wallet);expect(missing.status).toBe(503);expect(await missing.json()).not.toHaveProperty('items');
  }));
  it('holds wallet proofs at one read snapshot during rollback, then rejects orphaned checkpoints and sanitized provider errors',async()=>withFixture(async f=>{
    await f.replay();let reached!:()=>void,resume!:()=>void;const paused=new Promise<void>(resolve=>{reached=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
    const observed:SqlPool={async connect(){const client=await f.pool.connect();return{release:()=>client.release(),async query(sql,values){const result=await client.query(sql,values);if(sql.startsWith('SELECT block_number')&&sql.includes('ORDER BY')){reached();await gate;}return result;}};}};
    const wallet=f.manifest.poolManager.address,pending=f.readWallet(wallet,'',observed);await Promise.race([paused,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Wallet checkpoint barrier timeout')),5000).unref())]);try{await f.store.rollbackHead(f.latest);}finally{resume();}
    expect((await body(await pending)).context.checkpoint.hash).toBe(f.latest.hash);
    const last=parseEvidenceBlock(f.evidence.blocks.at(-1));await f.store.applyBlock(last.block,last.logs,evidenceRegistrations(f.manifest,last.block,last.logs,f.evidence.registrations));f.state.reorg=true;expect((await f.readWallet(wallet)).status).toBe(409);f.state.reorg=false;f.state.privateError=true;const failed=await f.readWallet(wallet);expect(failed.status).toBe(503);expect(JSON.stringify(await failed.json())).not.toMatch(/secret-provider|items/);
  }));
});
