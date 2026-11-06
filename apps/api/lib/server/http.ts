import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { activeNetworkResponse } from './active-network';
import { ApiError } from './errors';
import { corsHeaders, preflight, withCors } from './cors';
import { beginRequestMetric } from './request-metrics';
import { publicErrorMessage } from './public-error';

export { ApiError } from './errors';
export const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export async function boundedBody(request: Pick<Request, 'body'>, maximum = 1024 * 1024): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.length; if (total > maximum) { await reader.cancel(); throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The request exceeds the size limit.'); } chunks.push(value); }
  const result = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}
export async function readJson(request: Request) { return JSON.parse(new TextDecoder().decode(await boundedBody(request))); }
export function api(handler: (request: NextRequest, context: any) => Promise<Response>) {
  return async (request: NextRequest, context: any) => {
    const completeMetric = beginRequestMetric(request);
    let status = 503;
    let headers = new Headers({ Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    const respond = (response: Response) => { status = response.status; return withCors(response, headers); };
    try {
      headers = corsHeaders(request);
      if (request.method === 'OPTIONS') { const response = preflight(request, headers); status = response.status; return response; }
      if (!['GET', 'HEAD'].includes(request.method)) {
        const size = Number(request.headers.get('content-length') || 0);
        if (size > 7 * 1024 * 1024) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The request exceeds the upload limit.');
      }
      const migration = activeNetworkResponse(request);
      if (migration) return respond(migration);
      return respond(await handler(request, context));
    } catch (error) {
      if (error instanceof ApiError) {
        const message = request.nextUrl.pathname.startsWith('/api/admin/') ? error.message : publicErrorMessage(error.code, error.message);
        return respond(json({ error: { code: error.code, message } }, error.status));
      }
      if (error instanceof ZodError) return respond(json({ error: { code: 'INVALID_INPUT', message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') } }, 400));
      if (error instanceof SyntaxError) return respond(json({ error: { code: 'INVALID_JSON', message: 'Send a valid JSON request.' } }, 400));
      // Driver/provider errors may contain credentials, URLs or private inputs.
      // Keep unexpected-failure diagnostics independent of the error object.
      try { console.error('[oneshot API] SERVICE_UNAVAILABLE'); } catch { /* Logging must not affect the response. */ }
      return respond(json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'The service could not complete this request. Please retry.' } }, 503));
    } finally {
      completeMetric(status);
    }
  };
}

const buckets = new Map<string, { count: number; until: number }>();
export function rateLimit(key: string, maximum = 30, windowMs = 60_000) {
  const now = Date.now();
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.until < now) buckets.delete(k);
  const bucket = buckets.get(key);
  if (!bucket || bucket.until < now) { buckets.set(key, { count: 1, until: now + windowMs }); return; }
  if (++bucket.count > maximum) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment.');
}
