import type { ChainEventEnvelope } from "@b20/sdk";
import { decodeChainEvent, EventDecodingError, type EventSourceConfig } from "./decoder";
import type { BatchStore, EventBatch } from "./store";
import type { TransactionsResponse } from "./vendor/aptos/indexer/v1/raw_data";

export interface ProcessingLimits {
  maxEventsPerTransaction: number;
  maxEventDataBytes: number;
  maxTransactionsPerBatch: number;
}

export class ChainMismatchError extends Error { readonly fatal = true; }

export function decodeBatch(response: TransactionsResponse, expectedChainId: number, source: EventSourceConfig, limits: ProcessingLimits): EventBatch {
  if (response.chainId === undefined || response.chainId !== BigInt(expectedChainId)) throw new ChainMismatchError("Stream chain ID does not match the configured network");
  const transactions = response.transactions ?? [];
  if (transactions.length > limits.maxTransactionsPerBatch) throw new EventDecodingError("Stream batch exceeded the configured transaction bound");
  const events: EventBatch["events"] = [];
  let previousVersion: bigint | undefined;
  for (const transaction of transactions) {
    if (transaction.version === undefined) throw new EventDecodingError("Transaction version is missing");
    if (previousVersion !== undefined && transaction.version <= previousVersion) throw new EventDecodingError("Stream transaction versions are not strictly ordered");
    previousVersion = transaction.version;
    if (transaction.info?.success !== true) continue;
    const transactionEvents = transaction.user?.events ?? [];
    if (transactionEvents.length > limits.maxEventsPerTransaction) throw new EventDecodingError("Transaction exceeded the configured event bound");
    if (transaction.timestamp?.seconds === undefined || !transaction.info.hash) throw new EventDecodingError("Transaction time or hash is missing");
    const seconds = transaction.timestamp.seconds;
    const nanos = transaction.timestamp.nanos ?? 0;
    if (seconds < 0n || nanos < 0 || nanos >= 1_000_000_000) throw new EventDecodingError("Transaction timestamp is invalid");
    const timestampMicros = (seconds * 1_000_000n + BigInt(Math.floor(nanos / 1000))).toString();
    const transactionHash = `0x${Buffer.from(transaction.info.hash).toString("hex")}` as const;
    for (let eventIndex = 0; eventIndex < transactionEvents.length; eventIndex++) {
      const raw = transactionEvents[eventIndex]!;
      if (!raw.typeStr || raw.data === undefined) throw new EventDecodingError("Event type or JSON data is missing");
      if (Buffer.byteLength(raw.data, "utf8") > limits.maxEventDataBytes) throw new EventDecodingError("Event JSON exceeded the configured size bound");
      let data: unknown;
      try { data = JSON.parse(raw.data); } catch { throw new EventDecodingError("Event JSON could not be decoded"); }
      const envelope: ChainEventEnvelope = { chainId: expectedChainId, transactionVersion: transaction.version.toString(), eventIndex, transactionHash, timestampMicros, type: raw.typeStr, data };
      const decoded = decodeChainEvent(envelope, source);
      if (decoded) events.push(decoded);
    }
  }
  const range = response.processedRange;
  if (range?.lastVersion !== undefined && range.firstVersion !== undefined && range.lastVersion < range.firstVersion) throw new EventDecodingError("Stream processed range is inverted");
  if (range?.lastVersion !== undefined && previousVersion !== undefined && range.lastVersion < previousVersion) throw new EventDecodingError("Stream processed range precedes a returned transaction");
  // Empty filtered responses advance ONLY with an explicit server processed range.
  const lastVersion = range?.lastVersion ?? previousVersion;
  return { chainId: expectedChainId, events, ...(lastVersion !== undefined ? { nextVersion: (lastVersion + 1n).toString() } : {}) };
}

export async function processResponse(response: TransactionsResponse, store: BatchStore, expectedChainId: number, source: EventSourceConfig, limits: ProcessingLimits): Promise<EventBatch> {
  const batch = decodeBatch(response, expectedChainId, source, limits);
  if (batch.events.length || batch.nextVersion !== undefined) await store.commitBatch(batch);
  return batch;
}
