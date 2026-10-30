#!/bin/bash
# PREPARATION ONLY / HELD. STAGE 0254-AFTER-0257 ONLINE (include-all), Mac package step. Run ONLY after 0257 is hosted and Sam has separately approved the 0254 stage. Local to this Mac: no hosted call, no secret.
# 1. Download the 21 reviewed files (the 0254-online package logic with the include-all mechanics; runner and driver are the reviewed #1262 files, unchanged), check each by FULL sha256; install nothing unless all match.
# 2. Install into ~/hone-s1/s1-apply-0254a-online (the folder the reviewed runner manifest names), ~/hone-s1/window-reads-0254a,
#    ~/hone-s1/window-reads-s1-0254a (the paths the scripts hard-code) and ~/hone-s1/runner (hone-stage-run.sh, run.exp, stages/0254a.conf).
#    Exact-sha copies left in the earlier ~/hone-s1/s1-apply-0254a folder are removed so only one copy exists.
# 3. Remove the finished 0248 online apply/reconcile scripts (3f2fac3f, b9bd0dc4) ONLY when their sha matches exactly.
# 4. List every apply/reconcile script left, the shared marker path and supabase-go.
set -u
umask 077
SRC=sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/01-ops/stage-0254-after-0257-mac
ROOT="$HOME/hone-s1"
sha() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
die() { echo "STOP: $*" >&2; exit 1; }
[ -d "$ROOT" ] || die "$ROOT does not exist (do not change HOME)"
pgrep -f 's1-apply-02|s1-reconcile-02|g02-read-02' >/dev/null 2>&1 && die "an apply, reconcile or read script is running; close it first"

SET='
450e83334b386248b801b54d5b8a175b5f590cf942cd698ea776b2b441d85f22 s1-apply-0254a-online/s1-apply-0254a-online.sh
ecfb2d3b6811a8fd390449104f2952b4b4c877abed2fdce361bf69e7d0fa69c9 s1-apply-0254a-online/s1-reconcile-0254a-online.sh
d5fe9726e46bca1bfd326b6afd08dfb655a30bda3f11da62c30d66aab6812262 s1-apply-0254a-online/g02-read-0254a-online.sh
cb781e43b266a0c91b8a07ed18f8c87eeb297865846726b5be10c9c1e2576585 s1-apply-0254a-online/migrations-stage0254a.tar
446b637ce3845c65f9b5978ca41563f60939b733a8284e5c127c6a2199712675 s1-apply-0254a-online/MIGRATIONS-stage0254a.sha256
1d8ff11948dfe2c3dbae0ea88c290907292495461470a0d90175e3beace5559c window-reads-0254a/g02-history-0254a.sql
c0c40ea16b0ee12e1404d1a105fca27539abeed7b60518f9e0e560d0602d208b window-reads-0254a/g12-0254a-preflight-0254a.sql
66e7dbd61a78dfc40ba792631b7b3d7e4ee631115ffa8080c9b2498675b5c1c8 window-reads-0254a/MANIFEST.sha256
471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357 window-reads-0254a/run-window-read-macos.sh
d4a3def847c8d713fb30b1ce6ce92580722967715eaae8ef65fd490ccd05efff window-reads-0254a/s1-open-transactions-0254a.sql
03e4ce618597c3dd7449d764bb9c6422bd33e451c510686253e8afa33f736a91 window-reads-0254a/w03-table-sizes-0254a.sql
d3a5ce58ab6ae154c44843aa224aede49ac1affb363173a77f7207f714845d5a window-reads-s1-0254a/c01_functions-exist.sql
82b6d881c6ea54351a7e6ac713e8e76838b1311aa84114e42582dce7dc41b590 window-reads-s1-0254a/c02_function-bodies.sql
dae82cab3050aed3cf18a0651d9b501d8f2fb13eaf73b93176737517c2476592 window-reads-s1-0254a/c03_read-policies.sql
9f6ac715286428b4832af0a230fc08b5e428302f180c94036377e58fdf228ab3 window-reads-s1-0254a/MANIFEST.sha256
471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357 window-reads-s1-0254a/run-window-read-macos.sh
a0d3c33556ec7fe13b32f776cf6bf3fef6ccece4de39c752d66778f9b19c9d66 window-reads-s1-0254a/s1-history-0254a.sql
e2313ac8d927771606ae6004f3a8bd6be1e601277f9cda004ff037b49a583515 window-reads-s1-0254a/window-s1read-0254a.sh
bdaa312f1fcf3c54d642ca9e2bceb242f01e8f8232105c5bc42bcece9cc3633f runner/hone-stage-run.sh
7ec25db81ae6bd9d2c12be243e417f3ffdb273a6b3011024fd30748b4bb2a7c4 runner/run.exp
6a76e5acaeca905eebbde5bceda53bcd5f9174ca68200102804b5c5c3aec7e1c runner/stages/0254a.conf
'
DIRS="s1-apply-0254a-online window-reads-0254a window-reads-s1-0254a runner runner/stages"

