export type NftMarketplaceCapabilities = { address: string; version: 1 | 2 | 3; fundedOffers: boolean; batchBuy: boolean };
export function readNftMarketplace(value: unknown): NftMarketplaceCapabilities | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.address !== 'string' || !/^0x[\da-f]{40}$/i.test(input.address) || /^0x0{40}$/i.test(input.address)
    || ![1, 2, 3].includes(input.version as number) || typeof input.fundedOffers !== 'boolean' || typeof input.batchBuy !== 'boolean'
    || input.version !== 3 && (input.fundedOffers || input.batchBuy)) return null;
  return { address: input.address.toLowerCase(), version: input.version as 1 | 2 | 3, fundedOffers: input.fundedOffers, batchBuy: input.batchBuy };
}
export function sameNftMarketplace(left: NftMarketplaceCapabilities | null | undefined, right: NftMarketplaceCapabilities | null | undefined) {
  return Boolean(left && right && left.address.toLowerCase() === right.address.toLowerCase() && left.version === right.version
    && left.fundedOffers === right.fundedOffers && left.batchBuy === right.batchBuy);
}
