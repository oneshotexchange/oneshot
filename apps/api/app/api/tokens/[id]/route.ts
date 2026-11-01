import { api, ApiError } from '../../../../lib/server/http';
export const GET = api(async () => { throw new ApiError(404,'TOKEN_MARKET_UNAVAILABLE','No live B20 token market is available until Hyperion verification passes.'); });
