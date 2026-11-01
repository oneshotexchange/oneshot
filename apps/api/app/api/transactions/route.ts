import { api, json, readJson, rateLimit, ApiError } from '../../../lib/server/http';
import { session } from '../../../lib/server/auth';
import { transactionSchema, buildTransaction } from '../../../lib/server/transactions';
export const POST=api(async request=>{const input=await readJson(request);if(['launch_token','trade','process_fees'].includes(input.action))throw new ApiError(503,'HYPERION_NOT_VERIFIED','Token execution is gated until a deployed Hyperion testnet integration passes verification.');const parsed=transactionSchema.parse(input);rateLimit(`tx:${parsed.sender}`,30);return json(await buildTransaction(parsed,(await session(request))?.address));});
