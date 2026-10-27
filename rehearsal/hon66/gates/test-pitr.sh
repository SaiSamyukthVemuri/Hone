#!/bin/bash
# REHEARSAL - NEVER MERGE. HON66: Linux tests for pitr-backups-linux.sh (stub supabase-go, real script) with the PAT on fd 3.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/pl.XXXXXX")"; T="$(cd "$T" && pwd -P)"
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
has() { grep -qF -- "$2" "$1"; }
sha() { sha256sum -- "$1" | cut -d' ' -f1; }
TOKEN=TOKEN-SECRET-9f3a1b; PASSWORD=PW-SECRET-77c2de
PITR="$HERE/pitr-backups-linux.sh";
REF=alhhybgqdmcdyzpybykj
bash -n "$PITR" && ok "bash -n (pitr script)" || bad "syntax"
[ "$(grep -E '^GO_SHA=' "$PITR" | cut -d= -f2)" = 174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c ] && ok "pitr script pins the linux_amd64 2.102.0 binary" || bad "pitr GO_SHA"

mkfix() { # mkfix NAME : a private HOME with a stub supabase-go whose sha is written into a test copy of the script
  F="$T/$1"; H="$F/home"; ROOT="$H/hone-s1"; mkdir -p "$ROOT/supabase-cli" "$F/cred"; chmod 700 "$ROOT" "$F/cred"
  CALLS="$F/calls.log"; : > "$CALLS"
  cat > "$ROOT/supabase-cli/supabase-go" <<STUB
#!/bin/sh
echo "ARGS: \$*" >> "$CALLS"
[ "\${SUPABASE_ACCESS_TOKEN-}" = "$TOKEN" ] && echo "TOKEN-OK" >> "$CALLS" || echo "TOKEN-WRONG" >> "$CALLS"
env | grep -E '^(PG|SUPABASE_DB|GITHUB_TOKEN|GH_TOKEN)' >> "$CALLS"
now=\$(date +%s)
printf '{"backups":[],"physical_backup_data":{"earliest_physical_backup_date_unix":%s,"latest_physical_backup_date_unix":%s},"pitr_enabled":true,"region":"x","walg_enabled":true}' \$((now-6*86400)) \$((now-300))
STUB
  chmod 755 "$ROOT/supabase-cli/supabase-go"
  GOSHA=$(sha "$ROOT/supabase-cli/supabase-go")
  sed "s/^GO_SHA=174a.*/GO_SHA=$GOSHA/" "$PITR" > "$F/pitr-backups.sh"; chmod 755 "$F/pitr-backups.sh"
  printf '%s\n' "$TOKEN" > "$F/cred/token"; printf '%s\n' "$PASSWORD" > "$F/cred/pw"; chmod 600 "$F/cred/token" "$F/cred/pw"
  RUNS="$F/pitr-backups.sh"
}
envclean() { env -i PATH=/usr/bin:/bin:$(dirname "$(command -v node)") HOME="$H" TERM=dumb "$@"; }
pitr() { RC=0; envclean "${@}" /bin/bash "$RUNS" 3< "$F/cred/token" > "$F/out.txt" 2>&1 || RC=$?; OUT="$F/out.txt"; }
stop() { if [ "$RC" != 0 ] && has "$OUT" "$2" && [ "$(grep -c '^ARGS' "$CALLS")" = "$3" ]; then ok "$1 (exit $RC, $3 call(s))"; else bad "$1" "rc=$RC calls=$(grep -c '^ARGS' "$CALLS")"; tail -4 "$OUT"; fi; }

mkfix happy; pitr
[ "$RC" = 0 ] && has "$OUT" "pitr_enabled: true" && [ "$(grep -c '^ARGS' "$CALLS")" = 1 ] && has "$CALLS" "ARGS: --agent no backups list --project-ref $REF -o json" && ok "happy: exactly one call, exactly 'backups list --project-ref <const> -o json'" || bad "happy" "rc=$RC"
has "$CALLS" TOKEN-OK && ok "the token reached the one child through SUPABASE_ACCESS_TOKEN" || bad "token not delivered"
! grep -E '^(PG|SUPABASE_DB|GITHUB_TOKEN|GH_TOKEN)' "$CALLS" | grep -q . && ok "no database password, PG* or GitHub variable in the child's environment" || bad "child environment"
grep -rqF -e "$TOKEN" -e "$PASSWORD" "$OUT" "$ROOT"/pitr-backups.* 2>/dev/null && bad "a secret appears in output or on disk" || ok "neither the token nor the password appears in the output or on disk"
M=$(ls "$ROOT"/pitr-backups.*/backups.meta.json); has "$M" "\"script_sha256\":\"$(sha "$RUNS")\"" && has "$M" "\"supabase_go_sha256\":\"$GOSHA\"" && ok "the sidecar binds the script and binary shas" || bad "sidecar"

# refusals, all before the one call
mkfix rclosed; RC=0; envclean /bin/bash "$RUNS" 3<&- > "$F/out.txt" 2>&1 || RC=$?; OUT="$F/out.txt"; stop "fd 3 not open is refused" "fd 3 is not open" 0
mkfix rempty; : > "$F/cred/token"; pitr; stop "an empty fd 3 is refused" "could not read the access token from fd 3" 0
mkfix rmulti; printf 'a\nb\n' > "$F/cred/token"; pitr; stop "a two-line fd 3 is refused" "more than one line or more than 4096 bytes" 0
mkfix rbig; head -c 5000 /dev/zero | tr '\0' x > "$F/cred/token"; echo >> "$F/cred/token"; pitr; stop "an oversize (>4096) token is refused" "more than one line or more than 4096 bytes" 0
mkfix rclose; pitr; [ -z "$(ls "$ROOT"/pitr-backups.*/ 2>/dev/null | grep -F token)" ] && ok "the token is never written under the private folder" || bad "token file found"
mkfix rpw; pitr SUPABASE_DB_PASSWORD="$PASSWORD"; stop "a database password (any SUPABASE_* variable) in the environment is refused (names only)" "unset these variables first" 0
! has "$OUT" "$PASSWORD" && ok "  ... the refusal names the variable, never the value" || bad "  ... value leaked"
mkfix rarg; RC=0; envclean /bin/bash "$RUNS" restore > "$F/out.txt" 3< "$F/cred/token" 2>&1 || RC=$?; OUT="$F/out.txt"; stop "an argument (e.g. 'restore') is refused" "takes no arguments" 0
mkfix rbin; printf '\n#x\n' >> "$ROOT/supabase-cli/supabase-go"; pitr; stop "a modified supabase-go is refused" "sha256 mismatch" 0

echo; echo "passed: $pass failed: $fail"
[ "$fail" = 0 ]
