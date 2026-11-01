import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readMedia } from './media';

const mocks = vi.hoisted(() => ({ getRecord: vi.fn(), send: vi.fn() }));
vi.mock('./store', () => ({
  dataRoot: () => process.env.ONESHOT_DATA_DIR!,
  getRecord: mocks.getRecord,
  reserveMedia: vi.fn(),
}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = mocks.send; },
  GetObjectCommand: class { constructor(public input: unknown) {} },
  PutObjectCommand: class { constructor(public input: unknown) {} },
}));

const base = resolve('.local/media-read-tests');
let directory = '';
const idFor = (buffer: Buffer, extension = 'json') => `${createHash('sha256').update(buffer).digest('hex')}.${extension}`;
const recordFor = (buffer: Buffer, mimeType = 'application/json') => ({ mimeType, size: buffer.length });
async function asset(buffer: Buffer, extension = 'json') {
  const id = idFor(buffer, extension);
  await writeFile(join(directory, 'media', id), buffer);
  return id;
}

beforeEach(async () => {
  directory = '';
  await mkdir(base, { recursive: true });
  directory = await mkdtemp(join(base, 'case-'));
  await mkdir(join(directory, 'media'));
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('ONESHOT_DATA_DIR', directory);
  vi.stubEnv('S3_BUCKET', '');
  mocks.getRecord.mockReset().mockRejectedValue(new Error('The injected media record must avoid the global store.'));
  mocks.send.mockReset();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (!directory) return;
  const target = resolve(directory);
  if (dirname(target) !== base || !basename(target).startsWith('case-')) throw new Error('Unexpected media-test cleanup path.');
  await rm(target, { recursive: true, force: true });
});

