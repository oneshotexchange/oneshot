# Reviewed external NFT collections

## Delivered boundary

The owner's policy is **review collections before trading**, recorded on 19 November 2026. This milestone delivers private ERC-721 import requests, authenticated operator review, a separate review registry/marketplace contract pair, strict deployment verification and unsigned admission permit preparation/validation. It does not enable external collection trading in the customer app. Existing native v1/v2/v3 NFT manifests, decoders, minting and settlement remain unchanged.

Customers open `/nfts/import` from NFT discovery. They can submit an original-network collection address, notes and a reference, inspect their own history and withdraw a request. A current Privy account is required; a linked wallet is not. No reference URL is fetched, and submitting an address does not establish ownership or authorship. Review approval is displayed separately from trading availability. Withdrawal does not revoke an already signed permit or an onchain registration.

Requests use the existing PostgreSQL record store, with account ownership, exact revision comparisons, atomic duplicate admission and a 20-active-request limit per account. Rejected/withdrawn records remain in private history. Pages bind their cursor to account/admin scope, size and ordering. No new schema migration is required. Hosted storage never falls back to a local file. Operator notes, account IDs, contract inspection and commitments appear only at admin endpoints; account responses are allowlisted request DTOs.

The server-authenticated `/admin` area has the review queue. Every queue, detail, review and permit API independently requires a current admin bearer session. Approval requires private operator evidence and a fresh verified contract inspection. Rejection does not require RPC availability. A stored inspection is normalized and committed with SHA-256; tampering, stale revisions and withdrawal during inspection fail closed.

## Independent deployment identity

Server-only settings (default disabled):

```dotenv
ONESHOT_REVIEWED_NFT_IMPORTS_ENABLED=false
ONESHOT_REVIEWED_NFT_MANIFEST_PATH=
```

These flags do not enable customer transaction execution, and native NFT execution flags cannot enable imports. Only the explicitly selected local chain 31337 or Base Sepolia 84532 is accepted. Zero/mainnet are rejected. Configuration returning `available: true` means an import-request deployment was verified, not that any collection is admitted or trading is enabled.

The strict `oneshot-reviewed-erc721-v1` manifest contains exactly:

| Field | Evidence |
| --- | --- |
| `schemaVersion`, `deploymentVersion`, `mode`, `chainId` | Version 1, separate reviewed ERC-721 deployment, explicit supported test profile |
| `genesisHash`, `startBlock`, `anchorHash` | Observed chain identity; Base's pinned genesis; first indexed block and its parent hash |
| `oneshotFactory`, `registry`, `marketplace` | Each has a distinct nonzero `address` and exact `codeHash` |
| `treasury`, `reviewAuthority` | Nonzero immutable recipients/authority |
| `registrySalt`, `marketplaceSalt` | Separate nonzero deployment salts |

`startBlock` is a canonical decimal string in JSON. `parseReviewedNftManifest` normalizes it to bigint; `reviewedNftManifestJson` serializes it back. The deployment ID is SHA-256 of canonical normalized JSON. Do not populate a manifest from predictions or fake runtime hashes. New contracts have not been deployed by this milestone.

`VerifiedReviewedNftSource` verifies the genesis, parent anchor, all three runtime hashes, immutable references, authority, salts, versions, ERC-721 capability, fees and EIP-712 domains at one hash-selected canonical checkpoint, then rechecks that checkpoint. It has explicit read/time limits and no signer/broadcast method. Collection inspection reads the registry's `checkCollection` view: the exact native-factory exclusion and OpenZeppelin ERC-165 staticcall qualification used by admission. Heavy, caller-dependent and state-writing interface implementations are covered by contract regressions. Inspection also compares actual runtime code and the registry review version at that same checkpoint.

Code hashes identify runtime bytes. They do not prove proxy implementation immutability, ownership, artwork rights or a permanent royalty schedule. Those remain review policy/evidence concerns.

## Admission permits

An approved request can prepare a 15-minute unsigned EIP-712 `ReviewPermit`, binding collection, runtime code, next exact registry review version, deadline and registry deployment salt. Its domain binds the selected chain and registry. The response also binds request ID/revision, deployment ID and the approved inspection commitment. The API compares the computed digest to the registry's own digest.

The authority signs in its own controlled tool. This app does not collect an authority key, sign the permit or submit a transaction. Validation accepts the exact bundle, signature and submitter address, re-inspects the contract/current review version, simulates the exact `admitReviewed` call (including ERC-1271 authority checks), estimates gas, rechecks the canonical block and request revision, then checks expiry again. It returns only an unsigned zero-value call and simulation. It never marks the database request as onchain-admitted. Replay protection comes from the registry's version/deadline/domain, rather than EIP-712 alone.

