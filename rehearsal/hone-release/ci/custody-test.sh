#!/bin/bash
# REHEARSAL - NEVER MERGE. Proves the hone-release custody design on a DISPOSABLE Linux VM (a CI runner) with REAL users, REAL sudo and the
# EXACT sudoers line the installer writes. Run as root. A STUB stands in for the vendor CLI (the real CLI is exercised by e2e-test.sh);
# every secret is a CANARY. The agent is the user "sam", who is in NO docker or sudo group (the design case); a replica user in those
# groups then shows the residual. Nothing here touches a hosted system.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; HR="$HERE/.."; S1="$HR/../s1-script"
T=$(mktemp -d /tmp/hr-custody.XXXXXX); chmod 755 "$T"; mkdir "$T/out"; chmod 777 "$T/out"
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
DBC="DBPW-CANARY-7f3a91c2"; PATC="PAT-CANARY-2c8d44e1"
LB=/usr/local/libexec/hone-release/launcher
REF=abcdefghijklmnopqrst
HEAD40=0123456789abcdef0123456789abcdef01234567
URL="postgresql://postgres.$REF@127.0.0.1:54329/postgres?sslmode=require"
sam() { local e=(); while [[ "${1:-}" == *=* ]]; do e+=("$1"); shift; done; runuser -u sam -- env -i PATH=/usr/bin:/bin HOME=/home/sam LANG=C "${e[@]}" "$@"; }
in1h() { date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ; }
echo "host: $(uname -sr); sudo $(sudo -V | head -1); users before: $(getent passwd sam hone-release | cut -d: -f1 | tr '\n' ' ')"

# ---------------------------------------------------------------- build the test variant and install it with the real installer
id sam >/dev/null 2>&1 || useradd -m -s /bin/bash sam
passwd -l sam >/dev/null 2>&1
SRC="$T/src"; mkdir -p "$SRC/scripts"; cp "$HR/launcher" "$HR/install.sh" "$HR/set-secret.sh" "$HR/approve-package.sh" "$HR/actions.conf" "$HR/sudoers.hone-release" "$SRC/"; cp "$HR"/scripts/*.sh "$SRC/scripts/"
cp "$HERE/stub-supabase-go" "$T/supabase-go"; chmod 755 "$T/supabase-go"
STUBSHA=$(sha256sum "$T/supabase-go" | cut -d' ' -f1)
sed -i "s/^GO_SHA=.*/GO_SHA=$STUBSHA/" "$SRC/scripts/release-apply.sh" "$SRC/scripts/read-backups.sh"
echo "test variant rewrites: GO_SHA in release-apply.sh and read-backups.sh only (the stub's sha256)"
diff <(sed 's/^GO_SHA=.*/GO_SHA=X/' "$HR/scripts/release-apply.sh") <(sed 's/^GO_SHA=.*/GO_SHA=X/' "$SRC/scripts/release-apply.sh") >/dev/null && ok "the installed apply script differs from the shipped one in the GO_SHA line only" || bad "variant differs elsewhere"
bash "$SRC/install.sh" sam "$REF" "$T/supabase-go" > "$T/install.out" 2>&1 && ok "install.sh ran as root and validated the sudoers file with visudo" || { bad "install.sh" "$(tail -5 "$T/install.out")"; exit 1; }
visudo -cf /etc/sudoers.d/hone-release >/dev/null && ok "visudo -cf accepts /etc/sudoers.d/hone-release" || bad "visudo"
printf '%s\n' "$DBC" | bash "$SRC/set-secret.sh" db-password --stdin > /dev/null; printf '%s\n' "$PATC" | bash "$SRC/set-secret.sh" read-pat --stdin > /dev/null
W=/var/lib/hone-release/work
printf '%s' "$DBC" > $W/canary-db; printf '%s' "$PATC" > $W/canary-pat; chown hone-release:hone-release $W/canary-db $W/canary-pat
echo ok > $W/stub-mode; echo "0213 0246" > $W/stub-range; chown hone-release:hone-release $W/stub-mode $W/stub-range
python3 -I "$S1/fixture.py" syn "$T/syn" --head $HEAD40 >/dev/null
install -m 644 -o sam -g sam "$T/syn/migrations-d189768b.tar" /srv/hone-release-inbox/bundle.tar
install -m 644 -o sam -g sam "$T/syn/MIGRATIONS-d189768b.sha256" /srv/hone-release-inbox/list.sha256
approve() { bash "$SRC/approve-package.sh" "$1" 0213 0246 34 "${2:-$(in1h)}" "${3:-$URL}" "${4:-restore point attested by the approver, not verified here}" --yes > "$T/approve.out" 2>&1; }
state() { cat /var/lib/hone-release/state/APPLY-STATE 2>/dev/null || echo none; }
clear_state() { rm -f /var/lib/hone-release/state/APPLY-STATE; }
SAMOUT="$T/out/all.txt"; : > "$SAMOUT"; chmod 666 "$SAMOUT"
run() { sam sudo -n -u hone-release $LB "$@" >> "$SAMOUT" 2>&1; }
runo() { local o; o=$(sam sudo -n -u hone-release $LB "$@" 2>&1); RC=$?; printf '%s\n' "$o" >> "$SAMOUT"; OUT="$o"; }

