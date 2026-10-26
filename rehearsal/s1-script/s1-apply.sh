#!/bin/bash
# Hone #1035 S1 (row 4): apply migrations 0213..0246 (34 files) to the hosted project through the SESSION POOLER, with the
# vendor supabase-go (dce26b75) and ONLY the migration bundle committed at d189768b. ONE dry run, then ONE push.
# Fail-closed: the first failed check, refusal, authentication error or unexpected output stops. No step is retried.
# Nothing here creates a login role, resets a password or unbans an IP. PREVENTION: --db-url never reaches those code
# paths in CLI v2.102.0, and the database password is always present. The log scan below is only a detector after the
# fact (a hit must be REPORTED, never retried). The password is typed with read -rs from /dev/tty, never echoed, never
# on a command line, never written, and handed only to the one CLI child that needs it.
# Exit 0 ONLY after the push log shows exactly 34 "Applying migration" lines in order, then "Finished supabase db push.",
# and the CLI exited 0. That does NOT replace the read-back (history = 245 rows, max 0246) and the post-S1 checks.
set -u
umask 077

ROOT="$HOME/hone-s1"
BIN="$ROOT/supabase-cli/supabase-go"
GO_SHA=dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b
BUNDLE=migrations-d189768b.tar
BUNDLE_SHA=599adf08712f6c702f5921ee54f7a83c653ee9faba60604d501aba7af841527b
LIST=MIGRATIONS-d189768b.sha256
LIST_SHA=513035041c76717b5f8df1e2133cf2951c1b03c58d0cde5ce1e5dcdf5492c069
REF=alhhybgqdmcdyzpybykj
URL="postgresql://postgres.$REF@aws-1-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"
HEAD_SHA=d189768b86fe1c53e330c65078f3a9f2949f8e59
H0214=a8bdcefe7b01216e986838fe336a9eb3613b6e892bd8de2c101cdd4e2f03751b
NFILES=245
MAXV=246

