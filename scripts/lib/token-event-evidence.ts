import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';

type RpcRead = (method: string, params?: unknown[]) => Promise<unknown>;
type RpcObject = Record<string, unknown>;
export type TokenEvidenceLog = { address: Address; data: Hex; topics: Hex[]; blockNumber: string; blockHash: Hex; transactionHash: Hex; transactionIndex: number; logIndex: number; removed: false };
export type TokenEvidenceBlock = { number: string; hash: Hex; parentHash: Hex; timestamp: string; logs: TokenEvidenceLog[] };
export type TokenTransactionEvidence = Record<string, { transaction: RpcObject; receipt: RpcObject }>;
const object = (value: unknown): value is RpcObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function quantity(value: unknown) { assert(typeof value === 'string' && /^0x(?:0|[1-9a-f][\da-f]*)$/i.test(value)); return BigInt(value); }
function hash(value: unknown): Hex { assert(typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value)); return value.toLowerCase() as Hex; }
function index(value: unknown) { const result = quantity(value); assert(result <= 1_000_000n); return Number(result); }
const tag = (value: bigint) => `0x${value.toString(16)}`;

/** Test evidence from an owned local chain. Preserves full raw receipts/transactions
 * separately from the normalized indexer block/log shape; no inferred trade identity. */
export async function collectTokenEventBlock(read: RpcRead, number: bigint, addresses: Address[], transactions: TokenTransactionEvidence): Promise<TokenEvidenceBlock> {
  assert(number >= 0n && addresses.length > 0 && addresses.length <= 128);
  const block = await read('eth_getBlockByNumber', [tag(number), false]);
  assert(object(block) && quantity(block.number) === number && Array.isArray(block.transactions) && block.transactions.length <= 100);
  const blockHash = hash(block.hash), parentHash = hash(block.parentHash), timestamp = quantity(block.timestamp);
  const rawLogs = await read('eth_getLogs', [{ blockHash, address: addresses }]);
  assert(Array.isArray(rawLogs) && rawLogs.length <= 1000);
  const selected = new Set(addresses.map(value => value.toLowerCase()));
  const logs = rawLogs.map((raw): TokenEvidenceLog => {
    assert(object(raw) && typeof raw.address === 'string' && selected.has(raw.address.toLowerCase()) && raw.removed !== true);
    assert(typeof raw.data === 'string' && /^0x(?:[\da-f]{2})*$/i.test(raw.data) && raw.data.length <= 262_146);
    assert(Array.isArray(raw.topics) && raw.topics.length <= 4 && quantity(raw.blockNumber) === number && hash(raw.blockHash) === blockHash);
    return { address: raw.address.toLowerCase() as Address, data: raw.data.toLowerCase() as Hex, topics: raw.topics.map(hash), blockNumber: number.toString(), blockHash, transactionHash: hash(raw.transactionHash), transactionIndex: index(raw.transactionIndex), logIndex: index(raw.logIndex), removed: false };
  }).sort((a, b) => a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
  assert.equal(new Set(logs.map(value => value.logIndex)).size, logs.length);
  for (const transactionHash of block.transactions) {
    const selectedHash = hash(transactionHash);
    const transaction = await read('eth_getTransactionByHash', [selectedHash]), receipt = await read('eth_getTransactionReceipt', [selectedHash]);
    assert(object(transaction) && object(receipt));
    assert(hash(transaction.hash) === selectedHash && hash(receipt.transactionHash) === selectedHash);
    assert(hash(transaction.blockHash) === blockHash && hash(receipt.blockHash) === blockHash);
    assert(quantity(transaction.blockNumber) === number && quantity(receipt.blockNumber) === number);
    transactions[selectedHash] = { transaction, receipt };
  }
  for (const log of logs) assert(transactions[log.transactionHash]);
  return { number: number.toString(), hash: blockHash, parentHash, timestamp: timestamp.toString(), logs };
}

export async function collectTokenEventRange(read: RpcRead, from: bigint, to: bigint, addresses: Address[], transactions: TokenTransactionEvidence) {
  assert(from >= 1n && to >= from && to - from <= 512n);
  const blocks: TokenEvidenceBlock[] = [];
  for (let number = from; number <= to; number++) {
    const block = await collectTokenEventBlock(read, number, addresses, transactions);
    if (blocks.length) assert.equal(block.parentHash, blocks[blocks.length - 1]!.hash);
    blocks.push(block);
  }
  return blocks;
}
