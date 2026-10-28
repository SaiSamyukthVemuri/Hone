# HON66-ONE-COMMAND-STAGE: design, prompt table, and the PITR blocker (REHEARSAL, NEVER MERGE)

Draft only. Nothing here has run against the hosted project. The runner is exercised in CI against STUBS and a fake CLI with canary credentials.

## What it is

`hone-stage-run.sh PLAN` is the one Mac entry point for stage 0248. It runs the **pinned, byte-identical** reviewed scripts (no change to any of them, so
Machines' pins and Insurance's clearances stay valid) through a pty (`phase.exp`, `/usr/bin/expect`, which macOS ships). Each child reads its answers from
`/dev/tty`; the driver answers each prompt by exact text and in order, and **a prompt that is not in the table is a STOP**.

Flow: pins -> plan + sha256 -> two hold answers (yes/no) -> `approve`/`decline` -> token and password once, hidden -> PITR capture -> S0a ->
row 4 (select, bounded wait on the API capture) -> role setting (capture, apply, verify on a new pooler session) -> apply (dry run, watchdog started by the
runner, one push) -> read-back -> restore the role setting -> ONE result block.

Reused unchanged (full sha256 pins in the runner, re-checked after the approval): `pitr-backups.sh` 85407d0b, `window-row4.sh` 0fd4fbe4, `window-s0a-0248.sh`
234eb726, `s1-apply-0248.sh` a31e048b, `s1-reconcile-0248.sh` 91bbee68, `window-s1read-0248.sh` 6c96ff3b, `d3-watchdog.zsh` 1011530f, `supabase-go` dce26b75.
`reference/` holds byte-identical copies of the children so CI can assert that every prompt the runner types is a real prompt of the pinned child.

## Every prompt, and where its value comes from

| Child | Prompt (abridged) | Source |
|---|---|---|
| pitr-backups | access token | typed once to the runner, hidden |
| S0a | Operator label; Maintenance flag; PITR retention days; R-6 choice, text, reference | the **plan** (sha-bound, shown at approval) |
| S0a | Window start, window end | the plan |
| S0a | PITR enabled; earliest / latest recovery point | the **Management API capture** (`backups.json`, sidecar-bound) |
| S0a | Cron-job.org reminders paused; People hold in place | **owner-confirmed yes/no** before the approval (no API exists) |
| S0a | Use the idle proof | fixed `no` (see the blocker) |
| S0a | R-6 acknowledgement | the fixed sentence the script requires; the plan carries the R-6 decision |
| S0a | access token, database password | typed once to the runner, hidden |
| row 4 | Window start / end | the plan |
| row 4 | `select` | the runner, once, after S0a PASS |
| row 4 | `ready` / `abort` | the runner: `ready` only when a capture taken after the selection shows latest >= selection, else `abort` at the limit |
| row 4 | Basis | fixed `latest_at_or_after` (the idle and named-restore-point bases are never chosen) |
| row 4 | PITR enabled / retention / earliest / latest | API capture and the plan |
| apply | Window start / end | the plan |
| apply | restore point | **row 4's own stamp** (`Selected pre-migration restore point: ...`), read from its output |
| apply | database password | typed once, hidden |
| apply | WATCHDOG armed / watching (yes, yes) | typed **only after** the runner started `d3-watchdog.zsh` itself and read both of its own lines; never a blind yes |
| apply | `APPLY` | the runner, only after the approval, the post-approval pin re-check and the verified role setting |
| watchdog | database password (a silent `read -rs`) | typed once, hidden, only after terminal echo is off |
| s1read | access token, database password | typed once, hidden |

**Owner-typed: only** the two hold confirmations, `approve`/`decline`, the token and the password. Nothing is copied between a dashboard and a script.
Not machine-sourced and therefore plan inputs written before approval: R-6 decision text/reference, PITR retention days (the API capture does not report it),
the maintenance-flag decision. They are printed in the plan and covered by its sha256.

## The temporary role setting (a NEW route: needs its own approval sentence)

