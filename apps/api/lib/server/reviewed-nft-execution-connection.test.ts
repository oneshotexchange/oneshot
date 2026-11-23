import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, zeroHash, type Abi, type Address, type Hex } from 'viem';
import { BASE_SEPOLIA_GENESIS_HASH, RpcError, type RpcReadMethod } from '@oneshot/evm';
import { parseReviewedNftManifest, reviewedNftManifestId } from '../../../../packages/evm/src/reviewed-nft';
import { REVIEWED_NFT_MARKETPLACE_ABI, REVIEWED_NFT_REGISTRY_ABI } from '../../../../packages/evm/src/reviewed-nft-abi';
import { createReviewedNftExecutionConnector, REVIEWED_NFT_EXECUTION_CONNECT_TIMEOUT_MS, type ReviewedNftExecutionConnection } from './reviewed-nft-execution-connection';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const factory = address(1), registry = address(2), marketplace = address(3), treasury = address(4);
const code: Record<string, Hex> = { [factory]: '0x60016000', [registry]: '0x60026000', [marketplace]: '0x60036000' };
const factoryAbi = parseAbi(['function treasury() view returns(address)']);
function fixture(base = false) {
  const genesis = base ? BASE_SEPOLIA_GENESIS_HASH : hash(1), chainId = base ? 84532 : 31337;
  const manifest = parseReviewedNftManifest({ schemaVersion: 1, deploymentVersion: 'oneshot-reviewed-erc721-v1', mode: base ? 'base-sepolia' : 'local', chainId, genesisHash: genesis, startBlock: '2', anchorHash: hash(2),
    oneshotFactory: { address: factory, codeHash: keccak256(code[factory]) }, registry: { address: registry, codeHash: keccak256(code[registry]) }, marketplace: { address: marketplace, codeHash: keccak256(code[marketplace]) },
    treasury, reviewAuthority: address(5), registrySalt: hash(5), marketplaceSalt: hash(6) });
  const state = { missing: new Set<string>(), moved: false, ignore: '' as string, negativeError: undefined as Error | undefined, code: undefined as Hex | undefined, getters: {} as Record<string, unknown> };
  const marketGetters: Record<string, unknown> = { MARKETPLACE_VERSION: 4n, ASSET_STANDARD: '0x80ac58cd', PLATFORM_FEE_BPS: 200n, registry, oneshotFactory: factory, treasury,
    deploymentChainId: BigInt(chainId), deploymentSalt: manifest.marketplaceSalt, MAX_LISTING_INTENT_BYTES: 384n, ROYALTY_QUOTE_GAS_LIMIT: 100000n, totalPending: 0n,
    eip712Domain: ['0x0f', 'OneshotReviewedMarketplace', '1', BigInt(chainId), marketplace, zeroHash, []] };
  const registryGetters: Record<string, unknown> = { REGISTRY_VERSION: 1n, ASSET_STANDARD: '0x80ac58cd', MAX_SIGNATURE_BYTES: 4096n, oneshotFactory: factory, oneshotFactoryCodeHash: manifest.oneshotFactory.codeHash,
    reviewAuthority: manifest.reviewAuthority, deploymentSalt: manifest.registrySalt, deploymentChainId: BigInt(chainId), eip712Domain: ['0x0f', 'OneshotReviewedCollectionRegistry', '1', BigInt(chainId), registry, zeroHash, []] };
  const rpc: ReviewedNftExecutionConnection['rpc'] = {
    verification: { mode: manifest.mode, chainId, genesisHash: genesis, latestBlock: 10n, checkedAt: new Date().toISOString(), provider: { label: 'custom', verifiedSupport: false }, genesisMatched: base ? true : null },
    readRpc: vi.fn(async (method: RpcReadMethod, params: readonly unknown[] = []): Promise<unknown> => {
      const selected = params[1], filter = params[0];
      const selectedHash = method === 'eth_getLogs' ? filter && typeof filter === 'object' && 'blockHash' in filter ? filter.blockHash : undefined
        : selected && typeof selected === 'object' && 'blockHash' in selected ? selected.blockHash : undefined;
      if (typeof selectedHash === 'string' && selectedHash !== hash(10) && selectedHash !== genesis && selectedHash !== hash(2) && state.ignore !== method) throw state.negativeError ?? new RpcError('RPC_REMOTE_ERROR', 'block-not-found');
      if (method === 'eth_blockNumber') return '0xa';
      if (method === 'eth_getBlockByNumber') {
        if (params[0] === '0x0') return { number: '0x0', hash: genesis, parentHash: zeroHash, timestamp: '0x0' };
        if (params[0] === '0x1') return { number: '0x1', hash: hash(2), parentHash: genesis, timestamp: '0x1' };
        return { number: '0xa', hash: state.moved && params[0] !== 'latest' ? hash(11) : hash(10), parentHash: hash(9), timestamp: '0x64' };
      }
      if (method === 'eth_getCode') return state.missing.has(String(params[0])) ? '0x' : params[0] === marketplace && state.code !== undefined ? state.code : code[String(params[0])];
      if (method === 'eth_getBalance') return '0x0'; if (method === 'eth_getLogs') return [];
      if (method !== 'eth_call') throw new Error('Unexpected connector RPC.');
      const call = params[0] as { to: Address; data: Hex }; if (state.missing.has(call.to)) return '0x';
      const abi: Abi = call.to === marketplace ? REVIEWED_NFT_MARKETPLACE_ABI : call.to === registry ? REVIEWED_NFT_REGISTRY_ABI : factoryAbi;
      const { functionName } = decodeFunctionData({ abi, data: call.data });
      const result = call.to === marketplace ? Object.hasOwn(state.getters, functionName) ? state.getters[functionName] : marketGetters[functionName]
        : call.to === registry ? registryGetters[functionName] : treasury;
      return encodeFunctionResult({ abi, functionName, result });
    }),
    simulateCall: vi.fn(async () => { throw new Error('A connector never simulates or broadcasts transactions.'); }),
  };
  const env: Record<string, string | undefined> = { ONESHOT_NETWORK: manifest.mode, ONESHOT_REVIEWED_NFT_EXECUTION_ENABLED: 'true', ONESHOT_REVIEWED_NFT_MANIFEST_PATH: 'owned-connector-fixture.json' };
  const loadManifest = vi.fn(async () => manifest), makeRpc = vi.fn(async () => rpc), connector = createReviewedNftExecutionConnector({ environment: () => env, loadManifest, rpc: makeRpc });
  return { connector, env, manifest, state, rpc, loadManifest, makeRpc };
}
const safeError = { code: 'REVIEWED_NFT_EXECUTION_UNAVAILABLE', message: 'External NFT transactions are currently unavailable. Please try again later.' };
afterEach(() => { vi.useRealTimers(); });

