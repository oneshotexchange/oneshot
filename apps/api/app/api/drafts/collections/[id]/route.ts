import { api, json } from '../../../../../lib/server/http';
import { requireSession } from '../../../../../lib/server/auth';
import { ownedDraft } from '../../../../../lib/server/drafts';
export const GET=api(async(request,context)=>json(await ownedDraft((await context.params).id,(await requireSession(request)).address)));
