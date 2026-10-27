# release-apply.sh versus the reviewed s1-apply.sh 2dfd3354: every delta

| # | s1-apply.sh (macOS, interactive) | release-apply.sh (Linux, launcher) | Why |
|---|---|---|---|
| 1 | Darwin arm64 check | Linux check; `sha256sum`, `flock`, `setsid`, `stat -c` | the VPS is Linux |
| 2 | supabase-go dce26b75 under `~/hone-s1` | linux_amd64 inner sha 174a90e2 under `/usr/local/libexec/hone-release/bin` (root-owned) | platform |
| 3 | bundle/list/head/GO34 pinned INSIDE the script | bundle sha, list sha, head (the commit id in the tar's own git header), project ref, target URL, first/last/count and expiry come from the ROOT-written `/etc/hone-release/APPROVED-PACKAGE`; the script has no package pin | a routine release needs a per-stage approval that only root can write |
| 4 | bundle read from the script's directory | bundle and list copied from the inbox into a private 0700 work dir FIRST, then hashed (the copy) | the inbox is agent-writable: no TOCTOU |
| 5 | the 34 expected files from an embedded GO list | the pending set is the list lines from `first` to `last`, and their number must equal the approved `count`; the list must end at `last` and name nothing above it | generic for any package; 0247+ cannot slip in |
| 6 | password typed with `read -rs` from /dev/tty | password on fd 3, opened by the launcher from a 0600 file; never argv or environment; only the one CLI child gets `PGPASSWORD` (same prefix pattern as the rehearsed script) | non-interactive |
| 7 | restore point typed, checked against the row-4 result; `yes`/`APPLY` typed; window arithmetic | **none of these is a control here.** The root approval is the control. `recovery_attestation` is root's text, recorded in the run record, **NOT verified**. `watchdog` must be exactly `waived-by-approver` (recorded); any other value is refused because watchdog readiness is not enforced by this script (Machines E3). Row-4 / restore-point freshness (E4) is **not covered**; the approval's `expires_at` is the only time bound | a typed keystroke through sudo is not a control |
| 8 | tombstone file `FAILED-LOGIN` in `~/hone-s1/s1-apply` | the same rule as a state word `FAILED-LOGIN` in `/var/lib/hone-release/state/APPLY-STATE` | one durable state |
| 9 | no lock, no durable marker | `flock` on `state/lock` (held through the push, inherited by the CLI), a **durable fsync'd IN-FLIGHT marker written before the push**, replaced by APPLIED or FAILED after; the next run refuses unless the state is absent or APPLIED; the approval is consumed (`state/consumed/<id>`, `mkdir` is atomic) before the push, so it is single-use | a killed process releases a lock, so the lock alone cannot say "outcome unknown" |
| 10 | the CLI shares the terminal's signals | the push runs under `setsid -w` with INT/TERM/HUP ignored by the script | the runbook: never signal the CLI mid-statement |
| 11 | prints to the operator's terminal | the same masked tails (url, user=, host=, quoted user/role, *.supabase.com); no secret is ever read into a printed variable | |
| 12 | `scan_log`, ONE dry run, ONE push, exact 34 in order, finish line, exit 0 | unchanged in logic (count and names come from the approval) | |

Unchanged on purpose: URL rules (port 5432 pooler, user only, `sslmode=require`, no password parameter, never 6543), seeded `cli-latest`, `SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=false`, telemetry off, the login-role / unban / ban log scan, no retry of any step.
