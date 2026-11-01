import { api, json } from '../../../lib/server/http';
export const GET = api(async () => json({ items: [], nextCursor: null, indexedVersion: null, gated: true, reason: 'Hyperion testnet integration is awaiting verification.' }));
