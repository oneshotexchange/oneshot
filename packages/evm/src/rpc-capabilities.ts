import { keccak256, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import type { NetworkConfig } from './config';
import { createVerifiedRpc, RpcError, type RpcOptions, type RpcReadMethod } from './rpc';

/** Inputs describe an independently known deployment, never a request to deploy one. */
export type RpcCapabilityPlan = {
  chainId: number;
  genesisHash: Hex;
  checkpoint?: { number: string; hash: Hex };
  contracts: { address: Address; codeHash: Hex; call: { data: Hex; expectedResult: Hex } }[];
  expectedLog?: { address: Address; transactionHash: Hex; logIndex: string; topics: Hex[]; data: Hex };
};
export type RpcCapabilityOptions = RpcOptions & { overallTimeoutMs?: number; checkBlockCadence?: boolean };
type CheckName = 'identity' | 'checkpoint' | 'contractCode' | 'canonicalCalls' | 'callHashRejection'
  | 'blockHashLogs' | 'logHashRejection' | 'checkpointRecheck';
type Check = { status: 'not-tested' | 'passed' | 'inconclusive' | 'failed'; code?: string };
export type RpcBlockCadenceEvidence = {
  sampleBlocks: number;
  averageIntervalSeconds: number | null;
  subSecondDetected: boolean;
};
export type RpcCapabilityReport = {
  status: 'passed' | 'inconclusive' | 'failed';
  code: string | null;
  checkedAt: string;
  readOnly: true;
  mode: NetworkConfig['mode'] | null;
  chainId: number | null;
  genesisHash: Hex | null;
  checkpoint: { number: string; hash: Hex } | null;
  checks: Record<CheckName, Check>;
  evidence: {
    contractsChecked: number;
    codeSelection: 'checkpoint-number';
    callsMatched: number;
    logsObserved: number;
    expectedLogObserved: boolean;
    requests: number;
    blockCadence?: RpcBlockCadenceEvidence;
  };
  limits: { maximumRequests: number; overallTimeoutMs: number; maximumContracts: number };
  /** This probe cannot establish any of these independently. A pass never enables execution. */
  notVerified: readonly ['contractSafety', 'codeHashSelection', 'logCompleteness', 'orphanCanonicality', 'gasEstimation', 'walletSigning',
    'transactionSubmission', 'transactionReceipts', 'finality', 'nativePrecision', 'nftReadiness', 'ammReadiness'];
  executionEnabled: false;
};

const MAX_REQUESTS = 48;
const MAX_CONTRACTS = 4;
const HASH = /^0x[\da-fA-F]{64}$/;
const ADDRESS = /^0x[\da-fA-F]{40}$/;
const DATA = /^0x(?:[\da-fA-F]{2})*$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][\da-fA-F]{0,63})$/;
const DECIMAL = /^(0|[1-9]\d{0,77})$/;
const CHECKS: CheckName[] = ['identity', 'checkpoint', 'contractCode', 'canonicalCalls', 'callHashRejection', 'blockHashLogs', 'logHashRejection', 'checkpointRecheck'];
const UNVERIFIED = ['contractSafety', 'codeHashSelection', 'logCompleteness', 'orphanCanonicality', 'gasEstimation', 'walletSigning',
  'transactionSubmission', 'transactionReceipts', 'finality', 'nativePrecision', 'nftReadiness', 'ammReadiness'] as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => [...required, ...optional].includes(key));
const hexHash = (value: unknown): value is Hex => typeof value === 'string' && HASH.test(value);
const hash = (value: unknown): value is Hex => hexHash(value) && value.toLowerCase() !== zeroHash;
const address = (value: unknown): value is Address => typeof value === 'string' && ADDRESS.test(value) && value.toLowerCase() !== zeroAddress;
const data = (value: unknown, maximum = 16_386): value is Hex => typeof value === 'string' && DATA.test(value) && value.length <= maximum;
class CapabilityFailure extends Error {
  constructor(readonly code: string) { super('The bounded RPC capability check did not pass.'); }
}
const fail = (code: string): never => { throw new CapabilityFailure(code); };
function decimal(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL.test(value) && BigInt(value) < 2n ** 256n;
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !QUANTITY.test(value)) return fail('RPC_DATA_INVALID');
  return BigInt(value);
}

