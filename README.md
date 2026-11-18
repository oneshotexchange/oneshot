# oneshot

Token and NFT creation, launch and marketplace tools. Base Sepolia is the current test-network target; Zero remains a future integration after its network and AMM references are available.

The [NFT V3 milestone](NFT-MARKETPLACE-V3.md) adds funded item/collection offers, partial fills and refunds, atomic multi-item checkout, exact transaction reviews and canonical offer accounting. New offline deployment plans target V3; existing deployed v1/v2 marketplaces retain their existing features. Base deployment and real wallet evidence remain pending.

The subsequent [NFT collection search milestone](NFT-DISCOVERY.md) adds complete name/serial search, typed traits, owner and exact asking-price filters, sorting and checkpoint-bound pagination for collections up to 1,000 items. Verified metadata catalogs and an explicit stored-source backfill keep private drafts and failed metadata reads out of public search results.

## Project structure

| Path | Purpose |
| --- | --- |
| `apps/web` | Vite and React frontend |
| `apps/api` | Next.js API, authentication and storage |
| `apps/indexer` | Canonical NFT/token event indexing and bounded token contract snapshots |
| `packages` | Shared types and client libraries |
| `contracts-evm` | Solidity contracts and Foundry tests |
| `db` | PostgreSQL schema |
| `deploy/contabo` | API, database, HTTPS and backup deployment |

## Development

Requires Node.js 22.12 or newer and Docker for PostgreSQL.

```sh
npm ci
npm run dev:setup
npm run db:local -- up
npm run db:local -- migrate
npm run dev
```

