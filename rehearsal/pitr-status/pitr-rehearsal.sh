#!/bin/bash
# REHEARSAL - NEVER MERGE. PITR-STATUS-READS on macOS arm64 (macos-14): pitr-backups.sh, pitr-wal-status.sql / pitr-ready-count.sql and
# pitr-wal-twice.sh against a throwaway local PostgreSQL 17 with archive_mode on, a stub Management API and the REAL darwin supabase-go.
# Hosted: nothing. The only network use is fetching the public supabase CLI release. See the END file for real vs stub.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; PKG="$HERE/pkg"
W="${E2E_WORK:?E2E_WORK}"; rm -rf "$W"; mkdir -p "$W"
FAKEHOME="$W/home"; ROOT="$FAKEHOME/hone-s1"; PS="$ROOT/pitr-status"
TSV="$W/steps.tsv"; : > "$TSV"; PASS=0; FAIL=0; CUR=infra
PW="Pw-$(openssl rand -hex 8)"
TOK="sbp_$(openssl rand -hex 20)"   # a throwaway value made at run time; it is never stored in the repository
REF=alhhybgqdmcdyzpybykj
ok()  { PASS=$((PASS+1)); printf '%s\tok\t%s\n' "$CUR" "$1" >> "$TSV"; echo "ok   - $1"; }
bad() { FAIL=$((FAIL+1)); printf '%s\tFAIL\t%s\n' "$CUR" "$1 $2" >> "$TSV"; echo "FAIL - $1 $2"; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
has() { grep -qF -- "$2" "$1" 2>/dev/null; }
section() { CUR="$1"; echo; echo "== $1"; }

# ------------------------------------------------------------------------------------------------ infra
section infra
P="$(brew --prefix postgresql@17 2>/dev/null || true)"
if [ ! -x "$P/bin/initdb" ]; then brew install postgresql@17 >"$W/build.log" 2>&1 || brew install postgresql@17; P="$(brew --prefix postgresql@17)"; fi
B="$P/bin"; PGD="$W/pg"; ARCH="$W/archive"; mkdir -p "$PGD" "$ARCH"; chmod 700 "$PGD"
printf '%s\n' "$PW" > "$W/pw.txt"
"$B/initdb" -D "$PGD/data" -U postgres --auth-local=trust --auth-host=scram-sha-256 --pwfile="$W/pw.txt" -E UTF8 >/dev/null && rm -f "$W/pw.txt"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$PGD/data/server.key" -out "$PGD/data/server.crt" -subj /CN=localhost -days 2 >/dev/null 2>&1; chmod 600 "$PGD/data/server.key"
cat >> "$PGD/data/postgresql.conf" <<CONF
port = 55433
listen_addresses = '127.0.0.1'
unix_socket_directories = '$PGD'
ssl = on
fsync = off
wal_level = replica
archive_mode = on
archive_command = 'test ! -f $ARCH/%f && cp %p $ARCH/%f'
archive_timeout = 10
checkpoint_timeout = 1h
log_connections = on
CONF
printf 'hostssl all all 127.0.0.1/32 scram-sha-256\nlocal all all trust\n' > "$PGD/data/pg_hba.conf"
"$B/pg_ctl" -D "$PGD/data" -l "$PGD/pg.log" -w start >/dev/null
su() { "$B/psql" -X -At -h "$PGD" -p 55433 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "$1"; }
for r in v_plain v_stats v_monitor; do su "create role $r login password '$PW'" >/dev/null; done
su "grant pg_read_all_stats to v_stats" >/dev/null; su "grant pg_monitor to v_monitor" >/dev/null
su "create table gen(t text)" >/dev/null
[ "$(su 'select 1')" = 1 ] && ok "PostgreSQL $(su 'show server_version') up on 127.0.0.1:55433 with archive_mode=on, archive_timeout=10, TLS, scram" || bad "postgres"

mkdir -p "$W/dl" && ( cd "$W/dl" && curl -fsSL -o cli.tgz https://github.com/supabase/cli/releases/download/v2.102.0/supabase_2.102.0_darwin_arm64.tar.gz && tar -xzf cli.tgz ) || { echo "could not fetch the CLI"; exit 2; }
REALBIN=""
for f in "$W/dl/"*; do [ -f "$f" ] && [ "$(sha "$f")" = dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b ] && REALBIN="$f"; done
[ -n "$REALBIN" ] && ok "the real darwin_arm64 supabase-go v2.102.0 hashes to the pinned dce26b75" || { bad "no archive member hashes to dce26b75"; exit 2; }

# ------------------------------------------------------------------------------------------------ visibility matrix
section visibility
EXPRS=(
"(select archived_count from pg_stat_archiver)" "(select last_archived_wal from pg_stat_archiver)" "(select last_archived_time from pg_stat_archiver)"
"(select failed_count from pg_stat_archiver)" "(select last_failed_time from pg_stat_archiver)" "(select stats_reset from pg_stat_archiver)"
"pg_current_wal_lsn()" "pg_current_wal_insert_lsn()" "pg_current_wal_flush_lsn()" "(select file_name from pg_walfile_name_offset(pg_current_wal_lsn()))"
"pg_postmaster_start_time()" "pg_is_in_recovery()" "pg_snapshot_xmax(pg_current_snapshot())"
"current_setting('archive_mode')" "(select setting from pg_settings where name='archive_timeout')" "current_setting('wal_level')" "current_setting('checkpoint_timeout')" "current_setting('wal_segment_size')"
"(select xact_commit from pg_stat_database where datname=current_database())"
"(select count(*) from pg_ls_archive_statusdir())"
)
: > "$W/visibility.tsv"
for role in postgres v_plain v_stats v_monitor; do
  for ex in "${EXPRS[@]}"; do
    if [ "$role" = postgres ]; then out=$("$B/psql" -X -At -h "$PGD" -p 55433 -U postgres -d postgres -c "select $ex" 2>&1); rc=$?
    else out=$(PGPASSWORD="$PW" "$B/psql" -X -At "host=127.0.0.1 port=55433 dbname=postgres user=$role sslmode=require" -c "select $ex" 2>&1); rc=$?; fi
    if [ $rc = 0 ]; then res=readable; elif printf '%s' "$out" | grep -q 'permission denied'; then res=denied; else res="error"; fi
    printf '%s\t%s\t%s\n' "$role" "$ex" "$res" >> "$W/visibility.tsv"
  done
done
MAIN_N=$(( ${#EXPRS[@]} - 1 ))
SCEN=""
for role in v_plain v_stats v_monitor; do
  d=$(awk -F'\t' -v r="$role" '$1==r && $3!="readable" && $2 !~ /pg_ls_archive_statusdir/ {n++} END{print n+0}' "$W/visibility.tsv")
  [ "$d" = 0 ] && { SCEN="$role"; break; }
done
echo "visibility (role / expression / result), not readable only:"; awk -F'\t' '$3!="readable"{print "  " $1 "  " $2 "  " $3}' "$W/visibility.tsv"
for role in postgres v_plain v_stats v_monitor; do
  echo "  $role: $(awk -F'\t' -v r="$role" '$1==r && $3=="readable"{n++} END{print n+0}' "$W/visibility.tsv") of ${#EXPRS[@]} readable"
done
[ -n "$SCEN" ] && ok "the least-privileged role that reads every field of pitr-wal-status.sql is $SCEN (matrix in visibility.tsv)" || { bad "no tested role reads every main field"; SCEN=v_monitor; }
RDY_PLAIN=$(awk -F'\t' '$1=="v_plain" && $2 ~ /pg_ls_archive_statusdir/{print $3}' "$W/visibility.tsv")
RDY_MON=$(awk -F'\t' '$1=="v_monitor" && $2 ~ /pg_ls_archive_statusdir/{print $3}' "$W/visibility.tsv")
ok "pg_ls_archive_statusdir (the .ready count): v_plain=$RDY_PLAIN, v_monitor=$RDY_MON"

# ------------------------------------------------------------------------------------------------ layout, download line, test copies
section download
mkdir -p "$FAKEHOME" "$ROOT/supabase-cli/real" "$W/bin" "$W/vps/machines/pitr-status"
cp "$REALBIN" "$ROOT/supabase-cli/real/supabase-go"; chmod 755 "$ROOT/supabase-cli/real/supabase-go"
cp "$HERE/pitr-go-wrapper.sh" "$ROOT/supabase-cli/supabase-go"; chmod 755 "$ROOT/supabase-cli/supabase-go"
WSHA=$(sha "$ROOT/supabase-cli/supabase-go")
for f in pitr-backups.sh pitr-wal-twice.sh run-window-read-macos.sh MANIFEST.sha256 pitr-wal-status.sql pitr-ready-count.sql; do cp "$PKG/$f" "$W/vps/machines/pitr-status/$f"; done
cat > "$W/bin/scp" <<'SCP'
#!/bin/sh
# fake scp: maps sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/<path> to $E2E_VPS/<path>
dest=""; srcs=""
for a in "$@"; do case "$a" in -*) ;; sam@100.123.145.56:*) srcs="$srcs ${E2E_VPS}/${a#sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/}" ;; *) dest="$a" ;; esac; done
for s in $srcs; do cp "$s" "$dest/" || exit 1; done
SCP
chmod 755 "$W/bin/scp"
LINE=$(grep -m1 '^    ( set -u' "$PKG/PITR-STATUS-MACOS.md" | sed 's/^    //')
[ -n "$LINE" ] && ok "the download line was taken from PITR-STATUS-MACOS.md" || { bad "no download line"; exit 2; }
mkdir -p "$ROOT"
before=$(cd "$ROOT" && find . -type f | sort | shasum -a 256)
env -i HOME="$FAKEHOME" PATH="$W/bin:/usr/bin:/bin:/usr/sbin:/sbin" E2E_VPS="$W/vps" /bin/zsh -c "$LINE" > "$W/dl1.out" 2>&1; rc=$?
cat "$W/dl1.out"
[ $rc = 0 ] && has "$W/dl1.out" "sha256 OK, installed" && ok "the published download line ran under zsh with a fake scp and ended with 'sha256 OK, installed'" || bad "download line" "rc=$rc"
allok=1; for f in pitr-backups.sh pitr-wal-twice.sh run-window-read-macos.sh MANIFEST.sha256 pitr-wal-status.sql pitr-ready-count.sql; do [ "$(sha "$PS/$f")" = "$(sha "$PKG/$f")" ] || allok=0; done
[ "$allok" = 1 ] && ok "every installed file equals its VPS copy" || bad "installed files differ"
[ "$(sha "$PS/run-window-read-macos.sh")" = 471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357 ] && ok "the runner copy is byte-identical to the pinned runner (471ecb9d)" || bad "runner sha"
# negative: one tampered file -> STOP, nothing installed
mkdir -p "$W/home2/hone-s1"; cp "$W/vps/machines/pitr-status/pitr-wal-status.sql" "$W/vps/machines/pitr-status/pitr-wal-status.sql.keep"; echo "-- x" >> "$W/vps/machines/pitr-status/pitr-wal-status.sql"
env -i HOME="$W/home2" PATH="$W/bin:/usr/bin:/bin:/usr/sbin:/sbin" E2E_VPS="$W/vps" /bin/zsh -c "$LINE" > "$W/dl2.out" 2>&1; rc=$?
mv "$W/vps/machines/pitr-status/pitr-wal-status.sql.keep" "$W/vps/machines/pitr-status/pitr-wal-status.sql"
has "$W/dl2.out" "STOP: sha256 mismatch for pitr-wal-status.sql" && ! has "$W/dl2.out" "installed" && [ ! -e "$W/home2/hone-s1/pitr-status" ] && ok "a tampered file: STOP, and nothing was installed" || bad "tamper case" "rc=$rc"

# the backups-only download line (PITR-BACKUPS-MACOS.md): one file; tamper -> STOP, nothing installed
BLINE=$(grep -m1 '^    ( set -u' "$PKG/PITR-BACKUPS-MACOS.md" | sed 's/^    //')
mkdir -p "$W/home4/hone-s1"
env -i HOME="$W/home4" PATH="$W/bin:/usr/bin:/bin:/usr/sbin:/sbin" E2E_VPS="$W/vps" /bin/zsh -c "$BLINE" > "$W/dl3.out" 2>&1; cat "$W/dl3.out"
has "$W/dl3.out" "pitr-backups.sh: sha256 OK, installed" && [ "$(ls "$W/home4/hone-s1/pitr-status")" = "pitr-backups.sh" ] && [ "$(sha "$W/home4/hone-s1/pitr-status/pitr-backups.sh")" = "$(sha "$PKG/pitr-backups.sh")" ] && ok "the backups-only download line installs exactly pitr-backups.sh (sha256 checked first)" || bad "backups-only line"
cp "$W/vps/machines/pitr-status/pitr-backups.sh" "$W/pb.keep"; echo "#" >> "$W/vps/machines/pitr-status/pitr-backups.sh"; mkdir -p "$W/home5/hone-s1"
env -i HOME="$W/home5" PATH="$W/bin:/usr/bin:/bin:/usr/sbin:/sbin" E2E_VPS="$W/vps" /bin/zsh -c "$BLINE" > "$W/dl4.out" 2>&1; mv "$W/pb.keep" "$W/vps/machines/pitr-status/pitr-backups.sh"
has "$W/dl4.out" "STOP: sha256 mismatch for pitr-backups.sh" && ! has "$W/dl4.out" "installed" && [ ! -e "$W/home5/hone-s1/pitr-status" ] && ok "backups-only line, tampered file: STOP, nothing installed" || bad "backups-only tamper"

# test copies: only the pins and the interval constants differ
cp "$PS/run-window-read-macos.sh" "$W/runner.orig"
sed "s/^SUPABASE_GO_SHA256=.*/SUPABASE_GO_SHA256=$WSHA/" "$W/runner.orig" > "$PS/run-window-read-macos.sh"; chmod 755 "$PS/run-window-read-macos.sh"
TRUN=$(sha "$PS/run-window-read-macos.sh")
sed -e "s/^GO_SHA=.*/GO_SHA=$WSHA/" -e "s/^RUNNER_SHA=.*/RUNNER_SHA=$TRUN/" -e 's/^N_FLOOR=600$/N_FLOOR=15/' -e 's/^N_MARGIN=180$/N_MARGIN=3/' "$PKG/pitr-wal-twice.sh" > "$PS/pitr-wal-twice.sh"
sed -e "s/^GO_SHA=.*/GO_SHA=$WSHA/" "$PKG/pitr-backups.sh" > "$PS/pitr-backups.sh"; chmod 755 "$PS/pitr-wal-twice.sh" "$PS/pitr-backups.sh"
d1=$(diff "$PKG/pitr-wal-twice.sh" "$PS/pitr-wal-twice.sh" | grep -c '^>'); d2=$(diff "$PKG/pitr-backups.sh" "$PS/pitr-backups.sh" | grep -c '^>'); d3=$(diff "$W/runner.orig" "$PS/run-window-read-macos.sh" | grep -c '^>')
[ "$d1" = 4 ] && [ "$d2" = 1 ] && [ "$d3" = 1 ] && ok "test copies differ from the published scripts only on GO_SHA/RUNNER_SHA/N_FLOOR/N_MARGIN (4), GO_SHA (1) and the runner's SUPABASE_GO_SHA256 (1)" || bad "test copy diff" "$d1 $d2 $d3"
grep -q '^N_FLOOR=600$' "$PKG/pitr-wal-twice.sh" && grep -q '^N_MARGIN=180$' "$PKG/pitr-wal-twice.sh" && grep -q '^N_MAX=1800$' "$PKG/pitr-wal-twice.sh" && grep -q '^T_MAX=1200$' "$PKG/pitr-wal-twice.sh" && ok "the PUBLISHED wrapper holds N_FLOOR=600, N_MARGIN=180, N_MAX=1800, T_MAX=1200" || bad "published constants"
# the interval formula of the PUBLISHED script, extracted and evaluated
sed -n -e '/^N_FLOOR=/p' -e '/^N_MARGIN=/p' -e '/^N_MAX=/p' -e '/^T_MAX=/p' -e '/^interval_for_T() {/,/^}/p' "$PKG/pitr-wal-twice.sh" > "$W/formula.sh"
tbl=""; for t in 120 300 420 600 900 1200 0 1201 x ""; do tbl="$tbl $t=$( . "$W/formula.sh"; interval_for_T "$t")"; done
[ "$tbl" = " 120=600 300=600 420=600 600=780 900=1080 1200=1380 0=closed 1201=closed x=closed =closed" ] && ok "N = max(600, T+180): T=120->600, 300->600, 420->600, 600->780, 900->1080, 1200->1380; T=0, 1201, x, empty -> closed" || bad "formula" "$tbl"

# ------------------------------------------------------------------------------------------------ helpers for the pty runs
SAFEPATH="/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)")"
drive() { # drive NAME ANSWERS-FILE COMMAND... -> $OUT, $RC
  NAME=$1; ANS=$2; shift 2; OUT="$W/$NAME.out"; RC=0
  python3 "$HERE/driver.py" "$OUT" "$ANS" -- env -i PATH="$SAFEPATH" HOME="$FAKEHOME" TERM=dumb "$@" >/dev/null 2>&1 || RC=$?
  LC_ALL=C sed 's/\x1b\[[0-9;]*[A-Za-z]//g; s/\r//g' "$OUT" > "$OUT.clean"; mv "$OUT.clean" "$OUT"
}
calls() { [ -f "$ROOT/pitr-calls.log" ] && grep -c '' "$ROOT/pitr-calls.log" || echo 0; }
target() { printf 'postgresql://%s@127.0.0.1:55433/postgres?sslmode=require' "$1" > "$ROOT/pitr-target"; }
mkstub() { # mkstub KIND
  python3 -I - "$1" "$ROOT/pitr-backups-stub.json" <<'PY'
import json, sys, time
kind, out = sys.argv[1], sys.argv[2]
now = int(time.time()); iso = lambda s: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(s))
if kind == "healthy":
    b = [{"is_physical_backup": True, "status": "COMPLETED", "inserted_at": iso(now-3600*5)}, {"is_physical_backup": True, "status": "COMPLETED", "inserted_at": iso(now-3600*29)}]
    pb = {"earliest_physical_backup_date_unix": now-7*86400, "latest_physical_backup_date_unix": now-600}
elif kind == "stuck":
    b = [{"is_physical_backup": True, "status": "FAILED", "inserted_at": iso(now-600)}, {"is_physical_backup": False, "status": "COMPLETED", "inserted_at": iso(now-900)}, {"is_physical_backup": True, "status": "COMPLETED", "inserted_at": iso(now-3600*6)}]
    pb = {"earliest_physical_backup_date_unix": now-7*86400-17400, "latest_physical_backup_date_unix": now-(4*3600+49*60)}
else:
    b = [{"is_physical_backup": True, "status": "FAILED", "inserted_at": iso(now-600)}, {"is_physical_backup": False, "status": "COMPLETED", "inserted_at": iso(now-900)}]
    pb = {}
d = {"region": "us-east-1", "walg_enabled": True, "pitr_enabled": kind != "none", "backups": b}
if pb: d["physical_backup_data"] = pb
json.dump(d, open(out, "w"))
PY
}
printf 'Supabase access token\t%s\n' "$TOK" > "$W/a-tok.txt"
printf 'Supabase access token\t%s\nDatabase password\t%s\n' "$TOK" "$PW" > "$W/a-both.txt"
printf 'Supabase access token\t%s\nDatabase password\tWrong-%s\n' "$TOK" "$PW" > "$W/a-wrong.txt"

