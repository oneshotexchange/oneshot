# Cloudflare web + Contabo API and PostgreSQL

This deployment runs the Node API, PostgreSQL 17 and a TLS reverse proxy on one
Linux VPS. The Vite web build is deployed independently to Cloudflare Pages and
calls the API directly. PostgreSQL has no published port. There is no Redis,
indexer or chain worker: the current Zero implementation does not enable one.
R2 holds private media and separately encrypted database backups.

The selected server reference is 12 GB RAM / 6 shared vCPUs with 200 GB SSD
(or 100 GB NVMe instead). The conservative runtime caps also fit an 8 GB host;
leaving headroom on the selected server is intentional. This is not a
promise of 10 million transactions/month capacity. These are self-managed
services on one host, with one failure domain and no automatic failover. Provider
backups are separate from the application backups described below.

## Prepare Ubuntu and DNS

Use Ubuntu 24.04 LTS x86-64 and install Docker Engine plus the Compose plugin
using the [official Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/).
Docker Compose 2.30+ is required (raw secret environment files). These instructions assume an SSH user allowed to
run Docker (otherwise prefix Docker commands with `sudo`). Keep SSH restricted to
your trusted IPs; allow inbound TCP 80/443 and optionally UDP 443. Docker publishes
ports using its own firewall rules, so only the proxy declares published ports.

Create an `A` record for `api.example.com` pointing to the VPS IPv4. Initially use
DNS-only mode so Caddy can obtain its certificate. Do not add an `AAAA` record
unless IPv6 routing and firewall rules also work. The frontend hostname continues
pointing to Cloudflare Pages. Caddy stores certificates in its named volume.

Clone this repository on the server, for example to `/opt/oneshot`, then:

```sh
cd /opt/oneshot/deploy/contabo
sh init-secrets.sh
```

The script generates missing database and backup encryption passwords without
printing them. It preserves existing secrets. Its `secrets/` directory has mode
0700; mounted password files are readable by the non-root Node container. Save
the restic password in an external password manager: losing it makes backup
recovery impossible. Keep the whole secrets directory out of Git and image builds.

Edit `.env` with the actual API hostname, exact frontend origin, certificate
email and a unique `IMAGE_TAG` (normally the Git commit ID). Edit
`secrets/api.env` with Privy credentials and object storage configuration. Allow
the frontend's exact origin in Privy. Never put server credentials in the web's
`NEXT_PUBLIC_` variables. `WEB_ORIGIN` must include `https://` and have no path/trailing
slash; `API_DOMAIN` must be a bare hostname. The API receives
`NEXT_PUBLIC_APP_URL` for the web origin and `ONESHOT_API_URL` for its public URL.
Secret environment files use raw values: do not wrap credentials in quotes or
append inline comments. Literal dollar signs are preserved.

## Private R2 storage

Create **two private R2 buckets in Standard storage class**, for example
`oneshot-media` and `oneshot-backups`. Keep public access and `r2.dev` disabled.
Media is served through the API's existing validation and ownership rules; the
web must not receive R2 credentials. Configure `S3_*` in `secrets/api.env` with an
API token restricted to the media bucket, and put the account S3 endpoint in
`S3_ENDPOINT`. Do not use a public R2 custom domain for private objects.

Use a different bucket-scoped read/write token in `secrets/backup.env` and put the
backup repository endpoint/bucket/path in `.env`. Restic encrypts data and names
before upload. Do not configure lifecycle expiry inside the restic repository:
arbitrary object expiry corrupts it. Retention is managed by restic. Bucket/token
creation is manual; no account resources are created by these files.

R2 Standard charges depend on stored bytes and operations after the account's
shared free allowance. These services do not make media or backup storage
unlimited or necessarily free. Infrequent Access adds retrieval/minimum-duration
costs and is not the default here. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## Build, migrate and start

```sh
cd /opt/oneshot/deploy/contabo
sh deploy.sh
docker compose logs --tail=80 api
curl --fail https://api.example.com/api/health
curl --fail https://api.example.com/api/ready
```

