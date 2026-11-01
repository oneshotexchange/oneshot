import { api, json } from '../../../../../lib/server/http';
import { nftPage } from '../../../../../lib/server/read-model';
export const GET = api(async (request,context) => json(await nftPage((await context.params).id,request.nextUrl.searchParams.get('owner')||undefined,request.nextUrl.searchParams.get('cursor')||undefined)));