# ------------------------------------------------------------------------------------------------ tool 1: pitr-backups.sh
section backups
target "$SCEN"
mkstub healthy; c0=$(calls)
drive b1 "$W/a-tok.txt" /bin/bash "$PS/pitr-backups.sh"; cat "$OUT" | tail -n 14
[ $RC = 0 ] && has "$OUT" "pitr_enabled: true" && has "$OUT" "walg_enabled: true" && has "$OUT" "latest COMPLETED physical backup: inserted_at=" && has "$OUT" "PITR BACKUPS READ COMPLETE" && ok "healthy stub: exit 0; pitr_enabled, walg_enabled, the UTC physical-backup times, every backup and the latest COMPLETED physical backup are printed" || bad "healthy" "rc=$RC"
[ $(( $(calls) - c0 )) = 1 ] && tail -n 1 "$ROOT/pitr-calls.log" | grep -q 'backups list' && ok "exactly one supabase-go call, 'backups list'" || bad "call count"
BD=$(ls -d "$ROOT"/pitr-backups.* | tail -n 1)
[ "$(stat -f %Lp "$BD")" = 700 ] && [ -s "$BD/backups.json" ] && [ "$(grep -c '' "$BD/backups.meta.json")" = 1 ] && ok "the JSON and a one-line sidecar are saved in a fresh private (0700) folder" || bad "saved files"
grep -qE '^\{"command":"backups list","started_at_utc":"[0-9T:Z-]+","captured_at_utc":"[0-9T:Z-]+","exit_code":0,"result_sha256":"'"$(sha "$BD/backups.json")"'"' "$BD/backups.meta.json" && ok "the sidecar binds the result hash" || bad "sidecar"
mkstub stuck; drive b2 "$W/a-tok.txt" /bin/bash "$PS/pitr-backups.sh"; tail -n 12 "$OUT"
[ $RC = 0 ] && has "$OUT" "(4h49m ago)" && has "$OUT" "status=FAILED" && has "$OUT" "is_physical_backup=false" && ok "stuck stub (latest recovery point 4h49m old): the age is printed; FAILED and logical entries are listed" || bad "stuck" "rc=$RC"
LAST=$(grep 'latest COMPLETED physical backup' "$OUT" | head -n 1)
python3 -I - "$ROOT/pitr-backups-stub.json" "$LAST" <<'PY' && ok "the latest COMPLETED physical backup skips the newer FAILED and the newer logical entry" || bad "latest completed selection" "$LAST"
import json, sys
d = json.load(open(sys.argv[1])); want = sorted([b["inserted_at"] for b in d["backups"] if b["status"] == "COMPLETED" and b["is_physical_backup"]])[-1]
sys.exit(0 if want in sys.argv[2] else 1)
PY
mkstub none; drive b3 "$W/a-tok.txt" /bin/bash "$PS/pitr-backups.sh"
[ $RC = 0 ] && has "$OUT" "pitr_enabled: false" && has "$OUT" "latest COMPLETED physical backup: none in the list" && has "$OUT" "not reported" && ok "no physical data: pitr_enabled false, 'not reported' times, 'none in the list'" || bad "none" "rc=$RC"
c0=$(calls); env -i HOME="$FAKEHOME" PATH="/usr/bin:/bin:$(dirname "$(command -v node)")" /bin/bash "$PS/pitr-backups.sh" restore > "$W/b4.out" 2>&1; rc=$?
[ $rc != 0 ] && has "$W/b4.out" "this script takes no arguments" && [ "$(calls)" = "$c0" ] && ok "an argument ('restore') is refused before any call" || bad "arg refusal"
for v in SUPABASE_DB_PASSWORD SUPABASE_PROFILE SUPABASE_PROJECT_ID; do
  env -i HOME="$FAKEHOME" PATH="/usr/bin:/bin:$(dirname "$(command -v node)")" "$v=zzz-secret-value" /bin/bash "$PS/pitr-backups.sh" > "$W/b5.out" 2>&1; rc=$?
  [ $rc != 0 ] && has "$W/b5.out" "unset these variables first (names only): $v" && ! has "$W/b5.out" "zzz-secret-value" && [ "$(calls)" = "$c0" ] && ok "$v in the environment: refused by name, value not printed, no call" || bad "env refusal $v"
