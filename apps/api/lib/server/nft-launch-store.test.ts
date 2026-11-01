import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NftReview, NftReviewInput } from './nft-launch';
import { createNftLaunchRepository, NFT_REVIEW_NAMESPACE, type NftPublication, type StoredNftReview } from './nft-launch-store';
import { putRecord } from './store';

const root = path.resolve('.local/nft-launch-store-tests');
let directory: string;
const now = 1_800_000_000_000;
const wallet = '0x1111111111111111111111111111111111111111';
const otherWallet = '0x2222222222222222222222222222222222222222';
const hash = `0x${'ab'.repeat(32)}` as const;
const otherHash = `0x${'cd'.repeat(32)}` as const;
function review(owner = 'did:privy:alice', createdAt = now, from = wallet): StoredNftReview {
  const input = {draftId:randomUUID(),expectedRevision:2,from,action:'mint',collection:otherWallet,quantity:'1',localEthAcknowledged:true} as NftReviewInput;
  const data = {id:randomUUID(),reviewHash:hash,expiresAt:new Date(createdAt+120_000).toISOString(),scope:'draft',chainId:31337,from,to:otherWallet,data:'0x1234',value:'123456789012345678901234567890',action:'mint',network:{mode:'local',chainId:31337,name:'Local Anvil',nativeSymbol:'ETH',nativeDecimals:18},summary:{quantity:'1'},deploymentId:'a'.repeat(64),draftId:input.draftId,revision:2,simulation:{blockNumber:'100',blockHash:hash,gasEstimate:'123456'}} as NftReview;
  return {review:data,input,owner,session:`session:${owner}`,createdAt};
}
function publication(): {key:string;record:NftPublication} {
  const deploymentId = 'a'.repeat(64);
  const record: NftPublication = {deploymentId,collection:wallet,termsHash:hash,openHash:hash,blockNumber:'100',blockHash:hash,creatorUserId:'did:privy:alice',draft:{status:'prepared',name:'Exact local collection',symbol:'SHOT',maxSupply:2,royaltyBps:500,publicPrice:'0.123456789012345678',allowlistPrice:'0',perWalletLimit:2,publicStart:'2030-01-01T00:00:00Z',publicEnd:'2030-01-02T00:00:00Z',allowlistAddresses:[otherWallet],creatorWallet:wallet,snapshot:{manifestHash:'a'.repeat(64),contentHash:`0x${'a'.repeat(64)}`,baseUri:'https://api.oneshot.app/api/oneshot/metadata/hash/',collectionUri:'https://api.oneshot.app/api/media/hash.json',itemCount:2}}};
  return {key:`${deploymentId}:${wallet}`,record};
}
beforeEach(async()=>{
  await mkdir(root,{recursive:true}); directory = await mkdtemp(path.join(root,'case-'));
  vi.stubEnv('NODE_ENV','test'); vi.stubEnv('DATABASE_URL',''); vi.stubEnv('ONESHOT_DATA_DIR',directory);
});
afterEach(async()=>{
  vi.unstubAllEnvs();
  const target = path.resolve(directory); if (!target.startsWith(root+path.sep)) throw new Error('Unsafe local NFT repository cleanup.');
  await rm(target,{recursive:true,force:true});
});

