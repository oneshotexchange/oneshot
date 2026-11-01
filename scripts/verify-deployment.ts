/** Read-only testnet deployment checks. This script never publishes or signs. */
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeAddress } from "@b20/sdk";
import { abiFingerprint, type ModuleAbi } from "../apps/worker/src/verification";

type FunctionAbi = {
  name: string; visibility: string; is_entry: boolean; is_view: boolean;
  generic_type_params: unknown[]; params: string[]; return: string[];
};
type StructAbi = { name: string; fields: { name: string; type: string }[] };
type FullModuleAbi = ModuleAbi & { exposed_functions: FunctionAbi[]; structs: StructAbi[] };
type ExpectedFunction = { params: string[]; returns: string[]; entry: boolean; view: boolean };
const fun = (params: string[], returns: string[] = [], entry = false, view = false): ExpectedFunction => ({ params, returns, entry, view });
const STRING = "0x1::string::String";
const TOKEN = "0x1::object::Object<0x4::token::Token>";

// These are the public interfaces of contracts/sources at this release. SELF is
// replaced with the configured address; address spelling is normalized below.
export const EXPECTED_FUNCTIONS: Record<string, Record<string, ExpectedFunction>> = {
  allowlist: {
    leaf: fun(["address", "address"], ["vector<u8>"]),
    node: fun(["vector<u8>", "vector<u8>"], ["vector<u8>"]),
    verify: fun(["&vector<u8>", "address", "address", "&vector<vector<u8>>"], ["bool"]),
  },
  fee_math: {
    mul_bps: fun(["u64", "u64"], ["u64"]),
    validate_trading_fee: fun(["u64"]),
    split_collected_fee: fun(["u64", "u8"], ["u64", "u64", "u64", "u64"]),
    primary_split: fun(["u64"], ["u64", "u64"]),
    secondary_split: fun(["u64", "u64"], ["u64", "u64", "u64"]),
  },
  token_config: { launch_terms: fun(["u64", "u8"], ["SELF::token_config::LaunchTerms"], false, true) },
  hyperion_adapter: {
    is_available: fun([], ["bool"], false, true),
    launch_token: fun(["&signer", STRING, STRING, STRING, STRING, "u64", "u8"], [], true),
    buy: fun(["&signer", "address", "u64", "u64", "u64"], [], true),
    sell: fun(["&signer", "address", "u64", "u64", "u64"], [], true),
  },
  nft_launch: {
    create: fun(["&signer", STRING, STRING, STRING, STRING, "u64", "u64"], ["address"]),
    create_collection: fun(["&signer", STRING, STRING, STRING, STRING, "u64", "u64"], [], true),
    configure_mint: fun(["&signer", "address", "u64", "u64", "u64", "u64", "vector<u8>", "u64", "u64", "u64", "u64"], [], true),
    set_metadata_base_uri: fun(["&signer", "address", STRING], [], true),
    open_collection: fun(["&signer", "address"], [], true),
    mint_nft: fun(["&signer", "address", "u64", "vector<vector<u8>>", "u64"], [], true),
    mint: fun(["&signer", "address", "u64", "vector<vector<u8>>", "u64"], ["vector<address>"]),
    get_collection: fun(["address"], ["SELF::nft_launch::CollectionView"], false, true),
    wallet_mints: fun(["address", "address"], ["u64", "u64"], false, true),
    is_b20_token: fun(["address"], ["bool"], false, true),
    sale_terms: fun(["address"], ["address", "address", "u64"], false, true),
  },
  marketplace: {
    list: fun(["&signer", TOKEN, "u64"], [], true),
    create_listing: fun(["&signer", TOKEN, "u64"], ["address"]),
    buy: fun(["&signer", "address", "u64"], [], true),
    cancel: fun(["&signer", "address"], [], true),
    is_active: fun(["address"], ["bool"], false, true),
    get_listing: fun(["address"], ["SELF::marketplace::ListingView"], false, true),
  },
};

