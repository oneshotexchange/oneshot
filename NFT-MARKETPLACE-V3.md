# NFT offers and atomic checkout

This milestone adds funded item/collection offers and a browser cart to oneshot's existing ERC-721 mint, listing, purchase, cancellation, claims and recovery flows. Base Sepolia remains the intended test network. This code is not evidence of deployed contracts or a completed Base transaction.

## Customer behavior

- Make an item offer for one NFT, or a collection offer for 1–20 NFTs. The entire quantity is funded upfront in native test ETH. Price, recipient and expiry are fixed. The API offers durations up to 30 days.
- Accept an offer from an owned NFT's detail page. For an unlisted NFT, first approve that exact NFT in a separate wallet transaction. A seller's existing marketplace listing closes atomically when its NFT fills an offer.
- Cancel unused quantity, or release an expired offer. Funds move to the bidder's marketplace balance. The bidder claims that balance separately and may choose a withdrawal recipient. Cancellation, expiry release and claims do not require an authority permit or creator policy availability.
- Save up to 20 distinct listings in a deployment/network-specific browser cart. Saved prices are estimates. Check current prices, acknowledge the total, review the transaction, then approve in the wallet. A changed price or unavailable listing requires a new review. Every purchase succeeds together or the entire transaction reverts; gas remains separate.

The inclusive platform fee is 2%, with each collection's frozen royalty (0–10%) deducted separately from its price. Fees round per NFT. An offer never increases silently to meet a private policy. Private floor values, eligibility lists and authority secrets are absent from offer responses and acceptance summaries.

## Contract and deployment compatibility

`OneshotGuardedMarketplaceV3` inherits the guarded marketplace. It retains the original listing/policy signing domain and entrypoints, adding version 3, maximum batch/offer quantity 20, funded offers, an independent acceptance nonce and EIP-712 permit. Permits bind seller, offer, collection, NFT, final price, nonce, current policy commitment, deadline, deployment salt and chain/contract domain.

Reserved offer funds (`totalOfferEscrow`) and claimable balances (`totalPending`) are separate liabilities. Their sum must not exceed contract native balance. Force-sent excess is allowed. Current compiled marketplace runtime is 14,011 bytes, within EIP-170.

New offline Base plans target `oneshot-nft-v3`. The six planned deployment transactions remain unsigned; example plan generation uses placeholder addresses. Predicted addresses and template hashes are not deployment evidence. Existing v1/v2 manifests continue working with their existing actions; their interfaces expose neither funded offers nor atomic cart checkout. V3 is a new deployment, not an upgrade that moves existing assets or balances.

Before exposing V3 capabilities, verify deployed code hashes, factory/treasury, authority, salt, chain/genesis, deployment anchor, EIP-712 domain, version and both limits. EIP-1898 reads hold the exact canonical block hash. Balance reads also require a negative control proving the RPC rejects an unknown hash. Reviews resimulate the exact call before wallet submission. Receipts require the reviewed call and exact offer event; a batch receipt must contain every selected sale exactly once.

## Canonical data and limits

The indexer adds `oneshot_evm_offer_projections` idempotently. Existing projection kind constraints are unchanged. Offers, offer settlements and liability accounting share the raw-log journal transaction and undo on reorg. Each V3 block compares projected escrow/pending with the held contract values before committing. Public indexed reads repeat that check at their own held checkpoint. Run the indexer initializer before serving a new V3 manifest; public API reads do not create tables.

Collection resale totals include accepted offers once, separately from original listing asks and primary mints. Replaced listings show the actual accepted price and an offer-filled status. Receiver forwarding during safe transfer preserves the completed sale and final owner.

`GET /api/oneshot/launch/offers` reads public funded slots at one canonical checkpoint, requires a collection, and supports optional bidder/item filters. An item filter includes collection-wide offers. Each page scans at most 50 slots and returns at most 10 open/expired funded offers. Sparse pages can be empty with an older-page cursor; that does not establish that the collection has no offers. Cursors bind deployment, filters and block hash. This bounded RPC scan needs cost/latency evaluation before production scale; the separate offer projection provides a future indexed catalog path.

## Validation and remaining work

17 November 2026: 2,300 app tests, 61 dedicated PostgreSQL integration tests, 105 Foundry tests, workspace/script TypeScript checks and both production builds pass. The default app suite skips 65 environment-dependent tests; 61 are covered by the separate database runner. Tests include actual V3 contract execution in Foundry, full API review/revalidation/receipt boundaries, exact fees, partial fills, refunds, receiver failures/forwarding, stale quotes, journal rollback, canonical solvency and tampered statistics.

Desktop/mobile review used isolated synthetic data with signing disabled. It exercised funding, acceptance, cancellation, price refresh, cart review, wallet changes, load errors and related public screens. The sample preview is not live chain data or owner approval of the new screens.

Still required: a fresh actual-node V3/API rehearsal and Base RPC/deployment/wallet evidence, operator credentials and deployment inputs, independent contract/security review, and production capacity/recovery testing. Windows Application Control previously blocked the pinned Anvil executable; no bypass was attempted. Existing wallet SDK dependency findings and large frontend bundle warnings remain release work.

Other NFT product backlog remains: ERC-1155, external collection admission/royalty policy, creator/collector profiles, richer trait/search filters and larger catalog infrastructure. This milestone does not mark the whole NFT roadmap or broader token/game platform complete. Zero integration still depends on official network/AMM references.
