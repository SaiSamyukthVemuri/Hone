#!/bin/bash
# Hone S0b PRE-RESTORE check (production, read-only, counts and names only): what could a restored copy of production start
# by itself? Extensions, cron jobs, the pg_net queue, database webhooks (supabase_functions.hooks), vault secrets, storage and
# auth user counts. Run it BEFORE the restore. Chain guard first: the migration history max must be 0212.
# An unreadable object (permission denied) is marked UNREADABLE and the rest continues; that is informational, never retried.
# Nothing is written to production. Credentials are typed privately and cleared on any exit.
set -u
umask 077

ROOT="$HOME/hone-s1"
BIN="$ROOT/supabase-cli/supabase-go"
S0B="$ROOT/s0b"
GO_SHA=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b
RUNNER_SHA=471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357
MANIFEST_SHA=d04063acb8dae3874c50ae1abf38680d5c755bb2a9359432a70debaf86a57b47
PROD_REF=alhhybgqdmcdyzpybykj

cleanup() { unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD; stty echo </dev/tty >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'echo "STOP: interrupted; credentials cleared" >&2; exit 130' INT TERM HUP
die() { echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "not macOS arm64"
command -v shasum >/dev/null 2>&1 || die "shasum not found"
command -v node >/dev/null 2>&1 || die "node not found"
nodev=$(node --version 2>/dev/null) || die "node --version failed"
nodemajor=${nodev#v}; nodemajor=${nodemajor%%.*}
case "$nodemajor" in ''|*[!0-9]*) die "cannot read the node version" ;; esac
[ "$nodemajor" -ge 18 ] || die "node $nodev is older than 18"
[ -f "$BIN" ] && [ "$(sha "$BIN")" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch (run the Mac check first)"
[ -f "$S0B/run-window-read-macos.sh" ] && [ "$(sha "$S0B/run-window-read-macos.sh")" = "$RUNNER_SHA" ] || die "runner missing or sha256 mismatch"
[ -f "$S0B/MANIFEST.sha256" ] && [ "$(sha "$S0B/MANIFEST.sha256")" = "$MANIFEST_SHA" ] || die "manifest missing or sha256 mismatch"
oks=$(cd "$S0B" && shasum -a 256 -c MANIFEST.sha256) || die "a pinned file does not match MANIFEST.sha256"
[ "$(printf '%s\n' "$oks" | grep -c ': OK$')" = 13 ] || die "MANIFEST.sha256 did not verify exactly 13 pinned files"
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
[ -r /dev/tty ] || die "no terminal for private entry"

WORK=$(mktemp -d "$ROOT/s0b-precheck.XXXXXX") || die "mktemp failed"
chmod 700 "$WORK" || die "chmod failed"
LINK="$WORK/linked"; RES="$WORK/results"; LOGS="$WORK/logs"
mkdir -p "$LINK/supabase/.temp" "$RES" "$LOGS" || die "mkdir failed"
POOLER_URL="postgresql://postgres.$PROD_REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres"
printf '%s\n' "$PROD_REF" > "$LINK/supabase/.temp/project-ref" || die "write project-ref failed"
printf '%s' "$POOLER_URL" > "$LINK/supabase/.temp/pooler-url" || die "write pooler-url failed"   # no trailing newline (incident 2026-10-25)
[ "$(wc -c < "$LINK/supabase/.temp/pooler-url" | tr -d ' ')" = "${#POOLER_URL}" ] || die "pooler-url is not byte-exact"
printf '%s\n' v2.102.0 > "$LINK/supabase/.temp/cli-latest" || die "write cli-latest failed"

IFS= read -rs -p "Supabase access token (not shown): " SUPABASE_ACCESS_TOKEN </dev/tty || die "could not read the access token"; echo >&2
[ -n "$SUPABASE_ACCESS_TOKEN" ] || die "empty access token"
IFS= read -rs -p "PRODUCTION database password (not shown): " SUPABASE_DB_PASSWORD </dev/tty || die "could not read the password"; echo >&2
[ -n "$SUPABASE_DB_PASSWORD" ] || die "empty password"

run1() { # run1 FILE : 0 ok, 1 refused or failed (log kept)
  local f=$1 stem rc=0; stem=${f%.sql}
  ( export SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD; cd "$LINK" && env HONE_WINDOW_PROJECT_REF="$PROD_REF" HONE_SUPABASE_BIN="$BIN" HONE_WINDOW_RESULT_DIR="$RES" \
      SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 /bin/bash "$S0B/run-window-read-macos.sh" "$f" ) </dev/null 2>"$LOGS/$stem.err" || rc=$?
  if grep -qiE 'login role|unban|network.?ban|reset.*password' "$LOGS/$stem.err"; then die "$f: the CLI reported a login-role / ban / password path; stopped and REPORT it"; fi
  [ "$rc" = 0 ] && [ -f "$RES/$stem.json" ] && [ -f "$RES/$stem.meta.json" ]
}

# chain guard: the history must still be 211 / 0212
run1 v1-history.sql || { tail -n 5 "$LOGS/v1-history.err" >&2; die "the history read failed; nothing else was run"; }
c=$(LC_ALL=C tr -d '[:space:]' < "$RES/v1-history.json")
printf '%s' "$c" | grep -q '"hosted_max":"0212"' || die "production history max is not 0212 (chain guard); stopped"
echo "chain guard ok: migration history max 0212" >&2

run1 p0-presence.sql || { tail -n 5 "$LOGS/p0-presence.err" >&2; die "the presence read failed; nothing else was run"; }
want=$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[0];
const m = [["has_cron_job","p1-cron.sql"],["has_net_http_request_queue","p2-net.sql"],["has_supabase_functions_hooks","p3-hooks.sql"],["has_vault_secrets","p4-vault.sql"],["has_storage_objects","p5-storage.sql"],["has_auth_users","p6-auth-users.sql"]];
console.log(m.filter(([k]) => r[k] === true || r[k] === "t" || r[k] === "true").map(([,f]) => f).join(" "));' "$RES/p0-presence.json") || die "could not read the presence result"
echo "objects present -> files to read: ${want:-none}" >&2
: > "$WORK/unreadable.txt"
for f in $want; do
  run1 "$f" || { echo "UNREADABLE $f" | tee -a "$WORK/unreadable.txt" >&2; tail -n 2 "$LOGS/${f%.sql}.err" >&2; }
done
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD

cat > "$WORK/summary.mjs" <<'NODE'
import { readFileSync, existsSync } from "node:fs";
const dir = process.argv[2];
const unreadable = new Set(readFileSync(process.argv[3], "utf8").split("\n").filter(Boolean).map((l) => l.replace(/^UNREADABLE /, "").replace(/\.sql$/, "")));
const get = (n) => (!unreadable.has(n) && existsSync(`${dir}/${n}.json`) ? JSON.parse(readFileSync(`${dir}/${n}.json`, "utf8")) : null);
const p = get("p0-presence")[0];
const yes = (v) => v === true || v === "t" || v === "true";
let alerts = 0; const alert = (m) => { alerts++; console.log(`ALERT  ${m}`); };
console.log(`extensions: ${p.extensions}`);
console.log(`pg_net ${yes(p.ext_pg_net) ? "installed" : "absent"}; http ${yes(p.ext_http) ? "installed" : "absent"}; pg_cron ${yes(p.ext_pg_cron) ? "installed" : "absent"}`);
const sect = (name, present, file, fn) => {
  if (!yes(present)) return console.log(`${name}: not present`);
  const r = get(file);
  if (!r) return console.log(`${name}: UNREADABLE (informational; read it by hand with an owner role if it matters)`);
  fn(r);
};
sect("cron.job", p.has_cron_job, "p1-cron", ([c]) => {
  console.log(`cron.job: ${c.jobs} jobs, ${c.active_jobs} active, ${c.jobs_mentioning_http_net_functions} mention http/net/functions (${c.active_jobs_mentioning_http_net_functions} active)`);
  if (Number(c.active_jobs_mentioning_http_net_functions) > 0) alert(`${c.active_jobs_mentioning_http_net_functions} active cron job(s) mention http/net/functions: a restored copy could call out on its own`);
  else if (Number(c.active_jobs) > 0) alert(`${c.active_jobs} active cron job(s): a restored copy would run them`);
});
sect("net queue", p.has_net_http_request_queue, "p2-net", ([n]) => {
  console.log(`net.http_request_queue: ${n.queued_requests} queued, net._http_response: ${n.stored_responses} stored`);
  if (Number(n.queued_requests) > 0) alert(`${n.queued_requests} queued pg_net request(s): a restored copy could send them`);
});
sect("supabase_functions.hooks", p.has_supabase_functions_hooks, "p3-hooks", ([h]) => {
  console.log(`supabase_functions.hooks: ${h.hooks}`);
  if (Number(h.hooks) > 0) alert(`${h.hooks} database webhook record(s): a restored copy could fire webhooks`);
});
sect("vault.secrets", p.has_vault_secrets, "p4-vault", ([v]) => {
  console.log(`vault.secrets: ${v.secrets} (count only)`);
  if (Number(v.secrets) > 0) alert(`${v.secrets} vault secret(s) are in the database and would be in the restored copy`);
});
sect("storage.objects", p.has_storage_objects, "p5-storage", (rows) => {
  for (const r of rows) console.log(`storage ${r.bucket_id}: ${r.objects} objects, ${r.bytes} bytes`);
  console.log("(the files themselves are NOT in a database restore; only this metadata is)");
});
sect("auth.users", p.has_auth_users, "p6-auth-users", ([u]) => console.log(`auth.users: ${u.users}`));
console.log(`S0B PRECHECK DONE: ${alerts} alert(s). Informational: it does not block the restore; each alert is something to decide BEFORE the restore.`);
NODE
node "$WORK/summary.mjs" "$RES" "$WORK/unreadable.txt" </dev/null || die "could not summarise the results"
[ ! -s "$WORK/unreadable.txt" ] || echo "Some objects were UNREADABLE (listed above). Results: $RES" >&2
echo "Results and logs are in $WORK" >&2
