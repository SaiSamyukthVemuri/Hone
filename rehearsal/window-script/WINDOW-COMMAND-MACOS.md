# Window commands, macOS: S0a and row 4 (two scripts, no paste blocks)

Two scripts replace every paste block. Nothing in this document is pasted into a shell except the one download line below, which holds no secret and no project ref. Neither script makes a hosted call except `window-s0a.sh`'s own read-only `db query --linked`, which the window already authorizes. `window-row4.sh` makes no hosted call at all.

| Script | sha256 | When |
|---|---|---|
| `window-s0a.sh` | `13f4c5ee2e9fe437181db3f85071f595e4a0c85e93d65c510888ddd4114e62ba` | the S0a reads and comparison |
| `window-row4.sh` | `11b0a46c8dfe268e23baabd02d74ac610ca1fa95b5f112a8d62c2f06fa79e4ed` | row 4, immediately before S1, after S0a passed |

**The S0a `OVERALL PASS` does not cover the row-4 bracket** (the selected pre-migration restore point and a fresh PITR reading). The GO table requires both: S0a passed, and row 4 passed immediately before S1. Neither replaces the other.

Pinned (the scripts re-check every one of these before doing anything): comparator entry `147b5c67aa78ef80621c64eefe86755916d58dec284fdbe69f943348f8ba6058`, comparator lib `636bd85d5863df8aa6e852f7c35f837b47551c17ed1ec75f5c5d14403b6d3fe9`, baseline `BASELINE-W1-MACOS-CANDIDATE-3.json` `efc94a51f02bd2116a806229c8910b9ac48c2e5da6c0ff6556a3671e957301dd`, G3 checksums file `G3-CHECKSUMS-d189768b.txt` `bbdcd917da77f750f7987d6a5fdca172c6a564fc029d10d19a6ae1e51190f0f6`, plus the runner, manifest and 14 gate files from the earlier install (unchanged).

## 1. Download (once; fail-closed; stage, verify, then install)
Needs `~/hone-s1/window-reads` from the earlier install. Paste this one line (no comment, no secret, no project ref):

    ( set -u; S=$(mktemp -d) && D=sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/machines/window-reads && scp -q "$D/window-s0a.sh" "$D/window-row4.sh" "$D/BASELINE-W1-MACOS-CANDIDATE-3.json" "$D/G3-CHECKSUMS-d189768b.txt" "$D/compare-preflight.mjs" "$D/compare-preflight-lib.mjs" "$S/" && for p in window-s0a.sh:13f4c5ee2e9fe437181db3f85071f595e4a0c85e93d65c510888ddd4114e62ba window-row4.sh:11b0a46c8dfe268e23baabd02d74ac610ca1fa95b5f112a8d62c2f06fa79e4ed BASELINE-W1-MACOS-CANDIDATE-3.json:efc94a51f02bd2116a806229c8910b9ac48c2e5da6c0ff6556a3671e957301dd G3-CHECKSUMS-d189768b.txt:bbdcd917da77f750f7987d6a5fdca172c6a564fc029d10d19a6ae1e51190f0f6 compare-preflight.mjs:147b5c67aa78ef80621c64eefe86755916d58dec284fdbe69f943348f8ba6058 compare-preflight-lib.mjs:636bd85d5863df8aa6e852f7c35f837b47551c17ed1ec75f5c5d14403b6d3fe9; do [ "$(shasum -a 256 "$S/${p%%:*}" | cut -d" " -f1)" = "${p#*:}" ] || { echo "STOP: sha256 mismatch for ${p%%:*}"; exit 1; }; done && [ -d "$HOME/hone-s1/window-reads" ] && for f in window-s0a.sh window-row4.sh BASELINE-W1-MACOS-CANDIDATE-3.json G3-CHECKSUMS-d189768b.txt compare-preflight.mjs compare-preflight-lib.mjs; do cp "$S/$f" "$HOME/hone-s1/window-reads/$f" || exit 1; done && chmod 0755 "$HOME/hone-s1/window-reads/window-s0a.sh" "$HOME/hone-s1/window-reads/window-row4.sh" && echo "window-s0a.sh, window-row4.sh, baseline 3, G3 file and comparator: sha256 OK, installed" ) || echo "STOP: download, sha256 check or install failed; run nothing"

It copies the six files to a private temporary directory, checks every sha256 above, and only then installs them together. Any failure prints STOP and the next step must not be run. (A copy that failed half way would be caught anyway: both scripts re-verify every pinned file before doing anything.)

## 2. S0a (at the window)
    /bin/bash ~/hone-s1/window-reads/window-s0a.sh

Run it in a fresh Terminal with nothing exported. It exits 0 only on the comparator's exact line `OVERALL PASS`; any other end prints STOP and exits non-zero. No retries: a refusal means start over, not continue.

In order: checks Darwin arm64, node >= 18 and shasum; verifies the sha256 of supabase-go, the runner, the manifest, the 14 gate files, the comparator entry and lib, the baseline and the G3 file; scans the environment by NAME ONLY (never a value); makes fresh 0700 directories; writes project-ref (a constant in the script), a byte-exact pooler-url and a fresh cli-latest; asks the questions below; runs the attestation rows (including the PITR reading) through the comparator BEFORE any hosted read; reads the two secrets; runs the 14 files one at a time (g02 first, which must show hosted max 0212 and none from 0213); runs the comparator and prints its verdict. Its last lines say the PASS does not cover row 4.

