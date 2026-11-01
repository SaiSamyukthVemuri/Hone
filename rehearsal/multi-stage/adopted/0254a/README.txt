PREPARATION ONLY / HELD. 0254 AFTER 0257 (include-all). Not approved. Do not run.

Valid only when 0257 is already hosted (hosted history 247 rows, max 0257) and 0254 is still unapplied, and only after Sam separately approves 0254's exact changes.
It is built from the reviewed 0254 online package (apply d966c055, reconcile 6d6832bf, g02 read 870cbba5) with ONE mechanical change: 0254 is BELOW the hosted max (0257), so a plain push
refuses it; the dry run and the push carry `--include-all` (the flag set proven in rehearsal #1263, run 40845875745).

--include-all takes every unapplied file in the directory, so the bundle is the control: it holds the hosted files 0001..0246, 0248 and 0257 as hosted, plus the sealed 0254 (248 files);
0247, 0249..0253, 0255 and 0256 are absent. The apply script refuses any extra or missing file, requires the hosted 0257 file by name and sha256, and requires the dry run to list EXACTLY 0254.
Expected history 247 rows -> 248 rows, max stays 0257, 0254 exactly once, 0247 absent.

Every file and directory carries the suffix 0254a so it can never be mistaken for the forward package (01-ops/stage-0254-mac, valid only if 0254 precedes 0257).
Contents: s1-apply-0254a-online/, window-reads-0254a/, window-reads-s1-0254a/, runner/ (+ stages/0254a.conf), install-0254a-online.sh, SHA256SUMS.txt.
Rehearsal evidence: see machines/STAGE-0257-ONLINE-END.json (part2).

---- v2 (team/stage-0254a-v2; the 01-ops copy is unchanged and is the version Insurance reviewed) ----
CHANGES vs the reviewed v1 (every changed file is re-pinned; Insurance's review is void for these and needs a short delta):
 Z1  s1-apply-0254a-online.sh: HEAD_SHA is now 464ac549... = the #1226 head whose supabase/migrations tree is BYTE-EQUAL to the 248-file bundle (checked file by file, 0 differ). Label and the 0254 comment corrected. No gate reads HEAD_SHA.
 Z2  the g02 rule also asserts rows_0248 = 1 and last4 = '0257,0248,0246,0245' (the SQL and its pin are unchanged; it already returned both).
 Z4  after the dry run the script SHOWS the listing and asks for a SECOND, separate APPLY before the marker and the push. The first APPLY starts only the reads and the dry run (no write).
     The one-command runner supports an optional second approve prompt (credentials still typed once). runner/stages/0254a.conf lists it as the 4th prompt.
 Pins that moved: s1-apply-0254a-online.sh (cecb27bd), runner/hone-stage-run.sh (cf6b71b4), runner/run.exp (5013adc3), runner/stages/0254a.conf (2428cc78). All other 17 pins are byte-identical to v1 (bundle cb781e43, list 446b637c, reconcile ecfb2d3b, read-back e2313ac8).
 Z3  Z3-RECORD-PLAN.txt: the repository record after the apply and the lists for the later stages. #1226 was refreshed onto production (head 464ac549).
Still true: PREPARATION ONLY / HELD. No approval sentence is written here. install-0254a-online.sh embeds the new 21-line set (it is not itself one of the 21).

---- v2.1 (Insurance PEER-0254A-V2-DELTA conditions V2, V3, V4; ONE re-pin) ----
 V2  the second APPLY wait is bounded to 10 minutes (read -t 600). A timeout or end of input is a decline: PUSHSTATE=none, the password and token are cleared, the script exits NOT APPLIED. The prompt text says "10 minutes at most" (manifest line 18 matches).
 V3  the dry-run summary shown at the second prompt is piped through the same mask function as the failure path.
 V4  the runner (hone-stage-run.sh) refuses a manifest whose second approve is not listed after the access-token and password prompts; run.exp tolerates a late answer to a stage that gave up waiting. CI: #1262 head 94ab2056.
 New pins (4 changed again): s1-apply-0254a-online.sh 3255594171f7..., runner/hone-stage-run.sh c2e92c9570ca..., runner/run.exp 5b453f6f6d33..., runner/stages/0254a.conf 82573fa9b044... (full values in SHA256SUMS.txt). The other 17 are unchanged.
 V1 (a real rehearsal of this script) is Machines' combined rehearsal, which runs the REAL v2.1 apply script as step 1.
