import { api, json } from '../../../../lib/server/http';
import { session } from '../../../../lib/server/auth';
export const GET=api(async request=>json(await session(request)||{address:null}));
export const DELETE=api(async()=>{const response=json({address:null});response.cookies.delete('b20_session');return response;});
