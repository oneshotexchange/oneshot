import { z } from 'zod';

export const profileWalletSchema = z.string().regex(/^0x[0-9a-f]{40}$/).refine(value => !/^0x0{40}$/.test(value));
const controls = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const mediaPath = z.string().regex(/^\/api\/media\/[a-f0-9]{64}\.webp$/).nullable();
function website(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && url.hostname.includes('.') && !/[\[\]:]/.test(url.hostname) && !/^[\d.]+$/.test(url.hostname) && !url.hostname.endsWith('.localhost') && !url.hostname.endsWith('.local');
  } catch { return false; }
}
export const walletProfileDetailsSchema = z.object({
  displayName: z.string().trim().max(60).refine(value => !controls.test(value)),
  bio: z.string().trim().max(500).refine(value => !controls.test(value.replace(/[\r\n\t]/g, ''))),
  website: z.string().max(2048).refine(website).nullable(),
  avatarPath: mediaPath,
  bannerPath: mediaPath,
}).strict();
export type WalletProfileDetails = z.infer<typeof walletProfileDetailsSchema>;
export const emptyWalletProfile = (): WalletProfileDetails => ({ displayName: '', bio: '', website: null, avatarPath: null, bannerPath: null });
export const publicWalletProfileSchema = walletProfileDetailsSchema.extend({
  wallet: profileWalletSchema,
  publishedAt: z.string().datetime(),
}).strict().refine(value => value.displayName.length > 0);
export type PublicWalletProfile = z.infer<typeof publicWalletProfileSchema>;
export const publicWalletProfileResponseSchema = z.object({ wallet: profileWalletSchema, profile: publicWalletProfileSchema.nullable() }).strict()
  .refine(value => !value.profile || value.profile.wallet === value.wallet);
export type PublicWalletProfileResponse = z.infer<typeof publicWalletProfileResponseSchema>;
export const accountWalletProfileSchema = z.object({
  wallet: profileWalletSchema,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  draft: walletProfileDetailsSchema,
  published: publicWalletProfileSchema.nullable(),
  updatedAt: z.string().datetime().nullable(),
}).strict().refine(value => (!value.published || value.published.wallet === value.wallet) && (value.revision === 0 ? value.updatedAt === null && value.published === null : value.updatedAt !== null));
export type AccountWalletProfile = z.infer<typeof accountWalletProfileSchema>;
export function profileWallet(value: string) {
  const result = profileWalletSchema.safeParse(value.toLowerCase());
  if (!result.success) throw new Error('Enter a valid Ethereum wallet address.');
  return result.data;
}
export function walletProfileHref(wallet: string, deploymentId?: string | null) {
  return `/profile/${profileWallet(wallet)}${deploymentId && /^[a-f0-9]{64}$/.test(deploymentId) ? `?deployment=${deploymentId}` : ''}`;
}
