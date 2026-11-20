import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import { RpcError } from '@oneshot/evm';
import { VerifiedReviewedNftSource, reviewedNftManifestId, type ReviewedNftRpc } from '../../../packages/evm/src/reviewed-nft';
import { REVIEWED_NFT_MARKETPLACE_ABI } from '../../../packages/evm/src/reviewed-nft-abi';
import { VerifiedReviewedNftJournalSource, normalizeReviewedNftLogs } from '../src/reviewed-nft-source';
import { rManifest as m, rBlock, rTransfer, ra, rh } from './reviewed-nft-fixture';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const block = rBlock(1), state = { missingIgnored: false, moved: false, pending: 0n, balance: 100n, next: 1n, code: '0x6002', logs: [] as unknown[] };
  const readRpc = vi.fn(async (method: string, params: readonly unknown[] = []): Promise<unknown> => {
    const selector = (method === 'eth_getLogs' ? params[0] : params[1]) as { blockHash?: string } | undefined;
    if (selector?.blockHash && selector.blockHash !== block.hash) {
      if (!state.missingIgnored) throw new RpcError('RPC_REMOTE_ERROR', 'block-not-found');
      return method === 'eth_getLogs' ? [] : method === 'eth_getCode' ? state.code : '0x0';
    }
    if (method === 'eth_getBlockByNumber') return { number: '0x1', hash: state.moved ? rh(555) : block.hash, parentHash: block.parentHash, timestamp: `0x${block.timestamp.toString(16)}` };
    if (method === 'eth_blockNumber') return '0x1';
    if (method === 'eth_getCode') return state.code;
    if (method === 'eth_getBalance') return `0x${state.balance.toString(16)}`;
    if (method === 'eth_getLogs') return state.logs;
    if (method === 'eth_call') { const call = decodeFunctionData({ abi: REVIEWED_NFT_MARKETPLACE_ABI, data: (params[0] as { data: Hex }).data }); return encodeFunctionResult({ abi: REVIEWED_NFT_MARKETPLACE_ABI, functionName: call.functionName, result: call.functionName === 'nextListingId' ? state.next : state.pending }); }
    throw Error('Unexpected test RPC');
  });
  const rpc: ReviewedNftRpc = { verification: { mode: 'local', chainId: 31337, genesisHash: m.genesisHash, latestBlock: 1n, checkedAt: '2026-11-20T00:00:00.000Z', provider: { label: 'custom', verifiedSupport: false }, genesisMatched: null }, readRpc };
  return { state, block, readRpc, source: new VerifiedReviewedNftJournalSource(rpc) };
}
describe('reviewed NFT journal RPC transport', () => {
  it('retains the full shared identity proof and checks unknown block rejection for all required hash selectors', async () => {
    const f = fixture(), core = vi.spyOn(VerifiedReviewedNftSource.prototype, 'verify').mockResolvedValue({ manifest: m, manifestId: reviewedNftManifestId(m), block: f.block });
    await f.source.verify(m, f.block); expect(core).toHaveBeenCalledWith(m, f.block);
    expect(f.readRpc.mock.calls.map(call => call[0])).toEqual(['eth_getCode', 'eth_call', 'eth_getBalance', 'eth_getLogs', 'eth_getBlockByNumber']);
  });
  it('rejects a provider which ignores blockHash even for an empty log response', async () => {
    const f = fixture(); f.state.missingIgnored = true;
    await expect(f.source.logs(f.block, [ra(10)])).rejects.toMatchObject({ code: 'REVIEWED_NFT_HASH_SELECTOR_UNVERIFIED' });
  });
  it('rejects generic RPC failure as proof of hash-selector support', async () => {
    const f = fixture(), read = f.readRpc.getMockImplementation()!;
    f.readRpc.mockImplementation(async (method, params) => { if (method === 'eth_getLogs') throw new RpcError('RPC_UNAVAILABLE'); return read(method, params); });
    await expect(f.source.logs(f.block, [ra(10)])).rejects.toMatchObject({ code: 'REVIEWED_NFT_HASH_SELECTOR_UNVERIFIED' });
  });
  it('batches exact-hash address reads and rejects removed/out-of-scope/duplicate log responses', async () => {
    const f = fixture(); await f.source.logs(f.block, Array.from({ length: 10 }, (_, i) => ra(i + 10)));
    const positive = f.readRpc.mock.calls.filter(([method, params]) => method === 'eth_getLogs' && (params?.[0] as { blockHash: string }).blockHash === f.block.hash);
    expect(positive.map(([, params]) => (params![0] as { address: string[] }).address.length)).toEqual([8, 2]);
    const raw = rTransfer(f.block, 1, ra(4), ra(5));
    const wire = { ...raw, removed: false, blockNumber: '0x1', logIndex: '0x1', transactionIndex: '0x0' };
    for (const bad of [{ ...wire, removed: true }, { ...wire, address: ra(99) }, { ...wire, blockHash: rh(99) }, { ...wire, logIndex: '0x01' }]) {
      f.state.logs = [bad]; await expect(f.source.logs(f.block, [ra(10)])).rejects.toBeDefined();
    }
    f.state.logs = [wire, wire]; await expect(f.source.logs(f.block, [ra(10)])).rejects.toMatchObject({ code: 'REVIEWED_NFT_LOG_ORDER_INVALID' });
  });
  it('checks exact code, pending collateral and the next listing counter at one canonical block', async () => {
    const f = fixture(); expect(await f.source.accounting(m, f.block)).toEqual({ pending: '0', balance: '100', nextListingId: '1', marketDeployed: true });
    for (const [method, params] of f.readRpc.mock.calls) if (method === 'eth_call' && (params?.[1] as { blockHash: string }).blockHash === f.block.hash) expect(params?.[1]).toEqual({ blockHash: f.block.hash, requireCanonical: true });
    f.state.pending = 101n; await expect(f.source.accounting(m, f.block)).rejects.toMatchObject({ code: 'REVIEWED_NFT_INSOLVENT' });
    f.state.pending = 0n; f.state.code = '0x6003'; await expect(f.source.accounting(m, f.block)).rejects.toMatchObject({ code: 'REVIEWED_NFT_CODE_MISMATCH' });
  });
  it('distinguishes a predeployment market from a zero-liability deployed market', async () => {
    const f = fixture(); f.state.code = '0x'; expect(await f.source.accounting(m, f.block)).toEqual({ pending: '0', balance: '100', nextListingId: '1', marketDeployed: false });
  });
  it('does not accept a changed canonical block during collection capture', async () => {
    const f = fixture(); f.state.moved = true; await expect(f.source.logs(f.block, [ra(10)])).rejects.toMatchObject({ code: 'REVIEWED_NFT_CHAIN_MOVED' });
  });
  it('normalizes case but never permits unrequested sources or contradictory transaction indexes', () => {
    const block = rBlock(1), a = rTransfer(block, 1, ra(4), ra(5)), b = { ...rTransfer(block, 2, ra(5), ra(6)), transactionHash: rh(777) };
    expect(normalizeReviewedNftLogs(block, [a], [ra(10)])[0]).toEqual(a);
    expect(() => normalizeReviewedNftLogs(block, [a], [ra(11)])).toThrow(); expect(() => normalizeReviewedNftLogs(block, [a, b])).toThrow();
  });
});
