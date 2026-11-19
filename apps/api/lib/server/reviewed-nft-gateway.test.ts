import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { parseReviewedNftManifest, reviewedNftManifestId } from '../../../../packages/evm/src/reviewed-nft';
import { REVIEWED_NFT_REGISTRY_ABI } from '../../../../packages/evm/src/reviewed-nft-abi';
import { createReviewedNftGateway, reviewedPermitHash } from './reviewed-nft-gateway';
import { createExternalNftAdmission } from './external-nft-admission';
import { createExternalNftImports, type ExternalNftImportStore, type StoredExternalNftImport } from './external-nft-imports';
import type { OneshotSession } from './oneshot-auth';

const address = (value: string) => `0x${value.repeat(40)}` as Address;
const hash = (value: string) => `0x${value.repeat(64)}` as Hex;
const now = Date.UTC(2026, 10, 19, 6), code = '0x60016001' as Hex;
const abi = [...parseAbi(['function supportsInterface(bytes4 interfaceId) view returns (bool)', 'function isCollection(address collection) view returns (bool)']), ...REVIEWED_NFT_REGISTRY_ABI] as Abi;
const manifest = parseReviewedNftManifest({ schemaVersion: 1, deploymentVersion: 'oneshot-reviewed-erc721-v1', mode: 'local', chainId: 31337, genesisHash: hash('1'), startBlock: '1', anchorHash: hash('1'),
  oneshotFactory: { address: address('1'), codeHash: hash('2') }, registry: { address: address('2'), codeHash: hash('3') }, marketplace: { address: address('3'), codeHash: hash('4') },
  treasury: address('4'), reviewAuthority: address('5'), registrySalt: hash('5'), marketplaceSalt: hash('6') });
const id = reviewedNftManifestId(manifest), block = { number: 10n, hash: hash('a'), parentHash: hash('9'), timestamp: BigInt(now / 1000 - 1) };
function fixture() {
  const state = { native: false, supports: true, invalid165: false, code, version: 0n, moved: false, maliciousHash: false };
  const rpc = {
    verification: { mode: 'local' as const, chainId: 31337, genesisHash: manifest.genesisHash, latestBlock: 10n, checkedAt: new Date(now).toISOString(), provider: { label: 'custom' as const, verifiedSupport: false as const }, genesisMatched: null },
    readRpc: vi.fn(async (method: string, params: readonly unknown[] = []): Promise<unknown> => {
      if (method === 'eth_getCode') return state.code;
      if (method === 'eth_getBlockByNumber') return { number: '0xa', hash: state.moved ? hash('b') : block.hash };
      if (method !== 'eth_call') throw new Error('Unexpected test RPC');
      const call = params[0] as { data: Hex }, decoded = decodeFunctionData({ abi, data: call.data }); let result: unknown;
      if (decoded.functionName === 'isCollection') result = state.native;
      else if (decoded.functionName === 'checkCollection') { if (state.native || !state.supports || state.invalid165) throw new Error('Unsupported fixture collection'); result = keccak256(state.code); }
      else if (decoded.functionName === 'supportsInterface') result = decoded.args![0] === '0xffffffff' ? state.invalid165 : state.supports;
      else if (decoded.functionName === 'reviews') result = [hash('0'), state.version, false];
      else if (decoded.functionName === 'reviewPermitHash') result = state.maliciousHash ? hash('f') : reviewedPermitHash({ manifest }, { collection: decoded.args![0] as Address, runtimeCodeHash: decoded.args![1] as Hex, reviewVersion: String(decoded.args![2]), deadline: String(decoded.args![3]), deploymentSalt: manifest.registrySalt });
      else throw new Error('Unexpected test function');
      return encodeFunctionResult({ abi, functionName: decoded.functionName, result });
    }),
    simulateCall: vi.fn(async () => ({ result: '0x', gasEstimate: '180000' })),
  };
  const env = { ONESHOT_NETWORK: 'local', ONESHOT_REVIEWED_NFT_IMPORTS_ENABLED: 'true', ONESHOT_REVIEWED_NFT_MANIFEST_PATH: 'owned-fixture.json' };
  const verify = vi.fn(async () => ({ manifest, manifestId: id, block }));
  const gateway = createReviewedNftGateway({ environment: () => env, rpc: async () => rpc, verify, loadManifest: async () => manifest, now: () => now });
  return { gateway, rpc, state, env, verify };
}
async function approvedFixture() {
  const f = fixture(), records = new Map<string, StoredExternalNftImport>();
  const store: ExternalNftImportStore = {
    get: async id => structuredClone(records.get(id) ?? null), list: async () => [], create: async value => { records.set(value.request.id, structuredClone(value)); },
    replace: async (old, next) => { if (JSON.stringify(records.get(old.request.id)) !== JSON.stringify(old)) return false; records.set(old.request.id, structuredClone(next)); return true; },
  };
  const imports = createExternalNftImports({ store, now: () => new Date(now).toISOString(), deployment: f.gateway.deployment, inspect: f.gateway.inspect });
  const owner: OneshotSession = { provider: 'privy', userId: 'did:privy:import-owner', sessionId: 'session', expiresAt: 9999999999, linkedAddresses: [] };
  const created = await imports.create({ deploymentId: id, collection: address('7') }, owner);
  await imports.review(created.id, 1, { decision: 'review-approved', operatorEvidence: 'Contract references and royalty behavior reviewed.' }, 'admin:test');
  const admission = createExternalNftAdmission({ imports, gateway: f.gateway, now: () => now });
  return { ...f, imports, owner, admission, created, records };
}

