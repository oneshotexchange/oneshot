import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { TokenMarketReviewError } from '@oneshot/evm';
import { tokenExecution } from './token-execution';
import { requireOneshotSession } from './oneshot-auth';
import { ApiError } from './errors';
import { boundedBody, json, rateLimit } from './http';

const validation=z.object({id:z.string().uuid(),reviewHash:z.string().regex(/^[\da-f]{64}$/)}).strict();
const receipt=z.object({id:z.string().uuid(),hash:z.string().regex(/^0x[\da-f]{64}$/).transform(value=>value as `0x${string}`)}).strict();
async function input(request:Request){return JSON.parse(new TextDecoder().decode(await boundedBody(request,16384)));}
/** Invoked inside the common CORS/error wrapper. Every account resource authenticates on the server. */
export async function tokenExecutionApi(request:NextRequest){
  const segments=request.nextUrl.pathname.slice('/api/oneshot/token-execution/'.length).replace(/\/$/,'').split('/');
  if(segments.length===1&&segments[0]==='status'&&request.method==='GET'){
    rateLimit('oneshot:token-execution:status',60);return json(await tokenExecution.status());
  }
  const session=await requireOneshotSession(request);rateLimit(`oneshot:token-execution:${session.userId}`,30);
  try{
    if(segments.length===2&&segments[0]==='reviews'&&request.method==='GET')return json(await tokenExecution.recover(z.string().uuid().parse(segments[1]),session));
    if(segments.length===1&&request.method==='POST'){
      if(segments[0]==='review')return json(await tokenExecution.review(await input(request),session),201);
      if(segments[0]==='validate'){const parsed=validation.parse(await input(request));return json(await tokenExecution.validate(parsed.id,parsed.reviewHash,session));}
      if(segments[0]==='receipt'){const parsed=receipt.parse(await input(request));return json(await tokenExecution.receipt(parsed.id,parsed.hash,session));}
    }
  }catch(error){
    if(error instanceof TokenMarketReviewError)throw new ApiError(409,`TOKEN_${error.code}`,error.message);
    if(error instanceof RangeError)throw new ApiError(400,'TOKEN_AMOUNT_INVALID','Enter a positive amount with no more than 18 decimals for test ETH or 8 decimals for this token.');
    throw error;
  }
  throw new ApiError(404,'NOT_FOUND','This token transaction resource was not found.');
}
