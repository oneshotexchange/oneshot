import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, zeroAddress, type Address, type Hex } from 'viem';
import type { RpcReadMethod, RpcVerification } from '@oneshot/evm';
import { VerifiedRpcSource } from '../src/rpc-source';
import type { Block, Manifest } from '../src/types';

const hash = (value: number): Hex => `0x${value.toString(16).padStart(64, '0')}`;
const address = (value: number): Address => `0x${value.toString(16).padStart(40, '0')}`;
const factory = address(1), market = address(2), treasury = address(3);
const codeFactory = '0x6001' as Hex, codeMarket = '0x6002' as Hex;
const manifest: Manifest = {
  schemaVersion: 1, deploymentVersion: 'oneshot-nft-v1', mode: 'local', chainId: 31337,
  genesisHash: hash(100), startBlock: 2n, anchorHash: hash(101),
  factory: { address: factory, codeHash: keccak256(codeFactory) }, marketplace: { address: market, codeHash: keccak256(codeMarket) },
};
const block: Block = { number: 2n, hash: hash(102), parentHash: manifest.anchorHash, timestamp: 20n };
const wordAddress = (value: Address) => encodeAbiParameters(parseAbiParameters('address'), [value]);
const rpcBlock = (number: number) => ({ number: `0x${number.toString(16)}`, hash: hash(100 + number), parentHash: hash(99 + number), timestamp: '0x14' });
const rpcLog = (source: Address = factory, index = 0) => ({
  address: source, removed: false, blockNumber: '0x2', blockHash: block.hash,
  transactionHash: hash(500), transactionIndex: '0x0', logIndex: `0x${index.toString(16)}`,
  data: '0x', topics: [hash(600)],
});
const authorizationAbi = parseAbi(['function listingAuthority() view returns (address)', 'function deploymentSalt() view returns (bytes32)']);
const guardedManifest: Manifest = { ...manifest, deploymentVersion: 'oneshot-nft-v2',
  listingAuthorization: { authority: address(4), salt: hash(700) } };

function fixture() {
  const verification: RpcVerification = {
    mode: 'local', chainId: 31337, genesisHash: manifest.genesisHash, latestBlock: 2n,
    checkedAt: '2026-10-22T00:00:00Z', provider: { label: 'custom', verifiedSupport: false }, genesisMatched: null,
  };
  const state = {
    blocks: new Map<number, unknown>([[0, rpcBlock(0)], [1, rpcBlock(1)], [2, rpcBlock(2)]]),
    factoryCode: codeFactory as unknown, marketCode: codeMarket as unknown,
    factoryReference: wordAddress(factory) as unknown,
    factoryTreasury: wordAddress(treasury) as unknown, marketTreasury: wordAddress(treasury) as unknown,
    listingAuthority: wordAddress(address(4)) as unknown, deploymentSalt: hash(700) as unknown,
    height: '0x2' as unknown,
    logs: (_filter: { address: Address[]; blockHash: Hex }): unknown => [],
  };
  const readRpc = vi.fn(async (method: RpcReadMethod, params: readonly unknown[] = []): Promise<unknown> => {
    if (method === 'eth_blockNumber') return state.height;
    if (method === 'eth_getBlockByNumber') return state.blocks.get(Number(BigInt(params[0] as string)));
    if (method === 'eth_getCode') return params[0] === factory ? state.factoryCode : state.marketCode;
    if (method === 'eth_getLogs') return state.logs(params[0] as Parameters<typeof state.logs>[0]);
    if (method === 'eth_call') {
      const request = params[0] as { to: Address; data: Hex };
      // factory() selector is distinct from treasury(); the exact call encoding is asserted below.
      if (request.data === '0xc45a0155') return state.factoryReference;
      if (request.data === encodeFunctionData({ abi: authorizationAbi, functionName: 'listingAuthority' })) return state.listingAuthority;
      if (request.data === encodeFunctionData({ abi: authorizationAbi, functionName: 'deploymentSalt' })) return state.deploymentSalt;
      return request.to === factory ? state.factoryTreasury : state.marketTreasury;
    }
    throw new Error(`Unexpected read: ${method}`);
  });
  const source = new VerifiedRpcSource({ verification, readRpc });
  return { source, verification, readRpc, state };
}