/** Runtime validation is shared by the library and CLI; no plan text appears in errors. */
export function parseRpcCapabilityPlan(raw: unknown): RpcCapabilityPlan {
  let value: unknown;
  try { value = structuredClone(raw); } catch { return fail('CAPABILITY_PLAN_INVALID'); }
  if (!object(value) || !exact(value, ['chainId', 'genesisHash', 'contracts'], ['checkpoint', 'expectedLog'])
    || !Number.isSafeInteger(value.chainId) || Number(value.chainId) <= 0 || !hash(value.genesisHash)
    || !Array.isArray(value.contracts) || value.contracts.length < 1 || value.contracts.length > MAX_CONTRACTS) return fail('CAPABILITY_PLAN_INVALID');
  const seen = new Set<string>();
  for (const target of value.contracts) {
    if (!object(target) || !exact(target, ['address', 'codeHash', 'call']) || !address(target.address) || !hash(target.codeHash)
      || seen.has(target.address.toLowerCase()) || !object(target.call) || !exact(target.call, ['data', 'expectedResult'])
      || !data(target.call.data) || target.call.data.length < 10 || !data(target.call.expectedResult)
      || target.call.expectedResult.length < 66 || (target.call.expectedResult.length - 2) % 64 !== 0) return fail('CAPABILITY_PLAN_INVALID');
    seen.add(target.address.toLowerCase());
  }
  if (value.checkpoint !== undefined && (!object(value.checkpoint) || !exact(value.checkpoint, ['number', 'hash'])
    || !decimal(value.checkpoint.number) || !hash(value.checkpoint.hash))) return fail('CAPABILITY_PLAN_INVALID');
  if (value.expectedLog !== undefined) {
    const log = value.expectedLog;
    if (!object(log) || !exact(log, ['address', 'transactionHash', 'logIndex', 'topics', 'data']) || !address(log.address)
      || !seen.has(log.address.toLowerCase()) || !hash(log.transactionHash) || !decimal(log.logIndex)
      || !Array.isArray(log.topics) || log.topics.length > 4 || !log.topics.every(hexHash) || !data(log.data, 131_074)) return fail('CAPABILITY_PLAN_INVALID');
    // An expected event belongs to a known block, not whichever head the provider happens to return.
    if (value.checkpoint === undefined) return fail('CAPABILITY_PLAN_INVALID');
  }
  return value as RpcCapabilityPlan;
}

function block(value: unknown, number: bigint, expectedHash?: Hex) {
  if (!object(value) || quantity(value.number) !== number || !hash(value.hash)
    || typeof value.parentHash !== 'string' || !HASH.test(value.parentHash) || quantity(value.timestamp) < 0n) return fail('RPC_DATA_INVALID');
  const observed = value.hash.toLowerCase() as Hex;
  if (expectedHash && observed !== expectedHash.toLowerCase()) return fail('CHECKPOINT_CHANGED');
  return { number: number.toString(), hash: observed, parentHash: value.parentHash.toLowerCase(), timestamp: quantity(value.timestamp).toString() };
}

function inspectLogs(raw: unknown, checkpoint: { number: string; hash: Hex }, plan: RpcCapabilityPlan) {
  if (!Array.isArray(raw) || raw.length > 1000) return fail('RPC_LOGS_INVALID');
  const addresses = new Set(plan.contracts.map(target => target.address.toLowerCase()));
  const transactions = new Map<bigint, string>(), transactionIndices = new Map<string, bigint>();
  let previousLog = -1n, previousTransaction = -1n, observed = false;
  for (const log of raw) {
    if (!object(log) || !address(log.address) || !addresses.has(log.address.toLowerCase()) || log.removed !== false
      || !hash(log.blockHash) || log.blockHash.toLowerCase() !== checkpoint.hash || quantity(log.blockNumber).toString() !== checkpoint.number
      || !hash(log.transactionHash) || !Array.isArray(log.topics) || log.topics.length > 4 || !log.topics.every(hexHash)
      || !data(log.data, 131_074)) return fail('RPC_LOGS_INVALID');
    const index = quantity(log.logIndex), transaction = quantity(log.transactionIndex), transactionHash = log.transactionHash.toLowerCase();
    if (index <= previousLog || transaction < previousTransaction || index > BigInt(Number.MAX_SAFE_INTEGER)
      || transaction > BigInt(Number.MAX_SAFE_INTEGER) || transactions.has(transaction) && transactions.get(transaction) !== transactionHash
      || transactionIndices.has(transactionHash) && transactionIndices.get(transactionHash) !== transaction) return fail('RPC_LOGS_INVALID');
    transactions.set(transaction, transactionHash); transactionIndices.set(transactionHash, transaction);
    previousLog = index; previousTransaction = transaction;
    const expected = plan.expectedLog;
    if (expected && expected.address.toLowerCase() === log.address.toLowerCase() && expected.transactionHash.toLowerCase() === transactionHash
      && expected.logIndex === index.toString() && expected.data.toLowerCase() === log.data.toLowerCase()
      && expected.topics.length === log.topics.length && expected.topics.every((topic, i) => topic.toLowerCase() === String((log.topics as unknown[])[i]).toLowerCase())) observed = true;
  }
  if (plan.expectedLog && !observed) return fail('EXPECTED_LOG_MISSING');
  return { count: raw.length, expectedObserved: observed };
}

