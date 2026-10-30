#!/bin/bash
# REHEARSAL - NEVER MERGE. Hone ONE-COMMAND STAGE runner (online flow): ONE entry point on the operator's Mac, generic over a stage manifest.
#   usage: hone-stage-run.sh STAGE-MANIFEST        (stages/0254.conf is the manifest for 0254)
# It runs the REVIEWED, UNMODIFIED stage scripts (the manifest pins each by full sha256): the apply script, which itself runs the four pinned reads, the dry run,
# the ONE push and the pinned read-back, and then the reconcile script. It changes none of them. run.exp plays the person at the terminal through a pty:
#   summary shown -> ONE approval word -> access token and database password typed ONCE, hidden -> every prompt of the child answered by exact text, in order
#   (the read-back's second token/password prompts included; a prompt that is not in the manifest is never answered, the run STOPs) -> automatic reconcile
#   when, and only when, the apply script reports APPLIED+VERIFIED -> ONE result block.
# Fail-closed. No retry. No settings write of any kind (this file and run.exp contain no database statement at all). Credentials never leave run.exp's memory
# and the child's pty: not an argument, not the environment, not a file. The reconcile script makes no connection and takes no credentials.
set -u
umask 077
ROOT="$HOME/hone-s1"
HERE="$(cd "$(dirname "$0")" && pwd)"
EXP=$HERE/run.exp
OUTCOME=""; REASON=""; RUN=""; RECONCILE_NOTE=""; DRC=""
die_early() { REASON="$*"; echo "STOP: $*" >&2; exit 1; }
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---- the ONE result block, printed from the exit trap whatever the exit path ----
result_block() {
  local txt
  txt="================================================================================
ONE-COMMAND RESULT: $OUTCOME"
  [ -n "$REASON" ] && txt="$txt
reason: $REASON"
  [ -z "$RECONCILE_NOTE" ] || txt="$txt
reconcile: $RECONCILE_NOTE"
  txt="$txt
settings write: none (no ALTER ROLE, no SET, no database statement is made by this runner)"
  [ -z "${M_STAGE:-}" ] || txt="$txt
stage: $M_STAGE; manifest sha256 ${MANIFEST_SHA:-unread}"
  [ -z "$RUN" ] || txt="$txt
evidence: $RUN (masked transcript, driver result)"
  case "$OUTCOME" in
    "UNKNOWN"*) txt="$txt
next: do NOT rerun the push. Run the stage read-back (read only), then the stage reconcile script; the APPLY-STATE marker stays until then." ;;
  esac
  txt="$txt
================================================================================"
  printf '%s\n' "$txt" >&2
  [ -z "$RUN" ] || [ ! -d "$RUN" ] || printf '%s\n' "$txt" > "$RUN/RESULT.txt" 2>/dev/null
  return 0
}
on_exit() {
  local rc=$?
  trap - EXIT
  if [ -z "$OUTCOME" ]; then OUTCOME="NOT APPLIED"; REASON="${REASON:-the runner exited early (status $rc)}"; fi
  result_block
  exit $rc
}
trap on_exit EXIT
trap 'REASON="interrupted before the child started"; exit 130' INT TERM HUP

# ---- 0. this Mac, the tools, a clean environment ----
[ $# -eq 1 ] || die_early "usage: hone-stage-run.sh STAGE-MANIFEST"
MANIFEST=$1
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || die_early "the stage manifest is missing"
for c in shasum expect awk sed grep; do command -v "$c" >/dev/null 2>&1 || die_early "$c not found"; done
bad=$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E '^(SUPABASE_[A-Za-z0-9_]*|PG[A-Za-z0-9_]*|DATABASE_URL|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|DYLD_[A-Za-z0-9_]*|LD_PRELOAD|HONE_[A-Z_]*|GITHUB_TOKEN|GH_TOKEN)$' | tr '\n' ' ')
[ -z "$bad" ] || die_early "unset these variables first (names only): $bad"
[ -r /dev/tty ] || die_early "no terminal"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || die_early "$ROOT is missing or a symlink"
MANIFEST_SHA=$(sha "$MANIFEST")

