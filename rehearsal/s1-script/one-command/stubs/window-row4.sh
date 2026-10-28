#!/bin/bash
ME=row4; . "$HOME/hone-s1/stub-common.sh"
sask WSTART "Window start (UTC): " "$X_WSTART"
sask WEND "Window end (UTC): " "$X_WEND"
sask GO "Type exactly select: " select
T=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "$T" > "$S/stub.tsel"
echo "Selected pre-migration restore point: $T. Write it down. Do NOT start S1 yet." >&2
sleep 1
sask READY "Type ready when the newest pitr-backups capture was taken after $T and the dashboard's latest recovery point is at or after $T (or abort): "
[ "$READY" = ready ] || sdie "aborted by the operator; S1 was not started"
sask BASIS "Basis (latest_at_or_after, named_restore_point or idle_proven_latest): " latest_at_or_after
sask PITR_ON "PITR enabled on the dashboard (type exactly true): " true
sask PITR_RET "PITR retention in days (a whole number, no unit): " "$X_PITR_RET"
sask P_EARLY "Earliest recovery point on the dashboard (UTC): "
sask P_LATE "Latest recovery point on the dashboard (UTC): "
[ "$P_LATE" \> "$T" ] || [ "$P_LATE" = "$T" ] || sdie "latest point $P_LATE is before the selection $T"
echo "WINDOW ROW 4: OVERALL PASS for the selected restore point $T."
