#!/usr/bin/env bash
#
# Stand up a local ExtendDB and emit the env the conformance suite needs.
#
# ExtendDB ships no binaries, so this builds it from source, initialises it
# against PostgreSQL, mints a dynamodb:* IAM access key, and starts the server.
# It is used by the ExtendDB CI job and is runnable locally.
#
# Required:
#   EXTENDDB_DIR              path to an ExtendDB checkout (built or buildable)
#
# Optional (defaults shown):
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres
#   EXTENDDB_PORT=8000
#   EXTENDDB_ADMIN_PASSWORD   admin password (generated if unset; init reads it)
#   ACCOUNT_ID=123456789012   12-digit account the conformance user lives in
#   IAM_USER=conformance
#   BUILD=1                   set 0 to skip the cargo build when already built
#
# On success it emits the suite env (DYNAMODB_ENDPOINT, NODE_EXTRA_CA_CERTS,
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION). In CI ($GITHUB_ENV set)
# it appends them there and masks the secret; otherwise it prints `export`
# lines suitable for `eval "$(EXTENDDB_DIR=... ./scripts/run-extenddb.sh)"`.
set -euo pipefail

: "${EXTENDDB_DIR:?set EXTENDDB_DIR to an ExtendDB checkout}"
PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-postgres}
PGPASSWORD=${PGPASSWORD:-postgres}
EXTENDDB_PORT=${EXTENDDB_PORT:-8000}
ACCOUNT_ID=${ACCOUNT_ID:-123456789012}
IAM_USER=${IAM_USER:-conformance}

command -v jq >/dev/null || { echo "ERROR: jq is required" >&2; exit 1; }

# 40 hex chars from 20 random bytes. Avoids `tr </dev/urandom | head`, which
# SIGPIPEs tr (exit 141) under `set -o pipefail` once head closes the pipe.
rand() { LC_ALL=C od -An -tx1 -N20 /dev/urandom | tr -dc 'a-f0-9'; }
EXTENDDB_ADMIN_PASSWORD=${EXTENDDB_ADMIN_PASSWORD:-$(rand)}
export EXTENDDB_ADMIN_PASSWORD

# All build/init/serve/manage commands run from the ExtendDB checkout, where
# init writes extenddb.toml and ~/.extenddb/ (cert + run state) live.
cd "$EXTENDDB_DIR"
BIN=target/release/extenddb
CERT="${HOME}/.extenddb/tls/cert.pem"

if [ "${BUILD:-1}" = "1" ] && [ ! -x "$BIN" ]; then
  echo "==> building ExtendDB (release)" >&2
  cargo build --release
fi

echo "==> extenddb init" >&2
# init and serve print banners to stdout; route to stderr so this script's only
# stdout is the `export` block below (so `eval "$(run-extenddb.sh)"` works).
"$BIN" init --pg-host "$PGHOST" --pg-port "$PGPORT" --pg-user "$PGUSER" --pg-pass "$PGPASSWORD" >&2

# Pure-timing knob: make table create/delete transitions instant. This has no
# effect on the conformance signal (the suite polls for ACTIVE either way); it
# only keeps the run fast. Throttling and GSI propagation are left at ExtendDB's
# defaults so the measured behaviour stays faithful. Best-effort.
"$BIN" settings --config extenddb.toml set control_plane_delay_seconds 0 >&2 || true

echo "==> extenddb serve" >&2
"$BIN" serve --config extenddb.toml >&2

# Wait for the server to answer over TLS before driving the management API.
ready=0
for _ in $(seq 1 30); do
  if curl -fsS --cacert "$CERT" "https://127.0.0.1:${EXTENDDB_PORT}/health" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "ERROR: ExtendDB did not become healthy on :${EXTENDDB_PORT}" >&2
  "$BIN" status --config extenddb.toml >&2 || true
  exit 1
fi

mng() { "$BIN" manage --user admin --password "$EXTENDDB_ADMIN_PASSWORD" --config extenddb.toml "$@"; }

echo "==> create account, user, dynamodb:* policy" >&2
mng create-account --account-id "$ACCOUNT_ID" --account-name conformance >&2
mng create-user --account-id "$ACCOUNT_ID" --user-name "$IAM_USER" --user-password "$(rand)" >&2
mng put-user-policy --account-id "$ACCOUNT_ID" --user-name "$IAM_USER" \
  --policy-name allowddb \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"dynamodb:*","Resource":"*"}]}' >&2

echo "==> mint access key" >&2
key_json=$(mng create-access-key --account-id "$ACCOUNT_ID" --user-name "$IAM_USER")
akid=$(printf '%s' "$key_json" | jq -r '.access_key_id // empty')
secret=$(printf '%s' "$key_json" | jq -r '.secret_access_key // empty')
if [ -z "$akid" ] || [ -z "$secret" ]; then
  echo "ERROR: could not parse access key from create-access-key output" >&2
  printf '%s' "$key_json" | jq 'del(.secret_access_key)' >&2 || true
  exit 1
fi

emit() { # name value
  if [ -n "${GITHUB_ENV:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >>"$GITHUB_ENV"
  else
    printf "export %s='%s'\n" "$1" "$2"
  fi
}
[ -n "${GITHUB_ENV:-}" ] && echo "::add-mask::$secret"
emit DYNAMODB_ENDPOINT "https://127.0.0.1:${EXTENDDB_PORT}"
emit NODE_EXTRA_CA_CERTS "$CERT"
emit AWS_ACCESS_KEY_ID "$akid"
emit AWS_SECRET_ACCESS_KEY "$secret"
emit AWS_REGION "us-east-1"

echo "==> ExtendDB ready at https://127.0.0.1:${EXTENDDB_PORT} (access key ${akid})" >&2