# ---- 1. the manifest: strict KEY=VALUE lines, nothing evaluated ----
mget() { sed -n "s/^$1=\(.*\)\$/\1/p" "$MANIFEST" | head -1; }
M_STAGE=$(mget STAGE); M_APPLY=$(mget APPLY); M_RECONCILE=$(mget RECONCILE); M_MARKER=$(mget MARKER); M_TOMB=$(mget TOMBSTONE)
M_VERIFIED=$(mget VERIFIED_LINE); M_WORD=$(mget APPROVE_WORD); M_IDLE=$(mget IDLE_S); M_HARD=$(mget HARD_S); M_PLATFORM=$(mget PLATFORM)
printf '%s' "$M_STAGE" | grep -Eq '^[0-9A-Za-z._-]{1,16}$' || die_early "manifest STAGE is missing or malformed"
for k in M_APPLY M_RECONCILE M_MARKER M_TOMB; do
  eval "v=\$$k"; printf '%s' "$v" | grep -Eq '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$' && ! printf '%s' "$v" | grep -q '\.\.' || die_early "manifest ${k#M_} is missing or not a plain relative path"
done
printf '%s' "$M_IDLE" | grep -Eq '^[1-9][0-9]{0,4}$' && printf '%s' "$M_HARD" | grep -Eq '^[1-9][0-9]{0,5}$' || die_early "manifest IDLE_S / HARD_S must be whole seconds"
[ -n "$M_VERIFIED" ] || die_early "manifest VERIFIED_LINE is missing"
printf '%s' "$M_WORD" | grep -Eq '^[A-Za-z0-9]{3,16}$' || die_early "manifest APPROVE_WORD is missing or malformed"
case "$M_PLATFORM" in Darwin-arm64) [ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] || die_early "not macOS arm64" ;; any) ;; *) die_early "manifest PLATFORM must be Darwin-arm64 or any" ;; esac
PROMPTS=$(sed -n 's/^PROMPT=\(.*\)<END>$/\1/p' "$MANIFEST")   # a prompt ends with the visible marker <END>, because its own trailing space cannot be seen in a file
[ -n "$PROMPTS" ] || die_early "the manifest has no PROMPT lines"
printf '%s\n' "$PROMPTS" | grep -Evq '^(approve|secret-token|secret-password)\|.+$' && die_early "a manifest PROMPT line is not kind|text with kind approve, secret-token or secret-password"
[ "$(sed -n 's/^PROMPT=//p' "$MANIFEST" | grep -vc '<END>$')" = 0 ] || die_early "every PROMPT line must end with <END>"
[ "$(printf '%s\n' "$PROMPTS" | grep -c '^approve|')" = 1 ] || die_early "the manifest needs exactly one approve prompt"

