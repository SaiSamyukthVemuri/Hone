#!/bin/bash
# REHEARSAL - NEVER MERGE. HON66: Linux tests for pitr-backups-linux.sh (stub supabase-go, real script) and the credential launcher
# (hone-gate-launch.sh: per-gate credential table, clean environment, no value ever on argv or in the environment).
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
PITR="$HERE/pitr-backups-linux.sh"; LAUNCH="$HERE/hone-gate-launch.sh"
REF=alhhybgqdmcdyzpybykj
bash -n "$PITR" && bash -n "$LAUNCH" && ok "bash -n (pitr script, launcher)" || bad "syntax"
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
pitr() { RC=0; envclean HONE_GATE_TOKEN_FILE="$F/cred/token" "${@}" /bin/bash "$RUNS" > "$F/out.txt" 2>&1 || RC=$?; OUT="$F/out.txt"; }
stop() { if [ "$RC" != 0 ] && has "$OUT" "$2" && [ "$(grep -c '^ARGS' "$CALLS")" = "$3" ]; then ok "$1 (exit $RC, $3 call(s))"; else bad "$1" "rc=$RC calls=$(grep -c '^ARGS' "$CALLS")"; tail -4 "$OUT"; fi; }

mkfix happy; pitr
[ "$RC" = 0 ] && has "$OUT" "pitr_enabled: true" && [ "$(grep -c '^ARGS' "$CALLS")" = 1 ] && has "$CALLS" "ARGS: --agent no backups list --project-ref $REF -o json" && ok "happy: exactly one call, exactly 'backups list --project-ref <const> -o json'" || bad "happy" "rc=$RC"
has "$CALLS" TOKEN-OK && ok "the token reached the one child through SUPABASE_ACCESS_TOKEN" || bad "token not delivered"
! grep -E '^(PG|SUPABASE_DB|GITHUB_TOKEN|GH_TOKEN)' "$CALLS" | grep -q . && ok "no database password, PG* or GitHub variable in the child's environment" || bad "child environment"
grep -rqF -e "$TOKEN" -e "$PASSWORD" "$OUT" "$ROOT"/pitr-backups.* 2>/dev/null && bad "a secret appears in output or on disk" || ok "neither the token nor the password appears in the output or on disk"
M=$(ls "$ROOT"/pitr-backups.*/backups.meta.json); has "$M" "\"script_sha256\":\"$(sha "$RUNS")\"" && has "$M" "\"supabase_go_sha256\":\"$GOSHA\"" && ok "the sidecar binds the script and binary shas" || bad "sidecar"

# refusals, all before the one call
mkfix r644; chmod 644 "$F/cred/token"; pitr; stop "a token file with mode 644 is refused" "mode 600" 0
mkfix rsym; mv "$F/cred/token" "$F/cred/token.real"; ln -s "$F/cred/token.real" "$F/cred/token"; pitr; stop "a symlinked token file is refused" "symlink" 0
mkfix rhard; ln "$F/cred/token" "$F/cred/token.hard"; pitr; stop "a hard-linked token file is refused" "mode 600" 0
mkfix rempty; : > "$F/cred/token"; pitr; stop "an empty token file is refused" "could not read the access token file" 0
mkfix rmulti; printf 'a\nb\n' > "$F/cred/token"; pitr; stop "a two-line token file is refused" "exactly one line" 0
mkfix rgw; chmod 770 "$F/cred"; pitr; stop "a group-writable credential directory is refused" "writable by group or others" 0
mkfix rrel; RC=0; envclean HONE_GATE_TOKEN_FILE="cred/token" /bin/bash "$RUNS" > "$F/out.txt" 2>&1 || RC=$?; OUT="$F/out.txt"; stop "a relative token path is refused" "absolute path" 0
mkfix rnoenv; RC=0; envclean /bin/bash "$RUNS" > "$F/out.txt" 2>&1 || RC=$?; OUT="$F/out.txt"; stop "no token file named: refused" "is not set" 0
mkfix rpw; pitr SUPABASE_DB_PASSWORD="$PASSWORD"; stop "a database password in the environment is refused (names only)" "unset these variables first" 0
! has "$OUT" "$PASSWORD" && ok "  ... the refusal names the variable, never the value" || bad "  ... value leaked"
mkfix rarg; RC=0; envclean HONE_GATE_TOKEN_FILE="$F/cred/token" /bin/bash "$RUNS" restore > "$F/out.txt" 2>&1 || RC=$?; OUT="$F/out.txt"; stop "an argument (e.g. 'restore') is refused" "takes no arguments" 0
mkfix rbin; printf '\n#x\n' >> "$ROOT/supabase-cli/supabase-go"; pitr; stop "a modified supabase-go is refused" "sha256 mismatch" 0