# The 34 pending files and their sha256, from the GO package (FINAL-GO-PACKAGE-1035 section B; 0214 = a8bdcefe).
#GO34-BEGIN
GO34='5186bca250713e8db8eb17dc6a354202f98ea00388d489fb9f7d74d93c960d2b  0213_platform_lead_alerts.sql
a8bdcefe7b01216e986838fe336a9eb3613b6e892bd8de2c101cdd4e2f03751b  0214_studio_payment_jurisdiction.sql
612f98fe62b9bb7113e32956a46eaeab07238fbf94cb305f6c1ab6ddaa2ec168  0215_delivery_incidents.sql
1039bd49ab49849f2e0632aa896961572b4598ab46786fa194866730de10563e  0216_receptionist_membership_foundation.sql
beda95b6594c01da4f5b1eb9d52bbd5838991a51526874cfac41e18f9ccbb1f6  0217_studio_sms_sender_registrations.sql
58ad44c705797f3d5c48b9cea1fadcef2da23ab46a41ec41cc67ea7dcf0c3a7a  0218_receptionist_invitations.sql
4d44fc6603301ad1b94d7af9ecd56f1d28cd798742271bd6b1b0cd25b3bd69fe  0219_public_practitioner_selection.sql
329d70744996abe73a24c836e87e10bd842e9ba9f124940f9c95a5338fa4b0e2  0220_receptionist_scheduling.sql
b881fa9052edabee0af3140ee8b7e09108b2013b16268dce894003f5bec4e19a  0221_delivery_concerns_and_purposes.sql
9d85ba09f8ddcd308848a5c8711b7e8da5b58e7c707f040a6b69cf0333a6b798  0222_public_practitioner_booking_command.sql
12038b1eab95d84f0ed84b235f0bf00641f6e06007e6ba5008066fc0d852b948  0223_machine_inventory_and_setup_readings.sql
761a76fbb04adc03f13b82d1e7e22594d688a7ba9d7bf53ae6fe742f83003246  0224_us_settlement_method_guard.sql
61d69c6f50ea66963298ff44ad27f21a8cef640e81f1f428b9c778d29a5892ab  0225_public_new_client_practitioner_selection.sql
1ee108d11c2ce3ffe7bcd7baa9a44082c6c6d5369bfb7f3ca1d80489fd9ca0e4  0226_studio_sms_sender_unpurchased_release.sql
8b62d4d8b9c32608a0d2c9884184752068c64679eab2f913b04de9ba3a7e0313  0227_email_receipt_quarantine_bound.sql
0d43f23e16ec67a54cbe7df98e5c1a09f66321149ded4f43062fd2baae4841a3  0228_legacy_new_client_refusal_atomicity.sql
fe1499a590a90ad13597627c186010aaf0a486be7e2c3890cd31264d97d96f86  0229_studio_sms_sender_campaign_bindings.sql
6fd46332f04a463890350041005626ffc7977751fd2e6c976c5530a8812aceaa  0230_studio_sms_sender_stop_preflights.sql
b9ad60aa947cb63a8f4b8c1c5dd273d03d6f58dbaa1bdb8dba895cfce1bcddf1  0231_client_identification_portrait.sql
d58a05a21bb0de0a7cab8ac84ed936aa269634d6dc6b2c735760f291d2f526d4  0232_treatment_image_capture_stage.sql
2f2844fd92ff5ad744757ad8955ad238d79a99ceac9c25b5c5d77d864ab8621c  0233_clinical_records_audit_command.sql
41af062c7c44d647589fc98fc5fc7b5956812a6b696be1bc57efad12d7f9633f  0234_client_self_service_controls.sql
2161c333016c28ddf473b05dae31c57674dc41fa8f18373b75d58ce7ee15fbb2  0235_machine_finite_readings.sql
b83747ac1b86f54b8633571bd72ec732d904b0acf6bd1d073bc93f50b4c30060  0236_delivery_incident_retained_failures.sql
e565db62660ad237fa8b8541a2e021d9d755a8b7fb89492d436c251979db24e2  0237_machine_native_text_readings.sql
716e833ecafd1b82d20edda7aca76d88c59f294548e5c27a3abaa4ea6f9d251a  0238_stripe_account_country_alert.sql
85a59bb59e6686d571043b290fa7c502729537d3be5afb65df10aff71914810a  0239_bound_payment_event_reconciliation.sql
129f5e77b41de437e03a198c8947f8e86398b397f61e63e1c2db34d5acfbb89f  0240_provider_refund_status.sql
39aa9596f97717c8e153267da62e8cbb0da15818645d9e6a559e640cafc641b8  0241_session_appointment_coalesce_identity.sql
98707acb9053dfa78fadb7eaff59fcc98db678a9aee19b2375ec6ffa011c2f40  0242_close_direct_generic_audit_inserts.sql
3e8c89a857b3c450ac3c87257208b206ea42dcb415fcf46720ee35256976d332  0243_intake_revision_cas_and_profile_sync.sql
046d5d11f06d011fd00fc994770382e1bf72079694d4eb0aaac0a69be2bb5964  0244_treatment_reading_change_history.sql
623f967469cbc4bb5d29b38828fa95fd51539d4187af6b2b4d50a6900ca323ad  0245_ordered_card_setup_success.sql
03a30dab56524b87ebefdf2e7b915d7717b1a9de6bed87f34b039a41dfc64b1a  0246_intake_questionnaire_snapshot.sql'
#GO34-END

