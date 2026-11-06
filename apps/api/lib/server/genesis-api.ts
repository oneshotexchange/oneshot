import { z } from 'zod';
import { type NextRequest } from 'next/server';
import { json, boundedBody, rateLimit, ApiError } from './http';
import { genesisAuth } from './genesis-auth';
import { genesis } from './genesis-service';
import { genesisEnrollSchema, genesisRevisionSchema, genesisVerifySchema } from '../../../web/lib/genesis-schema';
import { genesisShareResponse } from './genesis-share';

export async function genesisApi(request: NextRequest): Promise<Response> {
  const path = request.nextUrl.pathname.replace(/\/$/, ''); const prefix = '/api/oneshot/genesis/';
  const operation = path.slice(prefix.length);
  if (operation.startsWith('auth/')) return (await genesisAuth.route(request))!;
  const publicRead = request.method === 'GET' || request.method === 'HEAD';
  if (operation === 'campaign' && publicRead) {
    rateLimit('genesis:campaign', 300);
    const response = json(await genesis.campaign());
    return request.method === 'HEAD' ? new Response(null, response) : response;
  }
  if (/^share\/[A-Za-z0-9_-]{16}(?:\/image)?$/.test(operation) && publicRead) {
    rateLimit('genesis:public:share', 300); return genesisShareResponse(request, operation.split('/')[1], operation.endsWith('/image'));
  }
  genesisAuth.assertWrite(request);
  const session = await genesisAuth.authenticate(request);
  if (session.provider === 'x' && request.headers.get('X-Genesis-Session') !== session.sessionId) throw new ApiError(401, 'GENESIS_AUTH_CHANGED', 'Your X sign-in changed. Refresh the page before continuing.');
  rateLimit(`genesis:account:${session.userId}`, 90);
  if (operation === 'me' && request.method === 'GET') return json(await genesis.me(session));
  if (request.method === 'POST') {
    rateLimit(`genesis:write:${session.userId}`, 12);
    const body = JSON.parse(new TextDecoder().decode(await boundedBody(request, 16_384)));
    if (operation === 'enroll') { const input = genesisEnrollSchema.parse(body); return json(await genesis.enroll(session, input.consentVersion, input.referral)); }
    if (operation === 'verify') { rateLimit(`genesis:verify:${session.userId}`, 6); const input = genesisVerifySchema.parse(body); return json(await genesis.verify(session, input.task, input.postUrl)); }
    if (operation === 'submit') { const input = genesisRevisionSchema.parse(body); return json(await genesis.submit(session, input.expectedRevision)); }
    if (operation === 'share') { const input = genesisRevisionSchema.extend({ enabled: z.boolean() }).strict().parse(body); return json(await genesis.share(session, input.enabled, input.expectedRevision)); }
    if (operation === 'nominations') { const input = z.object({ username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/) }).strict().parse(body); return json(await genesis.nominate(session, input.username)); }
    if (operation === 'nominations/accept') { const input = z.object({ id: z.string().uuid() }).strict().parse(body); return json(await genesis.acceptNomination(session, input.id)); }
  }
  throw new ApiError(404, 'NOT_FOUND', 'This application action is unavailable.');
}