# ---------------------------------------------------------------- 1. what sam can see and read
sl=$(sam sudo -n -l 2>&1)
printf '%s\n' "$sl" >> "$SAMOUT"
n=$(printf '%s\n' "$sl" | grep -c 'launcher')
echo "$sl" | grep -E 'NOPASSWD|launcher|Sorry|may run' | sed 's/^/       /'
[ "$n" -ge 3 ] && ! printf '%s\n' "$sl" | grep -Eq '\(ALL( : ALL)?\) +(NOPASSWD: +)?ALL$|\(root\)' && printf '%s' "$sl" | grep -q 'launcher apply' && printf '%s' "$sl" | grep -q 'launcher read-backups' && printf '%s' "$sl" | grep -q 'launcher status' && ok "sudo -l shows exactly the three launcher lines (as hone-release), nothing else, no ALL" || bad "sudo -l" "$sl"
for f in /var/lib/hone-release/secrets/db-password /var/lib/hone-release/secrets/read-pat /var/lib/hone-release/work/canary-db; do
  sam cat "$f" >/dev/null 2>&1 && bad "sam READ $f" || ok "sam cannot read $f"
done
sam ls /var/lib/hone-release >/dev/null 2>&1 && bad "sam can list /var/lib/hone-release" || ok "sam cannot list /var/lib/hone-release"
sam ls /var/lib/hone-release/secrets >/dev/null 2>&1 && bad "sam can list the secrets dir" || ok "sam cannot list the secrets directory"
sam find /var/lib/hone-release -type f >/dev/null 2>&1; [ -z "$(sam find /var/lib/hone-release -type f 2>/dev/null)" ] && ok "sam's find under /var/lib/hone-release finds nothing" || bad "find"