const fields = (entries: [string, string][]) => entries.map(([name, type]) => ({ name, type }));
const addresses = (...names: string[]): [string, string][] => names.map((name) => [name, "address"]);
const u64s = (...names: string[]): [string, string][] => names.map((name) => [name, "u64"]);
export const EXPECTED_STRUCTS: Record<string, Record<string, { name: string; type: string }[]>> = {
  nft_launch: {
    CollectionCreated: fields([...addresses("collection", "creator"), ["name", STRING], ...u64s("max_supply", "royalty_bps")]),
    CollectionOpened: fields([...addresses("collection"), ["metadata_base_uri", STRING], ["allowlist_root", "vector<u8>"], ...u64s("allowlist_start", "allowlist_end", "public_start", "public_end", "allowlist_price_octas", "public_price_octas", "allowlist_wallet_limit", "public_wallet_limit")]),
    Minted: fields([...addresses("collection", "token", "minter"), ...u64s("serial", "price_octas", "platform_fee_octas", "creator_proceeds_octas")]),
    CollectionView: fields([...addresses("collection", "creator"), ["name", STRING], ["metadata_base_uri", STRING], ...u64s("max_supply", "minted", "royalty_bps"), ["opened", "bool"], ["configured", "bool"], ["allowlist_root", "vector<u8>"], ...u64s("allowlist_start", "allowlist_end", "allowlist_price_octas", "allowlist_wallet_limit", "public_start", "public_end", "public_price_octas", "public_wallet_limit")]),
  },
  marketplace: {
    Listed: fields([...addresses("listing", "token", "collection", "seller"), ...u64s("price_octas")]),
    Cancelled: fields(addresses("listing", "token", "seller")),
    Sold: fields([...addresses("listing", "token", "collection", "seller", "buyer"), ...u64s("price_octas", "platform_fee_octas", "royalty_octas", "seller_proceeds_octas")]),
    ListingView: fields([...addresses("listing", "token", "collection", "seller"), ...u64s("price_octas"), ...addresses("royalty_recipient"), ...u64s("royalty_bps", "platform_fee_octas", "royalty_octas", "seller_proceeds_octas")]),
  },
  token_config: { LaunchTerms: fields([...u64s("supply_atomic"), ["decimals", "u8"], ...u64s("opening_fdv_octas", "maximum_price_multiple", "trading_fee_bps"), ["fee_mode", "u8"], ...u64s("platform_share_bps", "liquidity_share_of_destination_bps")]) },
};

class CheckError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); }
}
function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckError(message);
}
function decimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value) || BigInt(value) > (1n << 64n) - 1n) throw new CheckError(`${label} must be a decimal u64 string.`);
  return BigInt(value).toString();
}
function address(value: string, label: string): string {
  try { return normalizeAddress(value); } catch { throw new CheckError(`${label} must be an Aptos 0x address.`, 2); }
}
function moveType(value: string, self: string): string {
  return value.replaceAll("SELF", self).replace(/0x[0-9a-fA-F]+(?=::)/g, (part) => normalizeAddress(part)).replace(/\s+/g, "");
}
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export function checkInterfaces(modules: FullModuleAbi[], self: string): void {
  const actualNames = modules.map((module) => module.name).sort();
  requireCheck(equal(actualNames, Object.keys(EXPECTED_FUNCTIONS).sort()), "Published B20 module set differs from the six reviewed release modules.");
  for (const module of modules) {
    const expected = EXPECTED_FUNCTIONS[module.name];
    requireCheck(Array.isArray(module.exposed_functions), `${module.name}: exposed function ABI is missing.`);
    requireCheck(equal(module.exposed_functions.map((entry) => entry.name).sort(), Object.keys(expected).sort()), `${module.name}: public function set differs from the reviewed interface.`);
    for (const fn of module.exposed_functions) {
      const wanted = expected[fn.name];
      requireCheck(fn.visibility === "public" && fn.is_entry === wanted.entry && fn.is_view === wanted.view && Array.isArray(fn.generic_type_params) && fn.generic_type_params.length === 0, `${module.name}::${fn.name}: visibility, entry/view or generic parameters differ.`);
      requireCheck(Array.isArray(fn.params) && Array.isArray(fn.return), `${module.name}::${fn.name}: parameter/return ABI is missing.`);
      requireCheck(equal(fn.params.map((type) => moveType(type, self)), wanted.params.map((type) => moveType(type, self))) && equal(fn.return.map((type) => moveType(type, self)), wanted.returns.map((type) => moveType(type, self))), `${module.name}::${fn.name}: parameter or return types differ.`);
    }
    for (const [name, expectedFields] of Object.entries(EXPECTED_STRUCTS[module.name] ?? {})) {
      const struct = module.structs?.find((entry) => entry.name === name);
      requireCheck(struct && Array.isArray(struct.fields), `${module.name}::${name}: event/view struct ABI is missing.`);
      requireCheck(equal(struct.fields.map((field) => ({ name: field.name, type: moveType(field.type, self) })), expectedFields.map((field) => ({ name: field.name, type: moveType(field.type, self) }))), `${module.name}::${name}: ordered fields differ from the reviewed event/view schema.`);
    }
  }
}