/**
 * Read-only evidence for explicit known bytecode, ABI returns and one exact event block.
 * Hash-selection negative controls must reject a nonexistent (zero) block hash.
 * They do not establish orphan handling, exhaustive logs, simulation or readiness.
 */
export async function probeRpcCapabilities(config: NetworkConfig, rawPlan: unknown, options: RpcCapabilityOptions = {}): Promise<RpcCapabilityReport> {
  const overallTimeoutMs = options.overallTimeoutMs ?? 30_000;
  const report: RpcCapabilityReport = {
    status: 'failed', code: null, checkedAt: new Date().toISOString(), readOnly: true,
    mode: null, chainId: null, genesisHash: null, checkpoint: null,
    checks: Object.fromEntries(CHECKS.map(name => [name, { status: 'not-tested' }])) as Record<CheckName, Check>,
    evidence: { contractsChecked: 0, codeSelection: 'checkpoint-number', callsMatched: 0, logsObserved: 0, expectedLogObserved: false, requests: 0 },
    limits: { maximumRequests: MAX_REQUESTS, overallTimeoutMs: typeof overallTimeoutMs === 'number' && Number.isFinite(overallTimeoutMs) ? overallTimeoutMs : 30_000, maximumContracts: MAX_CONTRACTS },
    notVerified: UNVERIFIED, executionEnabled: false,
  };
  let current: CheckName = 'identity';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const finish = () => structuredClone(report);
  try {
    if (typeof window !== 'undefined') throw new RpcError('SERVER_ONLY');
    if (!Number.isInteger(overallTimeoutMs) || overallTimeoutMs < 1000 || overallTimeoutMs > 60_000) fail('CAPABILITY_OPTIONS_INVALID');
    const plan = parseRpcCapabilityPlan(rawPlan);
    // Snapshot options/config before I/O; caller mutation cannot retarget an active probe.
    const profile = structuredClone(config);
    if (profile.chainId !== plan.chainId || profile.genesisHash !== null && profile.genesisHash.toLowerCase() !== plan.genesisHash.toLowerCase()) fail('CAPABILITY_IDENTITY_MISMATCH');
    const transport = options.fetch ?? globalThis.fetch;
    const methodRequests = new Map<string, number>();
    const fetcher: typeof fetch = async (input, init) => {
      if (controller.signal.aborted) fail('CAPABILITY_DEADLINE');
      if (report.evidence.requests >= MAX_REQUESTS) fail('CAPABILITY_REQUEST_LIMIT');
      report.evidence.requests++;
      const request = JSON.parse(String(init?.body)) as { method: string };
      methodRequests.set(request.method, (methodRequests.get(request.method) ?? 0) + 1);
      return transport(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
    };
    const run = async () => {
      const rpc = await createVerifiedRpc(profile, { fetch: fetcher, provider: options.provider, timeoutMs: options.timeoutMs });
      const read = async (method: RpcReadMethod, params: readonly unknown[] = []) => {
        if (controller.signal.aborted) fail('CAPABILITY_DEADLINE');
        return rpc.readRpc(method, params);
      };
      if (rpc.verification.chainId !== plan.chainId || rpc.verification.genesisHash.toLowerCase() !== plan.genesisHash.toLowerCase()) fail('CAPABILITY_IDENTITY_MISMATCH');
      report.mode = rpc.verification.mode; report.chainId = plan.chainId; report.genesisHash = plan.genesisHash.toLowerCase() as Hex;
      report.checks.identity = { status: 'passed' };
      current = 'checkpoint';
      const height = plan.checkpoint ? BigInt(plan.checkpoint.number) : rpc.verification.latestBlock;
      if (height > rpc.verification.latestBlock) fail('CHECKPOINT_AHEAD');
      const tag = `0x${height.toString(16)}`;
      const pinned = block(await read('eth_getBlockByNumber', [tag, false]), height, plan.checkpoint?.hash);
      report.checkpoint = { number: pinned.number, hash: pinned.hash }; report.checks.checkpoint = { status: 'passed' };
      current = 'contractCode';
      for (const target of plan.contracts) {
        const code = await read('eth_getCode', [target.address, tag]);
        if (!data(code, 131_074) || code === '0x' || keccak256(code).toLowerCase() !== target.codeHash.toLowerCase()) fail('CONTRACT_CODE_MISMATCH');
        report.evidence.contractsChecked++;
      }
      report.checks.contractCode = { status: 'passed' };
      current = 'canonicalCalls';
      for (const target of plan.contracts) {
        const result = await read('eth_call', [{ to: target.address, data: target.call.data }, { blockHash: pinned.hash, requireCanonical: true }]);
        if (!data(result) || result.toLowerCase() !== target.call.expectedResult.toLowerCase()) fail('CONTRACT_CALL_MISMATCH');
        report.evidence.callsMatched++;
      }
      report.checks.canonicalCalls = { status: 'passed' };
      const rejectUnknownHash = async (method: RpcReadMethod, params: readonly unknown[]) => {
        const before = methodRequests.get(method) ?? 0;
        try { await read(method, params); }
        catch (error) {
          // A failure during the reader's preceding identity checks is not evidence
          // that the requested negative-control method rejected an unknown hash.
          if (error instanceof RpcError && error.code === 'RPC_REMOTE_ERROR' && error.remoteRejection === 'block-not-found'
            && (methodRequests.get(method) ?? 0) > before) return;
          throw error;
        }
        fail('BLOCK_HASH_IGNORED');
      };
      current = 'callHashRejection';
      await rejectUnknownHash('eth_call', [{ to: plan.contracts[0].address, data: plan.contracts[0].call.data }, { blockHash: zeroHash, requireCanonical: true }]);
      report.checks.callHashRejection = { status: 'passed' };
      current = 'blockHashLogs';
      const addresses = plan.contracts.map(target => target.address);
      const logs = inspectLogs(await read('eth_getLogs', [{ address: addresses, blockHash: pinned.hash }]), report.checkpoint!, plan);
      report.evidence.logsObserved = logs.count; report.evidence.expectedLogObserved = logs.expectedObserved;
      report.checks.blockHashLogs = { status: logs.expectedObserved ? 'passed' : 'inconclusive', ...(!logs.expectedObserved ? { code: 'EXPECTED_LOG_NOT_SUPPLIED' } : {}) };
      current = 'logHashRejection';
      await rejectUnknownHash('eth_getLogs', [{ address: addresses, blockHash: zeroHash }]);
      report.checks.logHashRejection = { status: 'passed' };
      current = 'checkpointRecheck';
      const rechecked = block(await read('eth_getBlockByNumber', [tag, false]), height, pinned.hash);
      if (rechecked.parentHash !== pinned.parentHash || rechecked.timestamp !== pinned.timestamp) fail('CHECKPOINT_CHANGED');
      report.checks.checkpointRecheck = { status: 'passed' };
      if (options.checkBlockCadence === true) {
        const timestamps: bigint[] = [BigInt(pinned.timestamp)];
        for (let offset = 1n; offset <= 3n && offset <= height; offset += 1n) {
          if (report.evidence.requests > MAX_REQUESTS - 3) break;
          const priorNumber = height - offset;
          const prior = block(await read('eth_getBlockByNumber', [`0x${priorNumber.toString(16)}`, false]), priorNumber);
          timestamps.unshift(BigInt(prior.timestamp));
        }
        const deltas: number[] = [];
        for (let i = 1; i < timestamps.length; i += 1) {
          const diff = Number(timestamps[i]! - timestamps[i - 1]!);
          if (Number.isFinite(diff) && diff >= 0) deltas.push(diff);
        }
        report.evidence.blockCadence = {
          sampleBlocks: timestamps.length,
          averageIntervalSeconds: deltas.length ? deltas.reduce((sum, val) => sum + val, 0) / deltas.length : null,
          subSecondDetected: deltas.some(delta => delta === 0),
        };
      }
      report.status = logs.expectedObserved ? 'passed' : 'inconclusive';
      report.code = logs.expectedObserved ? null : 'EXPECTED_LOG_NOT_SUPPLIED';
    };
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new CapabilityFailure('CAPABILITY_DEADLINE')); }, overallTimeoutMs); });
    await Promise.race([run(), deadline]);
    return finish();
  } catch (error) {
    report.status = 'failed';
    report.code = controller.signal.aborted ? 'CAPABILITY_DEADLINE'
      : error instanceof CapabilityFailure || error instanceof RpcError ? error.code : 'CAPABILITY_UNAVAILABLE';
    report.checks[current] = { status: 'failed', code: report.code };
    return finish();
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
