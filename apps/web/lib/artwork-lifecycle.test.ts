import { describe, expect, it, vi } from 'vitest';
import { createArtworkLifecycle, type ArtworkResource } from './artwork-lifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function artwork() {
  return { setVisible: vi.fn(), replay: vi.fn(), dispose: vi.fn() } satisfies ArtworkResource;
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('artwork lifecycle', () => {
  it('does not load before the artwork is both allowed and visible', async () => {
    const resource = artwork(), load = vi.fn(async () => resource);
    const lifecycle = createArtworkLifecycle({ load, onReady: vi.fn() });
    expect(load).not.toHaveBeenCalled();
    lifecycle.setAllowed(false);
    lifecycle.setVisible(true);
    expect(load).not.toHaveBeenCalled();
    lifecycle.setAllowed(true);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(resource.setVisible).toHaveBeenCalledWith(true);
    expect(resource.replay).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
  });

  it('serializes a preference off/on toggle while creation is still pending', async () => {
    const first = deferred<ArtworkResource>(), second = deferred<ArtworkResource>();
    const stale = artwork(), accepted = artwork(), onReady = vi.fn();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const lifecycle = createArtworkLifecycle({ load, onReady });
    lifecycle.setVisible(true);
    const firstSignal = load.mock.calls[0][0] as AbortSignal;
    lifecycle.setAllowed(false);
    lifecycle.setAllowed(true);
    expect(firstSignal.aborted).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    first.resolve(stale);
    await settle();
    expect(stale.dispose).toHaveBeenCalledTimes(1);
    expect(stale.replay).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);
    expect(onReady).not.toHaveBeenCalledWith(true);
    second.resolve(accepted);
    await settle();
    expect(onReady.mock.calls.filter(([ready]) => ready)).toEqual([[true]]);
    expect(accepted.setVisible).toHaveBeenCalledWith(true);
    expect(accepted.replay).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
  });

  it('disposes a stale completion without starting another attempt while disallowed', async () => {
    const pending = deferred<ArtworkResource>(), resource = artwork(), onReady = vi.fn();
    const load = vi.fn(() => pending.promise);
    const lifecycle = createArtworkLifecycle({ load, onReady });
    lifecycle.setVisible(true);
    lifecycle.setAllowed(false);
    pending.resolve(resource);
    await settle();
    expect(resource.dispose).toHaveBeenCalledTimes(1);
    expect(resource.setVisible).not.toHaveBeenCalled();
    expect(resource.replay).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalledWith(true);
    expect(load).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
    expect(resource.dispose).toHaveBeenCalledTimes(1);
  });

  it('aborts an unmounted pending scene and never publishes its completion', async () => {
    const pending = deferred<ArtworkResource>(), resource = artwork(), onReady = vi.fn();
    const load = vi.fn((_signal: AbortSignal) => pending.promise);
    const lifecycle = createArtworkLifecycle({ load, onReady });
    lifecycle.setVisible(true);
    lifecycle.dispose(); lifecycle.dispose();
    expect(load.mock.calls[0][0].aborted).toBe(true);
    pending.resolve(resource);
    await settle();
    lifecycle.setVisible(true); lifecycle.setAllowed(true); lifecycle.contextLost(); lifecycle.contextRestored(); lifecycle.replay();
    expect(resource.dispose).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shows the poster on context loss and rebuilds only after restoration', async () => {
    const first = artwork(), second = artwork(), onReady = vi.fn();
    const load = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const lifecycle = createArtworkLifecycle({ load, onReady });
    lifecycle.setVisible(true);
    await settle();
    lifecycle.contextLost(); lifecycle.contextLost();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenLastCalledWith(false);
    lifecycle.setVisible(false); lifecycle.setVisible(true); lifecycle.replay();
    expect(load).toHaveBeenCalledTimes(1);
    lifecycle.contextRestored();
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(second.replay).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenLastCalledWith(true);
    lifecycle.dispose();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).toHaveBeenCalledTimes(1);
  });

  it('serializes restoration when a lost scene is still compiling', async () => {
    const pending = deferred<ArtworkResource>(), stale = artwork(), restored = artwork();
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(restored);
    const lifecycle = createArtworkLifecycle({ load, onReady: vi.fn() });
    lifecycle.setVisible(true);
    lifecycle.contextLost(); lifecycle.contextRestored();
    expect((load.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(stale);
    await settle(); await settle();
    expect(stale.dispose).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(restored.replay).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
  });

  it('retains a hidden scene, including one that finishes loading while hidden', async () => {
    const pending = deferred<ArtworkResource>(), resource = artwork(), onReady = vi.fn();
    const load = vi.fn(() => pending.promise);
    const lifecycle = createArtworkLifecycle({ load, onReady });
    lifecycle.setVisible(true);
    lifecycle.setVisible(false);
    pending.resolve(resource);
    await settle();
    expect(resource.setVisible).toHaveBeenLastCalledWith(false);
    expect(resource.replay).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenLastCalledWith(true);
    lifecycle.setVisible(true); lifecycle.setVisible(false); lifecycle.setVisible(true);
    expect(resource.setVisible.mock.calls).toEqual([[false], [true], [false], [true]]);
    expect(resource.dispose).not.toHaveBeenCalled();
    expect(resource.replay).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
  });

  it('consumes an ordinary rejection without retrying on visibility changes', async () => {
    const pending = deferred<ArtworkResource>(), onReady = vi.fn(), recovered = artwork();
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(recovered);
    const lifecycle = createArtworkLifecycle({ load, onReady });
    lifecycle.setVisible(true);
    pending.reject(new Error('Graphics unavailable'));
    await settle(); await settle();
    lifecycle.setVisible(false); lifecycle.setVisible(true); lifecycle.setAllowed(true); lifecycle.contextRestored();
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalledWith(true);
    lifecycle.replay();
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenLastCalledWith(true);
    lifecycle.dispose();
  });

  it('consumes a synchronous factory failure and releases an accepted scene only once', async () => {
    const resource = artwork();
    const load = vi.fn<(signal: AbortSignal) => Promise<ArtworkResource>>()
      .mockImplementationOnce(() => { throw new Error('No graphics context'); })
      .mockResolvedValueOnce(resource);
    const lifecycle = createArtworkLifecycle({ load, onReady: vi.fn() });
    expect(() => lifecycle.setVisible(true)).not.toThrow();
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    lifecycle.setAllowed(false); lifecycle.setAllowed(true);
    await settle();
    lifecycle.setAllowed(false); lifecycle.dispose(); lifecycle.dispose();
    expect(resource.dispose).toHaveBeenCalledTimes(1);
  });
});
