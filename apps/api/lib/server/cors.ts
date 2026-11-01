import type { NextRequest } from 'next/server';
import { ApiError } from './errors';
import { webOrigin } from './origins';

const methods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
const allowedHeaders = new Set(['authorization', 'content-type']);

/** Bearer authentication only: allow exactly the configured web origin, without cookies. */
export function corsHeaders(request: NextRequest): Headers {
  const headers = new Headers({ Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
  const supplied = request.headers.get('origin');
  if (!supplied) return headers;
  const expected = webOrigin(request.nextUrl.origin);
  if (supplied !== expected) throw new ApiError(403, 'ORIGIN_MISMATCH', 'This request must originate from oneshot.');
  headers.set('Access-Control-Allow-Origin', expected);
  return headers;
}

export function preflight(request: NextRequest, headers: Headers): Response {
  const supplied = request.headers.get('origin');
  const method = request.headers.get('access-control-request-method');
  if (!supplied || !method || !methods.includes(method.toUpperCase())) {
    throw new ApiError(403, 'CORS_METHOD_FORBIDDEN', 'This browser request method is unavailable.');
  }
  const requested = request.headers.get('access-control-request-headers') || '';
  if (requested.split(',').some(value => value.trim() && !allowedHeaders.has(value.trim().toLowerCase()))) {
    throw new ApiError(403, 'CORS_HEADERS_FORBIDDEN', 'This browser request contains unsupported headers.');
  }
  headers.set('Access-Control-Allow-Methods', methods.join(', '));
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Access-Control-Max-Age', '600');
  headers.set('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 204, headers });
}

export function withCors(response: Response, cors: Headers): Response {
  const headers = new Headers(response.headers);
  const vary = new Set((headers.get('Vary') || '').split(',').map(value => value.trim()).filter(Boolean));
  for (const value of (cors.get('Vary') || '').split(',')) if (value.trim()) vary.add(value.trim());
  cors.forEach((value, key) => { if (key.toLowerCase() !== 'vary') headers.set(key, value); });
  headers.set('Vary', [...vary].join(', '));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