describe('durable NFT reviews and launch publication',()=>{
  it('persists exact transaction data across repository instances and isolates returned objects',async()=>{
    const original = review(); const first = createNftLaunchRepository(); await first.create(original,now);
    const recovered = await createNftLaunchRepository().get(original.review.id,now);
    expect(recovered).toMatchObject(original); expect(recovered!.review.value).toBe('123456789012345678901234567890');
    original.review.data = '0xdead'; recovered!.review.data = '0xbeef';
    expect((await createNftLaunchRepository().get(original.review.id,now))!.review.data).toBe('0x1234');
    const persisted = JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));
    expect(persisted[NFT_REVIEW_NAMESPACE][original.review.id].review.value).toBe('123456789012345678901234567890');
  });
  it('binds exactly one hash under concurrent repository instances and hides other owners',async()=>{
    const original = review(); const repo = createNftLaunchRepository(); await repo.create(original,now);
    await expect(repo.bindHash(original.review.id,'did:privy:bob',hash,now)).rejects.toMatchObject({code:'REVIEW_NOT_FOUND'});
    const attempts = await Promise.allSettled(Array.from({length:12},(_,index)=>createNftLaunchRepository().bindHash(original.review.id,original.owner,index%2?hash:otherHash,now+1)));
    const successful = attempts.filter(item=>item.status==='fulfilled').map(item=>(item as PromiseFulfilledResult<StoredNftReview>).value.transactionHash);
    expect(new Set(successful).size).toBe(1); expect(attempts.some(item=>item.status==='rejected')).toBe(true);
    for (const failure of attempts.filter(item=>item.status==='rejected')) expect((failure as PromiseRejectedResult).reason).toMatchObject({code:'TRANSACTION_CHANGED'});
    expect((await repo.get(original.review.id,now))!.transactionHash).toBe(successful[0]);
  });
  it('retains an idempotent hash, confirmed state and reorg recovery across restarts',async()=>{
    const original = review(); const repo = createNftLaunchRepository(); await repo.create(original,now);
    await repo.bindHash(original.review.id,original.owner,hash,now+1); await repo.setOutcome(original.review.id,hash,'confirmed',now+2);
    const fresh = createNftLaunchRepository(); expect((await fresh.bindHash(original.review.id,original.owner,hash,now+3)).outcome).toBe('confirmed');
    await fresh.setOutcome(original.review.id,hash,'submitted',now+4);
    expect(await repo.get(original.review.id,now+5)).toMatchObject({transactionHash:hash,outcome:'submitted',updatedAt:new Date(now+4).toISOString()});
    await expect(repo.setOutcome(original.review.id,otherHash,'reverted',now+6)).rejects.toMatchObject({code:'TRANSACTION_CHANGED'});
  });
  it('counts active unsigned reviews atomically and releases capacity at expiry',async()=>{
    const repo = createNftLaunchRepository({activeLimit:2});
    const attempts = await Promise.allSettled(Array.from({length:3},()=>repo.create(review(),now)));
    expect(attempts.filter(item=>item.status==='fulfilled')).toHaveLength(2);
    expect((attempts.find(item=>item.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({code:'REVIEW_LIMIT'});
    await repo.create(review('did:privy:alice',now+120_001),now+120_001);
    expect((await repo.list('did:privy:alice',{limit:50},now+120_001)).items).toHaveLength(3);
  });
  it('frees the active review slot after submission while preserving late receipt recovery',async()=>{
    const repo = createNftLaunchRepository({activeLimit:1}); const original = review(); await repo.create(original,now);
    await repo.bindHash(original.review.id,original.owner,hash,now+120_001);
    await repo.create(review(original.owner,now+120_001),now+120_001);
    expect((await createNftLaunchRepository().get(original.review.id,now+86_400_000))!.transactionHash).toBe(hash);
  });
  it('bounds retained records, expires them after retention and preserves other namespaces',async()=>{
    const repo = createNftLaunchRepository({retentionMs:1000,retainedLimit:2});
    await putRecord('oneshot_drafts','untouched',{marker:'user draft'});
    const originals = [review(),review()]; for (const item of originals) await repo.create(item,now);
    await expect(repo.create(review(),now)).rejects.toMatchObject({code:'REVIEW_LIMIT'});
    expect(await repo.get(originals[0].review.id,now+1000)).toBeNull();
    await expect(repo.bindHash(originals[0].review.id,originals[0].owner,hash,now+1000)).rejects.toMatchObject({code:'REVIEW_NOT_FOUND'});
    await repo.create(review('did:privy:alice',now+1000),now+1000);
    const persisted = JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));
    expect(Object.keys(persisted[NFT_REVIEW_NAMESPACE])).toHaveLength(1); expect(persisted.oneshot_drafts.untouched.marker).toBe('user draft');
  });
  it('filters owner and wallet before stable pagination, including equal creation times',async()=>{
    const repo = createNftLaunchRepository(); const alice = [review(),review(),review(),review('did:privy:alice',now,otherWallet)];
    for (const item of alice) await repo.create(item,now);
    for (let index=0;index<12;index++) await repo.create(review('did:privy:bob',now+index+1),now+index+1);
    const first = await repo.list('did:privy:alice',{wallet:wallet.toUpperCase().replace('0X','0x'),limit:2},now+20);
    expect(first.items).toHaveLength(2); expect(first.items.every(item=>item.owner==='did:privy:alice' && item.review.from===wallet)).toBe(true);
    const second = await repo.list('did:privy:alice',{wallet,limit:2,cursor:first.nextCursor},now+20);
    const ids = [...first.items,...second.items].map(item=>item.review.id);
    expect(ids).toEqual(alice.slice(0,3).map(item=>item.review.id).sort().reverse()); expect(second.nextCursor).toBeUndefined();
    await expect(repo.list('did:privy:bob',{wallet,limit:2,cursor:first.nextCursor},now+20)).rejects.toMatchObject({code:'TRANSACTION_INPUT_INVALID'});
    await expect(repo.list('did:privy:alice',{wallet:otherWallet,limit:2,cursor:first.nextCursor},now+20)).rejects.toMatchObject({code:'TRANSACTION_INPUT_INVALID'});
  });
  it('rejects unsupported inputs and duplicate review identifiers before altering storage',async()=>{
    const repo = createNftLaunchRepository(), original = review(); await repo.create(original,now);
    await expect(repo.create(original,now)).rejects.toMatchObject({code:'REVIEW_EXISTS'});
    await expect(repo.get('../state',now)).rejects.toMatchObject({code:'TRANSACTION_INPUT_INVALID'});
    await expect(repo.bindHash(original.review.id,original.owner,'0x1234',now)).rejects.toMatchObject({code:'TRANSACTION_INPUT_INVALID'});
    await expect(repo.list(original.owner,{limit:51},now)).rejects.toMatchObject({code:'TRANSACTION_INPUT_INVALID'});
    await expect(repo.list(original.owner,{limit:1,cursor:'not-valid-json'},now)).rejects.toMatchObject({code:'TRANSACTION_INPUT_INVALID'});
    await expect(repo.create({...review(),createdAt:now+1},now)).rejects.toMatchObject({code:'TRANSACTION_INPUT_INVALID'});
  });
  it('requires a hosted database and never falls back to local production files',async()=>{
    vi.stubEnv('NODE_ENV','production'); const repo = createNftLaunchRepository();
    await expect(repo.create(review(),now)).rejects.toMatchObject({code:'DATABASE_REQUIRED'});
    await expect(repo.get(randomUUID(),now)).rejects.toMatchObject({code:'DATABASE_REQUIRED'});
  });
  it('persists a private allowlist publication and only refreshes matching immutable provenance',async()=>{
    const repo = createNftLaunchRepository(), original = publication(); await repo.publish(original.key,original.record);
    expect(await createNftLaunchRepository().publication(original.key)).toEqual(original.record);
    const refreshed = {...original.record,openHash:otherHash,blockHash:otherHash,blockNumber:'101'};
    await repo.publish(original.key,refreshed); expect(await repo.publication(original.key)).toEqual(refreshed);
    await expect(repo.publish(original.key,{...refreshed,termsHash:otherHash})).rejects.toMatchObject({code:'PUBLICATION_CHANGED'});
    await expect(repo.publish(original.key,{...refreshed,creatorUserId:'did:privy:bob'})).rejects.toMatchObject({code:'PUBLICATION_CHANGED'});
    await expect(repo.publication('wrong-key')).rejects.toMatchObject({code:'TRANSACTION_INPUT_INVALID'});
  });
  it('permits an explicitly reconciled orphan replacement with full-record compare-and-set',async()=>{
    const repo = createNftLaunchRepository(), original = publication(); await repo.publish(original.key,original.record);
    const replacement = {...original.record,termsHash:otherHash,openHash:otherHash,blockHash:otherHash,creatorUserId:'did:privy:bob',draft:{...original.record.draft,creatorWallet:otherWallet}};
    await repo.publish(original.key,replacement,original.record);
    expect(await repo.publication(original.key)).toEqual(replacement);
    await expect(repo.publish(original.key,original.record,original.record)).rejects.toMatchObject({code:'PUBLICATION_CHANGED'});
  });
});
