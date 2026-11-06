import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createGenesisStore } from './genesis-store';
import { createGenesisService } from './genesis-service';
import { createGenesisAuthStore } from './genesis-auth-store';
import { genesisCampaignSchema, GENESIS_CONSENT_VERSION, type GenesisApplication } from '../../../web/lib/genesis-schema';

// Dedicated opt-in test DB only. Each run owns a separate temporary schema.
const connectionString = process.env.ONESHOT_API_TEST_DATABASE_URL;
describe.skipIf(!connectionString)('Genesis PostgreSQL allocation and durability',()=>{
  it('persists across pools and serializes final places, nomination reserves, unique identities and budget claims',async()=>{
    const target = new URL(connectionString!);
    if (!['127.0.0.1','localhost','[::1]'].includes(target.hostname)) throw new Error('Genesis integration checks require an explicitly local test database.');
    const schema='genesis_test_'+randomUUID().replaceAll('-','');
    const manager=new Pool({connectionString,max:1});let pool:Pool|undefined;
    try {
      await manager.query(`CREATE SCHEMA ${schema}`);
      pool=new Pool({connectionString,max:6,options:`-c search_path=${schema}`});
      await pool.query(await readFile(new URL('../../../../db/schema.sql',import.meta.url),'utf8'));
      const store=createGenesisStore(()=>pool!);const now=Date.parse('2030-01-02T00:00:00Z');
      await store.transaction(tx=>tx.saveCampaign(genesisCampaignSchema.parse({state:'open',opensAt:'2030-01-01T00:00:00Z',closesAt:'2030-01-03T00:00:00Z',projectXId:'999',projectHandle:'oneshot',rulesAccepted:true,nominationsOpen:true})));
      const seed=(index:number,selected:boolean):GenesisApplication=>({id:randomUUID(),userId:`did:privy:pg-${index}`,profile:{id:String(index),username:`person_${index}`,name:'Person',avatarUrl:null},code:String(index).padStart(16,'0'),referrerId:null,createdAt:new Date(now).toISOString(),submittedAt:new Date(now).toISOString(),revision:1,ruleVersion:1,status:'under_review',checks:Object.fromEntries(['follow','post','share'].map(task=>[task,{state:'verified',checkedAt:new Date(now).toISOString(),message:'Verified'}])),decision:selected?'selected':null,publishedDecision:selected?'selected':null,note:'',shareConsent:false,consentVersion:GENESIS_CONSENT_VERSION});
      const candidates=[seed(800,false),seed(801,false),seed(802,false)];
      await store.transaction(async tx=>{for(let i=1;i<=748;i++)await tx.saveApplication(seed(i,true));for(const app of candidates)await tx.saveApplication(app);});
      const service=createGenesisService({store,now:()=>now,webOrigin:()=> 'https://oneshot.example',verifier:{project:async()=> 'oneshot',lookup:async username=>({id:username.slice(7),username}),verify:async()=>({state:'verified',message:'Verified',checkedAt:new Date(now).toISOString()})}});
      const results=await Promise.allSettled(candidates.map(app=>service.review(app.id,{expectedRevision:1,decision:'selected',note:'',publish:true,nominationQuota:1},'admin')));
      expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
      expect(await store.transaction(tx=>tx.count('selected'))).toBe(749);expect(await store.transaction(tx=>tx.count('reserved'))).toBe(1);
      const budget=await Promise.all(Array.from({length:8},()=>store.transaction(tx=>tx.budget(3,now))));expect(budget.filter(Boolean)).toHaveLength(3);
      const existing=await store.transaction(tx=>tx.application('xId','800'));
      await expect(store.transaction(tx=>tx.saveApplication({...seed(900,false),profile:existing!.profile}))).rejects.toMatchObject({code:'GENESIS_IDENTITY_USED'});
      const interrupted=seed(803,false);interrupted.status='awaiting_verification';
      interrupted.checks.follow={state:'pending',message:'Checking your X account…',checkedAt:null};
      const jobId=randomUUID();
      await store.transaction(async tx=>{
        await tx.saveApplication(interrupted);
        await tx.saveJob({id:jobId,applicationId:interrupted.id,xId:interrupted.profile.id,ruleVersion:1,task:'follow',attempts:1,state:'running',nextAt:now,leaseUntil:now+60_000});
      });
      const auth=createGenesisAuthStore(()=>pool!);
      await auth.transaction(async tx=>{await tx.saveIdentity(interrupted.profile);await tx.saveSession('session-hash',{xId:interrupted.profile.id,expiresAt:now+3600_000});await tx.state('oauth-state-hash',{browserHash:'browser-hash',verifier:'server-only-pkce',expiresAt:now+600_000});});
      const callbacks=await Promise.all([auth.transaction(tx=>tx.consume('oauth-state-hash','wrong-browser',now)),auth.transaction(tx=>tx.consume('oauth-state-hash','browser-hash',now)),auth.transaction(tx=>tx.consume('oauth-state-hash','browser-hash',now))]);
      expect(callbacks.filter(Boolean)).toHaveLength(1);
      await pool.end();pool=new Pool({connectionString,max:2,options:`-c search_path=${schema}`});
      const restarted=createGenesisStore(()=>pool!);expect((await restarted.transaction(tx=>tx.application('id',candidates[0].id)))?.profile.id).toBe('800');
      const restartedAuth=createGenesisAuthStore(()=>pool!);expect(await restartedAuth.transaction(tx=>tx.identity(interrupted.profile.id))).toEqual(interrupted.profile);
      expect(await restartedAuth.transaction(tx=>tx.session('session-hash'))).toEqual({xId:interrupted.profile.id,expiresAt:now+3600_000});
      await restartedAuth.transaction(tx=>tx.revoke('session-hash'));expect(await restartedAuth.transaction(tx=>tx.session('session-hash'))).toBeNull();
      expect(await restarted.transaction(tx=>tx.count('selected'))).toBe(749);expect(await restarted.transaction(tx=>tx.count('reserved'))).toBe(1);
      let recoveryTime=now;
      const recovered=createGenesisService({store:restarted,now:()=>recoveryTime,webOrigin:()=> 'https://oneshot.example',verifier:{project:async()=> 'oneshot',verify:async()=>({state:'verified',message:'Verified',checkedAt:new Date(recoveryTime).toISOString()})}});
      expect((await recovered.runJobs()).processed).toBe(0);
      recoveryTime+=60_001;expect((await recovered.runJobs()).processed).toBe(1);
      expect((await restarted.transaction(tx=>tx.application('id',interrupted.id)))?.status).toBe('under_review');
      expect(await restarted.transaction(tx=>tx.job(jobId))).toMatchObject({state:'done',attempts:2,leaseUntil:0});
    } finally {await pool?.end();await manager.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await manager.end();}
  },30000);
});
