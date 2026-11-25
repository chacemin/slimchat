#!/bin/sh
set -eu

cd /app

# Idempotent: exits cleanly when the keyring already exists.
bun scripts/keyring.ts init

# Creates the schema on first run and applies pending migrations afterwards.
bun scripts/migrate.ts

# Only bootstrap when a password is provided; existing users are never overwritten.
if [ -n "${SLIMCHAT_ADMIN_PASSWORD:-}" ]; then
  bun scripts/admin-bootstrap.ts
fi

exec "$@"
