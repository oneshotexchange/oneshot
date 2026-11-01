import { NextResponse, type NextRequest } from 'next/server';
import { corsHeaders, preflight, withCors } from './lib/server/cors';
import { ApiError } from './lib/server/errors';

/** Also applies CORS to framework-generated 404/405/error responses. */
export function proxy(request: NextRequest) {
  let headers = new Headers({ Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
  try {
    headers = corsHeaders(request);
    if (request.method === 'OPTIONS') return preflight(request, headers);
    const response = NextResponse.next();
    headers.forEach((value, key) => response.headers.set(key, value));
    return response;
  } catch (error) {
    const known = error instanceof ApiError;
    return withCors(NextResponse.json({ error: {
      code: known ? error.code : 'SERVICE_UNAVAILABLE',
      message: known ? error.message : 'The service could not complete this request.',
    } }, { status: known ? error.status : 503, headers: { 'Cache-Control': 'no-store' } }), headers);
  }
}

export const config = { matcher: '/api/:path*' };
