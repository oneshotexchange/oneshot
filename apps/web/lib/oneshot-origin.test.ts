import { describe, expect, it } from 'vitest';
import { isPublicContentSource, isPublicMetadataOrigin } from './oneshot-origin';

describe('public metadata origin syntax', () => {
  it.each(['https://oneshot.app', 'https://oneshot.app/', 'https://oneshot.app:443', 'https://8.8.8.8'])('accepts a plausible public HTTPS root %s', value => {
    expect(isPublicMetadataOrigin(value)).toBe(true);
  });
  it.each([
    'http://oneshot.app', 'https://localhost', 'https://localhost.', 'https://sub.localhost', 'https://dev.local',
    'https://metadata.internal', 'https://oneshot.example', 'https://oneshot.invalid', 'https://server',
    'https://127.0.0.1', 'https://2130706433', 'https://0x7f000001', 'https://10.0.0.1', 'https://172.16.0.1',
    'https://172.31.255.255', 'https://192.168.1.1', 'https://100.64.0.1', 'https://169.254.169.254',
    'https://192.0.2.1', 'https://198.51.100.1', 'https://203.0.113.1', 'https://198.18.0.1', 'https://224.0.0.1',
    'https://0.0.0.0', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://oneshot.app:8443',
    'https://user:password@oneshot.app', 'https://oneshot.app/path', 'https://oneshot.app/?key=secret',
    'https://oneshot.app/#fragment', ' https://oneshot.app', 'https://one\nshot.app',
  ])('rejects private, reserved or non-origin input %s', value => {
    expect(isPublicMetadataOrigin(value)).toBe(false);
  });
  it('allows content paths and IPFS references while rejecting unsafe resource hosts', () => {
    expect(isPublicContentSource('https://oneshot.app/art/image.png?version=1')).toBe(true);
    expect(isPublicContentSource('ipfs://bafyContent/art/image.png')).toBe(true);
    expect(isPublicContentSource('ipfs://')).toBe(false);
    expect(isPublicContentSource('https://user:password@oneshot.app/art.png')).toBe(false);
    expect(isPublicContentSource('https://172.20.0.1/art.png')).toBe(false);
  });
});
