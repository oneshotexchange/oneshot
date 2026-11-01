import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { NftReview, NftReviewInput } from './nft-launch';
import { createNftLaunchRepository, NFT_PUBLICATION_NAMESPACE, NFT_REVIEW_NAMESPACE, type StoredNftReview, type NftPublication } from './nft-launch-store';

// An ambient production DATABASE_URL can never opt this suite in.
const testUrl = process.env.ONESHOT_API_TEST_DATABASE_URL;
const wallet = '0x1111111111111111111111111111111111111111';
const hash = `0x${'ab'.repeat(32)}` as const;
const otherHash = `0x${'cd'.repeat(32)}` as const;
type Fixture = {pool:Pool;owner:string;otherOwner:string;now:number;make:(owner?:string,createdAt?:number)=>StoredNftReview;publication:()=>{key:string;record:NftPublication}};
async function withDatabase(run: (fixture:Fixture)=>Promise<void>) {
  if (!testUrl) throw new Error('ONESHOT_API_TEST_DATABASE_URL is required.');
  const url = new URL(testUrl);
  if (!['postgres:','postgresql:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test')) throw new Error('Use an explicit dedicated local PostgreSQL test database.');
  const pool = new Pool({connectionString:testUrl,max:5,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,statement_timeout:10000,application_name:'oneshot-nft-review-integration'});
  const owner = `did:privy:review-test-${randomUUID()}`, otherOwner = `did:privy:review-test-${randomUUID()}`, now = Date.now();
  const reviewIds:string[] = [], publicationKeys:string[] = [];
  try {
    await pool.query(await readFile(new URL('../../../../db/schema.sql',import.meta.url),'utf8'));
    await run({pool,owner,otherOwner,now,make:(selectedOwner=owner,createdAt=now)=>{
      const id = randomUUID(); reviewIds.push(id);
      const input = {draftId:randomUUID(),expectedRevision:2,from:wallet,action:'mint',collection:wallet,quantity:'1',localEthAcknowledged:true} as NftReviewInput;
      const review = {id,reviewHash:hash,scope:'draft',expiresAt:new Date(createdAt+120000).toISOString(),chainId:31337,from:wallet,to:wallet,data:'0x1234',value:'99999999999999999999999999',action:'mint',network:{mode:'local',chainId:31337,name:'Local Anvil',nativeSymbol:'ETH',nativeDecimals:18},summary:{quantity:'1'},deploymentId:'a'.repeat(64),draftId:input.draftId,revision:2,simulation:{blockNumber:'10',blockHash:hash,gasEstimate:'100000'}} as NftReview;
      return {review,input,owner:selectedOwner,session:randomUUID(),createdAt};
    },publication:()=>{
      const deploymentId = randomUUID().replaceAll('-','').padEnd(64,'0'), key=`${deploymentId}:${wallet}`; publicationKeys.push(key);
      return {key,record:{deploymentId,collection:wallet,termsHash:hash,openHash:hash,blockHash:hash,blockNumber:'10',creatorUserId:owner,draft:{status:'prepared',name:'Postgres exact launch',symbol:'PG',creatorWallet:wallet,maxSupply:2,royaltyBps:500,publicPrice:'0.000000000000000001',allowlistPrice:'0',perWalletLimit:2,publicStart:'2030-01-01T00:00:00Z',publicEnd:'2030-01-02T00:00:00Z',allowlistAddresses:[wallet],snapshot:{manifestHash:'a'.repeat(64),contentHash:`0x${'a'.repeat(64)}`,baseUri:'https://api.oneshot.app/metadata/',collectionUri:'https://api.oneshot.app/collection.json',itemCount:2}}}};
    }});
  } finally {
    try {
      if (reviewIds.length) await pool.query('DELETE FROM b20_app_records WHERE namespace=$1 AND id=ANY($2::text[]) AND value->>\'owner\'=ANY($3::text[])',[NFT_REVIEW_NAMESPACE,reviewIds,[owner,otherOwner]]);
      if (publicationKeys.length) await pool.query('DELETE FROM b20_app_records WHERE namespace=$1 AND id=ANY($2::text[]) AND value->>\'creatorUserId\'=$3',[NFT_PUBLICATION_NAMESPACE,publicationKeys,owner]);
    } finally { await pool.end(); }
  }
}

