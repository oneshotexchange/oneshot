#!/usr/bin/env bash
# Ephemeral Docker integration check. Never run against a configured deployment.
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [[ "${CI:-}" != true || -e .env || -e secrets ]]; then
  printf '%s\n' 'Requires CI=true and a clean checkout without deployment .env/secrets.' >&2
  exit 1
fi
project="oneshotci_${GITHUB_RUN_ID:-$$}_${GITHUB_RUN_ATTEMPT:-1}"
[[ "$project" =~ ^oneshotci_[a-z0-9_]+$ ]] || exit 1
compose() { docker compose --project-name "$project" "$@"; }
cleanup() {
  status=$?
  trap - EXIT
  if [[ "$status" -ne 0 ]]; then compose logs --tail=100 db api migrate >&2 || true; fi
  # Leave volumes intact; the ephemeral CI runner itself is discarded by CI.
  compose down --remove-orphans || true
  exit "$status"
}
trap cleanup EXIT
sh init-secrets.sh >/dev/null
cat > .env <<'ENV'
API_DOMAIN=api.oneshot-ci.com
WEB_ORIGIN=https://web.oneshot-ci.com
ACME_EMAIL=ci@oneshot-ci.com
IMAGE_TAG=ci
RESTIC_REPOSITORY=/backup/restic-ci
ENV
cat > secrets/api.env <<'ENV'
PRIVY_APP_ID=oneshot_ci_dummy
PRIVY_APP_SECRET=ci_dummy_not_a_real_secret
ONESHOT_ADMIN_PASSWORD=oneshot_ci_dummy_admin_password
S3_BUCKET=oneshot-ci-dummy
S3_REGION=auto
S3_ENDPOINT=https://example.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=ci_dummy
S3_SECRET_ACCESS_KEY=ci_dummy
ENV
printf 'ONESHOT_ADMIN_PASSWORD=oneshot_ci_dummy_admin_password\n' > secrets/worker.env
printf '\nBACKUP_MIN_FREE_MIB=64\n' >> secrets/backup.env
compose config --quiet
compose --profile operations build api migrate genesis-worker backup
compose up -d --wait db
compose run --rm migrate
compose up -d --no-deps --wait api
compose run --rm --no-deps genesis-worker node scripts/genesis-worker.mjs
# Validate the real proxy config without obtaining a certificate or binding ports.
compose run --rm --no-deps proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

compose exec -T api node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:3001';
const origin = 'https://web.oneshot-ci.com';
async function request(path, status, init = {}) {
  const response = await fetch(base + path, {
    ...init, headers: { Origin: origin, ...init.headers },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, status, `${init.method || 'GET'} ${path}`);
  assert.equal(response.headers.get('access-control-allow-origin'), origin, path);
  // Next's HTML 404 renderer replaces Vary after proxy handling, but keeps the
  // exact allow-origin and disables shared caching. Other responses retain it.
  assert.ok(response.headers.get('vary')?.includes('Origin')
    || status === 404 && response.headers.get('cache-control')?.includes('no-store'), path);
  return response;
}
await request('/api/health', 200);
const ready = await (await request('/api/ready', 200)).json();
assert.deepEqual(ready, { service: 'oneshot-api', ready: true });
await request('/api/does-not-exist', 404);
await request('/api/health', 405, { method: 'POST' });
await request('/api/oneshot/session', 401);
await request('/api/does-not-exist', 204, { method: 'OPTIONS', headers: {
  'Access-Control-Request-Method': 'POST',
  'Access-Control-Request-Headers': 'authorization,content-type',
} });
const denied = await fetch(base + '/api/health', { headers: { Origin: 'https://foreign.example.com' } });
assert.equal(denied.status, 403);
assert.equal(denied.headers.get('access-control-allow-origin'), null);
console.log('Real PostgreSQL readiness, auth rejection and CORS smoke checks passed.');
JS

# Seed a known record and prove backup/restore preserves it in a new database.
compose exec -T db psql -U postgres -d oneshot --set=ON_ERROR_STOP=1 <<'SQL'
INSERT INTO b20_app_records (namespace, id, value)
VALUES ('ci', 'restore-proof', '{"proof":"round-trip"}'::jsonb);
SQL
compose --profile operations run --rm backup init
compose --profile operations run --rm backup backup
snapshot="$(compose --profile operations run --rm --no-deps --entrypoint restic backup snapshots --json \
  | node --input-type=module -e 'let data="";for await(const part of process.stdin)data+=part;const records=JSON.parse(data);if(records.length!==1)throw Error("Expected one CI snapshot");process.stdout.write(records[0].id);')"
[[ "$snapshot" =~ ^[a-f0-9]{64}$ ]] || { printf '%s\n' 'Missing snapshot ID' >&2; exit 1; }
compose --profile operations run --rm backup check
compose --profile operations run --rm backup restore "$snapshot" oneshot_restore_ci
restored="$(compose exec -T db psql -U postgres -d oneshot_restore_ci --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 -c "SELECT value->>'proof' FROM b20_app_records WHERE namespace='ci' AND id='restore-proof'")"
[[ "$restored" == round-trip ]] || { printf '%s\n' 'Restored data did not match' >&2; exit 1; }

# Selecting a recovered DB must also redirect future backups to that database.
compose exec -T db psql -U postgres -d oneshot_restore_ci --set=ON_ERROR_STOP=1 <<'SQL'
UPDATE b20_app_records SET value='{"proof":"after-cutover"}'::jsonb
WHERE namespace='ci' AND id='restore-proof';
SQL
export POSTGRES_APP_DB=oneshot_restore_ci
compose --profile operations run --rm backup backup
snapshot="$(compose --profile operations run --rm --no-deps --entrypoint restic backup snapshots --json \
  | node --input-type=module -e 'let data="";for await(const part of process.stdin)data+=part;const records=JSON.parse(data);if(records.length!==2)throw Error("Expected two CI snapshots");records.sort((a,b)=>a.time.localeCompare(b.time));process.stdout.write(records.at(-1).id);')"
[[ "$snapshot" =~ ^[a-f0-9]{64}$ ]] || exit 1
compose --profile operations run --rm backup restore "$snapshot" oneshot_restore_after_cutover
restored="$(compose exec -T db psql -U postgres -d oneshot_restore_after_cutover --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 -c "SELECT value->>'proof' FROM b20_app_records WHERE namespace='ci' AND id='restore-proof'")"
[[ "$restored" == after-cutover ]] || { printf '%s\n' 'Backup did not follow database cutover' >&2; exit 1; }
compose --profile operations run --rm backup prune
printf '%s\n' 'Container build, migration, CORS, PostgreSQL and encrypted local backup/restore checks passed.'
