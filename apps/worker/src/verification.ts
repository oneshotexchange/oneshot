import { createHash } from "node:crypto";
import { normalizeAddress, type EnvironmentConfig } from "@b20/sdk";

export interface ModuleAbi { address: string; name: string; exposed_functions?: { name: string; is_view?: boolean }[]; structs?: { name: string; fields?: { name: string; type: string }[] }[]; }
export interface VerifiedDeployment {
  address: string;
  abiSha256: string;
  modules: ModuleAbi[];
}
export class DeploymentVerificationError extends Error { readonly fatal = true; }

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, stable(inner)]));
  return value;
}

export function abiFingerprint(modules: ModuleAbi[]): string {
  const canonical = [...modules].sort((a, b) => a.name.localeCompare(b.name)).map((abi) => ({ ...abi, address: normalizeAddress(abi.address) }));
  return createHash("sha256").update(JSON.stringify(stable(canonical))).digest("hex");
}

export async function readJson(url: string, apiKey?: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
  if (!response.ok) throw new DeploymentVerificationError(`Aptos verification request failed with HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new DeploymentVerificationError("Verification response exceeded its size bound");
  try { return JSON.parse(text); } catch { throw new DeploymentVerificationError("Verification response is not JSON"); }
}

export async function verifyDeployment(config: EnvironmentConfig, kind: "b20" | "hyperion"): Promise<VerifiedDeployment> {
  const address = kind === "b20" ? config.B20_PACKAGE_ADDRESS : config.HYPERION_PACKAGE_ADDRESS;
  const expected = kind === "b20" ? config.B20_EXPECTED_ABI_SHA256 : config.HYPERION_EXPECTED_ABI_SHA256;
  const markedVerified = kind === "b20" ? config.B20_DEPLOYMENT_VERIFIED : config.HYPERION_DEPLOYMENT_VERIFIED;
  if (!address || !expected || !markedVerified) throw new DeploymentVerificationError(`${kind} has no reviewed deployment manifest`);
  const base = config.APTOS_FULLNODE_URL.replace(/\/$/, "");
  const ledger = await readJson(base, config.GEOMI_API_KEY) as { chain_id?: number };
  if (ledger.chain_id !== config.APTOS_CHAIN_ID) throw new DeploymentVerificationError("Fullnode chain ID mismatch");
  const rawModules = await readJson(`${base}/accounts/${address}/modules?limit=100`, config.GEOMI_API_KEY);
  if (!Array.isArray(rawModules) || !rawModules.length) throw new DeploymentVerificationError(`${kind} account has no published modules`);
  const modules = rawModules.map((entry: { abi?: ModuleAbi }) => entry.abi).filter((abi): abi is ModuleAbi => Boolean(abi?.name && abi.address));
  if (modules.length !== rawModules.length) throw new DeploymentVerificationError("Module ABI is missing");
  if (modules.some((abi) => normalizeAddress(abi.address) !== normalizeAddress(address))) throw new DeploymentVerificationError("Module ABI address mismatch");
  const hash = abiFingerprint(modules);
  if (hash !== expected.toLowerCase()) throw new DeploymentVerificationError(`${kind} ABI does not match its reviewed SHA-256 fingerprint`);
  if (kind === "b20") {
    for (const name of ["nft_launch", "marketplace"]) if (!modules.some((abi) => abi.name === name)) throw new DeploymentVerificationError(`Required B20 module ${name} is missing`);
    const registry = await readJson(`${base}/accounts/${address}/resource/0x1::code::PackageRegistry`, config.GEOMI_API_KEY) as { data?: { packages?: { upgrade_policy?: { policy?: number | string } }[] } };
    const packages = registry.data?.packages;
    if (!packages?.length || packages.some((pkg) => Number(pkg.upgrade_policy?.policy) !== 2)) throw new DeploymentVerificationError("B20 packages must have immutable upgrade policy");
  } else {
    const pool = modules.find((abi) => abi.name === "pool_v3");
    if (!pool?.structs?.some((struct) => struct.name === "SwapEventV3")) throw new DeploymentVerificationError("Verified Hyperion SwapEventV3 ABI is missing");
  }
  return { address: normalizeAddress(address), abiSha256: hash, modules };
}
