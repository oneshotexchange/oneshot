# NFT collection search and filters

18 November 2026. This milestone adds complete item search within an indexed oneshot ERC-721 collection. It follows the [funded offers and cart milestone](NFT-MARKETPLACE-V3.md). It changes neither settlement contracts nor transaction authority. Base Sepolia remains the intended test network; no live deployment or wallet settlement is established by these checks.

## Customer behavior

The collection Items tab searches names or an exact serial such as `#17`, filters listed/unlisted items, owner, asking-price range and traits, and sorts by serial or asking price. Filters apply across the complete supported collection, including items beyond the first loaded page. Owner lookup includes a listing's seller while its NFT is in marketplace escrow. Prices are current canonical asking prices, not past sales or valuations. ETH inputs are parsed as exact 18-decimal amounts.

Trait values retain their JSON type: number `7` differs from string `"7"`. Choices for the same trait name are ORed; different trait names are ANDed. Facet counts describe all minted, unburned items before the selected filters. They are not rarity scores. Visible choices are bounded to 32 trait names and 30 values per name; the response marks truncation and the UI supports entering an additional typed value. Manual number entry rejects values that would round or lose integer precision.

Apply/Clear preserve unrelated URL parameters and verified deployment scope. Pagination rejects duplicate items, broken ordering and inconsistent totals. Changing filters preserves collection-page navigation and scroll without changing draft, wallet-selection or cart route behavior. Empty results, missing metadata filters and failed reads have distinct recovery messages. These public reads require no wallet.

## API and canonical scope

`GET /api/oneshot/indexed/collections/:address/explore` is separate from the existing `/items` resource. It supports:

| Parameter | Meaning |
| --- | --- |
| `q` | Case-insensitive literal name substring, or positive decimal serial with optional `#` |
| `availability` | `all`, `listed` or `unlisted` |
| `owner` | Nonzero wallet address; active escrow listings use their seller |
| `minPrice`, `maxPrice` | Inclusive human ETH amounts; require `availability=listed` |
| `sort` | `serial-asc`, `serial-desc`, `price-asc` or `price-desc`; price sorts require listed items |
| `traits` | Canonical UTF-8 base64url JSON array of `{trait_type,value}`, sorted by JSON `[trait_type,value]`; at most 10 distinct choices |
| `limit`, `cursor` | 1–50 items, default 20; opaque continuation |

Unknown or repeated query parameters are rejected. Shared response types live in `packages/evm/src/nft-discovery.ts`. Counts and native amounts remain decimal strings. Unavailable indexed context has `discovery: null`, rather than a successful empty catalog.

The explorer checks complete minted-item coverage, projection/journal provenance and opened-collection commitments in one held SQL snapshot. Active listings must agree with escrow ownership and their canonical Listed event. Cursor scope binds deployment, checkpoint number/hash, collection, normalized filters, page size, sort position and catalog commitment. A changed checkpoint or reorg requires refreshing from the beginning. The Items tab labels its own checkpoint and never merges pages across checkpoints; the surrounding collection summary can have its separately stated checkpoint.

## Verified metadata catalogs

Preparation retains the original metadata JSON strings in an immutable derived record under `oneshot_nft_catalogs`, using the existing application-record store. Every entry is rehashed against the original `oneshot_snapshots` serial map before metadata-dependent filtering. Presentations derive from those verified bytes, with retained local media paths. Public requests never fetch arbitrary metadata URLs, read private drafts, create schemas or backfill records. The catalog is consumed publicly only through a canonically opened collection's content commitment; there is no public catalog endpoint.

Missing catalogs allow serial, owner, availability and price browsing, with name/trait availability explicitly false. Name/trait queries then return a recoverable unavailable response. Corrupt or incomplete catalogs fail instead of silently dropping items or presenting an empty collection. New preparations build the catalog before the existing draft revision comparison; existing ownership, revision and draft-preservation rules remain in force.