# Part 1: download into a private temp dir; check all 21 by full sha256 before installing any.
T=$(mktemp -d) || die "mktemp failed"
scp -q -r "$SRC/s1-apply-0254a-online" "$SRC/window-reads-0254a" "$SRC/window-reads-s1-0254a" "$SRC/runner" "$T/" || { rm -rf "$T"; die "download failed; nothing installed"; }
bad=0; n=0
while read -r want f; do
  [ -n "$f" ] || continue; n=$((n+1))
  if [ ! -f "$T/$f" ]; then echo "MISSING  $f"; bad=1
  elif [ "$(sha "$T/$f")" = "$want" ]; then echo "OK       $f"
  else echo "WRONG    $f"; bad=1; fi
done <<EOF
$SET
EOF
[ "$n" = 21 ] || { rm -rf "$T"; die "internal: expected 21 pinned files, read $n"; }
for d in $DIRS; do
  for g in "$T/$d"/*; do [ -d "$g" ] && continue; b="$d/$(basename "$g")"; printf '%s\n' "$SET" | grep -q " $b\$" || { echo "EXTRA    $b (not pinned)"; bad=1; }; done
done
[ "$bad" = 0 ] || { rm -rf "$T"; die "a downloaded file is wrong, missing or unpinned; NOTHING was installed or removed"; }

# Part 2: install.
for d in $DIRS; do
  mkdir -p "$ROOT/$d" && chmod 700 "$ROOT/$d" || die "cannot create $ROOT/$d"
  for g in "$ROOT/$d"/*; do [ -f "$g" ] || continue; b="$d/$(basename "$g")"; printf '%s\n' "$SET" | grep -q " $b\$" || echo "NOTE     $ROOT/$b exists and is not part of the pinned set (left in place; tell OPS)"; done
  for g in "$T/$d"/*; do [ -f "$g" ] && { cp "$g" "$ROOT/$d/" || die "copy into $ROOT/$d failed"; }; done
done
chmod 755 "$ROOT"/s1-apply-0254a-online/*.sh "$ROOT"/window-reads-0254a/*.sh "$ROOT"/window-reads-s1-0254a/*.sh "$ROOT"/runner/*.sh
rm -rf "$T"
inst=0
while read -r want f; do [ -n "$f" ] || continue; [ "$(sha "$ROOT/$f")" = "$want" ] && inst=$((inst+1)); done <<EOF
$SET
EOF
[ "$inst" = 21 ] || die "installed files did not re-check ($inst of 21)"
echo "INSTALLED 21 of 21 pinned files, each re-checked in place"

echo "--- removing earlier copies in ~/hone-s1/s1-apply-0254a (exact sha only; the folder itself is left)"
if [ -d "$ROOT/s1-apply-0254a" ]; then
  for g in "$ROOT/s1-apply-0254a"/*; do [ -f "$g" ] || continue; b="s1-apply-0254a-online/$(basename "$g")"; w=$(printf '%s\n' "$SET" | awk -v b="$b" '$2==b {print $1}')
    [ -n "$w" ] && [ "$(sha "$g")" = "$w" ] && rm -f -- "$g" && echo "REMOVED  $g (duplicate of the pinned copy)"; done
fi
echo "--- removing the finished 0248 online scripts (exact sha only)"
for base in "$ROOT" "$HOME/Downloads" "$HOME/Desktop" "$HOME/Documents"; do
  [ -d "$base" ] && find "$base" -maxdepth 4 -type f \( -name 's1-apply*.sh' -o -name 's1-reconcile*.sh' \) 2>/dev/null
done | sort -u | while read -r f; do
  case "$(sha "$f")" in
    3f2fac3fbc3a0e1e6cb1e223e86ac4f54fae82b959c41fe5de2168af9f93eda5|b9bd0dc498dd6072c96ef3fa9cc64ef2e70909bc4503bd5d9e7259a40784abbd) rm -f -- "$f" && echo "REMOVED  $f" ;;
  esac
done

echo "--- tool"
f="$ROOT/supabase-cli/supabase-go"
if [ ! -f "$f" ]; then echo "MISSING  supabase-cli/supabase-go"; elif [ "$(sha "$f")" = dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b ]; then echo "OK       supabase-cli/supabase-go"; else echo "WRONG    supabase-cli/supabase-go"; fi

echo "--- apply/reconcile scripts now on this Mac (expected exactly: ~/hone-s1/s1-apply-0254a-online/s1-apply-0254a-online.sh 450e8333..., .../s1-reconcile-0254a-online.sh ecfb2d3b...)"
for base in "$ROOT" "$HOME/Downloads" "$HOME/Desktop" "$HOME/Documents"; do
  [ -d "$base" ] && find "$base" -maxdepth 4 -type f \( -name 's1-apply*.sh' -o -name 's1-reconcile*.sh' \) 2>/dev/null
done | sort -u | while read -r f; do echo "$(sha "$f")  $f"; done
echo "--- markers (APPLY-STATE and FAILED-LOGIN must be absent; archived APPLY-STATE.cleared.* is fine)"
found=0
for m in "$ROOT/s1-apply/APPLY-STATE" "$ROOT/s1-apply/FAILED-LOGIN" "$ROOT/FAILED-LOGIN" "$ROOT"/*/FAILED-LOGIN; do
  [ -e "$m" ] && { echo "PRESENT  $m: $(head -c 120 "$m" | tr -d '\n')"; found=1; }
done
[ "$found" = 0 ] && echo "none"
echo "DONE at $(date -u +%Y-%m-%dT%H:%M:%SZ). Paste everything from INSTALLED onward to OPS."
