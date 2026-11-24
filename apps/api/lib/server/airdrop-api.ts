import { z } from 'zod';
import { type NextRequest } from 'next/server';
import { ApiError, boundedBody, json, rateLimit } from './http';
import { genesisAuth } from './genesis-auth';
import { airdropService } from './airdrop-service';
import {
  airdropEnrollSchema,
  airdropEvmAddress,
  airdropVerifySchema,
  airdropWalletBindSchema,
  airdropWalletChallengeSchema,
} from '../../../web/lib/airdrop-schema';

function singleQueryParams(request: NextRequest, allowed: readonly string[]) {
  const query = request.nextUrl.searchParams;
  for (const key of query.keys()) {
    if (!allowed.includes(key) || query.getAll(key).length !== 1) {
      throw new ApiError(400, 'INVALID_INPUT', 'Unexpected or duplicate query parameters.');
    }
  }
  return query;
}

async function parseJsonBody(request: NextRequest, maximum: number): Promise<unknown> {
  const raw = new TextDecoder().decode(await boundedBody(request, maximum));
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Send a valid JSON request.');
  }
}

export async function airdropApi(request: NextRequest): Promise<Response> {
  const path = request.nextUrl.pathname.replace(/\/$/, '');
  const prefix = '/api/oneshot/airdrop/';
  const operation = path.slice(prefix.length);

  const publicRead = request.method === 'GET' || request.method === 'HEAD';
  if (operation === 'campaign' && publicRead) {
    rateLimit('airdrop:campaign', 300);
    const response = json(await airdropService.campaign());
    return request.method === 'HEAD' ? new Response(null, response) : response;
  }

  if (operation === 'eligibility' && publicRead) {
    rateLimit('airdrop:eligibility', 240);
    const query = singleQueryParams(request, ['wallet']);
    const wallet = airdropEvmAddress.parse(query.get('wallet') || '');
    const response = json(await airdropService.checkEligibility(wallet));
    return request.method === 'HEAD' ? new Response(null, response) : response;
  }

  if (operation === 'leaderboard' && publicRead) {
    rateLimit('airdrop:leaderboard', 240);
    const query = singleQueryParams(request, ['offset', 'limit']);
    const offset = z.coerce.number().int().min(0).max(500).parse(query.get('offset') ?? 0);
    const limit = z.coerce.number().int().min(1).max(100).parse(query.get('limit') ?? 50);
    const response = json(await airdropService.leaderboard(offset, limit));
    return request.method === 'HEAD' ? new Response(null, response) : response;
  }

  genesisAuth.assertWrite(request);
  let session;
  try {
    session = await genesisAuth.authenticate(request);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'GENESIS_AUTH_REQUIRED') {
      throw new ApiError(401, 'GENESIS_AUTH_REQUIRED', 'Connect X to access your airdrop box.');
    }
    throw error;
  }
  if (session.provider === 'x' && request.headers.get('X-Genesis-Session') !== session.sessionId) {
    throw new ApiError(401, 'GENESIS_AUTH_CHANGED', 'Your X sign-in changed. Refresh the page before continuing.');
  }

  rateLimit(`airdrop:account:${session.userId}`, 120);
  if (operation === 'me' && request.method === 'GET') {
    return json(await airdropService.me(session));
  }

  if (request.method === 'POST') {
    rateLimit(`airdrop:write:${session.userId}`, 20);
    const body = await parseJsonBody(request, 16_384);
    if (operation === 'enroll') {
      const input = airdropEnrollSchema.parse(body);
      return json(await airdropService.enroll(session, input.consentVersion, input.referral));
    }
    if (operation === 'wallet-challenge') {
      const input = airdropWalletChallengeSchema.parse(body);
      return json(await airdropService.walletChallenge(session, input.wallet));
    }
    if (operation === 'wallet') {
      const input = airdropWalletBindSchema.parse(body);
      return json(await airdropService.bindWallet(session, input));
    }
    if (operation === 'verify') {
      rateLimit(`airdrop:verify:${session.userId}`, 12);
      const input = airdropVerifySchema.parse(body);
      return json(await airdropService.verifyMission(session, input.task, input.postUrl));
    }
    if (operation === 'refresh-engagement') {
      rateLimit(`airdrop:refresh:${session.userId}`, 6);
      z.object({}).strict().parse(body);
      return json(await airdropService.refreshEngagement(session));
    }
  }

  throw new ApiError(404, 'NOT_FOUND', 'This airdrop action is unavailable.');
}
