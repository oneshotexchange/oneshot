import { z } from 'zod';
import { networkConfig, verifyRpcNetwork, RpcError, type RpcProviderLabel } from '@oneshot/evm';
import { adminAuthenticator } from './admin-auth';
import { oneshotStatus } from './active-network';
import { readiness } from './readiness';
import { api, boundedBody, json, rateLimit, ApiError } from './http';
import { genesis } from './genesis-service';
import { genesisAuth } from './genesis-auth';
import { genesisCampaignSchema, genesisReviewSchema } from '../../../web/lib/genesis-schema';

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
  if (path.startsWith('/api/admin/genesis')) {
    const actor = 'admin:' + (await import('node:crypto')).createHash('sha256').update(request.headers.get('authorization') || '').digest('hex').slice(0,16);
    if (path === '/api/admin/genesis' && request.method === 'GET') {
      const offset = z.coerce.number().int().min(0).max(100_000).parse(request.nextUrl.searchParams.get('offset') || 0);
      return json({ ...await genesis.admin(offset), oauthConfigured: genesisAuth.available(), providerConfigured: Boolean(process.env.GETX_API_KEY), databaseConfigured: Boolean(process.env.DATABASE_URL) });
    }
    if (request.method === 'POST') {
      rateLimit('genesis:admin:write', 30);
      const body = JSON.parse(new TextDecoder().decode(await boundedBody(request, 16_384)));
      if (path === '/api/admin/genesis/campaign') { const input = z.object({ expectedRevision: z.number().int().positive(), campaign: genesisCampaignSchema }).strict().parse(body); return json(await genesis.configure(input.campaign, input.expectedRevision, actor)); }
      if (path === '/api/admin/genesis/run-checks') { z.object({}).strict().parse(body); return json(await genesis.runJobs()); }
      const match = /^\/api\/admin\/genesis\/applications\/([a-f0-9-]{36})$/.exec(path);
      if (match) { const id = z.string().uuid().parse(match[1]); await genesis.review(id, genesisReviewSchema.parse(body), actor); return json({ ok: true }); }
    }
    throw new ApiError(404, 'NOT_FOUND', 'Genesis administration action not found.');
  }
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