# ---- the launcher: stub gates named like the reviewed ones; they print their environment NAMES and their arguments
mkdir -p "$T/gates" "$T/lc"; chmod 700 "$T/lc"; printf 'tok\n' > "$T/lc/token"; printf 'pw\n' > "$T/lc/pw"; chmod 600 "$T/lc/token" "$T/lc/pw"
for g in window-s0a window-s1read window-gap-read pitr-backups window-row4; do
  printf '#!/bin/bash\necho "ARGC=$#"\nenv | sed -n "s/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p" | sort | tr "\\n" " "\necho\necho "TF=${HONE_GATE_TOKEN_FILE-unset} PF=${HONE_GATE_PASSWORD_FILE-unset}"\n' > "$T/gates/$g.sh"; chmod 755 "$T/gates/$g.sh"
done
L() { RC=0; env -i HOME="$T" PATH=/usr/bin:/bin:$(dirname "$(command -v node)") SUPABASE_ACCESS_TOKEN=leak GH_TOKEN=leak PGPASSWORD=leak bash "$LAUNCH" "$@" > "$T/lout.txt" 2>&1 || RC=$?; }
refuse() { L "${@:2}"; if [ "$RC" != 0 ] && grep -q "launcher: STOP: $1" "$T/lout.txt"; then ok "launcher refuses: $1"; else bad "launcher should refuse: $1" "rc=$RC $(head -2 "$T/lout.txt")"; fi; }
refuse "this gate needs --password-file" --token-file "$T/lc/token" -- "$T/gates/window-s0a.sh"
refuse "this gate needs --token-file" --password-file "$T/lc/pw" -- "$T/gates/window-s0a.sh"
refuse "this gate takes no database password" --token-file "$T/lc/token" --password-file "$T/lc/pw" -- "$T/gates/pitr-backups.sh"
refuse "this gate takes no token" --token-file "$T/lc/token" -- "$T/gates/window-row4.sh"
refuse "this gate takes no database password" --password-file "$T/lc/pw" -- "$T/gates/window-row4.sh"
refuse "credential file paths must be absolute" --token-file lc/token --password-file "$T/lc/pw" -- "$T/gates/window-s1read.sh"
refuse "not one of the reviewed gate scripts" -- "$T/gates/other.sh"
refuse "exactly one gate script after --" --token-file "$T/lc/token" -- "$T/gates/pitr-backups.sh" extra
refuse "unknown argument" --token "$T/lc/token" -- "$T/gates/pitr-backups.sh"
mkdir -p "$T/lk"; ln -sf "$T/gates/window-row4.sh" "$T/lk/window-row4.sh"; refuse "the gate script is missing or a symlink" -- "$T/lk/window-row4.sh"
for g in window-s0a window-s1read window-gap-read; do
  L --token-file "$T/lc/token" --password-file "$T/lc/pw" -- "$T/gates/$g.sh"
  [ "$RC" = 0 ] && grep -q "^ARGC=0" "$T/lout.txt" && grep -q "TF=$T/lc/token PF=$T/lc/pw" "$T/lout.txt" && ok "launcher: $g gets both paths as environment names, no argument" || bad "launcher $g" "$(cat "$T/lout.txt")"
done
L --token-file "$T/lc/token" -- "$T/gates/pitr-backups.sh"; [ "$RC" = 0 ] && grep -q "TF=$T/lc/token PF=unset" "$T/lout.txt" && ok "launcher: pitr-backups gets only the token path" || bad "launcher pitr" "$(cat "$T/lout.txt")"
L -- "$T/gates/window-row4.sh"; [ "$RC" = 0 ] && grep -q "TF=unset PF=unset" "$T/lout.txt" && ok "launcher: row4 gets no credential" || bad "launcher row4" "$(cat "$T/lout.txt")"
L --token-file "$T/lc/token" --password-file "$T/lc/pw" -- "$T/gates/window-s0a.sh"
! grep -qE 'SUPABASE_ACCESS_TOKEN|GH_TOKEN|PGPASSWORD|leak' "$T/lout.txt" && ok "launcher: the gate's environment is clean (a SUPABASE_ACCESS_TOKEN/GH_TOKEN/PGPASSWORD in the caller's environment never reaches it)" || bad "launcher environment" "$(cat "$T/lout.txt")"
grep -q 'HOME HONE_GATE_PASSWORD_FILE HONE_GATE_TOKEN_FILE LANG PATH PWD SHLVL TERM _ ' "$T/lout.txt" && ok "launcher: the environment holds exactly HOME LANG PATH TERM, the two path names and bash's own PWD/SHLVL/_" || bad "launcher environment names" "$(sed -n 2p "$T/lout.txt")"
! grep -qE '^(tok|pw)$' "$T/lout.txt" && ok "launcher: neither credential value is printed" || bad "value printed"

echo; echo "passed: $pass failed: $fail"
[ "$fail" = 0 ]
