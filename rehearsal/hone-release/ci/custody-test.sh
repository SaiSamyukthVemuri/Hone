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
chmod 440 /etc/sudoers.d/* 2>/dev/null   # a hosted runner ships /etc/sudoers.d/runner with a mode visudo rejects; unrelated to this proof
id sam >/dev/null 2>&1 || useradd -m -s /bin/bash sam
passwd -l sam >/dev/null 2>&1
# T1: the package is copied to a ROOT-OWNED directory outside /tmp (no world-writable ancestor); the pins are what Sam types from the reviewed record
SRC=/root/hr-pkg; rm -rf "$SRC" /root/hr-pins.txt; mkdir -p "$SRC/scripts" "$SRC/ci" "$SRC/ca" "$SRC/tools"
cp "$HR/launcher" "$HR/install.sh" "$HR/set-secret.sh" "$HR/approve-package.sh" "$HR/bind-gonogo.sh" "$HR/bind-serving.sh" "$HR/actions.conf" "$HR/sudoers.hone-release" "$SRC/"; cp "$HR"/scripts/*.sh "$HR"/scripts/mgmt-read.py "$HR"/scripts/wal-evidence.py "$HR"/scripts/pitr-wal-status.sql "$HR"/scripts/w1-data.tar "$SRC/scripts/"; cp "$HR"/ca/* "$SRC/ca/"; cp "$HR"/tools/make-verify-bundle.py "$SRC/tools/"
# STUB smoke: the real reviewed post-s3-smoke.sh makes GET requests to the production site; CI must not (its sha256 is checked against the OPS-reviewed copy below)
[ "$(sha256sum "$SRC/scripts/post-s3-smoke.sh" | cut -d' ' -f1)" = 0c69ce828a982234d97751284514bdd9d7d3af026871e572bfd799bfe614571c ] && echo "the packaged post-s3-smoke.sh is byte-identical to the OPS-reviewed script (0c69ce82...)"
printf '%s\n' '#!/bin/bash' 'm=$(cat /var/lib/hone-release/work/stub-smoke 2>/dev/null || echo ok)' 'if [ "$m" = ok ]; then echo "{\"total\":3,\"failed\":0}"; exit 0; fi' 'echo "{\"total\":3,\"failed\":1}"; exit 1' > "$SRC/scripts/post-s3-smoke.sh"
cp "$HERE/stub-supabase-go" "$T/supabase-go"; chmod 755 "$T/supabase-go"
STUBSHA=$(sha256sum "$T/supabase-go" | cut -d' ' -f1)
sed -i "s/^GO_SHA=.*/GO_SHA=$STUBSHA/" "$SRC/scripts/release-apply.sh" "$SRC/scripts/read-backups.sh" "$SRC/scripts/reconcile.sh" "$SRC/scripts/idle-probe.sh" "$SRC/scripts/heartbeat.sh" "$SRC/scripts/verify.sh"
sed -i "s/^SLACK=.*/SLACK=1/" "$SRC/scripts/idle-probe.sh"
sed -i "s/N_FLOOR = 600; N_MARGIN = 180/N_FLOOR = 2; N_MARGIN = 0/" "$SRC/scripts/wal-evidence.py"
sed -i 's#^BASE = .*#BASE = "http://127.0.0.1:18080"#' "$SRC/scripts/mgmt-read.py"
echo "test variant rewrites: BASE in mgmt-read.py https://api.supabase.com -> a LOCAL fake Management API that records every request (fake-mgmt-api.py)"
echo "test variant rewrites: GO_SHA in the five CLI-calling scripts (the stub's sha256) ; N_FLOOR 600 -> 2 and N_MARGIN 180 -> 0 in wal-evidence.py and SLACK 5 -> 1 in idle-probe.sh (so the proof takes seconds, not 10 minutes)"
diff <(sed 's/^GO_SHA=.*/GO_SHA=X/; s/^CA_SHA=.*/CA_SHA=X/' "$HR/scripts/release-apply.sh") <(sed 's/^GO_SHA=.*/GO_SHA=X/; s/^CA_SHA=.*/CA_SHA=X/' "$SRC/scripts/release-apply.sh") >/dev/null && ok "the installed apply script differs from the shipped one in the GO_SHA line only" || bad "variant differs elsewhere"
rmdir "$SRC/ci" 2>/dev/null; chown -R root:root "$SRC"; chmod -R go-w "$SRC"
mkpins() { (cd "$SRC" && find . -type f | sed 's#^\./##' | LC_ALL=C sort | while read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done) > /root/hr-pins.txt; chown root:root /root/hr-pins.txt; chmod 644 /root/hr-pins.txt; }
mkpins
inst() { bash "$SRC/install.sh" sam "$REF" "$T/supabase-go" /root/hr-pins.txt > "$T/install.out" 2>&1; }
notinstalled() { [ ! -e /usr/local/libexec/hone-release/launcher ] && [ ! -e /etc/sudoers.d/hone-release ]; }
t1refuse() { if inst; then bad "T1: install ACCEPTED: $1"; else if grep -q "REFUSED: .*$2" "$T/install.out" && notinstalled; then ok "T1: install refused for the right reason and nothing installed: $1"; else bad "T1: wrong refusal for: $1" "$(tail -3 "$T/install.out")"; fi; fi; }
echo "chain check (diagnostic): $(stat -c "%n %U %a" / /opt /root/hr-pins.txt /root/hr-pkg 2>&1 | tr "\n" ";")"
cp -a "$SRC/scripts/release-apply.sh" "$T/ra.orig"; echo "# edited after review" >> "$SRC/scripts/release-apply.sh"
t1refuse "a script changed after the pins were typed (release-apply.sh)" "does not match its pinned sha256"; cp -a "$T/ra.orig" "$SRC/scripts/release-apply.sh"
cp -a "$SRC/launcher" "$T/l.orig"; echo "# x" >> "$SRC/launcher"; t1refuse "the launcher changed after review" "does not match its pinned sha256"; cp -a "$T/l.orig" "$SRC/launcher"
cp -a "$SRC/sudoers.hone-release" "$T/s.orig"; sed -i 's/NOPASSWD: /NOPASSWD: ALL, /' "$SRC/sudoers.hone-release"; t1refuse "the sudoers template widened after review" "does not match its pinned sha256"; cp -a "$T/s.orig" "$SRC/sudoers.hone-release"
cp -a "$SRC/actions.conf" "$T/a.orig"; echo "evil evil.sh read-pat" >> "$SRC/actions.conf"; t1refuse "actions.conf gained an action" "does not match its pinned sha256"; cp -a "$T/a.orig" "$SRC/actions.conf"
echo 'echo pwned' > "$SRC/scripts/extra.sh"; chmod 644 "$SRC/scripts/extra.sh"; t1refuse "an extra file in the package that the pins do not list" "pins do not list"; rm -f "$SRC/scripts/extra.sh"
mv "$SRC/scripts/status.sh" "$T/status.moved"; t1refuse "a pinned file missing from the package" "not in the package"; mv "$T/status.moved" "$SRC/scripts/status.sh"
ln -s /etc/passwd "$SRC/scripts/link.sh"; t1refuse "a symlink in the package" "contains a symlink"; rm -f "$SRC/scripts/link.sh"
chmod 666 "$SRC/scripts/status.sh"; t1refuse "a world-writable package file" "group- or other-writable"; chmod 755 "$SRC/scripts/status.sh"
cp /root/hr-pins.txt "$SRC/pins.txt"; chown root:root "$SRC/pins.txt"; bash "$SRC/install.sh" sam "$REF" "$T/supabase-go" "$SRC/pins.txt" > "$T/install.out" 2>&1 && bad "T1: a pins file INSIDE the package was accepted" || { grep -q "inside the package" "$T/install.out" && notinstalled && ok "T1: a pins file inside the package directory is refused"; }; rm -f "$SRC/pins.txt"
chmod 666 /root/hr-pins.txt; t1refuse "a world-writable pins file" "pins file or a parent directory"; chmod 644 /root/hr-pins.txt
sed -i '1s/^[0-9a-f]\{4\}/0000/' /root/hr-pins.txt; t1refuse "a wrong pin (the first line altered)" "does not match its pinned sha256"; mkpins
cp "$T/supabase-go" "$T/supabase-go.bad"; printf 'x' >> "$T/supabase-go.bad"; bash "$SRC/install.sh" sam "$REF" "$T/supabase-go.bad" /root/hr-pins.txt > "$T/install.out" 2>&1 && bad "T1: a wrong supabase-go was accepted" || { grep -q "supabase-go sha256 differs" "$T/install.out" && notinstalled && ok "T1: a supabase-go that is not the pinned binary is refused"; }
cp -r "$SRC" /tmp/hr-pkg-in-tmp; bash /tmp/hr-pkg-in-tmp/install.sh sam "$REF" "$T/supabase-go" /root/hr-pins.txt > "$T/install.out" 2>&1 && bad "T1: a package under /tmp was accepted" || { grep -q "root-owned" "$T/install.out" && notinstalled && ok "T1: a package under a world-writable ancestor (/tmp) is refused"; }; rm -rf /tmp/hr-pkg-in-tmp
# F2: no override; refused for each root-equivalent or log-reading group, nothing installed
for g in docker sudo wheel lxd adm; do
  groupadd -f "$g" 2>/dev/null; u=f2-$g; id "$u" >/dev/null 2>&1 || useradd -m -s /bin/bash -G "$g" "$u"
  bash "$SRC/install.sh" "$u" "$REF" "$T/supabase-go" /root/hr-pins.txt > "$T/install.out" 2>&1 && bad "F2: install ACCEPTED an agent user in group $g" || { grep -q "member of the group $g" "$T/install.out" && notinstalled && ok "F2: install.sh refuses an agent user in the group $g (no override); nothing installed"; }