describe.skipIf(!testUrl)('real PostgreSQL durable NFT review storage',()=>{
  it('preserves exact review/hash state across repository and pool restarts',async()=>{
    await withDatabase(async({pool,owner,now,make})=>{
      const original = make(), first = createNftLaunchRepository({database:()=>pool}); await first.create(original,now);
      await first.bindHash(original.review.id,owner,hash,now+1); await first.setOutcome(original.review.id,hash,'confirmed',now+2);
      const reopenedPool = new Pool({connectionString:testUrl,max:1,connectionTimeoutMillis:5000,idleTimeoutMillis:1000});
      try {
        const reopened = createNftLaunchRepository({database:()=>reopenedPool});
        expect(await reopened.get(original.review.id,now+3)).toMatchObject({...original,transactionHash:hash,outcome:'confirmed'});
        expect((await reopened.list(owner,{limit:10},now+3)).items[0].review.value).toBe('99999999999999999999999999');
        await reopened.setOutcome(original.review.id,hash,'submitted',now+4);
        expect((await first.get(original.review.id,now+5))!.outcome).toBe('submitted');
      } finally { await reopenedPool.end(); }
    });
  });
  it('binds the first submitted hash atomically across concurrent database clients',async()=>{
    await withDatabase(async({pool,owner,otherOwner,now,make})=>{
      const original = make(), repo = createNftLaunchRepository({database:()=>pool}); await repo.create(original,now);
      await expect(repo.bindHash(original.review.id,otherOwner,hash,now+1)).rejects.toMatchObject({code:'REVIEW_NOT_FOUND'});
      const results = await Promise.allSettled(Array.from({length:10},(_,index)=>createNftLaunchRepository({database:()=>pool}).bindHash(original.review.id,owner,index%2?hash:otherHash,now+2)));
      const accepted = results.filter(result=>result.status==='fulfilled').map(result=>(result as PromiseFulfilledResult<StoredNftReview>).value.transactionHash);
      expect(new Set(accepted).size).toBe(1); expect(results.some(result=>result.status==='rejected')).toBe(true);
      expect((await repo.get(original.review.id,now+3))!.transactionHash).toBe(accepted[0]);
    });
  });
  it('enforces the active account quota atomically and releases submitted capacity',async()=>{
    await withDatabase(async({pool,owner,now,make})=>{
      const candidates = Array.from({length:5},()=>make()), repo=createNftLaunchRepository({database:()=>pool,activeLimit:2});
      const results = await Promise.allSettled(candidates.map(item=>repo.create(item,now)));
      expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(2);
      for (const failure of results.filter(result=>result.status==='rejected')) expect((failure as PromiseRejectedResult).reason).toMatchObject({code:'REVIEW_LIMIT'});
      const page=await repo.list(owner,{limit:10},now); await repo.bindHash(page.items[0].review.id,owner,hash,now+1);
      await repo.create(make(),now+1); expect((await repo.list(owner,{limit:10},now+2)).items).toHaveLength(3);
    });
  });
  it('filters ownership before stable transaction history pagination',async()=>{
    await withDatabase(async({pool,owner,otherOwner,now,make})=>{
      const repo=createNftLaunchRepository({database:()=>pool}), originals=[make(),make(),make()];
      for (const item of originals) await repo.create(item,now);
      for (let index=0;index<8;index++) await repo.create(make(otherOwner,now+index+1),now+index+1);
      const first=await repo.list(owner,{limit:2},now+10),second=await repo.list(owner,{limit:2,cursor:first.nextCursor},now+10);
      expect([...first.items,...second.items].map(item=>item.review.id)).toEqual(originals.map(item=>item.review.id).sort().reverse());
      expect(second.nextCursor).toBeUndefined();
      await expect(repo.list(otherOwner,{limit:2,cursor:first.nextCursor},now+10)).rejects.toMatchObject({code:'TRANSACTION_INPUT_INVALID'});
    });
  });
  it('does not recover reviews outside the thirty-day retention period',async()=>{
    await withDatabase(async({pool,owner,now,make})=>{
      const original=make(owner,now-31*86400000), repo=createNftLaunchRepository({database:()=>pool});
      await pool.query('INSERT INTO b20_app_records(namespace,id,value) VALUES($1,$2,$3::jsonb)',[NFT_REVIEW_NAMESPACE,original.review.id,JSON.stringify(original)]);
      expect(await repo.get(original.review.id,now)).toBeNull(); expect((await repo.list(owner,{limit:10},now)).items).toEqual([]);
      await expect(repo.bindHash(original.review.id,owner,hash,now)).rejects.toMatchObject({code:'REVIEW_NOT_FOUND'});
    });
  });
  it('persists private proof material and compare-and-sets reconciled publication provenance',async()=>{
    await withDatabase(async({pool,publication})=>{
      const original=publication(), repo=createNftLaunchRepository({database:()=>pool}); await repo.publish(original.key,original.record);
      expect(await createNftLaunchRepository({database:()=>pool}).publication(original.key)).toEqual(original.record);
      const replacement={...original.record,termsHash:otherHash,openHash:otherHash,blockHash:otherHash};
      await expect(repo.publish(original.key,replacement)).rejects.toMatchObject({code:'PUBLICATION_CHANGED'});
      await repo.publish(original.key,replacement,original.record);
      expect(await repo.publication(original.key)).toEqual(replacement);
      await expect(repo.publish(original.key,original.record,original.record)).rejects.toMatchObject({code:'PUBLICATION_CHANGED'});
    });
  });
});
