import { api, json } from '../../../lib/server/http';
export const GET = api(async () => json({ service: 'oneshot-api', status: 'ok' }));
