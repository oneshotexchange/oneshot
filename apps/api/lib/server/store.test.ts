import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRecord, putRecord, dataRoot } from './store';

const mocks = vi.hoisted(() => ({ rename: vi.fn(), unlink: vi.fn(), delay: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  rename: mocks.rename,
  unlink: mocks.unlink,
}));
vi.mock('node:timers/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:timers/promises')>(),
  setTimeout: mocks.delay,
}));
const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const ROOT = resolve('.local/store-tests');
let directory: string;

beforeEach(async () => {
  await fs.mkdir(ROOT, { recursive: true });
  directory = await fs.mkdtemp(join(ROOT, 'atomic-store-'));
  vi.stubEnv('B20_DATA_DIR', directory);
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('NODE_ENV', 'test');
  mocks.rename.mockReset().mockImplementation(fs.rename);
  mocks.unlink.mockReset().mockImplementation(fs.unlink);
  mocks.delay.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  const target = resolve(directory);
  if (dirname(target) !== ROOT || !basename(target).startsWith('atomic-store-')) throw new Error('Unexpected store-test path');
  await fs.rm(target, { recursive: true, force: true });
});

describe('atomic local state replacement', () => {
  it('uses the oneshot data directory and retains an explicit legacy fallback', () => {
    vi.stubEnv('ONESHOT_DATA_DIR', '');
    expect(dataRoot()).toBe(directory);
    vi.stubEnv('B20_DATA_DIR', '');
    expect(dataRoot()).toBe(resolve('.local/oneshot'));
    vi.stubEnv('ONESHOT_DATA_DIR', directory);
    expect(dataRoot()).toBe(directory);
  });
  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries transient %s while keeping the previous state intact', async code => {
    await putRecord('records', 'entry', { value: 'previous' });
    const path = join(directory, 'state.json');
    let attempts = 0;
    mocks.rename.mockReset().mockImplementation(async (temp: string, destination: string) => {
      expect(destination).toBe(path);
      if (attempts++ < 2) {
        expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual({ records: { entry: { value: 'previous' } } });
        throw Object.assign(new Error('temporarily locked'), { code });
      }
      await fs.rename(temp, destination);
    });
    await putRecord('records', 'entry', { value: 'next' });
    expect(mocks.rename).toHaveBeenCalledTimes(3);
    expect(mocks.delay.mock.calls).toEqual([[10], [20]]);
    expect(await getRecord('records', 'entry')).toEqual({ value: 'next' });
    expect(await fs.readdir(directory)).toEqual(['state.json']);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it.each(['EIO', 'EPERM'])('keeps committed state and removes the temporary file after fatal %s', async code => {
    await putRecord('records', 'entry', { value: 'previous' });
    const failure = Object.assign(new Error('cannot replace'), { code });
    mocks.rename.mockReset().mockRejectedValue(failure);
    await expect(putRecord('records', 'entry', { value: 'failed' })).rejects.toBe(failure);
    expect(mocks.rename).toHaveBeenCalledTimes(code === 'EPERM' ? 5 : 1);
    expect(mocks.delay.mock.calls).toEqual(code === 'EPERM' ? [[10], [20], [40], [80]] : []);
    expect(await getRecord('records', 'entry')).toEqual({ value: 'previous' });
    expect(mocks.unlink).toHaveBeenCalledExactlyOnceWith(`${join(directory, 'state.json')}.${process.pid}.tmp`);
    expect(await fs.readdir(directory)).toEqual(['state.json']);

    // A failed operation must not poison the serialization queue for later writes.
    mocks.rename.mockImplementation(fs.rename);
    await putRecord('records', 'entry', { value: 'recovered' });
    expect(await getRecord('records', 'entry')).toEqual({ value: 'recovered' });
  });
});
