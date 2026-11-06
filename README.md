# oneshot

Token and NFT creation tools for Zero, with wallet authentication, saved NFT drafts, artwork uploads and a marketplace interface.

## Project structure

| Path | Purpose |
| --- | --- |
| `apps/web` | Vite and React frontend |
| `apps/api` | Next.js API, authentication and storage |
| `apps/indexer` | NFT event indexing |
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
```

Database and contract integration tests use isolated local services. They must not target production data.

## Deployment

The frontend deploys to Cloudflare Pages. The API and PostgreSQL run on Contabo behind Caddy, with private Cloudflare R2 storage for media and encrypted database backups. See the [deployment runbook](deploy/contabo/README.md).

For a Git-connected Pages project, use Node.js 22, build command `npm run build:web` and output directory `apps/web/dist`. Set `NEXT_PUBLIC_API_URL` to the HTTPS API origin and supply the public Privy app/client IDs. Server credentials must never enter the frontend build.

## Network availability

Zero network configuration and contract deployment remain unverified. Live minting, trading and chain indexing stay disabled until the network and deployments are verified. NFT transaction and marketplace flows currently support a verified local Anvil deployment only. Hosting the application does not enable production blockchain transactions.

Browser drafts remain local to the device. Account drafts require authentication and durable database storage; uploaded media requires configured object storage.

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