| Endpoint | Boundary |
| --- | --- |
| `GET /api/oneshot/external-nfts/config` | Public, safe availability and verified network labels only |
| `GET/POST /api/oneshot/external-nfts/imports` | Current account's private page / new request |
| `GET/DELETE /api/oneshot/external-nfts/imports/:id` | Account-owned detail / exact-revision withdrawal |
| `GET /api/admin/external-nfts/imports` and `/:id` | Server-authenticated private queue/detail |
| `POST .../:id/review` | Exact revision, decision, customer note, private evidence |
| `POST .../:id/permit` | Exact approved revision; unsigned bundle only |
| `POST .../:id/validate-permit` | Fresh proof and signature simulation; unsigned call only |

## Contract foundation

`OneshotReviewedCollectionRegistry` permits authority-reviewed external ERC-721/ERC-2981 collections and excludes the pinned native factory's collections. Revocation consumes a version, invalidates old next-version permits and prevents new listings/purchases under revoked admission. Anyone may submit a valid authority permit; only the authority may revoke it. It has no fund/asset withdrawal power.

`OneshotReviewedMarketplace` is a separate version-4 ERC-721 market. Holder-initiated safe transfer plus an exact listing intent creates custody without blanket operator approval. IDs may be zero or sparse. The inclusive platform fee is 2%; the whole-item ERC-2981 quote must be valid and at most 10%. Price, recipient, royalty tuple, code hash and review version are pinned in the listing. A changed royalty quote requires cancel/relist; it is never silently clamped or treated as zero. Sales accrue pull-payment balances. Cancellation to another recipient and claims remain callable after registry revocation or royalty failure, subject to the NFT itself allowing transfer. Unsafe direct `transferFrom` deposits cannot be intercepted or rescued. No upgrade/admin rescue path was added.

This foundation currently has no external offers, cart checkout, ERC-1155 quantities or public transaction-review/receipt integration. Native V3 features do not automatically apply to it.

## Verification and remaining work

Final checks: **2,545 app tests**, **90 disposable PostgreSQL tests**, **134 Foundry tests**, all workspace/script TypeScript checks and both production builds passed. The default app command skips 94 environment-dependent cases; the database runner covers 90 of those. The previously blocked Windows junction case now passes in the complete host run. The restricted API build hit Windows `EPERM`; its host build passed. Final registry runtime is 4,750 bytes; market runtime is 7,507 bytes. These results are engineering checks, not an independent audit or actual Base deployment evidence.

Browser QA used isolated in-memory samples with signing disabled. It covered request submission without a linked wallet, administrator review, unsigned permit/call display, withdrawal consequences, account switching, unavailable configuration with retained history, failed/unreadable responses, desktop and 390px mobile layout. Related home/token/NFT/portfolio/activity/settings screens were rechecked for navigation/overflow. Screenshots/logs are in ignored `.local/qa/wallet-profiles`. The synthetic preview is `http://127.0.0.1:19405/nfts/import`; fixtures are never shipped in the public artifact. Existing large-bundle warnings remain.

The subsequent [20 November external NFT journal milestone](REVIEWED-NFT-JOURNAL.md) now provides canonical admission/events, reorg rollback, sparse ownership observations and read-only public records with explicitly partial coverage. Remaining agent work before external trading includes observed mutable metadata, customer list/buy/cancel/claim reviews, exact collection-transfer/market-event receipts, transaction recovery and integration into profiles/portfolio/feed. Do not reuse native dense token-ID or frozen-metadata assumptions. ERC-1155 issuance/trading needs its own quantity-aware design and integration.

Owner/release work remains separate: genuine Base contract deployment evidence and signed test receipts, authority custody/review policy, real Privy acceptance, independent contract review, dependency remediation and production capacity/retention/monitoring. Current-bytecode Anvil rehearsal remains blocked by Windows Application Control; no bypass was attempted. Zero awaits official network/AMM references. No contract was deployed, no authority signature was created and no transaction was broadcast in this milestone.

Primary references: [OpenZeppelin cryptography and interface utilities](https://docs.openzeppelin.com/contracts/5.x/api/utils), [ERC-165 staticcall detection](https://eips.ethereum.org/EIPS/eip-165), [ERC-2981 changing royalty quotes](https://eips.ethereum.org/EIPS/eip-2981), [EIP-712 domains and replay considerations](https://eips.ethereum.org/EIPS/eip-712). The repository retains pinned OpenZeppelin 5.6.1 and source licenses.
