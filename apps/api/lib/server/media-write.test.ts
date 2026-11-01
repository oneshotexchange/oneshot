import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeBlob } from './media';

const mocks = vi.hoisted(() => ({ reserveMedia: vi.fn(), send: vi.fn(), dataRoot: vi.fn() }));
vi.mock('./store', () => ({
  reserveMedia: mocks.reserveMedia,
  dataRoot: mocks.dataRoot,
  getRecord: vi.fn(),
}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = mocks.send; },
  PutObjectCommand: class { constructor(public input: unknown) {} },
  GetObjectCommand: class { constructor(public input: unknown) {} },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('S3_BUCKET', 'isolated-test-media');
  mocks.reserveMedia.mockReset().mockResolvedValue(undefined);
  mocks.send.mockReset();
  mocks.dataRoot.mockReset().mockImplementation(() => { throw new Error('Object storage must not fall back to local files.'); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('bounded content-addressed S3 writes', () => {
  const buffer = Buffer.from('{"name":"Stored original"}');
  const hash = createHash('sha256').update(buffer).digest('hex');
  const save = () => storeBlob(buffer, 'json', 'isolated-test-owner', 'https://api.oneshot.app');

  it('preserves exact bytes, content identity and immutable caching on success', async () => {
    mocks.send.mockResolvedValue({});
    await expect(save()).resolves.toEqual({ url: `https://api.oneshot.app/api/media/${hash}.json`, hash, mimeType: 'application/json', size: buffer.length });
    expect(mocks.reserveMedia).toHaveBeenCalledExactlyOnceWith(`${hash}.json`, expect.objectContaining({ hash, size: buffer.length, mimeType: 'application/json' }));
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ input: {
      Bucket: 'isolated-test-media', Key: `assets/${hash}.json`, Body: buffer,
      ContentType: 'application/json', CacheControl: 'public,max-age=31536000,immutable',
    } }), { abortSignal: expect.any(AbortSignal) });
    expect(mocks.send.mock.calls[0][1].abortSignal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.dataRoot).not.toHaveBeenCalled();
  });

  it('aborts and returns a retryable timeout even when a stalled transport ignores cancellation', async () => {
    mocks.send.mockImplementation(() => new Promise<never>(() => {}));
    const saving = save();
    const assertion = expect(saving).rejects.toMatchObject({ status: 503, code: 'CONTENT_WRITE_TIMEOUT', message: 'Saving content took too long. Please try again.' });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(mocks.send.mock.calls[0][1].abortSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(mocks.send.mock.calls[0][1].abortSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.dataRoot).not.toHaveBeenCalled();
  });

  it('uses the same timeout result when the SDK rejects in response to cancellation', async () => {
    mocks.send.mockImplementation((_command, { abortSignal }: { abortSignal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      abortSignal.addEventListener('abort', () => reject(new Error('SDK timeout at private-storage-endpoint')), { once: true });
    }));
    const assertion = expect(save()).rejects.toMatchObject({ status: 503, code: 'CONTENT_WRITE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(mocks.dataRoot).not.toHaveBeenCalled();
  });

  it('does not expose storage provider errors or claim an upload succeeded', async () => {
    mocks.send.mockRejectedValue(new Error('AccessDenied for private-bucket at https://private-storage-endpoint?credential=server-secret'));
    await expect(save()).rejects.toMatchObject({ status: 503, code: 'CONTENT_WRITE_UNAVAILABLE', message: 'Your content could not be saved. Please try again.' });
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.dataRoot).not.toHaveBeenCalled();
  });

  it('can retry the same content identity after a failed write without changing the reserved object', async () => {
    mocks.send.mockRejectedValueOnce(new Error('Temporary provider failure')).mockResolvedValueOnce({});
    await expect(save()).rejects.toMatchObject({ code: 'CONTENT_WRITE_UNAVAILABLE' });
    await expect(save()).resolves.toMatchObject({ hash, url: `https://api.oneshot.app/api/media/${hash}.json` });
    expect(mocks.reserveMedia.mock.calls.map(([id]) => id)).toEqual([`${hash}.json`, `${hash}.json`]);
    expect(mocks.send.mock.calls.map(([command]) => command.input.Key)).toEqual([`assets/${hash}.json`, `assets/${hash}.json`]);
    expect(mocks.dataRoot).not.toHaveBeenCalled();
  });

  it('rejects missing hosted storage before reserving quota or requesting a provider', async () => {
    vi.stubEnv('S3_BUCKET', '');
    await expect(save()).rejects.toMatchObject({ status: 503, code: 'STORAGE_REQUIRED' });
    expect(mocks.reserveMedia).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.dataRoot).not.toHaveBeenCalled();
  });
});
