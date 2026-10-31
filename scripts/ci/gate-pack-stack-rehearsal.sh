#!/bin/bash
# REHEARSAL (never a release script). Runs the generated GATE PACKS of an ordered multi-stage plan against a REAL local Supabase stack
# that is hosted-shaped (the checkout's supabase/migrations is the production tree: 247 files, max 0257), applying each step with the pinned
# CLI's `db push --local --include-all` from that stage's own bundle.
#   per step: PRE reads (g02 history, g12 preflight, open transactions, table sizes) judged by the generated rule.js taken from the stage's
#             apply script; the push; POST read-back (history + the pack's content reads) judged by the generated read-back node program;
#             then MUTATION CONTROLS: a change a reviewer's check must catch is made, the read-back must now FAIL, the change is reverted,
#             and the read-back must pass again.
# usage: gate-pack-stack-rehearsal.sh PKGDIR [SEQUENCE]    env: PGURL (default the local stack), ONLY_PACKS=1 (skip steps without a pack's mutations)
set -u
PKG=${1:?usage: gate-pack-stack-rehearsal.sh PKGDIR [SEQUENCE]}; SEQ=${2:-full}
PGURL=${PGURL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}
OUT=${REHEARSAL_OUT:-$(mktemp -d)}; mkdir -p "$OUT"
pass=0; fail=0
ok() { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
pj() { python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))' "$1" "$2"; }
STAGES=$(pj "$PKG/PLAN.json" '" ".join(d["sequences"]["'"$SEQ"'"]["stages"])')
# the read-only query runner: the file's SELECT as one JSON array (what the CLI's query returns), with the session settings the hosted login role carries
runq() { # runq FILE OUTFILE
  local sql; sql=$(grep -v '^[[:space:]]*--' "$1" | sed -e ':a' -e '$!N;$!ba' -e 's/;[[:space:]]*$//')
  PGOPTIONS='-c statement_timeout=60000 -c lock_timeout=5000' psql "$PGURL" -At -v ON_ERROR_STOP=1 -c "select coalesce(json_agg(t), '[]'::json) from ($sql) t" > "$2" 2> "$2.err"
}
sqlx() { psql "$PGURL" -At -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
echo "# gate packs on a real stack: sequence $SEQ: $STAGES"
n0=$(sqlx "select count(*) from supabase_migrations.schema_migrations"); m0=$(sqlx "select max(version) from supabase_migrations.schema_migrations")
[ "$n0" = "$(pj "$PKG/PLAN.json" 'd["hosted_before_step_1"]["rows"]')" ] && [ "$m0" = 0257 ] && ok "the stack is hosted-shaped: $n0 history rows, max $m0" || { bad "the stack is not hosted-shaped" "rows=$n0 max=$m0"; echo "# RESULT: $pass passed, $fail failed"; exit 1; }
for S in $STAGES; do
  A=$PKG/$S/s1-apply-$S-online/s1-apply-$S-online.sh; V=$(pj "$PKG/$S/EXPECT.json" 'd["migration"][:4]'); GATES=$(pj "$PKG/$S/EXPECT.json" 'd["content_gates"]')
  W=$OUT/$S; mkdir -p "$W/pre" "$W/post"
  sed -n "/^cat > \"\$ONLINE\/rule.js\" <<'JS'\$/,/^JS\$/p" "$A" | sed '1d;$d' > "$W/rule.js"
  sed -n "/<<'NODE'\$/,/^NODE\$/p" "$PKG/$S/window-reads-s1-$S/window-s1read-$S.sh" | sed '1d;$d' > "$W/check.mjs"
  [ -s "$W/rule.js" ] && [ -s "$W/check.mjs" ] || { bad "step $V ($S): the generated rule program or read-back program was not found"; continue; }
  # ---- PRE
  prefail=0
  for pair in "g02-history-$S:g02" "g12-$S-preflight-$S:g12" "s1-open-transactions-$S:open" "w03-table-sizes-$S:w03"; do
    f=${pair%%:*}; r=${pair##*:}; [ -f "$PKG/$S/window-reads-$S/$f.sql" ] || continue
    if ! runq "$PKG/$S/window-reads-$S/$f.sql" "$W/pre/$f.json"; then prefail=1; bad "step $V ($S): PRE read $f failed to run" "$(head -c 300 "$W/pre/$f.json.err")"; continue; fi
    o=$(node "$W/rule.js" "$r" "$W/pre/$f.json" 2>&1 </dev/null) && ok "step $V ($S): PRE $r: ${o#PASS }" || { prefail=1; bad "step $V ($S): PRE $r refused" "$o"; }
  done
  [ $prefail = 0 ] || { bad "step $V ($S): not applied (a PRE gate failed)"; break; }
  # ---- PUSH: the stage's own bundle replaces supabase/migrations; the pinned CLI applies exactly what is unapplied (include-all, as the stage does for a below-head file)
  rm -rf supabase/migrations && tar -xf "$PKG/$S/s1-apply-$S-online/migrations-stage$S.tar" -C . && [ "$(ls supabase/migrations | wc -l | tr -d ' ')" = "$(pj "$PKG/$S/EXPECT.json" 'd["bundle"]["files"]')" ] || { bad "step $V ($S): bundle extraction"; break; }
  flags=--local; [ "$(pj "$PKG/$S/EXPECT.json" 'd["include_all"]')" = True ] && flags="--local --include-all"
  dry=$(supabase db push $flags --dry-run 2>&1) || { bad "step $V ($S): dry run failed" "$(echo "$dry" | tail -3)"; break; }
  [ "$(echo "$dry" | grep -cE '^ *[0-9]{4}_')" = 1 ] && echo "$dry" | grep -q "$(pj "$PKG/$S/EXPECT.json" 'd["migration"]')" && ok "step $V ($S): the dry run lists exactly the step's one migration" || { bad "step $V ($S): the dry run does not list exactly one migration" "$dry"; break; }
  supabase db push $flags --yes > "$W/push.log" 2>&1 || { bad "step $V ($S): push failed" "$(tail -5 "$W/push.log")"; break; }
  # ---- POST
  postfail=0
  readback() { # readback LABEL: run every read-back file, then the generated node program; prints its verdict; returns its status
    local f
    for f in $(ls "$PKG/$S/window-reads-s1-$S" | grep -E '\.sql$' | sed 's/\.sql$//'); do runq "$PKG/$S/window-reads-s1-$S/$f.sql" "$W/post/$f.json" || { echo "READ FAILED $f: $(head -c 300 "$W/post/$f.json.err")"; return 2; }; done
    A_RES="$W/post" node "$W/check.mjs" 2>&1
  }
  o=$(readback); rc=$?
  if [ $rc = 0 ] && echo "$o" | grep -Fxq "$(pj "$PKG/$S/EXPECT.json" 'd["pins"]["overall"]')"; then ok "step $V ($S): POST read-back OVERALL PASS ($(echo "$o" | grep -c '^PASS') checks)"; else postfail=1; bad "step $V ($S): POST read-back" "rc=$rc $(echo "$o" | tail -4)"; fi
  [ "$(sqlx "select count(*) from supabase_migrations.schema_migrations where version = '$V'")" = 1 ] && ok "step $V ($S): history holds $V once" || bad "step $V ($S): history"
  # ---- MUTATION CONTROLS (only for steps that carry a content-gate pack)
  [ "$GATES" = True ] || continue
  mut() { # mut NAME 'apply sql' 'revert sql' : the read-back must FAIL while the change is in place and PASS again once reverted
    local name=$1 up=$2 down=$3 o2 rc2
    sqlx "$up" > "$W/mut.log" || { bad "step $V ($S): mutation '$name' could not be made" "$(tail -2 "$W/mut.log")"; return; }
    o2=$(readback); rc2=$?
    if [ $rc2 != 0 ] && ! echo "$o2" | grep -q "OVERALL PASS" && echo "$o2" | grep -q "FAIL"; then ok "step $V ($S): MUTATION '$name': the read-back REFUSES it"; else bad "step $V ($S): MUTATION '$name' was accepted by the read-back" "rc=$rc2 $(echo "$o2" | tail -3)"; fi
    sqlx "$down" > "$W/mut.log" || bad "step $V ($S): mutation '$name' could not be reverted" "$(tail -2 "$W/mut.log")"
    o2=$(readback); rc2=$?
    [ $rc2 = 0 ] && echo "$o2" | grep -q "OVERALL PASS" && ok "step $V ($S):   ... reverted, the read-back passes again" || bad "step $V ($S): after reverting '$name' the read-back does not pass" "$(echo "$o2" | tail -3)"
  }
  case "$V" in
    0253) mut "a permissive studio-wide INSERT policy on studio_blockouts" "create policy zz_mut on public.studio_blockouts for insert to authenticated with check (true)" "drop policy zz_mut on public.studio_blockouts"
          mut "the old member FOR ALL policy back on studio_blockouts" "create policy studio_blockouts_member_all on public.studio_blockouts for all to authenticated using (true)" "drop policy studio_blockouts_member_all on public.studio_blockouts"
          mut "execute on the decision function granted to anon" "grant execute on function public.member_owns_scoped_timed_block(uuid, uuid) to anon" "revoke execute on function public.member_owns_scoped_timed_block(uuid, uuid) from anon" ;;
    0258) mut "DELETE granted on client_legal_identities" "grant delete on public.client_legal_identities to authenticated" "revoke delete on public.client_legal_identities from authenticated"
          mut "a DELETE policy on client_legal_identities" "create policy zz_mut on public.client_legal_identities for delete to authenticated using (true)" "drop policy zz_mut on public.client_legal_identities"
          mut "service_role granted SELECT on client_legal_identities" "grant select on public.client_legal_identities to service_role" "revoke select on public.client_legal_identities from service_role"
          mut "the predicate executable by anon" "grant execute on function public.can_use_client_legal_identity(uuid) to anon" "revoke execute on function public.can_use_client_legal_identity(uuid) from anon" ;;
    0266) mut "INSERT granted on studio_legal_name_access" "grant insert on public.studio_legal_name_access to authenticated" "revoke insert on public.studio_legal_name_access from authenticated"
          mut "an ALL policy on client_legal_name_access_audit" "create policy zz_mut on public.client_legal_name_access_audit for all to authenticated using (true)" "drop policy zz_mut on public.client_legal_name_access_audit"
          mut "service_role granted SELECT on client_legal_name_access_audit" "grant select on public.client_legal_name_access_audit to service_role" "revoke select on public.client_legal_name_access_audit from service_role"
          mut "the old receptionist_client_contacts executable by authenticated again" "grant execute on function public.receptionist_client_contacts(uuid, text, integer) to authenticated" "revoke execute on function public.receptionist_client_contacts(uuid, text, integer) from authenticated" ;;
    0271) mut "a permissive INSERT policy on realtime.messages" "create policy zz_mut on realtime.messages for insert to authenticated with check (true)" "drop policy zz_mut on realtime.messages"
          mut "a third policy on realtime.messages (a public SELECT)" "create policy zz_mut2 on realtime.messages for select to anon using (true)" "drop policy zz_mut2 on realtime.messages"
          mut "emit_schedule_signal executable by authenticated" "grant execute on function public.emit_schedule_signal() to authenticated" "revoke execute on function public.emit_schedule_signal() from authenticated" ;;
  esac
done
n1=$(sqlx "select count(*) from supabase_migrations.schema_migrations"); echo "# final history rows: $n1"
echo "# RESULT: $pass passed, $fail failed"
[ $fail = 0 ]