# ---------------------------------------------------------------- 2. what sam cannot modify
snap() { (cd /; find usr/local/libexec/hone-release etc/hone-release -type f -exec sha256sum {} + | sort; stat -c '%n %U %a' usr/local/libexec/hone-release usr/local/libexec/hone-release/scripts etc/hone-release usr/local/libexec/hone-release/launcher usr/local/libexec/hone-release/manifest) 2>&1; }
approve CUST-0001; snap > "$T/snap.before"
LX=/usr/local/libexec/hone-release
attempts=0; succ=0
tryw() { attempts=$((attempts+1)); if sam bash -c "$1" >/dev/null 2>&1; then succ=$((succ+1)); echo "       WRITE SUCCEEDED: $1"; fi; }
tryw "echo x >> $LX/launcher"; tryw "echo x >> $LX/manifest"; tryw "echo x >> $LX/scripts/release-apply.sh"; tryw "echo x >> $LX/scripts/status.sh"; tryw "echo x >> $LX/bin/supabase-go"
tryw "echo x > $LX/scripts/new.sh"; tryw "touch $LX/x"; tryw "rm -f $LX/manifest"; tryw "rm -f $LX/launcher"; tryw "mv $LX/scripts $LX/scripts.old"; tryw "mv $LX $LX.old"
tryw "ln -sf /bin/sh $LX/scripts/status.sh"; tryw "cp /bin/sh $LX/launcher"; tryw "chmod 777 $LX/launcher"
tryw "echo x >> /etc/hone-release/APPROVED-PACKAGE"; tryw "rm -f /etc/hone-release/APPROVED-PACKAGE"; tryw "echo ref > /etc/hone-release/PROJECT-REF"; tryw "touch /etc/hone-release/NEW"
tryw "echo x >> /etc/sudoers.d/hone-release"; tryw "mv /etc/hone-release /etc/hone-release.old"
tryw "echo x > /var/lib/hone-release/state/APPLY-STATE"; tryw "mkdir /var/lib/hone-release/state/consumed/FORGED"
snap > "$T/snap.after"
[ "$succ" = 0 ] && ok "all $attempts attempts by sam to write, replace, move, link, chmod or delete the launcher, manifest, scripts, supabase-go, approval, PROJECT-REF, sudoers and state FAILED" || bad "$succ of $attempts write attempts succeeded"
cmp -s "$T/snap.before" "$T/snap.after" && ok "the sha256 and owner/mode snapshot of the launcher, manifest, scripts, bin and approval is unchanged" || bad "snapshot changed" "$(diff "$T/snap.before" "$T/snap.after" | head -5)"

# ---------------------------------------------------------------- 3. nothing else can be run as hone-release (or root)
refuse() { local d="$1"; shift; local o; o=$(sam "$@" 2>&1); local rc=$?; printf '%s\n' "$o" >> "$SAMOUT"; if [ $rc -ne 0 ] && ! printf '%s' "$o" | grep -Eq 'uid=|root:|hone-release:'; then ok "refused: $d"; else bad "NOT refused: $d" "rc=$rc $o"; fi; }
refuse "sudo -u hone-release /bin/bash -c id" sudo -n -u hone-release /bin/bash -c id
refuse "sudo -u hone-release id" sudo -n -u hone-release id
refuse "sudo -u hone-release cat the secret" sudo -n -u hone-release cat /var/lib/hone-release/secrets/db-password
refuse "sudo -u root id" sudo -n -u root id
refuse "sudo id (as root)" sudo -n id
refuse "sudo -s" sudo -n -s
refuse "sudo -i" sudo -n -i
refuse "sudoedit a file" sudoedit /etc/hone-release/PROJECT-REF
refuse "sudoedit the launcher" sudoedit $LB
refuse "sudo -u hone-release launcher (no argument)" sudo -n -u hone-release $LB
refuse "launcher status extra" sudo -n -u hone-release $LB status extra
refuse "launcher apply --x" sudo -n -u hone-release $LB apply --x
refuse "launcher 'status;id'" sudo -n -u hone-release $LB 'status;id'
refuse "launcher STATUS" sudo -n -u hone-release $LB STATUS
refuse "launcher shell" sudo -n -u hone-release $LB shell
refuse "launcher ../scripts/status.sh" sudo -n -u hone-release $LB ../scripts/status.sh
refuse "launcher with a newline in the argument" sudo -n -u hone-release $LB $'status\nid'
refuse "the status script directly" sudo -n -u hone-release $LX/scripts/status.sh
sam cp $LB /tmp/launcher.copy 2>/dev/null; refuse "a copy of the launcher in /tmp" sudo -n -u hone-release /tmp/launcher.copy status
refuse "sudo -E" sudo -n -E -u hone-release $LB status
refuse "sudo -A / askpass form" sudo -A -u hone-release $LB status

