import { credentials, Metadata } from "@grpc/grpc-js";
import { normalizeAddress, type EnvironmentConfig } from "@b20/sdk";
import { RawDataClient, type TransactionsResponse, type GetTransactionsRequest } from "./vendor/aptos/indexer/v1/raw_data";
import type { BooleanTransactionFilter } from "./vendor/aptos/indexer/v1/filter";

export function transactionFilter(b20PackageAddress: string, hyperionPackageAddress?: string): BooleanTransactionFilter {
  const sources: BooleanTransactionFilter[] = [{ apiFilter: { eventFilter: { structType: { address: normalizeAddress(b20PackageAddress) } } } }];
  if (hyperionPackageAddress) sources.push({ apiFilter: { eventFilter: { structType: { address: normalizeAddress(hyperionPackageAddress), module: "pool_v3" } } } });
  return { logicalAnd: { filters: [{ apiFilter: { transactionRootFilter: { success: true } } }, { logicalOr: { filters: sources } }] } };
}

export interface StreamConnection {
  responses: AsyncIterable<TransactionsResponse>;
  close(): void;
}

export function openTransactionStream(config: EnvironmentConfig, nextVersion: string, signal: AbortSignal): StreamConnection {
  if (!config.GEOMI_API_KEY || !config.B20_PACKAGE_ADDRESS) throw new Error("Aptos stream credentials and B20 package are required");
  const client = new RawDataClient(config.APTOS_GRPC_ENDPOINT, credentials.createSsl(), { "grpc.max_receive_message_length": config.B20_STREAM_MAX_MESSAGE_BYTES, "grpc.keepalive_time_ms": 30_000, "grpc.keepalive_timeout_ms": 10_000 });
  const metadata = new Metadata();
  metadata.set("authorization", `Bearer ${config.GEOMI_API_KEY}`);
  metadata.set("x-aptos-request-name", "b20-testnet-indexer");
  const request: GetTransactionsRequest = { startingVersion: BigInt(nextVersion), batchSize: BigInt(config.B20_STREAM_BATCH_SIZE), transactionFilter: transactionFilter(config.B20_PACKAGE_ADDRESS, config.HYPERION_ENABLED ? config.HYPERION_PACKAGE_ADDRESS : undefined) };
  const stream = client.getTransactions(request, metadata);
  const close = () => { stream.cancel(); client.close(); };
  signal.addEventListener("abort", close, { once: true });
  return { responses: stream as AsyncIterable<TransactionsResponse>, close: () => { signal.removeEventListener("abort", close); close(); } };
}
