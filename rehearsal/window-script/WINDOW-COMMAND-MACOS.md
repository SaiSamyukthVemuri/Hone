# Window commands, macOS: S0a and row 4 (two scripts, no paste blocks)

Two scripts replace every paste block. Nothing in this document is pasted into a shell except the one download line below, which holds no secret and no project ref. Neither script makes a hosted call except `window-s0a.sh`'s own read-only `db query --linked`, which the window already authorizes. `window-row4.sh` makes no hosted call at all.

| Script | sha256 | When |
|---|---|---|
| `window-s0a.sh` | `02290ee14ccb23bfb0629672191ee888e82d2b672aedb86de31c9467cc9aadc5` | the S0a reads and comparison |
| `window-row4.sh` | `1bc452a5b8c530576f0a42df6f31195c98f9402827f1b723801df4e0ea607386` | row 4, immediately before S1, after S0a passed |

**The S0a `OVERALL PASS` does not cover the row-4 bracket** (the selected pre-migration restore point and a fresh PITR reading). The GO table requires both: S0a passed, and row 4 passed immediately before S1. Neither replaces the other.

Pinned (the scripts re-check every one of these before doing anything): comparator entry `147b5c67aa78ef80621c64eefe86755916d58dec284fdbe69f943348f8ba6058`, comparator lib `636bd85d5863df8aa6e852f7c35f837b47551c17ed1ec75f5c5d14403b6d3fe9`, baseline `BASELINE-W1-MACOS-CANDIDATE-3.json` `efc94a51f02bd2116a806229c8910b9ac48c2e5da6c0ff6556a3671e957301dd`, G3 checksums file `G3-CHECKSUMS-d189768b.txt` `bbdcd917da77f750f7987d6a5fdca172c6a564fc029d10d19a6ae1e51190f0f6`, plus the runner, manifest and 14 gate files from the earlier install (unchanged).

## 0. Before the window
- **Sync the Mac clock** (System Settings > General > Date & Time > "Set time and date automatically" on). The selected restore point and the reading time are stamped from the Mac clock, while the latest recovery point is the provider's: a Mac that runs slow by minutes could understate the selected time (a fast Mac only makes row 4 stricter).
- **Pre-window read-only look at the PITR panel (a decision for Sam, no script, nothing written).** On the dashboard (Database > Backups > Point in Time, and the Scheduled backups tab) confirm that each of the nine facts the scripts ask for is visible: PITR enabled, retention, earliest and latest recovery point, the latest base backup's status and completion time, and which source each came from. Also note whether the base backup's completion time is **not after the latest recovery point** (the comparator refuses a base backup newer than the latest recovery point, a rule with no live evidence yet). If a field is not shown, or the base backup time is after the latest recovery point, the comparator would refuse a healthy state. Then the decision is Sam's: (a) drop that one rule (keep "base backup not after the reading") as a one-line comparator change with its mutation test and a new set of hashes, or (b) take the base-backup facts from the management API only (`base_backup_source` management_api). The comparator has NOT been changed for this.

## 1. Download (once; fail-closed; stage, verify, then install)
Needs `~/hone-s1/window-reads` from the earlier install. Paste this one line (no comment, no secret, no project ref):

    ( set -u; S=$(mktemp -d) && D=sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/machines/window-reads && scp -q "$D/window-s0a.sh" "$D/window-row4.sh" "$D/BASELINE-W1-MACOS-CANDIDATE-3.json" "$D/G3-CHECKSUMS-d189768b.txt" "$D/compare-preflight.mjs" "$D/compare-preflight-lib.mjs" "$S/" && for p in window-s0a.sh:02290ee14ccb23bfb0629672191ee888e82d2b672aedb86de31c9467cc9aadc5 window-row4.sh:1bc452a5b8c530576f0a42df6f31195c98f9402827f1b723801df4e0ea607386 BASELINE-W1-MACOS-CANDIDATE-3.json:efc94a51f02bd2116a806229c8910b9ac48c2e5da6c0ff6556a3671e957301dd G3-CHECKSUMS-d189768b.txt:bbdcd917da77f750f7987d6a5fdca172c6a564fc029d10d19a6ae1e51190f0f6 compare-preflight.mjs:147b5c67aa78ef80621c64eefe86755916d58dec284fdbe69f943348f8ba6058 compare-preflight-lib.mjs:636bd85d5863df8aa6e852f7c35f837b47551c17ed1ec75f5c5d14403b6d3fe9; do [ "$(shasum -a 256 "$S/${p%%:*}" | cut -d" " -f1)" = "${p#*:}" ] || { echo "STOP: sha256 mismatch for ${p%%:*}"; exit 1; }; done && [ -d "$HOME/hone-s1/window-reads" ] && for f in window-s0a.sh window-row4.sh BASELINE-W1-MACOS-CANDIDATE-3.json G3-CHECKSUMS-d189768b.txt compare-preflight.mjs compare-preflight-lib.mjs; do cp "$S/$f" "$HOME/hone-s1/window-reads/$f" || exit 1; done && chmod 0755 "$HOME/hone-s1/window-reads/window-s0a.sh" "$HOME/hone-s1/window-reads/window-row4.sh" && echo "window-s0a.sh, window-row4.sh, baseline 3, G3 file and comparator: sha256 OK, installed" ) || echo "STOP: download, sha256 check or install failed; run nothing"

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
| Recovery range read from | `dashboard` or `management_api` |
| R-6 choice, answer, reference | `S0b` or `accept_rpo`; one line in your words; the decision reference |
| 0242 disposition and reference | `bridge_ready` or `R-3`; the reference |

