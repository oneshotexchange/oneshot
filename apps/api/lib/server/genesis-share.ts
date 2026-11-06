import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { type NextRequest } from 'next/server';
import { genesis } from './genesis-service';
import { apiOrigin, webOrigin } from './origins';

const escape = (value: string) => value.replace(/[&<>"']/g, letter => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[letter]!));
const cache = new Map<string, Buffer>();
async function avatar(url: string | null) {
  if (!url) return null;
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== 'pbs.twimg.com' || target.username || target.password || target.port) return null;
    const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return null;
    const reader = response.body?.getReader(); if (!reader) return null;
    const chunks: Buffer[] = []; let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 512 * 1024) { await reader.cancel(); return null; } chunks.push(Buffer.from(part.value)); }
    return await sharp(Buffer.concat(chunks), { limitInputPixels: 16_000_000 }).rotate().resize(84,84).png().toBuffer();
  } catch { return null; }
}

export async function genesisShareResponse(request: NextRequest, code: string, image: boolean) {
  const publicProfile = await genesis.shareProfile(code);
  const version = createHash('sha256').update(JSON.stringify(publicProfile)).digest('hex').slice(0, 16);
  const site = webOrigin('http://127.0.0.1:3000');
  const destination = `${site}/whitelist?ref=${code}`;
  if (image) {
    const headers = { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (request.method === 'HEAD') return new Response(null, { headers });
    const cacheKey = createHash('sha256').update(JSON.stringify(publicProfile)).digest('hex');
    let result = cache.get(cacheKey);
    if (!result) {
      const profileImage = await avatar(publicProfile?.profile.avatarUrl || null);
      const title = publicProfile ? publicProfile.status : 'The first edition';
      const handle = publicProfile ? `@${publicProfile.profile.username}` : '750 Genesis free-mint places';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#ece9df"/><rect x="28" y="28" width="1144" height="574" rx="2" fill="none" stroke="#1b2825"/><path d="M48 154H1152M800 48V582" stroke="#1b2825"/><text x="62" y="107" font-family="sans-serif" font-size="37" font-weight="bold" fill="#142b24">oneshot</text><text x="843" y="104" font-family="monospace" font-size="20" fill="#142b24">GENESIS / 01</text><text x="60" y="294" font-family="sans-serif" font-size="99" font-weight="bold" letter-spacing="-6" fill="#142b24">The first</text><text x="60" y="403" font-family="serif" font-style="italic" font-size="108" fill="#142b24">edition.</text><text x="${profileImage ? 170 : 63}" y="506" font-family="sans-serif" font-size="26" font-weight="bold" fill="#142b24">${escape(title)}</text><text x="${profileImage ? 170 : 63}" y="542" font-family="sans-serif" font-size="23" fill="#53665d">${escape(handle)}</text><g transform="translate(834 202)"><path d="M0 0H282V62H0ZM38 96H282V158H38ZM81 192H282V254H81Z" fill="#235c49"/><path d="M0 285H282" stroke="#142b24"/><text x="0" y="324" font-family="monospace" font-size="17" fill="#142b24">A PLACE TO BEGIN.</text></g></svg>`;
      let render = sharp(Buffer.from(svg));
      if (profileImage) render = render.composite([{ input: profileImage, left: 63, top: 466 }]);
      result = await render.png().toBuffer();
      if (cache.size >= 64) cache.delete(cache.keys().next().value!); cache.set(cacheKey, result);
    }
    return new Response(new Uint8Array(result), { headers });
  }
  const imageUrl = `${apiOrigin(request.nextUrl.origin)}/api/oneshot/genesis/share/${code}/image?v=${version}`;
  const title = publicProfile ? `${publicProfile.profile.username} · ${publicProfile.status}` : 'oneshot Genesis · The first edition';
  const description = 'Apply for a Genesis free-mint place. 750 selected recipients, with a reserve list. Network fees may apply when minting opens.';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><meta name="description" content="${escape(description)}"><meta property="og:type" content="website"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:image" content="${escape(imageUrl)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:url" content="${escape(`${site}/g/${code}`)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escape(title)}"><meta name="twitter:image" content="${escape(imageUrl)}"><link rel="canonical" href="${escape(destination)}"><style>body{background:#ece9df;color:#142b24;font:18px system-ui;margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:1000px;padding:32px}img{width:100%;border:1px solid #142b24}h1{font-size:40px;letter-spacing:-2px}p{line-height:1.7;max-width:650px}a{display:inline-block;margin:20px 0;padding:16px 24px;background:#235c49;color:white;text-decoration:none}</style></head><body><main><img src="${escape(imageUrl)}" alt="oneshot Genesis invitation"><h1>${escape(title)}</h1><p>${escape(description)}</p><a href="${escape(destination)}">Continue to Genesis →</a></main></body></html>`;
  return new Response(request.method === 'HEAD' ? null : html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src https: http://127.0.0.1:3001; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' } });
}
