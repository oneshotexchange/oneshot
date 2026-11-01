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
