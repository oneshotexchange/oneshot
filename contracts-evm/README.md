# oneshot testnet EVM contracts

Base Sepolia is the immediate test-network target. Local protocol rehearsals do not prove a Base deployment. No Zero deployment is claimed.

New deployment plans use `OneshotGuardedMarketplaceV3`: funded native item/collection offers, independent acceptance permits/nonces, partial fills, permissionless expired-offer release, bidder refunds into pull balances and atomic buys of up to 20 listings. The guarded listing/policy entrypoints remain available. See [NFT V3 behavior, verification and rollout](../NFT-MARKETPLACE-V3.md). Earlier v1/v2 local smoke fixtures remain earlier-version evidence; do not label them V3 rehearsals. All 105 Foundry cases pass; the V3 marketplace runtime is 14,011 bytes.

## Run

Install Node 22.12+ and Foundry (local validation used 1.7.1), then run from the repository root:

```sh
npm ci
npm run contracts:build
npm run contracts:test
npm run contracts:smoke
```

Solidity 0.8.30, Cancun and OpenZeppelin 5.6.1 are pinned for local testing. Zero compiler/opcode support still needs verification. Foundry may download the pinned compiler on first use. The smoke runner requires `forge` and `anvil` on PATH; `ONESHOT_FORGE_BIN` and `ONESHOT_ANVIL_BIN` can select explicit executable paths.

The contract test runner also compiles the untouched Uniswap v4 core 1.0.2 PoolManager under its exact Solidity 0.8.26 requirement using the separate `v4_core` profile. Tests deploy that bytecode with `vm.getCode`; oneshot contracts retain 0.8.30. Core is BUSL-1.1 and the periphery 1.0.3 math dependency is MIT. This integration targets local/testnet use; do not assume the core package grants an unrestricted production license.

## Token market

`OneshotV4MarketFactory` creates a new eight-decimal, 1B fixed-supply `OneshotMarketToken` and one immutable market per launch. Every issued token enters its original concentrated-liquidity position except unavoidable rounding dust permanently locked in the market. Initialization needs no native-token contribution. The position belongs directly to the market contract; it has no transferable position NFT. No owner, proxy, principal withdrawal, rescue, negative liquidity modification or range-changing entrypoint exists. This new issuance cannot access the old local foundation allocation.

The creator chooses the opening valuation, a 1–5% execution fee in 0.1% steps and either creator revenue or liquidity/burn revenue before launch. These choices freeze at construction. The native/token range targets 1000× the opening valuation; protocol tick alignment changes the effective endpoints slightly. Call `previewTerms` before commitment to display the exact effective opening and upper valuations. Native currency is ETH on Base Sepolia and local Anvil; no APT/ZRO threshold conversion is assumed.

The pool's immutable LP fee is 2500 pips (0.25%). Uniswap protocol governance can independently apply an upstream protocol fee, so total DEX costs must be read/quoted rather than promised to remain exactly 0.25%. The observation hook changes no fee, settlement delta or token transfer. External router swaps pay no oneshot execution fee. Buy payment includes the oneshot fee; its remainder is exact pool input. Sell fees use actual gross native output. Both directions reject partial pool consumption atomically. There is no fee-on-transfer or swap tax.

Revenue uses 20% platform / 80% destination. Creator mode credits native pull claims. Liquidity/burn mode divides the destination into 75% liquidity / 25% buy-and-burn. LP fees are collected without removing principal; token-denominated LP fees convert to native before revenue allocation, without another execution fee. Rounding conserves raw units and residual inventory remains pending or permanently locked.

Permissionless `process` uses a 300-second cumulative-tick TWAP, at most 50 ticks of current-price deviation, 1% quote slippage, exact fills, original-range price limits and a deadline at most 60 seconds ahead. Its explicit **testnet policy** requires at least 0.01 ETH of eligible accumulated revenue. Caller budgets cap existing token consumption and total native spending across swaps, new principal and burns. New liquidity is always added to the original range. The hook retains 1024 observations, at most one per second. Missing history, unsafe price movement or failed execution keeps the whole operation pending; there is no spot-only fallback. This mechanism still requires independent economic review before any production decision.

Factories, tokens and market admission accept only local 31337 and Base Sepolia 84532. Base factory/market construction additionally requires the official PoolManager `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408`. Claims remain available independently of admission checks. `OneshotV4Quoter` simulates only registered markets and reverts its callback to roll back all swap/oracle state; use `quoteSwap` through `eth_call` before approval and execution.

The factory stores its fixed market creation bytecode in two immutable STOP-prefixed code contracts. This keeps factory runtime below EIP-170 without a proxy, replaceable implementation or caller-supplied code. The only deployment path reconstructs that exact bytecode and appends constructor arguments.

