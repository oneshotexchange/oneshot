import { api, json, readJson, rateLimit } from '../../../../lib/server/http';
import { requireSession } from '../../../../lib/server/auth';
import { ownerDrafts, saveDraft } from '../../../../lib/server/drafts';
export const GET=api(async request=>json({items:await ownerDrafts((await requireSession(request)).address)}));
export const POST=api(async request=>{const {address}=await requireSession(request);rateLimit(`draft:${address}`,5);return json(await saveDraft(await readJson(request),address),201);});