`deploy.sh` validates Compose without printing resolved settings, builds the API
standalone and separate migration images, waits for PostgreSQL, runs
`npm run db:migrate`'s entrypoint, and starts the API/proxy. Existing application
and retained legacy indexer tables are migrated; no chain process is enabled.
The PostgreSQL role used by the API owns its database and is not a superuser.
Its connection URL is assembled from the mounted password file at runtime, with
reserved password characters escaped. Do not add a literal `DATABASE_URL` to
Compose. Database passwords in files are initialization settings: changing them
does not rotate passwords inside an existing cluster.

The Docker build runs `npm ci` at the repository root and `npm run build:api`.
It excludes local `.env` files, secrets, dependencies and build artifacts from its
context. No credentials are passed as build arguments. Build-time dependencies
are not part of the API runtime image. A build can temporarily use extra memory;
build/push images in CI if an already-busy 8 GB VPS has insufficient headroom.
Node 22 and PostgreSQL 17 are pinned to majors; rebuild/pull regularly for patched
images. PostgreSQL major upgrades need a separate tested migration, not a tag swap.

Runtime memory caps are PostgreSQL 3 GB, API 2 GB, Caddy 256 MB; the backup job is
capped at 768 MB, leaving some host/build headroom. CPU caps share the 4 cores and
do not reserve dedicated physical cores. Docker restarts exited services;
health checks report failed dependencies but do not automatically restart a
still-running unhealthy container. Watch memory, disk, health, errors and latency.

Build/deploy the frontend to Cloudflare Pages using its own instructions. Set
`NEXT_PUBLIC_API_URL=https://api.example.com` for that frontend build, plus the
public Privy app/client IDs. Test account login,
image upload/read and draft save/read from the deployed frontend. A healthy API
alone does not prove authentication, R2 permissions or complete app flows.

## Encrypted logical backups and restore drill

Initialize the repository once, then make and verify a backup:

```sh
docker compose --profile operations build --pull backup
docker compose --profile operations run --rm backup init
docker compose --profile operations run --rm backup backup
docker compose --profile operations run --rm backup snapshots
docker compose --profile operations run --rm backup check
```

The backup job first completes a gzip-compressed PostgreSQL custom-format logical
dump on the VPS and checks its archive directory, then uploads it with restic.
An archive-directory check is not a complete restore test. Dump files are removed
after the job, including failures and catchable interruptions. A daily full
logical dump gives roughly 24-hour recovery-point granularity; it is not WAL archiving or
point-in-time recovery. At higher write volume choose an appropriate recovery
objective and upgrade this backup design.

### Backup disk budget

The server's advertised disk capacity is shared by PostgreSQL data/indexes, WAL,
Docker images, the OS, the temporary dump and any retained restore drills. Docker
memory limits do not cap these files. The backup reads actual free space on
`/backup`'s filesystem; default Docker named volumes share the host filesystem
with PostgreSQL. If those volumes are moved onto separate filesystems, monitor
each filesystem independently.

The dump guard does not cap a restore's new database. Before a restore drill,
budget space for its downloaded archive and an additional database/index copy,
and retain enough free space for the running production database and WAL.

The default job reserves **20 GiB** of free filesystem space. Before dumping it
sets a Linux per-file limit to free space minus that reserve and a small rounding
margin, or a lower explicitly configured dump limit. During the dump it checks
free space every second and aborts if the reserve is reached or a check fails.
Failed/oversize dumps are removed and never uploaded as successful backups.
These controls limit this dump; they are not a filesystem quota and cannot
guarantee space against other writers between checks. Keep disk monitoring and
alerting active for PostgreSQL, WAL, Docker and retained recovery files.

Optional settings go in `secrets/backup.env` (raw values, without quotes):

| Setting | Default | Meaning |
| --- | ---: | --- |
| `BACKUP_MIN_FREE_MIB` | `20480` | Free-space reserve; a positive integer in MiB |
| `BACKUP_MAX_DUMP_MIB` | `0` | Additional dump-file cap in MiB; `0` uses the available budget |
| `BACKUP_DISK_POLL_SECONDS` | `1` | Free-space check interval, from 1 to 60 seconds |