done
cp "$ROOT/supabase-cli/supabase-go" "$W/go.keep"; echo "#" >> "$ROOT/supabase-cli/supabase-go"
env -i HOME="$FAKEHOME" PATH="/usr/bin:/bin:$(dirname "$(command -v node)")" /bin/bash "$PS/pitr-backups.sh" > "$W/b6.out" 2>&1; rc=$?; cp "$W/go.keep" "$ROOT/supabase-cli/supabase-go"
[ $rc != 0 ] && has "$W/b6.out" "supabase-go missing or sha256 mismatch" && ok "a supabase-go with another hash is refused" || bad "go sha refusal"
touch "$ROOT/pitr-backups-fail"; drive b7 "$W/a-tok.txt" /bin/bash "$PS/pitr-backups.sh"; rm -f "$ROOT/pitr-backups-fail"
BD7=$(ls -d "$ROOT"/pitr-backups.* | tail -n 1)
[ $RC != 0 ] && has "$OUT" "backups list failed" && ! has "$OUT" "$TOK" && ! grep -q "$TOK" "$BD7/backups.err" && ok "a failing API call stops (no retry); the token and the URL are masked in the saved log" || bad "failure case" "rc=$RC"
c0=$(calls); mkstub healthy

# ------------------------------------------------------------------------------------------------ real binary: backups list against a stub API
section realcli
python3 -I "$HERE/stub-api.py" "$ROOT/pitr-backups-stub.json" "$W/api.log" > "$W/api.out" 2>&1 &
APIPID=$!
for i in 1 2 3 4 5 6 7 8 9 10; do /usr/bin/nc -z 127.0.0.1 8080 2>/dev/null && break; /bin/sleep 1; done
CONN0=$(grep -c 'connection received' "$PGD/pg.log")
mkdir -p "$W/realcwd/supabase/.temp" "$W/realhome"; echo v2.102.0 > "$W/realcwd/supabase/.temp/cli-latest"
( cd "$W/realcwd" && env -i HOME="$W/realhome" PATH=/usr/bin:/bin SUPABASE_ACCESS_TOKEN="$TOK" SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 "$REALBIN" --agent no --profile supabase-local backups list --project-ref abcdefghijklmnopqrst -o json > "$W/real.out" 2> "$W/real.err" ); rc=$?
kill $APIPID 2>/dev/null; wait $APIPID 2>/dev/null
cat "$W/api.log"; head -c 300 "$W/real.out"; echo; head -c 300 "$W/real.err"; echo
[ $rc = 0 ] && grep -Eq '"pitr_enabled": ?true' "$W/real.out" && ok "the REAL supabase-go v2.102.0 ran 'backups list -o json' (against the stub API) and printed the JSON" || bad "real cli run" "rc=$rc"
NREQ=$(grep -c '' "$W/api.log")
bad_req=$(grep -vE '^GET /v1/projects/abcdefghijklmnopqrst(/database/backups)? auth=yes$' "$W/api.log" || true)
[ -z "$bad_req" ] && grep -q 'database/backups' "$W/api.log" && ok "a bare 'backups list' in an UNSEEDED folder made $NREQ read-only GET request(s), nothing else: the backups GET$( [ "$NREQ" = 2 ] && echo ' plus the CLI telemetry project lookup GET /v1/projects/<ref> (a finding; pitr-backups.sh seeds linked-project.json to avoid it)')" || bad "unseeded request log" "$(cat "$W/api.log")"
[ "$(grep -c 'connection received' "$PGD/pg.log")" = "$CONN0" ] && ok "no database connection was opened (the local database's connection log did not change)" || bad "db connection"
! grep -rqF -- "$TOK" "$W/real.out" "$W/real.err" "$W/realcwd" "$W/realhome" 2>/dev/null && ok "the token appears in no output or file of the real run" || bad "real token leak"

