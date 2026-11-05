# REHEARSAL - NEVER MERGE. Sourced by seq-check.sh when the plan is ONE group stage (Sam's option A: 0258, 0266, 0272 in ONE plain push).
# The negative controls that apply to a group: the file-set gates (stray, swapped, missing, altered, changed hosted), the pinned shas, the history gate with a
# member already applied, the declined second APPLY, and a failure injected at EACH member of the push (history stops there, the marker stays, nothing re-runs).
S1=$(echo $STAGES | cut -d' ' -f1)
PEND=$(ex $S1 '" ".join(d["pending_versions"])'); P1=$(echo $PEND | cut -d' ' -f1); P2=$(echo $PEND | cut -d' ' -f2); P3=$(echo $PEND | cut -d' ' -f3)
NOTHING="(files|holds|names|allowlist|sealed|differs|missing|not part|lines|pinned|sha)"
ctl() { # ctl HOME NAME ADD DROP ALT ALTV [PATTERN]
  newhome "$1"; install_step "$S1"; mkvb "$S1" "$3" "$4" "$5" "$6"; install_step "$S1" "$T/vb"; rm -f "$H/calls.log"; run_apply "$S1"
  expect_stop "$2" "${7:-$NOTHING}" "$(hist_rows)"
}
echo "# G. group negative controls"
ctl G1 "EXTRA FILE below the head (0255, the --include-all danger): STOP, nothing pushed" "0255_stray.sql" "" 0 ""
ctl G2 "EXTRA FILE above the head (0273): STOP, nothing pushed" "0273_stray.sql" "" 0 ""
ctl G3 "SWAPPED FILE (right count): 0255 added, 0001 dropped: STOP on the named-file gates" "0255_stray.sql" "0001" 0 ""
ctl G4 "SWAPPED FILE of an unlisted number (0158 added, 0001 dropped): STOP on the allowlist" "0158_stray.sql" "0001" 0 ""
ctl G5 "MISSING MEMBER $P1: STOP before any call" "" "$P1" 0 ""
ctl G6 "MISSING MEMBER $P2: STOP before any call" "" "$P2" 0 ""
ctl G7 "MISSING MEMBER $P3: STOP before any call" "" "$P3" 0 ""
ctl G8 "ALTERED MEMBER $P1 (sealed sha differs): STOP before any call" "" "" 1 ""
ctl G9 "ALTERED MEMBER $P2 (re-pinned consistently): STOP on the allowlist / sealed sha" "" "" 0 "$P2"
ctl G10 "ALTERED MEMBER $P3 (re-pinned consistently): STOP on the allowlist / sealed sha" "" "" 0 "$P3"
ctl G11 "CHANGED HOSTED FILE 0257 (re-pinned consistently): STOP" "" "" 0 "0257"
ctl G12 "MISSING HOSTED FILE 0001: STOP before any call" "" "0001" 0 ""
newhome G13; install_step "$S1"; echo x >> "$H/hone-s1/s1-apply-$S1-online/migrations-stage$S1.tar"; rm -f "$H/calls.log"; run_apply "$S1"; expect_stop "WRONG SHA: the bundle tar changed after pinning: STOP before any call" "(sha256|sha|differs|pinned)" "$(hist_rows)"
newhome G14; install_step "$S1"; echo x >> "$H/hone-s1/s1-apply-$S1-online/MIGRATIONS-stage$S1.sha256"; rm -f "$H/calls.log"; run_apply "$S1"; expect_stop "WRONG SHA: the bundle list changed after pinning: STOP before any call" "(sha256|sha|differs|pinned)" "$(hist_rows)"
# history gate: a member already applied, and a hosted version missing
newhome G15; install_step "$S1"; echo "$P1" >> "$H/remote-history"; rm -f "$H/calls.log"; run_apply "$S1"; expect_stop "HISTORY: $P1 already applied (a partial earlier run): STOP at the history gate, nothing pushed" "(history|already applied|applied_count|expected)" "$(hist_rows)"
newhome G16; install_step "$S1"; sed -i.bak '/^0001$/d' "$H/remote-history"; rm -f "$H/remote-history.bak" "$H/calls.log"; run_apply "$S1"; expect_stop "HISTORY: a hosted version missing (248 rows): STOP at the history gate, nothing pushed" "(history|applied_count|expected|version set)" "$(hist_rows)"
# the second APPLY declined
newhome G17; install_step "$S1"; rm -f "$H/calls.log"; runscript "$H/hone-s1/s1-apply-$S1-online/s1-apply-$S1-online.sh" APPLY "$CTOK" "$CPW" NO "$CTOK" "$CPW"; before=$(hist_rows)
[ $RC != 0 ] && [ "$(receipt_of)" = "NOT APPLIED" ] && [ "$(marker)" = none ] && ! grep -q '^push' "$H/calls.log" && [ "$(hist_rows)" = "$before" ] && [ -z "$(leaks)" ] \
  && ok "SECOND APPLY declined after the dry-run listing: NOTHING pushed, receipt NOT APPLIED, no marker, history unchanged" || bad "G17 second apply declined" "rc=$RC calls=[$(calls)] receipt=$(receipt_of) marker=$(marker)"
# a failure injected at EACH member: history stops before it, the marker stays IN-FLIGHT, the script cannot be re-run (no retry path)
for pair in "$P1:249" "$P2:250" "$P3:251"; do
  v=${pair%%:*}; want=${pair##*:}
  newhome "G18-$v"; install_step "$S1"; cfgset "FAIL_PUSH_VER=$v"; rm -f "$H/calls.log"; run_apply "$S1"
  [ $RC != 0 ] && [ "$(marker)" = IN-FLIGHT ] && receipt_of | grep -q "^UNKNOWN" && [ "$(hist_rows)" = "$want" ] && [ "$(grep -c '^push' "$H/calls.log")" = 1 ] && ! grep -q "^$v\$" "$H/remote-history" \
    && ok "FAILURE AT $v: the push failed; history stopped at $want rows (the members before it stay applied, $v did not); receipt UNKNOWN; marker IN-FLIGHT; exactly one push, no retry" || bad "G18 failure at $v" "rc=$RC marker=$(marker) receipt=$(receipt_of) rows=$(hist_rows)/$want $(echo "$OUT" | tail -3)"
  install_step "$S1"; rm -f "$H/calls.log"; run_apply "$S1"
  [ $RC != 0 ] && echo "$OUT" | grep -q "STOP: a previous run left .*APPLY-STATE" && [ "$(calls)" = "" ] && [ "$CONSUMED" = 0 ] \
    && ok "  ... and the stage cannot be re-run: the surviving marker refuses it, no prompt, no call" || bad "G18 rerun after failure at $v" "rc=$RC calls=[$(calls)] $(echo "$OUT" | tail -2)"
done
# --include-all is nowhere in the executable text of the apply script (option A is a plain push)
grep -v '^ *#' "$PKG/$S1/s1-apply-$S1-online/s1-apply-$S1-online.sh" | grep -Ev '^ *(echo|printf) ' | grep -q -- '--include-all' && bad "the apply script's executable text contains --include-all" || ok "no --include-all in the apply script's executable text (plain push)"
echo "# RESULT: $pass passed, $fail failed"; [ $fail = 0 ]; exit
