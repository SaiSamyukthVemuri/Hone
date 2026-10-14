#!/usr/bin/env bash
# LOCAL-ONLY synthetic Fett twin (#825): build or serve the twin app, LOOPBACK-BOUND, against its isolated
# stack, from an EXPORTED copy of a pinned commit (so acceptance runs never rebuild the served .next).
#
#   scripts/fett-twin/app.sh export <commit> <app-dir>      git archive <commit> into <app-dir>, link node_modules
#   scripts/fett-twin/app.sh build  <app-dir> <supabase-workdir>
#   scripts/fett-twin/app.sh serve  <app-dir> <supabase-workdir>
#
# The server starts from an EMPTY environment (env -i): only the fake transports below and the local
# stack's own keys (read from `supabase status -o env`) are set. No PostHog, Sentry auth, deployment
# signal or real key. The serve step preloads egress-deny.cjs, which refuses EVERY non-loopback outbound
# connection and logs each refusal to $APP_DIR/../egress-refused.jsonl.
# Port: FETT_TWIN_APP_PORT (default 3995). The build fetches Google Fonts like every CI/e2e build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CMD="${1:?usage: app.sh export|build|serve ...}"
CLI="npx --yes supabase@2.102.0"
PORT="${FETT_TWIN_APP_PORT:-3995}"
# The fake processor's run id names its ledger (/tmp/hone-e2e-stripe-<id>.jsonl). Override it to start a
# fresh ledger; never delete an old one, it is the evidence a replay is checked against.
RUN_ID="${FETT_TWIN_RUN_ID:-fett-twin-demo}"
[[ "$RUN_ID" =~ ^[a-z0-9-]{1,48}$ ]] || { echo "REFUSED: FETT_TWIN_RUN_ID must be [a-z0-9-]{1,48}"; exit 2; }

if [ "$CMD" = "export" ]; then
  COMMIT="${2:?commit}"; APP="${3:?app-dir}"
  mkdir -p "$APP"
  git -C "$ROOT" archive "$COMMIT" | tar -x -C "$APP"
  ln -sfn "$ROOT/node_modules" "$APP/node_modules"
  git -C "$ROOT" rev-parse "$COMMIT" > "$APP/.fett-twin-commit"
  echo "exported $(cat "$APP/.fett-twin-commit") to $APP"; exit 0
fi

APP="${2:?app-dir}"; WD="${3:?supabase-workdir}"
CFG="$WD/supabase/config.toml"
PROJECT="$(sed -n 's/^project_id = "\(.*\)"$/\1/p' "$CFG" | head -1)"
API_PORT="$(awk '/^\[api\]/{f=1;next} /^\[/{f=0} f && /^port = /{print $3; exit}' "$CFG")"
[ "$PROJECT" != "Hone-0162" ] || { echo "REFUSED: shared fleet stack"; exit 4; }
ENVOUT="$(cd "$WD" && $CLI status --workdir . -o env 2>/dev/null)"
ANON="$(printf '%s\n' "$ENVOUT" | sed -n 's/^ANON_KEY="\(.*\)"$/\1/p')"
SERVICE="$(printf '%s\n' "$ENVOUT" | sed -n 's/^SERVICE_ROLE_KEY="\(.*\)"$/\1/p')"
[ -n "$ANON" ] && [ -n "$SERVICE" ] || { echo "REFUSED: could not read local keys from supabase status"; exit 4; }
NODEBIN="$(dirname "$(readlink -f "$(command -v node)")")"
ORIGIN="http://localhost:$PORT"
ENVV=(
  HOME="$HOME" PATH="$NODEBIN:/usr/bin:/bin" NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
  PORT="$PORT" NEXT_PUBLIC_APP_ORIGIN="$ORIGIN" PUBLIC_APP_URL="$ORIGIN"
  NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:$API_PORT" NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON" SUPABASE_SERVICE_ROLE_KEY="$SERVICE"
  HONE_E2E_FAKE_RESEND=1 HONE_E2E_FAKE_RESEND_DEFAULT_MODE=success
  HONE_E2E_FAKE_STRIPE=1 HONE_E2E_RUN_ID="$RUN_ID"
  HONE_SYNTHETIC_MACHINE_PROFILE=1
  RESEND_API_KEY=re_dummy_resend_key
  STRIPE_SECRET_KEY=sk_test_dummy NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_dummy STRIPE_WEBHOOK_SECRET=whsec_dummy STRIPE_ALLOW_LIVE_MODE=false
  TWILIO_ACCOUNT_SID=AC00000000000000000000000000000000 TWILIO_AUTH_TOKEN=dummy-twilio-token TWILIO_FROM_NUMBER=+15555550100
  CRON_SECRET=dummy-cron-secret APPOINTMENT_SIGNING_SECRET=dummy-appointment-signing-secret INTAKE_SIGNING_SECRET=dummy-intake-signing-secret
  PORTAL_FINGERPRINT_SALT=dummy-portal-fingerprint-salt-twin ADMIN_EMAILS=twin-operator@fett-twin.synth.local
)
case "$CMD" in
  build) cd "$APP" && env -i "${ENVV[@]}" ./node_modules/.bin/next build ;;
  serve)
    LOG="$(dirname "$APP")/egress-refused.jsonl"; : > "$LOG"
    OPTS="--require $ROOT/scripts/fett-twin/egress-deny.cjs"
    # The payment lane's own Stripe egress guard (#878), when the exported tree carries it. Loaded with
    # --import, not a second --require (Next merges repeated --require values into one broken path).
    # It writes an "armed" record per process and logs any refused *.stripe.com connection.
    STRIPE_GUARD="$APP/e2e-payment/helpers/stripe-egress-guard.cjs"
    STRIPE_LOG="$(dirname "$APP")/stripe-egress.jsonl"; : > "$STRIPE_LOG"
    [ -f "$STRIPE_GUARD" ] && OPTS="$OPTS --import file://$STRIPE_GUARD"
    cd "$APP" && env -i "${ENVV[@]}" FETT_TWIN_EGRESS_LOG="$LOG" HONE_E2E_STRIPE_EGRESS_LOG="$STRIPE_LOG" NODE_OPTIONS="$OPTS" \
      ./node_modules/.bin/next start -H 127.0.0.1 -p "$PORT" ;;
  *) echo "usage: app.sh export|build|serve"; exit 2 ;;
esac
