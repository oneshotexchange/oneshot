import { api, json, rateLimit, ApiError } from '../../../lib/server/http';
import { chainFetch, normalizeAddress } from '../../../lib/server/config';
import { nftPage } from '../../../lib/server/read-model';
import { formatUnits } from '@b20/sdk';
export const GET = api(async request => {
  const input=request.nextUrl.searchParams.get('address');
  if(!input) throw new ApiError(400,'ADDRESS_REQUIRED','Connect a wallet to view its portfolio.');
  const address=normalizeAddress(input); rateLimit(`portfolio:${address}`,30);
  const [balance]=await chainFetch('/view',{method:'POST',body:JSON.stringify({function:'0x1::coin::balance',type_arguments:['0x1::aptos_coin::AptosCoin'],arguments:[address]})});
  const page=await nftPage(undefined,address,request.nextUrl.searchParams.get('cursor')||undefined);
  return json({address,balanceApt:formatUnits(BigInt(balance)),tokens:[],nfts:page.items,nftsNextCursor:page.nextCursor,earnings:[]});
});
