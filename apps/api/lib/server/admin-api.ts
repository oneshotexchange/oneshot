import { z } from 'zod';
import { networkConfig, verifyRpcNetwork, RpcError, type RpcProviderLabel } from '@oneshot/evm';
import { adminAuthenticator } from './admin-auth';
import { oneshotStatus } from './active-network';
import { readiness } from './readiness';
import { api, boundedBody, json, rateLimit, ApiError } from './http';

const credentials = z.object({ password: z.string().max(1024) }).strict();

export const adminApi = api(async request => {
  const path = request.nextUrl.pathname.replace(/\/$/, '');
  if (path === '/api/admin/session' && request.method === 'POST') {
    // One process-wide budget, independent of spoofable client addresses and before body parsing.
    rateLimit('oneshot:admin:password', 10);
    adminAuthenticator.assertConfigured();
    const body = JSON.parse(new TextDecoder().decode(await boundedBody(request, 4096)));
    const { password } = credentials.parse(body);
    return json(adminAuthenticator.signIn(password), 201);
  }
  adminAuthenticator.requireSession(request);
  rateLimit('oneshot:admin:read', 120);
  if (path === '/api/admin/session' && request.method === 'GET') return json(adminAuthenticator.requireSession(request));
  if (path === '/api/admin/session' && request.method === 'DELETE') {
    adminAuthenticator.revoke(request);
    return json({ ok: true });
  }
  if (path === '/api/admin/network' && request.method === 'GET') {
    rateLimit('oneshot:admin:network', 5);
    const provider = process.env.ONESHOT_RPC_PROVIDER || 'custom';
    if (!['alchemy', 'official', 'custom'].includes(provider)) throw new ApiError(503, 'RPC_CONFIG_INVALID', 'Select a valid RPC provider label.');
    let config: ReturnType<typeof networkConfig>;
    try { config = networkConfig(process.env); }
    catch { throw new ApiError(503, 'RPC_CONFIG_INVALID', 'Configure a valid network profile before verifying the RPC.'); }
    try { const result = await verifyRpcNetwork(config, { provider: provider as RpcProviderLabel }); return json({ ...result, latestBlock: result.latestBlock.toString() }); }
    catch (error) { if (error instanceof RpcError) throw new ApiError(503, error.code, error.message); throw error; }
  }
  if (path === '/api/admin/status' && request.method === 'GET') return json(oneshotStatus());
  if (path === '/api/admin/readiness' && request.method === 'GET') return json({ service: 'oneshot-api', ...await readiness() });
  throw new ApiError(404, 'NOT_FOUND', 'Admin resource not found.');
});
