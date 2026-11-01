import { z } from "zod";
import { ECONOMICS } from "./economics";

const booleanEnv = z.preprocess((value) => value === undefined || value === "" ? false : value === "true" ? true : value === "false" ? false : value, z.boolean());
const optionalText = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());
const optionalAddress = z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, "Invalid Aptos address").optional());
const rawVersion = z.string().regex(/^\d+$/).refine((value) => BigInt(value) <= (1n << 64n) - 1n, "Version exceeds u64");
const optionalVersion = z.preprocess((value) => value === "" ? undefined : value, rawVersion.optional());
const optionalHash = z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^[0-9a-f]{64}$/i, "Expected SHA-256 hex digest").optional());
const integerEnv = (minimum: number, maximum: number, fallback: number) => z.preprocess((value) => value === undefined || value === "" ? fallback : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value, z.number().int().min(minimum).max(maximum));
const feeList = z.preprocess((value) => value === undefined || value === "" ? [25] : typeof value === "string" ? value.split(",").map((part) => /^\d+$/.test(part.trim()) ? Number(part.trim()) : NaN) : value, z.array(z.number().int().min(1).max(1000)).min(1).max(20).refine((values) => new Set(values).size === values.length, "Duplicate DEX fee tier"));

const environmentSchema = z.object({
  APTOS_NETWORK: z.enum(["testnet", "localnet"]).default("testnet"),
  APTOS_CHAIN_ID: integerEnv(0, 255, 2),
  APTOS_FULLNODE_URL: z.string().url().default("https://api.testnet.aptoslabs.com/v1"),
  APTOS_INDEXER_URL: z.string().url().default("https://api.testnet.aptoslabs.com/v1/graphql"),
  APTOS_GRPC_ENDPOINT: z.string().regex(/^[a-zA-Z0-9.-]+:\d+$/, "Expected gRPC host:port").default("grpc.testnet.aptoslabs.com:443"),
  GEOMI_API_KEY: optionalText,
  DATABASE_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  B20_WORKER_ENABLED: booleanEnv,
  B20_PACKAGE_ADDRESS: optionalAddress,
  B20_DEPLOYMENT_VERSION: optionalVersion,
  B20_DEPLOYMENT_VERIFIED: booleanEnv,
  B20_EXPECTED_ABI_SHA256: optionalHash,
  B20_DEX_FEE_BPS: integerEnv(1, 1000, ECONOMICS.defaultDexFeeBps),
  B20_SUPPORTED_DEX_FEE_BPS: feeList,
  B20_STREAM_BATCH_SIZE: integerEnv(1, 1000, 100),
  B20_STREAM_MAX_MESSAGE_BYTES: integerEnv(1_048_576, 67_108_864, 16_777_216),
  B20_STREAM_MAX_EVENTS_PER_TX: integerEnv(1, 100_000, 10_000),
  B20_MAX_EVENT_DATA_BYTES: integerEnv(1024, 1_048_576, 65_536),
  B20_STATUS_PORT: integerEnv(1024, 65535, 42070),
  HYPERION_ENABLED: booleanEnv,
  HYPERION_PACKAGE_ADDRESS: optionalAddress,
  HYPERION_DEPLOYMENT_VERIFIED: booleanEnv,
  HYPERION_EXPECTED_ABI_SHA256: optionalHash,
  B20_KEEPER_ENABLED: booleanEnv,
  B20_KEEPER_ACCOUNT_ADDRESS: optionalAddress,
  B20_KEEPER_PRIVATE_KEY: optionalText,
  B20_KEEPER_MODULE: optionalText,
  B20_KEEPER_INTERVAL_MS: integerEnv(5000, 3_600_000, 60_000),
  B20_KEEPER_MAX_JOBS: integerEnv(1, 100, 5),
}).superRefine((config, context) => {
  if (!config.B20_SUPPORTED_DEX_FEE_BPS.includes(config.B20_DEX_FEE_BPS)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["B20_DEX_FEE_BPS"], message: "Default fee must be a configured supported new-pool tier" });
  if (config.APTOS_NETWORK === "testnet" && config.APTOS_CHAIN_ID !== 2) context.addIssue({ code: z.ZodIssueCode.custom, path: ["APTOS_CHAIN_ID"], message: "Aptos testnet requires chain ID 2" });
});

export function parseEnvironmentConfig(environment: Record<string, string | undefined>) {
  return environmentSchema.parse({ ...environment, ...(environment.APTOS_NETWORK === "localnet" && !environment.APTOS_CHAIN_ID ? { APTOS_CHAIN_ID: "4" } : {}) });
}
export type EnvironmentConfig = ReturnType<typeof parseEnvironmentConfig>;

export function indexerDisabledReasons(config: EnvironmentConfig): string[] {
  if (!config.B20_WORKER_ENABLED) return ["B20_WORKER_ENABLED is false"];
  return [
    !config.DATABASE_URL && "DATABASE_URL is missing",
    !config.GEOMI_API_KEY && "GEOMI_API_KEY is missing",
    !config.B20_PACKAGE_ADDRESS && "B20_PACKAGE_ADDRESS is missing",
    config.B20_DEPLOYMENT_VERSION === undefined && "B20_DEPLOYMENT_VERSION is missing",
    !config.B20_DEPLOYMENT_VERIFIED && "B20 deployment verification is missing",
    !config.B20_EXPECTED_ABI_SHA256 && "Reviewed B20 ABI fingerprint is missing",
    config.HYPERION_ENABLED && !config.HYPERION_PACKAGE_ADDRESS && "Hyperion package address is missing",
    config.HYPERION_ENABLED && !config.HYPERION_DEPLOYMENT_VERIFIED && "Hyperion deployment verification is missing",
    config.HYPERION_ENABLED && !config.HYPERION_EXPECTED_ABI_SHA256 && "Reviewed Hyperion ABI fingerprint is missing",
  ].filter((value): value is string => Boolean(value));
}

export function keeperDisabledReasons(config: EnvironmentConfig): string[] {
  if (!config.B20_KEEPER_ENABLED) return ["B20_KEEPER_ENABLED is false"];
  return [
    ...indexerDisabledReasons(config),
    !config.B20_KEEPER_ACCOUNT_ADDRESS && "Keeper account address is missing",
    !config.B20_KEEPER_PRIVATE_KEY && "Keeper signer is missing",
    !config.B20_KEEPER_MODULE && "Verified keeper module is missing",
  ].filter((value): value is string => Boolean(value));
}

export function normalizeAddress(address: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) throw new RangeError("Invalid Aptos address");
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}