# ---------------------------------------------------------------- 4. environment and path injection
cat > "$T/pre.c" <<'C'
#include <fcntl.h>
#include <unistd.h>
__attribute__((constructor)) static void f(void){ int fd=open("/tmp/hr-pwned-ld",O_CREAT|O_WRONLY,0666); if(fd>=0) close(fd); }
C
gcc -shared -fPIC -o "$T/pre.so" "$T/pre.c" 2>/dev/null && chmod 755 "$T/pre.so"
printf '#!/bin/sh\n: > /tmp/hr-pwned-bashenv\n' > "$T/bashenv.sh"; chmod 755 "$T/bashenv.sh"
mkdir -p "$T/evilbin"; printf '#!/bin/sh\n: > /tmp/hr-pwned-path\nexec /usr/bin/sha256sum "$@"\n' > "$T/evilbin/sha256sum"; chmod 755 "$T/evilbin/sha256sum"; for c in awk grep cat stat env id date; do cp "$T/evilbin/sha256sum" "$T/evilbin/$c"; done
rm -f /tmp/hr-pwned-*
sam LD_PRELOAD="$T/pre.so" BASH_ENV="$T/bashenv.sh" ENV="$T/bashenv.sh" PATH="$T/evilbin:/usr/bin:/bin" IFS=: sudo -n -u hone-release $LB status >> "$SAMOUT" 2>&1
[ ! -e /tmp/hr-pwned-ld ] && [ ! -e /tmp/hr-pwned-bashenv ] && [ ! -e /tmp/hr-pwned-path ] && ok "LD_PRELOAD, BASH_ENV, ENV, PATH and IFS in the caller's environment had NO effect (env_reset; none of the three planted payloads ran)" || bad "an injected payload RAN: $(ls /tmp/hr-pwned-* 2>/dev/null)"
for assign in "LD_PRELOAD=$T/pre.so" "BASH_ENV=$T/bashenv.sh" "PATH=$T/evilbin:/usr/bin" "ENV=$T/bashenv.sh"; do
  o=$(sam sudo -n -u hone-release "$assign" $LB status 2>&1); rc=$?; printf '%s\n' "$o" >> "$SAMOUT"
  [ $rc -ne 0 ] && ok "refused: VAR=value on the sudo command line ($(printf '%s' "$assign" | cut -d= -f1))" || bad "sudo accepted $assign" "$o"
done
[ ! -e /tmp/hr-pwned-ld ] && [ ! -e /tmp/hr-pwned-bashenv ] && [ ! -e /tmp/hr-pwned-path ] && ok "still none of the injected payloads ran" || bad "payload ran"

