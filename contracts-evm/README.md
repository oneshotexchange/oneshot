# oneshot local EVM contracts

Local foundation for the Zero migration. No Zero deployment is claimed.

## Run

Install Node 22.12+ and Foundry (local validation used 1.7.1), then run from the repository root:

```sh
npm ci
npm run contracts:build
npm run contracts:test
npm run contracts:smoke
```

Solidity 0.8.30, Cancun and OpenZeppelin 5.6.1 are pinned for local testing. Zero compiler/opcode support still needs verification. Foundry may download the pinned compiler on first use. The smoke runner requires `forge` and `anvil` on PATH; `ONESHOT_FORGE_BIN` and `ONESHOT_ANVIL_BIN` can select explicit executable paths.

## NFT lifecycle

1. Deploy `OneshotNFTFactory(treasury)`, then `OneshotMarketplace(factory)`.
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
