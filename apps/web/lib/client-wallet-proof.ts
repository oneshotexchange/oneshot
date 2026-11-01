export const ED25519_SIGN_IN_REQUIRED = "Use a funded Aptos testnet account with an Ed25519 wallet. Multisig, keyless and other signature schemes are not supported for B20 sign-in yet.";

type ProofKind = "publicKey" | "signature";

/** Wallet adapters can return raw bytes, hexadecimal strings, or SDK objects. */
export function normalizeEd25519Hex(value: unknown, kind: ProofKind, depth = 0): string {
  const byteLength = kind === "publicKey" ? 32 : 64;
  const unsupported = () => new Error(ED25519_SIGN_IN_REQUIRED);
  if (depth > 2 || value == null || Array.isArray(value)) throw unsupported();
  if (typeof value === "string") {
    const hex = value.trim().replace(/^0x/i, "");
    if (!new RegExp(`^[a-fA-F0-9]{${byteLength * 2}}$`).test(hex)) throw unsupported();
    return `0x${hex.toLowerCase()}`;
  }
  if (value instanceof Uint8Array || Object.prototype.toString.call(value) === "[object Uint8Array]") {
    const bytes = value as Uint8Array;
    if (bytes.byteLength !== byteLength) throw unsupported();
    return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  if (typeof value !== "object") throw unsupported();
  const record = value as Record<string, unknown>;
  const className = Object.getPrototypeOf(value)?.constructor?.name || "";
  if (/multi|secp|keyless|webauthn/i.test(className)) throw unsupported();
  // Unified Ed25519 SDK wrappers serialize an extra variant byte. Unwrap only
  // the explicit Ed25519 variant; other schemes must never be guessed from size.
  if ("variant" in record) {
    if (record.variant !== 0 || !(kind in record)) throw unsupported();
    return normalizeEd25519Hex(record[kind], kind, depth + 1);
  }
  if (typeof record.toUint8Array === "function") {
    let bytes: unknown;
    try { bytes = record.toUint8Array.call(value); } catch { throw unsupported(); }
    if (!(bytes instanceof Uint8Array) && Object.prototype.toString.call(bytes) !== "[object Uint8Array]") throw unsupported();
    return normalizeEd25519Hex(bytes, kind, depth + 1);
  }
  if (typeof record.toString === "function" && record.toString !== Object.prototype.toString) {
    let hex: unknown;
    try { hex = record.toString.call(value); } catch { throw unsupported(); }
    if (typeof hex === "string") return normalizeEd25519Hex(hex, kind, depth + 1);
  }
  throw unsupported();
}

export type WalletIdentity = {
  connected: boolean;
  account: { address: { toString(): string } | string; publicKey?: unknown } | null;
  network: { chainId?: number | string; name?: string } | null;
};

export function assertSignInWallet(wallet: WalletIdentity, expectedAddress?: string, expectedPublicKey?: string): string {
  const address = wallet.account?.address.toString();
  if (!wallet.connected || !address) throw new Error("Connect your Aptos wallet to continue.");
  const testnet = wallet.network && (wallet.network.chainId != null ? Number(wallet.network.chainId) === 2 : wallet.network.name?.toLowerCase() === "testnet");
  if (!testnet) throw new Error("Switch your wallet to Aptos testnet to continue.");
  let same = !expectedAddress;
  if (expectedAddress) { try { same = BigInt(address) === BigInt(expectedAddress); } catch { same = false; } }
  if (!same || (expectedPublicKey && normalizeEd25519Hex(wallet.account?.publicKey, "publicKey") !== expectedPublicKey)) throw new Error("Your wallet account or signing key changed during sign-in. Start again with the wallet you want to use.");
  return address;
}