Capture `rolconfig` -> `ALTER ROLE postgres SET statement_timeout` -> verify in the catalog **and** through a new pooler session -> push -> restore the captured
original -> read it back. The restore runs from the exit trap on every exit path (normal, STOP, interrupt, UNKNOWN). A restore that does not read back is
reported as **SETTING NOT RESTORED** on whatever outcome is printed, never folded into APPLIED+VERIFIED. A trap cannot catch SIGKILL, sleep or power loss, so
the capture is also written to `ROLE-STATE`, and the next run **refuses to start** while that file exists. Credentials are cleared after the restore, not before.

Unverified against the real binary: the output format of `supabase-go db query -o json` (the runner reads the first scalar), and whether a new pooler session
reads the new value (the MAC-PATH rehearsal found held backends keep the old value; this runner stops and restores if the new session does not read it).
The rehearsal that proved the role-level control used `psql`, not `db query`.

The approval sentence is generated from the plan sha256 and printed with the plan. **Typing `approve` is not Sam's approval of that route**; Sam and Insurance decide
the sentence separately (OPEN).

## The known blocker, stated first

**As built, this runner STOPS on a quiet database.** Row 4 requires the latest recovery point to reach the selection time; the runner waits (poll every 60 s, up
to 25 minutes) and then aborts with nothing pushed. It does not heartbeat, does not create a named restore point and makes no provider write other than the role setting.

Evidence (CHECKPOINT):
- 27 Oct: `T_SEL` 01:38:56Z; the capture at 01:43:46Z showed latest 01:18:33Z; at 01:55:46Z still 01:18:33Z (37 minutes behind). The only reviewed WAL-forcing step, a
  named restore point, returned HTTP 400 "This endpoint is unavailable at the moment".
- 28 Oct: capture 23:00:26Z latest 22:54:16Z; `T_SEL` 23:14:16Z; latest still 22:54:16Z at 23:19. Row 4 aborted, NOT APPLIED.
- The latest point moved in steps on 26/27 Oct when the database was written (reminders running): the provider's latest recovery point advances when WAL is archived.

Options for Insurance and Sam (none is the default; none is implemented as a default):

1. **A busier window** (reminders on, normal traffic). Contradicts the drain holds, so only if the holds can be lifted for the row-4 wait. No code needed.
2. **The runner's own ALTER ROLE as the WAL write.** Move the role setting to just after `select`. ALTER ROLE writes WAL, so it may push an archive after the selection;
   restoring to `T_SEL` still lands before the ALTER. **UNVERIFIED**: a tiny record may not force an archive within the window; this can only be learned by one
   hosted observation. It changes the order of the one write the plan already asks Sam to approve, not the number of writes.
3. **A bounded heartbeat** (`pg_logical_emit_message`, a hosted write) after `select`, supported today only by the Linux release path. It needs Insurance review and
   Sam's own sentence; the Mac scripts do not support it, so it would be a new reviewed script.
4. **A named restore point.** Rejected by OPS for 0248 (no method stated; the 27 Oct attempt returned 400).

Recommendation: ask for one read-only observation first (is there any archive movement without a write over 30 minutes?), then decide between 1 and 2.

## What CI proves, and what it does not

Proven on stubs (Linux and macOS arm64, /bin/bash 3.2): happy path; stalled PITR -> clean STOP with the push stub called zero times and no marker; refused ALTER ->
restore then STOP; killed push -> UNKNOWN with the IN-FLIGHT marker kept and the setting restored; authentication failure -> STOP with the auth stub called
exactly once; watchdog that never arms; unexpected prompt; leftover ROLE-STATE; existing marker; attempt budget; short window; no canary secret in any file.

Not proven: any hosted behaviour; the real `db query` output; the pooler value after ALTER on the hosted Supavisor; the real pitr-backups/S0a/row-4/apply running under
the driver on the operator's Mac (their prompts are asserted against the pinned sources, not executed); `expect` behaviour on the operator's macOS version.