For example, `BACKUP_MAX_DUMP_MIB=51200` caps the compressed file at 50 GiB even
when more space is available. The log reports `pg_database_size` as a planning
input, not a prediction of dump size: indexes, TOAST and compression affect the
comparison. Measure successful compressed dumps and growth; do not assume a
fixed compression ratio. Compressed archives can also reduce restic's ability
to deduplicate changes; measure retained repository growth. Disposable CI can
use a smaller reserve for its tiny test database; the production reserve should
reflect actual WAL/write growth.

When the disk budget no longer fits, extend the provider disk/filesystem or move
the data/dump volume using a reviewed migration and verified backup. Adding disk
at the provider does not automatically prove that the guest filesystem or Docker
volume has grown. Check filesystem free space after the change. Do not change a
named volume or Compose project name to obtain space: doing so can abandon the
existing database. Retention/archive changes and recovery-file cleanup require
an explicit data policy; this job does not delete application history.

Use an explicit snapshot ID from `snapshots` and restore into a **new** database:

```sh
docker compose --profile operations run --rm backup restore SNAPSHOT_ID oneshot_restore_drill
```

The command refuses the production database name and refuses an existing target.
It leaves a recovered dump under the ignored `restore/` directory and prints
record counts from the restored database. Check those records and app behavior
before selecting any recovered DB. To use a validated restore, set
`POSTGRES_APP_DB=oneshot_restore_drill` in `.env`, then run `deploy.sh`. This selects
the same database for the API, migrations and future backups. Initial bootstrap
always creates `oneshot`; keep that selection for a new cluster. Retain
the original production database until recovery is accepted. No script drops a
database or deletes a Docker volume. `restore/` can contain plaintext personal
data; restrict access and clean it according to your retention policy.

Schedule daily backups in the host's root crontab (`sudo crontab -e`). Times below
use UTC if the server is configured to UTC; adjust intentionally for its timezone:

```cron
15 2 * * * cd /opt/oneshot/deploy/contabo && /usr/bin/flock -n /run/oneshot-backup.lock /usr/bin/docker compose --profile operations run --rm backup backup >> /var/log/oneshot-backup.log 2>&1
45 3 * * 0 cd /opt/oneshot/deploy/contabo && /usr/bin/flock -n /run/oneshot-backup.lock /usr/bin/docker compose --profile operations run --rm backup prune >> /var/log/oneshot-backup.log 2>&1
```

Retention keeps 7 daily, 4 weekly and 3 monthly snapshots for this database tag/host.
Weekly prune removes expired snapshots and checks repository metadata. Monitor
the job exit status/logs and add log rotation; a cron entry alone gives no failure
notification. Keep enough R2 storage for retained changes and run regular restore
drills. Separate media retention must also be configured; PostgreSQL dumps do
not contain the media bucket's objects. Existing media is not deleted by these jobs.

## Updates and rollback

Before an update, take a successful backup, record the running `IMAGE_TAG`, and
retain the previous API and migration images. Pull the chosen Git commit, select
a new tag in `.env`, and run `sh deploy.sh`. Inspect readiness and the frontend
flows after deployment. Avoid pruning old images until the release is accepted.

To roll back application code without rebuilding it, set the previous `IMAGE_TAG`
in `.env` and run:

```sh
docker compose up -d --no-deps --no-build api
docker compose ps
```

This does not reverse schema/data changes. Only roll back across a compatible
schema; otherwise restore a verified snapshot into a separate DB and select it
as above. Do not run `docker compose down -v`, delete `postgres_data`, or change
the Compose project name on an existing deployment. That can remove or abandon
the database volume. `docker compose down` without `-v` preserves named volumes.

## Verification status and references

The files are deployment infrastructure, not evidence of a live deployment or a
10 million transaction benchmark. On a Docker-capable host verify Compose config,
image builds, migration, readiness, actual authenticated flows, backup and restore
before routing production traffic. Credentials, a server, DNS and R2 access are
required. No provider resources have been purchased or deployed by this change.

- [Docker startup ordering](https://docs.docker.com/compose/how-tos/startup-order/)
- [Next.js standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
- [PostgreSQL image secrets and persistent data](https://hub.docker.com/_/postgres)
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [Restic S3 repositories and password files](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)
- [Restic retention](https://restic.readthedocs.io/en/stable/060_forget.html)