The reading time (`read_at_utc`) is not typed: the script stamps it from the Mac clock when you answer the last PITR prompt (the earliest and latest recovery points stay typed, in UTC). Nothing is defaulted, and an empty or malformed answer stops the script before any hosted read. Not typed: the head (a constant) and its 34 checksums (the pinned G3 file, compared by the comparator to the baseline's 34), the project ref hash (from the constant), the hold times, `denial_files` and `runner_refusals`.

Hidden prompts (typed, never shown or written, set only inside the runner subshell and cleared on exit): the Supabase access token, then the database password.

## 3. Row 4 (immediately before S1)
Run it **only after `window-s0a.sh` printed `OVERALL PASS` in this same window**, and when the holds are in place and the last read-only checks are done.

    /bin/bash ~/hone-s1/window-reads/window-row4.sh

It refuses before selecting anything if **fewer than 90 minutes of the window remain**, and checks again the moment you type `ready` (so a long wait cannot leave S1 with less than 90 minutes: it stops with "do not start S1"). The 90 is OPS's derivation of what follows row 4: S1 about 15, read-back 10, staged smoke and promote 10, post-promote watch 35, export guard down 5, lifting the holds and the S4 record 15. It asks for the window, then you type `select`: **the script stamps the selected pre-migration restore point as the time now** and prints it, with a deadline 30 minutes later.

Then you **wait** (do not select again): wait until the dashboard's latest recovery point is **at or after the stamped time**. On a quiet database expect about 15 minutes, because the latest recovery point trails the clock (Sam's 01:54Z reading showed it 14.5 min behind). **Refresh the dashboard page before you read it** (a page left open can show an old recovery range: the script cannot tell a stale page from a quiet database beyond its 30-minute lag rule). Only then type `ready` (or `abort`), and answer the reading below, all before the deadline. Same UTC and EDT conversion as above; the basis is `latest_at_or_after`, or `named_restore_point` (with its name, status exactly `AVAILABLE` and completed-at time, which must not precede the selection). The reading time is stamped by the script at your last answer, so it cannot predate the selection. It runs the comparator's `--stage row4` and exits 0 only on `OVERALL PASS`.

It passes only when: the selected point is not in the future, inside the window and not older than 30 min; the latest recovery point is **at or after the selected point**; the earliest recovery point reaches back at least 5 min before it; PITR is on with at least 7 days' retention; the latest base backup is COMPLETED and not after the latest recovery point. (The reading time is stamped by the script after the selection, so it is fresh and later than the selection by construction.)

**If it is still behind after about 25 minutes**, stop: the named restore point route is a provider write and needs Sam's explicit authorization (or a recorded manual substitution decision outside the comparator). **If 30 minutes pass after the selection** (the script says so when you type `ready` too late), stop and run row 4 again from the start. A refusal never loops or retries inside the script, and S1 is not started on a refusal.

**After a row-4 `OVERALL PASS`, start S1 within 10 minutes** (the script prints the time). If more time passes, run row 4 again from the start: the selected restore point is the point a restore would target, and the longer S1 waits the more the point ages against the holds.

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
