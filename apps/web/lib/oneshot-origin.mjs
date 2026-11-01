/** Pure URL checks shared by status, draft validation and the snapshot service.
 * They establish configuration plausibility, not DNS reachability or origin ownership. */
export function isPublicIpv4Address(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return false;
  const [a, b, c] = parts.map(Number);
  if (parts.some(part => Number(part) > 255)) return false;
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113));
}

function publicHttpsUrl(input) {
  if (input.trim() !== input || /[\u0000-\u0020\u007f]/.test(input)) return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) return null;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  // The snapshot downloader currently supports public IPv4, not IPv6 literals.
  if (!hostname || hostname.includes(':') || hostname.startsWith('[')) return null;
  if (/^[\d.]+$/.test(hostname)) return isPublicIpv4Address(hostname) ? url : null;
  if (!hostname.includes('.') || hostname.length > 253
    || hostname.split('.').some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))) return null;
  if (['localhost', 'local', 'localdomain', 'internal', 'lan', 'home', 'test', 'invalid', 'example', 'onion']
    .some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))) return null;
  return url;
}

export function isPublicMetadataOrigin(input) {
  const url = publicHttpsUrl(input);
  return !!url && url.pathname === '/' && !url.search;
}

/** URL syntax/literal host validation; remote fetches additionally check and pin DNS. */
export function isPublicContentSource(input) {
  if (input.startsWith('ipfs://')) return /^ipfs:\/\/(?:ipfs\/)?[a-zA-Z\d]+(?:\/[^\u0000-\u0020\u007f]*)?$/.test(input);
  return publicHttpsUrl(input) !== null;
}