verify_pins() { # every PIN line, by FULL sha256, relative to ROOT; the apply and reconcile scripts must be among them
  local want path got n=0 sawa=0 sawr=0
  while IFS= read -r l; do
    want=${l%% *}; path=${l#*  }
    printf '%s' "$want" | grep -Eq '^[0-9a-f]{64}$' || { echo "malformed PIN line" >&2; return 1; }
    [ -f "$ROOT/$path" ] && [ ! -L "$ROOT/$path" ] || { echo "pinned file missing: $path" >&2; return 1; }
    got=$(sha "$ROOT/$path"); [ "$got" = "$want" ] || { echo "pin mismatch: $path" >&2; return 1; }
    [ "$path" = "$M_APPLY" ] && sawa=1; [ "$path" = "$M_RECONCILE" ] && sawr=1
    n=$((n+1))
  done <<EOF
$(sed -n 's/^PIN=\(.*\)$/\1/p' "$MANIFEST")
EOF
  [ "$n" -ge 2 ] && [ $sawa = 1 ] && [ $sawr = 1 ]
}
verify_pins || die_early "a pinned file is missing or its sha256 differs (only the pinned reviewed scripts may be on this Mac)"
STATEF=$ROOT/$M_MARKER; TOMB=$ROOT/$M_TOMB
[ ! -e "$STATEF" ] && [ ! -L "$STATEF" ] || die_early "an APPLY-STATE marker exists ($STATEF): a previous push is UNKNOWN or unverified. Run the stage reconcile script, not this."
[ ! -e "$TOMB" ] && [ ! -L "$TOMB" ] || die_early "a FAILED-LOGIN tombstone exists ($TOMB): a login failed earlier. Report it; do not rerun."
OC=$ROOT/one-command; mkdir -p "$OC" && chmod 700 "$OC" || die_early "cannot create $OC"
RUN=$(mktemp -d "$OC/run.XXXXXX") || die_early "mktemp failed"; chmod 700 "$RUN"
printf '%s\n' "$PROMPTS" > "$RUN/prompts.txt"

# ---- 2. the interactive part: ONE pty session for the apply script (and, inside it, the read-back) ----
cat >&2 <<EOF
HONE ONE-COMMAND STAGE $M_STAGE   (manifest sha256 $MANIFEST_SHA)
Next: the reviewed apply script shows its own summary. You then approve ONCE, type the access token and database password ONCE (hidden), and everything
after that is automatic: the four reads, the dry run, ONE push, the read-back (its own token/password prompts are answered from what you typed), then the
reconcile. Nothing is retried. No settings are changed. Ctrl-C at any point stops safely; after the push starts the result is UNKNOWN and the receipt says what to run.
EOF
{ echo "APPLY=$ROOT/$M_APPLY"; echo "IDLE_S=$M_IDLE"; echo "HARD_S=$M_HARD"; echo "RUN=$RUN"; echo "PROMPTS=$RUN/prompts.txt"; echo "ROOT=$ROOT"; echo "APPROVE_WORD=$M_WORD"; echo "VERIFIED_LINE=$M_VERIFIED"; } > "$RUN/driver.cfg"
echo "started $(utcnow)" > "$RUN/run.log"
INTSEEN=""; trap 'INTSEEN=1' INT TERM HUP   # from here the driver handles the signal (it is in our foreground group too); we classify from disk afterwards
expect -f "$EXP" "$RUN/driver.cfg"; DRC=$?
trap 'REASON="interrupted"; exit 130' INT TERM HUP
echo "driver exit $DRC $(utcnow)" >> "$RUN/run.log"
res() { sed -n "s/^$1=\(.*\)\$/\1/p" "$RUN/driver.result" 2>/dev/null | head -1; }
REASON=$(res STOP_REASON)
VER=$(res VERIFIED_SEEN)

# ---- 3. classify from what is on disk, never from the driver's word alone ----
if [ "$DRC" = 5 ]; then OUTCOME="NOT APPLIED"; REASON="${REASON:-not approved}"
elif [ -e "$STATEF" ] || [ -L "$STATEF" ]; then
  word=$(awk '{print $1}' "$STATEF" 2>/dev/null)
  if [ "$DRC" = 0 ] && [ "$VER" = 1 ] && [ "$word" = APPLIED-UNVERIFIED ]; then
    # ---- 4. APPLIED+VERIFIED: the reconcile runs by itself (it makes no connection and takes no credentials) ----
    ( cd "$ROOT" && /bin/bash "$ROOT/$M_RECONCILE" ) </dev/null >"$RUN/reconcile.out" 2>&1; rcr=$?
    if [ "$rcr" = 0 ] && [ ! -e "$STATEF" ]; then
      OUTCOME="APPLIED+VERIFIED"; RECONCILE_NOTE="done: $(sed -n 's/^RECONCILED \([A-Z]*\):.*/\1/p' "$RUN/reconcile.out" | head -1) (marker archived, record written; $RUN/reconcile.out)"
    else
      OUTCOME="APPLIED+VERIFIED (reconcile did NOT clear the marker)"; RECONCILE_NOTE="refused or failed (status $rcr); run the stage reconcile script by hand. See $RUN/reconcile.out"
    fi
    REASON=""
  else
    OUTCOME="UNKNOWN -> reconcile"; REASON="${REASON:-the push was started and the read-back did not confirm it (driver status $DRC, marker word $word)}"
    RECONCILE_NOTE="not run automatically: the outcome is not APPLIED+VERIFIED"
  fi
else
  OUTCOME="NOT APPLIED"; REASON="${REASON:-nothing was pushed (driver status $DRC)}"
fi
[ "$OUTCOME" = "APPLIED+VERIFIED" ] && exit 0
exit 1