describe('reviewed external NFT gateway', () => {
  it('exposes only a verified customer-safe network choice and no infrastructure configuration', async () => {
    const { gateway } = fixture();
    expect(await gateway.configuration()).toEqual({ available: true, deployments: [{ deploymentId: id, chainId: 31337, label: 'Local testnet' }] });
    expect(JSON.stringify(await gateway.configuration())).not.toMatch(/RPC|manifest|factory|registry|authority|salt|path/i);
  });
  it('never inherits native execution flags and rejects Zero, wrong deployment and provider failures', async () => {
    const { gateway, env, verify } = fixture();
    await expect(gateway.deployment('f'.repeat(64))).rejects.toMatchObject({ code: 'EXTERNAL_IMPORT_UNAVAILABLE' });
    env.ONESHOT_REVIEWED_NFT_IMPORTS_ENABLED = 'false'; expect(await gateway.configuration()).toEqual({ available: false, deployments: [] });
    env.ONESHOT_REVIEWED_NFT_IMPORTS_ENABLED = 'true'; env.ONESHOT_NETWORK = 'zero'; expect(await gateway.configuration()).toEqual({ available: false, deployments: [] });
    env.ONESHOT_NETWORK = 'local'; verify.mockRejectedValueOnce(new Error('private-provider-token'));
    await expect(gateway.deployment(id)).rejects.toThrow('Collection import requests are temporarily unavailable. Please try again.');
  });
  it('inspects code, native exclusion and ERC165/721/2981 at the same hash and rechecks canonicality', async () => {
    const { gateway, rpc } = fixture(), deployment = await gateway.deployment(id), proof = await gateway.inspect(deployment, address('7'));
    expect(proof).toMatchObject({ collection: address('7'), runtimeCodeHash: keccak256(code), currentReviewVersion: '0', checkpoint: { number: '10', hash: block.hash } });
    for (const [method, params] of rpc.readRpc.mock.calls) if (method === 'eth_call' || method === 'eth_getCode') expect(params?.[1]).toEqual({ blockHash: block.hash, requireCanonical: true });
    expect(rpc.readRpc.mock.calls.some(([method, params]) => method === 'eth_call' && decodeFunctionData({ abi, data: (params![0] as { data: Hex }).data }).functionName === 'checkCollection')).toBe(true);
    expect(proof).not.toHaveProperty('creator'); expect(proof).not.toHaveProperty('totalSupply');
  });
  it.each(['native', 'supports', 'invalid165', 'code', 'version', 'moved'] as const)('rejects unsupported or changed collection evidence: %s', async key => {
    const { gateway, state } = fixture();
    if (key === 'native') state.native = true; if (key === 'supports') state.supports = false;
    if (key === 'invalid165') state.invalid165 = true; if (key === 'code') state.code = '0x';
    if (key === 'version') state.version = 2n ** 256n - 1n; if (key === 'moved') state.moved = true;
    await expect(gateway.inspect(await gateway.deployment(id), address('7'))).rejects.toBeDefined();
  });
});