# the WHOLE pitr-backups.sh with the REAL binary against the stub API (one test copy line: --profile supabase-local)
section realscript
H3="$W/home3"; mkdir -p "$H3/hone-s1/supabase-cli" "$H3/hone-s1/pitr-status"
cp "$REALBIN" "$H3/hone-s1/supabase-cli/supabase-go"; chmod 755 "$H3/hone-s1/supabase-cli/supabase-go"
sed 's/"\$BIN" --agent no backups list/"$BIN" --agent no --profile supabase-local backups list/' "$PKG/pitr-backups.sh" > "$H3/hone-s1/pitr-status/pitr-backups.sh"
[ "$(diff "$PKG/pitr-backups.sh" "$H3/hone-s1/pitr-status/pitr-backups.sh" | grep -c '^>')" = 1 ] && ok "test copy of pitr-backups.sh differs by ONE line (--profile supabase-local); GO_SHA stays the real pin dce26b75" || bad "realscript copy"
find "$H3" -type f | sort > "$W/h3.before"
: > "$W/api.log"; python3 -I "$HERE/stub-api.py" "$ROOT/pitr-backups-stub.json" "$W/api.log" > "$W/api.out" 2>&1 & APIPID=$!
for i in 1 2 3 4 5 6 7 8 9 10; do /usr/bin/nc -z 127.0.0.1 8080 2>/dev/null && break; /bin/sleep 1; done
CONN0=$(grep -c 'connection received' "$PGD/pg.log")
RC=0; python3 "$HERE/driver.py" "$W/rs.out" "$W/a-tok.txt" -- env -i PATH="$SAFEPATH" HOME="$H3" TERM=dumb /bin/bash "$H3/hone-s1/pitr-status/pitr-backups.sh" >/dev/null 2>&1 || RC=$?
kill $APIPID 2>/dev/null; wait $APIPID 2>/dev/null
LC_ALL=C sed 's/\x1b\[[0-9;]*[A-Za-z]//g; s/\r//g' "$W/rs.out" > "$W/rs.clean"; mv "$W/rs.clean" "$W/rs.out"; tail -n 12 "$W/rs.out"; cat "$W/api.log"
[ $RC = 0 ] && has "$W/rs.out" "pitr_enabled: true" && has "$W/rs.out" "PITR BACKUPS READ COMPLETE" && ok "pitr-backups.sh ran end to end with the REAL supabase-go (pty-typed token, stub API): exit 0" || bad "realscript run" "rc=$RC"
[ "$(grep -c '' "$W/api.log")" = 1 ] && grep -qx 'GET /v1/projects/abcdefghijklmnopqrst/database/backups auth=yes' "$W/api.log" && ok "the stub API saw exactly ONE request: GET .../database/backups with a Bearer token (no project lookup, no login-role, no ban-list, no write)" || bad "realscript request log" "$(cat "$W/api.log")"
[ "$(grep -c 'connection received' "$PGD/pg.log")" = "$CONN0" ] && ok "no database connection was opened during the script run" || bad "realscript db connection"
find "$H3" -type f | sort > "$W/h3.after"; echo "files created under the fake HOME by the run (names only):"; comm -13 "$W/h3.before" "$W/h3.after" | sed "s#$H3/##"
! grep -rIlF -- "$TOK" "$H3" "$W/rs.out" "$W/api.log" 2>/dev/null | grep -q . && ok "the token appears in no transcript or file of the script run" || bad "realscript token leak"

