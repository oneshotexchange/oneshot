import { z } from 'zod';
import { api, json, readJson, rateLimit, boundedBody } from './http';
import { ApiError } from './errors';
import { requireOneshotSession } from './oneshot-auth';
import { archiveOneshotDraft, createOneshotDraft, getOneshotDraft, listOneshotDrafts, prepareOneshotDraft, readOneshotMetadata, updateOneshotDraft } from './oneshot-drafts';
import { storeImage } from './media';
import { apiOrigin, webOrigin } from './origins';
import { analyticsStore, hashVisitorId } from './analytics-store';
import { indexedNftRead } from './indexed-nfts';
import { indexedTokenRead } from './indexed-tokens';
import { tokenAnalyticsRead } from './token-analytics';
import { nftLaunch } from './nft-launch';
import { genesisApi } from './genesis-api';
import { airdropApi } from './airdrop-api';
import { tokenExecutionApi } from './token-execution-api';
import { walletProfilesApi } from './wallet-profiles';
import { walletFollowingApi } from './wallet-following';
import { createExternalNftImportsApi } from './external-nft-imports';
import { reviewedNftImports } from './external-nft-admission';
import { reviewedNftGateway } from './reviewed-nft-gateway';
import { reviewedNftRead } from './reviewed-nft-read';
import { reviewedNftExecutionApi } from './reviewed-nft-execution-api';
import { archiveTokenAccountDraft, createTokenAccountDraft, getTokenAccountDraft, listTokenAccountDrafts, updateTokenAccountDraft } from './token-account-drafts';

const revision = z.number().int().positive();
const change = z.object({ expectedRevision: revision, draft: z.unknown() }).strict();
const expected = z.object({ expectedRevision: revision }).strict();
const externalNftImportsApi = createExternalNftImportsApi(reviewedNftImports);
export const oneshotApi = api(async request => {
  const prefix = '/api/oneshot/';
  if (!request.nextUrl.pathname.startsWith(prefix)) throw new ApiError(404, 'NOT_FOUND', 'API resource not found.');
  const segments = request.nextUrl.pathname.slice(prefix.length).replace(/\/$/,'').split('/');
  const [resource, id, operation, extra] = segments;
  if (resource === 'reviewed-execution') return reviewedNftExecutionApi(request);
  if (resource === 'reviewed-nfts') { rateLimit('oneshot:reviewed-nfts:public', 20); return reviewedNftRead(request); }
  if (resource === 'external-nfts') {
    if (segments.length === 2 && id === 'config' && request.method === 'GET' && !request.nextUrl.search) {
      rateLimit('oneshot:external-nfts:config', 20);
      return json(await reviewedNftGateway.configuration());
    }
    return externalNftImportsApi(request);
  }
  if (resource === 'genesis') return genesisApi(request);
  if (resource === 'airdrop') return airdropApi(request);
  if (resource === 'analytics' && segments.length === 2 && id === 'visit' && request.method === 'POST') {
    if (request.headers.get('origin') !== webOrigin(request.nextUrl.origin)) {
      throw new ApiError(403, 'ORIGIN_MISMATCH', 'This request must originate from oneshot.');
    }
    const body = JSON.parse(new TextDecoder().decode(await boundedBody(request, 1024)));
    const input = z.object({
      visitorId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
      path: z.string().min(1).max(256),
    }).strict().parse(body);
    rateLimit('oneshot:analytics:visit:global', 600, 60_000);
    rateLimit(`oneshot:analytics:visit:${hashVisitorId(input.visitorId)}`, 30, 60_000);
    const result = await analyticsStore.recordVisit(input.visitorId, input.path);
    return json({ ok: true, recorded: result.recorded });
  }
  if (resource === 'profiles') return walletProfilesApi(request);
  if (resource === 'following') return walletFollowingApi(request);
  if (resource === 'token-execution') return tokenExecutionApi(request);
  if (resource === 'launch' && segments.length === 2 && id === 'status' && request.method === 'GET') {
    rateLimit('oneshot:launch:status', 60);
    const status = await nftLaunch.status();
    return json({ ...status, reason: status.enabled ? null : 'Collection launches are currently unavailable. You can save a draft and return later.' });
  }
  if (resource === 'launch' && segments.length === 3 && id === 'collections' && request.method === 'GET') {
    rateLimit('oneshot:launch:collections',120);
    return json(await nftLaunch.collection(operation));
  }
  if(resource==='launch'&&segments.length===2&&id==='offers'&&request.method==='GET'){
    rateLimit('oneshot:launch:offers',30);
    const query=request.nextUrl.searchParams;
    for(const key of query.keys())if(query.getAll(key).length!==1)throw new ApiError(400,'INVALID_INPUT','Use one value for each offer filter.');
    return json(await nftLaunch.offers(Object.fromEntries(query)));
  }
  if (resource === 'indexed') {
    let decoded:string[];
    try{decoded=segments.map(decodeURIComponent);}catch{throw new ApiError(400,'INVALID_INPUT','Check the collection address and item filters.');}
    if(decoded.length===4&&decoded[1]==='collections'&&decoded[3]==='explore')rateLimit('oneshot:indexed:explore',20);
    // Public reads still have a process-wide budget before manifest/RPC/database work.
    rateLimit('oneshot:indexed:public', 240);
    return indexedNftRead(request);
  }
  if(resource==='token-indexed'){
    rateLimit('oneshot:token-indexed:public',240);
    return indexedTokenRead(request);
  }
  if(resource==='token-analytics'){
    rateLimit('oneshot:token-analytics:public',120);
    return tokenAnalyticsRead(request);
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
  if (resource === 'token-drafts') {
    rateLimit(`oneshot:token-drafts:${session.userId}`, request.method === 'GET' ? 120 : 30);
    if (segments.length === 1 && request.method === 'GET') return json({ items: await listTokenAccountDrafts(session) });
    const body = async () => JSON.parse(new TextDecoder().decode(await boundedBody(request, 16384)));
    if (segments.length === 1 && request.method === 'POST') return json(await createTokenAccountDraft(await body(), session), 201);
    if (segments.length === 2) {
      if (request.method === 'GET') return json(await getTokenAccountDraft(id, session));
      if (request.method === 'PUT') { const input = change.parse(await body()); return json(await updateTokenAccountDraft(id, input.draft, input.expectedRevision, session)); }
      if (request.method === 'DELETE') { const input = expected.parse(await body()); return json(await archiveTokenAccountDraft(id, input.expectedRevision, session)); }
    }
  }
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
