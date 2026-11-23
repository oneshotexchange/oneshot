import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { reviewedNftExecutionService } from './reviewed-nft-execution-service';
import { requireOneshotSession } from './oneshot-auth';
import { ApiError } from './errors';
import { boundedBody, json, rateLimit } from './http';

const digest = z.string().regex(/^[a-f0-9]{64}$/), idSchema = z.string().uuid();
const validation = z.object({ reviewHash: digest }).strict();
const submission = validation.extend({ transactionHash: z.string().regex(/^0x[\da-f]{64}$/).refine(value => !/^0x0{64}$/.test(value)).transform(value => value as `0x${string}`) }).strict();
async function input(request: Request) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(request, 16_384))); }
/** Status is public; every review and saved transaction is account-private. */
export function createReviewedNftExecutionApi(service = reviewedNftExecutionService, authenticate = requireOneshotSession) {
  return async function reviewedNftExecutionApi(request: NextRequest) {
    const prefix = '/api/oneshot/reviewed-execution/';
    if (!request.nextUrl.pathname.startsWith(prefix)) throw new ApiError(404, 'NOT_FOUND', 'This NFT transaction resource was not found.');
    const parts = request.nextUrl.pathname.slice(prefix.length).replace(/\/$/, '').split('/');
    if (parts.length === 1 && parts[0] === 'status' && request.method === 'GET') {
      if (request.nextUrl.search) throw new ApiError(400, 'INVALID_INPUT', 'Open the transaction status without extra parameters.');
      rateLimit('oneshot:reviewed-execution:status', 60); return json(await service.status());
    }
    const session = await authenticate(request); rateLimit(`oneshot:reviewed-execution:${session.userId}`, 60);
    if (parts.length === 1 && parts[0] === 'transactions' && request.method === 'GET') {
      const query = request.nextUrl.searchParams;
      for (const key of query.keys()) if (!['wallet', 'limit', 'cursor'].includes(key) || query.getAll(key).length !== 1) throw new ApiError(400, 'INVALID_INPUT', 'Use one wallet and an optional page cursor.');
      const parsed = z.object({ wallet: z.string().regex(/^0x[\da-fA-F]{40}$/).optional(), limit: z.string().regex(/^[1-9]\d?$/).transform(Number).refine(value => value <= 50).optional(), cursor: z.string().min(1).max(2048).regex(/^[\w-]+$/).optional() }).strict().parse(Object.fromEntries(query));
      return json(await service.transactions(session, parsed));
    }
    if (request.nextUrl.search) throw new ApiError(400, 'INVALID_INPUT', 'Use this transaction resource without extra parameters.');
    if (parts.length === 1 && parts[0] === 'reviews' && request.method === 'POST') return json(await service.review(await input(request), session), 201);
    if (parts[0] === 'reviews' && parts.length >= 2) {
      const id = idSchema.parse(parts[1]);
      if (parts.length === 2 && request.method === 'GET') return json(await service.recover(id, session));
      if (parts.length === 3 && request.method === 'POST') {
        if (parts[2] === 'revalidate') { const parsed = validation.parse(await input(request)); return json(await service.revalidate(id, parsed.reviewHash, session)); }
        if (parts[2] === 'submit') { const parsed = submission.parse(await input(request)); return json(await service.submit(id, parsed.reviewHash, parsed.transactionHash, session)); }
      }
    }
    throw new ApiError(404, 'NOT_FOUND', 'This NFT transaction resource was not found.');
  };
}
export const reviewedNftExecutionApi = createReviewedNftExecutionApi();
