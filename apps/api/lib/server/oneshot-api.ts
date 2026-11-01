import { z } from 'zod';
import { api, json, readJson, rateLimit, boundedBody } from './http';
import { ApiError } from './errors';
import { requireOneshotSession } from './oneshot-auth';
import { archiveOneshotDraft, createOneshotDraft, getOneshotDraft, listOneshotDrafts, prepareOneshotDraft, readOneshotMetadata, updateOneshotDraft } from './oneshot-drafts';
import { storeImage } from './media';
import { apiOrigin } from './origins';
import { indexedNftRead } from './indexed-nfts';
import { nftLaunch } from './nft-launch';

const revision = z.number().int().positive();
const change = z.object({ expectedRevision: revision, draft: z.unknown() }).strict();
const expected = z.object({ expectedRevision: revision }).strict();
export const oneshotApi = api(async request => {
  const prefix = '/api/oneshot/';
  if (!request.nextUrl.pathname.startsWith(prefix)) throw new ApiError(404, 'NOT_FOUND', 'API resource not found.');
  const segments = request.nextUrl.pathname.slice(prefix.length).replace(/\/$/,'').split('/');
  const [resource, id, operation, extra] = segments;
  if (resource === 'launch' && segments.length === 2 && id === 'status' && request.method === 'GET') {
    rateLimit('oneshot:launch:status', 60);
    const status = await nftLaunch.status();
    return json({ ...status, reason: status.enabled ? null : 'Collection launches are currently unavailable. You can save a draft and return later.' });
  }
  if (resource === 'launch' && segments.length === 3 && id === 'collections' && request.method === 'GET') {
    rateLimit('oneshot:launch:collections',120);
    return json(await nftLaunch.collection(operation));
  }
  if (resource === 'indexed') {
    // Public reads still have a process-wide budget before manifest/RPC/database work.
    rateLimit('oneshot:indexed:public', 240);
    return indexedNftRead(request);
  }
  if (resource === 'metadata' && request.method === 'GET' && segments.length === 3) {
    const blob = await readOneshotMetadata(id, operation);
    return new Response(new Uint8Array(blob.buffer), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public,max-age=31536000,immutable', 'X-Content-Type-Options': 'nosniff' } });
  }
  const session = await requireOneshotSession(request);
  rateLimit(`oneshot:read:${session.userId}`, 120);
  if (resource==='launch' && request.method==='GET') {
    rateLimit(`oneshot:recover:${session.userId}`,60);
    if (segments.length === 2 && id === 'earnings') {
      const query = request.nextUrl.searchParams;
      for (const key of query.keys()) if (!['wallet', 'cursor'].includes(key) || query.getAll(key).length !== 1)
        throw new ApiError(400, 'INVALID_INPUT', 'Use one linked wallet and an optional earnings page cursor.');
      const input = z.object({ wallet: z.string().regex(/^0x[\da-fA-F]{40}$/), cursor: z.string().min(1).max(2048).optional() }).strict().parse(Object.fromEntries(query));
      return json(await nftLaunch.earnings({ from: input.wallet, cursor: input.cursor }, session));
    }
    if (segments.length === 3 && id === 'drafts') {
      const query = request.nextUrl.searchParams;
      for (const key of query.keys()) if (!['wallet', 'revision', 'launchId', 'cursor'].includes(key) || query.getAll(key).length !== 1)
        throw new ApiError(400, 'INVALID_INPUT', 'Use one creator wallet, draft revision and saved launch selection.');
      const input = z.object({
        wallet: z.string().regex(/^0x[\da-fA-F]{40}$/),
        revision: z.string().regex(/^[1-9]\d{0,15}$/).transform(Number).refine(Number.isSafeInteger),
        launchId: z.string().uuid().optional(), cursor: z.string().min(1).max(512).optional(),
      }).strict().parse(Object.fromEntries(query));
      if (input.launchId && input.cursor) throw new ApiError(400, 'INVALID_INPUT', 'Select a saved launch or a page cursor separately.');
      return json(await nftLaunch.progress(z.string().uuid().parse(operation), {
        expectedRevision: input.revision, from: input.wallet, launchId: input.launchId, cursor: input.cursor,
      }, session));
    }
    if(segments.length===3&&id==='floor') {
      const query=request.nextUrl.searchParams;
      if([...query.keys()].some(key=>key!=='wallet')||query.getAll('wallet').length!==1)throw new ApiError(400,'INVALID_INPUT','Use one linked creator wallet.');
      return json(await nftLaunch.floor(operation,z.string().regex(/^0x[\da-fA-F]{40}$/).parse(query.get('wallet')),session));
    }
    if (segments.length===3 && id==='reviews') return json(await nftLaunch.recover(z.string().uuid().parse(operation),session));
    if (segments.length===2 && id==='transactions') {
      const query=request.nextUrl.searchParams;
      for (const key of query.keys()) if (!['wallet','limit','cursor'].includes(key) || query.getAll(key).length!==1) throw new ApiError(400,'INVALID_INPUT','Use a valid recovery query.');
      const input=z.object({wallet:z.string().regex(/^0x[\da-fA-F]{40}$/).optional(),limit:z.coerce.number().int().min(1).max(50).default(20),cursor:z.string().max(2048).optional()}).parse(Object.fromEntries(query));
      return json(await nftLaunch.transactions(session,input));
    }
  }
  if (resource === 'launch' && segments.length === 2 && request.method === 'POST') {
    rateLimit(`oneshot:launch:${session.userId}`, 30);
    const body = await readJson(request);
    if (id === 'review') return json(await nftLaunch.review(body, session), 201);
    if (id === 'submitted') {
      const input=z.object({reviewId:z.string().uuid(),reviewHash:z.string().regex(/^0x[\da-f]{64}$/),hash:z.string().regex(/^0x[\da-fA-F]{64}$/)}).strict().parse(body);
      return json(await nftLaunch.submitted(input.reviewId,input.reviewHash,input.hash as `0x${string}`,session));
    }
    if (id === 'validate') {
      const input = z.object({reviewId:z.string().uuid(),reviewHash:z.string().regex(/^0x[\da-f]{64}$/)}).strict().parse(body);
      return json(await nftLaunch.validate(input.reviewId,input.reviewHash,session));
    }
    if (id === 'receipt') {
      const input = z.object({reviewId:z.string().uuid(),hash:z.string().regex(/^0x[\da-fA-F]{64}$/)}).strict().parse(body);
      return json(await nftLaunch.receipt(input.reviewId,input.hash as `0x${string}`,session));
    }
  }
  if (resource === 'session' && segments.length === 1 && request.method === 'GET') return json({ userId: session.userId, linkedAddresses: session.linkedAddresses, expiresAt: session.expiresAt });
  if (resource === 'media' && segments.length === 1 && request.method === 'POST') {
    rateLimit(`oneshot:upload:${session.userId}`, 10);
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data;')) throw new ApiError(400, 'FILE_REQUIRED', 'Upload an image as multipart form data.');
    const body = await boundedBody(request, 6 * 1024 * 1024);
    let form: FormData;
    try { form = await new Response(body as BodyInit, { headers: { 'Content-Type': contentType } }).formData(); }
    catch { throw new ApiError(400, 'INVALID_MULTIPART', 'Upload a valid image as multipart form data.'); }
    const file = form.get('file');
    if (!(file instanceof File) || !['image/png','image/jpeg','image/webp'].includes(file.type)) throw new ApiError(400, 'INVALID_IMAGE', 'Choose a PNG, JPEG or WebP image.');
    const uploaded = await storeImage(Buffer.from(await file.arrayBuffer()), session.userId, apiOrigin(request.nextUrl.origin));
    return json({ ...uploaded, reference: `/api/media/${uploaded.hash}.webp`, publicContent: true }, 201);
  }
  if (resource === 'drafts' && !extra) {
    if (segments.length === 1) {
      if (request.method === 'GET') return json({ items: await listOneshotDrafts(session) });
      if (request.method === 'POST') { rateLimit(`oneshot:draft:${session.userId}`, 20); return json(await createOneshotDraft(await readJson(request), session), 201); }
    }
    if (segments.length === 2) {
      if (request.method === 'GET') return json(await getOneshotDraft(id, session));
      if (request.method === 'PUT') { rateLimit(`oneshot:edit:${session.userId}`, 40); const input = change.parse(await readJson(request)); return json(await updateOneshotDraft(id, input.draft, input.expectedRevision, session)); }
      if (request.method === 'DELETE') { rateLimit(`oneshot:edit:${session.userId}`, 40); const input = expected.parse(await readJson(request)); return json(await archiveOneshotDraft(id, input.expectedRevision, session)); }
    }
    if (segments.length === 3 && operation === 'prepare' && request.method === 'POST') {
      rateLimit(`oneshot:prepare:${session.userId}`, 4, 3600000);
      const input = expected.parse(await readJson(request));
      return json(await prepareOneshotDraft(id, input.expectedRevision, session, apiOrigin(request.nextUrl.origin)));
    }
  }
  throw new ApiError(404, 'NOT_FOUND', 'API resource not found.');
});
