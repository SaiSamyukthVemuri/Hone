#!/usr/bin/env bash
# Staging safety guards (Correction D). Every push/deploy/migration command must
# run through these. Production ref/projectId are read LIVE from ~/Hone so nothing
# prod is hardcoded here; only the expected STAGING identifiers are baked (both are
# non-secret and overridable via env).
#
#   bash scripts/guard-staging.sh supabase   # D-1: gate before `supabase db push`
#   bash scripts/guard-staging.sh vercel     # D-2: gate before `vercel deploy`

EXPECTED_STAGING_REF="${EXPECTED_STAGING_REF:-ndcqadeirszuzmytvobk}"
EXPECTED_STAGING_VERCEL_PROJECT_ID="${EXPECTED_STAGING_VERCEL_PROJECT_ID:-}" # set once the staging Vercel project exists

mask() { local s="$1"; [ -n "$s" ] && printf '%s…%s' "${s:0:4}" "${s: -4}" || printf '(empty)'; }

guard_supabase() {
  local linked prod
  linked="$(cat supabase/.temp/project-ref 2>/dev/null || true)"
  prod="$(cat /Users/chloebaca/Hone/supabase/.temp/project-ref 2>/dev/null || true)"
  [ -n "$linked" ] || { echo "ABORT(D-1): clone not linked — run 'supabase link' first"; return 1; }
  [ "$linked" = "$EXPECTED_STAGING_REF" ] || { echo "ABORT(D-1): linked ref != staging (linked=$(mask "$linked"))"; return 1; }
  [ "$linked" != "$prod" ] || { echo "ABORT(D-1): linked ref == PROD"; return 1; }
  echo "GUARD D-1 PASS: supabase linked to staging $(mask "$linked"), distinct from prod $(mask "$prod")"
}

guard_vercel() {
  local sid pid
  sid="$(python3 -c 'import json; print(json.load(open(".vercel/project.json")).get("projectId", ""))' 2>/dev/null || true)"
  pid="$(python3 -c 'import json; print(json.load(open("/Users/chloebaca/Hone/.vercel/project.json")).get("projectId", ""))' 2>/dev/null || true)"
  [ -n "$EXPECTED_STAGING_VERCEL_PROJECT_ID" ] || { echo "ABORT(D-2): EXPECTED_STAGING_VERCEL_PROJECT_ID unset"; return 1; }
  [ -n "$sid" ] || { echo "ABORT(D-2): clone not linked to a Vercel project"; return 1; }
  [ "$sid" = "$EXPECTED_STAGING_VERCEL_PROJECT_ID" ] || { echo "ABORT(D-2): vercel projectId != staging"; return 1; }
  [ "$sid" != "$pid" ] || { echo "ABORT(D-2): vercel projectId == PROD"; return 1; }
  echo "GUARD D-2 PASS: vercel linked to staging project, distinct from prod"
}

case "${1:-}" in
  supabase) guard_supabase; exit $? ;;
  vercel)   guard_vercel;   exit $? ;;
  *) echo "usage: $0 {supabase|vercel}"; exit 2 ;;
esac
