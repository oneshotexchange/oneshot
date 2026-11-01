import { api, json } from '../../../lib/server/http';
import { readiness } from '../../../lib/server/readiness';

export const GET = api(async () => {
  const result = await readiness();
  return json({ service: 'oneshot-api', ready: result.ready }, result.ready ? 200 : 503);
});