# ------------------------------------------------------------------------------------------------ tool 2: pitr-wal-twice.sh
section wal
wait_archived() { c0=$(su "select archived_count from pg_stat_archiver"); i=0; while [ $i -lt 40 ]; do [ "$(su 'select archived_count from pg_stat_archiver')" -gt "$c0" ] && return 0; /bin/sleep 1; i=$((i+1)); done; return 1; }
prep_idle() { su "alter system set archive_command = 'test ! -f $ARCH/%f && cp %p $ARCH/%f'" >/dev/null; su "select pg_reload_conf()" >/dev/null
  su "insert into gen values ('x')" >/dev/null; su "select pg_switch_wal()" >/dev/null; wait_archived; /bin/sleep 14; }
gen_loop() { i=0; while [ $i -lt "$1" ]; do su "insert into gen select repeat('x',500) from generate_series(1,2000)" >/dev/null 2>&1; su "select pg_switch_wal()" >/dev/null 2>&1; /bin/sleep 5; i=$((i+1)); done; }
runwal() { # runwal NAME ROLE ANSWERS
  target "$2"; drive "$1" "$3" /bin/bash "$PS/pitr-wal-twice.sh"; tail -n 22 "$OUT" | cut -c1-210; }
indic() { grep -m1 '^INDICATION:' "$OUT" | cut -c1-200; }

