import { describe, expect, it } from 'vitest';
import { apiUrl } from './api-url';

describe('separate API origin', () => {
  it('supports a local development proxy and a fixed hosted origin', () => {
    expect(apiUrl('/api/status', '')).toBe('/api/status');
    expect(apiUrl('/api/oneshot/drafts?cursor=one', 'https://api.oneshot.app')).toBe('https://api.oneshot.app/api/oneshot/drafts?cursor=one');
    expect(apiUrl('/api/status', 'http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001/api/status');
  });
  it('rejects URL injection, traversal and untrusted origin configuration', () => {
    for (const path of ['https://evil.example/api/oneshot/session', '//evil.example/api/oneshot/session', '/api/../private', '/api/%2e%2e/private', '/api/\\evil', '/api/status#fragment', '/api/status\n']) {
      expect(() => apiUrl(path, 'https://api.oneshot.app')).toThrow();
    }
    for (const origin of ['http://api.oneshot.app', 'https://name:secret@api.oneshot.app', 'https://api.oneshot.app/base', 'https://api.oneshot.app?host=evil', ' https://api.oneshot.app']) {
      expect(() => apiUrl('/api/oneshot/session', origin)).toThrow();
    }
  });
});
