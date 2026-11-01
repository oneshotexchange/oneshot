#!/bin/sh
set -eu

# This runs only for a new PostgreSQL volume. The application is not a superuser.
export ONESHOT_DB_PASSWORD="$(cat /run/secrets/postgres_password)"
psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password ONESHOT_DB_PASSWORD
CREATE ROLE oneshot LOGIN PASSWORD :'app_password';
CREATE DATABASE oneshot OWNER oneshot;
SQL
unset ONESHOT_DB_PASSWORD
