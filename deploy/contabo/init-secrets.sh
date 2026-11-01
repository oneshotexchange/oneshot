#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
umask 077
mkdir -p secrets restore
chmod 0700 secrets restore
for name in postgres_admin_password postgres_password restic_password; do
  if [ ! -e "secrets/$name" ]; then
    openssl rand -hex 32 > "secrets/$name"
  fi
  # Docker bind-backed secrets keep host permissions. The non-root Node user
  # must be able to read its mounted secret; the host parent directory is 0700.
  chmod 0444 "secrets/$name"
done
if [ ! -e .env ]; then cp .env.example .env; fi
if [ ! -e secrets/api.env ]; then cp api.env.example secrets/api.env; fi
if [ ! -e secrets/backup.env ]; then cp backup.env.example secrets/backup.env; fi
chmod 0600 .env secrets/api.env secrets/backup.env
printf '%s\n' 'Created missing files only. Edit .env and secrets/*.env, and save the restic key off this server.'
