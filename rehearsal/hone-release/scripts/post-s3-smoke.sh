#!/usr/bin/env bash
# POST-S3 credential-free smoke. GET ONLY. No secrets, no cookies, no customer
# data, no writes, no provider contact. Every request is a plain GET with no
# body, to a fixed allow-listed route on one base URL, using synthetic ids
# (all-zero UUIDs) where a path needs one.
#
# Usage:  post-s3-smoke.sh [--base https://hone.care] [--book-slug SLUG]
#   --book-slug  OPTIONAL. The sanctioned synthetic studio's public slug, given
#                by OPS once the P0 fixture binding exists. Adds one GET of
#                /book/SLUG. Never guess a slug; never pass a real studio's.
#
# Output: one JSON object on stdout. Exit 0 = every check passed, 1 = any
# failed, 2 = usage.
#
# WHAT THIS CAN AND CANNOT PROVE. Unauthenticated routes only. It proves the
# deployment serves, the auth redirects hold, the machine endpoints refuse
# unauthenticated callers, and no public page 5xx's. It cannot see any database
# behaviour: the 0213-0246 migrations change nothing an anonymous GET reaches
# except /book/SLUG (public booking reads). A pass here is a necessary floor,
# never evidence that a migration applied or a finding closed.
#
# Deliberately NOT requested: token pages (/intake/T, /cancel/T, /manage/T,
# /reschedule/T, /invitation/T). They pass through limitTokenRoute, a rate-limit
# counter write; this script makes no writes of any kind.
set -u
BASE="https://hone.care"
SLUG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --book-slug) SLUG="${2:-}"; shift 2 ;;
    *) echo "usage: $0 [--base URL] [--book-slug SLUG]" >&2; exit 2 ;;
  esac
done
case "$BASE" in
  https://hone.care|http://localhost:*|http://127.0.0.1:*) ;;
  *) echo "refusing base $BASE (allow-list: https://hone.care, localhost)" >&2; exit 2 ;;
esac
if [ -n "$SLUG" ] && ! printf '%s' "$SLUG" | grep -Eq '^[a-z0-9][a-z0-9-]{0,62}$'; then
  echo "invalid slug" >&2; exit 2
fi

Z="00000000-0000-0000-0000-000000000000"
HDR=$(mktemp); trap 'rm -f "$HDR"' EXIT
FAIL=0; N=0; OUT=""

# check ROUTE EXPECTED_STATUS EXPECTED_LOCATION_PATH_OR_EMPTY CLASS
check() {
  local route="$1" want="$2" wantloc="$3" cls="$4" code loc ok=true
  code=$(curl -sS -X GET -o /dev/null -D "$HDR" --max-time 20 \
    -A "hone-post-s3-smoke/1" -w '%{http_code}' "$BASE$route" 2>/dev/null) || code=000
  loc=$(grep -i '^location:' "$HDR" | head -1 | tr -d '\r' | sed -E 's/^[Ll]ocation: *//; s#^https?://[^/]+##')
  [ "$code" = "$want" ] || ok=false
  [ -z "$wantloc" ] || [ "$loc" = "$wantloc" ] || ok=false
  [ "$ok" = true ] || FAIL=$((FAIL+1))
  N=$((N+1))
  OUT="$OUT${OUT:+,}{\"route\":\"$route\",\"class\":\"$cls\",\"expect\":$want,\"status\":$code,\"location\":\"$loc\",\"ok\":$ok}"
}

# header_check ROUTE HEADER_NAME
header_check() {
  local route="$1" name="$2" ok=true
  curl -sS -X GET -o /dev/null -D "$HDR" --max-time 20 -A "hone-post-s3-smoke/1" "$BASE$route" 2>/dev/null
  grep -qi "^$name:" "$HDR" || ok=false
  [ "$ok" = true ] || FAIL=$((FAIL+1))
  N=$((N+1))
  OUT="$OUT${OUT:+,}{\"route\":\"$route\",\"class\":\"header:$name\",\"expect\":\"present\",\"ok\":$ok}"
}

# 1. Public pages serve.
for r in / /login /demo /pricing /privacy /terms /robots.txt /sitemap.xml \
         /features/treatment-memory /features/booking-calendar /portal/login; do
  check "$r" 200 "" public
done

# 2. Signed-in surfaces redirect an anonymous caller to /login. The routes are
#    the ones the 0213-0246 app diff touches (payments, export, intake, calendar).
for r in /dashboard /clients /calendar /settings/payments /settings/data \
         /settings/booking /settings/team /admin /admin/ops-alerts \
         "/clients/$Z/intake" "/clients/$Z/intake/assist"; do
  check "$r" 307 "/login" auth-redirect
done

# 3. Machine endpoints refuse an anonymous caller before doing any work.
check /api/stripe/webhook 405 "" webhook-method
check /api/twilio/inbound-sms 405 "" webhook-method
check /api/twilio/message-status 405 "" webhook-method
for r in no-show-check appointment-reminders calendar-sync calendar-reconcile materialize-recurring-breaks; do
  check "/api/cron/$r" 401 "" cron-auth
done
check /api/google-calendar/e2e/authorize 307 "/login" e2e-route-closed
check "/api/clients/$Z/images/$Z/signed-url" 307 "/login" auth-redirect

# 4. A studio that does not exist is a clean 404, not a 5xx (public booking
#    reads reach the database; a schema/app skew shows here as 500).
check /book/zz-no-such-studio-0000 404 "" public-not-found

# 5. Security headers survive the deploy.
for h in content-security-policy strict-transport-security x-content-type-options x-frame-options referrer-policy permissions-policy; do
  header_check /login "$h"
done

# 6. OPTIONAL: the sanctioned synthetic studio's public booking page.
[ -z "$SLUG" ] || check "/book/$SLUG" 200 "" synthetic-studio-public-booking

printf '{"base":"%s","at":"%s","checks":[%s],"total":%d,"failed":%d,"scope":"Unauthenticated read-only GET; no writes, no token pages, no provider flow, no customer data."}\n' \
  "$BASE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$OUT" "$N" "$FAIL"
[ "$FAIL" -eq 0 ]
