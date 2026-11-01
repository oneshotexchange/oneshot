import { api, json, rateLimit, boundedBody, ApiError } from '../../../lib/server/http';
import { requireSession } from '../../../lib/server/auth';
import { storeImage } from '../../../lib/server/media';
export const POST=api(async request=>{const {address}=await requireSession(request);rateLimit(`upload:${address}`,10);const body=await boundedBody(request,6*1024*1024);const form=await new Response(body as BodyInit,{headers:{'Content-Type':request.headers.get('content-type')||''}}).formData();const file=form.get('file');if(!(file instanceof File))throw new ApiError(400,'FILE_REQUIRED','Choose an image file.');return json(await storeImage(Buffer.from(await file.arrayBuffer()),address,process.env.NEXT_PUBLIC_APP_URL||request.nextUrl.origin),201);});
