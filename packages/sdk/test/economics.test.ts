import { describe, expect, it } from "vitest";
import { calculateTradeAmounts, createLaunchPolicy, feeAddedToNet, feeFromGross, formatUnits, parseEnvironmentConfig, parseUnits, splitCollectedFee, splitNetAptEarnings, splitNftMintBatch, splitNftSale } from "../src/index";

describe("exact economics", () => {
  it("preserves amounts beyond JavaScript's safe integer range", () => {
    const raw = parseUnits("900719925.47409931");
    expect(raw).toBe(90_071_992_547_409_931n);
    expect(formatUnits(raw)).toBe("900719925.47409931");
    expect(() => parseUnits("1e9")).toThrow();
    expect(() => parseUnits("1.000000001")).toThrow();
  });

  it("conserves every base unit across both destination modes, including dust", () => {
    for (const total of [0n, 1n, 2n, 4n, 5n, 99n, 101n, 90_071_992_547_409_931n]) {
      for (const mode of ["creator", "liquidity_burn"] as const) {
        const split = splitCollectedFee(total, mode);
        expect(split.platform + split.destination).toBe(total);
        expect(split.creator + split.liquidity + split.burn).toBe(split.destination);
        expect(split.platform).toBe(total * 2000n / 10_000n);
        if (mode === "liquidity_burn") expect(split.liquidity).toBe(split.destination * 7500n / 10_000n);
      }
    }
  });

  it("splits actual converted net APT, independent of a token's decimal scale", () => {
    expect(splitNetAptEarnings(10_000n, "liquidity_burn")).toEqual({ total: 10_000n, platform: 2000n, destination: 8000n, creator: 0n, liquidity: 6000n, burn: 2000n });
  });

  it("charges inclusive buys and net sells with floor collection matching Move", () => {
    expect(calculateTradeAmounts("buy", 10_000n, 300)).toEqual({ side: "buy", grossApt: 10_000n, fee: 300n, poolApt: 9700n, userApt: 10_000n });
    expect(calculateTradeAmounts("sell", 10_000n, 300).userApt).toBe(9700n);
    expect(feeFromGross(1n, 200)).toBe(0n);
    for (const bps of [1, 100, 200, 500, 9999]) {
      for (const net of [0n, 1n, 99n, 1000n, 90_071_992_547_409_931n]) {
        const gross = net + feeAddedToNet(net, bps);
        expect(gross - feeFromGross(gross, bps)).toBe(net);
        if (net > 0n && gross > 0n) expect(gross - 1n - feeFromGross(gross - 1n, bps)).toBeLessThan(net);
      }
    }
  });

  it("keeps NFT royalty separate and batch rounding equal to contract settlement", () => {
    expect(splitNftSale(100_000n, 500)).toEqual({ gross: 100_000n, platform: 2000n, royalty: 5000n, seller: 93_000n });
    const batch = splitNftMintBatch(49n, 100);
    expect(batch.platform).toBe(98n);
    expect(batch.allocations.reduce((total, item) => total + item.platform, 0n)).toBe(batch.platform);
    expect(batch.allocations.reduce((total, item) => total + item.creator, 0n)).toBe(batch.creator);
    expect(batch.allocations[0]?.platform).toBe(1n);
    expect(batch.allocations[99]?.platform).toBe(0n);
  });

  it("snapshots immutable launch terms rather than rereading changed environment defaults", () => {
    const policy = createLaunchPolicy({ creatorFeeBps: 300, feeMode: "creator" });
    const changed = parseEnvironmentConfig({ B20_DEX_FEE_BPS: "100", B20_SUPPORTED_DEX_FEE_BPS: "25,100" });
    expect(policy.dexFeeBps).toBe(25);
    expect(policy.mutable).toBe(false);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(changed.B20_DEX_FEE_BPS).toBe(100);
    expect(() => createLaunchPolicy({ creatorFeeBps: 99, feeMode: "creator" })).toThrow();
    expect(() => createLaunchPolicy({ creatorFeeBps: 501, feeMode: "creator" })).toThrow();
    expect(() => createLaunchPolicy({ creatorFeeBps: 100, feeMode: "creator", dexFeeBps: 100 })).toThrow();
  });
});
