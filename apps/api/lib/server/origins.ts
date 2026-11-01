import { ApiError } from './errors';
import { isPublicMetadataOrigin } from '../../../web/lib/oneshot-origin';

type Environment = Record<string, string | undefined>;

function origin(value: string, production: boolean, code: string): string {
  const invalid = () => new ApiError(503, code, 'Configure a valid public HTTPS origin for this service.');
  if (value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw invalid();
  if (isPublicMetadataOrigin(value)) return url.origin;
  if (!production && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.origin;
  throw invalid();
}

/** The browser origin is independent of the host serving API requests and content. */
export function webOrigin(fallback?: string, env: Environment = process.env): string {
  const value = env.NEXT_PUBLIC_APP_URL || (env.NODE_ENV !== 'production' ? fallback : undefined);
  if (!value) throw new ApiError(503, 'APP_ORIGIN_REQUIRED', 'Configure the web origin before accepting browser requests.');
  return origin(value, env.NODE_ENV === 'production', 'INVALID_APP_ORIGIN');
}

/** Never freeze the Cloudflare web hostname into metadata hosted by the API. */
export function apiOrigin(fallback?: string, env: Environment = process.env): string {
  const value = env.ONESHOT_API_URL || (env.NODE_ENV !== 'production' ? fallback : undefined);
  if (!value) throw new ApiError(503, 'API_ORIGIN_REQUIRED', 'Configure the public HTTPS API origin before accepting hosted content.');
  return origin(value, env.NODE_ENV === 'production', 'INVALID_API_ORIGIN');
}

export function publicApiOriginConfigured(env: Environment = process.env): boolean {
  try { return isPublicMetadataOrigin(apiOrigin(undefined, env)); } catch { return false; }
}
