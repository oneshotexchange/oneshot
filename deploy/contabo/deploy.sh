#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
docker compose config --quiet
docker compose build --pull api migrate genesis-worker
docker compose up -d --wait db
docker compose run --rm migrate
# Migrations succeeded above. Restart only application/proxy, retain DB volume.
docker compose up -d --no-deps --wait api
docker compose up -d --no-deps proxy
docker compose up -d --no-deps genesis-worker
docker compose ps
