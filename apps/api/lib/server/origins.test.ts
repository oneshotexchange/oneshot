import { describe, expect, it } from 'vitest';
import { apiOrigin, webOrigin } from './origins';

describe('separate browser and content origins', () => {
  it('uses only the canonical API origin for hosted content', () => {
    const env = { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://oneshot.app', ONESHOT_API_URL: 'https://api.oneshot.app' };
    expect(webOrigin(undefined, env)).toBe('https://oneshot.app');
    expect(apiOrigin('https://untrusted-host.app', env)).toBe('https://api.oneshot.app');
    expect(() => apiOrigin('https://untrusted-host.app', { ...env, ONESHOT_API_URL: '' })).toThrow();
  });
  it('accepts loopback HTTP only outside production', () => {
    expect(apiOrigin('http://localhost:3001', { NODE_ENV: 'development' })).toBe('http://localhost:3001');
    expect(webOrigin(undefined, { NODE_ENV: 'test', NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:5173' })).toBe('http://127.0.0.1:5173');
    expect(() => apiOrigin(undefined, { NODE_ENV: 'production', ONESHOT_API_URL: 'http://localhost:3001' })).toThrow();
    expect(() => apiOrigin(undefined, { NODE_ENV: 'test', ONESHOT_API_URL: 'http://public.app' })).toThrow();
  });
  it('rejects credentials, paths, query strings, fragments and nonpublic hosts', () => {
    for (const value of ['https://user:secret@api.oneshot.app', 'https://api.oneshot.app/path', 'https://api.oneshot.app/?key=secret', 'https://api.oneshot.app/#fragment', 'https://127.0.0.1', 'https://api.internal', ' https://api.oneshot.app']) {
      expect(() => apiOrigin(undefined, { NODE_ENV: 'production', ONESHOT_API_URL: value })).toThrow();
    }
  });
});
