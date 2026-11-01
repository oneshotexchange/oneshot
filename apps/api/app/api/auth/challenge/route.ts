import { api, json, readJson, rateLimit } from '../../../../lib/server/http';
import { createChallenge } from '../../../../lib/server/auth';
import { normalizeAddress } from '../../../../lib/server/config';
import { z } from 'zod';
export const POST=api(async request=>{const {address}=z.object({address:z.string()}).parse(await readJson(request));const owner=normalizeAddress(address);rateLimit(`auth:${owner}`,5);return json(await createChallenge(owner,process.env.NEXT_PUBLIC_APP_URL||request.nextUrl.origin));});