The frontend runs at `http://127.0.0.1:3000` and the API at `http://127.0.0.1:3001`. Setup preserves existing environment files and local data. Configure public client settings in `apps/web/.env.local` and server credentials in `apps/api/.env.local`, using the supplied examples. Account features require a Privy application with the frontend origin allowed.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:database
```

Contract checks also require Foundry:

```sh
npm run contracts:test
npm run contracts:smoke
npm run contracts:smoke:v4
```

Database and contract integration tests use isolated local services. They must not target production data.

## Deployment

The frontend deploys to Cloudflare Pages. The API and PostgreSQL run on Contabo behind Caddy, with private Cloudflare R2 storage for media and encrypted database backups. See the [deployment runbook](deploy/contabo/README.md).

For a Git-connected Pages project, use Node.js 22, build command `npm run build:web` and output directory `apps/web/dist`. Set `NEXT_PUBLIC_API_URL` to the HTTPS API origin and supply the public Privy app/client IDs. Server credentials must never enter the frontend build.

## Network availability

Base Sepolia (chain 84532, test ETH with 18 decimals) and local Anvil (31337) have explicit, separate execution profiles. NFT reviews, guarded listing permits, receipts and indexing use the verified deployment's chain. Token launch, exact-input trading and fee claims use the immutable v4 market engine described in [the contract reference](contracts-evm/README.md). The November 16 v4 local rehearsal covers contract execution and authenticated application reviews and receipt recovery for that earlier bytecode. The subsequent metadata admission changes have Foundry coverage; Windows Application Control currently prevents a fresh Anvil run. These local results do not establish a Base deployment. Hosting the application alone never enables transactions. See [the build status and three-phase release plan](BASE-SEPOLIA.md).

Base execution requires independently verified RPC identity, canonical deployment manifests and separate NFT/token opt-ins. The public RPC identity probe is `npm run verify:base-sepolia -- --env-file PATH`; it never signs or submits a transaction. The offline unsigned deployment planner, `npm run contracts:plan:base -- --help`, prepares six explicit wallet transactions and size/hash evidence without publishing them. Zero remains disabled until its own network, deployment and AMM have been verified.

Token discovery uses `/api/oneshot/token-indexed/markets`, independently of the legacy token API. `npm run indexer:token-snapshot -- --manifest PATH` verifies and atomically stores a complete canonical contract snapshot in a dedicated local PostgreSQL database. This development discovery worker is bounded to at most 25 markets (default 10); a larger registry fails without committing a partial result.

`npm run indexer:token-events -- --help` describes the separate resumable event journal. Hash-selected factory, pool, market and token logs drive exact prices, volume, balances and burns with atomic rollback. It avoids the snapshot ceiling, but retains explicit limits: 1,024 registered markets, four new markets and 10,000 logs per block, 768 logical reads/45 seconds per capture and 16 blocks of reorg recovery. Its current address/topic batches scan known registrations per block; this is not an unlimited-scale ingestion design. Production capacity work and broader discovery pagination remain release requirements.

The separately enabled `/api/oneshot/token-analytics/markets/:market` API provides prices, trades and holders at a held canonical checkpoint. Pool volume includes all routes; oneshot executions and fees are separate totals. External pool-event traders remain unknown. Wallet reads at `/api/oneshot/token-analytics/wallets/:wallet` verify exact token balances at the same hash and require complete wallet-aware journal coverage. Older journals return unavailable until an explicit tested replay; public reads never reset or backfill them. The UI shows sampled loaded-swap price history, exact ratio values, lag, holder scope and paginated balances without inventing cash values or P&L.

Authenticated `/api/oneshot/token-execution/` routes prepare and revalidate exact calls before the customer's wallet signs. Sell approval is a separate exact allowance; buy fees come from the total native input and sell fees from actual gross output. Reviews disclose the current directional protocol/LP fee and require a new review after a fee change. Receipt tracking checks the complete wallet call, chain and canonical inclusion; confirmations remain explicitly unfinalized. No signing keys are used by this token service.

NFT and token issuance reject malformed UTF-8, control-only/blank metadata and a leading BOM before registering a launch. Normal Unicode and emoji remain supported within the existing name/symbol byte limits. This prevents permissionless direct launches from creating records that the decoders cannot safely index.

For separately scoped, read-only RPC evidence, use an independently prepared deployment plan:

```sh
npm run verify:rpc-capabilities -- --plan PATH_TO_PLAN.json --env-file PATH_TO_NETWORK.env
```

See [the capability plan and report reference](packages/evm/RPC-CAPABILITIES.md). This command never enables execution, signs or submits transactions. It supplements `verify:network`; it does not replace deployment verification or establish that Zero, an NFT deployment or an AMM is ready.

Browser drafts remain local to the device. Account drafts require authentication and durable database storage; uploaded media requires configured object storage.

Token creators can also save up to 20 private account copies without linking a wallet. Authenticated `/api/oneshot/token-drafts` routes preserve incomplete terms and exact valuation strings, enforce ownership and capacity atomically, and require the previous revision to update or archive a copy. Currency changes require a new copy. Copy to editor explicitly creates a browser working copy; it does not edit the account record, and pending copies are cancelled when the account changes. Existing browser terms remain protected before replacement. Production account storage requires PostgreSQL and never silently falls back to local files.

Token creators can keep up to 20 named browser drafts alongside an autosaved working copy. Legacy Zero storage remains unchanged; new storage has separate versioned keys with optimistic migration snapshots. A Base copy clears prices or opening valuation and requires deliberate test ETH amounts. Account drafts cannot change their currency tag in place. Both creation pages support versioned JSON backups that restore editable terms as a new draft. Backups do not include image bytes, account credentials, prepared metadata snapshots or transaction authority. Collection imports require the original images again before uploading. Unreadable storage and stale-tab writes are blocked; saving a new draft at capacity does not evict existing work.

NFT creation also preserves incomplete browser working terms separately from named drafts. Account edits remain in memory until explicitly saved to the account; only Copy to new draft creates a browser copy. Navigation warns before losing selected artwork bytes, unsaved account edits or browser terms that could not be saved. Selected image bytes are never stored in the browser working copy.

Media uploads reserve quota through per-attempt 60-second leases and publish their metadata only after storage succeeds. Failed attempts release their own reservation; interrupted leases expire. Existing published content is retained. Physical orphan objects from ambiguous provider timeouts and legacy failed-upload records require separate conservative reconciliation.

## NFT browsing

Collection details include marketplace activity from the same canonical indexed checkpoint as the collection record. `marketStats` reports exact string counts (`activeListings`, `completedSales`) and native base-unit totals (`lowestListingPriceRaw`, `secondaryVolumeRaw`). The lowest listing is a public asking price; it does not expose a creator's private listing policy. No active listings returns a null lowest price. Missing or invalid statistics are unavailable, not a zero-activity market.

Active listings must match the marketplace's current escrow item. Completed resales retain their history after later ownership changes. Resale volume is the gross buyer total on oneshot, including settlement fees and royalties, excluding primary mints and gas. These are all-time indexed totals, not 24-hour statistics or finality claims. Discovery cards do not request per-collection aggregates.

The indexer initializer adds the listing collection/status index idempotently; public reads never migrate the database. Plan its additive index build before rollout on an existing large dataset. No projection reset or backfill is required. The client tolerates an older API without statistics and offers a refresh action. Checkout still verifies current terms independently before review and pauses wallet setup/approval guidance during failed or pending terms reads; saved receipts remain accessible.

## Genesis whitelist

`/whitelist` uses official X OAuth with PKCE for applications, public-post/follow verification, referrals,
private application status, opt-in invitation cards and nominations. `/admin/genesis`
uses the existing server-authenticated administrator session to configure the window,
review applications, allocate up to 750 guaranteed places and publish decisions.
Unspent nomination quotas reserve capacity within the same 750 places.

Run the additive database migration before hosted use. Set `X_OAUTH_CLIENT_ID` and
the optional confidential-client `X_OAUTH_CLIENT_SECRET` on the API. Register the exact
callback `<WEB_ORIGIN>/api/oneshot/genesis/auth/callback` on the X application; an
optional `X_OAUTH_REDIRECT_URI` must match it exactly. Only `users.read tweet.read`
scopes are requested. The verified numeric ID and public profile are saved in the
database; X tokens are discarded. Returning users use an opaque, revocable, 30-day
HttpOnly session cookie. The whitelist does not load Privy or require its app keys.
Existing wallet/creator authentication continues to use the main app's Privy setup.
Set `GETX_API_KEY` only on the API for checks using the saved X ID. The campaign starts as upcoming; opening requires
the official numeric X ID and matching handle, dates, and reviewed campaign/provider
terms. Public pages do not expose provider or infrastructure configuration.

Verification runs immediately when requested, with durable retry jobs on outages.
Run the background retry command against the configured API:

```sh
npm run genesis:worker -- --env-file apps/api/.env.local --watch
```

The worker uses the server administrator credential, keeps its session in memory,
and processes bounded batches. It does not run blockchain jobs. Configure it as a
separate supervised process in hosting; an administrator can also process a batch
from the Genesis review screen.

The Cloudflare artifact includes `/g/:code` invitation and `/api/oneshot/genesis/*`
first-party account proxies. Set the Pages
runtime binding `GENESIS_API_ORIGIN` to the public HTTPS API origin. The worker serves
all other paths from static assets. Host-only cookies pass through the first-party
account proxy, so the flow works without cross-site authentication cookies. OAuth
state is persisted, expires after ten minutes and is atomically consumed only for
the initiating browser. All cookie-authenticated writes require the configured web
origin and the expected session identity. The API renders crawler-visible metadata and PNG
cards; personal X details appear only after explicit sharing consent. Local Vite
development proxies these links to port 3001. Review crawler previews after deployment.

Genesis applications do not require a wallet or enabled blockchain execution.
Collection supply preparation, mint-wallet binding, final contract distribution and
live minting remain separate milestones. The current NFT creator's 1,000-item limit
has not been silently raised to support a 10,000-item collection.
