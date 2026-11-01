import { api, json } from '../../../../../../lib/server/http';
import { itemDetail } from '../../../../../../lib/server/read-model';
export const GET = api(async (_request,context) => { const {id,item}=await context.params; return json(await itemDetail(id,item)); });
