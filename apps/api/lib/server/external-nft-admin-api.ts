import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { adminAuthenticator } from './admin-auth';
import { externalNftImportDecisionSchema } from '../../../web/lib/external-nft-import';
import { externalNftAdmission, reviewedNftImports } from './external-nft-admission';
import { boundedBody, json, rateLimit, ApiError } from './http';

const expected = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const readBody = async (request: NextRequest, limit: number) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(request, limit)));
/** Standalone authorization is intentional: imports cannot expose this queue via an account session. */
export function createExternalNftAdminApi(dependencies: {
  imports?: typeof reviewedNftImports;
  admission?: typeof externalNftAdmission;
  authenticate?: typeof adminAuthenticator.requireSession;
} = {}) {
  const imports = dependencies.imports ?? reviewedNftImports, admission = dependencies.admission ?? externalNftAdmission;
  return async (request: NextRequest) => {
    (dependencies.authenticate ?? adminAuthenticator.requireSession)(request);
    rateLimit('oneshot:external-nfts:admin', request.method === 'GET' ? 120 : 20);
    const path = request.nextUrl.pathname.replace(/\/$/, ''), prefix = '/api/admin/external-nfts/imports';
    if (path === prefix && request.method === 'GET') {
      const query = request.nextUrl.searchParams;
      for (const key of query.keys()) if (!['limit', 'cursor'].includes(key) || query.getAll(key).length !== 1) throw new ApiError(400, 'EXTERNAL_IMPORT_INPUT_INVALID', 'Choose one review queue page.');
      const limit = query.get('limit');
      if (limit !== null && !/^[1-9]\d?$/.test(limit)) throw new ApiError(400, 'EXTERNAL_IMPORT_INPUT_INVALID', 'Choose a valid review page size.');
      return json(await imports.adminList({ ...(limit === null ? {} : { limit: Number(limit) }), ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}) }));
    }
    const match = /^\/api\/admin\/external-nfts\/imports\/([^/]+)(?:\/(review|permit|validate-permit))?$/.exec(path);
    if (!match || !z.string().uuid().safeParse(match[1]).success || request.nextUrl.search) throw new ApiError(404, 'NOT_FOUND', 'Collection review action not found.');
    const [, id, operation] = match;
    if (request.method === 'GET' && !operation) return json(await imports.adminRead(id));
    if (request.method === 'POST' && operation === 'review') {
      const input = externalNftImportDecisionSchema.extend({ expectedRevision: expected }).strict().parse(await readBody(request, 40_960));
      if (input.decision === 'review-approved' && !input.operatorEvidence.trim()) throw new ApiError(400, 'EXTERNAL_REVIEW_EVIDENCE_REQUIRED', 'Record the collection review evidence before approval.');
      const { expectedRevision, ...decision } = input;
      const actor = 'admin:' + createHash('sha256').update(request.headers.get('authorization') ?? '').digest('hex').slice(0, 16);
      return json(await imports.review(id, expectedRevision, decision, actor));
    }
    if (request.method === 'POST' && operation === 'permit') {
      const input = z.object({ expectedRevision: expected }).strict().parse(await readBody(request, 1024));
      return json(await admission.prepare(id, input.expectedRevision));
    }
    if (request.method === 'POST' && operation === 'validate-permit') return json(await admission.validate(id, await readBody(request, 24_576)));
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use the collection review queue controls.');
  };
}
export const externalNftAdminApi = createExternalNftAdminApi();
