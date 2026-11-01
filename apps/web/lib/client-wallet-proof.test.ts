import { describe, expect, it } from "vitest";
import { AnyPublicKey, AnySignature, Ed25519PublicKey, Ed25519Signature } from "@aptos-labs/ts-sdk";
import { assertSignInWallet, ED25519_SIGN_IN_REQUIRED, normalizeEd25519Hex, type WalletIdentity } from "./client-wallet-proof";

const keyHex = `0x${"ab".repeat(32)}`;
const signatureHex = `0x${"cd".repeat(64)}`;
const wallet = (): WalletIdentity => ({ connected: true, account: { address: "0x1", publicKey: keyHex }, network: { chainId: 2, name: "testnet" } });

describe("Ed25519 wallet proof normalization", () => {
  it("serializes typed bytes as hexadecimal rather than comma-separated decimals", () => {
    expect(normalizeEd25519Hex(new Uint8Array(32).fill(0xab), "publicKey")).toBe(keyHex);
    expect(normalizeEd25519Hex(new Uint8Array(64).fill(0xcd), "signature")).toBe(signatureHex);
  });
  it("accepts prefixed and unprefixed hex without changing proof bytes", () => {
    expect(normalizeEd25519Hex(`  ${keyHex.toUpperCase()}  `, "publicKey")).toBe(keyHex);
    expect(normalizeEd25519Hex(signatureHex.slice(2), "signature")).toBe(signatureHex);
  });
  it("handles real SDK Ed25519 and unified Ed25519 objects", () => {
    const key = new Ed25519PublicKey(keyHex); const signature = new Ed25519Signature(signatureHex);
    expect(normalizeEd25519Hex(key, "publicKey")).toBe(keyHex);
    expect(normalizeEd25519Hex(signature, "signature")).toBe(signatureHex);
    expect(normalizeEd25519Hex(new AnyPublicKey(key), "publicKey")).toBe(keyHex);
    expect(normalizeEd25519Hex(new AnySignature(signature), "signature")).toBe(signatureHex);
  });
  it("supports wallet SDK objects that expose only hexadecimal toString", () => {
    expect(normalizeEd25519Hex({ toString: () => keyHex }, "publicKey")).toBe(keyHex);
  });
  it.each([new Uint8Array(31), "1,2,3", [keyHex], { publicKeys: [keyHex], threshold: 1 }, { variant: 1, publicKey: { toString: () => keyHex } }])("rejects malformed or unsupported public key representations", value => {
    expect(() => normalizeEd25519Hex(value, "publicKey")).toThrow(ED25519_SIGN_IN_REQUIRED);
  });
  it("rejects signature arrays and unsupported wallet classes", () => {
    class MultiEd25519Signature { toUint8Array() { return new Uint8Array(64); } }
    expect(() => normalizeEd25519Hex([signatureHex], "signature")).toThrow(ED25519_SIGN_IN_REQUIRED);
    expect(() => normalizeEd25519Hex(new MultiEd25519Signature(), "signature")).toThrow(ED25519_SIGN_IN_REQUIRED);
  });
});

describe("wallet identity at async sign-in boundaries", () => {
  it("allows the same canonical address and signing key", () => {
    expect(assertSignInWallet(wallet(), "0x0001", keyHex)).toBe("0x1");
  });
  it("stops a disconnected or switched account", () => {
    expect(() => assertSignInWallet({ ...wallet(), connected: false }, "0x1", keyHex)).toThrow("Connect your Aptos wallet");
    expect(() => assertSignInWallet({ ...wallet(), account: { address: "0x2", publicKey: keyHex } }, "0x1", keyHex)).toThrow("changed during sign-in");
  });
  it("stops a signing-key change even when the address stays the same", () => {
    const changed = wallet(); changed.account!.publicKey = `0x${"ef".repeat(32)}`;
    expect(() => assertSignInWallet(changed, "0x1", keyHex)).toThrow("changed during sign-in");
  });
  it("prioritizes a known chain ID over an inconsistent network name", () => {
    expect(() => assertSignInWallet({ ...wallet(), network: { chainId: 1, name: "testnet" } }, "0x1", keyHex)).toThrow("Aptos testnet");
    expect(assertSignInWallet({ ...wallet(), network: { name: "TESTNET" } }, "0x1", keyHex)).toBe("0x1");
  });
});
