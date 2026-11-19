import { z } from 'zod';
import { profileWallet, profileWalletSchema } from './wallet-profile';

export const walletFollowingSchema = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  wallets: z.array(profileWalletSchema).max(50),
  updatedAt: z.string().datetime().nullable(),
}).strict().refine(value => new Set(value.wallets).size === value.wallets.length && value.wallets.every((wallet, index) => index === 0 || value.wallets[index - 1] < wallet)
  && (value.revision === 0 ? value.wallets.length === 0 && value.updatedAt === null : value.updatedAt !== null));
export type WalletFollowing = z.infer<typeof walletFollowingSchema>;
export const emptyWalletFollowing = (): WalletFollowing => ({ revision: 0, wallets: [], updatedAt: null });
/** Canonical ASCII JSON keeps the URL bounded and independent of list order. */
export function encodeFollowedWallets(wallets: string[]) {
  const normalized = [...new Set(wallets.map(profileWallet))].sort();
  if (!normalized.length || normalized.length > 50) throw new Error('Choose between 1 and 50 wallets for this activity feed.');
  return btoa(JSON.stringify(normalized)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decodeFollowedWallets(encoded: string): string[] {
  try {
    if (!encoded || encoded.length > 3100 || !/^[\w-]+$/.test(encoded)) throw new Error();
    const value: unknown = JSON.parse(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')));
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string') || encodeFollowedWallets(value) !== encoded) throw new Error();
    return value;
  } catch { throw new Error('Check the followed wallets and refresh the activity feed.'); }
}
