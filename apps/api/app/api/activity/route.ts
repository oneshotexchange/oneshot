import { api, json } from '../../../lib/server/http';
import { activityIndex } from '../../../lib/server/read-model';
export const GET = api(async () => json({items:await activityIndex(),nextCursor:null,indexedVersion:null}));
