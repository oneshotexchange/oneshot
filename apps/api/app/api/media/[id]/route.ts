import { api } from '../../../../lib/server/http';
import { readMedia } from '../../../../lib/server/media';
export const GET=api(async (_request,context)=>{const asset=await readMedia((await context.params).id);return new Response(new Uint8Array(asset.buffer),{headers:{'Content-Type':asset.mimeType,'Cache-Control':'public,max-age=31536000,immutable','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});});
