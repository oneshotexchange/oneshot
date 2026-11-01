import { z } from "zod";
import { normalizeAddress } from "./config";

export const rawAmountSchema = z.string().regex(/^\d+$/).refine((value) => BigInt(value) <= (1n << 64n) - 1n, "Amount exceeds u64");
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).transform(normalizeAddress);
const objectAddressSchema = z.union([addressSchema, z.object({ inner: addressSchema }).transform((value) => value.inner)]);
const textSchema = z.string().max(2048);
export const b20EventSchemas = {
  "nft_launch::CollectionCreated": z.object({ collection: addressSchema, creator: addressSchema, name: z.string().max(256), max_supply: rawAmountSchema, royalty_bps: rawAmountSchema.refine((value) => BigInt(value) <= 10_000n) }),
  "nft_launch::CollectionOpened": z.object({ collection: addressSchema, metadata_base_uri: textSchema, allowlist_root: z.union([z.string().regex(/^0x[0-9a-fA-F]*$/), z.array(z.number().int().min(0).max(255)).max(32)]), allowlist_start: rawAmountSchema, allowlist_end: rawAmountSchema, public_start: rawAmountSchema, public_end: rawAmountSchema, allowlist_price_octas: rawAmountSchema, public_price_octas: rawAmountSchema, allowlist_wallet_limit: rawAmountSchema, public_wallet_limit: rawAmountSchema }),
  "nft_launch::Minted": z.object({ collection: addressSchema, token: addressSchema, minter: addressSchema, serial: rawAmountSchema, price_octas: rawAmountSchema, platform_fee_octas: rawAmountSchema, creator_proceeds_octas: rawAmountSchema }),
  "marketplace::Listed": z.object({ listing: addressSchema, token: addressSchema, collection: addressSchema, seller: addressSchema, price_octas: rawAmountSchema }),
  "marketplace::Cancelled": z.object({ listing: addressSchema, token: addressSchema, seller: addressSchema }),
  "marketplace::Sold": z.object({ listing: addressSchema, token: addressSchema, collection: addressSchema, seller: addressSchema, buyer: addressSchema, price_octas: rawAmountSchema, platform_fee_octas: rawAmountSchema, royalty_octas: rawAmountSchema, seller_proceeds_octas: rawAmountSchema }),
} as const;

export type B20EventName = keyof typeof b20EventSchemas;
export type B20EventPayloads = { [Key in B20EventName]: z.infer<(typeof b20EventSchemas)[Key]> };
export type B20DomainEvent = { [Key in B20EventName]: { kind: Key; data: B20EventPayloads[Key] } }[B20EventName];

/** Raw amounts come from actual on-chain swap events, never an unverified HTTP quote. */
export const hyperionSwapSchema = z.object({
  pool_id: addressSchema,
  from_token: objectAddressSchema,
  to_token: objectAddressSchema,
  amount_in: rawAmountSchema,
  amount_out: rawAmountSchema,
  fee_amount: rawAmountSchema,
  protocol_fee_amount: rawAmountSchema,
  pool_reserve_a: rawAmountSchema,
  pool_reserve_b: rawAmountSchema,
  current_tick: z.union([z.object({ bits: z.number().int() }), z.number().int(), z.string().regex(/^-?\d+$/)]),
  sqrt_price: z.string().regex(/^\d+$/),
  active_liquidity: z.string().regex(/^\d+$/),
});
export type HyperionSwap = z.infer<typeof hyperionSwapSchema>;

export interface ChainEventEnvelope {
  chainId: number;
  transactionVersion: string;
  eventIndex: number;
  transactionHash: `0x${string}`;
  timestampMicros: string;
  type: string;
  data: unknown;
}
export type DecodedChainEvent = ChainEventEnvelope & (B20DomainEvent | { kind: "hyperion::SwapEventV3"; data: HyperionSwap } | { kind: "hyperion::PoolEvent"; data: Record<string, unknown> });
