import {afterEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {createTokenAnalyticsReader} from './token-analytics';
import {oneshotApi} from './oneshot-api';
import {api} from './http';
import * as auth from './oneshot-auth';
import {tokenAddress as a} from '../../../indexer/test/token-fixture';
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('canonical token analytics public boundary',()=>{
  it('routes a safely disabled journal context before account authentication',async()=>{
    vi.stubEnv('ONESHOT_TOKEN_ANALYTICS_READS_ENABLED','false');const session=vi.spyOn(auth,'requireOneshotSession').mockRejectedValue(new Error('No auth expected'));
    const response=await oneshotApi(new NextRequest(`http://localhost/api/oneshot/token-analytics/markets/${a(5)}`),{});expect(response.status).toBe(200);const body=await response.json();expect(body).toMatchObject({context:{kind:'canonical-event-journal',available:false,enabled:false,source:null,checkpoint:null},market:null,analytics:null});expect(session).not.toHaveBeenCalled();
  });
  it('rejects malformed page inputs and unsupported methods before any database or provider work',async()=>{
    const pool=vi.fn(()=>{throw new Error('Unexpected database');}),source=vi.fn(async()=>{throw new Error('Unexpected provider');});
    const reader=createTokenAnalyticsReader({env:()=>({ONESHOT_TOKEN_ANALYTICS_READS_ENABLED:'true'}),pool,source});
    for(const suffix of ['/trades?limit=01','/holders?limit=51','/holders?kind=all','/trades?kind=all&kind=pool-swap','/trades?cursor=invalid','?limit=1']){
      const response=await api(request=>reader(request))(new NextRequest(`http://localhost/api/oneshot/token-analytics/markets/${a(5)}${suffix}`),{});expect(response.status).toBe(400);
    }
    const response=await api(request=>reader(request))(new NextRequest(`http://localhost/api/oneshot/token-analytics/markets/${a(5)}`,{method:'POST'}),{});expect(response.status).toBe(405);expect(pool).not.toHaveBeenCalled();expect(source).not.toHaveBeenCalled();
  });
});
