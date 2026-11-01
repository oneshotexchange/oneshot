import { describe, expect, it } from 'vitest';
import { checkDeployment } from './check-deployment.mjs';

const configured = {
  NEXT_PUBLIC_APP_URL: 'https://app.oneshot.app', ONESHOT_API_URL: 'https://api.oneshot.app',
  PRIVY_APP_ID: 'app-id', PRIVY_APP_SECRET: 'do-not-print-secret',
  S3_BUCKET: 'media', S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  S3_ACCESS_KEY_ID: 'test-id', S3_SECRET_ACCESS_KEY: 'do-not-print-s3-secret',
  PGPASSWORD_FILE: '/run/secrets/postgres_password',
};
describe('deployment configuration boundary', () => {
  it('accepts separated HTTPS origins and mounted PostgreSQL credentials', () => {
    expect(() => checkDeployment(configured)).not.toThrow();
    expect(() => checkDeployment({ NEXT_PUBLIC_API_URL: configured.ONESHOT_API_URL }, true)).not.toThrow();
  });
  it.each(['https://10.0.0.1', 'https://100.64.0.1', 'https://169.254.169.254', 'https://192.168.1.1',
    'https://api.oneshot.app:8443', 'https://api.internal', 'https://api.oneshot.app/path', 'https://user:secret@api.oneshot.app'])('rejects %s consistently with the API', value => {
    expect(() => checkDeployment({ ...configured, ONESHOT_API_URL: value })).toThrow('public HTTPS origin');
    expect(() => checkDeployment({ NEXT_PUBLIC_API_URL: value }, true)).toThrow('public HTTPS origin');
  });
  it('requires distinct hosts and matching public/server Privy configuration', () => {
    expect(() => checkDeployment({ ...configured, ONESHOT_API_URL: configured.NEXT_PUBLIC_APP_URL })).toThrow('separate origins');
    expect(() => checkDeployment({ ...configured, NEXT_PUBLIC_PRIVY_APP_ID: 'different-app' })).toThrow('App IDs must match');
  });
  it('reports variable names without exposing configured credentials', () => {
    expect(() => checkDeployment({ ...configured, S3_BUCKET: '' })).toThrow('S3_BUCKET must be configured');
    let message = '';
    try { checkDeployment({ ...configured, S3_BUCKET: '' }); } catch (error) { message = (error as Error).message; }
    expect(message).not.toContain(configured.PRIVY_APP_SECRET);
    expect(message).not.toContain(configured.S3_SECRET_ACCESS_KEY);
    expect(configured.S3_BUCKET).toBe('media');
  });
});
