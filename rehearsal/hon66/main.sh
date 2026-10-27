#!/usr/bin/env bash
# REHEARSAL - NEVER MERGE. HON66: one shared setup, then the parts in order. Each part prints PASS/FAIL/RESULT lines into $REHEARSAL_OUT/results.txt.
set -u
. "$(dirname "$0")/common.sh"
for part in facts apiproof verify gatetests; do
  [ -f "$HERE/$part.part" ] || continue
  say "######## part: $part"
  . "$HERE/$part.part"
done
say "== HON66 total failures: $FAILS"
exit $FAILS
