import {afterEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {createTokenWalletReader} from './token-wallets';
import {oneshotApi} from './oneshot-api';
import {api} from './http';
import * as auth from './oneshot-auth';
import {tokenAddress as a} from '../../../indexer/test/token-fixture';
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('public token wallet boundary',()=>{
  it('returns a disabled public wallet context without account authentication or fabricated zero balances',async()=>{
    vi.stubEnv('ONESHOT_TOKEN_ANALYTICS_READS_ENABLED','false');const session=vi.spyOn(auth,'requireOneshotSession').mockRejectedValue(new Error('No auth expected'));
    const response=await oneshotApi(new NextRequest(`http://localhost/api/oneshot/token-analytics/wallets/${a(99)}`),{});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({context:{enabled:false,available:false,source:null,checkpoint:null},wallet:a(99),scope:'registered-token-markets',holdingCount:null,items:[],nextCursor:null});expect(session).not.toHaveBeenCalled();
  });
  it('requires a nonzero wallet, bounded page size and one checkpoint cursor before provider/database work',async()=>{
    const pool=vi.fn(()=>{throw new Error('Unexpected database');}),source=vi.fn(async()=>{throw new Error('Unexpected provider');});const reader=createTokenWalletReader({env:()=>({ONESHOT_TOKEN_ANALYTICS_READS_ENABLED:'true'}),pool,source});
    for(const suffix of ['?limit=1','?limit=6','?limit=02','?limit=3&limit=3','?cursor=bad','?q=x']){const response=await api(request=>reader(request))(new NextRequest(`http://localhost/api/oneshot/token-analytics/wallets/${a(99)}${suffix}`),{});expect(response.status).toBe(400);}
    expect((await api(request=>reader(request))(new NextRequest(`http://localhost/api/oneshot/token-analytics/wallets/${a(0)}`),{})).status).toBe(404);expect(pool).not.toHaveBeenCalled();expect(source).not.toHaveBeenCalled();
  });
});
