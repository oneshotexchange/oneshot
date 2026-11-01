import { createHash, randomBytes } from 'node:crypto';
import { Ed25519PublicKey, Ed25519Signature, AnyPublicKey } from '@aptos-labs/ts-sdk';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { chainFetch, normalizeAddress } from './config';
import { ApiError } from './http';
import { consumeRecord, getRecord, putRecord } from './store';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export async function createChallenge(address: string, origin: string) {
  address = normalizeAddress(address);
  const nonce = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const message = `Sign in to B20 at ${origin} as ${address}. Issued ${new Date().toISOString()}`;
  await putRecord('challenges', nonce, { address, origin, message, nonce, expiresAt });
  return { message, nonce, expiresAt };
}
export const proofSchema = z.object({ address: z.string(), publicKey: z.string().min(64).max(132), fullMessage: z.string().max(2048), signature: z.string().min(128).max(132) });

export function parseSignedMessage(fullMessage: string) {
  const lines = fullMessage.split('\n');
  if (lines.shift() !== 'APTOS') throw new ApiError(401, 'INVALID_PROOF', 'The wallet message prefix is invalid.');
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const match = /^(address|application|chainId|message|nonce):\s?(.*)$/.exec(line);
    if (!match || fields[match[1]] !== undefined) throw new ApiError(401, 'INVALID_PROOF', 'The wallet message format is invalid.');
    fields[match[1]] = match[2];
  }
  if (fields.chainId !== '2' || !fields.nonce || !fields.message) throw new ApiError(401, 'WRONG_NETWORK', 'Sign the B20 challenge with Aptos testnet enabled.');
  return fields;
}
export function verifyEd25519Proof(publicKey: string, signature: string, fullMessage: string, authenticationKey: string) {
  try {
    const key = new Ed25519PublicKey(publicKey);
    const authKeys = [key.authKey().toString(), new AnyPublicKey(key).authKey().toString()].map(normalizeAddress);
    return authKeys.includes(normalizeAddress(authenticationKey)) && key.verifySignature({ message: new TextEncoder().encode(fullMessage), signature: new Ed25519Signature(signature) });
  } catch { return false; }
}
export async function verifyChallenge(input: z.infer<typeof proofSchema>, origin: string) {
  const address = normalizeAddress(input.address);
  const fields = parseSignedMessage(input.fullMessage);
  const challenge: any = await consumeRecord('challenges', fields.nonce);
  if (!challenge || challenge.address !== address || challenge.origin !== origin || challenge.message !== fields.message || Date.parse(challenge.expiresAt) < Date.now()) throw new ApiError(401, 'CHALLENGE_EXPIRED', 'Request a new wallet sign-in challenge.');
  if (fields.address && normalizeAddress(fields.address) !== address) throw new ApiError(401, 'INVALID_PROOF', 'The signing address does not match.');
  if (fields.application && fields.application !== new URL(origin).host && fields.application !== origin) throw new ApiError(401, 'INVALID_PROOF', 'The signing application does not match.');
  const ledger = await chainFetch('');
  if (ledger.chain_id !== 2) throw new ApiError(503, 'CHAIN_MISMATCH', 'The server is not connected to Aptos testnet.');
  const account = await chainFetch(`/accounts/${address}`);
  if (!verifyEd25519Proof(input.publicKey, input.signature, input.fullMessage, account.authentication_key)) throw new ApiError(401, 'SIGNATURE_UNSUPPORTED', 'The signature could not be verified. Use a funded Aptos testnet account with an Ed25519 wallet.');
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  await putRecord('sessions', digest(token), { address, expiresAt });
  return { token, address, expiresAt };
}
export async function session(request: NextRequest) {
  const token = request.cookies.get('b20_session')?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const record: any = await getRecord('sessions', digest(token));
  return record && Date.parse(record.expiresAt) > Date.now() ? record : null;
}
export async function requireSession(request: NextRequest) {
  const record = await session(request);
  if (!record) throw new ApiError(401, 'AUTH_REQUIRED', 'Connect your wallet and sign in before saving or uploading.');
  return record;
}
