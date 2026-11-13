import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createGenesisAuth, type GenesisAuthDiagnostic } from './genesis-auth';
import { memoryGenesisAuthStore } from './genesis-auth-store';
import { memoryGenesisStore } from './genesis-store';
import { createGenesisService } from './genesis-service';
import { genesisCampaignSchema, GENESIS_CONSENT_VERSION } from '../../../web/lib/genesis-schema';

const origin='https://oneshot.example.com';
const identity={id:'123',username:'person',name:'Person',avatarUrl:'https://pbs.twimg.com/profile_images/example.png'};
function fixture() {
  const store=memoryGenesisAuthStore();const applications=memoryGenesisStore();let time=Date.parse('2030-01-02T00:00:00Z');
  const environment:Record<string,string|undefined>={NODE_ENV:'production',NEXT_PUBLIC_APP_URL:origin,X_OAUTH_CLIENT_ID:'test-client',X_OAUTH_CLIENT_SECRET:'test-secret'};
  const fetcher=vi.fn<typeof fetch>(async url=>String(url).endsWith('/oauth2/token')?Response.json({access_token:'discarded-x-token'}):Response.json({data:{id:identity.id,username:identity.username,name:identity.name,profile_image_url:identity.avatarUrl}}));
  const diagnostic=vi.fn<(failure:GenesisAuthDiagnostic)=>void>();
  const auth=createGenesisAuth({store,applications,environment:()=>environment,fetcher,now:()=>time,diagnostic});
  const request=(cookie:string)=>new NextRequest(origin+'/api/oneshot/genesis/me',{headers:{Cookie:`oneshot_genesis_session=${cookie}`}});
  const begin=async()=>{const started=await auth.start();return{...started,state:new URL(started.url).searchParams.get('state')!};};
  return{store,applications,environment,auth,fetcher,diagnostic,request,begin,setTime:(value:number)=>{time=value;}};
}
describe('official X OAuth and saved Genesis sessions',()=>{
  it('uses PKCE S256 and read scopes at fixed official endpoints, then discards X tokens',async()=>{
    const f=fixture();const started=await f.begin();const url=new URL(started.url);
    expect(url.origin+url.pathname).toBe('https://x.com/i/oauth2/authorize');expect(url.searchParams.get('scope')).toBe('users.read tweet.read');expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(origin+'/api/oneshot/genesis/auth/callback');
    const result=await f.auth.callback('official-code',started.state,started.browser);
    const exchange=new URLSearchParams(String(f.fetcher.mock.calls[0][1]?.body));
    expect(new Headers(f.fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe('Basic '+Buffer.from('test-client:test-secret').toString('base64'));
    expect(exchange.has('client_id')).toBe(false);
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(f.fetcher.mock.calls.map(call=>String(call[0]))).toEqual(['https://api.x.com/2/oauth2/token','https://api.x.com/2/users/me?user.fields=profile_image_url']);
    expect(f.fetcher.mock.calls.every(call=>call[1]?.redirect==='error')).toBe(true);
    const session=await f.auth.authenticate(f.request(result.cookie));expect(session).toMatchObject({provider:'x',userId:'x:123',linkedAddresses:[],xAccount:identity});
    expect(await f.store.transaction(tx=>tx.identity('123'))).toEqual(identity);
    expect(JSON.stringify(await f.store.transaction(tx=>tx.session(createHash('sha256').update(result.cookie).digest('hex'))))).not.toContain('discarded-x-token');
    expect(await f.store.transaction(tx=>tx.session(result.cookie))).toBeNull();
    expect(f.diagnostic).not.toHaveBeenCalled();
  });
  it('includes client_id without Basic authentication for a public client',async()=>{
    const f=fixture();delete f.environment.X_OAUTH_CLIENT_SECRET;const started=await f.begin();
    await f.auth.callback('official-code',started.state,started.browser);
    const request=f.fetcher.mock.calls[0][1];
    expect(new Headers(request?.headers).has('Authorization')).toBe(false);
    expect(new URLSearchParams(String(request?.body)).get('client_id')).toBe('test-client');
    expect(f.diagnostic).not.toHaveBeenCalled();
  });
  async function callbackRoute(f:ReturnType<typeof fixture>,started:Awaited<ReturnType<ReturnType<typeof fixture>['begin']>>) {
    return f.auth.route(new NextRequest(origin+`/api/oneshot/genesis/auth/callback?code=private-code&state=${started.state}`,{headers:{Cookie:`oneshot_genesis_oauth=${started.browser}`}}));
  }
  function expectFailedCallback(response:Response|null) {
    expect(response?.status).toBe(303);expect(response?.headers.get('location')).toBe(origin+'/whitelist?x_login=failed');
    expect(response?.headers.getSetCookie().some(cookie=>cookie.startsWith('oneshot_genesis_session='))).toBe(false);
    expect(response?.headers.get('cache-control')).toBe('no-store');
  }
  it.each([{stage:'token',status:401},{stage:'identity',status:403}] as const)('records only the $stage rejection status and creates no session',async({stage,status})=>{
    const f=fixture();const started=await f.begin();
    f.fetcher.mockImplementation(async url=>{
      if(String(url).endsWith('/oauth2/token')&&stage==='identity')return Response.json({access_token:'private-access-token'});
      return Response.json({error:'private-provider-error',error_description:'private-secret private-code private-identity'},{status});
    });
    expectFailedCallback(await callbackRoute(f,started));
    expect(f.diagnostic.mock.calls).toEqual([[{stage,reason:'rejected',httpStatus:status}]]);
    expect(await f.store.transaction(tx=>tx.identity(identity.id))).toBeNull();
    expect(f.fetcher).toHaveBeenCalledTimes(stage==='token'?1:2);
  });
  it.each([{stage:'token',invalid:'json'},{stage:'token',invalid:'schema'},{stage:'identity',invalid:'json'},{stage:'identity',invalid:'schema'}] as const)('classifies malformed $stage $invalid without logging its contents',async({stage,invalid})=>{
    const f=fixture();const started=await f.begin();
    f.fetcher.mockImplementation(async url=>{
      if(String(url).endsWith('/oauth2/token')&&stage==='identity')return Response.json({access_token:'private-access-token'});
      return invalid==='json'?new Response('private-malformed-response'):Response.json(stage==='token'?{access_token:42,private:'private-response'}:{data:{id:'private-identity',username:'person'}});
    });
    expectFailedCallback(await callbackRoute(f,started));
    expect(f.diagnostic.mock.calls).toEqual([[{stage,reason:'invalid_response',httpStatus:200}]]);
    expect(await f.store.transaction(tx=>tx.identity(identity.id))).toBeNull();
  });
  it.each([{stage:'token',name:'TimeoutError'},{stage:'identity',name:'AbortError'}] as const)('classifies a $stage timeout without logging the exception',async({stage,name})=>{
    const f=fixture();const started=await f.begin();
    f.fetcher.mockImplementation(async url=>{
      if(String(url).endsWith('/oauth2/token')&&stage==='identity')return Response.json({access_token:'private-access-token'});
      throw new DOMException('private-client-secret private-code private-identity',name);
    });
    expectFailedCallback(await callbackRoute(f,started));
    expect(f.diagnostic.mock.calls).toEqual([[{stage,reason:'timeout'}]]);
    expect(await f.store.transaction(tx=>tx.identity(identity.id))).toBeNull();
  });
  it('rolls back identity/session persistence and reports no provider or database details',async()=>{
    const f=fixture();const started=await f.begin();const transaction=f.store.transaction.bind(f.store);let sessionHash:string|undefined;
    const spy=vi.spyOn(f.store,'transaction').mockImplementation(operation=>transaction(tx=>operation({...tx,saveSession:async(hash)=>{sessionHash=hash;throw new Error('private-database-url private-access-token private-client-secret');}})));
    expectFailedCallback(await callbackRoute(f,started));spy.mockRestore();
    expect(sessionHash).toBeDefined();expect(await f.store.transaction(tx=>tx.session(sessionHash!))).toBeNull();
    expect(await f.store.transaction(tx=>tx.identity(identity.id))).toBeNull();
    expect(f.diagnostic.mock.calls).toEqual([[{stage:'persistence',reason:'storage_failure'}]]);
  });
  it('records cancellation, malformed callbacks and expiry once without making provider requests',async()=>{
    const f=fixture();const started=await f.begin();
    expectFailedCallback(await f.auth.route(new NextRequest(origin+'/api/oneshot/genesis/auth/callback?error=private-provider-text&error_description=private-identity')));
    expectFailedCallback(await f.auth.route(new NextRequest(origin+'/api/oneshot/genesis/auth/callback?code=private-one&code=private-two')));
    f.setTime(Date.parse('2030-01-02T00:11:00Z'));expectFailedCallback(await callbackRoute(f,started));
    expect(f.diagnostic.mock.calls).toEqual([[{stage:'callback',reason:'cancelled'}],[{stage:'callback',reason:'invalid_callback'}],[{stage:'state',reason:'expired'}]]);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('preserves successful and failed authentication when the diagnostic sink throws',async()=>{
    const f=fixture();f.diagnostic.mockImplementation(()=>{throw new Error('private-logging-error');});
    const started=await f.begin();const result=await f.auth.callback('official-code',started.state,started.browser);
    expect((await f.auth.authenticate(f.request(result.cookie))).xAccount).toEqual(identity);
    await expect(f.auth.callback('private-replay-code',started.state,started.browser)).rejects.toMatchObject({code:'GENESIS_AUTH_EXPIRED'});
    const fresh=await f.begin();f.fetcher.mockRejectedValue(new Error('private-network-details'));expectFailedCallback(await callbackRoute(f,fresh));
    expect(f.diagnostic.mock.calls).toEqual([[{stage:'state',reason:'expired'}],[{stage:'token',reason:'request_failed'}]]);
  });
  it('rejects a forwarded authorization without consuming the initiating browser state',async()=>{
    const f=fixture();const started=await f.begin();
    await expect(f.auth.callback('code',started.state,'a'.repeat(43))).rejects.toMatchObject({code:'GENESIS_AUTH_EXPIRED'});expect(f.fetcher).not.toHaveBeenCalled();
    await f.auth.callback('code',started.state,started.browser);expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('allows only one racing callback and rejects replay before making another X request',async()=>{
    const f=fixture();const started=await f.begin();const results=await Promise.allSettled([f.auth.callback('code',started.state,started.browser),f.auth.callback('code',started.state,started.browser)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(f.fetcher).toHaveBeenCalledTimes(2);
    await expect(f.auth.callback('code',started.state,started.browser)).rejects.toMatchObject({code:'GENESIS_AUTH_EXPIRED'});expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('expires browser state and sessions, and fails closed on malformed official identities',async()=>{
    const f=fixture();const started=await f.begin();f.setTime(Date.parse('2030-01-02T00:11:00Z'));
    await expect(f.auth.callback('code',started.state,started.browser)).rejects.toMatchObject({code:'GENESIS_AUTH_EXPIRED'});expect(f.fetcher).not.toHaveBeenCalled();
    const fresh=await f.begin();f.fetcher.mockImplementation(async url=>String(url).endsWith('/oauth2/token')?Response.json({access_token:'discard'}):Response.json({data:{id:'not-an-id',username:'person'}}));
    await expect(f.auth.callback('code',fresh.state,fresh.browser)).rejects.toMatchObject({code:'GENESIS_AUTH_UNAVAILABLE'});expect(await f.store.transaction(tx=>tx.identity('123'))).toBeNull();
    f.fetcher.mockImplementation(async url=>String(url).endsWith('/oauth2/token')?Response.json({access_token:'discard'}):Response.json({data:{id:'123',username:'person'}}));
    const final=await f.begin();const session=await f.auth.callback('code',final.state,final.browser);f.setTime(session.expiresAt);
    await expect(f.auth.authenticate(f.request(session.cookie))).rejects.toMatchObject({status:401});
  });
  it('recovers an existing Privy-owned application by verified numeric X ID without wallet access',async()=>{
    const f=fixture();await f.applications.transaction(tx=>tx.saveCampaign(genesisCampaignSchema.parse({state:'open'})));
    const service=createGenesisService({store:f.applications,webOrigin:()=>origin});
    const saved=await service.enroll({provider:'privy',userId:'did:privy:original',sessionId:'old',expiresAt:9999999999,linkedAddresses:['0x1111111111111111111111111111111111111111'],xAccount:identity},GENESIS_CONSENT_VERSION);
    const started=await f.begin();const result=await f.auth.callback('code',started.state,started.browser);const session=await f.auth.authenticate(f.request(result.cookie));
    expect(session.userId).toBe('did:privy:original');expect(session.provider).toBe('x');expect(session.linkedAddresses).toEqual([]);
    expect((await service.me(session)).application?.id).toBe(saved.application?.id);
  });
  it('sets HttpOnly first-party cookies, returns no session secrets, and revokes on sign-out',async()=>{
    const f=fixture();const start=await f.auth.route(new NextRequest(origin+'/api/oneshot/genesis/auth/start',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'}));
    const browser=/oneshot_genesis_oauth=([^;]+)/.exec(start!.headers.get('set-cookie')!)![1];const state=new URL((await start!.json()).url).searchParams.get('state')!;
    const callback=await f.auth.route(new NextRequest(origin+`/api/oneshot/genesis/auth/callback?code=code&state=${state}`,{headers:{Cookie:`oneshot_genesis_oauth=${browser}`}}));
    expect(callback?.status).toBe(303);expect(callback?.headers.get('location')).toBe(origin+'/whitelist');
    const cookies=callback!.headers.getSetCookie();const sessionCookie=cookies.find(cookie=>cookie.startsWith('oneshot_genesis_session='))!;
    expect(sessionCookie).toContain('HttpOnly');expect(sessionCookie).toContain('Secure');expect(sessionCookie).toContain('SameSite=lax');expect(sessionCookie).not.toContain('Domain=');
    const cookie=/oneshot_genesis_session=([^;]+)/.exec(sessionCookie)![1];
    const status=await f.auth.route(new NextRequest(origin+'/api/oneshot/genesis/auth/session',{headers:{Cookie:`oneshot_genesis_session=${cookie}`}}));
    const body=await status!.text();expect(body).toContain('person');expect(body).not.toContain(cookie);expect(body).not.toContain('discarded-x-token');
    await expect(f.auth.route(new NextRequest(origin+'/api/oneshot/genesis/auth/logout',{method:'POST',headers:{Origin:origin,Cookie:`oneshot_genesis_session=${cookie}`,'X-Genesis-Session':'old-session'}}))).rejects.toMatchObject({code:'GENESIS_AUTH_CHANGED'});
    await f.auth.route(new NextRequest(origin+'/api/oneshot/genesis/auth/logout',{method:'POST',headers:{Origin:origin,Cookie:`oneshot_genesis_session=${cookie}`,'X-Genesis-Session':createHash('sha256').update(cookie).digest('hex').slice(0,32)}}));
    await expect(f.auth.authenticate(f.request(cookie))).rejects.toMatchObject({status:401});
  });
  it('preserves the invitation in server state when browser storage cannot carry it',async()=>{
    const f=fixture();const start=await f.auth.route(new NextRequest(origin+'/api/oneshot/genesis/auth/start',{method:'POST',headers:{Origin:origin},body:JSON.stringify({referral:'abcdefghijklmnop'})}));
    const browser=/oneshot_genesis_oauth=([^;]+)/.exec(start!.headers.get('set-cookie')!)![1];const state=new URL((await start!.json()).url).searchParams.get('state')!;
    const response=await f.auth.route(new NextRequest(origin+`/api/oneshot/genesis/auth/callback?code=code&state=${state}`,{headers:{Cookie:`oneshot_genesis_oauth=${browser}`}}));
    expect(response!.headers.get('location')).toBe(origin+'/whitelist?ref=abcdefghijklmnop');
  });
  it('rejects cross-origin writes and a mismatched callback configuration',async()=>{
    const f=fixture();const request=new NextRequest(origin+'/api/oneshot/genesis/submit',{method:'POST',headers:{Origin:'https://other.example.com',Cookie:'oneshot_genesis_session='+'a'.repeat(43)}});
    expect(()=>f.auth.assertWrite(request)).toThrowError(expect.objectContaining({status:403}));
    await expect(f.auth.route(new NextRequest(origin+'/api/oneshot/genesis/auth/start',{method:'POST',headers:{Origin:'https://other.example.com'},body:'{}'}))).rejects.toMatchObject({status:403});
    f.environment.X_OAUTH_REDIRECT_URI='https://other.example.com/callback';expect(f.auth.available()).toBe(false);await expect(f.auth.start()).rejects.toMatchObject({status:503});expect(f.fetcher).not.toHaveBeenCalled();
  });
});
