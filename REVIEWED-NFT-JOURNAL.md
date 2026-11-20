# External NFT journal and collection records

Delivered on 20 November 2026 after the [reviewed import and registry milestone](REVIEWED-EXTERNAL-NFTS.md). This is an independent ERC-721 event journal and read experience. It does not enable customer listing, checkout, cancellation or payout transactions.

## Customer experience

`/nfts/reviewed` lists admitted collections and retains revoked admission history. Contract-address lookup opens a collection's observed NFTs, active listings and activity. Individual item routes accept token ID 0 and sparse uint256 IDs. There are no inferred names, artwork, total supply, rarity scores, creator identities or complete-wallet claims. Collection admission does not verify artwork rights or immutable proxy behavior.

Collection details and their tabs must use the same deployment and checkpoint. A moved checkpoint requires refreshing the collection details. Public links bind the expected deployment ID, so a contract address cannot silently open records from another deployment. Prices use exact native integer amounts and display test ETH, inclusive 2% platform fee, listing royalty and separate gas. Read failures, unreadable responses, unobserved addresses/items and genuine empty lists have distinct recovery states. Browsing never requires a linked wallet, approval or signature.

The read API supports:

| Resource under `/api/oneshot/reviewed-nfts` | Result |
| --- | --- |
| `/status` | Customer-safe availability, verified deployment/network/checkpoint and coverage |
| `/collections`, `/collections/:address` | Admission observations, including revoked collections |
| `/collections/:address/items`, `/collections/:address/items/:tokenId` | Sparse observed ownership, burn status and active listing association |
| `/listings` | Collection/seller/status-filtered listing records and exact settlement amounts |
| `/activity` | Collection or explicit wallet-actor activity, including royalty recipient actors |
| `/wallets/:address/items`, `/wallets/:address/claims` | Observed wallet custody and marketplace payout ledger |

Pages default to 20 and allow at most 50 records. Cursors bind resource/filter scope, page size, deployment, checkpoint number/hash and deterministic ordering. A head change invalidates a continuation with HTTP 409. Unknown collection/item detail returns 404 meaning **not observed here**, not proof that the NFT does not exist. Disabled reads return a safe unavailable context. Public errors never expose database credentials, provider URLs or operator configuration.

## Journal and settlement consistency

The journal reuses the existing atomic indexer store and tables under the distinct `reviewedNftManifestId`. Native v1/v2/v3 manifest parsers, projections and features remain separate. Public reads never create a schema or advance the journal. A new index supports latest transfer lookup by deployment, collection and token ID; the explicit worker initializes that index through the existing schema initializer.

Each block fetches registry/marketplace logs first, then known admitted collections plus collections admitted in that same block. Collection history continues after revocation. Logs preceding a collection's first admission position are excluded, including logs earlier in the admission block. Unknown collection event types do not create NFT observations. Recognized events require canonical ABI encoding, source, block hash and transaction/log positions; malformed transfers and inconsistent ownership stop the block.

An unknown token's first observation may be a non-mint transfer or burn. The journal does not invent its mint origin or pre-admission owner history. A token may burn and later re-mint. Token IDs stay decimal strings through PostgreSQL, JSON and the client; they are never converted to floating-point numbers.

Listings require an admitted review version/code hash, the exact preceding seller-to-market transfer in that transaction, escrow custody and a contiguous marketplace listing counter. Sales/cancellations require the corresponding market-to-recipient transfer and active listing. Recipient callbacks may forward the NFT again before `Sold` or `Cancelled`, so the final observed owner is not forced to equal the reviewed recipient. Sales retain the exact price, 2% fee, royalty receiver/amount and seller proceeds. Beneficiary collisions accumulate correctly. Claims must match the complete recorded beneficiary pending amount. Unexplained escrow exits and inconsistent financial events fail atomically.

At every committed block the projected total pending liability and next listing counter must equal hash-selected contract reads; native collateral must cover the liability. Registry deployment may precede marketplace deployment. Historical empty market code is represented explicitly with zero pending and counter 1, and is accepted only before that market has been observed deployed. Code cannot disappear afterward without a rollback. Available API snapshots require a fully deployed, verified market.

All block logs, admission state, items, listings, payout ledgers, accounting flags and before-images commit together. A bounded reorg rolls them back together. A reorg beyond the configured bound preserves the existing checkpoint and stops for operator recovery. Cancellation and claims observed after registry revocation remain supported. No rescue or transfer authority is added.

## Source and read limits