type JsonRecord = Record<string, any>;
type Fetcher = (url: string, step: string) => Promise<JsonRecord | JsonRecord[]>;
function makeFetcher(apiKey?: string): Fetcher {
  return async (url, step) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
      if (!response.ok) throw new CheckError(`${step}: fullnode returned HTTP ${response.status}. Confirm the public address/version, endpoint and API-key permissions.`);
      // Match the worker's single-page fingerprint. Never hash a truncated page.
      requireCheck(!response.headers.get("x-aptos-cursor"), `${step}: response is paginated; this release supports fewer than 100 modules per account.`);
      const reader = response.body?.getReader();
      requireCheck(reader, `${step}: response body is missing.`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new CheckError(`${step}: response exceeded the 8 MiB bound.`); }
        chunks.push(chunk.value);
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requireCheck(parsed && typeof parsed === "object", `${step}: response is not a JSON object or array.`);
      return parsed as JsonRecord | JsonRecord[];
    } catch (error) {
      if (error instanceof CheckError) throw error;
      // Fetch/JSON errors may contain credentialed endpoint URLs; never echo them.
      throw new CheckError(`${step}: request failed, timed out, or returned invalid JSON. Check connectivity and server-only credentials.`);
    }
  };
}

async function readModules(fetcher: Fetcher, base: string, self: string, snapshot: string): Promise<FullModuleAbi[]> {
  const entries = await fetcher(`${base}/accounts/${self}/modules?limit=100&ledger_version=${snapshot}`, "Read published modules");
  requireCheck(Array.isArray(entries) && entries.length > 0 && entries.length < 100, "Account has no modules, or its module list cannot be proven complete within this release's bound.");
  const modules = entries.map((entry) => entry.abi as FullModuleAbi);
  requireCheck(modules.every((module) => module && typeof module.name === "string" && typeof module.address === "string" && address(module.address, "Module ABI address") === self), "Published module ABI is missing or its address differs from the configured package.");
  requireCheck(new Set(modules.map((module) => module.name)).size === modules.length, "Published module names are duplicated.");
  return modules;
}