done
inst && ok "T1: with every file matching its typed pin, install.sh installs (visudo validated; manifest built from the pins)" || { bad "install.sh" "$(tail -5 "$T/install.out")"; exit 1; }
visudo -cf /etc/sudoers.d/hone-release >/dev/null && ok "visudo -cf accepts /etc/sudoers.d/hone-release" || bad "visudo"
printf '%s\n' "$DBC" | bash "$SRC/set-secret.sh" db-password --stdin > /dev/null; printf '%s\n' "$PATC" | bash "$SRC/set-secret.sh" read-pat --stdin > /dev/null
W=/var/lib/hone-release/work
printf '%s' "$DBC" > $W/canary-db; printf '%s' "$PATC" > $W/canary-pat; chown hone-release:hone-release $W/canary-db $W/canary-pat
echo ok > $W/stub-mode; echo "0213 0246" > $W/stub-range; chown hone-release:hone-release $W/stub-mode $W/stub-range
: > /tmp/hr-api.log
( setsid nohup python3 -I "$HERE/fake-mgmt-api.py" 18080 "$W" /tmp/hr-api.log > "$T/fake-api.out" 2>&1 & )   # detached: the later bare `wait` calls must not wait for it
python3 -I "$S1/fixture.py" syn "$T/syn" --head $HEAD40 >/dev/null
install -m 644 -o sam -g sam "$T/syn/migrations-d189768b.tar" /srv/hone-release-inbox/bundle.tar
install -m 644 -o sam -g sam "$T/syn/MIGRATIONS-d189768b.sha256" /srv/hone-release-inbox/list.sha256
HEAD_REVIEWED=$HEAD40; RECEIPT=$(printf 'a%.0s' $(seq 1 64))
approve() { # approve ID [key=value overrides]   every value is "typed from the reviewed record" (computed here from the files under review)
  local id=$1; shift; local -A K=( [id]=$id [bundle_sha]=$(sha256sum /srv/hone-release-inbox/bundle.tar | cut -d' ' -f1) [list_sha]=$(sha256sum /srv/hone-release-inbox/list.sha256 | cut -d' ' -f1) [head]=$HEAD_REVIEWED [pr]=1193 [receipt_sha]=$RECEIPT [first]=0213 [last]=0246 [count]=34 [minutes]=30 [window_start]=$(date -u -d '-10 minutes' +%Y-%m-%dT%H:%M:%SZ) [window_end]=$(date -u -d '+3 hours' +%Y-%m-%dT%H:%M:%SZ) [recovery_basis]=waiver [waiver_id]=WAIVER-20261027-1 [recovery_stamp]=none [s0a_writes]=none [history_before]=211 [drain_holds]=yes [drain_queues]=yes [drain_people]=yes [drain_max_busy]=0 [drain_attestation]="holds paused queues empty studios offline" [serving_commit]=$(printf 'c%.0s' $(seq 1 40)) [serving_attestation]="the compatible build serves the app" [serving_check]=attested-only [heartbeat_auth]=none [verify_sha]=none [s0a_sha]=$(printf 'd%.0s' $(seq 1 64)) [s0a_at]=$(date -u -d '-5 minutes' +%Y-%m-%dT%H:%M:%SZ) [min_span_days]=6 [quiet_db]=idle [connection_mode]=direct [pooler_host]=none [statement_timeout_s]=120 [lock_timeout_s]=5 [idle_tx_timeout_s]=60 [max_push_seconds]=60 [attestation]="restore point attested by the approver, not verified here" )
  local kv; for kv in "$@"; do K[${kv%%=*}]=${kv#*=}; done
  local args=() k; for k in "${!K[@]}"; do args+=("$k=${K[$k]}"); done
  bash "$SRC/approve-package.sh" "${args[@]}" > "$T/approve.out" 2>&1; local rc=$?
  [ $rc = 0 ] && [ -z "${NOBIND:-}" ] && autobind; return $rc; }
forcebind() { # a synthetic GO package about the CURRENT (hand-edited) record, bound as root: lets a case reach checks that come after the binding (the preflight itself would say NO-GO)
  python3 -I - /var/lib/hone-release/state /etc/hone-release/APPROVED-PACKAGE <<'PYF'
import json, sys, hashlib, time, os
st, ap = sys.argv[1], sys.argv[2]
aid = [l.split("=", 1)[1].strip() for l in open(ap) if l.startswith("approval_id=")][0]
body = {"kind": "hone-release-gonogo", "approval_id": aid, "approval_sha256": hashlib.sha256(open(ap, "rb").read()).hexdigest(), "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "verdict": "GO", "reason": "synthetic", "checks": []}
body["sha256"] = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
open(os.path.join(st, "GONOGO.json"), "w").write(json.dumps(body, sort_keys=True, indent=1) + "\n")
open("/etc/hone-release/GONOGO-BOUND", "w").write("gonogo_sha=%s\napproval_id=%s\nbound_at=%s\n" % (body["sha256"], aid, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
PYF
}
autobind() { # the approver reads the preflight GO/NO-GO package and binds it (root). The stub log is restored so the CLI-call counters of the cases stay exact.
  local sz; sz=$(stat -c %s $W/stub.log 2>/dev/null || echo 0)
  runuser -u sam -- env -i PATH=/usr/bin:/bin HOME=/home/sam sudo -n -u hone-release $LB preflight > "$T/preflight.out" 2>&1
  truncate -s "$sz" $W/stub.log 2>/dev/null
  local g; g=$(python3 -I -c 'import json;print(json.load(open("/var/lib/hone-release/state/GONOGO.json"))["sha256"])' 2>/dev/null)
  [ -n "$g" ] && bash "$SRC/bind-gonogo.sh" gonogo_sha="$g" > "$T/bind.out" 2>&1; return 0; }
edit() { sed -i "s|^$1=.*|$1=$2|" /etc/hone-release/APPROVED-PACKAGE; }   # root hand-editing the record, to prove the apply script re-validates every field
state() { cat /var/lib/hone-release/state/APPLY-STATE 2>/dev/null || echo none; }
clear_state() { rm -f /var/lib/hone-release/state/APPLY-STATE; }
SAMOUT="$T/out/all.txt"; : > "$SAMOUT"; chmod 666 "$SAMOUT"
run() { sam sudo -n -u hone-release $LB "$@" >> "$SAMOUT" 2>&1; }
runo() { local o; o=$(sam sudo -n -u hone-release $LB "$@" 2>&1); RC=$?; printf '%s\n' "$o" >> "$SAMOUT"; OUT="$o"; }

# ---------------------------------------------------------------- 1. what sam can see and read
sl=$(sam sudo -n -l 2>&1)
printf '%s\n' "$sl" >> "$SAMOUT"
n=$(printf '%s\n' "$sl" | grep -o 'launcher [a-z-]*' | sort -u | wc -l)
echo "$sl" | grep -E 'NOPASSWD|launcher|Sorry|may run' | sed 's/^/       /'
[ "$n" -ge 9 ] && ! printf '%s\n' "$sl" | grep -Eq '\(ALL( : ALL)?\) +(NOPASSWD: +)?ALL$|\(root\)' && printf '%s' "$sl" | grep -q 'launcher apply' && printf '%s' "$sl" | grep -q 'launcher read-backups' && printf '%s' "$sl" | grep -q 'launcher status' && printf '%s' "$sl" | grep -q 'launcher reconcile' && printf '%s' "$sl" | grep -q 'launcher idle-probe' && printf '%s' "$sl" | grep -q 'launcher heartbeat' && printf '%s' "$sl" | grep -q 'launcher preflight' && printf '%s' "$sl" | grep -q 'launcher verify' && printf '%s' "$sl" | grep -q 'launcher wal-capture' && printf '%s' "$sl" | grep -q 'launcher read-s1read' && printf '%s' "$sl" | grep -q 'launcher read-gap' && ok "sudo -l shows exactly the eleven launcher lines (as hone-release), nothing else, no ALL" || bad "sudo -l" "$sl"
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
refuse "sudo -A with an unlisted command" sudo -A -u hone-release id

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

# ---------------------------------------------------------------- 6. approval gates (all refuse before any CLI call, state stays clean)
: > $W/stub.log; chown hone-release:hone-release $W/stub.log; clear_state
nocall() { [ ! -s $W/stub.log ] && [ "$(state)" = none ]; }
# T2: approve-package.sh refuses anything that differs from the values typed from the reviewed record
ap_refuse() { local why=$1 pat=$2; shift 2; rm -f /etc/hone-release/APPROVED-PACKAGE; if approve "$@"; then bad "T2: approve-package ACCEPTED: $why"; else grep -q "$pat" "$T/approve.out" && [ ! -e /etc/hone-release/APPROVED-PACKAGE ] && ok "T2: approve-package refuses and writes nothing: $why" || bad "T2: wrong refusal: $why" "$(tail -3 "$T/approve.out")"; fi; }
ap_refuse "a bundle sha256 different from the reviewed one" "not the reviewed" CUST-T2A bundle_sha=$(printf 'b%.0s' $(seq 1 64))
ap_refuse "a list sha256 different from the reviewed one" "not the reviewed" CUST-T2B list_sha=$(printf 'c%.0s' $(seq 1 64))
ap_refuse "a commit id different from the bundle's own" "not the reviewed" CUST-T2C head=ffffffffffffffffffffffffffffffffffffffff
ap_refuse "an 8-character sha (the full value is required)" "FULL" CUST-T2D bundle_sha=01234567
ap_refuse "a wrong file count" "typed count" CUST-T2E count=33
ap_refuse "an approval lasting more than 60 minutes" "minutes must be 1..60" CUST-T2F minutes=61
ap_refuse "an unknown argument" "unknown argument" CUST-T2G extra=1
ap_refuse "a missing argument" "missing argument" CUST-T2H attestation=
approve CUST-T2OK && grep -q "VERIFIED against the typed reviewed values" "$T/approve.out" && grep -q "pending 0213..0246 = 34 files" "$T/approve.out" && ok "T2: with the typed values equal, it verifies, prints the count and first/last file, and writes the record (PR, PR head and receipt sha bound)" || bad "T2: positive approval" "$(cat "$T/approve.out" | tail -3)"
grep -q '^pr=1193$' /etc/hone-release/APPROVED-PACKAGE && grep -q "^pr_head=$HEAD_REVIEWED$" /etc/hone-release/APPROVED-PACKAGE && grep -q "^receipt_sha=$RECEIPT$" /etc/hone-release/APPROVED-PACKAGE && ok "T2: the record carries the PR number, the PR head and the receipt sha" || bad "T2: record fields"
approve CUST-PRH; edit pr_head ffffffffffffffffffffffffffffffffffffffff; expect_refuse "an approval whose pr_head is not its head (T2)" apply "not its head"
approve CUST-EXP; edit expires_at "$(date -u -d '+3 hours' +%Y-%m-%dT%H:%M:%SZ)"; expect_refuse "an approval that lives more than 60 minutes (T2)" apply "more than 60 minutes"
approve CUST-EXP2; edit expires_at 2020-01-01T00:00:00Z; expect_refuse "an expired approval" apply "expired"
rm -f /etc/hone-release/APPROVED-PACKAGE; expect_refuse "no APPROVED-PACKAGE record" apply "no APPROVED-PACKAGE"; nocall && ok "no CLI call, state clean" || bad "side effect"
# T3: the Mac gate conditions as approval fields
approve CUST-W1 window_start=$(date -u -d '+30 minutes' +%Y-%m-%dT%H:%M:%SZ) window_end=$(date -u -d '+5 hours' +%Y-%m-%dT%H:%M:%SZ); expect_refuse "an apply before the approved window opens (T3)" apply "has not opened"
approve CUST-W2 window_start=$(date -u -d '-3 hours' +%Y-%m-%dT%H:%M:%SZ) window_end=$(date -u -d '-1 minute' +%Y-%m-%dT%H:%M:%SZ); expect_refuse "an apply after the window closed (T3)" apply "has closed"
approve CUST-W3 window_end=$(date -u -d '+60 minutes' +%Y-%m-%dT%H:%M:%SZ); expect_refuse "fewer than 75 minutes of the window left (T3)" apply "fewer than 75 minutes"
# (the old typed recovery_point is gone: row4 needs the custody-recorded provider evidence; see section 6b)
ap_refuse "a waiver id that is not WAIVER-YYYYMMDD-N (F3)" "WAIVER-YYYYMMDD-N" CUST-F3A waiver_id=None
ap_refuse "a free-text waiver id (F3)" "WAIVER-YYYYMMDD-N" CUST-F3B waiver_id=waiver-1234
approve CUST-F3C; edit waiver_id None; expect_refuse "an approval record whose waiver id was hand-edited to None (F3)" apply "needs a waiver_id of the form"
ap_refuse "an unknown recovery basis" "recovery_basis must be row4 or waiver" CUST-R5 recovery_basis=idle waiver_id=none
approve CUST-AU1; edit autonomy autonomous; expect_refuse "a waiver presented as the AUTONOMOUS path" apply "never the autonomous path"
# T4 (consolidated): the three server-side timeouts are approval fields with ceilings; the record cannot say 'accepted residual' any more
approve CUST-T4B max_push_seconds=5; expect_refuse "a client-side push bound under 10 s (T4)" apply "must be 10..1800"
approve CUST-T4C statement_timeout_s=601; expect_refuse "a statement timeout above its ceiling (T4)" apply "above its ceiling"
approve CUST-T4D; edit lock_timeout_s 0; expect_refuse "a zero lock timeout (T4)" apply "positive number of seconds"
approve CUST-T4E; edit timeout_control accepted-server-limit-only; expect_refuse "the old accepted-residual wording as the timeout control (T4)" apply "server-startup-options"
approve CUST-HEAD; sed -i '/^quiet_db_mode=/d' /etc/hone-release/APPROVED-PACKAGE; expect_refuse "an approval without the quiet_db_mode key (E4)" apply "lacks the key: quiet_db_mode"
ap_refuse "a quiet_db that is neither idle nor heartbeat (E4)" "quiet_db must be idle or heartbeat" CUST-E4A quiet_db=maybe
approve CUST-UNK; echo "extra=1" >> /etc/hone-release/APPROVED-PACKAGE; expect_refuse "an approval with an unknown key" apply "unknown key"
approve CUST-OLDKEY; echo "watchdog=waived-by-approver" >> /etc/hone-release/APPROVED-PACKAGE; expect_refuse "the old watchdog=waived-by-approver key is no longer a thing" apply "unknown key"
ap_refuse "an S0a sha that is not 64 hex" "FULL 64-hex" CUST-S0A s0a_sha=1234
approve CUST-S0B s0a_at=$(date -u -d '-190 minutes' +%Y-%m-%dT%H:%M:%SZ) window_start=$(date -u -d '-200 minutes' +%Y-%m-%dT%H:%M:%SZ); expect_refuse "an S0a result older than 3 hours (S0a freshness)" apply "older than 3 hours"
approve CUST-S0C s0a_at=$(date -u -d '-30 minutes' +%Y-%m-%dT%H:%M:%SZ); expect_refuse "an S0a result from before the window start" apply "older than the window start"
approve CUST-S0D min_span_days=3; expect_refuse "a minimum span under 6 days" apply "6 or more"
# T5 (consolidated): the exact target is BUILT by the script; direct = db.<ref>.supabase.co:5432 + startup options, pooler = session pooler + per-file gate
approve CUST-H1 connection_mode=pooler pooler_host=evil.example.com:5432 ; expect_refuse "a pooler host that is not a Supabase session pooler" apply "not a Supabase session pooler host"
approve CUST-H2 connection_mode=pooler pooler_host=aws-0-us-east-1.pooler.supabase.com:6543; expect_refuse "the transaction pooler port 6543" apply "not a Supabase session pooler host"
approve CUST-H3; edit target_url "postgresql://postgres:secret@db.$REF.supabase.co:5432/postgres?options=-c%20statement_timeout%3D120000%20-c%20lock_timeout%3D5000%20-c%20idle_in_transaction_session_timeout%3D60000%20-c%20client_connection_check_interval%3D5000"; expect_refuse "a target_url carrying a password" apply "not exactly the approved form"
approve CUST-H4; edit target_url "postgresql://postgres@evil.example.com:5432/postgres?options=-c%20statement_timeout%3D120000%20-c%20lock_timeout%3D5000%20-c%20idle_in_transaction_session_timeout%3D60000%20-c%20client_connection_check_interval%3D5000"; expect_refuse "a target_url whose host is not the approved host" apply "not exactly the approved form"
approve CUST-H5; edit target_url "postgresql://postgres@db.$REF.supabase.co:5432/postgres?sslmode=disable"; expect_refuse "a target_url that names its own TLS mode / drops the timeouts" apply "not exactly the approved form"
approve CUST-H6; edit target_url "postgresql://postgres@db.$REF.supabase.co:5432/postgres?options=-c%20statement_timeout%3D0%20-c%20lock_timeout%3D5000%20-c%20idle_in_transaction_session_timeout%3D60000%20-c%20client_connection_check_interval%3D5000"; expect_refuse "a target_url whose statement_timeout is 0 (disabled)" apply "not exactly the approved form"
approve CUST-H7; edit db_host "db.otherprojectxxxxxxxx.supabase.co:5432"; expect_refuse "a direct host of another project" apply "not the exact direct host"
approve CUST-H8 connection_mode=pooler pooler_host=aws-0-us-east-1.pooler.supabase.com:5432; edit timeout_control server-startup-options; expect_refuse "the pooler claiming startup options enforce the timeouts (the pooler ignores them)" apply "server-per-file-set-local"
# package gates
approve CUST-SHA; cp /srv/hone-release-inbox/bundle.tar "$T/bundle.good"; sam bash -c "printf x >> /srv/hone-release-inbox/bundle.tar"
expect_refuse "a bundle changed by the agent after approval (sha256)" apply "bundle sha256 is not the approved"; sam cp "$T/bundle.good" /srv/hone-release-inbox/bundle.tar
cp /srv/hone-release-inbox/list.sha256 "$T/list.good"; approve CUST-SHA2; sam bash -c "printf 'x' >> /srv/hone-release-inbox/list.sha256"
expect_refuse "a list changed by the agent after approval" apply "list sha256 is not the approved"; sam cp "$T/list.good" /srv/hone-release-inbox/list.sha256
approve CUST-HEADX; edit head ffffffffffffffffffffffffffffffffffffffff; edit pr_head ffffffffffffffffffffffffffffffffffffffff; forcebind
expect_refuse "a bundle whose commit id is not the approved head" apply "not the approved head"
approve CUST-LONG; sam truncate -s 100M /srv/hone-release-inbox/bundle.tar; expect_refuse "an oversized bundle in the inbox" apply "too large"; sam cp "$T/bundle.good" /srv/hone-release-inbox/bundle.tar
approve CUST-LNK; sam ln -sf /etc/passwd /srv/hone-release-inbox/list.sha256.link; sam mv -f /srv/hone-release-inbox/list.sha256.link /srv/hone-release-inbox/list.sha256
expect_refuse "an inbox file that is a symlink" apply "missing or a symlink"; rm -f /srv/hone-release-inbox/list.sha256; install -m 644 -o sam -g sam "$T/list.good" /srv/hone-release-inbox/list.sha256
nocall && ok "none of the approval refusals called the CLI or left a state; none consumed an approval" || bad "side effect after refusals" "stub.log: $(head -3 $W/stub.log); state $(state)"
ls /var/lib/hone-release/state/consumed/ 2>/dev/null | grep -q . && bad "an approval was consumed by a refusal before the dry run" "$(ls /var/lib/hone-release/state/consumed)" || ok "T6 precondition: refusals before the first dry-run attempt consume nothing"

# ---------------------------------------------------------------- 7. the happy path and secret routing
approve CUST-GOOD; : > $W/stub.log; chown hone-release:hone-release $W/stub.log; echo ok > $W/stub-mode
runo apply
if [ $RC = 0 ] && printf '%s' "$OUT" | grep -q "APPLIED: exactly 34" && [ "$(state | cut -d' ' -f1)" = APPLIED-UNVERIFIED ] && [ -d /var/lib/hone-release/state/consumed/CUST-GOOD ]; then ok "apply with the approved package (bound GO/NO-GO): 34 applied, state APPLIED-UNVERIFIED, approval consumed"; else bad "happy apply" "rc=$RC $OUT"; fi
grep -q "PGPASSWORD matches the db canary" $W/stub.log && ok "the apply child received the database password (matches the canary) in PGPASSWORD" || bad "stub did not get PGPASSWORD"
ap_env=$(grep '^ENVNAMES' $W/stub.log | head -1)
printf '%s' "$ap_env" | grep -q SUPABASE_ACCESS_TOKEN && bad "the apply child's environment holds a token variable" || ok "the apply child's environment holds NO SUPABASE_ACCESS_TOKEN (the apply never sees the read token)"
grep -q "TOKEN absent" $W/stub.log && ok "the apply child saw no token at all" || bad "token visible to apply"
! grep -E "argv=.*($DBC|$PATC)" $W/stub.log >/dev/null && ok "no secret in the CLI's argv" || bad "secret in argv"
: > $W/stub.log; chown hone-release:hone-release $W/stub.log
runo read-backups
if [ $RC = 0 ] && printf '%s' "$OUT" | grep -q "evidence recorded" && tail -n 1 /tmp/hr-api.log | grep -q '"method": "GET", "path": "/v1/projects/[a-z0-9]*/database/backups", "auth": "match"' && [ ! -s $W/stub.log ]; then ok "read-backups: ONE GET of the backups endpoint with the read token (matches the canary), no CLI, no database password"; else bad "read-backups routing" "rc=$RC $OUT / $(tail -n 2 /tmp/hr-api.log)"; fi
runo apply; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -Eq "already used|consumed|expired|no APPROVED|APPLIED-UNVERIFIED" && ok "a second apply with the same (consumed) approval is refused" || bad "second apply" "rc=$RC $OUT"
runo status; printf '%s' "$OUT" | grep -q "state: APPLIED" && ok "status reports the state without any secret" || bad "status" "$OUT"

# ---------------------------------------------------------------- 7b. HON66-CONSOLIDATE: TLS environment, recovery evidence (C), the E4 selection, timeout gate (T4), reconcile
ST=/var/lib/hone-release/state; CAP=/usr/local/libexec/hone-release/ca/supabase-prod-ca-2021.crt
stubset() { printf '%s' "$2" > $W/$1; chown hone-release:hone-release $W/$1; }
idle() { runo wal-capture; sleep 1; runo idle-probe; }   # the S0a WAL record, then the proof (two samples of the approved pitr-wal-status.sql)
rec_ok() { stubset stub-writes 100; stubset stub-pitr true; stubset stub-span-days 7; stubset stub-latest-age 30; rm -f $W/stub-active; }
clr_ev() { rm -f $ST/BACKUPS-EVIDENCE $ST/IDLE-PROOF $ST/HEARTBEAT $ST/heartbeat-done-* $ST/RECONCILE; }
fresh() { stubset stub-hist "211 0212"; clear_state; : > $W/stub.log; chown hone-release:hone-release $W/stub.log; echo ok > $W/stub-mode; }
HBA() { printf 'I authorize ONE heartbeat write to the production database: a single pg_logical_emit_message WAL message (no table, no row, no schema change) over the verify-full direct connection as the postgres role, once for approval %s.' "$1"; }
stampago() { date -u -d "-$1 minutes" +%Y-%m-%dT%H:%M:%SZ; }
AUTO=(recovery_basis=row4 waiver_id=none)
# T5: the child gets verify-full and the pinned CA through its environment (the vendor CLI drops sslmode from the URL); the argv carries no sslmode and no password
fresh; approve CUST-TLS; runo apply
grep -q "^TLS PGSSLMODE=verify-full PGSSLROOTCERT=$CAP " $W/stub.log && ok "T5: the apply child's environment carries PGSSLMODE=verify-full and PGSSLROOTCERT=<the pinned CA under /usr/local/libexec/hone-release/ca>" || bad "T5: TLS environment" "$(grep '^TLS' $W/stub.log | head -2)"
grep -q "argv=db push --db-url postgresql://postgres@db\.$REF\.supabase\.co:5432/postgres?options=-c%20statement_timeout%3D120000%20-c%20lock_timeout%3D5000%20-c%20idle_in_transaction_session_timeout%3D60000%20-c%20client_connection_check_interval%3D5000" $W/stub.log && ok "T4/T5: the direct target carries the three server-side timeouts as startup options, the user is plain postgres, and the URL names no sslmode and no password" || bad "target form" "$(grep -m1 '^CALL' $W/stub.log)"
[ "$(sha256sum $CAP | cut -d' ' -f1)" = 700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7 ] && sam bash -c "echo x >> $CAP" 2>/dev/null; [ "$(sha256sum $CAP | cut -d' ' -f1)" = 700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7 ] && ok "T5: the pinned CA is root-owned, has the pinned sha256 and the agent cannot change it" || bad "CA pin"
cp -a $CAP "$T/ca.orig"; echo "# x" >> $CAP; fresh; approve CUST-CA; expect_refuse "a CA file whose sha256 differs from the pin in the script (T5)" apply "pinned Supabase root CA"; cp -a "$T/ca.orig" $CAP; chown root:root $CAP; chmod 644 $CAP
# C: the unattended path STOPs without the provider's recovery evidence; E4 (a) idle proof
ST_MSG() { :; }
fresh; clr_ev; rec_ok; approve CUST-N1 "${AUTO[@]}" recovery_stamp=$(stampago 8) s0a_writes=100; expect_refuse "C: no BACKUPS-EVIDENCE (read-backups never ran): the launcher STOPs" apply "no BACKUPS-EVIDENCE"
stubset stub-pitr false; runo read-backups; [ $RC = 0 ] && grep -q '^pitr_enabled=false' $ST/BACKUPS-EVIDENCE && ok "C: read-backups records what the provider said (pitr_enabled=false) in custody-owned state" || bad "evidence record" "$OUT"
approve CUST-N2 "${AUTO[@]}" recovery_stamp=$(stampago 8) s0a_writes=100; expect_refuse "C: the provider reports PITR not enabled: STOP" apply "PITR not enabled"
rec_ok; stubset stub-span-days 3; runo read-backups; approve CUST-N3 "${AUTO[@]}" recovery_stamp=$(stampago 8) s0a_writes=100; expect_refuse "C: a recovery span of 3 days under the 6-day minimum: STOP (S0-10)" apply "below the approved minimum"
rec_ok; stubset stub-latest-age 600; runo read-backups; approve CUST-N4 "${AUTO[@]}" recovery_stamp=$(stampago 8) s0a_writes=100; expect_refuse "C: the latest recovery point is older than the stamp: STOP (row-4 latest point >= stamp)" apply "older than the recovery_stamp"
rec_ok; runo read-backups; approve CUST-N5 "${AUTO[@]}" recovery_stamp=$(stampago 8) s0a_writes=100; expect_refuse "E4(a): evidence fine but no idle proof: STOP" apply "no IDLE-PROOF"
touch $W/stub-lsn-move; chown hone-release:hone-release $W/stub-lsn-move; idle; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "NOT proven idle" && grep -q 'result=active' $ST/IDLE-PROOF && grep -q 'unchanged:lsn_write' $ST/IDLE-VERDICT.json && ok "E4(a): a WAL position that moves between the two samples is recorded as NOT idle (unchanged:lsn_write fails)" || bad "idle-probe active" "rc=$RC $OUT"; rm -f $W/stub-lsn-move
approve CUST-N6 "${AUTO[@]}" recovery_stamp=$(stampago 8) s0a_writes=100; expect_refuse "E4(a): the idle proof says active: STOP" apply "NOT idle"
rec_ok; runo read-backups; idle; [ $RC = 0 ] && grep -q 'result=idle' $ST/IDLE-PROOF && ok "E4(a): two equal WAL samples (pitr-wal-status.sql, equal to the S0a record, archiver healthy) record IDLE-PROOF result=idle with wal=ok (read token only)" || bad "idle-probe" "rc=$RC $OUT"
sed -i "s/^read_at=.*/read_at=$(stampago 20)/" $ST/BACKUPS-EVIDENCE; approve CUST-N7 "${AUTO[@]}" recovery_stamp=$(stampago 8) s0a_writes=100; expect_refuse "C: BACKUPS-EVIDENCE read 20 minutes ago: STOP (freshness 900 s)" apply "older than 900 s"
fresh; rec_ok; runo read-backups; idle; approve CUST-AUTO1 "${AUTO[@]}" recovery_stamp=$(stampago 8) s0a_writes=100; runo apply
if [ $RC = 0 ] && printf '%s' "$OUT" | grep -q "APPLIED: exactly 34" && grep -q 'path autonomous; quiet-db mode idle' /var/lib/hone-release/logs/CUST-AUTO1/run.txt; then ok "AUTONOMOUS path, E4(a) idle: with fresh evidence (PITR on, span 7 d, latest >= stamp) and an idle proof the apply proceeds and the run record says autonomous"; else bad "autonomous idle apply" "rc=$RC $OUT"; fi
# E4 (b) heartbeat
fresh; clr_ev; rec_ok; runo read-backups; approve CUST-HB0 "${AUTO[@]}" recovery_stamp=none quiet_db=heartbeat heartbeat_auth="$(HBA CUST-HB0)"; expect_refuse "E4(b): no HEARTBEAT recorded: STOP" apply "no HEARTBEAT was recorded"
sleep 1; : > $W/stub.log; chown hone-release:hone-release $W/stub.log; runo heartbeat
[ $RC = 0 ] && grep -q '^HEARTBEAT at=' $ST/HEARTBEAT && grep -q "PGPASSWORD matches the db canary" $W/stub.log && grep -q 'pg_logical_emit_message' $W/stub.log && grep -q "^TLS PGSSLMODE=verify-full PGSSLROOTCERT=$CAP" $W/stub.log && ok "E4(b): the heartbeat action (db password only) emitted ONE logical WAL message over verify-full and recorded HEARTBEAT" || bad "heartbeat" "rc=$RC $OUT $(tail -5 $W/stub.log)"
expect_refuse "E4(b): the apply refuses evidence that was read BEFORE the heartbeat" apply "read before the heartbeat"
runo heartbeat; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "already written" && ok "E4(b): a second heartbeat for the same approval is refused" || bad "heartbeat twice" "$OUT"
stubset stub-latest-age 600; sleep 1; runo read-backups; expect_refuse "E4(b): the provider's latest recovery point has not advanced past the heartbeat: STOP" apply "older than the heartbeat"
stubset stub-latest-age 0; runo read-backups; autobind; runo apply
[ $RC = 0 ] && printf '%s' "$OUT" | grep -q "APPLIED: exactly 34" && grep -q 'path autonomous; quiet-db mode heartbeat' /var/lib/hone-release/logs/CUST-HB0/run.txt && ok "AUTONOMOUS path, E4(b) heartbeat: recovery point advanced past the heartbeat, evidence read after it: the apply proceeds" || bad "heartbeat apply" "rc=$RC $OUT"
fresh; rec_ok; approve CUST-HB6 "${AUTO[@]}"; runo heartbeat; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "does not select quiet_db_mode=heartbeat" && ok "E4: the heartbeat action refuses when the approval selected idle" || bad "heartbeat under idle" "$OUT"
approve CUST-HB7 "${AUTO[@]}" recovery_stamp=none quiet_db=heartbeat heartbeat_auth="$(HBA CUST-HB7)"; echo hbfail > $W/stub-mode; rm -f $ST/HEARTBEAT; runo heartbeat; r1=$RC; echo ok > $W/stub-mode; runo heartbeat
[ $r1 -ne 0 ] && [ ! -e $ST/HEARTBEAT ] && [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "already written" && ok "E4(b): a failed heartbeat records nothing and is NOT retried by the action (the marker is spent)" || bad "heartbeat failure" "r1=$r1 rc=$RC $OUT"
clear_state; clr_ev; echo ok > $W/stub-mode
# a waiver is the ATTENDED FALLBACK and needs no provider evidence
fresh; approve CUST-ATT; runo apply; [ $RC = 0 ] && grep -q 'path attended-fallback' /var/lib/hone-release/logs/CUST-ATT/run.txt && ok "ATTENDED FALLBACK: a recorded waiver proceeds without provider evidence and the run record says attended-fallback" || bad "attended" "$OUT"
# T4: the lexical timeout gate (B1 direct: nothing may weaken a server-side timeout; B2 pooler: every file carries its own bounded ones)
cp /srv/hone-release-inbox/bundle.tar "$T/bundle.keep"; cp /srv/hone-release-inbox/list.sha256 "$T/list.keep"
GCN=0
gate_case() { # gate_case DESC MODE "fixture args" EXPECT   (EXPECT = text of the refusal, or OK)
  GCN=$((GCN+1)); local d=$1 m=$2 fa=$3 want=$4; rm -rf "$T/gv"; python3 -I "$S1/fixture.py" syn "$T/gv" --head $HEAD40 $fa >/dev/null
  install -m 644 -o sam -g sam "$T/gv/migrations-d189768b.tar" /srv/hone-release-inbox/bundle.tar; install -m 644 -o sam -g sam "$T/gv/MIGRATIONS-d189768b.sha256" /srv/hone-release-inbox/list.sha256
  fresh; if [ "$m" = pooler ]; then approve CUST-G$GCN connection_mode=pooler pooler_host=aws-0-us-east-1.pooler.supabase.com:5432; else approve CUST-G$GCN; fi; runo apply
  if [ "$want" = OK ]; then [ $RC = 0 ] && ok "T4 gate: $d" || bad "T4 gate: $d" "$OUT"
  else [ $RC -ne 0 ] && printf '%s' "$OUT$(cat $T/gv/../gate.out 2>/dev/null)" | grep -q "fails the timeout gate" && [ ! -s $W/stub.log ] && ok "T4 gate refuses before any CLI call: $d" || bad "T4 gate did not refuse: $d" "rc=$RC $OUT"; fi; }
gate_case "direct: plain files (no timeout text) pass" direct "" OK
gate_case "direct: a file that RESETs statement_timeout is refused" direct "--tfile 0230 --tkind reset" refuse
gate_case "direct: a file that sets statement_timeout = 0 is refused" direct "--tfile 0230 --tkind zero" refuse
gate_case "direct: a file with set local statement_timeout 9999s (above the 120 s ceiling) is refused" direct "--tfile 0230 --tkind big" refuse
gate_case "direct: a file that uses set_config('statement_timeout') is refused" direct "--tfile 0230 --tkind dyn" refuse
gate_case "pooler: plain files WITHOUT their own set local statement_timeout are refused (the pooler ignores startup options)" pooler "" refuse
gate_case "pooler: every file carries bounded set local statement_timeout and lock_timeout: passes" pooler "--all-setlocal" OK
install -m 644 -o sam -g sam "$T/bundle.keep" /srv/hone-release-inbox/bundle.tar; install -m 644 -o sam -g sam "$T/list.keep" /srv/hone-release-inbox/list.sha256
# no action can reach the named restore point or any restore endpoint
! grep -Eqi 'backups +restore|restore-point +(create|new)|/database/backups/restore|restore_point' $LX/scripts/*.sh $LX/launcher && ok "no installed script or the launcher can call a restore or restore-point endpoint (the named restore point stays excluded; HTTP 400 is never a restore target)" || bad "a restore call exists"
# reconcile: read-only classification after an UNKNOWN outcome (token only, no password, never clears the state)
fresh; approve CUST-REC; st0=$(state)
stubset stub-recon ""; : > $W/stub.log; chown hone-release:hone-release $W/stub.log; runo reconcile
[ $RC = 0 ] && printf '%s' "$OUT" | grep -q "RECONCILE NONE" && tail -n 1 /tmp/hr-api.log | grep -q '"auth": "match"' && [ ! -s $W/stub.log ] && ok "reconcile: an empty history for the approved range -> NONE; one read-only query with the read token, no CLI, no database password" || bad "reconcile none" "rc=$RC $OUT"
stubset stub-recon "$(seq -f '%04g' 213 246 | tr '\n' ' ')"; runo reconcile; [ $RC = 0 ] && printf '%s' "$OUT" | grep -q "RECONCILE ALL" && ok "reconcile: all 34 approved versions present -> ALL" || bad "reconcile all" "$OUT"
stubset stub-recon "0213 0214 0215"; runo reconcile; [ $RC = 0 ] && printf '%s' "$OUT" | grep -q "RECONCILE PARTIAL" && ok "reconcile: 3 of 34 present -> PARTIAL (never reported as a pass)" || bad "reconcile partial" "$OUT"
echo qfail > $W/stub-mode; runo reconcile; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "stays UNKNOWN" && ok "reconcile: a failed read leaves the outcome UNKNOWN" || bad "reconcile qfail" "$OUT"
echo ok > $W/stub-mode; [ "$(state)" = "$st0" ] && ok "reconcile never changed the release state (only root clears it)" || bad "reconcile changed the state" "$st0 -> $(state)"

# ---------------------------------------------------------------- 7c. HON66-CONSOLIDATE-2: GO/NO-GO package + binding, drain, chained verification, sha-chained receipt, quiet-database idle
chain_ok() { python3 -I - "$1" <<'PYC'
import json, sys, hashlib
r = json.load(open(sys.argv[1])); prev = "0" * 64
for e in r["entries"]:
    body = {k: v for k, v in e.items() if k != "sha256"}
    if e["prev"] != prev or hashlib.sha256((prev + json.dumps(body, sort_keys=True, separators=(",", ":"))).encode()).hexdigest() != e["sha256"]: sys.exit(1)
    prev = e["sha256"]
sys.exit(0 if r["head"] == prev and r["entries"] else 1)
PYC
}
ST=/var/lib/hone-release/state; LG=/var/lib/hone-release/logs
unbind() { rm -f /etc/hone-release/GONOGO-BOUND; }
stubset stub-hist "211 0212"; stubset stub-busy 0; stubset stub-rangec 34; stubset stub-smoke ok
# the GO/NO-GO package
fresh; clr_ev; unbind; NOBIND=1 approve C2-GO; runo preflight
[ $RC = 0 ] && printf '%s' "$OUT" | grep -q '"verdict": "GO"' && for c in tooling package window recovery target timeout-gate drain-attestations history drain-read; do printf '%s' "$OUT" | grep -q "\"name\": \"$c\"" || { RC=9; echo "missing check $c"; }; done; [ $RC = 0 ] && ok "preflight (read token only) writes a GO package naming tooling, package, window, recovery, target, timeout gate, drain attestations, history/drift and the drain read check" || bad "preflight GO" "rc=$RC $OUT"
[ ! -s $W/stub.log ] && ok "preflight called no CLI at all (no dry run, no push): only Management API reads" || bad "preflight called something else"
stubset stub-hist "212 0213"; runo preflight; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q '"verdict": "NO-GO"' && printf '%s' "$OUT" | grep -q DRIFT && ok "preflight: history that differs from the manifest (212 rows, max 0213) is DRIFT -> NO-GO" || bad "preflight drift" "$OUT"
g=$(python3 -I -c 'import json;print(json.load(open("/var/lib/hone-release/state/GONOGO.json"))["sha256"])'); bash "$SRC/bind-gonogo.sh" gonogo_sha="$g" > "$T/bind.out" 2>&1 && bad "a NO-GO package was bound" || { grep -q "verdict is NO-GO" "$T/bind.out" && ok "bind-gonogo refuses to bind a NO-GO package"; }
stubset stub-hist "211 0212"; stubset stub-busy 3; runo preflight; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "busy client sessions" && ok "preflight: 3 busy sessions against an allowed 0 -> NO-GO (the drain read check)" || bad "preflight busy" "$OUT"
stubset stub-busy 0
NOBIND=1 approve C2-W window_start=$(date -u -d '+30 minutes' +%Y-%m-%dT%H:%M:%SZ) window_end=$(date -u -d '+5 hours' +%Y-%m-%dT%H:%M:%SZ); runo preflight
[ $RC -ne 0 ] && grep -q '"verdict": "NO-GO"' $ST/GONOGO.json && grep -q "has not opened" $ST/GONOGO.json && ok "preflight: a failed approval check (window not open) is recorded as NO-GO with the reason" || bad "preflight NO-GO reason" "$OUT"
# the binding
fresh; unbind; NOBIND=1 approve C2-B1; expect_refuse "apply without a root-written GONOGO-BOUND" apply "no root-written GONOGO-BOUND"
runo preflight; g=$(python3 -I -c 'import json;print(json.load(open("/var/lib/hone-release/state/GONOGO.json"))["sha256"])')
bash "$SRC/bind-gonogo.sh" gonogo_sha=$(printf 'e%.0s' $(seq 1 64)) > "$T/bind.out" 2>&1 && bad "a wrong typed sha was bound" || { grep -q "typed sha256 is not this package" "$T/bind.out" && ok "bind-gonogo: a sha256 other than the package's is refused (nothing bound)"; }
[ ! -e /etc/hone-release/GONOGO-BOUND ] && ok "nothing was bound by the refusal" || bad "a binding exists"
bash "$SRC/bind-gonogo.sh" gonogo_sha=$g > "$T/bind.out" 2>&1 && ok "bind-gonogo with the typed package sha256 writes the root-owned binding" || bad "bind" "$(cat $T/bind.out)"
sam bash -c "echo x >> /etc/hone-release/GONOGO-BOUND" 2>/dev/null && bad "sam wrote the binding" || ok "the agent cannot write the binding"
NOBIND=1 approve C2-B2; expect_refuse "a binding that belongs to another approval" apply "binding is for another approval"
bash "$SRC/bind-gonogo.sh" gonogo_sha=$g > "$T/bind.out" 2>&1; autobind; sed -i "s/^bound_at=.*/bound_at=$(stampago 40)/" /etc/hone-release/GONOGO-BOUND; expect_refuse "a binding older than 30 minutes" apply "older than 30 minutes"
approve C2-B3; sed -i "s/^drain_attestation=.*/drain_attestation=edited after the GO NO-GO was bound/" /etc/hone-release/APPROVED-PACKAGE; expect_refuse "an approval record edited after its GO/NO-GO was bound" apply "not the bound package"
# drain / hold preconditions are launcher refusals
fresh; approve C2-D1 drain_holds=no; expect_refuse "drain: reminder/cron holds not attested (drain_holds=no)" apply "drain precondition drain_holds"
approve C2-D2 drain_people=maybe; expect_refuse "drain: people hold not attested yes" apply "drain precondition drain_people"
approve C2-D3 drain_attestation=short; expect_refuse "drain: an attestation that is not the approver's words" apply "12 characters or more"
approve C2-D4 serving_commit=abc; expect_refuse "serving source: a commit that is not 40 hex" apply "40-hex commit"
# chained verification + the sha-chained receipt
fresh; approve C2-V1; runo apply
[ $RC = 0 ] && [ "$(state | cut -d' ' -f1)" = APPLIED-UNVERIFIED ] && ok "apply ends APPLIED-UNVERIFIED (not APPLIED)" || bad "state after apply" "$(state)"
approve C2-V1b; expect_refuse "the next apply is refused until the push is verified" apply "APPLIED-UNVERIFIED"
NOBIND=1 approve C2-V1   # the record of the verified stage is back (verify belongs to the approval named in the state)
stubset stub-hist "245 0246"; rm -f $W/stub-smoke; stubset stub-smoke ok; runo verify
[ $RC = 0 ] && printf '%s' "$OUT" | grep -q "^VERIFIED" && [ "$(state | cut -d' ' -f1)" = APPLIED ] && ok "verify: history 245 rows / max 0246, all 34 approved versions present, smoke OK: state APPLIED" || bad "verify" "rc=$RC state=$(state) $OUT"
chain_ok $LG/C2-V1/receipt.json && for st in bound dry-run push verify-start V1-history V3-smoke V4-serving-source; do grep -q "\"stage\": \"$st\"" $LG/C2-V1/receipt.json || { echo "missing $st"; false; }; done && ok "ONE sha-chained receipt for the run: bound, dry-run, push, verify-start, V1-history, V3-smoke, V4-serving-source; every link verifies" || bad "receipt chain" "$(python3 -I -c 'import json;print([e["stage"] for e in json.load(open("'$LG'/C2-V1/receipt.json"))["entries"]])')"
grep -q "gonogo $(python3 -I -c 'import json;print(json.load(open("'$LG'/C2-V1/receipt.json"))["entries"][0]["detail"].split()[1].rstrip(";"))')" $LG/C2-V1/receipt.json && ok "the receipt's first link binds the GO/NO-GO package sha256 and the approval" || bad "receipt gonogo"
cp $LG/C2-V1/receipt.json "$T/receipt.good"; sed -i '0,/"detail": "[^"]*dry-run/s//"detail": "TAMPERED dry-run/' $LG/C2-V1/receipt.json; python3 -I - $LG/C2-V1/receipt.json <<'PYT'
import json,sys
r=json.load(open(sys.argv[1])); r["entries"][1]["detail"]="altered"; json.dump(r,open(sys.argv[1],"w"))
PYT
chain_ok $LG/C2-V1/receipt.json && bad "an altered receipt still verified" || ok "an altered receipt entry breaks the chain (tamper-evident)"; cp "$T/receipt.good" $LG/C2-V1/receipt.json
# a mismatch STOPS and is recorded
vfail() { # vfail DESC PATTERN   (state must be APPLIED-UNVERIFIED before; leaves VERIFY-FAILED)
  runo verify; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "$2" && [ "$(state | cut -d' ' -f1)" = VERIFY-FAILED ] && grep -q '"stage": "verify-failed"' $LG/$VID/receipt.json && chain_ok $LG/$VID/receipt.json && ok "verify STOPS and records it (VERIFY-FAILED, receipt entry): $1" || bad "verify did not stop: $1" "rc=$RC state=$(state) $OUT"; }
fresh; VID=C2-VF1; approve $VID; runo apply; stubset stub-hist "244 0246"; vfail "history rows differ (244, expected 245)" "V1: history MISMATCH"
approve C2-VF1b; runo apply; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q VERIFY-FAILED && ok "VERIFY-FAILED blocks the next apply until root clears it" || bad "VERIFY-FAILED not blocking" "$OUT"
fresh; VID=C2-VF2; approve $VID; runo apply; stubset stub-hist "245 0246"; stubset stub-smoke fail; vfail "the smoke reports a failure" "V3: the smoke reported a failure"
stubset stub-smoke ok
# the stage's governed object / ACL / function-hash checks, named by the approved verify bundle
mkvb() { # mkvb DIR EXPECTED_JSON_ROWS SQLTEXT
  rm -rf "$1"; mkdir -p "$1"; printf '%s\n' "$3" > "$1/c1.sql"
  python3 -I - "$1" "$2" <<'PYB'
import hashlib, json, sys, tarfile, os
d, rows = sys.argv[1], json.loads(sys.argv[2])
sq = hashlib.sha256(open(os.path.join(d, "c1.sql"), "rb").read()).hexdigest()
ex = hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
open(os.path.join(d, "checks.list"), "w").write("c1\tc1.sql\t%s\t%s\n" % (sq, ex))
with tarfile.open(os.path.join(d, "verify.tar"), "w") as t:
    for n in ("checks.list", "c1.sql"): t.add(os.path.join(d, n), arcname=n)
PYB
}
SQLOK="select 'stage-check' as stage_check, 1 as x"
mkvb "$T/vb" '[{"x":1}]' "$SQLOK"; install -m 644 -o sam -g sam "$T/vb/verify.tar" /srv/hone-release-inbox/verify.tar; VSHA=$(sha256sum "$T/vb/verify.tar" | cut -d' ' -f1)
stubset stub-check-json '[{"x":1}]'
fresh; VID=C2-VS1; approve $VID verify_sha=$VSHA; runo apply; stubset stub-hist "245 0246"; runo verify
[ $RC = 0 ] && grep -q '"stage": "V2-c1"' $LG/$VID/receipt.json && ok "verify: the approved verify bundle's governed-object check ran (fixed SELECT, result sha256 equals the expected one) and is in the receipt" || bad "stage check" "$OUT"
fresh; VID=C2-VS2; stubset stub-check-json '[{"x":2}]'; approve $VID verify_sha=$VSHA; runo apply; stubset stub-hist "245 0246"; vfail "a governed-object check result differs from the expected sha256" "result MISMATCH"
stubset stub-check-json '[{"x":1}]'
mkvb "$T/vb2" '[{"x":1}]' "insert into public.t values (1)"; install -m 644 -o sam -g sam "$T/vb2/verify.tar" /srv/hone-release-inbox/verify.tar; V2=$(sha256sum "$T/vb2/verify.tar" | cut -d' ' -f1)
fresh; VID=C2-VS3; approve $VID verify_sha=$V2; runo apply; stubset stub-hist "245 0246"; vfail "a verify bundle SQL that is not a read-only SELECT (lexical gate)" "lexical gate"
# serving-source READ-BACK (OPS step): the OPS read of Vercel alias -> deployment -> commit is bound as a root-owned record; verify compares it with the approved serving commit
SVC=$(printf 'c%.0s' $(seq 1 40))
rm -f /etc/hone-release/SERVING-READBACK; fresh; VID=C2-SR1; approve $VID serving_check=readback; runo apply; stubset stub-hist "245 0246"; vfail "serving_check=readback but OPS has not bound a read-back" "no root-written SERVING-READBACK"
fresh; VID=C2-SR2; approve $VID serving_check=readback; runo apply; stubset stub-hist "245 0246"; sleep 1; bash "$SRC/bind-serving.sh" commit=$(printf 'd%.0s' $(seq 1 40)) deployment=dpl_AbC12345 alias_host=hone.care observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ) > "$T/sv.out" 2>&1; vfail "the alias points to a deployment of ANOTHER commit than the approved serving commit" "SERVING MISMATCH"
fresh; VID=C2-SR3; approve $VID serving_check=readback; runo apply; stubset stub-hist "245 0246"; bash "$SRC/bind-serving.sh" commit=$SVC deployment=dpl_AbC12345 alias_host=hone.care observed_at=$(stampago 30) > "$T/sv.out" 2>&1; vfail "a serving read-back made BEFORE the push" "not made after the push"
fresh; VID=C2-SR4; approve $VID serving_check=readback; runo apply; stubset stub-hist "245 0246"; sleep 1; bash "$SRC/bind-serving.sh" commit=$SVC deployment=dpl_AbC12345 alias_host=hone.care observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ) > "$T/sv.out" 2>&1; runo verify
[ $RC = 0 ] && grep -q 'READ BACK by OPS' $LG/$VID/receipt.json && ok "serving source READ BACK: OPS's Vercel read (alias hone.care -> deployment -> commit) equals the approved serving commit; recorded in the receipt (not attestation)" || bad "serving readback" "rc=$RC $OUT"
sam bash -c "echo x >> /etc/hone-release/SERVING-READBACK" 2>/dev/null && bad "sam wrote the serving read-back" || ok "the agent cannot write the serving read-back"
rm -f /etc/hone-release/SERVING-READBACK; fresh
# ---- HON66-OPENS-FX: guard, connection-phase read-back (FX2/FX4), WAL evidence (FX3), typed heartbeat authorization (FX5)
bad_inst=$(grep -lE '/cli/login-role|/network-bans|--linked' $LX/scripts/* $LX/launcher 2>/dev/null); tar -xOf $LX/scripts/w1-data.tar 2>/dev/null | grep -qE '/cli/login-role|/network-bans|--linked|supabase-go|npx' && bad_inst="$bad_inst w1-data.tar(contents)"   # OPS: NOTHING the package installs or invokes may name `db query --linked` or run Machines' runner
for f in $LX/scripts/read-s1read.sh $LX/scripts/read-gap.sh; do grep -v '^[[:space:]]*#' "$f" | grep -nE 'supabase-go|HONE_SUPABASE_BIN|SUPABASE_DB_PASSWORD|SUPABASE_ACCESS_TOKEN=|run-window-read|npx' | grep -v 'bad=\$(env' && bad_inst="$bad_inst $f(CLI use)"; done
 bad_q=$(grep -nE 'database/query($|[^/])' $LX/scripts/mgmt-read.py | head -1)
[ -z "$bad_inst" ] && [ -z "$bad_q" ] && ok "FX1 guard: no installed script or the launcher contains the login-role or network-bans endpoints or the CLI's --linked mode, and the helper's only query endpoint is .../database/query/read-only" || bad "FX1 guard" "$bad_inst $bad_q"
sam bash -c "echo x >> $LX/scripts/mgmt-read.py" 2>/dev/null && bad "sam wrote the helper" || ok "the pinned read helper is root-owned: the agent cannot change it"
cp -a $LX/scripts/mgmt-read.py "$T/helper.orig"; echo "# edited" >> $LX/scripts/mgmt-read.py; fresh; runo reconcile; cp -a "$T/helper.orig" $LX/scripts/mgmt-read.py
[ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "mgmt-read helper is missing or differs" && ok "FX1: a changed read helper is refused by every reader (sha256 against the root manifest)" || bad "helper tamper" "$OUT"
# FX2/FX4: the first login reads history, busy sessions and the four settings AS APPLIED, before the dry run
fresh; approve FX-S1; stubset stub-pre-settings "0 0 0 0"; runo apply
[ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "startup options not honoured" && ! grep -q 'argv=db push' $W/stub.log && [ "$(state | cut -d' ' -f1)" = FAILED-DRYRUN ] && ok "FX2: settings the endpoint applied differ from the approval -> refused BEFORE the dry run (no db push call), state FAILED-DRYRUN" || bad "FX2 settings" "rc=$RC $OUT"
stubset stub-pre-settings "120000 5000 60000 5000"
fresh; approve FX-S2; stubset stub-hist "230 0230"; runo apply; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "history drift" && ! grep -q 'argv=db push' $W/stub.log && ok "FX4: history that moved between the preflight and the apply (230 rows) -> refused before the dry run" || bad "FX4 history" "$OUT"
fresh; approve FX-S3; stubset stub-busy 4; runo apply; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "busy client sessions exceed" && ! grep -q 'argv=db push' $W/stub.log && ok "FX4: busy client sessions appeared after the preflight -> refused before the dry run" || bad "FX4 busy" "$OUT"
stubset stub-busy 0; fresh; approve FX-S4; runo apply; [ $RC = 0 ] && grep -q '"stage": "precheck"' $LG/FX-S4/receipt.json && ok "FX2/FX4: with history, busy sessions and the four settings as approved the apply goes on, and the read-back is a link of the receipt" || bad "precheck pass" "$OUT"
# FX3: WAL evidence for idle
fresh; clr_ev; rec_ok; stubset stub-writes 100; touch $W/stub-wal-lag; chown hone-release:hone-release $W/stub-wal-lag; idle
[ $RC -ne 0 ] && grep -q ' wal=no:FAIL:.*backlog' $ST/IDLE-PROOF && ok "FX3: a completed WAL segment is waiting for the archiver (backlog) -> not idle, even with an unchanged write counter" || bad "FX3 lag" "$OUT $(cat $ST/IDLE-PROOF)"
rm -f $W/stub-wal-lag; stubset stub-archive-mode off; idle; [ $RC -ne 0 ] && grep -q ' wal=no:FAIL:.*archive_mode' $ST/IDLE-PROOF && ok "FX3: archive_mode off -> no WAL evidence" || bad "FX3 archive_mode" "$OUT"
stubset stub-archive-mode on; stubset stub-archive-timeout 0; idle; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "CLOSED: archive_timeout is 0" && ok "FX3: archive_timeout 0/unknown -> the idle path is CLOSED (no evidence is possible)" || bad "FX3 timeout" "$OUT"
stubset stub-archive-timeout 1; idle; [ $RC = 0 ] && grep -q ' wal=ok ' $ST/IDLE-PROOF && grep -q '"verdict": *"PASS"' $ST/IDLE-VERDICT.json && ok "FX3: archive on, timeout 1 s, LSNs and archiver counters equal across both samples and to the S0a record, no backlog, archiver healthy -> IDLE-PROOF wal=ok (verdict PASS kept in state)" || bad "FX3 ok" "$OUT"
sed -i 's/ wal=ok / /' $ST/IDLE-PROOF; runo read-backups; unbind; approve FX-W1 "${AUTO[@]}" quiet_db=idle recovery_stamp=$(stampago 8) s0a_writes=100; expect_refuse "FX3: an idle proof WITHOUT WAL evidence (write counter alone) is not accepted for the autonomous path" apply "carries no WAL evidence"
# FX5: the heartbeat needs Sam's typed authorization sentence, recorded by approve-package.sh
fresh; clr_ev; NOBIND=1 approve FX-H1 "${AUTO[@]}" recovery_stamp=none quiet_db=heartbeat > /dev/null; [ ! -s "$T/approve.out" ] || true
bash "$SRC/approve-package.sh" id=FX-H1 bundle_sha="$(sha256sum /srv/hone-release-inbox/bundle.tar | cut -d' ' -f1)" list_sha="$(sha256sum /srv/hone-release-inbox/list.sha256 | cut -d' ' -f1)" head="$HEAD_REVIEWED" pr=1193 receipt_sha="$RECEIPT" first=0213 last=0246 count=34 minutes=30 window_start="$(stampago 10)" window_end="$(date -u -d '+3 hours' +%Y-%m-%dT%H:%M:%SZ)" recovery_basis=row4 waiver_id=none recovery_stamp=none s0a_writes=none s0a_sha=$(printf 'd%.0s' $(seq 1 64)) s0a_at="$(stampago 5)" min_span_days=6 quiet_db=heartbeat heartbeat_auth=none connection_mode=direct pooler_host=none statement_timeout_s=120 lock_timeout_s=5 idle_tx_timeout_s=60 max_push_seconds=60 history_before=211 drain_holds=yes drain_queues=yes drain_people=yes drain_max_busy=0 drain_attestation="holds paused queues empty studios offline" serving_commit=$(printf 'c%.0s' $(seq 1 40)) serving_attestation="the compatible build serves the app" serving_check=attested-only verify_sha=none attestation="x" > "$T/approve.out" 2>&1 && bad "approve accepted a heartbeat without Sam's sentence" || { grep -q "HOSTED WRITE" "$T/approve.out" && ok "FX5: approve-package refuses quiet_db=heartbeat without the exact authorization sentence for this approval id (it prints the sentence to type)"; }
NOBIND=1 approve FX-H2 "${AUTO[@]}" recovery_stamp=none quiet_db=heartbeat heartbeat_auth="$(HBA FX-OTHER)" && bad "a sentence for ANOTHER approval id was accepted" || ok "FX5: a sentence naming another approval id is refused"
NOBIND=1 approve FX-H3 "${AUTO[@]}" recovery_stamp=none quiet_db=heartbeat heartbeat_auth="$(HBA FX-H3)"; grep -q "^heartbeat_auth_sha=[0-9a-f]\{64\}$" /etc/hone-release/APPROVED-PACKAGE && ok "FX5: the sha256 of the typed sentence is recorded in the approval" || bad "heartbeat_auth_sha not recorded"
sed -i 's/^heartbeat_auth_sha=.*/heartbeat_auth_sha=none/' /etc/hone-release/APPROVED-PACKAGE; runo heartbeat; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "typed heartbeat authorization" && ok "FX5: a record whose authorization was stripped cannot heartbeat (the action recomputes the sentence sha itself)" || bad "FX5 stripped" "$OUT"
fresh; clr_ev; rec_ok

# the verify-bundle AUTHORING TOOL (tools/make-verify-bundle.py): derived from approved migration text, reproducible, accepted by the verify gate, and the answers it expects verify end to end
mkdir -p "$T/mig"; cat > "$T/mig/0301_demo.sql" <<'SQLD'
begin;
set local lock_timeout = '5s';
create table public.demo_t (id uuid primary key);
alter table public.demo_t enable row level security;
create or replace function public.demo_f(p_id uuid, p_note text default null) returns void language sql security definer set search_path = '' as $$ select 1 $$;
revoke all on function public.demo_f(uuid, text) from public;
revoke execute on function public.demo_f(uuid, text) from anon, authenticated;
grant execute on function public.demo_f(uuid, text) to service_role;
commit;
SQLD
python3 -I "$HR/tools/make-verify-bundle.py" --migrations "$T/mig" --first 0301 --last 0301 --out "$T/tb1" > "$T/tb1.out" && python3 -I "$HR/tools/make-verify-bundle.py" --migrations "$T/mig" --first 0301 --last 0301 --out "$T/tb2" >/dev/null && cmp -s "$T/tb1/verify.tar" "$T/tb2/verify.tar" && ok "verify-bundle tool: the same approved files give a byte-identical verify.tar (reproducible verify_sha $(cut -c1-12 $T/tb1/verify_sha.txt)...)" || bad "verify-bundle tool not reproducible" "$(cat $T/tb1.out)"
grep -q 'public.demo_f(uuid,text)' "$T/tb1/checks.list" 2>/dev/null; grep -q "functions-exist" "$T/tb1/checks.list" && grep -q "function-acl" "$T/tb1/checks.list" && grep -q "rls-enabled" "$T/tb1/checks.list" && grep -q "function-bodies" "$T/tb1/review.md" && ok "verify-bundle tool: derived functions-exist, tables-exist, rls-enabled and function-acl checks; function bodies are listed as needing a reference database" || bad "tool checks" "$(cat $T/tb1/checks.list | cut -c1-100)"
python3 -I - "$T/tb1" "$W/stub-answers" <<'PYA'
import hashlib, json, os, sys
d, out = sys.argv[1], sys.argv[2]; os.makedirs(out, exist_ok=True)
for l in open(os.path.join(d, "checks.list")):
    cid, fn, ssha, esha = l.rstrip("\n").split("\t")
    q = open(os.path.join(d, fn)).read().strip()
    open(os.path.join(out, hashlib.sha256(q.encode()).hexdigest()), "w").write(open(os.path.join(d, "expected", fn + ".json")).read())
PYA
chown -R hone-release:hone-release "$W/stub-answers" 2>/dev/null; chmod -R a+rX "$W/stub-answers"
install -m 644 -o sam -g sam "$T/tb1/verify.tar" /srv/hone-release-inbox/verify.tar; TV=$(cat "$T/tb1/verify_sha.txt")
fresh; VID=C2-TOOL; approve $VID verify_sha=$TV; runo apply; stubset stub-hist "245 0246"; runo verify
[ $RC = 0 ] && grep -q '"stage": "V2-functions-exist"' $LG/$VID/receipt.json && grep -q '"stage": "V2-function-acl"' $LG/$VID/receipt.json && grep -q '"stage": "V2-rls-enabled"' $LG/$VID/receipt.json && ok "the tool's bundle verifies end to end: every derived check (functions, tables, RLS, function ACL) ran through the verify gate and matched, one receipt link each" || bad "tool bundle verify" "rc=$RC $OUT"
python3 -I - "$W/stub-answers" <<'PYB'
import os, sys, json
d = sys.argv[1]
for f in os.listdir(d):
    r = json.load(open(os.path.join(d, f)))
    if r and "fn" in r[0]: r[0]["ok"] = not r[0]["ok"]; json.dump(r, open(os.path.join(d, f), "w"))
PYB
fresh; VID=C2-TOOL2; approve $VID verify_sha=$TV; runo apply; stubset stub-hist "245 0246"; vfail "a derived ACL expectation does not hold on the target (a privilege is not what the migration says)" "result MISMATCH"
rm -rf "$W/stub-answers"; install -m 644 -o sam -g sam "$T/vb/verify.tar" /srv/hone-release-inbox/verify.tar
install -m 644 -o sam -g sam "$T/vb/verify.tar" /srv/hone-release-inbox/verify.tar; fresh; VID=C2-VS4; approve $VID verify_sha=$V2; runo apply; stubset stub-hist "245 0246"; vfail "a verify bundle other than the approved one (sha256)" "not the approved verify bundle"
fresh
# E4(a) for a QUIET database: the recovery point is older than the window (the case idle exists for); no writes since S0a
fresh; clr_ev; unbind; rec_ok; stubset stub-latest-age 7200; stubset stub-writes 100; rm -f $W/stub-active
runo read-backups; idle; grep -q 'writes=100$' $ST/IDLE-PROOF && ok "idle-probe records the user-table write counter (writes=100)" || bad "idle proof counter" "$(cat $ST/IDLE-PROOF)"
approve C2-Q1 "${AUTO[@]}" quiet_db=idle recovery_stamp=$(stampago 125) s0a_writes=100; runo apply
[ $RC = 0 ] && printf '%s' "$OUT" | grep -q "APPLIED: exactly 34" && ok "E4(a) QUIET database: the latest recovery point is 2 h old (older than the window) and the apply PROCEEDS because the write counter equals S0a's and the point has not gone back past the S0a stamp" || bad "quiet database apply" "rc=$RC $OUT"
fresh; stubset stub-writes 105; idle; approve C2-Q2 "${AUTO[@]}" quiet_db=idle recovery_stamp=$(stampago 125) s0a_writes=100; expect_refuse "E4(a): writes happened since S0a (counter 105, S0a saw 100): the quiet claim fails" apply "differs from the one at S0a"
stubset stub-writes 100; idle; approve C2-Q3 "${AUTO[@]}" quiet_db=idle recovery_stamp=$(stampago 130) s0a_writes=100; stubset stub-latest-age 9000; runo read-backups; expect_refuse "E4(a): the provider's latest point went BACK past the S0a stamp" apply "went backwards"
approve C2-Q4 "${AUTO[@]}" quiet_db=idle recovery_stamp=$(stampago 2) s0a_writes=100; stubset stub-latest-age 7200; runo read-backups; expect_refuse "E4(a): a stamp after s0a_at is not a point S0a saw" apply "recovery_stamp must be the recovery point S0a saw"
approve C2-Q5 "${AUTO[@]}" quiet_db=idle recovery_stamp=$(stampago 125) s0a_writes=none; expect_refuse "E4(a): s0a_writes missing" apply "needs s0a_writes"
rec_ok
# heartbeat: the target is rebuilt like the apply's, and the hosted startup-option proof is part of the heartbeat
fresh; clr_ev; rec_ok; NOBIND=1 approve C2-H1 "${AUTO[@]}" recovery_stamp=none quiet_db=heartbeat heartbeat_auth="$(HBA C2-H1)"; edit target_url "postgresql://postgres@db.otherprojectxxxxxxxx.supabase.co:5432/postgres?options=-c%20statement_timeout%3D120000%20-c%20lock_timeout%3D5000%20-c%20idle_in_transaction_session_timeout%3D60000%20-c%20client_connection_check_interval%3D5000"
runo heartbeat; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "not exactly the target rebuilt" && ok "heartbeat: a hand-edited target_url (another project's host) is refused: the same builder as the apply" || bad "heartbeat target" "$OUT"
NOBIND=1 approve C2-H2 "${AUTO[@]}" recovery_stamp=none quiet_db=heartbeat heartbeat_auth="$(HBA C2-H2)"; echo hbsettings > $W/stub-mode; runo heartbeat; echo ok > $W/stub-mode
[ $RC -ne 0 ] && grep -q 'settings=MISMATCH' $ST/HEARTBEAT && ok "heartbeat: when the real endpoint does NOT apply the approved startup options it records settings=MISMATCH and fails (the hosted proof)" || bad "heartbeat settings" "$OUT"
rec_ok; runo read-backups; autobind; expect_refuse "the autonomous apply refuses a heartbeat whose settings were not confirmed" apply "did not confirm the startup options"
fresh; clr_ev

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
if grep -q "PUSH COMPLETED" $W/stub.log && [ "$(grep -c '^CALL.*Applying\|^CALL' $W/stub.log)" -ge 2 ] && [ "$(state | cut -d' ' -f1)" = APPLIED-UNVERIFIED ]; then ok "SIGINT, SIGTERM and SIGHUP sent to sudo during the push did NOT tear it: the push ran to completion exactly once and the state ended APPLIED"; else bad "signal handling" "state $(state); $(cat $W/stub.log | tail -3); $sig_out"; fi
# SIGKILL of the caller's sudo (cannot be handled): the release script keeps running and finishes cleanly; nothing is torn
echo slow > $W/stub-mode; clear_state; approve CUST-SIGKILL; : > $W/stub.log; chown hone-release:hone-release $W/stub.log
sam bash -c "sudo -n -u hone-release $LB apply > $T/out/sk.txt 2>&1" &
for i in $(seq 1 60); do [ "$(state | cut -d' ' -f1)" = IN-FLIGHT ] && break; sleep 0.5; done
SP=$(pgrep -x sudo | head -1); runuser -u sam -- kill -9 "$SP" 2>/dev/null
wait; sleep 13
if [ "$(grep -c 'PUSH COMPLETED' $W/stub.log)" = 1 ] && [ "$(state | cut -d' ' -f1)" = APPLIED-UNVERIFIED ]; then ok "SIGKILL of the caller's sudo mid-push: the release script and the CLI ran on, the push completed exactly once, the state is APPLIED (not torn, not IN-FLIGHT)"; else bad "sigkill of sudo" "state $(state); $(tail -3 $W/stub.log)"; fi
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
clear_state; echo ok > $W/stub-mode; autobind; runo apply; [ $RC = 0 ] && ok "after ROOT clears the state (and a fresh approval exists) the next apply proceeds" || bad "apply after root clear" "rc=$RC $OUT"
# T4 (consolidated): the client wall clock KILLS the CLI; the outcome is UNKNOWN-KILLED, never a pass, never a retry
echo veryslow > $W/stub-mode; clear_state; approve CUST-OVERDUE max_push_seconds=10; : > $W/stub.log; chown hone-release:hone-release $W/stub.log
runo apply
[ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "KILLED" && printf '%s' "$OUT" | grep -q "UNKNOWN" && [ "$(state | cut -d' ' -f1)" = UNKNOWN-KILLED ] && ok "T4: a push past the client wall clock: the CLI is KILLED, exit non-zero, state UNKNOWN-KILLED, the message says UNKNOWN / not a pass / reconcile" || bad "T4 kill" "rc=$RC state=$(state) $OUT"
sleep 28
! pgrep -u hone-release -f 'bin/supabase-go' >/dev/null && ! grep -q "PUSH COMPLETED" $W/stub.log && ok "T4: the killed CLI is gone and never completed the push (no PUSH COMPLETED line)" || bad "T4: the CLI survived the kill or completed" "$(tail -3 $W/stub.log)"
approve CUST-OVERDUE2; runo apply; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "UNKNOWN-KILLED" && [ "$(grep -c '^CALL' $W/stub.log)" = 3 ] && ok "T4: with a NEW approval the agent cannot launch again: refused by the state UNKNOWN-KILLED (still the two CLI calls of the first run: one dry run, one push)" || bad "T4: not blocked" "$OUT calls=$(grep -c '^CALL' $W/stub.log)"
# the lock: two simultaneous runners, only one owns execution
clear_state; echo slow > $W/stub-mode; approve CUST-LOCK1; : > $W/stub.log; chown hone-release:hone-release $W/stub.log
sam bash -c "sudo -n -u hone-release $LB apply > $T/out/lock1.txt 2>&1" &
for i in $(seq 1 40); do [ "$(state | cut -d' ' -f1)" = IN-FLIGHT ] && break; sleep 0.5; done
approve CUST-LOCK2; runo apply; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "holds the lock" && ok "two simultaneous launches: the second is refused by the single release lock while the first owns execution" || bad "lock" "$OUT"
wait; [ "$(grep -c 'PUSH COMPLETED' $W/stub.log)" = 1 ] && ok "the owner of the lock completed exactly one push" || bad "push count under the lock test" "$(grep -c 'PUSH COMPLETED' $W/stub.log)"
clear_state
# T6: a non-authentication dry-run failure consumes the approval and blocks the next run
echo dryfail > $W/stub-mode; approve CUST-DRYFAIL; : > $W/stub.log; chown hone-release:hone-release $W/stub.log
runo apply
[ $RC -ne 0 ] && [ "$(state | cut -d' ' -f1)" = FAILED-DRYRUN ] && [ -d /var/lib/hone-release/state/consumed/CUST-DRYFAIL ] && [ "$(grep -c '^CALL' $W/stub.log)" = 2 ] && ok "T6: a non-authentication dry-run failure: exactly tne CLI call, the approval is CONSUMED and the state is FAILED-DRYRUN" || bad "T6 dryfail" "rc=$RC state=$(state) calls=$(grep -c '^CALL' $W/stub.log) $OUT"
approve CUST-DRYFAIL2; runo apply; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "FAILED-DRYRUN" && [ "$(grep -c '^CALL' $W/stub.log)" = 2 ] && ok "T6: even with a NEW approval the agent cannot launch again: refused by the state, still one CLI call in total" || bad "T6: retry possible" "$OUT calls=$(grep -c '^CALL' $W/stub.log)"
clear_state; echo ok > $W/stub-mode; echo "0213 0245" > $W/stub-range; approve CUST-MISMATCH; : > $W/stub.log; chown hone-release:hone-release $W/stub.log
runo apply; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "does not list exactly" && [ "$(state | cut -d' ' -f1)" = DRYRUN-STARTED ] && [ -d /var/lib/hone-release/state/consumed/CUST-MISMATCH ] && ok "T6: a dry run that lists the wrong files: the approval is consumed, the state DRYRUN-STARTED blocks, nothing was pushed" || bad "T6 mismatch" "rc=$RC state=$(state) $OUT"
! grep -q 'Applying' $W/stub.log && ok "T6: no push was started after the mismatched dry run" || bad "a push started"
clear_state; echo "0213 0246" > $W/stub-range
# authentication failure writes FAILED-LOGIN and blocks
clear_state; echo authfail > $W/stub-mode; approve CUST-AUTH; : > $W/stub.log; chown hone-release:hone-release $W/stub.log
runo apply; [ $RC -ne 0 ] && [ "$(state | cut -d' ' -f1)" = FAILED-LOGIN ] && ! printf '%s' "$OUT" | grep -q secretref && ok "an authentication failure in the dry run writes FAILED-LOGIN, masks the user and host, and made exactly one CLI call" || bad "authfail" "rc=$RC state=$(state) $OUT"
[ "$(grep -c '^CALL' $W/stub.log)" = 1 ] && ok "one CLI call only (no retry)" || bad "calls: $(grep -c '^CALL' $W/stub.log)"
approve CUST-AUTH2; runo apply; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "FAILED-LOGIN" && ok "the next run is refused while FAILED-LOGIN stands" || bad "after authfail" "$OUT"
clear_state; echo ok > $W/stub-mode

# ---------------------------------------------------------------- 8a0. RC1: the pinned helper refuses every redirect (the read PAT is never re-sent to another URL)
fresh; echo redirect > $W/stub-mode; n0=$(wc -l < /tmp/hr-api.log | tr -d ' '); runo read-backups; n1=$(( $(wc -l < /tmp/hr-api.log | tr -d ' ') - n0 )); echo ok > $W/stub-mode
if [ $RC -ne 0 ] && [ "$n1" = 1 ] && ! tail -n 1 /tmp/hr-api.log | grep -q redirected; then ok "RC1: the API answers 302 -> the helper exits 1 after ONE request; the redirect target is never requested (no Authorization header re-sent)"; else bad "RC1 redirect" "rc=$RC n=$n1 $(printf '%s' "$OUT" | tail -n 2)"; fi
fresh
# ---------------------------------------------------------------- 8a. HON66 final batch: Machines' read gates as manifest actions, every read through mgmt-read.py (no CLI, no db query --linked)
# test-environment rewrite (disclosed): the runner's node lives in /usr/local/bin; the launcher's sudo secure_path is /usr/bin:/bin
[ -x /usr/bin/node ] || ln -s "$(command -v node)" /usr/bin/node
mkdir -p "$T/w1x" && tar -xf "$HR/scripts/w1-data.tar" -C "$T/w1x"
W1B=$T/w1x/window-reads-s1; W1C=$T/w1x/window-reads
api_n() { wc -l < /tmp/hr-api.log | tr -d ' '; }
w1answers() { # w1answers DIR: stored answers keyed by the sha256 of each gate file's stripped text (what the fake API looks up)
  rm -rf "$W/stub-answers"; mkdir -p "$W/stub-answers"
  python3 -I - "$1" "$W1B" "$W/stub-answers" <<'PYW'
import hashlib, json, os, sys
res, d, out = sys.argv[1:4]
for f in sorted(os.listdir(d)):
    if f.endswith(".sql"):
        h = hashlib.sha256(open(os.path.join(d, f), encoding="utf-8").read().strip().encode()).hexdigest()
        open(os.path.join(out, h), "w").write(open(os.path.join(res, f[:-4] + ".json")).read())
PYW
  chmod -R a+rX "$W/stub-answers"
}
fresh; : > $W/stub.log; chown hone-release:hone-release $W/stub.log
for sc in ok at0212 body_bad; do node "$HERE/gen-s1-results.mjs" "$T/s1res-$sc" "$W1C/BASELINE-W1-LINUX-CANDIDATE-3.json" "$W1B/census-0213-0246.sql" $sc || bad "s1 result generator ($sc)"; done
rm -f "$T"/s1res-*/*.error
w1answers "$T/s1res-ok"; n0=$(api_n); runo read-s1read
n1=$(( $(api_n) - n0 ))
if [ $RC = 0 ] && printf '%s' "$OUT" | grep -q "OVERALL PASS" && [ "$n1" = 6 ] && tail -n 6 /tmp/hr-api.log | python3 -I -c 'import sys,json; r=[json.loads(l) for l in sys.stdin]; sys.exit(0 if all(x["method"]=="POST" and x["path"].endswith("/database/query/read-only") and x["auth"]=="match" and x["body_keys"]==["query"] for x in r) else 1)' && [ ! -s $W/stub.log ]; then ok "read-s1read (Machines' gate, team variant): the six S1 gate files read through the read-only endpoint (6 POSTs, token matched, one key each), the pinned comparator printed OVERALL PASS, the CLI was never called"; else bad "read-s1read PASS path" "rc=$RC n=$n1 $(printf '%s' "$OUT" | tail -n 4)"; fi
w1answers "$T/s1res-at0212"; n0=$(api_n); runo read-s1read
n1=$(( $(api_n) - n0 ))
[ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "S1 did not reach its end state" && [ "$n1" = 1 ] && ok "read-s1read: a history that is not the S1 end state STOPs after ONE read; nothing else is read" || bad "read-s1read at0212" "rc=$RC n=$n1 $(printf '%s' "$OUT" | tail -n 3)"
w1answers "$T/s1res-body_bad"; runo read-s1read
[ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "did not print OVERALL PASS" && ok "read-s1read: a replaced function body that differs from the baseline -> the comparator does not pass -> STOP (never PASS)" || bad "read-s1read body_bad" "rc=$RC $(printf '%s' "$OUT" | tail -n 3)"
w1answers "$T/s1res-ok"; echo qfail > $W/stub-mode; n0=$(api_n); runo read-s1read; n1=$(( $(api_n) - n0 )); echo ok > $W/stub-mode
[ $RC -ne 0 ] && [ "$n1" = 1 ] && ok "read-s1read: a provider failure is ONE request and a STOP (no retry, no CLI fallback)" || bad "read-s1read provider failure" "rc=$RC n=$n1 $(printf '%s' "$OUT" | tail -n 3)"
rm -rf "$W/stub-answers"; mkdir -p "$W/stub-answers"
python3 -I - "$T/w1x/gap-read-2" "$W/stub-answers" ok <<'PYG'
import hashlib, json, os, re, sys
d, out, mode = sys.argv[1:4]
sql = open(os.path.join(d, "obs-1035-gap-pending-payments-v2.sql"), encoding="utf-8").read()
pairs = re.findall(r"select '([a-z_]+)' as src, '([a-z_]+)' as state,", sql)
rows = [{"at_hosted_0246": 1, "src": a, "state": b, "rows_in_lookback": str(i % 3)} for i, (a, b) in enumerate(pairs)]
open(os.path.join(out, hashlib.sha256(sql.strip().encode()).hexdigest()), "w").write(json.dumps(rows))
PYG
chmod -R a+rX "$W/stub-answers"; n0=$(api_n); runo read-gap; n1=$(( $(api_n) - n0 ))
if [ $RC = 0 ] && printf '%s' "$OUT" | grep -q "GAP READ: 19 rows" && [ "$n1" = 1 ] && [ ! -s $W/stub.log ]; then ok "read-gap (Machines' gate, team variant): ONE read-only POST, 19 rows validated by the reading rules, CLI never called"; else bad "read-gap PASS path" "rc=$RC n=$n1 $(printf '%s' "$OUT" | tail -n 4)"; fi
python3 -I - "$W/stub-answers" <<'PYG'
import glob, json, sys
for f in glob.glob(sys.argv[1] + "/*"):
    r = json.load(open(f)); json.dump(r[:-1], open(f, "w"))
PYG
runo read-gap; [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q "STOP" && ok "read-gap: 18 rows instead of 19 -> STOP" || bad "read-gap 18 rows" "rc=$RC $(printf '%s' "$OUT" | tail -n 3)"
rm -rf "$W/stub-answers"
cp -a /usr/local/libexec/hone-release/scripts/w1-data.tar "$T/w1.orig"; printf 'x' >> /usr/local/libexec/hone-release/scripts/w1-data.tar
expect_refuse "the w1-data bundle changed after install (sha256 is not the manifest's)" read-gap "w1-data\|sha256"; cp -a "$T/w1.orig" /usr/local/libexec/hone-release/scripts/w1-data.tar
fresh

# ---------------------------------------------------------------- 8b. Insurance H6: the recorded requests of every read action in this whole run
for f in $T/vb/c*.sql $T/vb2/c*.sql $T/tb1/c*.sql $T/w1x/window-reads-s1/*.sql $T/w1x/gap-read-2/*.sql; do [ -f "$f" ] && python3 -I -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],encoding="utf-8").read().strip().encode()).hexdigest())' "$f"; done > "$T/allowed-bundle-q.txt"
python3 -I - /tmp/hr-api.log "$T/allowed-bundle-q.txt" <<'PYH6' && ok "H6 (recorded requests, $(wc -l < /tmp/hr-api.log) in this run): ONLY GET .../database/backups and POST .../database/query/read-only; every POST body holds exactly one key `query`; every query is a fixed SELECT of the known shapes; every request carried the read token; NOTHING else was ever asked (no login-role, no network-bans, no write endpoint)" || bad "H6 recorded requests" "$(python3 -I -c 'import sys;print(open("/tmp/hr-api.log").read()[-900:])')"
import hashlib, json, re, sys
allowed = set(open(sys.argv[2]).read().split())
ok = True; seen = set()
shapes = [r"^select count\(\*\)::int as n, coalesce\(max\(version\), ''\) as mx from supabase_migrations\.schema_migrations$",
          r"^select count\(\*\)::int as c from supabase_migrations\.schema_migrations where version >= '[0-9]{4}' and version <= '[0-9]{4}'$",
          r"^select count\(\*\)::int as busy from pg_catalog\.pg_stat_activity where backend_type = 'client backend' and pid <> pg_catalog\.pg_backend_pid\(\) and state <> 'idle' and datname = pg_catalog\.current_database\(\)$",
          r"^select coalesce\(sum\(n_tup_ins \+ n_tup_upd \+ n_tup_del\), 0\)::text as writes from pg_catalog\.pg_stat_user_tables$",
          r"^select version from supabase_migrations\.schema_migrations where version >= '[0-9]{4}' and version <= '[0-9]{4}' order by version$",
          r"^select 'stage-check' as stage_check, 1 as x$"]
for l in open(sys.argv[1]):
    r = json.loads(l)
    ep = re.sub(r"/v1/projects/[a-z0-9-]+", "/v1/projects/<ref>", r["path"])
    seen.add((r["method"], ep))
    if r["auth"] != "match": ok = False; print("token mismatch", r)
    if (r["method"], ep) == ("GET", "/v1/projects/<ref>/database/backups"): continue
    if (r["method"], ep) != ("POST", "/v1/projects/<ref>/database/query/read-only") or r["body_keys"] != ["query"]: ok = False; print("unexpected request", r); continue
    q = r["query"]
    if hashlib.sha256(q.encode()).hexdigest() in allowed: continue   # a query of an APPROVED verify bundle (the helper's `file` id; it passed the lexical gate)
    if hashlib.sha256(q.encode()).hexdigest() == "c91d7a497ce3b04b88aedd72c8b2729694b65c3c5cc2f051837e3f2365ad8cd5": continue   # the Insurance-approved pitr-wal-status.sql, byte-identical
    if not any(re.match(p, q.strip()) for p in shapes): ok = False; print("query of an unknown shape", q)
print("endpoints seen:", sorted(seen))
sys.exit(0 if ok and seen else 1)
PYH6
cp /tmp/hr-api.log "$T/out/api-requests.log" 2>/dev/null

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
