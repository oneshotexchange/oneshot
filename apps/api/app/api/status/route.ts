import { api, json } from '../../../lib/server/http';
import { status } from '../../../lib/server/config';
export const GET = api(async () => json(await status()));
