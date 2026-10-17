#!/usr/bin/env bash
# Run `supabase start …` and retry it ONCE, only for a host-port bind collision.
#
# Usage: bash scripts/ci/supabase-start-bind-retry.sh supabase start [args…]
#
# Why: on a fresh GitHub runner, `supabase start` occasionally dies before any
# test runs with
#   failed to bind host port for 0.0.0.0:54324:…: address already in use
# (run 38490241652, job 115613879102: inbucket on 54324; the same class has hit
# 54322, Postgres, in browser and DB jobs). A rerun of only that job, at the
# unchanged head, has gone green every time. It is runner infrastructure, not
# the diff.
#
# Bounds, deliberately narrow:
#   - wraps ONLY the stack start. No test step is ever retried;
#   - retries ONLY when the output carries the exact bind signature on a local
#     Supabase port (5432x); every other failure exits with its own code;
#   - at most ONE retry, announced as a workflow warning so it is never silent.
set -uo pipefail

if [ "$#" -lt 2 ] || [ "$1" != "supabase" ] || [ "$2" != "start" ]; then
  echo "usage: $0 supabase start [args…]" >&2
  exit 2
fi

SIGNATURE='failed to bind host port for [0-9.]+:543[0-9]{2}:[^ ]*: address already in use'
log="$(mktemp)"

"$@" 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}
if [ "$rc" -eq 0 ]; then
  exit 0
fi

if ! grep -Eq "$SIGNATURE" "$log"; then
  exit "$rc"
fi

port="$(grep -Eo 'host port for [0-9.]+:543[0-9]{2}' "$log" | head -n1 | grep -Eo '543[0-9]{2}$')"
echo "::warning title=Supabase port-bind collision (retrying once)::'supabase start' exited ${rc}: host port ${port} already in use. Stopping the partial stack and retrying the START step once. Tests are not retried."

echo "--- holder of port ${port} before cleanup (diagnostic) ---"
sudo -n ss -ltnp "sport = :${port}" 2>/dev/null || ss -ltn "sport = :${port}" || true
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' || true

supabase stop --no-backup || true
sleep "${SUPABASE_BIND_RETRY_DELAY_SECONDS:-10}"

echo "--- holder of port ${port} after cleanup (diagnostic) ---"
sudo -n ss -ltnp "sport = :${port}" 2>/dev/null || ss -ltn "sport = :${port}" || true

"$@"
rc=$?
if [ "$rc" -eq 0 ]; then
  echo "::warning title=Supabase port-bind collision (recovered)::The single retry of 'supabase start' succeeded after a port ${port} bind collision."
fi
exit "$rc"
