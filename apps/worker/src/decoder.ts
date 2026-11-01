import { b20EventSchemas, hyperionSwapSchema, normalizeAddress, type ChainEventEnvelope, type DecodedChainEvent } from "@b20/sdk";

export class EventDecodingError extends Error {
  readonly fatal = true;
}

export interface EventSourceConfig {
  b20PackageAddress: string;
  hyperionPackageAddress?: string;
}

export function decodeChainEvent(event: ChainEventEnvelope, source: EventSourceConfig): DecodedChainEvent | null {
  const match = /^(0x[0-9a-fA-F]{1,64})::([a-zA-Z_][a-zA-Z0-9_]*)::([a-zA-Z_][a-zA-Z0-9_]*)(?:<.*>)?$/.exec(event.type);
  if (!match) return null;
  const address = normalizeAddress(match[1]!);
  const name = `${match[2]}::${match[3]}`;
  if (address === normalizeAddress(source.b20PackageAddress)) {
    const schema = b20EventSchemas[name as keyof typeof b20EventSchemas];
    if (!schema) throw new EventDecodingError(`B20 event ${name} has no reviewed decoder; checkpoint preserved`);
    const parsed = schema.safeParse(event.data);
    if (!parsed.success) throw new EventDecodingError(`Invalid ${name} payload at version ${event.transactionVersion}:${event.eventIndex}`);
    if (name === "nft_launch::Minted") {
      const data = parsed.data as import("@b20/sdk").B20EventPayloads["nft_launch::Minted"];
      if (BigInt(data.platform_fee_octas) + BigInt(data.creator_proceeds_octas) !== BigInt(data.price_octas)) throw new EventDecodingError("Mint settlement does not conserve APT");
    }
    if (name === "marketplace::Sold") {
      const data = parsed.data as import("@b20/sdk").B20EventPayloads["marketplace::Sold"];
      if (BigInt(data.platform_fee_octas) + BigInt(data.royalty_octas) + BigInt(data.seller_proceeds_octas) !== BigInt(data.price_octas)) throw new EventDecodingError("Sale settlement does not conserve APT");
    }
    return { ...event, kind: name, data: parsed.data } as DecodedChainEvent;
  }
  if (source.hyperionPackageAddress && address === normalizeAddress(source.hyperionPackageAddress) && match[2] === "pool_v3") {
    if (match[3] === "SwapEventV3") {
      const parsed = hyperionSwapSchema.safeParse(event.data);
      if (!parsed.success) throw new EventDecodingError(`Invalid Hyperion swap at version ${event.transactionVersion}:${event.eventIndex}`);
      return { ...event, kind: "hyperion::SwapEventV3", data: parsed.data };
    }
    if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) throw new EventDecodingError("Invalid Hyperion pool event");
    return { ...event, kind: "hyperion::PoolEvent", data: event.data as Record<string, unknown> };
  }
  return null;
}