prep_idle
c0=$(calls); runwal idle "$SCEN" "$W/a-both.txt"
[ $RC = 0 ] && has "$OUT" "INDICATION: IDLE_PROVEN" && has "$OUT" "PITR WAL STATUS READ COMPLETE" && ok "IDLE ($SCEN): no WAL movement, archiver healthy -> exit 0, INDICATION: IDLE_PROVEN" || bad "idle" "rc=$RC $(indic)"
[ $(( $(calls) - c0 )) = 4 ] && ok "four logins: the main file and the ready count, twice" || bad "idle call count" "$(( $(calls) - c0 ))"
has "$OUT" "interval by the database clock: 1" && ok "the interval was measured by the database clock and met N (15 s in the test copy)" || bad "interval line"
if [ "$SCEN" = v_plain ] && [ "$RDY_PLAIN" = denied ]; then has "$OUT" "not readable" && ok "the ready count was not readable for $SCEN: recorded, not a stop" || bad "unreadable ready path"; fi

# label case: a base backup archives a .backup label
prep_idle; "$B/pg_basebackup" -h "$PGD" -p 55433 -U postgres -D "$W/basebackup" -X fetch -c fast >/dev/null 2>&1
i=0; while [ $i -lt 40 ]; do case "$(su 'select last_archived_wal from pg_stat_archiver')" in *.backup) break ;; esac; /bin/sleep 1; i=$((i+1)); done; /bin/sleep 14
LASTW=$(su 'select last_archived_wal from pg_stat_archiver')
case "$LASTW" in
  *.backup)
    runwal label_plain v_plain "$W/a-both.txt"
    if [ "$RDY_PLAIN" = denied ]; then [ $RC = 0 ] && has "$OUT" "INDICATION: UNKNOWN" && ok "LABEL case, ready count not readable: INDICATION UNKNOWN (the idle path stays closed)" || bad "label unreadable" "rc=$RC $(indic)"; fi
    runwal label_mon v_monitor "$W/a-both.txt"
    [ $RC = 0 ] && has "$OUT" "INDICATION: IDLE_PROVEN" && has "$OUT" '"label" means' && ok "LABEL case, ready count readable and 0 (v_monitor): INDICATION IDLE_PROVEN" || bad "label readable" "rc=$RC $(indic)" ;;
  *) echo "last archived is $LASTW (not a label): label case not exercised"; printf 'wal\tskip\tlabel case not exercised: last archived %s\n' "$LASTW" >> "$TSV" ;;
