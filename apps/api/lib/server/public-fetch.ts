import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { ApiError } from './errors';

export function isPublicIpv4(address: string) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
}
export function canonicalPublicUrl(input: string) {
  if (input.startsWith('ipfs://')) input = `https://ipfs.io/ipfs/${input.slice(7).replace(/^ipfs\//, '')}`;
  let url: URL;
  try { url = new URL(input); } catch { throw new ApiError(400, 'INVALID_URL', 'Provide a valid HTTPS or IPFS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hostname === 'localhost') throw new ApiError(400, 'UNSAFE_URL', 'Only public HTTPS or IPFS resources are supported.');
  return url;
}
const importTimeout = () => new ApiError(504, 'IMPORT_TIMEOUT', 'The public resource exceeded its import deadline.');
/** An absolute deadline includes DNS, redirects and the body, even while bytes keep arriving. */
export async function fetchPublicResource(input: string, maximum = 5 * 1024 * 1024, options: { signal?: AbortSignal } = {}): Promise<{ buffer: Buffer; contentType: string }> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(cancel, 12_000);
  const aborted = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) reject(importTimeout());
    else controller.signal.addEventListener('abort', () => reject(importTimeout()), { once: true });
  });
  try { return await Promise.race([fetchPublicResourceHop(input, maximum, 0, controller.signal), aborted]); }
  catch (error) {
    if (controller.signal.aborted) throw importTimeout();
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'IMPORT_FAILED', 'The public resource could not be imported.');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}
async function fetchPublicResourceHop(input: string, maximum: number, redirects: number, signal: AbortSignal): Promise<{ buffer: Buffer; contentType: string }> {
  if (signal.aborted) throw importTimeout();
  const url = canonicalPublicUrl(input);
  const addresses = await lookup(url.hostname, { family: 4, all: true });
  if (signal.aborted) throw importTimeout();
  if (!addresses.length || addresses.some(a => !isPublicIpv4(a.address))) throw new ApiError(400, 'UNSAFE_URL', 'The URL must resolve to a public Internet address.');
  const result = await new Promise<{ buffer: Buffer; contentType: string; redirect?: string }>((resolve, reject) => {
    const req = request(url, { method: 'GET', signal, timeout: 12_000, lookup: ((_host: string, options: any, callback: Function) => options?.all ? callback(null, [{ address: addresses[0].address, family: 4 }]) : callback(null, addresses[0].address, 4)) as any, headers: { Accept: 'application/json,image/*', 'User-Agent': 'oneshot-Metadata-Snapshot/0.2', 'Accept-Encoding': 'identity' } }, response => {
      if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) { response.resume(); resolve({ buffer: Buffer.alloc(0), contentType: '', redirect: new URL(response.headers.location, url).href }); return; }
      if (response.statusCode !== 200) { response.resume(); reject(new ApiError(400, 'IMPORT_FAILED', `The remote resource returned HTTP ${response.statusCode}.`)); return; }
      if (Number(response.headers['content-length'] || 0) > maximum) { response.destroy(); reject(new ApiError(413, 'RESOURCE_TOO_LARGE', 'The remote resource exceeds the size limit.')); return; }
      let bytes = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maximum) { response.destroy(); reject(new ApiError(413, 'RESOURCE_TOO_LARGE', 'The remote resource exceeds the size limit.')); } else chunks.push(chunk); });
      response.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: String(response.headers['content-type'] || '').split(';')[0] }));
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Remote resource timed out')));
    req.on('error', reject); req.end();
  });
  if (result.redirect) { if (redirects >= 3) throw new ApiError(400, 'TOO_MANY_REDIRECTS', 'The resource redirects too many times.'); return fetchPublicResourceHop(result.redirect, maximum, redirects + 1, signal); }
  return result;
}