`VerifiedReviewedNftJournalSource` retains the strict shared registry/market/factory proof and fresh chain/genesis checks. State reads use EIP-1898 canonical hash selectors; log reads use EIP-234 block hashes. Unknown-hash negative controls must reject correctly even when the real response is empty. A timeout or generic provider failure is not accepted as evidence that hash selection works. This is a consistency check on the selected RPC service, not cryptographic proof that an untrusted provider supplied every chain event.

Explicit bounds include 1,024 collections, eight addresses per log request, 10,000 logs per block, 65,536 data bytes per log, a 16 MiB combined capture budget and 160 logical RPC reads/45 seconds per source operation. Each pass accepts at most 32 blocks and has a cooperative 120-second budget checked around asynchronous work; the source operations and database operations have their own bounds. Confirmation depth is a local processing policy, not a finality claim.

The API holds a repeatable-read, read-only SQL snapshot, validates record/transfer provenance and verifies the held deployment/checkpoint before and after reading. SQL acquisition/operations are bounded to five seconds, with a 75-second absolute lease and request cancellation. Late/poisoned connections are destroyed. Public clients bound transport/body consumption to 90 seconds and 2 MiB, cancel superseded requests and validate all record shapes, activity arguments, attribution, ordering and checkpoint relationships. These conservative proofs still need real-provider latency/cost and production-capacity measurement.

## Running the explicit worker

```dotenv
ONESHOT_REVIEWED_NFT_READS_ENABLED=false
ONESHOT_REVIEWED_NFT_MANIFEST_PATH=
```

The read opt-in is independent of imports and native NFT flags. Only local chain 31337 or Base Sepolia 84532 is accepted; Zero and mainnet are not enabled. A genuine reviewed deployment manifest and an initialized journal are required before records become available. No predictive or synthetic manifest belongs in live configuration.

```sh
npm run indexer:reviewed-nfts -- --help
npm run indexer:reviewed-nfts -- --manifest PATH --env-file PATH --max-blocks 8 --confirmations 2
```

The command performs one bounded pass, requires explicit loopback PostgreSQL and validates the selected test-network profile. It never signs or broadcasts. An interrupted or failed later block can leave earlier complete canonical blocks committed. Operational scheduling, remote-worker deployment and production recovery exercises remain release work.

## Verification and next work

Final checks pass 2,599 app tests, 97 PostgreSQL tests, all workspace/script TypeScript checks and both production builds. The default app run skips 101 environment-dependent cases; 97 run in the dedicated database runner. Seven new PostgreSQL cases exercise sparse IDs, exact item/listing association, forwarding, payout reads, pagination, corrupt provenance, reorg rollback and failed-block atomicity. The original failed test cleanup was corrected; its seven owned temporary schemas were explicitly removed from the dedicated test database. Existing large web-bundle warnings remain. These are engineering results, not an independent audit or actual Base deployment evidence.

Agent browser QA uses isolated in-memory samples produced by the actual sparse projector, with wallet signing disabled. It covers anonymous discovery, address lookup, token ID 0, pagination/back navigation, listings, sale/transfer activity, revoked history, unknown collections, empty/unavailable/error/unreadable states and mobile/desktop layouts. Related home/token/NFT/portfolio/activity/settings routes were checked for navigation and overflow. The [sample reviewed NFT preview](http://127.0.0.1:19405/nfts/reviewed) is not live deployment evidence. Screenshots/logs live under ignored `.local/qa/wallet-profiles` and fixture source under `.local/qa/wallet-profiles-preview`.

Remaining agent work includes safe observed mutable metadata/artwork, customer list/buy/cancel/claim reviews, exact transfer/market receipts and recovery, external portfolio/profile/feed aggregation, and ERC-1155. Existing native mint, offers and cart features do not automatically apply to this market. Owner/release work includes actual Base deployment/current-bytecode chain rehearsal, real account/wallet acceptance, independent contract review, wallet SDK dependency remediation, production worker/capacity/monitoring and retention policy. No Solidity changed in this milestone; the prior 134 Foundry checks remain the contract evidence. Windows Application Control still blocks the pinned Anvil binary; no bypass was attempted.

Primary references: [EIP-234 hash-selected logs](https://eips.ethereum.org/EIPS/eip-234), [EIP-1898 canonical state selectors](https://eips.ethereum.org/EIPS/eip-1898), and [ERC-721 transfer and constructor-mint semantics](https://eips.ethereum.org/EIPS/eip-721).