Metadata uses the established `attributes` / `trait_type` / typed `value` convention documented by [OpenSea metadata standards](https://docs.opensea.io/docs/metadata-standards) and [media and traits](https://docs.opensea.io/docs/media-and-traits). Compatibility with that format does not establish external collection admission or an external marketplace integration.

Current explicit limits are 1,000 items, 256 KiB per original metadata JSON, 20 MiB total original metadata and 48 MiB serialized catalog record. The five-second explorer work budget starts inside the collection reader after acquisition/checkpoint work; it is not an end-to-end HTTP timeout. A separate ten-second SQL lease deadline includes acquisition and rollback. Surrounding RPC checks retain their existing independent bounds. The additional shared explorer request budget is 20 per minute before canonical reads; existing indexed limits also apply. Lease deadline expiry or request cancellation destroys the SQL connection, including connections acquired late. Normal PostgreSQL statement errors can still roll back and release normally. This uses the documented [node-postgres pool release behavior](https://node-postgres.com/apis/pool). Other indexed resources retain their existing leases.

These bounds are not production capacity evidence. Whole-catalog verification has CPU/memory and storage costs that need measurement under realistic traffic. Larger collections require a different catalog/index design.

## Existing snapshot backfill and repair

An operator can rebuild one explicitly selected catalog from already stored original metadata:

```sh
npm run nft:catalog:backfill -- --manifest-hash LOWERCASE_SHA256 --env-file PATH --output .local/qa/catalog-report.json
```

The hash is 64 lowercase hexadecimal characters without `0x`. No environment file is loaded implicitly. Omit `--env-file` only when the intended storage environment is already explicitly supplied. Reports are optional, local, must not already exist, and contain no raw metadata, owners or provider details. Use the command's `--help` for argument syntax. Production storage requires the existing durable database configuration.

The command downloads no URLs, signs no transaction, publishes no draft and resets no projections. It independently verifies every stored source byte against the committed snapshot before writing. A healthy catalog remains unchanged. A corrupt derived catalog can be replaced only with verified originals and an exact previous-value comparison; concurrent changes fail. Missing or changed original bytes fail without rewriting the catalog. The default backfill deadline is 60 seconds. Late reads cannot resume the workflow; an already dispatched storage mutation is not claimed to be undone. On timeout, inspect stored state before retrying. Pool shutdown is also bounded so a stuck transport cannot keep the CLI waiting indefinitely.

No SQL migration is added. Older prepared/opened collections require this explicit backfill for complete name/trait filters. Run it against the intended application storage, not a public browser or automatic read path.

## Validation and remaining work

Current checks: 2,422 app tests pass; 80 environment-dependent cases are skipped in the default command. The separate disposable PostgreSQL runner passes 76 cases, including 15 explorer integration cases. Workspace/script TypeScript checks and both production builds pass. The full suite used host permissions because the existing report-safety fixture creates a temporary Windows directory junction; the restricted sandbox denied that fixture setup. No Solidity changed in this milestone; the previous V3 milestone's 105 Foundry results are not a new actual-node run.

Coverage includes v1/v2/v3 projection compatibility, canonical provenance/accounting, full-collection filtering, exact large amounts, typed traits, truncation, stale cursors/reorgs, tampered catalogs, private-draft isolation, cancellation/deadlines, SQL lease cleanup and actual child-process backfill/repair with source corruption. Database test files run serially to avoid shared fixture schema initialization/cleanup races; explicit concurrency cases still run. This test-runner setting is not a production concurrency fix.

Agent desktop/mobile inspection covered search beyond the first page, loading 40 items, combined filters, price ordering, true empty results, missing/corrupt metadata, scroll preservation and related public screens. The signing-disabled synthetic [collection preview](http://127.0.0.1:19404/nfts/0x0000000000000000000000000000000000000004?deployment=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd&q=Nebula) is available while its local process runs. Proof images and logs are ignored under `.local/qa/nft-discovery`. These fixtures are neither live Base data nor owner approval; see [Phase 2 review](PHASE-2-REVIEW.md).

Remaining NFT product work includes creator/collector profiles, ERC-1155, external collection admission/royalty policy and larger catalog infrastructure. Release still requires genuine Base RPC/deployment/wallet evidence, a fresh actual-node V3/API rehearsal, independent contract review, dependency remediation and operational capacity/recovery testing. Windows Application Control previously blocked the pinned Anvil executable; no bypass was attempted. Existing large frontend chunks and wallet SDK dependency findings remain open. Zero integration waits for official network/AMM references. This milestone completes bounded collection search, not the entire marketplace or token/game roadmap.