describe('bounded content-addressed media reads', () => {
  it('reads real local JSON at the exact byte limit using only its injected media record', async () => {
    const buffer = Buffer.from(JSON.stringify({ name: 'Committed original', description: 'Frozen public metadata.' }));
    const id = await asset(buffer);
    const record = vi.fn(async () => recordFor(buffer));
    await expect(readMedia(id, { record, maximumBytes: buffer.length })).resolves.toEqual({ buffer, mimeType: 'application/json' });
    expect(record).toHaveBeenCalledExactlyOnceWith(id);
    expect(mocks.getRecord).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('preserves actual WebP bytes and the MIME type established by the asset ID', async () => {
    const buffer = await sharp({ create: { width: 2, height: 3, channels: 4, background: { r: 87, g: 230, b: 193, alpha: 1 } } }).webp().toBuffer();
    const id = await asset(buffer, 'webp');
    const result = await readMedia(id, { record: async () => recordFor(buffer, 'image/webp') });
    expect(result).toEqual({ buffer, mimeType: 'image/webp' });
    expect(await sharp(result.buffer).metadata()).toMatchObject({ format: 'webp', width: 2, height: 3 });
    expect(mocks.getRecord).not.toHaveBeenCalled();
  });

  it('rejects corrupted bytes even when the stored size and MIME are plausible', async () => {
    const original = Buffer.from('{"name":"Original"}');
    const id = await asset(original);
    await writeFile(join(directory, 'media', id), Buffer.from('{"name":"Replaced"}'));
    await expect(readMedia(id, { record: async () => recordFor(original) })).rejects.toMatchObject({ status: 503, code: 'CONTENT_INTEGRITY' });
  });

  it.each([
    { mimeType: 'image/webp', size: 4 },
    { mimeType: 'application/json', size: 17 },
    { mimeType: 'application/json', size: -1 },
    { mimeType: 'application/json', size: 1.5 },
    { mimeType: 'application/json', size: '4' },
    { size: 4 },
    'malformed record',
  ])('rejects invalid MIME or size before opening the asset: %j', async record => {
    // No such file exists: CONTENT_INTEGRITY, rather than ENOENT, proves that
    // invalid record metadata is rejected before starting the local stream.
    await expect(readMedia(idFor(Buffer.from('missing')), { record: async () => record, maximumBytes: 16 })).rejects.toMatchObject({ status: 503, code: 'CONTENT_INTEGRITY' });
  });

  it.each([{}, { size: 1 }])('bounds actual local bytes when stored metadata omits or understates size: %j', async value => {
    const buffer = Buffer.alloc(130_000, 123);
    const id = await asset(buffer);
    await expect(readMedia(id, { record: async () => ({ mimeType: 'application/json', ...value }), maximumBytes: 100_000 })).rejects.toMatchObject({ status: 503, code: 'CONTENT_INTEGRITY' });
  });

  it('leaves JSON parsing to the content resolver while preserving valid byte identity', async () => {
    const buffer = Buffer.from('{not valid JSON');
    const id = await asset(buffer);
    await expect(readMedia(id, { record: async () => recordFor(buffer) })).resolves.toEqual({ buffer, mimeType: 'application/json' });
  });

  it('rejects an unknown record and propagates a missing local file for resolver fallback', async () => {
    const id = idFor(Buffer.from('not stored'));
    await expect(readMedia(id, { record: async () => null })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(readMedia(id, { record: async () => ({ mimeType: 'application/json' }) })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.getRecord).not.toHaveBeenCalled();
  });

  it.each(['local', 'S3'])('skips %s asset I/O when the supplied signal is already aborted', async storage => {
    vi.stubEnv('S3_BUCKET', storage === 'S3' ? 'isolated-test-media' : '');
    const controller = new AbortController();
    controller.abort();
    // The record is already available to the caller, but no file is created and
    // no object response is configured. Neither asset read may begin.
    await expect(readMedia(idFor(Buffer.from('not stored')), {
      record: async () => ({ mimeType: 'application/json' }), signal: controller.signal,
    })).rejects.toMatchObject({ status: 503, code: 'CONTENT_READ_TIMEOUT' });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.getRecord).not.toHaveBeenCalled();
  });

  it.each(['../state.json', `${'a'.repeat(64)}.svg`, `${'A'.repeat(64)}.json`])('rejects invalid IDs before any record or object lookup: %s', async id => {
    const record = vi.fn();
    await expect(readMedia(id, { record })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(record).not.toHaveBeenCalled();
    expect(mocks.getRecord).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, 5 * 1024 * 1024 + 1])('rejects an invalid caller byte limit: %s', async maximumBytes => {
    await expect(readMedia(idFor(Buffer.from('{}')), { record: async () => ({ mimeType: 'application/json' }), maximumBytes })).rejects.toThrow('Invalid media read limit');
  });
});

describe('bounded S3 response bodies without external access', () => {
  beforeEach(() => { vi.stubEnv('S3_BUCKET', 'isolated-test-media'); });

  it('reads streamed bytes at the limit and supplies an abort signal to the object request', async () => {
    const buffer = Buffer.from('{"name":"Streamed original"}');
    const id = idFor(buffer);
    mocks.send.mockResolvedValue({ ContentLength: buffer.length, Body: Readable.from([buffer.subarray(0, 8), buffer.subarray(8)]) });
    await expect(readMedia(id, { record: async () => recordFor(buffer), maximumBytes: buffer.length })).resolves.toEqual({ buffer, mimeType: 'application/json' });
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ input: { Bucket: 'isolated-test-media', Key: `assets/${id}` } }), expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    expect(mocks.send.mock.calls[0][1].abortSignal.aborted).toBe(false);
    expect(mocks.getRecord).not.toHaveBeenCalled();
  });

  it('destroys a stalled returned body and releases the read when its supplied signal aborts', async () => {
    const controller = new AbortController();
    let beganRead!: () => void;
    const readingBody = new Promise<void>(resolve => { beganRead = resolve; });
    // Headers have already arrived. This body deliberately never produces a
    // chunk or EOF, so aborting only the SDK request cannot finish this read.
    const body = new Readable({ read() { beganRead(); } });
    const destroy = vi.spyOn(body, 'destroy');
    const closed = new Promise<void>(resolve => { body.once('close', resolve); });
    mocks.send.mockResolvedValue({ Body: body });
    const reading = readMedia(idFor(Buffer.from('{}')), {
      record: async () => ({ mimeType: 'application/json' }), signal: controller.signal,
    });
    const rejected = expect(reading).rejects.toMatchObject({ status: 503, code: 'CONTENT_READ_TIMEOUT' });
    try {
      await readingBody;
      expect(mocks.send.mock.calls[0][1].abortSignal).toBe(controller.signal);
      controller.abort();
      await rejected;
      await closed;
      expect(body.destroyed).toBe(true);
      expect(destroy).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONTENT_READ_TIMEOUT' }));
    } finally {
      controller.abort();
      body.destroy();
    }
  });

  it('rejects oversized ContentLength and destroys the body before reading it', async () => {
    const iterator = vi.fn(async function* () { yield Buffer.from('{}'); });
    const destroy = vi.fn();
    mocks.send.mockResolvedValue({ ContentLength: 17, Body: { [Symbol.asyncIterator]: iterator, destroy } });
    await expect(readMedia(idFor(Buffer.from('{}')), { record: async () => ({ mimeType: 'application/json' }), maximumBytes: 16 })).rejects.toMatchObject({ status: 503, code: 'CONTENT_INTEGRITY' });
    expect(destroy).toHaveBeenCalledOnce();
    expect(iterator).not.toHaveBeenCalled();
  });

  it.each([undefined, 1])('stops and closes an oversized stream despite absent or understated ContentLength: %s', async ContentLength => {
    let closed = false;
    const trailingRead = vi.fn();
    const body = (async function* () {
      try {
        yield Buffer.alloc(10, 123);
        yield Buffer.alloc(10, 125);
        trailingRead();
        yield Buffer.alloc(10);
      } finally { closed = true; }
    })();
    mocks.send.mockResolvedValue({ ContentLength, Body: body });
    await expect(readMedia(idFor(Buffer.from('{}')), { record: async () => ({ mimeType: 'application/json' }), maximumBytes: 16 })).rejects.toMatchObject({ status: 503, code: 'CONTENT_INTEGRITY' });
    expect(closed).toBe(true);
    expect(trailingRead).not.toHaveBeenCalled();
  });

  it('treats a missing object body as unavailable and rejects corrupted object bytes', async () => {
    const buffer = Buffer.from('{"name":"Original"}');
    const options = { record: async () => recordFor(buffer) };
    mocks.send.mockResolvedValueOnce({});
    await expect(readMedia(idFor(buffer), options)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    mocks.send.mockResolvedValueOnce({ Body: Readable.from([Buffer.from('{"name":"Replaced"}')]) });
    await expect(readMedia(idFor(buffer), options)).rejects.toMatchObject({ status: 503, code: 'CONTENT_INTEGRITY' });
  });
});
