#!/bin/bash
# LINUX VARIANT of the reviewed Mac script (HON66-LINUX-GATES), derived by machines/linux-gates/make-linux.py with a fixed substitution
# list (see LINUX-DIFFS.txt). Credentials are read from files named by the launcher, never prompted, never on argv.
# Hone PITR STATUS (1 of 2): read the project's backup and PITR status from the Management API through the pinned supabase-go
# 174a90e2. It runs exactly ONE command:  supabase-go --agent no backups list --project-ref <constant ref> -o json
# and nothing else: no `backups restore`, no `db`, no `--linked`, no database connection.
#
# Why that command is read-only and needs no database password (supabase/cli v2.102.0, read at the tag):
#   cmd/backups.go            backups list -> list.Run(ctx); the command has NO db-url / local / linked / proxy flag.
#   cmd/root.go               PersistentPreRunE calls flags.ParseDatabaseConfig for every command, but
#   flags/db_url.go           ParseDatabaseConfig only acts when one of those four flags is set; for `backups list` none exists,
#                             so it does nothing: no login role (initLoginRole), no pooler login, no UnbanIP, no DB connection.
#                             The same PreRun also runs promptLogin (needs SUPABASE_ACCESS_TOKEN) and ParseProjectRef, which
#                             with --project-ref only validates the ref text.
#   backups/list/list.go     one call, V1ListAllBackups (an HTTPS GET to the Management API), then prints.
# The Management API is reached with the access token only. The database password is NOT needed and is refused if present.
# Afterwards the CLI may check for a newer release unless supabase/.temp/cli-latest is fresh: this script seeds it (v2.102.0).
# Found in the rehearsal with the REAL binary: after the command, root.go's ensureProjectGroupsCached makes ONE extra read-only
# GET /v1/projects/<ref> (to cache the project name for telemetry) unless supabase/.temp/linked-project.json already exists. This script
# seeds that file (the ref only; empty name and organization) in its private folder, so the only request is the backups GET.
#
# Read-only. Fail-closed: the first failure stops. No retries. The token is read from a mode-600 file named by the launcher (never printed, never on a command
# line, never written), exported only to the one child, and cleared on any exit.
set -u
umask 077

ROOT="$HOME/hone-s1"
BIN="$ROOT/supabase-cli/supabase-go"
GO_SHA=174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c
REF=alhhybgqdmcdyzpybykj
SELF="${BASH_SOURCE[0]}"

