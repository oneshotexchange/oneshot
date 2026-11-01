/** A deployment-controlled API origin, never a URL supplied by request data. */
export function apiUrl(path: string, configured = process.env.NEXT_PUBLIC_API_URL || ''): string {
  if (!path.startsWith('/api/') || /[\\\u0000-\u0020\u007f#]/.test(path)) throw new Error('Unsupported API destination.');
  const relative = new URL(path, 'https://relative.invalid');
  if (relative.origin !== 'https://relative.invalid' || !relative.pathname.startsWith('/api/')) throw new Error('Unsupported API destination.');
  if (!configured) {
    if (typeof window !== 'undefined' && !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) throw new Error('This service is temporarily unavailable. Please try again later.');
    return path;
  }
  let origin: URL;
  try { origin = new URL(configured); } catch { throw new Error('This service is temporarily unavailable. Please try again later.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (configured.trim() !== configured || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || !(origin.protocol === 'https:' || origin.protocol === 'http:' && loopback)) throw new Error('This service is temporarily unavailable. Please try again later.');
  return new URL(path, origin).href;
}
