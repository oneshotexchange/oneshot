import { api, json, readJson, rateLimit } from '../../../../lib/server/http';
import { session } from '../../../../lib/server/auth';
import { confirmTransaction } from '../../../../lib/server/transactions';
import { z } from 'zod';
export const POST=api(async request=>{const input=z.object({hash:z.string(),draftId:z.string().optional()}).parse(await readJson(request));rateLimit(`confirm:${input.hash}`,10);return json(await confirmTransaction(input.hash,input.draftId,(await session(request))?.address));});