export async function verifyPublicDeployment(env: Record<string, string | undefined>, fetchOverride?: Fetcher) {
  if ((env.APTOS_NETWORK && env.APTOS_NETWORK !== "testnet") || (env.APTOS_CHAIN_ID && env.APTOS_CHAIN_ID !== "2")) throw new CheckError("This verifier supports Aptos testnet only. Set APTOS_NETWORK=testnet and APTOS_CHAIN_ID=2.", 2);
  const rawAddress = env.B20_NFT_PACKAGE_ADDRESS || env.B20_PACKAGE_ADDRESS;
  if (!rawAddress) throw new CheckError("Set B20_NFT_PACKAGE_ADDRESS (or B20_PACKAGE_ADDRESS) to the public published NFT package address. Publish the reviewed immutable testnet release first if no deployment exists.", 2);
  const self = address(rawAddress, "B20 NFT package address");
  if (env.B20_NFT_PACKAGE_ADDRESS && env.B20_PACKAGE_ADDRESS && address(env.B20_PACKAGE_ADDRESS, "B20_PACKAGE_ADDRESS") !== self) throw new CheckError("B20_NFT_PACKAGE_ADDRESS and B20_PACKAGE_ADDRESS must identify the same NFT deployment for this worker.", 2);
  const rawVersion = env.B20_NFT_DEPLOYMENT_VERSION || env.B20_DEPLOYMENT_VERSION;
  if (!rawVersion) throw new CheckError("Set B20_NFT_DEPLOYMENT_VERSION (or B20_DEPLOYMENT_VERSION) to the decimal ledger version from the successful publication receipt; a transaction hash is not a ledger version.", 2);
  let deploymentVersion: string;
  try { deploymentVersion = decimal(rawVersion, "Deployment version"); } catch { throw new CheckError("Deployment version must be a decimal u64 ledger version from the publication receipt.", 2); }
  if (env.B20_NFT_DEPLOYMENT_VERSION && env.B20_DEPLOYMENT_VERSION && decimal(env.B20_DEPLOYMENT_VERSION, "B20_DEPLOYMENT_VERSION") !== deploymentVersion) throw new CheckError("NFT and worker deployment versions must agree.", 2);
  let endpoint: URL;
  try { endpoint = new URL(env.APTOS_FULLNODE_URL || "https://api.testnet.aptoslabs.com/v1"); } catch { throw new CheckError("APTOS_FULLNODE_URL must be an HTTPS testnet fullnode /v1 URL.", 2); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)))) throw new CheckError("APTOS_FULLNODE_URL requires HTTPS (HTTP loopback is allowed for fixtures), without embedded credentials, query or fragment. Use APTOS_API_KEY or GEOMI_API_KEY separately.", 2);
  const base = endpoint.toString().replace(/\/$/, "");
  const fetcher = fetchOverride ?? makeFetcher(env.APTOS_API_KEY || env.GEOMI_API_KEY);
  const ledger = await fetcher(base, "Read ledger") as JsonRecord;
  requireCheck(ledger.chain_id === 2, "Fullnode chain ID is not Aptos testnet (2). No deployment was accepted.");
  const snapshot = decimal(ledger.ledger_version, "Fullnode ledger version");
  requireCheck(BigInt(deploymentVersion) <= BigInt(snapshot), "Publication version is newer than the fullnode ledger.");
  const modules = await readModules(fetcher, base, self, snapshot);
  checkInterfaces(modules, self);
  const registry = await fetcher(`${base}/accounts/${self}/resource/0x1::code::PackageRegistry?ledger_version=${snapshot}`, "Read immutable package registry") as JsonRecord;
  const packages: JsonRecord[] | undefined = registry.data?.packages;
  requireCheck(Array.isArray(packages) && packages.length > 0 && packages.every((pkg) => String(pkg.upgrade_policy?.policy) === "2"), "Every package at the B20 address must have immutable upgrade policy (policy 2).");
  const release = packages.find((pkg) => pkg.name === "B20TestnetV1");
  requireCheck(release && Array.isArray(release.modules) && equal(release.modules.map((module: JsonRecord) => module.name).sort(), Object.keys(EXPECTED_FUNCTIONS).sort()), "B20TestnetV1 registry metadata does not contain exactly the reviewed release modules.");
  const transaction = await fetcher(`${base}/transactions/by_version/${deploymentVersion}`, "Read publication transaction") as JsonRecord;
  requireCheck(transaction.type === "user_transaction" && transaction.success === true && decimal(transaction.version, "Publication receipt version") === deploymentVersion, "Configured publication version is not a successful committed user transaction.");
  requireCheck(Array.isArray(transaction.changes), "Publication transaction has no state changes.");
  const published = transaction.changes.filter((change: JsonRecord) => change.type === "write_module" && typeof change.address === "string" && address(change.address, "Published module address") === self).map((change: JsonRecord) => change.data?.abi?.name).sort();
  requireCheck(equal(published, Object.keys(EXPECTED_FUNCTIONS).sort()), "Configured transaction version did not publish the complete reviewed B20 module set at this address.");
  const hash = abiFingerprint(modules);
  const expected = env.B20_EXPECTED_ABI_SHA256;
  if (expected) requireCheck(/^[0-9a-f]{64}$/i.test(expected) && expected.toLowerCase() === hash, "On-chain ABI fingerprint differs from B20_EXPECTED_ABI_SHA256. Do not overwrite a reviewed digest to bypass this failure.");

  let hyperion: JsonRecord = { status: "not_configured", integrationVerified: false, enabled: false };
  if (env.HYPERION_PACKAGE_ADDRESS) {
    const hyperionAddress = address(env.HYPERION_PACKAGE_ADDRESS, "HYPERION_PACKAGE_ADDRESS");
    try {
      const candidate = await readModules(fetcher, base, hyperionAddress, snapshot);
      const pool = candidate.find((module) => module.name === "pool_v3");
      const swap = pool?.structs?.find((struct) => struct.name === "SwapEventV3");
      hyperion = { status: "candidate_modules_read", address: hyperionAddress, abiSha256: abiFingerprint(candidate), poolV3Present: Boolean(pool), swapEventV3Present: Boolean(swap), integrationVerified: false, enabled: false };
    } catch (error) {
      hyperion = { status: "deployment_not_verified", address: hyperionAddress, reason: error instanceof CheckError ? error.message : "Hyperion module checks failed.", integrationVerified: false, enabled: false };
    }
  }
  hyperion.requiredBeforeEnablement = ["Reviewed current testnet package and full ABI match", "Committed first buy and first sell with exact APT/token balance reconciliation, slippage, expiry and full-fill checks", "On-chain one-sided launch and registered-pool provenance", "Creator LP custody and authorized claim/conversion/distribution proof; no residual balances or unauthorized withdrawals", "Verified supported fee tier and safe integer price/amount rounding", "A reviewed execution adapter; current immutable hyperion_adapter remains unavailable"];
  return {
    status: "passed_onchain_nft_interface_checks", chainId: 2, snapshotLedgerVersion: snapshot,
    nft: { address: self, deploymentVersion, publicationTransactionHash: typeof transaction.hash === "string" ? transaction.hash : null, packageName: release.name, upgradePolicy: "immutable", packageSourceDigest: typeof release.source_digest === "string" ? release.source_digest : null, abiSha256: hash, comparedToPreviouslyReviewedAbi: Boolean(expected), checkedModules: modules.map((module) => module.name).sort(), sourceBytecodeEquivalenceVerified: false, liveNftFlowVerified: false },
    hyperion,
    suggestedEnvironment: {
      B20_NFT_PACKAGE_ADDRESS: self, B20_PACKAGE_ADDRESS: self, B20_DEPLOYMENT_VERSION: deploymentVersion,
      B20_EXPECTED_ABI_SHA256: hash, B20_DEPLOYMENT_VERIFIED: "false", B20_WORKER_ENABLED: "false",
      HYPERION_ENABLED: "false", HYPERION_DEPLOYMENT_VERIFIED: "false", B20_KEEPER_ENABLED: "false",
    },
    nextAction: "Review this public manifest against the release build and publication receipt, then complete the NFT flow smoke test before explicitly setting B20_DEPLOYMENT_VERIFIED=true. Worker enablement additionally requires database migration, Geomi credentials and a real stream/replay smoke test. No environment or deployment was changed.",
  };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
      console.log("Read-only Aptos testnet deployment verification.\nUsage: npm run verify:deployment -- [--env-file PATH]\nRequires: B20_NFT_PACKAGE_ADDRESS (or B20_PACKAGE_ADDRESS) and B20_NFT_DEPLOYMENT_VERSION (or B20_DEPLOYMENT_VERSION).\nOptional: APTOS_FULLNODE_URL, APTOS_API_KEY or GEOMI_API_KEY, B20_EXPECTED_ABI_SHA256, HYPERION_PACKAGE_ADDRESS.\nNo signing key is required. Output contains public deployment metadata only.\nExit: 0 NFT interface checks passed; 1 on-chain/request failure; 2 missing or invalid configuration.");
      return 0;
    }
    if (args.length) {
      const filename = args.length === 2 && args[0] === "--env-file" ? args[1] : args.length === 1 && args[0].startsWith("--env-file=") ? args[0].slice("--env-file=".length) : undefined;
      if (!filename) throw new CheckError("Unsupported arguments. Use --help or --env-file PATH.", 2);
      try { loadEnvFile(resolve(filename)); } catch { throw new CheckError("Could not load --env-file. Check that the local file exists and is readable; its contents were not printed.", 2); }
    }
    console.log(JSON.stringify(await verifyPublicDeployment(process.env), null, 2));
    return 0;
  } catch (error) {
    const known = error instanceof CheckError;
    console.error(JSON.stringify({ status: "failed", exitCode: known ? error.exitCode : 1, message: known ? error.message : "Deployment verification failed. Check the endpoint and the reviewed release interface; no configuration was changed." }));
    return known ? error.exitCode : 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
