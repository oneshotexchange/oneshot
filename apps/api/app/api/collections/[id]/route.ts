import { api, json } from '../../../../lib/server/http';
import { collectionDetail } from '../../../../lib/server/read-model';
export const GET = api(async (_request,context) => json(await collectionDetail((await context.params).id)));
