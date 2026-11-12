import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeBlob, readMedia } from './media';
import { beginMediaUpload, cancelMediaUpload, commitMediaUpload, getRecord, listRecords, MEDIA_UPLOAD_LEASE_MS, withLocalNamespace } from './store';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = mocks.send; },
  PutObjectCommand: class { constructor(public input: unknown) {} },
  GetObjectCommand: class { constructor(public input: unknown) {} },
}));

const root = path.resolve('.local/media-upload-lifecycle-tests');
const first = Buffer.from('{"a":1}');
const other = Buffer.from('{"b":2}');
const id = (bytes: Buffer) => `${createHash('sha256').update(bytes).digest('hex')}.json`;
const asset = { size: first.length, mimeType: 'application/json', owner: 'isolated-creator' };
let directory: string;
beforeEach(async () => {
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(path.join(root, 'case-'));
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('S3_BUCKET', 'isolated-fake-storage');
  vi.stubEnv('ONESHOT_DATA_DIR', directory);
  vi.stubEnv('ONESHOT_MEDIA_QUOTA_BYTES', String(first.length));
  mocks.send.mockReset().mockResolvedValue({});
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== root) throw new Error('Unsafe lifecycle test cleanup');
  await rm(directory, { recursive: true, force: true });
});
const save = (bytes = first) => storeBlob(bytes, 'json', 'isolated-creator', 'https://api.oneshot.app');

