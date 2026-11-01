import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { ApiError } from './errors';
import { dataRoot, reserveMedia, getRecord } from './store';

let client: S3Client | undefined;
const s3 = () => client ||= new S3Client({ region: process.env.S3_REGION || 'auto', endpoint: process.env.S3_ENDPOINT, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true', credentials: process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } : undefined });
const writeTimeout = () => new ApiError(503, 'CONTENT_WRITE_TIMEOUT', 'Saving content took too long. Please try again.');
async function writeObject(command: PutObjectCommand) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(writeTimeout()); }, 15_000);
    timer.unref();
  });
  try {
    // The deadline includes SDK retries. The race also bounds a stalled transport
    // that does not settle promptly after receiving the abort signal.
    await Promise.race([s3().send(command, { abortSignal: controller.signal }), deadline]);
  } catch {
    if (controller.signal.aborted) throw writeTimeout();
    throw new ApiError(503, 'CONTENT_WRITE_UNAVAILABLE', 'Your content could not be saved. Please try again.');
  } finally { clearTimeout(timer!); }
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function storeBlob(buffer: Buffer, extension: 'webp' | 'json', owner: string, origin: string) {
  if (buffer.length > 5 * 1024 * 1024) throw new ApiError(413, 'FILE_TOO_LARGE', 'Each asset must be 5 MiB or smaller.');
  if (!process.env.S3_BUCKET && process.env.NODE_ENV === 'production') throw new ApiError(503, 'STORAGE_REQUIRED', 'Object storage must be configured before accepting hosted uploads.');
  const hash = createHash('sha256').update(buffer).digest('hex');
  const id = `${hash}.${extension}`;
  const mimeType = extension === 'json' ? 'application/json' : 'image/webp';
  await reserveMedia(id, { hash, size: buffer.length, mimeType, owner, createdAt: new Date().toISOString() });
  if (process.env.S3_BUCKET) {
    await writeObject(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: `assets/${id}`, Body: buffer, ContentType: mimeType, CacheControl: 'public,max-age=31536000,immutable' }));
  } else {
    if (process.env.NODE_ENV === 'production') throw new ApiError(503, 'STORAGE_REQUIRED', 'Object storage must be configured before accepting hosted uploads.');
    await mkdir(resolve(dataRoot(), 'media'), { recursive: true });
    try { await writeFile(resolve(dataRoot(), 'media', id), buffer, { flag: 'wx' }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  }
  return { url: `${origin}/api/media/${id}`, hash, mimeType, size: buffer.length };
}
export async function storeImage(buffer: Buffer, owner: string, origin: string, maximumOutputBytes = 5 * 1024 * 1024) {
  if (buffer.length > 5 * 1024 * 1024) throw new ApiError(413, 'FILE_TOO_LARGE', 'Images must be 5 MiB or smaller.');
  let image: Buffer;
  try { image = await sharp(buffer, { limitInputPixels: 20_000_000, animated: false }).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer(); }
  catch { throw new ApiError(400, 'INVALID_IMAGE', 'Upload a valid PNG, JPEG, or WebP image up to 20 megapixels.'); }
  if (image.length > maximumOutputBytes) throw new ApiError(413, 'SNAPSHOT_TOO_LARGE', 'The sanitized art exceeds the remaining content batch limit.');
  return storeBlob(image, 'webp', owner, origin);
}
type MediaReadOptions = { record?: (id: string) => Promise<unknown>; maximumBytes?: number; signal?: AbortSignal };
async function boundedMediaBytes(source: AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => unknown }, maximum: number, signal: AbortSignal) {
  const timeout = () => new ApiError(503, 'CONTENT_READ_TIMEOUT', 'Stored content could not be read within its deadline.');
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => { const error = timeout(); source.destroy?.(error); reject(error); };
    signal.addEventListener('abort', abort, { once: true });
  });
  const reading = (async () => {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of source) {
      length += chunk.length;
      if (length > maximum) throw new ApiError(503, 'CONTENT_INTEGRITY', 'Stored content exceeds its read limit.');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, length);
  })();
  if (signal.aborted) abort();
  try { return await Promise.race([reading, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}
export async function readMedia(id: string, options: MediaReadOptions = {}) {
  if (!/^[a-f0-9]{64}\.(webp|json)$/.test(id)) throw new ApiError(404, 'NOT_FOUND', 'Asset not found.');
  const record = options.record ? await options.record(id) : await getRecord('media', id);
  if (!record) throw new ApiError(404, 'NOT_FOUND', 'Asset not found.');
  const maximum = options.maximumBytes ?? 5 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 5 * 1024 * 1024) throw new Error('Invalid media read limit');
  const mimeType = id.endsWith('.json') ? 'application/json' : 'image/webp';
  if (typeof record !== 'object' || !('mimeType' in record) || record.mimeType !== mimeType
    || 'size' in record && (typeof record.size !== 'number' || !Number.isSafeInteger(record.size) || record.size < 0 || record.size > maximum)) throw new ApiError(503, 'CONTENT_INTEGRITY', 'Stored content failed its integrity check.');
  const signal = options.signal ?? AbortSignal.timeout(10_000);
  if (signal.aborted) throw new ApiError(503, 'CONTENT_READ_TIMEOUT', 'Stored content could not be read within its deadline.');
  let buffer: Buffer;
  if (process.env.S3_BUCKET) {
    const object = await s3().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: `assets/${id}` }), { abortSignal: signal });
    if (!object.Body) throw new ApiError(404, 'NOT_FOUND', 'Asset not found.');
    if (object.ContentLength !== undefined && object.ContentLength > maximum) { (object.Body as { destroy?: () => void }).destroy?.(); throw new ApiError(503, 'CONTENT_INTEGRITY', 'Stored content exceeds its read limit.'); }
    buffer = await boundedMediaBytes(object.Body as AsyncIterable<Uint8Array>, maximum, signal);
  } else buffer = await boundedMediaBytes(createReadStream(resolve(dataRoot(), 'media', id), { highWaterMark: Math.min(64 * 1024, maximum + 1) }), maximum, signal);
  if (createHash('sha256').update(buffer).digest('hex') !== id.split('.')[0]) throw new ApiError(503, 'CONTENT_INTEGRITY', 'Stored content failed its integrity check.');
  return { buffer, mimeType };
}
