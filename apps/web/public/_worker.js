// Only Genesis routes reach the API. Other product pages remain static assets.
// First-party routing keeps X sessions in host-only HttpOnly cookies, including
// the OAuth callback; the browser never receives an X access token.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const invitation = /^\/g\/([A-Za-z0-9_-]{16})\/?$/.exec(url.pathname);
    const account = /^\/api\/oneshot\/genesis\/(?:campaign|me|enroll|verify|submit|share|nominations(?:\/accept)?|auth\/(?:session|start|callback|logout))\/?$/.test(url.pathname);
    if (!invitation && !account) return env.ASSETS.fetch(request);
    if (!(invitation ? ['GET','HEAD'] : ['GET','HEAD','POST']).includes(request.method)) return new Response('Method not allowed',{status:405});
    try {
      const origin = new URL(env.GENESIS_API_ORIGIN);
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid origin');
      const target = new URL(invitation ? '/api/oneshot/genesis/share/' + invitation[1] : url.pathname, origin);
      if (account && url.pathname.replace(/\/$/,'').endsWith('/auth/callback')) target.search = url.search;
      const options = {method:request.method,redirect:invitation?'error':'manual',signal:AbortSignal.timeout(invitation?15000:45000)};
      if (account) {
        const headers = new Headers();
        for (const name of ['Cookie','Content-Type','Origin','X-Genesis-Session']) if(request.headers.has(name)) headers.set(name,request.headers.get(name));
        options.headers = headers;
        if (request.method === 'POST') {
          const reader = request.body?.getReader(); const chunks=[]; let size=0;
          if (reader) for (;;) { const part=await reader.read(); if(part.done)break; size+=part.value.byteLength; if(size>16384){await reader.cancel();return Response.json({error:{message:'This request is too large.'}},{status:413});}chunks.push(part.value); }
          const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}options.body=body;
        }
      }
      const upstream = await fetch(target,options);
      if (account) {
        if (upstream.status>=300 && upstream.status<400) {
          const location=new URL(upstream.headers.get('Location'),url.origin);
          if(location.origin!==url.origin || location.pathname!=='/whitelist')throw new Error('Invalid redirect');
        }
        const headers=new Headers(upstream.headers);headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');
        return new Response(request.method==='HEAD'?null:upstream.body,{status:upstream.status,headers});
      }
      return new Response(request.method==='HEAD'?null:upstream.body,{status:upstream.status,headers:{'Content-Type':upstream.headers.get('Content-Type')||'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':upstream.headers.get('Content-Security-Policy')||"default-src 'none'; frame-ancestors 'none'"}});
    } catch {
      if(account)return new Response(request.method==='HEAD'?null:JSON.stringify({error:{message:'This service is temporarily unavailable. Please try again.'}}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
      return new Response(request.method==='HEAD'?null:'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>oneshot Genesis</title><body><h1>This invitation is temporarily unavailable.</h1><p>Your application is still available on the Genesis page.</p><a href="/whitelist">Continue to Genesis</a></body></html>',{status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
    }
  },
};
