import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

describe('Genesis invitation edge routing',()=>{
  it('proxies only Genesis account routes and keeps callback cookies and redirects first-party',async()=>{
    const {worker,fetcher,assets}=await fixture();
    fetcher.mockImplementation(async()=>{const headers=new Headers({Location:'https://app.example/whitelist'});headers.append('Set-Cookie','oneshot_genesis_oauth=; Max-Age=0; HttpOnly');headers.append('Set-Cookie','oneshot_genesis_session=private; HttpOnly; Secure; SameSite=Lax');return new Response(null,{status:303,headers});});
    const result=await worker.fetch(new Request('https://app.example/api/oneshot/genesis/auth/callback?code=one-use&state=bound',{headers:{Cookie:'oneshot_genesis_oauth=bound-browser',Authorization:'Bearer must-not-forward'}}),{ASSETS:assets,GENESIS_API_ORIGIN:'https://api.example'});
    expect(result.status).toBe(303);expect(result.headers.get('location')).toBe('https://app.example/whitelist');expect(result.headers.getSetCookie()).toHaveLength(2);
    const [url,options]=fetcher.mock.calls[0];expect(String(url)).toBe('https://api.example/api/oneshot/genesis/auth/callback?code=one-use&state=bound');
    expect(new Headers(options?.headers).get('Cookie')).toBe('oneshot_genesis_oauth=bound-browser');expect(new Headers(options?.headers).has('Authorization')).toBe(false);expect(options?.redirect).toBe('manual');
    await worker.fetch(new Request('https://app.example/api/admin/genesis'),{ASSETS:assets,GENESIS_API_ORIGIN:'https://api.example'});expect(assets.fetch).toHaveBeenCalledOnce();
  });
  it('forwards same-origin account protection and bounded JSON bodies, and refuses arbitrary redirects',async()=>{
    const {worker,fetcher,assets}=await fixture();
    await worker.fetch(new Request('https://app.example/api/oneshot/genesis/submit?discard=this',{method:'POST',headers:{Origin:'https://app.example',Cookie:'oneshot_genesis_session=private','Content-Type':'application/json','X-Genesis-Session':'current'},body:'{"expectedRevision":1}'}),{ASSETS:assets,GENESIS_API_ORIGIN:'https://api.example'});
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.example/api/oneshot/genesis/submit');expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('X-Genesis-Session')).toBe('current');
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1]?.body as Uint8Array)).toBe('{"expectedRevision":1}');
    expect((await worker.fetch(new Request('https://app.example/api/oneshot/genesis/enroll',{method:'POST',body:'a'.repeat(16385)}),{ASSETS:assets,GENESIS_API_ORIGIN:'https://api.example'})).status).toBe(413);
    fetcher.mockImplementation(async()=>new Response(null,{status:303,headers:{Location:'https://other.example/steal'}}));
    expect((await worker.fetch(new Request('https://app.example/api/oneshot/genesis/auth/callback'),{ASSETS:assets,GENESIS_API_ORIGIN:'https://api.example'})).status).toBe(503);
  });
  it('forwards HEAD and keeps successful and unavailable responses bodyless',async()=>{
    const {worker,fetcher,assets}=await fixture();const request=new Request('https://app.example/g/abcdefghijklmnop',{method:'HEAD'});
    const response=await worker.fetch(request,{ASSETS:assets,GENESIS_API_ORIGIN:'https://api.example'});
    expect(response.status).toBe(200);expect(await response.text()).toBe('');expect(fetcher.mock.calls[0][1]?.method).toBe('HEAD');
    const unavailable=await worker.fetch(request,{ASSETS:assets});expect(unavailable.status).toBe(503);expect(await unavailable.text()).toBe('');
  });
  async function fixture(){const fetcher=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>new Response('<html>Public invitation</html>',{headers:{'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'"}}));const source=await readFile(new URL('../apps/web/public/_worker.js',import.meta.url),'utf8');const worker=new Function('fetch',source.replace('export default','return'))(fetcher) as {fetch(request:Request,env:unknown):Promise<Response>};const assets={fetch:vi.fn(async()=>new Response('static asset'))};return{worker,fetcher,assets};}
  it('keeps ordinary routes static and forwards only the code to the fixed configured origin',async()=>{const {worker,fetcher,assets}=await fixture();expect(await(await worker.fetch(new Request('https://app.example/whitelist'),{ASSETS:assets})).text()).toBe('static asset');expect(assets.fetch).toHaveBeenCalledOnce();const response=await worker.fetch(new Request('https://app.example/g/abcdefghijklmnop?secret=ignore',{headers:{Authorization:'Bearer private-token',Cookie:'private-session'}}),{ASSETS:assets,GENESIS_API_ORIGIN:'https://api.example'});expect(response.status).toBe(200);expect(String(fetcher.mock.calls[0][0])).toBe('https://api.example/api/oneshot/genesis/share/abcdefghijklmnop');expect(fetcher.mock.calls[0][1]).not.toHaveProperty('headers');expect(response.headers.get('cache-control')).toBe('no-store');});
  it('rejects writes and fails safely for a missing or unsafe upstream origin',async()=>{const {worker,fetcher,assets}=await fixture();expect((await worker.fetch(new Request('https://app.example/g/abcdefghijklmnop',{method:'POST'}),{ASSETS:assets,GENESIS_API_ORIGIN:'https://api.example'})).status).toBe(405);for(const value of [undefined,'http://127.0.0.1:3001','https://user:password@api.example','https://api.example/private']){const result=await worker.fetch(new Request('https://app.example/g/abcdefghijklmnop'),{ASSETS:assets,GENESIS_API_ORIGIN:value});expect(result.status).toBe(503);expect(await result.text()).toContain('Continue to Genesis');}expect(fetcher).not.toHaveBeenCalled();});
});