PW=""
STAGE=start
cleanup() {
  PW=""
  unset PW PGPASSWORD SUPABASE_DB_PASSWORD
  stty echo </dev/tty >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'echo >&2; echo "STOP: interrupted at stage $STAGE; credentials cleared. If the stage was the push, the database state is UNKNOWN: read back the migration history before anything else, and do NOT rerun this script." >&2; exit 130' INT TERM HUP
die() { echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }
iso='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
strip() { LC_ALL=C sed $'s/\033\\[[0-9;]*[A-Za-z]//g' "$1"; }

[ $# -eq 0 ] || die "this script takes no arguments"

# ---------------------------------------------------------------------------------------------------------
# Part 0: this Mac, the verified binary, a clean environment (NAMES only, never values)
# ---------------------------------------------------------------------------------------------------------
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "not macOS arm64"
for t in shasum tar awk sed grep find mktemp cut sort diff wc tr; do command -v "$t" >/dev/null 2>&1 || die "$t not found"; done
[ -r /dev/tty ] || die "no terminal for private entry"
SELF=$(cd "$(dirname "$0")" && pwd -P) || die "cannot resolve the script directory"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die "$ROOT is missing or a symlink (run the Mac installer check first)"
[ -n "$(find "$ROOT" -maxdepth 0 -user "$(id -un)" ! -perm -020 ! -perm -002 2>/dev/null)" ] || die "$ROOT must be owned by you and not writable by group or others"
[ -f "$BIN" ] && [ ! -L "$BIN" ] && [ "$(sha "$BIN")" = "$GO_SHA" ] || die "supabase-go missing or sha256 mismatch (run the Mac check first)"
[ -n "$(find "$BIN" -maxdepth 0 -user "$(id -un)" ! -perm -020 ! -perm -002 2>/dev/null)" ] || die "supabase-go must be owned by you and not writable by group or others"
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|E2E_SUPABASE_URL|HONE_LOCAL_DB_URL|HONE_WINDOW_[A-Z_]*|HONE_SUPABASE_BIN|GITHUB_TOKEN|GH_TOKEN|HTTPS_PROXY|HTTP_PROXY|ALL_PROXY|NO_PROXY|https_proxy|http_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|DYLD_[A-Z_]*|LD_PRELOAD|LD_LIBRARY_PATH)$' | sort -u | tr '\n' ' ')
[ -z "$bad" ] || die "unset these variables first (names only): $bad"
case "$URL" in postgresql://*) ;; *) die "internal: the URL is not a postgresql:// URL" ;; esac
userinfo=${URL#postgresql://}; userinfo=${userinfo%%@*}
case "$userinfo" in *:*|*%*) die "internal: the URL carries a password-like userinfo" ;; esac
case "$URL" in *password=*|*Password=*) die "internal: the URL carries a password parameter" ;; esac
case "$URL" in *:6543/*) die "internal: the transaction pooler (6543) is never used" ;; esac
case "$URL" in *sslmode=require*) ;; *) die "internal: the URL does not require TLS" ;; esac

# ---------------------------------------------------------------------------------------------------------
# Part 1: the bundle. Both files are pinned by sha256; the tar is checked entry by entry BEFORE extraction.
# 0247 and above cannot be in the bundle, and any extra, missing or altered file stops here.
# ---------------------------------------------------------------------------------------------------------
[ -f "$SELF/$BUNDLE" ] && [ ! -L "$SELF/$BUNDLE" ] || die "$BUNDLE is not next to this script"
[ -f "$SELF/$LIST" ] && [ ! -L "$SELF/$LIST" ] || die "$LIST is not next to this script"
[ "$(sha "$SELF/$BUNDLE")" = "$BUNDLE_SHA" ] || die "$BUNDLE sha256 mismatch (tampered or wrong file)"
[ "$(sha "$SELF/$LIST")" = "$LIST_SHA" ] || die "$LIST sha256 mismatch (tampered or wrong file)"
grep -Eqv '^[0-9a-f]{64}  [0-9]{4}_[A-Za-z0-9_]+\.sql$' "$SELF/$LIST" && die "$LIST has a malformed line"
prev=0
while IFS= read -r l; do
  v=${l#*  }; v=${v%%_*}
  case "$v" in [0-9][0-9][0-9][0-9]) ;; *) die "$LIST: a malformed version" ;; esac
  vn=$((10#$v))
  [ "$vn" -le "$MAXV" ] || die "$LIST names a file above $(printf '%04d' "$MAXV"): $v"
  [ "$vn" -gt "$prev" ] || die "$LIST is not strictly ascending at $v"
  prev=$vn
done < "$SELF/$LIST"
[ "$prev" = "$MAXV" ] || die "$LIST does not end at $(printf '%04d' "$MAXV")"
n=$(grep -c '' "$SELF/$LIST"); [ "$n" = "$NFILES" ] || die "$LIST has $n lines, expected $NFILES"
# the 34 pending files equal the GO package list, byte for byte (names and hashes)
awk '{v=substr($2,1,4)+0; if (v>=213 && v<=246) print}' "$SELF/$LIST" > "${TMPDIR:-/tmp}/.s1-go34.$$" || die "cannot derive the pending list"
printf '%s\n' "$GO34" | diff -q - "${TMPDIR:-/tmp}/.s1-go34.$$" >/dev/null 2>&1 || { rm -f "${TMPDIR:-/tmp}/.s1-go34.$$"; die "the 34 pending files in $LIST differ from the GO package list"; }
rm -f "${TMPDIR:-/tmp}/.s1-go34.$$"
[ "$(printf '%s\n' "$GO34" | grep -c '')" = 34 ] || die "internal: the embedded GO list is not 34 lines"
printf '%s\n' "$GO34" | grep -q "^$H0214  0214_" || die "0214 is not $H0214"
# tar entries: names, types, nothing else
tar -tf "$SELF/$BUNDLE" > /dev/null 2>&1 || die "$BUNDLE is not a readable tar"
ents=$(tar -tf "$SELF/$BUNDLE" 2>/dev/null | sed 's#/$##') || die "cannot list $BUNDLE"
printf '%s\n' "$ents" | grep -Evx 'supabase|supabase/migrations|supabase/migrations/[0-9]{4}_[A-Za-z0-9_]+\.sql' | head -3 | grep -q . && die "$BUNDLE holds an entry that is not supabase/migrations/NNNN_name.sql"
tar -tvf "$SELF/$BUNDLE" 2>/dev/null | cut -c1 | grep -Evx '[-d]' | head -1 | grep -q . && die "$BUNDLE holds a link or special entry"
over=$(printf '%s\n' "$ents" | sed -n 's#^supabase/migrations/\([0-9][0-9][0-9][0-9]\)_.*#\1#p' | awk -v m="$MAXV" '$1+0>m' | head -1)
[ -z "$over" ] || die "$BUNDLE holds a file above $(printf '%04d' "$MAXV"): version $over"
printf '%s\n' "$ents" | sed -n 's#^supabase/migrations/##p' | LC_ALL=C sort > "${TMPDIR:-/tmp}/.s1-tar.$$"
awk '{print $2}' "$SELF/$LIST" | LC_ALL=C sort > "${TMPDIR:-/tmp}/.s1-lst.$$"
extra=$(LC_ALL=C comm -23 "${TMPDIR:-/tmp}/.s1-tar.$$" "${TMPDIR:-/tmp}/.s1-lst.$$" | head -3 | tr '\n' ' ')
missing=$(LC_ALL=C comm -13 "${TMPDIR:-/tmp}/.s1-tar.$$" "${TMPDIR:-/tmp}/.s1-lst.$$" | head -3 | tr '\n' ' ')
rm -f "${TMPDIR:-/tmp}/.s1-tar.$$" "${TMPDIR:-/tmp}/.s1-lst.$$"
[ -z "$extra" ] || die "$BUNDLE has files that $LIST does not list: $extra"
[ -z "$missing" ] || die "$BUNDLE is missing files that $LIST lists: $missing"

# a fresh private project dir made from the bundle ONLY (no config.toml, no .env, no pooler-url, no linked project)
mkdir -p "$ROOT" || die "mkdir failed"
WORK=$(mktemp -d "$ROOT/s1apply.XXXXXX") || die "mktemp failed"
chmod 700 "$WORK" || die "chmod failed"
PROJ="$WORK/project"; LOGS="$WORK/logs"
mkdir "$PROJ" "$LOGS" || die "mkdir failed"
chmod 700 "$PROJ" "$LOGS" || die "chmod failed"
tar -xf "$SELF/$BUNDLE" -C "$PROJ" || die "could not extract $BUNDLE"
[ -z "$(find "$PROJ" -type l | head -1)" ] || die "the extracted bundle contains a link"
[ "$(find "$PROJ" -type f | wc -l | tr -d ' ')" = "$NFILES" ] || die "the extracted bundle does not hold exactly $NFILES files"
[ -z "$(find "$PROJ" -type f ! -path "$PROJ/supabase/migrations/*" | head -1)" ] || die "the extracted bundle holds a file outside supabase/migrations"
vout=$(cd "$PROJ/supabase/migrations" && shasum -a 256 -c "$SELF/$LIST" 2>&1) || die "an extracted migration differs from $LIST"
[ "$(printf '%s\n' "$vout" | grep -c ': OK$')" = "$NFILES" ] || die "the extracted migrations did not verify $NFILES files"
mkdir -p "$PROJ/supabase/.temp" || die "mkdir failed"
printf '%s\n' v2.102.0 > "$PROJ/supabase/.temp/cli-latest" || die "write cli-latest failed"
[ ! -e "$PROJ/supabase/config.toml" ] && [ ! -e "$PROJ/supabase/.temp/pooler-url" ] && [ ! -e "$PROJ/supabase/.temp/project-ref" ] || die "internal: the project dir has linked-project files"
RUN="$WORK/run.txt"
{
  echo "S1 apply run started $(utcnow)"
  echo "script sha256 $(sha "$0")"
  echo "bundle sha256 $BUNDLE_SHA ($BUNDLE) list sha256 $LIST_SHA"
  echo "head $HEAD_SHA; files $NFILES; pending 34 (0213..0246)"
  echo "supabase-go sha256 $GO_SHA"
  echo "target pooler URL (no password): $URL"
} > "$RUN" || die "cannot write the run record"
echo "Bundle verified: $NFILES files, 0001..$(printf '%04d' "$MAXV"), the 34 pending files equal the GO package list. Working directory: $WORK" >&2

# ---------------------------------------------------------------------------------------------------------
# Part 2: what the operator confirms (BEFORE any connection). Nothing is guessed or defaulted.
# ---------------------------------------------------------------------------------------------------------
STAGE=prompts
ask() { # ask VAR "prompt"
  local _v
  IFS= read -r -p "$2" _v </dev/tty || die "could not read $1"
  printf -v "$1" '%s' "$_v"
}
echo "The time now is $(utcnow). Times are UTC, like 2026-10-27T01:00:00Z. Nothing is defaulted." >&2
ask RPOINT "Pre-migration PITR restore point you recorded (UTC): "
printf '%s' "$RPOINT" | LC_ALL=C grep -Eq "^$iso\$" || die "the restore point is not YYYY-MM-DDTHH:MM:SSZ"
[ ! "$RPOINT" \> "$(utcnow)" ] || die "the restore point is in the future"
echo "The watchdog is the separate window that cancels a statement running past 120 seconds. It must be running first." >&2
ask W1 "The watchdog window printed the word  armed  (type yes): "; [ "$W1" = yes ] || die "watchdog 'armed' not confirmed (type exactly: yes)"
ask W2 "The watchdog window printed the word  watching  (type yes): "; [ "$W2" = yes ] || die "watchdog 'watching' not confirmed (type exactly: yes)"
{ echo "restore point typed: $RPOINT"; echo "watchdog armed and watching confirmed $(utcnow)"; } >> "$RUN"

# ---------------------------------------------------------------------------------------------------------
# Part 3: the password (typed, never echoed), then ONE dry run. No retry: a failed login stops the script.
# ---------------------------------------------------------------------------------------------------------
STAGE=password
IFS= read -rs -p "Database password (not shown): " PW </dev/tty || die "could not read the password"
echo >&2
[ -n "$PW" ] || die "empty password; nothing was attempted"

run_cli() { # run_cli LOGFILE args...  (the password is in the child's environment only)
  local lf="$1"; shift
  ( cd "$PROJ" && PGPASSWORD="$PW" SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 "$BIN" "$@" ) </dev/null >"$lf" 2>&1
}
scan_log() { # scan_log FILE: a login-role / ban / password-reset path means the CLI left the plan
  if strip "$1" | grep -qiE 'login role|initialising|unban|network.?ban|reset.*password|api\.supabase\.com'; then
    die "the CLI reported a login-role / ban / password / Management API path. Stopped; REPORT it (log: $1). Do not retry."
  fi
}
WANT=$(printf '%s\n' "$GO34" | awk '{print $2}')

STAGE=dry-run
echo "dry run started $(utcnow)" >> "$RUN"
echo "Running the dry run (one connection attempt)..." >&2
DRY="$LOGS/dry-run.log"
rc=0; run_cli "$DRY" db push --db-url "$URL" --dry-run || rc=$?
echo "dry run finished $(utcnow) exit $rc" >> "$RUN"
scan_log "$DRY"
if [ "$rc" != 0 ]; then
  strip "$DRY" | tail -n 6 >&2
  die "the dry run failed (exit $rc), for example a connection or authentication error. NOTHING was applied. Do not retry from this script; report the log: $DRY"
fi
dsum=$(strip "$DRY")
printf '%s\n' "$dsum" | grep -qx 'DRY RUN: migrations will \*not\* be pushed to the database.' || die "the dry run did not announce itself as a dry run"
printf '%s\n' "$dsum" | grep -qx 'Would push these migrations:' || die "the dry run did not print 'Would push these migrations:'"
printf '%s\n' "$dsum" | grep -q 'Applying migration' && die "the dry run printed 'Applying migration': stopped"
got=$(printf '%s\n' "$dsum" | LC_ALL=C grep -E '^ *[^ ]+ +[0-9]{4}_[A-Za-z0-9_]+\.sql *$' | LC_ALL=C sed -E 's/^.* ([0-9]{4}_[A-Za-z0-9_]+\.sql) *$/\1/')
ngot=$(printf '%s\n' "$got" | grep -c '.')
[ "$ngot" = 34 ] || die "the dry run lists $ngot migrations, expected exactly 34. NOTHING was applied (log: $DRY)"
[ "$got" = "$WANT" ] || die "the dry run lists 34 migrations but not the expected 0213..0246 in order. NOTHING was applied (log: $DRY)"
echo "Dry run OK: exactly 34 migrations, 0213 .. 0246, in order." >&2
echo "dry run listed exactly the 34 expected versions in order" >> "$RUN"

# ---------------------------------------------------------------------------------------------------------
# Part 4: ONE push. The operator types APPLY. The log must show 34 "Applying migration" lines in order, then the
# finish line, and the CLI must exit 0.
# ---------------------------------------------------------------------------------------------------------
STAGE=confirm
ask GOWORD "Type  APPLY  to run the single push of those 34 migrations now: "
[ "$GOWORD" = APPLY ] || die "not confirmed (type exactly: APPLY). NOTHING was applied."
STAGE=push
echo "push started $(utcnow)" >> "$RUN"
echo "Running the push (one connection attempt)..." >&2
PUSH="$LOGS/push.log"
rc=0; run_cli "$PUSH" db push --db-url "$URL" --yes || rc=$?
echo "push finished $(utcnow) exit $rc" >> "$RUN"
PW=""; unset PW
psum=$(strip "$PUSH")
napp=$(printf '%s\n' "$psum" | grep -c '^Applying migration ')
scan_log "$PUSH"
fail_report() {
  strip "$PUSH" | tail -n 12 >&2
  echo "Applying-migration lines seen: $napp of 34." >&2
  die "$1 The database state is what the CLI reports above: files before the failing one are recorded and the failing file did not commit, but READ BACK the migration history before anything else. Do NOT rerun this script. Report the log: $PUSH"
}
[ "$rc" = 0 ] || fail_report "the push failed (exit $rc)."
[ "$napp" = 34 ] || fail_report "the push logged $napp 'Applying migration' lines, expected 34."
applied=$(printf '%s\n' "$psum" | LC_ALL=C grep -E '^Applying migration [0-9]{4}_[A-Za-z0-9_]+\.sql\.\.\.$' | LC_ALL=C sed -E 's/^Applying migration ([0-9]{4}_[A-Za-z0-9_]+\.sql)\.\.\.$/\1/')
[ "$applied" = "$WANT" ] || fail_report "the 34 applied migrations are not exactly 0213..0246 in order."
printf '%s\n' "$psum" | grep -qx 'Finished supabase db push.' || fail_report "the 'Finished supabase db push.' line is missing."

{ echo "S1 APPLIED $(utcnow): 34 migrations 0213..0246 in order, finish line present, exit 0"; echo "dry-run log sha256 $(sha "$DRY")"; echo "push log sha256 $(sha "$PUSH")"; } >> "$RUN"
echo "S1 APPLIED: exactly 34 migrations (0213 .. 0246) in order; 'Finished supabase db push.'; exit 0." >&2
echo "NEXT (read back before anything else): migration history must be 245 rows with max 0246, and the post-S1 checks. Run record and logs: $WORK" >&2
exit 0
