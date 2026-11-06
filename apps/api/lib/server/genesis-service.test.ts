import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createGenesisService } from './genesis-service';
import { memoryGenesisStore, type GenesisStore } from './genesis-store';
import { GenesisProviderUnavailable, type GenesisVerifier } from './genesis-verification';
import type { OneshotSession } from './oneshot-auth';
import { GENESIS_CONSENT_VERSION, genesisCampaignSchema, type GenesisApplication, type GenesisCheck } from '../../../web/lib/genesis-schema';

export const genesisTestNow = Date.parse('2030-01-02T12:00:00Z');
export function genesisTestSession(index = 1): OneshotSession { return { provider:'privy',userId:`did:privy:genesis-${index}`,sessionId:`session-${index}`,expiresAt:Math.floor(genesisTestNow/1000)+3600,linkedAddresses:[],xAccount:{id:String(index),username:`person_${index}`,name:`Person ${index}`,avatarUrl:null} }; }
export function genesisTestApplication(index:number,selected=false):GenesisApplication {
  const session=genesisTestSession(index); const verified:GenesisCheck={state:'verified',message:'Verified',checkedAt:new Date(genesisTestNow).toISOString()};
  return {id:randomUUID(),userId:session.userId,profile:session.xAccount!,code:String(index).padStart(16,'0'),referrerId:null,createdAt:new Date(genesisTestNow).toISOString(),submittedAt:new Date(genesisTestNow).toISOString(),revision:1,ruleVersion:1,status:'under_review',checks:{follow:verified,post:verified,share:verified},decision:selected?'selected':null,publishedDecision:selected?'selected':null,note:'private review',shareConsent:false,consentVersion:GENESIS_CONSENT_VERSION};
}
export async function genesisTestFixture(store:GenesisStore=memoryGenesisStore()) {
  let time=genesisTestNow;
  await store.transaction(tx=>tx.saveCampaign(genesisCampaignSchema.parse({state:'open',opensAt:'2030-01-01T00:00:00Z',closesAt:'2030-01-03T00:00:00Z',projectXId:'999',projectHandle:'oneshot',rulesAccepted:true,nominationsOpen:true})));
  const verify=vi.fn<GenesisVerifier['verify']>(async(task,_profile,_campaign,postId)=>({state:'verified',message:'Verified',checkedAt:new Date(time).toISOString(),...(postId?{postId}:{})}));
  const verifier:GenesisVerifier={verify,project:vi.fn(async()=> 'oneshot'),lookup:vi.fn(async username=>({id:username.replace('person_',''),username}))};
  const service=createGenesisService({store,verifier,now:()=>time,webOrigin:()=> 'https://oneshot.example'});
  return {store,service,verify,verifier,setTime:(now:number)=>{time=now;}};
}
describe('Genesis account applications and allocation safety',()=>{
  it('enrolls without a wallet, persists by X identity and never exposes private review fields',async()=>{
    const {service,verify}=await genesisTestFixture();const session=genesisTestSession();
    const joined=await service.enroll(session,GENESIS_CONSENT_VERSION);
    expect(joined.application?.profile.id).toBe('1');expect(joined.referralUrl).toContain('/whitelist?ref=');
    expect(JSON.stringify(joined)).not.toMatch(/userId|referrerId|private review|consentVersion|"decision"/);
    expect(await service.enroll(session,GENESIS_CONSENT_VERSION)).toEqual(joined);
    await service.me(session);await service.campaign();expect(verify).not.toHaveBeenCalled();
    await expect(service.enroll({...genesisTestSession(2),xAccount:session.xAccount},GENESIS_CONSENT_VERSION)).rejects.toMatchObject({code:'GENESIS_IDENTITY_USED'});
    await expect(service.me({...session,xAccount:genesisTestSession(2).xAccount})).rejects.toMatchObject({code:'GENESIS_X_CHANGED'});
  });
  it('qualifies a referral once only after the invited application is submitted and verified',async()=>{
    const {service}=await genesisTestFixture();const first=genesisTestSession(1),second=genesisTestSession(2);
    const original=await service.enroll(first,GENESIS_CONSENT_VERSION);
    await service.enroll(second,GENESIS_CONSENT_VERSION,original.application!.code);
    expect((await service.me(first)).qualifiedReferrals).toBe(0);
    for(const task of ['follow','post','share'] as const)await service.verify(second,task,task==='follow'?undefined:'https://x.com/person_2/status/123');
    const ready=await service.me(second);await service.submit(second,ready.application!.revision);await service.submit(second,ready.application!.revision);
    expect((await service.me(first)).qualifiedReferrals).toBe(1);
    await service.enroll(second,GENESIS_CONSENT_VERSION,original.application!.code);expect((await service.me(first)).qualifiedReferrals).toBe(1);
  });
  it('preserves an on-time submission across a provider outage and recovers after closing',async()=>{
    const {service,verify,setTime}=await genesisTestFixture();const session=genesisTestSession();await service.enroll(session,GENESIS_CONSENT_VERSION);
    verify.mockRejectedValue(new GenesisProviderUnavailable());
    for(const task of ['follow','post','share'] as const)await service.verify(session,task,task==='follow'?undefined:'https://x.com/person_1/status/123');
    const waiting=await service.me(session);expect(waiting.application?.checks.post?.state).toBe('temporarily_unavailable');
    await service.submit(session,waiting.application!.revision);const submitted=(await service.me(session)).application!.submittedAt;
    setTime(Date.parse('2030-01-04T00:00:00Z'));verify.mockImplementation(async(_task,_profile,_campaign,postId)=>({state:'verified',message:'Verified',checkedAt:'2030-01-04T00:00:00Z',...(postId?{postId}:{})}));
    await service.runJobs();const recovered=await service.me(session);expect(recovered.application?.status).toBe('under_review');expect(recovered.application?.submittedAt).toBe(submitted);
    await expect(service.enroll(genesisTestSession(2),GENESIS_CONSENT_VERSION)).rejects.toMatchObject({code:'GENESIS_CLOSED'});
  });
  it('requires tasks, prevents stale updates, and keeps decisions private until published',async()=>{
    const {service}=await genesisTestFixture();const session=genesisTestSession();const joined=await service.enroll(session,GENESIS_CONSENT_VERSION);
    await expect(service.submit(session,joined.application!.revision)).rejects.toMatchObject({code:'GENESIS_TASKS_INCOMPLETE'});
    for(const task of ['follow','post','share'] as const)await service.verify(session,task,task==='follow'?undefined:'https://x.com/person_1/status/123');
    await expect(service.submit(session,joined.application!.revision)).rejects.toMatchObject({code:'GENESIS_REVISION'});
    await service.submit(session,(await service.me(session)).application!.revision);
    let app=(await service.me(session)).application!;
    await service.review(app.id,{expectedRevision:app.revision,decision:'selected',note:'Private',publish:false},'admin');
    app=(await service.me(session)).application!;expect(app.publishedDecision).toBeNull();
    await service.review(app.id,{expectedRevision:app.revision,decision:'selected',note:'Private',publish:true},'admin');
    app=(await service.me(session)).application!;expect(app.publishedDecision).toBe('selected');
    await expect(service.review(app.id,{expectedRevision:app.revision,decision:'not_selected',note:'',publish:true},'admin')).rejects.toMatchObject({code:'GENESIS_DECISION_PUBLISHED'});
  });
  it('serializes competing final-place selections at exactly 750 recipients',async()=>{
    const {service,store}=await genesisTestFixture();const candidates=[genesisTestApplication(800),genesisTestApplication(801),genesisTestApplication(802)];
    await store.transaction(async tx=>{for(let i=1;i<=749;i++)await tx.saveApplication(genesisTestApplication(i,true));for(const app of candidates)await tx.saveApplication(app);});
    const results=await Promise.allSettled(candidates.map(app=>service.review(app.id,{expectedRevision:1,decision:'selected',note:'',publish:true},'admin')));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await store.transaction(tx=>tx.count('selected'))).toBe(750);
  });
  it('reserves nomination capacity before granting quotas and accepts only the matching verified applicant',async()=>{
    const {service,store}=await genesisTestFixture();const nominator=genesisTestApplication(800),nominee=genesisTestApplication(801),third=genesisTestApplication(802);
    await store.transaction(async tx=>{for(let i=1;i<=748;i++)await tx.saveApplication(genesisTestApplication(i,true));for(const app of [nominator,nominee,third])await tx.saveApplication(app);});
    await service.review(nominator.id,{expectedRevision:1,decision:'selected',note:'',publish:true,nominationQuota:1},'admin');
    await expect(service.review(third.id,{expectedRevision:1,decision:'selected',note:'',publish:true},'admin')).rejects.toMatchObject({code:'GENESIS_CAPACITY'});
    await expect(service.nominate(genesisTestSession(800),'person_800')).rejects.toMatchObject({code:'GENESIS_SELF_NOMINATION'});
    await service.nominate(genesisTestSession(800),'person_801');const incoming=(await service.me(genesisTestSession(801))).nomination!;
    await expect(service.acceptNomination(genesisTestSession(802),incoming.id)).rejects.toMatchObject({code:'GENESIS_NOMINATION_UNAVAILABLE'});
    await service.acceptNomination(genesisTestSession(801),incoming.id);await service.acceptNomination(genesisTestSession(801),incoming.id);
    expect(await store.transaction(tx=>tx.count('selected'))).toBe(750);expect(await store.transaction(tx=>tx.count('reserved'))).toBe(0);
    await expect(service.nominate(genesisTestSession(800),'person_802')).rejects.toMatchObject({code:'GENESIS_NOMINATION_UNAVAILABLE'});
  });
  it('publishes personal card fields only after submission and explicit opt-in; revocation returns a generic card',async()=>{
    const {service,store}=await genesisTestFixture();const app=genesisTestApplication(1);await store.transaction(tx=>tx.saveApplication(app));
    expect(await service.shareProfile(app.code)).toBeNull();await service.share(genesisTestSession(),true,1);
    expect(await service.shareProfile(app.code)).toEqual({profile:app.profile,status:'Applied for Genesis'});
    await service.share(genesisTestSession(),false,2);expect(await service.shareProfile(app.code)).toBeNull();
  });
});