NFT collection and new token names/symbols share bounded UTF-8 admission at construction. Invalid encodings, ASCII control characters, trim-only whitespace and an initial U+FEFF byte-order mark are rejected before registration. The initial mark is excluded because the application's UTF-8 decoder consumes it and would fail exact ABI round-trip verification. Valid non-English text, emoji and embedded/trailing U+FEFF remain supported. Byte limits stay 100/20 for NFT name/symbol and 64/16 for token name/symbol. The permanently locked local foundation is unchanged.

Run the dedicated RPC rehearsal from the root:

```sh
npx tsx scripts/local-v4-smoke.ts
```

It uses Foundry 1.7.1 and an owned, disposable loopback Anvil chain. It reconciles canonical receipts and actual local runtime hashes, writes a `.local/qa/local-v4-smoke-*.json` report, then stops Anvil. Its addresses and local immutable runtime hashes cannot enable Base Sepolia.

An offline unsigned deployment plan can be prepared with explicit public inputs:

```sh
npx tsx scripts/prepare-base-sepolia-contracts.ts --deployer ADDRESS --nonce DECIMAL_NONCE --platform ADDRESS --listing-authority ADDRESS --deployment-salt NONZERO_BYTES32
```

This rebuilds pinned artifacts, mines the hook's CREATE2 salt and writes six unsigned transaction payloads for both NFT and token services to `.local/qa`. It reads no signing key and performs no RPC or wallet call. The exact deployer nonce and transaction order must hold when reviewed. Manifest preparations deliberately contain null runtime hashes and block anchors; only actual successful Base receipts, canonical parent/genesis checks, immutable getters and deployed runtime code can supply those values.

## NFT lifecycle

1. Deploy `OneshotNFTFactory(treasury)`, then `OneshotGuardedMarketplace(factory,listingAuthority,deploymentSalt)` for the guarded listing flow. The simpler `OneshotMarketplace(factory)` remains covered by the earlier local smoke.
2. A creator calls `createCollection(name,symbol)`; the immutable registry records provenance.
3. The creator configures all terms in one call: supply cap, royalties, metadata base URI, collection URI, content hash, allowlist root and phase schedules/prices/limits.
4. `open()` irreversibly freezes terms. All content must be validated and snapshotted before this transaction. Metadata IDs are `baseURI + decimal tokenId`, starting at 1, without a `.json` suffix.
5. `mint(quantity,recipient,maximumTotalPrice,proof)` requires exact inclusive native payment. A batch is at most 20. Caps accumulate per payer per phase; changing recipients cannot bypass them.
6. Approve and `list(collection,tokenId,totalPrice)`. Only factory collections enter the market. `buy(listingId,maximumTotalPrice,recipient)` consumes that listing exactly once.
7. `cancel` returns to the seller; `cancelTo` lets contract sellers select a compatible recipient. Native beneficiaries use `claimTo` to route their own proceeds.

Primary mint collects 2% to treasury; creator receives the remainder. Resale collects 2% plus the frozen 0–10% creator royalty; seller receives the remainder. Every raw base unit is conserved. Rejected claims/transfers roll back. Claims are liabilities, not administrator-controlled balances. There is no proxy, setter after opening or principal rescue path. Unsolicited plain `transferFrom` deposits are not recoverable; use the listing flow.

Allowlist leaves are `keccak256(bytes.concat(keccak256(abi.encode(keccak256("ONESHOT_ALLOWLIST_V1"), chainId, collection, payer)))))`. Parent nodes hash sorted child pairs. Proofs bind to chain, collection and payer. Public issuance on one chain only; no bridge remint path.

## Token foundation limits

`OneshotTokenFoundationFactory` is hard-gated to local chain 31337. Each allocation creates immutable policy and a 1B token with eight decimals, entirely in permanent foundation custody. This lock cannot move, approve, rescue or later bind an adapter. **It is deliberately not a market launch.** The token can demonstrate holder burns/no transfer tax in local tests; the registered foundation allocation remains inaccessible.

`OneshotLaunchPolicy` computes immutable 1–5% execution fee budgets with 20/80 platform/destination, then 75/25 liquidity/burn when selected. It computes converted LP revenue splitting separately without charging another execution fee. It executes no swaps, additions, fee claims or burns. Opening valuation is supplied before construction and the 1000× upper target is fixed per instance.

## Evidence

Foundry covers freezes, provenance, phases, Merkle proofs, caps, stale listings, hostile callbacks, contract-wallet recovery, fee/royalty conservation, full uint256 arithmetic and local-only gates. The smoke runner executes real transactions on an ephemeral local Anvil chain, reconciles claims, verifies event indexing/replay and a real orphaned-block rollback, then writes `.local/oneshot/smoke-result.json` and stops that chain. It also verifies external ownership transfers and cancellation to another recipient. Those addresses cease to be a running deployment and must not configure the UI.
