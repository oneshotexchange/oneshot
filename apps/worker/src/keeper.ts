import { keeperDisabledReasons, normalizeAddress, type EnvironmentConfig, type RuntimeStatus } from "@b20/sdk";
import { setTimeout as sleep } from "node:timers/promises";
import type { VerifiedDeployment } from "./verification";

export interface RegisteredKeeperJob {
  id: string;
  moduleAddress: string;
  moduleName: string;
  functionName: string;
  registeredOnChain: true;
  /** Payload is produced by the verified contract registry, never accepted from HTTP clients. */
  arguments: readonly string[];
}
export interface KeeperAdapter {
  signerAddress(): Promise<string>;
  readRegisteredJobs(limit: number): Promise<RegisteredKeeperJob[]>;
  simulate(job: RegisteredKeeperJob): Promise<{ success: boolean; fullFill: boolean }>;
  execute(job: RegisteredKeeperJob): Promise<{ hash: string; committed: boolean }>;
}

/** No default signer or made-up contract job exists. A reviewed deployment must register an adapter. */
export async function runKeeper(config: EnvironmentConfig, deployment: VerifiedDeployment | undefined, adapter: KeeperAdapter | undefined, signal: AbortSignal, status: (value: Omit<RuntimeStatus, "updatedAt">) => void): Promise<void> {
  const reasons = keeperDisabledReasons(config);
  if (!deployment) reasons.push("B20 deployment has not passed on-chain verification");
  if (!adapter) reasons.push("No reviewed keeper execution adapter is registered for this deployment");
  if (reasons.length) { status({ service: "keeper", state: "disabled", message: reasons.join("; ") }); return; }
  const executor = adapter!;
  const signer = await executor.signerAddress();
  if (normalizeAddress(signer) !== normalizeAddress(config.B20_KEEPER_ACCOUNT_ADDRESS!)) throw new Error("Keeper signer does not match the configured account");
  const [moduleName, functionName] = (config.B20_KEEPER_MODULE ?? "").split("::");
  if (!moduleName || !functionName || !deployment!.modules.some((module) => module.name === moduleName && module.exposed_functions?.some((fn) => fn.name === functionName))) throw new Error("Keeper function is not present in the reviewed deployment ABI");
  while (!signal.aborted) {
    const jobs = await executor.readRegisteredJobs(config.B20_KEEPER_MAX_JOBS);
    if (jobs.length > config.B20_KEEPER_MAX_JOBS) throw new Error("Keeper job bound exceeded");
    for (const job of jobs) {
      if (signal.aborted) break;
      if (job.registeredOnChain !== true || normalizeAddress(job.moduleAddress) !== deployment!.address || job.moduleName !== moduleName || job.functionName !== functionName) throw new Error("Keeper job is not registered for the verified function");
      const simulation = await executor.simulate(job);
      if (!simulation.success || !simulation.fullFill) continue;
      const receipt = await executor.execute(job);
      if (!receipt.committed) throw new Error("Keeper transaction did not commit; it will be reconciled before another attempt");
    }
    status({ service: "keeper", state: "running", message: "Verified registered jobs checked" });
    await sleep(config.B20_KEEPER_INTERVAL_MS, undefined, { signal }).catch((error: unknown) => { if (!signal.aborted) throw error; });
  }
}