esac

prep_idle
gen_loop 12 & GEN=$!
runwal active v_monitor "$W/a-both.txt"; wait $GEN
[ $RC = 0 ] && has "$OUT" "INDICATION: ACTIVE_HEALTHY" && ok "ACTIVE: WAL moves and archived_count rises, failed_count does not -> INDICATION: ACTIVE_HEALTHY" || bad "active" "rc=$RC $(indic)"
prep_idle
su "alter system set archive_command = 'false'" >/dev/null; su "select pg_reload_conf()" >/dev/null
gen_loop 12 & GEN=$!
runwal stalled v_monitor "$W/a-both.txt"; wait $GEN
[ $RC = 0 ] && has "$OUT" "INDICATION: STALLED" && ok "STALLED (archive_command failing): failed_count rises / segments wait -> INDICATION: STALLED" || bad "stalled" "rc=$RC $(indic)"
grep -E '^failed_count|^ready_count' "$OUT" | head -n 3
su "alter system set archive_command = 'test ! -f $ARCH/%f && cp %p $ARCH/%f'" >/dev/null; su "select pg_reload_conf()" >/dev/null
i=0; while [ $i -lt 90 ]; do [ "$(su "select count(*) from pg_ls_archive_statusdir() where name like '%.ready'")" = 0 ] && break; /bin/sleep 1; i=$((i+1)); done