describe('unsigned external NFT admission', () => {
  it('prepares an exact authority/domain/version-bound permit without claiming admission or sending a transaction', async () => {
    const { admission, created, rpc } = await approvedFixture(), prepared = await admission.prepare(created.id, 2);
    expect(prepared.bundle).toMatchObject({ authority: manifest.reviewAuthority, registry: manifest.registry.address, chainId: 31337, reviewVersion: '1', deadline: String(now / 1000 + 900), runtimeCodeHash: keccak256(code) });
    expect(prepared.typedData.domain).toMatchObject({ verifyingContract: manifest.registry.address, name: 'OneshotReviewedCollectionRegistry', version: '1' });
    expect(prepared.admissionStatus).toBe('not-established'); expect(rpc.simulateCall).not.toHaveBeenCalled();
  });
  it('validates the exact signed registry call via simulation and still does not claim submission', async () => {
    const { admission, created, rpc } = await approvedFixture(), { bundle } = await admission.prepare(created.id, 2);
    const result = await admission.validate(created.id, { expectedRevision: 2, bundle, signature: '0xab', submitter: address('8') });
    const call = decodeFunctionData({ abi: REVIEWED_NFT_REGISTRY_ABI, data: result.call.data });
    expect(call.functionName).toBe('admitReviewed'); expect(call.args).toEqual([address('7'), keccak256(code), 1n, BigInt(bundle.deadline), '0xab']);
    expect(result.call).toMatchObject({ from: address('8'), to: manifest.registry.address, value: '0x0', chainId: 31337 });
    expect(result.admissionStatus).toBe('not-established'); expect(rpc.simulateCall).toHaveBeenCalledTimes(1);
  });
  it.each(['collection', 'authority', 'deploymentId', 'registry', 'runtimeCodeHash', 'reviewVersion', 'deploymentSalt', 'requestRevision', 'deadline'] as const)('rejects a changed permit field: %s', async key => {
    const { admission, created, rpc } = await approvedFixture(), { bundle } = await admission.prepare(created.id, 2);
    const changed = { ...bundle };
    Object.assign(changed, { [key]: key === 'requestRevision' ? 3 : key === 'deadline' ? String(now / 1000) : key === 'reviewVersion' ? '2' : key === 'deploymentId' ? 'f'.repeat(64) : ['collection', 'authority', 'registry'].includes(key) ? address('9') : hash('f') });
    await expect(admission.validate(created.id, { expectedRevision: 2, bundle: changed, signature: '0xab', submitter: address('8') })).rejects.toBeDefined();
    expect(rpc.simulateCall).not.toHaveBeenCalled();
  });
  it('rejects changed code/version, wrong on-chain digest and failed authority-signature simulation', async () => {
    const f = await approvedFixture(), { bundle } = await f.admission.prepare(f.created.id, 2);
    f.state.code = '0x6002'; await expect(f.admission.prepare(f.created.id, 2)).rejects.toMatchObject({ code: 'EXTERNAL_REVIEW_CHANGED' });
    f.state.code = code; f.state.version = 1n; await expect(f.admission.prepare(f.created.id, 2)).rejects.toMatchObject({ code: 'EXTERNAL_REVIEW_CHANGED' });
    f.state.version = 0n; f.state.maliciousHash = true; await expect(f.admission.prepare(f.created.id, 2)).rejects.toMatchObject({ code: 'EXTERNAL_PERMIT_INVALID' });
    f.state.maliciousHash = false; f.rpc.simulateCall.mockRejectedValueOnce(new Error('private-provider-key'));
    await expect(f.admission.validate(f.created.id, { expectedRevision: 2, bundle, signature: '0xab', submitter: address('8') })).rejects.toMatchObject({ code: 'EXTERNAL_PERMIT_INVALID' });
  });
  it('stops preparation after request withdrawal including a withdrawal while the contract read was pending', async () => {
    const f = await approvedFixture(), original = f.rpc.readRpc.getMockImplementation()!;
    f.rpc.readRpc.mockImplementationOnce(async (method, params) => { await f.imports.withdraw(f.created.id, 2, f.owner); return original(method, params); });
    await expect(f.admission.prepare(f.created.id, 2)).rejects.toMatchObject({ code: 'EXTERNAL_REVIEW_CHANGED' });
    await expect(f.admission.prepare(f.created.id, 3)).rejects.toMatchObject({ code: 'EXTERNAL_REVIEW_CHANGED' });
  });
  it('rejects a permit which expires while simulation is running', async () => {
    const f = await approvedFixture(), { bundle } = await f.admission.prepare(f.created.id, 2); let clock = now;
    const admission = createExternalNftAdmission({ imports: f.imports, gateway: f.gateway, now: () => clock });
    f.rpc.simulateCall.mockImplementationOnce(async () => { clock += 901_000; return { result: '0x', gasEstimate: '180000' }; });
    await expect(admission.validate(f.created.id, { expectedRevision: 2, bundle, signature: '0xab', submitter: address('8') })).rejects.toMatchObject({ code: 'EXTERNAL_PERMIT_INVALID' });
  });
});
