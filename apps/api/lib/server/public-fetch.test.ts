import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPublicResource } from './public-fetch';

const net = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: net.lookup }));
vi.mock('node:https', () => ({ request: net.request }));
const publicAddress = [{ address: '8.8.8.8', family: 4 }];
function response(statusCode = 200, headers = {}) {
  return Object.assign(new EventEmitter(), { statusCode, headers, resume: vi.fn(), destroy: vi.fn() });
}
function requests(onEnd: (callback: (incoming: ReturnType<typeof response>) => void) => void) {
  net.request.mockImplementation((_url, options, callback) => {
    const req = Object.assign(new EventEmitter(), { end: () => onEnd(callback), destroy: vi.fn() });
    options.signal.addEventListener('abort', () => { req.destroy(); req.emit('error', new Error('aborted')); }, { once: true });
    return req;
  });
}
beforeEach(() => { vi.useFakeTimers(); net.lookup.mockReset().mockResolvedValue(publicAddress); net.request.mockReset(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('bounded public resource imports', () => {
  it('includes stalled DNS in the absolute import deadline', async () => {
    net.lookup.mockImplementationOnce(() => new Promise(() => {}));
    const assertion = expect(fetchPublicResource('https://art.oneshot.app/image.png')).rejects.toMatchObject({ status: 504, code: 'IMPORT_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
    expect(net.request).not.toHaveBeenCalled();
  });
  it('ends a trickling response at the total deadline even while data keeps arriving', async () => {
    requests(callback => {
      const incoming = response(); callback(incoming);
      setInterval(() => incoming.emit('data', Buffer.from('x')), 1000);
    });
    const assertion = expect(fetchPublicResource('https://art.oneshot.app/image.png')).rejects.toMatchObject({ code: 'IMPORT_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
    expect(net.request.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('shares the original deadline across redirects and their DNS lookup', async () => {
    net.lookup.mockResolvedValueOnce(publicAddress).mockImplementationOnce(() => new Promise(() => {}));
    requests(callback => { setTimeout(() => callback(response(302, { location: '/next.png' })), 8000); });
    const assertion = expect(fetchPublicResource('https://art.oneshot.app/image.png')).rejects.toMatchObject({ code: 'IMPORT_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(8000);
    expect(net.lookup).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    await assertion;
    expect(net.request).toHaveBeenCalledTimes(1);
  });
  it('rejects private DNS results before opening HTTPS', async () => {
    net.lookup.mockResolvedValueOnce([{ address: '172.20.0.1', family: 4 }]);
    await expect(fetchPublicResource('https://art.oneshot.app/image.png')).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(net.request).not.toHaveBeenCalled();
  });
  it('pins the checked address and observes caller cancellation', async () => {
    requests(() => {});
    const controller = new AbortController();
    const assertion = expect(fetchPublicResource('https://art.oneshot.app/image.png', 1000, { signal: controller.signal })).rejects.toMatchObject({ code: 'IMPORT_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(0);
    const pinned = vi.fn();
    net.request.mock.calls[0][1].lookup('art.oneshot.app', {}, pinned);
    expect(pinned).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    controller.abort();
    await assertion;
  });
});