# T = 0: the idle path is closed after the first reading
prep_idle; su "alter system set archive_timeout = 0" >/dev/null; su "select pg_reload_conf()" >/dev/null; /bin/sleep 2
c0=$(calls); runwal t0 "$SCEN" "$W/a-both.txt"
[ $RC = 3 ] && has "$OUT" "IDLE PATH CLOSED" && [ $(( $(calls) - c0 )) = 2 ] && ok "archive_timeout = 0: exit 3, 'IDLE PATH CLOSED', only the first reading was taken (2 logins)" || bad "T=0" "rc=$RC calls=$(( $(calls) - c0 ))"
su "alter system set archive_timeout = 10" >/dev/null; su "select pg_reload_conf()" >/dev/null

# refusals and the failed-login tombstone
c0=$(calls); env -i HOME="$FAKEHOME" PATH="/usr/bin:/bin:$(dirname "$(command -v node)")" /bin/bash "$PS/pitr-wal-twice.sh" extra > "$W/w1.out" 2>&1; rc=$?
[ $rc != 0 ] && has "$W/w1.out" "takes no arguments" && [ "$(calls)" = "$c0" ] && ok "an argument is refused before any call" || bad "wal arg refusal"
echo "-- x" >> "$PS/pitr-ready-count.sql"
env -i HOME="$FAKEHOME" PATH="/usr/bin:/bin:$(dirname "$(command -v node)")" /bin/bash "$PS/pitr-wal-twice.sh" > "$W/w2.out" 2>&1; rc=$?
cp "$PKG/pitr-ready-count.sql" "$PS/pitr-ready-count.sql"
[ $rc != 0 ] && has "$W/w2.out" "pitr-ready-count.sql missing or sha256 mismatch" && [ "$(calls)" = "$c0" ] && ok "an edited gate file is refused before any call" || bad "gate edit refusal"
runwal wrongpw "$SCEN" "$W/a-wrong.txt"
[ $RC != 0 ] && has "$OUT" "an authentication failure was recorded" && [ -e "$PS/FAILED-LOGIN" ] && ok "a wrong password: STOP, no retry, FAILED-LOGIN tombstone written" || bad "wrong password" "rc=$RC"
c1=$(calls); runwal tomb "$SCEN" "$W/a-both.txt"
[ $RC != 0 ] && has "$OUT" "a previous run failed a login" && [ "$(calls)" = "$c1" ] && ok "with the tombstone present the next run refuses with zero connections" || bad "tombstone refusal"
rm -f "$PS/FAILED-LOGIN"
# a permission refusal on a main field closes the idle path
su "revoke execute on function pg_current_wal_insert_lsn() from public" >/dev/null
runwal denied v_plain "$W/a-both.txt"
su "grant execute on function pg_current_wal_insert_lsn() to public" >/dev/null
[ $RC != 0 ] && has "$OUT" "a permission refusal was reported" && [ ! -e "$PS/FAILED-LOGIN" ] && ok "a permission refusal on a main field: STOP with the idle path closed; not treated as a login failure" || bad "permission refusal" "rc=$RC"

# ------------------------------------------------------------------------------------------------ secrets, final
section final
leak=0
for s in "$TOK" "$PW" "Wrong-$PW"; do grep -rIlF -- "$s" "$W"/*.out "$ROOT" "$W/api.log" "$W/real.err" 2>/dev/null | grep -v '/pitr-calls.log$' | grep -q . && leak=1; done
[ $leak = 0 ] && ok "neither the token nor the password (right or wrong) appears in any transcript, saved log or file under ~/hone-s1" || bad "secret leak"
cmp -s "$PKG/pitr-backups.sh" "$W/vps/machines/pitr-status/pitr-backups.sh" && cmp -s "$PKG/pitr-wal-twice.sh" "$W/vps/machines/pitr-status/pitr-wal-twice.sh" && ok "the published scripts were not modified by the run (only the test copies in the fake HOME were)" || bad "published modified"
cp "$W/visibility.tsv" "$W/visibility-final.tsv" 2>/dev/null
"$B/pg_ctl" -D "$PGD/data" -m fast stop >/dev/null 2>&1
echo; echo "passed: $PASS failed: $FAIL"
[ "$FAIL" = 0 ]
