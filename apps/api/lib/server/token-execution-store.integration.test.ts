import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createTokenExecutionRepository, type StoredTokenExecutionReview } from './token-execution-store';

const testUrl=process.env.ONESHOT_API_TEST_DATABASE_URL;
async function withDatabase(run:(pool:Pool,owner:string,make:()=>StoredTokenExecutionReview)=>Promise<void>){
  if(!testUrl)throw new Error('An explicit local test database is required.');const url=new URL(testUrl);
  if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!url.pathname.endsWith('_test'))throw new Error('Use a dedicated local test database.');
  const pool=new Pool({connectionString:testUrl,max:5,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,statement_timeout:10000});
  const owner=`token-review-${randomUUID()}`,ids:string[]=[];
  const make=():StoredTokenExecutionReview=>{const id=randomUUID();ids.push(id);const createdAt=Date.now();return{owner,session:'session',createdAt,intent:{action:'buy'},review:{id,reviewHash:'a'.repeat(64),expiresAt:new Date(createdAt+60000).toISOString(),
    action:'buy',chainId:84532,deploymentId:'b'.repeat(64),network:{mode:'base-sepolia',chainId:84532,name:'Base Sepolia',nativeSymbol:'ETH',nativeDecimals:18},
    from:`0x${'11'.repeat(20)}`,to:`0x${'22'.repeat(20)}`,value:'123456789012345678901234567890',data:'0x12345678',summary:{minimumReceiveRaw:'9999999999999999999999999'},simulation:{blockNumber:'123',blockHash:`0x${'33'.repeat(32)}`,gasEstimate:'120000'}}};};
  try{await pool.query(await readFile(new URL('../../../../db/schema.sql',import.meta.url),'utf8'));await run(pool,owner,make);}
  finally{try{await pool.query("DELETE FROM b20_app_records WHERE namespace='oneshot_token_reviews' AND id=ANY($1::text[]) AND value->>'owner'=$2",[ids,owner]);}finally{await pool.end();}}
}
describe.skipIf(!testUrl)('PostgreSQL token review tracking',()=>{
  it('preserves exact raw amounts and ownership after reopening the repository',async()=>withDatabase(async(pool,owner,make)=>{
    const original=make(),repo=createTokenExecutionRepository({database:()=>pool});await repo.create(original,original.createdAt);
    const reopened=new Pool({connectionString:testUrl,max:1,connectionTimeoutMillis:5000,idleTimeoutMillis:1000});try{
      const second=createTokenExecutionRepository({database:()=>reopened});expect(await second.get(original.review.id,owner,Date.now())).toEqual(original);
      await expect(second.get(original.review.id,'another-owner',Date.now())).rejects.toMatchObject({status:404});
    }finally{await reopened.end();}
  }));
  it('accepts only one hash under simultaneous updates and can reconcile a reorg',async()=>withDatabase(async(pool,owner,make)=>{
    const original=make(),repo=createTokenExecutionRepository({database:()=>pool});await repo.create(original,original.createdAt);
    const results=await Promise.allSettled(Array.from({length:8},(_,index)=>createTokenExecutionRepository({database:()=>pool}).update(original.review.id,owner,`0x${index%2?'aa'.repeat(32):'bb'.repeat(32)}`,'submitted',Date.now())));
    const accepted=results.filter(result=>result.status==='fulfilled').map(result=>result.value.transactionHash);expect(new Set(accepted).size).toBe(1);expect(results.some(result=>result.status==='rejected')).toBe(true);
    const bound=(await repo.get(original.review.id,owner,Date.now())).transactionHash!;
    await repo.update(original.review.id,owner,bound,'confirmed',Date.now());await repo.update(original.review.id,owner,bound,'submitted',Date.now());
    expect((await repo.get(original.review.id,owner,Date.now())).outcome).toBe('submitted');
  }));
  it('enforces account capacity across parallel database clients',async()=>withDatabase(async(pool,owner,make)=>{
    const repo=createTokenExecutionRepository({database:()=>pool,activeLimit:2}),candidates=Array.from({length:6},make);
    const results=await Promise.allSettled(candidates.map(item=>repo.create(item,Date.now())));expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(2);
    const first=candidates.find((_,index)=>results[index].status==='fulfilled')!;
    await repo.update(first.review.id,owner,`0x${'aa'.repeat(32)}`,'submitted',Date.now());await expect(repo.create(make(),Date.now())).resolves.toBeUndefined();
  }));
});
