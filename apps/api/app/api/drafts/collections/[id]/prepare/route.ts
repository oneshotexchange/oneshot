import { api, json, rateLimit } from '../../../../../../lib/server/http';
import { requireSession } from '../../../../../../lib/server/auth';
import { prepareDraft } from '../../../../../../lib/server/drafts';
export const POST=api(async(request,context)=>{const {address}=await requireSession(request);rateLimit(`prepare:${address}`,2);return json(await prepareDraft((await context.params).id,address,process.env.NEXT_PUBLIC_APP_URL||request.nextUrl.origin));});