describe('recoverable content upload lifecycle', () => {
  it('releases quota after provider failure so different artwork can be saved', async () => {
    mocks.send.mockRejectedValueOnce(new Error('Provider refused the object'));
    await expect(save()).rejects.toMatchObject({ code: 'CONTENT_WRITE_UNAVAILABLE' });
    expect(await getRecord('media', id(first))).toBeNull();
    expect(await listRecords('media_uploads')).toEqual([]);
    await expect(save(other)).resolves.toMatchObject({ hash: id(other).split('.')[0] });
    expect((await listRecords('media')).map(value => value.hash)).toEqual([id(other).split('.')[0]]);
  });

  it('does not expose pending metadata or let one failed duplicate cancel a successful writer', async () => {
    let entered!: () => void, failFirst!: (error: Error) => void, finishSecond!: (value: unknown) => void;
    const firstEntered = new Promise<void>(resolve => { entered = resolve; });
    mocks.send.mockImplementationOnce(() => { entered(); return new Promise((_resolve, reject) => { failFirst = reject; }); });
    const firstAttempt = save();
    const firstFailure = expect(firstAttempt).rejects.toMatchObject({ code: 'CONTENT_WRITE_UNAVAILABLE' });
    await firstEntered;
    expect(await getRecord('media', id(first))).toBeNull();
    await expect(readMedia(id(first))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    let enteredSecond!: () => void;
    const secondEntered = new Promise<void>(resolve => { enteredSecond = resolve; });
    mocks.send.mockImplementationOnce(() => { enteredSecond(); return new Promise(resolve => { finishSecond = resolve; }); });
    const secondAttempt = save();
    await secondEntered;
    failFirst(new Error('First writer failed'));
    await firstFailure;
    await expect(save(other)).rejects.toMatchObject({ code: 'MEDIA_QUOTA_REACHED' });
    finishSecond({});
    await secondAttempt;
    expect(await getRecord('media', id(first))).toMatchObject({ size: first.length });
    expect(await listRecords('media_uploads')).toEqual([]);
    await expect(save(other)).rejects.toMatchObject({ code: 'MEDIA_QUOTA_REACHED' });
  });

  it('keeps confirmed content unchanged if a later same-content write fails', async () => {
    await save();
    const confirmed = await getRecord('media', id(first));
    mocks.send.mockRejectedValueOnce(new Error('Rewrite failed'));
    await expect(save()).rejects.toMatchObject({ code: 'CONTENT_WRITE_UNAVAILABLE' });
    expect(await getRecord('media', id(first))).toEqual(confirmed);
    expect(await listRecords('media_uploads')).toEqual([]);
    await expect(save(other)).rejects.toMatchObject({ code: 'MEDIA_QUOTA_REACHED' });
  });

  it('preserves the winner when an overlapping writer reports failure after confirmation', async () => {
    let entered!: () => void, failLate!: (error: Error) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    mocks.send.mockImplementationOnce(() => { entered(); return new Promise((_resolve, reject) => { failLate = reject; }); });
    const losingWriter = expect(save()).rejects.toMatchObject({ code: 'CONTENT_WRITE_UNAVAILABLE' });
    await started;
    await save();
    const confirmed = await getRecord('media', id(first));
    failLate(new Error('Overlapping provider request failed late'));
    await losingWriter;
    expect(await getRecord('media', id(first))).toEqual(confirmed);
    expect(await listRecords('media_uploads')).toEqual([]);
    await expect(save(other)).rejects.toMatchObject({ code: 'MEDIA_QUOTA_REACHED' });
  });

  it('releases a timed-out attempt and ignores its eventual provider completion', async () => {
    vi.useFakeTimers();
    let entered!: () => void, complete!: (value: unknown) => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    mocks.send.mockImplementationOnce(() => { entered(); return new Promise(resolve => { complete = resolve; }); });
    const timedOut = expect(save()).rejects.toMatchObject({ code: 'CONTENT_WRITE_TIMEOUT' });
    await ready;
    await vi.advanceTimersByTimeAsync(15_000);
    await timedOut;
    complete({});
    await Promise.resolve();
    expect(await getRecord('media', id(first))).toBeNull();
    expect(await listRecords('media_uploads')).toEqual([]);
    vi.useRealTimers();
    await expect(save(other)).resolves.toMatchObject({ size: other.length });
  });

  it('recovers persisted expired reservations without accepting a stale completion', async () => {
    let now = 1_900_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const interrupted = await beginMediaUpload(id(first), asset);
    const persisted = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
    expect(persisted.media_uploads[interrupted.reservationId]).toMatchObject({ mediaId: id(first), expiresAt: now + MEDIA_UPLOAD_LEASE_MS });
    await expect(beginMediaUpload(id(other), asset)).rejects.toMatchObject({ code: 'MEDIA_QUOTA_REACHED' });
    now += MEDIA_UPLOAD_LEASE_MS + 1;
    const replacement = await beginMediaUpload(id(first), asset);
    expect(await commitMediaUpload(interrupted)).toBe(false);
    await cancelMediaUpload(interrupted);
    expect(await commitMediaUpload(replacement)).toBe(true);
    expect(await getRecord('media', id(first))).toMatchObject(asset);
    expect(await listRecords('media_uploads')).toEqual([]);
  });

  it('binds cancellation and confirmation to both the attempt and content identity', async () => {
    const upload = await beginMediaUpload(id(first), asset);
    const wrongContent = { ...upload, mediaId: id(other) };
    expect(await commitMediaUpload(wrongContent)).toBe(false);
    await cancelMediaUpload(wrongContent);
    expect(await commitMediaUpload(upload)).toBe(true);
    expect(await getRecord('media', id(first))).toMatchObject(asset);
    expect(await getRecord('media', id(other))).toBeNull();
  });

  it('rechecks expiry after waiting for an earlier store operation', async () => {
    let now = Date.now(), entered!: () => void, release!: () => void;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const upload = await beginMediaUpload(id(first), asset);
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const precedingOperation = withLocalNamespace('media_uploads', async () => { entered(); await gate; }, false);
    await started;
    const queuedConfirmation = commitMediaUpload(upload);
    now += MEDIA_UPLOAD_LEASE_MS + 1;
    release();
    await precedingOperation;
    expect(await queuedConfirmation).toBe(false);
    expect(await getRecord('media', id(first))).toBeNull();
    await expect(beginMediaUpload(id(other), asset)).resolves.toMatchObject({ mediaId: id(other) });
  });
});
