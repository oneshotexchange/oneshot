import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { indexerDisabledReasons, normalizeAddress, parseEnvironmentConfig, type RuntimeStatus } from "@b20/sdk";
import { PostgresEventStore, type SqlPool } from "./store";
import { processResponse } from "./processor";
import { openTransactionStream } from "./stream";
import { verifyDeployment, type VerifiedDeployment } from "./verification";
import { runKeeper } from "./keeper";

const config = parseEnvironmentConfig(process.env);
const controller = new AbortController();
const statuses: Record<"indexer" | "keeper", RuntimeStatus> = {
  indexer: { service: "indexer", state: "starting", message: "Checking configuration", updatedAt: new Date().toISOString() },
  keeper: { service: "keeper", state: "disabled", message: "No registered execution adapter", updatedAt: new Date().toISOString() },
};
const lastLogs: Partial<Record<"indexer" | "keeper", { signature: string; at: number }>> = {};
function update(value: Omit<RuntimeStatus, "updatedAt">) {
  const next = { ...value, updatedAt: new Date().toISOString() };
  statuses[value.service] = next;
  // Status strings contain no endpoint credentials, private keys or transaction payloads.
  const signature = `${next.state}:${next.message}`;
  const previous = lastLogs[value.service];
  if (!previous || previous.signature !== signature || Date.now() - previous.at >= 30_000) {
    lastLogs[value.service] = { signature, at: Date.now() };
    console.log(JSON.stringify({ type: "worker_status", ...next }));
  }
}
const server = createServer((request, response) => {
  if (request.url !== "/health" && request.url !== "/ready") { response.writeHead(404).end(); return; }
  const ready = statuses.indexer.state === "running";
  response.writeHead(request.url === "/ready" && !ready ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ ready, statuses }));
});
server.listen(Number(process.env.PORT || config.B20_STATUS_PORT), "0.0.0.0");

let pool: pg.Pool | undefined;
let store: PostgresEventStore | undefined;
async function run() {
  const reasons = indexerDisabledReasons(config);
  if (reasons.length) { update({ service: "indexer", state: "disabled", message: reasons.join("; ") }); return; }
  update({ service: "indexer", state: "verifying", message: "Checking chain, immutable package and reviewed ABI" });
  const deployment = await verifyDeployment(config, "b20");
  let hyperion: VerifiedDeployment | undefined;
  if (config.HYPERION_ENABLED) hyperion = await verifyDeployment(config, "hyperion");
  pool = new pg.Pool({ connectionString: config.DATABASE_URL!, max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  pool.on("error", () => update({ service: "indexer", state: "failed", message: "Database connection error; checkpoint retained" }));
  store = new PostgresEventStore(pool as unknown as SqlPool, config.APTOS_CHAIN_ID, `b20:${normalizeAddress(config.B20_PACKAGE_ADDRESS!)}`, config.B20_DEPLOYMENT_VERSION!);
  await store.initialize();
  void runKeeper(config, deployment, undefined, controller.signal, update).catch(() => update({ service: "keeper", state: "failed", message: "Keeper stopped; no further transactions will be submitted" }));
  let failures = 0;
  while (!controller.signal.aborted) {
    const nextVersion = await store.getNextVersion();
    const connection = openTransactionStream(config, nextVersion, controller.signal);
    try {
      update({ service: "indexer", state: "starting", message: "Waiting for a chain-verified transaction-stream response", nextVersion });
      for await (const response of connection.responses) {
        if (controller.signal.aborted) break;
        const batch = await processResponse(response, store, config.APTOS_CHAIN_ID, { b20PackageAddress: deployment.address, hyperionPackageAddress: hyperion?.address }, { maxEventsPerTransaction: config.B20_STREAM_MAX_EVENTS_PER_TX, maxEventDataBytes: config.B20_MAX_EVENT_DATA_BYTES, maxTransactionsPerBatch: config.B20_STREAM_BATCH_SIZE });
        failures = 0;
        update({ service: "indexer", state: "running", message: "Committed stream batch", nextVersion: batch.nextVersion ?? await store.getNextVersion() });
      }
      if (!controller.signal.aborted) throw new Error("Transaction stream ended");
    } catch (error: unknown) {
      if (controller.signal.aborted) break;
      if (error && typeof error === "object" && "fatal" in error && error.fatal === true) throw error;
      failures += 1;
      update({ service: "indexer", state: "retrying", message: "Stream or database unavailable; resuming from committed checkpoint", nextVersion: await store.getNextVersion() });
    } finally { connection.close(); }
    if (!controller.signal.aborted) await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), undefined, { signal: controller.signal }).catch(() => undefined);
  }
}

const running = run().catch((error: unknown) => update({ service: "indexer", state: "failed", message: error instanceof Error && "fatal" in error ? error.message : "Startup or database verification failed; checkpoint retained and indexing stopped" }));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  controller.abort();
  await running;
  await store?.close().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  server.close();
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