### What Sam types at S0a
Times are UTC, `YYYY-MM-DDTHH:MM:SSZ`. **The dashboard shows local time. Convert to UTC first: EDT is UTC-4 (add 4 hours); EST, from 2026-11-01, is UTC-5 (add 5 hours); if the sum passes midnight, add a day.** Example: 9:39:31 PM EDT on 25 Oct is `2026-10-26T01:39:31Z`. A time typed in local time without converting is refused: it reads as hours old (stale) or hours behind (lag), and the comparator fails S0-10 before any hosted read.

| Prompt | Type |
|---|---|
| Operator label | initials or a short label; no customer names |
| Window start / end | UTC; now must be inside it, outside 07:45 to 10:00 UTC, with at least the baseline's planned duration (110 min) remaining |
| Cron-job.org reminders paused | exactly `yes` (the script stamps the time) |
| People hold in place | exactly `yes` (the script stamps the time) |
| Maintenance flag decision | `no_flag` or `flag_on` |
| PITR enabled | exactly `true` |
| PITR retention in days | digits only, a whole number (7) |
| Earliest recovery point | UTC |
| Latest recovery point | UTC; not after the read time; within 30 min of it |
| Latest base backup status | exactly `COMPLETED` |
| Latest base backup completed at | UTC; not after the latest recovery point |
| Base backup read from | `dashboard` or `management_api` |
| Time you read the recovery range | UTC; not older than 60 min |
| Recovery range read from | `dashboard` or `management_api` |
| R-6 choice, answer, reference | `S0b` or `accept_rpo`; one line in your words; the decision reference |
| 0242 disposition and reference | `bridge_ready` or `R-3`; the reference |

Nothing is defaulted, and an empty or malformed answer stops the script before any hosted read. Not typed: the head (a constant) and its 34 checksums (the pinned G3 file, compared by the comparator to the baseline's 34), the project ref hash (from the constant), the hold times, `denial_files` and `runner_refusals`.

Hidden prompts (typed, never shown or written, set only inside the runner subshell and cleared on exit): the Supabase access token, then the database password.

## 3. Row 4 (immediately before S1)
    /bin/bash ~/hone-s1/window-reads/window-row4.sh

Do this only when the holds are in place and the last read-only checks are done. It asks for the window, then you type `select`: **the script stamps the selected pre-migration restore point as the time now**, writes it on screen, and only then asks for a NEW PITR reading (never the S0a one; each reading carries its own read time). The reading must be taken after the stamped time. Same field rules and the same UTC and EDT conversion as above, plus the basis: `latest_at_or_after`, or `named_restore_point` (with its name, status exactly `AVAILABLE` and completed-at time, which must not precede the selection). It runs the comparator's `--stage row4` and exits 0 only on `OVERALL PASS`.

It passes only when: the selected point is not in the future, inside the window and not older than 30 min; the reading is no older than 60 min and was taken after the selected point; the latest recovery point is **at or after the selected point**; the earliest recovery point reaches back at least 5 min before it; PITR is on with at least 7 days' retention; the latest base backup is COMPLETED and not after the latest recovery point.

**If the latest recovery point is behind the selected point** (a quiet database: Sam's 01:54Z reading showed the latest point 14.5 min behind), the script stops, prints the options and does NOT loop or retry: (1) wait, then run it again (it selects a new time); (2) with Sam's explicit authorization, a named restore point; (3) a recorded manual substitution decision outside the comparator. Do not start S1.

## 4. Thresholds (baseline candidate 3, `g4_pitr`)
| Threshold | Value | Why |
|---|---|---|
| min_retention_days | 7 | the intended minimum; Sam's reading shows 7 |
| earliest_margin_minutes | 5 | the window must reach back past the point it protects |
| max_latest_lag_minutes | **30** | Sam's reading lagged by 14.5 min on a quiet database, so 15 sat on the edge; 30 is about twice the evidence. It still refuses an archiver stalled for over half an hour, a stale dashboard page, and an unconverted EDT time. It is not the safety rule: the row-4 rule that the latest point is at or after the selected point holds however large the lag |
| max_read_age_minutes | 60 | the range moves; a reading must be fresh |
| max_pre_point_age_minutes | 30 | S1 must not be left waiting after the point was selected |
| planned_duration_minutes | 110 | OPS proposal pending Sam's Q1; one value, so a different answer is one value plus a re-pin |

## 5. After
Close the Terminal and revoke the access token. Results, attestation and verdict stay in the 0700 `~/hone-s1/window.<random>` (S0a) and `~/hone-s1/row4.<random>` (row 4) directories; they hold counts, ordinals, catalogue names and the typed reading only.

## 6. Not covered here
The S1 read-back compare (`compare-preflight.mjs --stage s1 ...`) is a separate step after S1, unchanged. A different baseline value needs a new baseline file, a new sha pinned in both scripts, new script shas and a fresh download line. Whether a restore would actually succeed, how long it takes and whether WAL has gaps are not readable here; only an S0b restore test shows them.
