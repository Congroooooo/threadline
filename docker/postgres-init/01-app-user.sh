#!/bin/sh
# Runs once, when the Postgres volume is first created. Creates the role the app connects
# as, with a password, before the migrations run (migration 0001 then leaves it alone).
# app_user is not a superuser, has no BYPASSRLS and owns nothing, so row-level security
# always applies to it. The migrations run as POSTGRES_USER, which owns the tables.
set -eu
psql -v ON_ERROR_STOP=1 -v pw="$APP_USER_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE app_user LOGIN PASSWORD :'pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
SQL
