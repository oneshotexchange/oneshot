import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { activeNetworkResponse, oneshotStatus, publicOneshotStatus } from './active-network';
import { api } from './http';

afterEach(() => vi.unstubAllEnvs());
describe('active Zero routes cannot fall through into the Aptos prototype', () => {
  it('ignores every old deployment readiness flag', () => {
    const result = oneshotStatus({ B20_NFT_PACKAGE_ADDRESS: '0x1', B20_DEPLOYMENT_VERIFIED: 'true', GEOMI_API_KEY: 'old-key' });
    expect(result.app).toBe('oneshot'); expect(result.chainId).toBeNull(); expect(result.nativeDecimals).toBeNull();
    expect(Object.values(result.features).every(feature => !feature.enabled)).toBe(true);
    expect(result.contracts.nftPackage).toBeNull(); expect(result.indexer.configured).toBe(false);
  });
  it('separates account and content configuration from chain deployment', () => {
    const empty = oneshotStatus({ NODE_ENV: 'production' });
    expect(empty.auth.configured).toBe(false);
    expect(empty.accountDrafts).toEqual({ implemented: true, configured: false });
    expect(empty.storage).toEqual({ configured: false, mode: 'not-configured' });
    const configured = oneshotStatus({ NODE_ENV: 'production', PRIVY_APP_ID: 'oneshot', NEXT_PUBLIC_PRIVY_APP_ID: 'oneshot', PRIVY_APP_SECRET: 'server-only', DATABASE_URL: 'postgres://secret', S3_BUCKET: 'oneshot', NEXT_PUBLIC_APP_URL: 'https://oneshot.app', ONESHOT_API_URL: 'https://api.oneshot.app' });
    expect(configured.accountDrafts.configured).toBe(true);
    expect(configured.storage).toEqual({ configured: true, mode: 'object-storage' });
    expect(configured.metadata.publicOriginConfigured).toBe(true);
    expect(Object.values(configured.features).every(feature => !feature.enabled)).toBe(true);
    expect(JSON.stringify(configured)).not.toMatch(/server-only|postgres:\/\//);
    expect(oneshotStatus({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://oneshot.app' }).metadata.publicOriginConfigured).toBe(false);
  });
  it('blocks even direct transaction/auth/draft API calls before legacy handlers run', async () => {
    const oldHandler = vi.fn(); const handle = api(oldHandler);
    for (const path of ['/api/transactions', '/api/transactions/confirm', '/api/auth/verify', '/api/drafts/collections', '/api/media']) {
      const response = await handle(new NextRequest(`http://localhost${path}`, { method: 'POST', body: '{}' }), {});
      expect(response.status).toBe(409); expect((await response.json()).error.code).toBe('ZERO_INTEGRATION_PENDING');
    }
    expect(oldHandler).not.toHaveBeenCalled();
  });
  it('returns honest empty views and unknown balances, never cached Aptos assets', async () => {
    for (const path of ['/api/collections', '/api/activity', '/api/tokens']) {
      const response = activeNetworkResponse(new NextRequest(`http://localhost${path}`))!;
      expect((await response.json()).items).toEqual([]);
    }
    const portfolio = await activeNetworkResponse(new NextRequest('http://localhost/api/portfolio?address=0x1'))!.json();
    expect(portfolio.balanceNative).toBeNull(); expect(portfolio.balanceApt).toBeUndefined();
  });
  it('retains read-only content-addressed media while rejecting legacy detail reads', () => {
    expect(activeNetworkResponse(new NextRequest('http://localhost/api/media/hash.png'))).toBeNull();
    expect(activeNetworkResponse(new NextRequest('http://localhost/api/collections/0x1'))!.status).toBe(404);
  });
  it('returns only customer availability publicly and retains operational details for admin callers', async () => {
    const env = { NODE_ENV: 'production', PRIVY_APP_ID: 'oneshot', NEXT_PUBLIC_PRIVY_APP_ID: 'oneshot', PRIVY_APP_SECRET: 'private-provider-secret', DATABASE_URL: 'postgres://private-database', S3_BUCKET: 'private-bucket', ONESHOT_API_URL: 'https://api.oneshot.app' };
    const status = publicOneshotStatus(env);
    expect(Object.keys(status).sort()).toEqual(['app', 'network', 'chainId', 'nativeSymbol', 'nativeDecimals', 'features'].sort());
    expect(JSON.stringify(status)).not.toMatch(/private-|postgres|implemented|networkConfig|missing|local-development|AMM|ATLAS|custody|RPC/);
    expect(oneshotStatus(env).networkConfig).toBeDefined();
    const response = activeNetworkResponse(new NextRequest('http://localhost/api/status'))!;
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(publicOneshotStatus());
  });
  it('retains other admin diagnostics when network configuration is invalid without echoing the invalid value', () => {
    const result = oneshotStatus({ ONESHOT_NETWORK: 'local', ONESHOT_RPC_URL: 'invalid-private-rpc-secret' });
    expect(result.networkConfig).toMatchObject({ mode: 'local', configurationValid: false, configurationReady: false, chainId: null });
    expect(result.networkConfig.missing).toContain('Network configuration is invalid. Review the network profile, RPC URL, chain ID, genesis hash and native precision.');
    expect(result.auth.configured).toBe(false);
    expect(result.storage).toBeDefined();
    expect(result.executionScope).toBe('Zero');
    expect(JSON.stringify(result)).not.toContain('invalid-private-rpc-secret');
    expect(publicOneshotStatus({ ONESHOT_NETWORK: 'invalid-mode-private' }).network).toBe('Unknown');
  });
  it('passes admin routes through to their password-protected dedicated router', () => {
    for (const [path, method] of [['/api/admin/status', 'GET'], ['/api/admin/session', 'POST'], ['/api/admin/session', 'DELETE']])
      expect(activeNetworkResponse(new NextRequest(`http://localhost${path}`, { method }))).toBeNull();
  });
});