describe('verified local RPC source', () => {
  it('checks guarded immutable authority and deployment salt in addition to existing identities', async () => {
    const { source, readRpc } = fixture();
    await source.verify(guardedManifest);
    expect(readRpc.mock.calls.slice(-2)).toEqual(['listingAuthority', 'deploymentSalt'].map(functionName =>
      ['eth_call', [{ to: market, data: encodeFunctionData({ abi: authorizationAbi,
        functionName: functionName as 'listingAuthority' | 'deploymentSalt' }) }, 'latest']]));
  });

  it.each(['listingAuthority', 'deploymentSalt'] as const)('refuses a guarded %s mismatch', async field => {
    const { source, state } = fixture();
    state[field] = field === 'listingAuthority' ? wordAddress(address(999)) : hash(999);
    await expect(source.verify(guardedManifest)).rejects.toMatchObject({ code:
      field === 'listingAuthority' ? 'LISTING_AUTHORITY_MISMATCH' : 'DEPLOYMENT_SALT_MISMATCH' });
  });

  it.each(['listingAuthority', 'deploymentSalt'] as const)('refuses malformed guarded %s return data', async field => {
    const { source, state } = fixture();
    state[field] = '0x01';
    await expect(source.verify(guardedManifest)).rejects.toMatchObject({ code: 'RPC_DATA_INVALID' });
  });

  it('checks identity, deployment anchor, bytecode, factory and treasury references without a public RPC', async () => {
    const { source, readRpc } = fixture();
    await source.verify(manifest);
    expect(readRpc.mock.calls).toEqual([
      ['eth_getBlockByNumber', ['0x0', false]], ['eth_getBlockByNumber', ['0x1', false]],
      ['eth_getCode', [factory, 'latest']], ['eth_getCode', [market, 'latest']],
      ['eth_call', [{ to: market, data: '0xc45a0155' }, 'latest']],
      ['eth_call', [{ to: factory, data: '0x61d027b3' }, 'latest']],
      ['eth_call', [{ to: market, data: '0x61d027b3' }, 'latest']],
    ]);
  });

  it.each(['mode', 'chain', 'genesis'] as const)('refuses a mismatched verified %s before any read', async mismatch => {
    const { source, verification, readRpc } = fixture();
    if (mismatch === 'mode') verification.mode = 'zero';
    if (mismatch === 'chain') verification.chainId = 1;
    if (mismatch === 'genesis') verification.genesisHash = hash(999);
    await expect(source.verify(manifest)).rejects.toMatchObject({ code: 'CHAIN_IDENTITY_MISMATCH' });
    expect(readRpc).not.toHaveBeenCalled();
  });

  it('refuses a live genesis mismatch even when the verification snapshot matched', async () => {
    const { source, state } = fixture();
    state.blocks.set(0, { ...rpcBlock(0), hash: hash(999) });
    await expect(source.verify(manifest)).rejects.toMatchObject({ code: 'CHAIN_IDENTITY_MISMATCH' });
  });

  it('refuses a changed deployment anchor before reading deployed contracts', async () => {
    const { source, state, readRpc } = fixture();
    state.blocks.set(1, { ...rpcBlock(1), hash: hash(999) });
    await expect(source.verify(manifest)).rejects.toMatchObject({ code: 'DEPLOYMENT_ANCHOR_CHANGED' });
    expect(readRpc.mock.calls.every(([method]) => method === 'eth_getBlockByNumber')).toBe(true);
  });

  it.each(['factoryCode', 'marketCode'] as const)('refuses missing or changed %s', async field => {
    for (const value of ['0x', '0x6003', '0x0', null]) {
      const { source, state } = fixture();
      state[field] = value;
      await expect(source.verify(manifest)).rejects.toMatchObject({ code: 'CONTRACT_CODE_MISMATCH' });
    }
  });

  it('refuses a marketplace that references a different factory', async () => {
    const { source, state } = fixture();
    state.factoryReference = wordAddress(address(999));
    await expect(source.verify(manifest)).rejects.toMatchObject({ code: 'FACTORY_REFERENCE_MISMATCH' });
  });

  it.each(['zero', 'different'] as const)('refuses %s treasury references', async mismatch => {
    const { source, state } = fixture();
    if (mismatch === 'zero') state.factoryTreasury = wordAddress(zeroAddress);
    else state.marketTreasury = wordAddress(address(999));
    await expect(source.verify(manifest)).rejects.toMatchObject({ code: 'TREASURY_REFERENCE_MISMATCH' });
  });

  it.each(['0x', '0x01', null])('refuses malformed immutable-reference return data: %s', async value => {
    const { source, state } = fixture();
    state.factoryReference = value;
    await expect(source.verify(manifest)).rejects.toMatchObject({ code: 'RPC_DATA_INVALID' });
  });

  it('reads quantities as bigint and canonical blocks as normalized hashes', async () => {
    const { source, state } = fixture();
    state.height = '0x20000000000001';
    expect(await source.height()).toBe(9_007_199_254_740_993n);
    expect(await source.block(2n)).toEqual(block);
  });

  it.each(['0x00', '0x01', '0x-1', 2, null, 'latest'])('rejects a malformed height quantity: %s', async value => {
    const { source, state } = fixture();
    state.height = value;
    await expect(source.height()).rejects.toMatchObject({ code: 'RPC_DATA_INVALID' });
  });

  it.each([null, { ...rpcBlock(2), number: '0x3' }, { ...rpcBlock(2), hash: '0x123' }, { ...rpcBlock(2), timestamp: '0x01' }])
    ('rejects missing, mismatched or malformed blocks: %j', async value => {
      const { source, state } = fixture();
      state.blocks.set(2, value);
      await expect(source.block(2n)).rejects.toMatchObject({ code: 'RPC_DATA_INVALID' });
    });

  it('rejects negative block requests without reading the RPC', async () => {
    const { source, readRpc } = fixture();
    await expect(source.block(-1n)).rejects.toMatchObject({ code: 'RPC_DATA_INVALID' });
    expect(readRpc).not.toHaveBeenCalled();
  });

  it('deduplicates addresses and chunks one-block log reads to at most eight sources', async () => {
    const { source, state, readRpc } = fixture();
    const addresses = Array.from({ length: 17 }, (_, index) => address(index + 1));
    state.logs = filter => [rpcLog(filter.address[0], filter.address[0] === addresses[0] ? 16 : filter.address[0] === addresses[8] ? 2 : 10)];
    const logs = await source.logs(block, [...addresses, addresses[0]]);
    expect(readRpc.mock.calls).toEqual([
      ['eth_getLogs', [{ address: addresses.slice(0, 8), blockHash: block.hash }]],
      ['eth_getLogs', [{ address: addresses.slice(8, 16), blockHash: block.hash }]],
      ['eth_getLogs', [{ address: addresses.slice(16), blockHash: block.hash }]],
    ]);
    expect(logs.map(log => log.logIndex)).toEqual([2, 10, 16]);
    expect(logs[0]).toMatchObject({ blockNumber: 2n, blockHash: block.hash, transactionIndex: 0 });
  });

  it('binds even an empty response to the supplied hash so a temporary fork cannot omit canonical logs', async () => {
    const { source, readRpc } = fixture();
    expect(await source.logs(block, [factory, market])).toEqual([]);
    expect(readRpc.mock.calls).toEqual([
      ['eth_getLogs', [{ address: [factory, market], blockHash: block.hash }]],
    ]);
  });

  it.each([
    ['removed', { removed: true }], ['missing removal flag', { removed: undefined }],
    ['unrequested source', { address: address(999) }], ['wrong block', { blockNumber: '0x3' }],
    ['wrong hash', { blockHash: hash(999) }], ['malformed data', { data: '0x0' }],
    ['malformed topic', { topics: ['0x01'] }], ['too many topics', { topics: Array(5).fill(hash(600)) }],
    ['malformed transaction', { transactionHash: '0x01' }], ['noncanonical index', { logIndex: '0x01' }],
    ['unsafe log index', { logIndex: '0x20000000000000' }], ['unsafe transaction index', { transactionIndex: '0x20000000000000' }],
    ['negative transaction index', { transactionIndex: '0x-1' }], ['oversized data', { data: `0x${'00'.repeat(65_537)}` }],
  ])('rejects %s logs', async (_label, patch) => {
    const { source, state } = fixture();
    state.logs = () => [{ ...rpcLog(), ...patch }];
    await expect(source.logs(block, [factory])).rejects.toMatchObject({ code: 'RPC_DATA_INVALID' });
  });

  it('rejects a source belonging to a later chunk in the wrong chunk response', async () => {
    const { source, state } = fixture();
    const addresses = Array.from({ length: 9 }, (_, index) => address(index + 1));
    state.logs = () => [rpcLog(addresses[8])];
    await expect(source.logs(block, addresses)).rejects.toMatchObject({ code: 'RPC_DATA_INVALID' });
  });

  it('rejects duplicate log positions across distinct address chunks', async () => {
    const { source, state } = fixture();
    const addresses = Array.from({ length: 9 }, (_, index) => address(index + 1));
    state.logs = filter => [rpcLog(filter.address[0], 7)];
    await expect(source.logs(block, addresses)).rejects.toMatchObject({ code: 'DUPLICATE_LOG' });
  });

  it.each([{ addresses: [] }, { addresses: Array<Address>(4097).fill(factory) }, { addresses: ['0x123' as Address] }])('bounds address requests before the RPC read', async ({ addresses }) => {
    const { source, readRpc } = fixture();
    await expect(source.logs(block, addresses)).rejects.toMatchObject({ code: 'SOURCE_LIMIT' });
    expect(readRpc).not.toHaveBeenCalled();
  });

  it.each([{ result: null }, { result: {} }, { result: Array(10_001).fill(rpcLog()) }])('bounds and validates each log response', async ({ result }) => {
    const { source, state } = fixture();
    state.logs = () => result;
    await expect(source.logs(block, [factory])).rejects.toMatchObject({ code: 'RPC_DATA_INVALID' });
  });

  it('bounds the combined log result across individually valid chunks', async () => {
    const { source, state } = fixture();
    const addresses = Array.from({ length: 9 }, (_, index) => address(index + 1));
    state.logs = filter => Array.from({ length: 6000 }, (_, index) => rpcLog(filter.address[0], index + (filter.address[0] === factory ? 0 : 6000)));
    await expect(source.logs(block, addresses)).rejects.toMatchObject({ code: 'SOURCE_LIMIT' });
  });
});
