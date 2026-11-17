import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTokenExecutionRepository, type StoredTokenExecutionReview } from './token-execution-store';

let directory:string;
const now=Date.parse('2026-11-16T10:00:00Z');
function item(owner='account-a'):StoredTokenExecutionReview{return{
  owner,session:'session-a',createdAt:now,intent:{action:'buy',amount:'1'},review:{
    id:randomUUID(),reviewHash:'a'.repeat(64),expiresAt:new Date(now+60000).toISOString(),action:'buy',chainId:84532,deploymentId:'b'.repeat(64),
    network:{mode:'base-sepolia',chainId:84532,name:'Base Sepolia',nativeSymbol:'ETH',nativeDecimals:18},
    from:`0x${'11'.repeat(20)}`,to:`0x${'22'.repeat(20)}`,value:'1000000000000000000',data:'0x12345678',summary:{amount:'1 test ETH'},
    simulation:{blockNumber:'123',blockHash:`0x${'33'.repeat(32)}`,gasEstimate:'120000'},
  },
};}
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'oneshot-token-review-'));vi.stubEnv('ONESHOT_DATA_DIR',directory);vi.stubEnv('NODE_ENV','test');});
afterEach(async()=>{vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});});

describe('durable token review ownership and transaction binding',()=>{
  it('isolates accounts and returns a snapshot the caller cannot mutate',async()=>{
    const repo=createTokenExecutionRepository({database:()=>null}),saved=item();await repo.create(saved,now);
    await expect(repo.get(saved.review.id,'account-b',now)).rejects.toMatchObject({status:404});
    const read=await repo.get(saved.review.id,saved.owner,now);read.review.to=`0x${'44'.repeat(20)}`;
    expect((await repo.get(saved.review.id,saved.owner,now)).review.to).toBe(saved.review.to);
  });
  it('binds one transaction atomically under concurrent receipt requests',async()=>{
    const repo=createTokenExecutionRepository({database:()=>null}),saved=item();await repo.create(saved,now);
    const a=`0x${'aa'.repeat(32)}`,b=`0x${'bb'.repeat(32)}`;
    const results=await Promise.allSettled([repo.update(saved.review.id,saved.owner,a,'submitted',now+1),repo.update(saved.review.id,saved.owner,b,'submitted',now+1)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
    const bound=(await repo.get(saved.review.id,saved.owner,now+2)).transactionHash!;
    await expect(repo.update(saved.review.id,saved.owner,bound,'confirmed',now+3)).resolves.toMatchObject({outcome:'confirmed'});
    // A receipt can become noncanonical; fresh observation may return it to submitted.
    await expect(repo.update(saved.review.id,saved.owner,bound,'submitted',now+4)).resolves.toMatchObject({outcome:'submitted'});
  });
  it('cannot bind a hash from another account',async()=>{
    const repo=createTokenExecutionRepository({database:()=>null}),saved=item();await repo.create(saved,now);
    await expect(repo.update(saved.review.id,'account-b',`0x${'aa'.repeat(32)}`,'submitted',now)).rejects.toMatchObject({status:404});
    expect((await repo.get(saved.review.id,saved.owner,now)).transactionHash).toBeUndefined();
  });
  it('enforces active capacity atomically and does not count another account',async()=>{
    const repo=createTokenExecutionRepository({database:()=>null,activeLimit:1});
    const results=await Promise.allSettled([repo.create(item(),now),repo.create(item(),now)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    await expect(repo.create(item('account-b'),now)).resolves.toBeUndefined();
    const next=item();next.createdAt=now+60000;next.review.expiresAt=new Date(now+120000).toISOString();
    await expect(repo.create(next,now+60000)).resolves.toBeUndefined();
  });
  it('retains submitted reviews after signing expires and removes old records from capacity',async()=>{
    const repo=createTokenExecutionRepository({database:()=>null,retainedLimit:1}),saved=item();await repo.create(saved,now);
    await expect(repo.get(saved.review.id,saved.owner,now+60001)).resolves.toMatchObject({owner:saved.owner});
    await expect(repo.get(saved.review.id,saved.owner,now+30*86400000)).rejects.toMatchObject({status:404});
    const next=item();next.createdAt=now+30*86400000;next.review.expiresAt=new Date(next.createdAt+60000).toISOString();
    await expect(repo.create(next,next.createdAt)).resolves.toBeUndefined();
  });
  it('rejects forged network labels, excessive lifetime, existing hash and oversized records',async()=>{
    const repo=createTokenExecutionRepository({database:()=>null});
    for(const change of [
      (value:StoredTokenExecutionReview)=>{value.review.network={...value.review.network,name:'Mainnet'} as never;},
      (value:StoredTokenExecutionReview)=>{value.review.expiresAt=new Date(now+120001).toISOString();},
      (value:StoredTokenExecutionReview)=>{value.transactionHash=`0x${'aa'.repeat(32)}`;value.outcome='submitted';},
      (value:StoredTokenExecutionReview)=>{value.intent={data:'x'.repeat(32768)};},
    ]){const saved=item();change(saved);await expect(repo.create(saved,now)).rejects.toBeDefined();}
  });
});