describe('independent external NFT execution connector', () => {
  it.each([false, true])('verifies the exact supported%s execution profile without simulating or broadcasting', async base => {
    const f = fixture(base), connected = await f.connector.connect({ deploymentId: reviewedNftManifestId(f.manifest) });
    expect(connected.manifestId).toBe(reviewedNftManifestId(f.manifest)); expect(connected.block.number).toBe(10n); expect(connected.rpc).toBe(f.rpc);
    expect(f.rpc.simulateCall).not.toHaveBeenCalled();
    for (const [method, params] of vi.mocked(f.rpc.readRpc).mock.calls) if (method === 'eth_call' || method === 'eth_getCode' || method === 'eth_getBalance') expect(params?.[1]).toMatchObject({ requireCanonical: true });
    // The proof deadline is not installed on the returned service RPC.
    expect(await connected.rpc.readRpc('eth_blockNumber')).toBe('0xa');
  });
  it.each([undefined, '', 'false', 'TRUE', '1'])('never inherits import/read/native opt-ins when the dedicated execution flag is%s', async flag => {
    const f = fixture(); f.env.ONESHOT_REVIEWED_NFT_EXECUTION_ENABLED = flag;
    Object.assign(f.env, { ONESHOT_REVIEWED_NFT_IMPORTS_ENABLED: 'true', ONESHOT_REVIEWED_NFT_READS_ENABLED: 'true', ONESHOT_LOCAL_NFT_EXECUTION_ENABLED: 'true', ONESHOT_BASE_SEPOLIA_NFT_EXECUTION_ENABLED: 'true' });
    expect(f.connector.enabled()).toBe(false); await expect(f.connector.connect()).rejects.toMatchObject(safeError); expect(f.loadManifest).not.toHaveBeenCalled();
  });
  it.each(['zero', 'base', 'mainnet', 'invalid'])('rejects an unsupported network before manifest or provider work:%s', async mode => {
    const f = fixture(); f.env.ONESHOT_NETWORK = mode;
    expect(f.connector.enabled()).toBe(false); await expect(f.connector.connect()).rejects.toMatchObject(safeError); expect(f.makeRpc).not.toHaveBeenCalled();
  });
  it('rejects missing manifests, wrong deployment, manifest/network mismatch and explicit Base mainnet configuration', async () => {
    const f = fixture(); f.env.ONESHOT_REVIEWED_NFT_MANIFEST_PATH = ''; await expect(f.connector.connect()).rejects.toMatchObject(safeError);
    f.env.ONESHOT_REVIEWED_NFT_MANIFEST_PATH = 'owned.json'; await expect(f.connector.connect({ deploymentId: 'f'.repeat(64) })).rejects.toMatchObject(safeError);
    f.env.ONESHOT_NETWORK = 'base-sepolia'; await expect(f.connector.connect()).rejects.toMatchObject(safeError);
    const base = fixture(true); base.env.ONESHOT_CHAIN_ID = '8453'; await expect(base.connector.connect()).rejects.toMatchObject(safeError);
  });
  it('permits disabled recovery only through the explicit recovery-only exception', async () => {
    const f = fixture(); f.env.ONESHOT_REVIEWED_NFT_EXECUTION_ENABLED = 'false';
    await expect(f.connector.connect({ recoveryOnly: true })).rejects.toMatchObject(safeError);
    await expect(f.connector.connect({ allowDisabled: true })).rejects.toMatchObject(safeError);
    await expect(f.connector.connect({ allowDisabled: true, recoveryOnly: false })).rejects.toMatchObject(safeError);
    expect((await f.connector.connect({ allowDisabled: true, recoveryOnly: true })).manifestId).toBe(reviewedNftManifestId(f.manifest));
    await expect(f.connector.connect({ allowDisabled: true, recoveryOnly: true, deploymentId: 'f'.repeat(64) })).rejects.toMatchObject(safeError);
  });
  it('recovers from the pinned market even when registry/factory contracts are unavailable, without authorizing fresh full execution', async () => {
    const f = fixture(); f.state.missing.add(registry); f.state.missing.add(factory);
    expect((await f.connector.connect({ recoveryOnly: true })).manifestId).toBe(reviewedNftManifestId(f.manifest));
    for (const [method, params] of vi.mocked(f.rpc.readRpc).mock.calls) {
      if (method === 'eth_call') expect((params?.[0] as { to: Address }).to).toBe(marketplace);
      if (method === 'eth_getCode') expect(params?.[0]).toBe(marketplace);
    }
    await expect(f.connector.connect()).rejects.toMatchObject(safeError);
  });
  it.each(['eth_getCode', 'eth_getBalance', 'eth_call'])('rejects a provider that ignores an unknown block hash for%s during recovery', async method => {
    const f = fixture(); f.state.ignore = method; await expect(f.connector.connect({ recoveryOnly: true })).rejects.toMatchObject(safeError);
  });
  it.each([new RpcError('RPC_REMOTE_ERROR'), new RpcError('RPC_HTTP_ERROR'), new Error('unknown block')])('rejects ambiguous/unclassified negative controls without exposing underlying errors', async error => {
    const f = fixture(); f.state.negativeError = error; await expect(f.connector.connect({ recoveryOnly: true })).rejects.toMatchObject(safeError);
  });
  it.each(['chain', 'genesis', 'runtime', 'version', 'salt', 'treasury', 'domain', 'reorg'])('fails changed recovery identity or domain:%s', async field => {
    const f = fixture();
    if (field === 'chain') f.rpc.verification.chainId = 84532;
    if (field === 'genesis') f.rpc.verification.genesisHash = hash(99);
    if (field === 'runtime') f.state.code = '0x60046000';
    if (field === 'version') f.state.getters.MARKETPLACE_VERSION = 3n;
    if (field === 'salt') f.state.getters.deploymentSalt = hash(99);
    if (field === 'treasury') f.state.getters.treasury = address(99);
    if (field === 'domain') f.state.getters.eip712Domain = ['0x0f', 'OneshotGuardedMarketplace', '1', 31337n, marketplace, zeroHash, []];
    if (field === 'reorg') f.state.moved = true;
    await expect(f.connector.connect({ recoveryOnly: true })).rejects.toMatchObject(safeError);
  });
  it('redacts a rejected provider error and malformed block quantities', async () => {
    const f = fixture(); f.makeRpc.mockRejectedValueOnce(new Error('https://user:secret@private-rpc.example')); await expect(f.connector.connect()).rejects.toMatchObject(safeError);
    vi.mocked(f.rpc.readRpc).mockResolvedValueOnce({ number: '0x00', hash: hash(10), parentHash: hash(9), timestamp: '0x64' });
    await expect(f.connector.connect()).rejects.toMatchObject(safeError);
  });
  it('snapshots caller options/environment before a pending manifest load', async () => {
    const f = fixture(), options = { recoveryOnly: true, deploymentId: reviewedNftManifestId(f.manifest) }; let finish!: (manifest: typeof f.manifest) => void;
    f.loadManifest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const connecting = f.connector.connect(options);
    options.recoveryOnly = false; options.deploymentId = 'f'.repeat(64); f.env.ONESHOT_NETWORK = 'zero'; finish(f.manifest);
    expect((await connecting).manifestId).toBe(reviewedNftManifestId(f.manifest));
  });
  it('bounds a stalled manifest and stops late completion before creating a provider', async () => {
    vi.useFakeTimers(); const f = fixture(); let finish!: (manifest: typeof f.manifest) => void;
    f.loadManifest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const connecting = f.connector.connect();
    const rejected = expect(connecting).rejects.toMatchObject(safeError); await vi.advanceTimersByTimeAsync(REVIEWED_NFT_EXECUTION_CONNECT_TIMEOUT_MS); await rejected;
    finish(f.manifest); await Promise.resolve(); await Promise.resolve(); expect(f.makeRpc).not.toHaveBeenCalled();
  });
  it('bounds a stalled RPC proof and prevents later proof reads after it resolves', async () => {
    vi.useFakeTimers(); const f = fixture(); let finish!: (value: unknown) => void;
    vi.mocked(f.rpc.readRpc).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const connecting = f.connector.connect({ recoveryOnly: true });
    const rejected = expect(connecting).rejects.toMatchObject(safeError); await vi.advanceTimersByTimeAsync(REVIEWED_NFT_EXECUTION_CONNECT_TIMEOUT_MS); await rejected;
    const calls = vi.mocked(f.rpc.readRpc).mock.calls.length; finish({ number: '0xa', hash: hash(10), parentHash: hash(9), timestamp: '0x64' });
    await Promise.resolve(); await Promise.resolve(); expect(vi.mocked(f.rpc.readRpc).mock.calls).toHaveLength(calls);
  });
});
