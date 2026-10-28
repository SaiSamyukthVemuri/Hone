#!/bin/bash
ME=pitr; . "$HOME/hone-s1/stub-common.sh"
slog "pitr: started"
ssecret TOK "Supabase access token (not shown): " "$TOKH"
O=$(mktemp -d "$S/pitr-backups.XXXXXX"); chmod 700 "$O"
n=$(grep -c '^pitr: started' "$S/stub.log"); now=$(date -u +%s)
if [ "${PITR_MODE:-advance}" = stalled ]; then late=$((now - 7200)); else late=$((now - 5)); fi
[ "$n" -ge "${PITR_ADVANCE_AFTER:-1}" ] || late=$((now - 7200))
[ "${PITR_MODE:-advance}" != needs_hb ] || { if [ -f "$S/hb.count" ]; then late=$((now - 5)); else late=$((now - 7200)); fi; }
node -e 'const [l,e]=process.argv.slice(1).map(Number);console.log(JSON.stringify({pitr_enabled:true,walg_enabled:true,physical_backup_data:{earliest_physical_backup_date_unix:e,latest_physical_backup_date_unix:l},backups:[]}))' "$late" $((now - 86400*7)) > "$O/backups.json"
printf '{"command":"backups list","started_at_utc":"%s","captured_at_utc":"%s","exit_code":0}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$O/backups.meta.json"
echo "saved (private, mode 0700): $O/backups.json and $O/backups.meta.json"
slog "pitr: saved $O"
