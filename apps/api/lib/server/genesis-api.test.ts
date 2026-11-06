import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  campaign: vi.fn(), me: vi.fn(), shareProfile: vi.fn(), requireSession: vi.fn(),
}));
vi.mock('./genesis-service', () => ({ genesis: mocks }));
vi.mock('./genesis-auth', () => ({ genesisAuth: { authenticate: mocks.requireSession, assertWrite: vi.fn() } }));
import { genesisApi } from './genesis-api';

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe('Genesis API public and account boundaries', () => {
  it('serves GET and HEAD campaign and invitation reads without a customer session', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://oneshot.example.com');
    vi.stubEnv('ONESHOT_API_URL', 'https://api.oneshot.example.com');
    mocks.campaign.mockResolvedValue({ state: 'upcoming', capacity: 750 });
    mocks.shareProfile.mockResolvedValue(null);
    for (const path of ['campaign', 'share/abcdefghijklmnop', 'share/abcdefghijklmnop/image']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await genesisApi(new NextRequest(`https://api.oneshot.example/api/oneshot/genesis/${path}`, { method }));
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        if (method === 'HEAD') expect(await response.text()).toBe('');
      }
    }
    expect(mocks.requireSession).not.toHaveBeenCalled();
  });

  it('requires a verified session for account reads and every write', async () => {
    const denied = new Error('Authentication required');
    mocks.requireSession.mockRejectedValue(denied);
    for (const [path, method] of [['me', 'GET'], ['enroll', 'POST'], ['share', 'POST'], ['nominations/accept', 'POST'], ['campaign', 'POST']]) {
      await expect(genesisApi(new NextRequest(`https://api.oneshot.example/api/oneshot/genesis/${path}`, { method }))).rejects.toBe(denied);
    }
    expect(mocks.me).not.toHaveBeenCalled();
    expect(mocks.campaign).not.toHaveBeenCalled();
  });
  it('rejects a request from an older X session before any account action',async()=>{
    mocks.requireSession.mockResolvedValue({provider:'x',userId:'x:123',sessionId:'current-session'});
    await expect(genesisApi(new NextRequest('https://api.oneshot.example.com/api/oneshot/genesis/me',{headers:{'X-Genesis-Session':'old-session'}}))).rejects.toMatchObject({code:'GENESIS_AUTH_CHANGED',status:401});
    expect(mocks.me).not.toHaveBeenCalled();
  });
});
