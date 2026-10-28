#!/bin/bash
# hone-release action: verify. Chained after the push: the state APPLIED-UNVERIFIED stays (and blocks the next apply) until THIS passes.
# READ-ONLY, with the separate read token on fd 3 (Database Read through the Management API; no database password). It runs, in order:
#   V1 history/max read-back against the approval (rows = history_before + count, max version = last, every approved version present);
#   V2 the stage's governed object / ACL / function-hash checks named by the approved verify bundle (verify_sha): fixed read-only SELECTs whose result
#      sha256 must equal the expected one in the bundle (lexical read-only gate: the Database Read token is NOT proven read-only by the provider);
#   V3 the reviewed credential-free smoke (scripts/post-s3-smoke.sh, byte-identical to the OPS-reviewed post-s3-smoke.sh), found through the manifest sha;
#   V4 serving-source compatibility: the approval's serving_commit and the approver's attestation are RECORDED (no unauthenticated read reports the served commit).
# Every step appends one link to the sha-chained receipt (logs/<approval>/receipt.json). A mismatch writes VERIFY-FAILED (only root clears it) and STOPS.
set -u
umask 077
PREFIX=/var/lib/hone-release; STATE=$PREFIX/state; LOGROOT=$PREFIX/logs; WORKROOT=$PREFIX/work
APPROVAL=/etc/hone-release/APPROVED-PACKAGE; INBOX=/srv/hone-release-inbox
LIBEXEC=/usr/local/libexec/hone-release; MANIFEST=$LIBEXEC/manifest
utcnow() { date -u +%Y-%m-%dT%H:%M:%SZ; }
APPROVAL_ID=""
write_state() { printf '%s %s %s%s\n' "$1" "${APPROVAL_ID:-none}" "$(utcnow)" "${2:+ $2}" > "$STATE/APPLY-STATE.tmp" && sync "$STATE/APPLY-STATE.tmp" && mv -f "$STATE/APPLY-STATE.tmp" "$STATE/APPLY-STATE" && sync "$STATE" 2>/dev/null; }
receipt_add() {
  mkdir -p "$LOGROOT/$APPROVAL_ID" && python3 -I - "$LOGROOT/$APPROVAL_ID/receipt.json" "$1" "$2" <<'PYR'
import json, sys, os, hashlib, time
path, stage, detail = sys.argv[1:4]
def sha(b): return hashlib.sha256(b).hexdigest()
r = json.load(open(path)) if os.path.isfile(path) else {"kind": "hone-release-receipt", "entries": []}
prev = r["entries"][-1]["sha256"] if r["entries"] else "0" * 64
e = {"seq": len(r["entries"]) + 1, "stage": stage, "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "detail": detail, "prev": prev}
e["sha256"] = sha((prev + json.dumps(e, sort_keys=True, separators=(",", ":"))).encode())
r["entries"].append(e); r["head"] = e["sha256"]
tmp = path + ".tmp"; open(tmp, "w").write(json.dumps(r, sort_keys=True, indent=1) + "\n"); os.replace(tmp, path)
PYR
}
fail() { echo "STOP: $*" >&2; [ -z "$APPROVAL_ID" ] || { receipt_add verify-failed "$*"; write_state VERIFY-FAILED "$*" 2>/dev/null; }; echo "The release is STOPPED: state VERIFY-FAILED (only root clears it). Receipt: $LOGROOT/$APPROVAL_ID/receipt.json" >&2; exit 1; }
die() { echo "STOP: $*" >&2; exit 1; }
[ "${HONE_RELEASE_ACTION:-}" = verify ] || die "not started by the launcher for the verify action"
for t in flock sha256sum tar python3; do command -v "$t" >/dev/null 2>&1 || die "$t not found"; done
{ IFS= read -r TOKEN <&3; } 2>/dev/null || die "no token on fd 3"
exec 3<&-
[ -n "$TOKEN" ] || die "empty token"
mkdir -p "$STATE" "$WORKROOT" "$LOGROOT"; exec 9>"$STATE/lock" || die "cannot open the lock"; flock -n 9 || die "another release run holds the lock"
for p in "$APPROVAL" /etc/hone-release /etc; do [ -e "$p" ] && [ ! -L "$p" ] && [ "$(stat -c %u "$p")" = 0 ] && [ $(( 8#$(stat -c %a "$p") & 8#022 )) = 0 ] || die "$p is not root-owned and private to root"; done
g() { sed -n "s/^$1=//p" "$APPROVAL" | head -1; }
APPROVAL_ID=$(g approval_id); printf '%s' "$APPROVAL_ID" | grep -Eq '^[A-Za-z0-9._-]{4,64}$' || die "approval_id is malformed"
st=$(cat "$STATE/APPLY-STATE" 2>/dev/null || echo none)
case "$st" in "APPLIED-UNVERIFIED $APPROVAL_ID "*) ;; *) die "the state is not APPLIED-UNVERIFIED for this approval ($st): nothing to verify" ;; esac
REF=$(g project_ref); FIRST=$(g first); LAST=$(g last); COUNT=$(g count); HB=$(g history_before); VSHA=$(g verify_sha); SERVC=$(g serving_commit); SERVA=$(g serving_attestation)
printf '%s' "$REF" | grep -Eq '^[a-z0-9-]{10,20}$' && printf '%s%s' "$FIRST" "$LAST" | grep -Eq '^[0-9]{8}$' && printf '%s%s' "$COUNT" "$HB" | grep -Eq '^[0-9]+$' || die "the approval's range fields are malformed"
W=$(mktemp -d "$WORKROOT/verify.XXXXXX") || die "no work dir";
MANIFEST=/usr/local/libexec/hone-release/manifest
mgmt() { # mgmt ID [args]   the ONE pinned read helper (mgmt-read.py): sha256-checked against the root-owned manifest; the token is only in its environment
  local line msha mpath; line=$(awk '$1 == "mgmt-read" {print $2 " " $3}' "$MANIFEST" 2>/dev/null)
  msha=${line% *}; mpath=${line#* }
  [ -n "$line" ] && [ -f "$mpath" ] && [ ! -L "$mpath" ] && [ "$(sha256sum "$mpath" | cut -d' ' -f1)" = "$msha" ] || { echo "the mgmt-read helper is missing or differs from the manifest sha256" >&2; return 9; }
  HONE_READ_TOKEN="$TOKEN" python3 -I "$mpath" "$REF" "$@"
}
pj() { python3 -I -c 'import json,sys; j=json.load(sys.stdin); r=j if isinstance(j,list) else j.get("rows",j.get("result",[])); print(" ".join(str(r[0][k]) for k in sys.argv[1:]))' "$@"; }
receipt_add verify-start "approval $APPROVAL_ID; range $FIRST..$LAST count $COUNT"

# V1 history
h=$(mgmt history 2> "$W/err.txt" | pj n mx) || fail "V1: the history read failed (outcome unverified)"
hn=${h%% *}; hx=${h#* }
[ "$hn" = "$((10#$HB + 10#$COUNT))" ] && [ "$hx" = "$LAST" ] || fail "V1: history MISMATCH: rows $hn (expected $((10#$HB + 10#$COUNT))), max $hx (expected $LAST)"
c=$(mgmt range "$FIRST" "$LAST" 2> "$W/err.txt" | pj c) || fail "V1: the range read failed"
[ "$c" = "$((10#$COUNT))" ] || fail "V1: only $c of the $COUNT approved versions are in the history"
receipt_add V1-history "rows $hn, max $hx, $c of $COUNT approved versions present"

# V2 stage checks named by the approved verify bundle
if [ "$VSHA" = none ]; then receipt_add V2-stage-checks "none named in the approval (verify_sha=none): no governed object, ACL or function-hash check was run"
else
  [ -f "$INBOX/verify.tar" ] && [ ! -L "$INBOX/verify.tar" ] && [ "$(stat -c %s "$INBOX/verify.tar")" -le 8388608 ] || fail "V2: verify.tar is missing, a symlink or too large"
  cat -- "$INBOX/verify.tar" > "$W/verify.tar"; [ "$(sha256sum "$W/verify.tar" | cut -d' ' -f1)" = "$VSHA" ] || fail "V2: verify.tar is not the approved verify bundle (sha256)"
  tar -tvf "$W/verify.tar" | cut -c1 | grep -Evx '-' | head -1 | grep -q . && fail "V2: the verify bundle holds a non-regular entry"
  tar -tf "$W/verify.tar" | grep -Evx '(\./)?[A-Za-z0-9_.-]+' | head -1 | grep -q . && fail "V2: the verify bundle holds a path that is not a plain file name"
  mkdir "$W/v" && tar -xf "$W/verify.tar" -C "$W/v" || fail "V2: the verify bundle could not be extracted"
  [ -f "$W/v/checks.list" ] || fail "V2: the verify bundle has no checks.list"
  n=0
  while IFS=$'\t' read -r id file ssha esha; do
    [ -n "$id" ] || continue
    printf '%s' "$id" | grep -Eq '^[A-Za-z0-9_.-]{1,60}$' && printf '%s' "$file" | grep -Eq '^[A-Za-z0-9_.-]+\.sql$' && printf '%s%s' "$ssha" "$esha" | grep -Eq '^[0-9a-f]{128}$' || fail "V2: a checks.list line is malformed"
    [ -f "$W/v/$file" ] && [ "$(sha256sum "$W/v/$file" | cut -d' ' -f1)" = "$ssha" ] || fail "V2: check $id: the SQL file is missing or its sha256 differs from checks.list"
    out=$(mgmt file "$W/v/$file" 2> "$W/err.txt"); mrc=$?
    [ "$mrc" != 3 ] || fail "V2: check $id: the SQL is not a single fixed read-only SELECT (lexical gate in the pinned helper)"
    [ "$mrc" = 0 ] || fail "V2: check $id: the read failed"
    got=$(printf '%s' "$out" | python3 -I -c 'import json,sys,hashlib; j=json.load(sys.stdin); r=j if isinstance(j,list) else j.get("rows",j.get("result",[])); print(hashlib.sha256(json.dumps(r,sort_keys=True,separators=(",",":")).encode()).hexdigest())') || fail "V2: check $id: the answer could not be canonicalised"
    [ "$got" = "$esha" ] || fail "V2: check $id: result MISMATCH (got $got, expected $esha)"
    receipt_add "V2-$id" "result sha256 $got equals the expected one; sql sha256 $ssha"
    n=$((n + 1))
  done < "$W/v/checks.list"
  [ "$n" -ge 1 ] || fail "V2: checks.list names no check although verify_sha was approved"
fi

# V3 the reviewed credential-free smoke, through the manifest
sm=$(awk '$1 == "smoke" {print $2 " " $3}' "$MANIFEST"); [ -n "$sm" ] || fail "V3: the smoke action is not in the manifest"
SMS=${sm% *}; SMP=${sm#* }
[ -f "$SMP" ] && [ ! -L "$SMP" ] && [ "$(sha256sum "$SMP" | cut -d' ' -f1)" = "$SMS" ] || fail "V3: the smoke script is missing or differs from the manifest sha256"
smout=$(env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME=/var/lib/hone-release/home /bin/bash -p "$SMP" 2>"$W/smoke.err") ; smrc=$?
printf '%s' "$smout" > "$W/smoke.json"
[ "$smrc" = 0 ] && python3 -I -c 'import json,sys; j=json.load(open(sys.argv[1])); sys.exit(0 if j.get("failed")==0 and j.get("total",0)>0 else 1)' "$W/smoke.json" || fail "V3: the smoke reported a failure (exit $smrc)"
receipt_add V3-smoke "smoke json sha256 $(sha256sum "$W/smoke.json" | cut -d' ' -f1); script sha256 $SMS; $(python3 -I -c 'import json,sys; j=json.load(open(sys.argv[1])); print("%d checks, %d failed" % (j["total"], j["failed"]))' "$W/smoke.json")"

# V4 serving source: compared with the OPS read-back of the Vercel alias->deployment commit (serving_check=readback), or recorded as attested only
SCHK=$(g serving_check)
if [ "$SCHK" = readback ]; then
  SR=/etc/hone-release/SERVING-READBACK
  [ -f "$SR" ] && [ ! -L "$SR" ] && [ "$(stat -c %u "$SR")" = 0 ] && [ $(( 8#$(stat -c %a "$SR") & 8#022 )) = 0 ] || fail "V4: serving_check=readback but there is no root-written SERVING-READBACK (the OPS read-back step: bind-serving.sh)"
  sr() { sed -n "s/^$1=//p" "$SR" | head -1; }
  [ "$(sr approval_id)" = "$APPROVAL_ID" ] || fail "V4: the SERVING-READBACK is for another approval"
  [ "$(sr commit)" = "$SERVC" ] || fail "V4: SERVING MISMATCH: the alias points to a deployment of commit $(sr commit), the approval names $SERVC"
  obs=$(date -u -d "$(sr observed_at)" +%s 2>/dev/null); pushed=$(python3 -I -c 'import json,sys,time,calendar; r=json.load(open(sys.argv[1])); t=[e["time"] for e in r["entries"] if e["stage"]=="push"][0]; print(calendar.timegm(time.strptime(t,"%Y-%m-%dT%H:%M:%SZ")))' "$LOGROOT/$APPROVAL_ID/receipt.json" 2>/dev/null); nowv=$(date -u +%s)
  [ -n "$obs" ] && [ -n "$pushed" ] && [ "$obs" -ge "$pushed" ] && [ "$obs" -le "$nowv" ] && [ $((nowv - obs)) -le 1800 ] || fail "V4: the serving read-back was not made after the push and within the last 30 minutes"
  receipt_add V4-serving-source "READ BACK by OPS (Vercel alias $(sr alias_host) -> deployment $(sr deployment)): commit $(sr commit) equals serving_commit $SERVC; observed $(sr observed_at); attestation: $SERVA"
else
  receipt_add V4-serving-source "serving_check=attested-only: serving_commit $SERVC attested by the approver ($SERVA); NOT read back"
fi
TOKEN=""; unset TOKEN
head_sha=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["head"])' "$LOGROOT/$APPROVAL_ID/receipt.json")
write_state APPLIED "verified receipt-head-$head_sha"
echo "VERIFIED: history, stage checks ($([ "$VSHA" = none ] && echo none-named || echo run)), smoke OK; serving source attested only. State APPLIED. Receipt head sha256 $head_sha ($LOGROOT/$APPROVAL_ID/receipt.json)"
python3 -I -c 'import json,sys; [print("  %2d %-22s %s" % (e["seq"], e["stage"], e["sha256"][:16])) for e in json.load(open(sys.argv[1]))["entries"]]' "$LOGROOT/$APPROVAL_ID/receipt.json"