# ---------------------------------------------------------------- 5. the launcher's own refusals (root tampers, then restores)
run status; [ "$(sam sudo -n -u hone-release $LB status 2>&1 | head -1 | cut -c1-6)" = state: ] && ok "status runs (the baseline for the tamper cases)" || bad "status baseline" "$(sam sudo -n -u hone-release $LB status 2>&1 | head -3)"
cp -a $LX/manifest "$T/manifest.orig"; cp -a $LX/scripts/status.sh "$T/status.orig"; cp -a $LX/scripts/release-apply.sh "$T/apply.orig"
expect_refuse() { runo "$2"; if [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "$3"; then ok "launcher refuses: $1"; else bad "launcher did NOT refuse: $1" "rc=$RC $OUT"; fi; }
echo "# changed" >> $LX/scripts/status.sh
expect_refuse "a script whose sha256 is not in the manifest (the script was edited)" status "sha256 is not the manifest"
cp -a "$T/status.orig" $LX/scripts/status.sh
grep -v '^status ' $LX/manifest > "$T/m.tmp"; cp "$T/m.tmp" $LX/manifest
expect_refuse "an action that is not in the manifest (unlisted script)" status "not listed exactly once"
cp -a "$T/manifest.orig" $LX/manifest
sed -i 's/^status [0-9a-f]\{64\}/status 0000000000000000000000000000000000000000000000000000000000000000/' $LX/manifest
expect_refuse "a manifest sha256 that does not match the script" status "sha256 is not the manifest"
cp -a "$T/manifest.orig" $LX/manifest
chmod 664 $LX/scripts/status.sh; expect_refuse "a group-writable script" status "not root-owned and private"; chmod 755 $LX/scripts/status.sh
chmod 666 $LX/manifest; expect_refuse "a world-writable manifest" status "manifest or a parent"; chmod 644 $LX/manifest
chmod 775 $LX/scripts; expect_refuse "a group-writable scripts directory" status "not root-owned and private"; chmod 755 $LX/scripts
mv $LX/scripts/status.sh $LX/scripts/status.real; ln -s $LX/scripts/status.real $LX/scripts/status.sh
expect_refuse "a symlink as the script path" status "symlink"
rm $LX/scripts/status.sh; mv $LX/scripts/status.real $LX/scripts/status.sh
mv $LX/scripts $LX/scripts.real; ln -s $LX/scripts.real $LX/scripts
expect_refuse "a symlink as a directory in the script path" status "symlink"
rm $LX/scripts; mv $LX/scripts.real $LX/scripts
chown sam $LX/scripts/status.sh; expect_refuse "a script owned by a non-root user" status "not root-owned"; chown root:root $LX/scripts/status.sh
cmp -s "$T/manifest.orig" $LX/manifest && cmp -s "$T/status.orig" $LX/scripts/status.sh && ok "the tampered files were restored byte-identical" || bad "restore"
chown sam /var/lib/hone-release/secrets 2>/dev/null; expect_refuse "a secrets directory not owned by hone-release (apply)" apply "secrets directory is not owned"; chown hone-release /var/lib/hone-release/secrets
chmod 640 /var/lib/hone-release/secrets/db-password; expect_refuse "a secret file with mode 640" apply "secret file is not owned"; chmod 600 /var/lib/hone-release/secrets/db-password
mv /var/lib/hone-release/secrets/db-password /var/lib/hone-release/secrets/db-password.real; ln -s /etc/passwd /var/lib/hone-release/secrets/db-password
expect_refuse "a secret file that is a symlink" apply "missing or a symlink"; rm /var/lib/hone-release/secrets/db-password; mv /var/lib/hone-release/secrets/db-password.real /var/lib/hone-release/secrets/db-password

# ---------------------------------------------------------------- 6. package approval gates (all refuse BEFORE any CLI call, state stays clean)
: > $W/stub.log; chown hone-release:hone-release $W/stub.log; clear_state
nocall() { [ ! -s $W/stub.log ] && [ "$(state)" = none ]; }
rm -f /etc/hone-release/APPROVED-PACKAGE; expect_refuse "no APPROVED-PACKAGE record" apply "no APPROVED-PACKAGE"; nocall && ok "no CLI call, state clean" || bad "side effect"
approve CUST-EXP "2020-01-01T00:00:00Z"; expect_refuse "an expired approval" apply "expired"
approve CUST-SHA; cp /srv/hone-release-inbox/bundle.tar "$T/bundle.good"; sam bash -c "printf x >> /srv/hone-release-inbox/bundle.tar"
expect_refuse "a bundle changed by the agent after approval (sha256)" apply "bundle sha256 is not the approved"; sam cp "$T/bundle.good" /srv/hone-release-inbox/bundle.tar
cp /srv/hone-release-inbox/list.sha256 "$T/list.good"; sam bash -c "printf 'x' >> /srv/hone-release-inbox/list.sha256"
expect_refuse "a list changed by the agent after approval" apply "list sha256 is not the approved"; sam cp "$T/list.good" /srv/hone-release-inbox/list.sha256
sed -i "s/^head=.*/head=ffffffffffffffffffffffffffffffffffffffff/" /etc/hone-release/APPROVED-PACKAGE
expect_refuse "a bundle whose commit id is not the approved head" apply "not the approved head"
approve CUST-HEAD; sed -i '/^watchdog=/d' /etc/hone-release/APPROVED-PACKAGE; expect_refuse "an approval without the watchdog key" apply "lacks the key: watchdog"
approve CUST-WD; sed -i 's/^watchdog=.*/watchdog=required/' /etc/hone-release/APPROVED-PACKAGE; expect_refuse "an approval that claims the watchdog is required (not enforced by this script)" apply "not enforced by this script"
approve CUST-UNK; echo "extra=1" >> /etc/hone-release/APPROVED-PACKAGE; expect_refuse "an approval with an unknown key" apply "unknown key"
approve CUST-PWURL "$(in1h)" "postgresql://postgres.$REF:secret@127.0.0.1:54329/postgres?sslmode=require"; expect_refuse "a target_url carrying a password" apply "password-like"
approve CUST-6543 "$(in1h)" "postgresql://postgres.$REF@127.0.0.1:6543/postgres?sslmode=require"; expect_refuse "the transaction pooler port 6543" apply "6543"
approve CUST-NOTLS "$(in1h)" "postgresql://postgres.$REF@127.0.0.1:54329/postgres"; expect_refuse "a target_url that does not require TLS" apply "require TLS"
approve CUST-OTHERREF "$(in1h)" "postgresql://postgres.zzzzzzzzzzzzzzzzzzzz@127.0.0.1:54329/postgres?sslmode=require"; expect_refuse "a target_url naming another project" apply "approved project_ref"
approve CUST-LONG; sam truncate -s 100M /srv/hone-release-inbox/bundle.tar; expect_refuse "an oversized bundle in the inbox" apply "too large"; sam cp "$T/bundle.good" /srv/hone-release-inbox/bundle.tar
sam ln -sf /etc/passwd /srv/hone-release-inbox/list.sha256.link; sam mv -f /srv/hone-release-inbox/list.sha256.link /srv/hone-release-inbox/list.sha256
expect_refuse "an inbox file that is a symlink" apply "missing or a symlink"; sam cp "$T/list.good" /srv/hone-release-inbox/list.sha256 2>/dev/null || { rm -f /srv/hone-release-inbox/list.sha256; install -m 644 -o sam -g sam "$T/list.good" /srv/hone-release-inbox/list.sha256; }
nocall && ok "none of the approval refusals called the CLI or left a state" || bad "side effect after refusals" "stub.log: $(cat $W/stub.log | head -3); state $(state)"

# ---------------------------------------------------------------- 7. the happy path and secret routing
approve CUST-GOOD; : > $W/stub.log; chown hone-release:hone-release $W/stub.log; echo ok > $W/stub-mode
runo apply
if [ $RC = 0 ] && printf '%s' "$OUT" | grep -q "APPLIED: exactly 34" && [ "$(state | cut -d' ' -f1)" = APPLIED ] && [ -d /var/lib/hone-release/state/consumed/CUST-GOOD ]; then ok "apply with the approved package: 34 applied, state APPLIED, approval consumed"; else bad "happy apply" "rc=$RC $OUT"; fi
grep -q "PGPASSWORD matches the db canary" $W/stub.log && ok "the apply child received the database password (matches the canary) in PGPASSWORD" || bad "stub did not get PGPASSWORD"
ap_env=$(grep '^ENVNAMES' $W/stub.log | head -1)
printf '%s' "$ap_env" | grep -q SUPABASE_ACCESS_TOKEN && bad "the apply child's environment holds a token variable" || ok "the apply child's environment holds NO SUPABASE_ACCESS_TOKEN (the apply never sees the read token)"
grep -q "TOKEN absent" $W/stub.log && ok "the apply child saw no token at all" || bad "token visible to apply"
! grep -E "argv=.*($DBC|$PATC)" $W/stub.log >/dev/null && ok "no secret in the CLI's argv" || bad "secret in argv"
: > $W/stub.log; chown hone-release:hone-release $W/stub.log
runo read-backups
if [ $RC = 0 ] && printf '%s' "$OUT" | grep -q COMPLETED && grep -q "TOKEN matches the pat canary" $W/stub.log && grep -q "PGPASSWORD absent" $W/stub.log; then ok "read-backups: the child received the read token (matches) and NO database password"; else bad "read-backups routing" "rc=$RC $OUT / $(cat $W/stub.log)"; fi
! grep -E "argv=.*($DBC|$PATC)" $W/stub.log >/dev/null && ok "no secret in the read child's argv" || bad "secret in read argv"
runo apply; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -Eq "already used|consumed|expired|no APPROVED" && ok "a second apply with the same (consumed) approval is refused" || bad "second apply" "rc=$RC $OUT"
runo status; printf '%s' "$OUT" | grep -q "state: APPLIED" && ok "status reports the state without any secret" || bad "status" "$OUT"

# ---------------------------------------------------------------- 8. interruption, signals and unknown outcome
echo slow > $W/stub-mode; clear_state; approve CUST-SIG; : > $W/stub.log; chown hone-release:hone-release $W/stub.log
sam bash -c "sudo -n -u hone-release $LB apply > $T/out/sig.txt 2>&1; echo rc=\$? >> $T/out/sig.txt" &
for i in $(seq 1 60); do [ "$(state | cut -d' ' -f1)" = IN-FLIGHT ] && break; sleep 0.5; done
[ "$(state | cut -d' ' -f1)" = IN-FLIGHT ] && ok "during the push the durable state is IN-FLIGHT" || bad "no IN-FLIGHT marker" "$(state)"
SP=$(pgrep -x sudo | head -1)
HRPID=$(pgrep -u hone-release -f 'supabase-go|stub-supabase' | head -1); [ -z "$HRPID" ] && HRPID=$(pgrep -u hone-release | head -1)
sam cat /proc/$HRPID/environ >/dev/null 2>&1 && bad "sam read /proc/$HRPID/environ of a hone-release process" || ok "sam cannot read /proc/<pid>/environ of the running hone-release process"
sam ls /proc/$HRPID/fd >/dev/null 2>&1 && bad "sam listed /proc/$HRPID/fd" || ok "sam cannot list the open descriptors of the hone-release process"
for sg in INT TERM HUP; do runuser -u sam -- kill -$sg "$SP" 2>/dev/null; sleep 0.3; done
wait
sig_out=$(cat $T/out/sig.txt); printf '%s\n' "$sig_out" >> "$SAMOUT"
if grep -q "PUSH COMPLETED" $W/stub.log && [ "$(grep -c '^CALL.*Applying\|^CALL' $W/stub.log)" -ge 2 ] && [ "$(state | cut -d' ' -f1)" = APPLIED ]; then ok "SIGINT, SIGTERM and SIGHUP sent to sudo during the push did NOT tear it: the push ran to completion exactly once and the state ended APPLIED"; else bad "signal handling" "state $(state); $(cat $W/stub.log | tail -3); $sig_out"; fi
# an unclean death (the script is SIGKILLed, as by a crash or the OOM killer) leaves IN-FLIGHT and blocks the next run
echo slow > $W/stub-mode; clear_state; approve CUST-KILL; : > $W/stub.log; chown hone-release:hone-release $W/stub.log
sam bash -c "sudo -n -u hone-release $LB apply > $T/out/kill.txt 2>&1" &
for i in $(seq 1 60); do [ "$(state | cut -d' ' -f1)" = IN-FLIGHT ] && break; sleep 0.5; done
pkill -9 -u hone-release -f '/dev/fd/5' ; sleep 0.5
wait
[ "$(state | cut -d' ' -f1)" = IN-FLIGHT ] && ok "after the release script was SIGKILLed mid-push the state STAYS IN-FLIGHT (unknown outcome)" || bad "state after kill" "$(state)"
sleep 12
approve CUST-AFTERKILL; runo apply
[ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "UNKNOWN" && ok "the next apply refuses: the previous outcome is UNKNOWN, read back first; only root clears it" || bad "no refusal after unknown outcome" "rc=$RC $OUT"
sam bash -c "rm -f /var/lib/hone-release/state/APPLY-STATE" 2>/dev/null; [ "$(state | cut -d' ' -f1)" = IN-FLIGHT ] && ok "sam cannot clear the IN-FLIGHT marker" || bad "sam cleared the marker"
clear_state; echo ok > $W/stub-mode; runo apply; [ $RC = 0 ] && ok "after ROOT clears the state (and a fresh approval exists) the next apply proceeds" || bad "apply after root clear" "rc=$RC $OUT"
# authentication failure writes FAILED-LOGIN and blocks
clear_state; echo authfail > $W/stub-mode; approve CUST-AUTH; : > $W/stub.log; chown hone-release:hone-release $W/stub.log
runo apply; [ $RC -ne 0 ] && [ "$(state | cut -d' ' -f1)" = FAILED-LOGIN ] && ! printf '%s' "$OUT" | grep -q secretref && ok "an authentication failure in the dry run writes FAILED-LOGIN, masks the user and host, and made exactly one CLI call" || bad "authfail" "rc=$RC state=$(state) $OUT"
[ "$(grep -c '^CALL' $W/stub.log)" = 1 ] && ok "one CLI call only (no retry)" || bad "calls: $(grep -c '^CALL' $W/stub.log)"
approve CUST-AUTH2; runo apply; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "FAILED-LOGIN" && ok "the next run is refused while FAILED-LOGIN stands" || bad "after authfail" "$OUT"
clear_state; echo ok > $W/stub-mode

# ---------------------------------------------------------------- 9. nothing secret ever reached the agent's terminal
if grep -q -e "$DBC" -e "$PATC" "$SAMOUT" "$T"/out/*.txt 2>/dev/null; then bad "a canary secret appeared in sam's captured output"; else ok "no canary secret appears anywhere in $(wc -l < "$SAMOUT") lines of output the agent received"; fi
grep -rl -e "$DBC" -e "$PATC" /srv/hone-release-inbox /home/sam /etc/hone-release /usr/local/libexec/hone-release 2>/dev/null | head -1 | grep -q . && bad "a canary was found in a place the agent can read" || ok "no canary secret in the inbox, sam's home, /etc/hone-release or the libexec tree"

# ---------------------------------------------------------------- 10. THE RESIDUAL: docker and sudo group membership (what the VPS has today)
useradd -m -s /bin/bash agent2 2>/dev/null; usermod -aG docker agent2 2>/dev/null
IMG=$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -v '<none>' | head -1); [ -z "$IMG" ] && { docker pull -q ubuntu:22.04 >/dev/null 2>&1 && IMG=ubuntu:22.04; }
if [ -n "$IMG" ]; then
  o=$(runuser -u agent2 -- docker run --rm --entrypoint cat -v /var/lib/hone-release/secrets:/s:ro "$IMG" /s/db-password 2>&1)
  if printf '%s' "$o" | grep -q "$DBC"; then echo "RESIDUAL DEMONSTRATED - a user in the docker group READ the database-password canary through docker run -v (image $IMG). This is what group docker means on a host."; ok "residual shown: docker-group membership defeats the custody"; else echo "residual not reproduced here: $(printf '%s' "$o" | head -2)"; fi
else echo "SKIP - no docker image available to demonstrate the docker-group residual"; fi
sam id | grep -Eq 'docker|sudo' && bad "the design user sam is in the docker or sudo group" || ok "the design user sam is in NEITHER the docker nor the sudo group (this proof's premise)"
useradd -m -s /bin/bash agent3 2>/dev/null; usermod -aG sudo agent3 2>/dev/null
sl3=$(sudo -l -U agent3 2>&1 | tr '\n' ' ' | cut -c1-300); echo "       sudo -l -U <a user in group sudo>: $sl3"
printf '%s' "$sl3" | grep -Eq 'ALL' && echo "RESIDUAL DEMONSTRATED - a user in the sudo group has a general ALL rule on this host's default sudoers, so 'sudo -l shows only the launcher' would be FALSE for such a user, and a sudo password typed in that user's session gives root."
echo
echo "HEADLINE LIMIT: this custody holds ONLY IF the agent user is in neither the docker nor the sudo group. The current VPS user sam is in BOTH (id: uid=1000(sam) groups=sam,sudo(27),users(100),docker(988)). Removing sam from them, and moving the lanes' docker use elsewhere, is Sam's decision and blocks the custody claim."
echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ]
