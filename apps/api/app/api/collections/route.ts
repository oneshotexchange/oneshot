import { api, json } from '../../../lib/server/http';
import { collectionIndex } from '../../../lib/server/read-model';
export const GET = api(async () => json({items:await collectionIndex(),nextCursor:null,indexedVersion:null}));