tok=""
# Credentials come from FILES named by the launcher (hone-gate-launch.sh), never from a prompt, never from argv.
# secret_from_file VAR ENVNAME LABEL: the file must be absolute, a regular file (no symlink), one hard link, owned by you, mode 600,
# in a directory that is not group/other-writable, one line, non-empty. The value is read into VAR only; nothing is printed.
secret_from_file() {
  local _v _p _envn="$2" _label="$3" _dir
  _p="${!_envn:-}"
  [ -n "$_p" ] || die "$_envn is not set (the launcher passes the path of the $_label file)"
  case "$_p" in /*) ;; *) die "$_envn must be an absolute path" ;; esac
  [ -f "$_p" ] && [ ! -L "$_p" ] || die "the $_label file is missing, not a regular file, or a symlink"
  [ "$(stat -c '%u %a %h' "$_p" 2>/dev/null)" = "$(id -u) 600 1" ] || die "the $_label file must be owned by you, mode 600, one hard link"
  _dir=$(dirname "$_p"); [ -z "$(find "$_dir" -maxdepth 0 \( -perm -020 -o -perm -002 \) 2>/dev/null)" ] || die "the directory of the $_label file is writable by group or others"
  [ "$(grep -c '' "$_p")" -le 1 ] || die "the $_label file must hold exactly one line"
  _v=""; IFS= read -r _v < "$_p" || [ -n "$_v" ] || die "could not read the $_label file"
  [ -n "$_v" ] || die "the $_label file is empty"
  printf -v "$1" '%s' "$_v"
  unset "$_envn"
}

cleanup() { tok=""; unset SUPABASE_ACCESS_TOKEN; stty echo </dev/tty >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'echo "STOP: interrupted; the token was cleared." >&2; exit 130' INT TERM HUP
die() { echo "STOP: $*" >&2; exit 1; }
sha() { sha256sum -- "$1" | cut -d' ' -f1; }
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }
mask() { LC_ALL=C sed -E -e 's#postgres(ql)?://[^ ]*#<url>#g' -e 's#sbp_[A-Za-z0-9_]+#<token>#g' -e 's#(Bearer|bearer) +[^ ]+#\1 <token>#g'; }

# ---- this Mac, the verified tool, a clean environment (NAMES only) ----------------------------------------------------------
[ $# -eq 0 ] || die "this script takes no arguments: it runs only 'backups list' (it will not run 'restore' or anything else)"
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "not Linux x86_64 (the pinned supabase-go is linux_amd64)"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum not found"
command -v node >/dev/null 2>&1 || die "node not found (Node 18 or newer is used to read the JSON)"
nodev=$(node --version 2>/dev/null) || die "node --version failed"
nodemajor=${nodev#v}; nodemajor=${nodemajor%%.*}
case "$nodemajor" in ''|*[!0-9]*) die "cannot read the node version" ;; esac
[ "$nodemajor" -ge 18 ] || die "node $nodev is older than 18"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die "$ROOT is missing or a symlink"
[ -f "$BIN" ] && [ "$(sha "$BIN")" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch (run the installer check first)"
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
OUT=$(mktemp -d "$ROOT/pitr-backups.XXXXXX") || die "mktemp failed"
chmod 700 "$OUT" || die "chmod failed"
LINK="$OUT/cwd"
mkdir -p "$LINK/supabase/.temp" && chmod 700 "$LINK" || die "mkdir failed"
printf '%s\n' v2.102.0 > "$LINK/supabase/.temp/cli-latest" || die "write cli-latest failed"
printf '{"ref":"%s","name":"","organization_id":"","organization_slug":""}\n' "$REF" > "$LINK/supabase/.temp/linked-project.json" || die "write linked-project.json failed"

secret_from_file tok HONE_GATE_TOKEN_FILE "access token"
[ -n "$tok" ] || die "empty access token"

# ---- the one command ------------------------------------------------------------------------------------------------------------
T0=$(utcnow)
rc=0
( cd "$LINK" && SUPABASE_ACCESS_TOKEN="$tok" env -u GITHUB_TOKEN -u GH_TOKEN SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
    "$BIN" --agent no backups list --project-ref "$REF" -o json ) </dev/null >"$OUT/backups.json" 2>"$OUT/backups.err" || rc=$?
tok=""; unset SUPABASE_ACCESS_TOKEN
T1=$(utcnow)
mask < "$OUT/backups.err" > "$OUT/backups.err.m" && mv "$OUT/backups.err.m" "$OUT/backups.err"
if [ "$rc" != 0 ]; then tail -n 5 "$OUT/backups.err" >&2; die "backups list failed (exit $rc). Nothing else was run. Do not retry here; report this."; fi
grep -qiE 'login role|unban' "$OUT/backups.err" && die "the CLI mentioned a login role or an unban: REPORT it (log: $OUT/backups.err). Nothing else was run."
c=$(LC_ALL=C tr -d '[:space:]' < "$OUT/backups.json")
case "$c" in "{"*"}") ;; *) die "the result is not a JSON object (file: $OUT/backups.json)" ;; esac
RS=$(sha "$OUT/backups.json")
printf '{"command":"backups list","started_at_utc":"%s","captured_at_utc":"%s","exit_code":0,"result_sha256":"%s","supabase_go_sha256":"%s","script_sha256":"%s"}\n' \
  "$T0" "$T1" "$RS" "$GO_SHA" "$(sha "$SELF")" > "$OUT/backups.meta.json" || die "could not write the sidecar"

# ---- print only the named fields ---------------------------------------------------------------------------------------------------
node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const now = Date.now();
const utc = (s) => (typeof s === "number" && isFinite(s)) ? new Date(s * 1000).toISOString().replace(".000Z", "Z") : "not reported";
const age = (ms) => { const m = Math.round((now - ms) / 60000); return m < 0 ? "in the future" : (Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0") + "m ago"); };
const pbd = j.physical_backup_data || {};
console.log("pitr_enabled: " + j.pitr_enabled);
console.log("walg_enabled: " + j.walg_enabled);
const e = pbd.earliest_physical_backup_date_unix, l = pbd.latest_physical_backup_date_unix;
console.log("physical_backup_data.earliest_physical_backup_date_unix: " + (e === undefined ? "not reported" : e + "  = " + utc(e) + " UTC"));
console.log("physical_backup_data.latest_physical_backup_date_unix:   " + (l === undefined ? "not reported" : l + "  = " + utc(l) + " UTC" + (typeof l === "number" ? "  (" + age(l * 1000) + ")" : "")));
const bs = Array.isArray(j.backups) ? j.backups.slice() : [];
bs.sort((a, b) => String(b.inserted_at).localeCompare(String(a.inserted_at)));
console.log("backups: " + bs.length);
for (const b of bs) console.log("  status=" + b.status + "  inserted_at=" + b.inserted_at + "  is_physical_backup=" + b.is_physical_backup);
const done = bs.filter((b) => b.status === "COMPLETED" && b.is_physical_backup === true);
if (done.length) { const t = Date.parse(done[0].inserted_at); console.log("latest COMPLETED physical backup: inserted_at=" + done[0].inserted_at + (isNaN(t) ? "" : "  (" + age(t) + ")")); }
else console.log("latest COMPLETED physical backup: none in the list");
' "$OUT/backups.json" || die "could not read the result (file: $OUT/backups.json)"
echo "saved (private, mode 0700): $OUT/backups.json and $OUT/backups.meta.json"
echo "PITR BACKUPS READ COMPLETE at $T1 (UTC): one 'backups list' call; no database connection; nothing was written to the project."
