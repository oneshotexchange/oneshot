# Local persistent PostgreSQL

The local development database is separate from Contabo production. This Compose
project starts only official PostgreSQL 17, exposes it on **127.0.0.1:5433**, and
persists its data in `oneshot-local_postgres_data`. Existing Docker projects,
databases and volumes are not used or modified. The credentials below are
deliberately disposable local credentials and must never be reused in production.

The app and integration tests use separate databases and roles:

| Purpose | Database / role | Local password |
| --- | --- | --- |
| Application | `oneshot_dev` | `oneshot_dev_local_only` |
| API and indexer integration tests | `oneshot_indexer_test` | `oneshot_test_local_only` |

PostgreSQL initializes both databases when the project's volume is first created.
The application role is not a superuser. Application and test roles cannot
connect to each other's database. The bootstrap administrator is local-only. Changing bootstrap SQL or
passwords later does not automatically update an existing volume.

## Start and verify

From the repository root, with its existing Node dependencies installed:

```sh
node deploy/local/db.mjs doctor
node deploy/local/db.mjs up
node deploy/local/db.mjs migrate
node deploy/local/db.mjs test
```

`up` starts only project `oneshot-local`, waits for the final PostgreSQL TCP
server, then checks both databases with real SQL. `migrate` runs the existing
application and retained legacy schema migration against the development DB.
`test` runs the API and indexer real PostgreSQL integration test files against the
dedicated test DB. It sets both explicit test URLs and removes any ambient
`DATABASE_URL` from that test process. The fixtures scope cleanup to their own
records/manifests; they do not truncate unrelated records.

The separate [capacity rehearsal](../../docs/LOCAL-CAPACITY.md) uses this dedicated test database, disposable local chain/API processes and bounded workloads. Build the API first, then select the test database explicitly through `npm run test:capacity`. It does not load the development database or change production configuration.

The cross-platform helper uses a native local Docker context, or on Windows the
existing Docker Engine in WSL `Ubuntu-24.04`. It does not install software, change
Docker daemon settings, use a remote context, or deploy anything externally.
Set `ONESHOT_WSL_DISTRO` if your existing Docker-capable WSL distribution has a
different name. On Windows its PostgreSQL connection uses WSL's localhost
forwarding; `up` reports a connection failure if that forwarding is unavailable.
Keep WSL localhost forwarding enabled or run the commands inside your WSL
checkout with an existing Linux Node installation.

WSL can stop its distribution soon after its last foreground client exits, even
when Docker containers have restart policies. The `up`, `check`, `migrate` and
`test` commands keep an owned foreground WSL client alive for their duration.
Keep one active while using the database from another Windows process:

```sh
node deploy/local/db.mjs hold
```

Leave that terminal open, or let the repository's development supervisor own the
keeper when using the managed local DB. Stop the holder with Ctrl+C. The exported
`startLocalDatabaseKeeper` helper returns an owned `stop()` handle for supervision.
Stopping closes stdin so its Linux shell exits normally; await the returned
promise to confirm cleanup. It does not change WSL settings, terminate a distribution, or stop Docker. Native
Docker does not need this holder.

If port 5433 is already occupied, choose an unused loopback port by setting
`ONESHOT_LOCAL_DB_PORT` consistently for all helper commands and update the app's
development URL to match. Do not stop another project's service to free a port.

```powershell
$env:ONESHOT_LOCAL_DB_PORT = '5434'
node deploy/local/db.mjs up
```

On Linux/macOS use `ONESHOT_LOCAL_DB_PORT=5434 node deploy/local/db.mjs up` and
set that same variable for subsequent commands.

## Connect the local API

`node deploy/local/db.mjs env` prints these **local-only** URLs:

```dotenv
DATABASE_URL=postgresql://oneshot_dev:oneshot_dev_local_only@127.0.0.1:5433/oneshot_dev
ONESHOT_INDEXER_TEST_DATABASE_URL=postgresql://oneshot_indexer_test:oneshot_test_local_only@127.0.0.1:5433/oneshot_indexer_test
ONESHOT_API_TEST_DATABASE_URL=postgresql://oneshot_indexer_test:oneshot_test_local_only@127.0.0.1:5433/oneshot_indexer_test
```

Set the first URL in the API's ignored local environment or provide it only to
your local API process. The helper deliberately does not write any app `.env`
files or read production configuration. Start the web/API using the repository's
normal `npm run dev` command after configuration. No chain indexer or worker is
enabled by starting this database.
The API and indexer integration URLs both point to the dedicated test database;
their fixtures use different tables and scope record cleanup to their own tests.

This folder does not add an object storage emulator. Hosted media and backups
remain Cloudflare R2; the API's existing development file storage can be used
without Cloudflare credentials. Database readiness alone does not prove a Privy
login, an R2 upload or a live chain connection. The production `/api/ready` route
requires S3 configuration, so it can report 503 during file-based local media
development even when this PostgreSQL check passes.

## Stop without deleting data

```sh
node deploy/local/db.mjs status
node deploy/local/db.mjs check
node deploy/local/db.mjs stop
```

`stop` preserves the container and database volume; `up` reuses them. The helper
has no volume deletion or reset command. Do not run `down -v`, delete the named
volume, or change the project name to reset the database. Keep any data you need
before a future PostgreSQL major-version upgrade.

The server is capped at 1 GB RAM and one shared CPU for local use. It is not a
production configuration or a capacity benchmark. See the
[official PostgreSQL image documentation](https://hub.docker.com/_/postgres)
for its initialization and persistent-volume behavior.
