# HON66-ONE-COMMAND-STAGE (online flow): one command, credentials once, one result (REHEARSAL, NEVER MERGE)

Supersedes the PITR-era runner of #1231 (that flow, with its watchdog, row 4, restore point and temporary role setting, no longer exists). Nothing here has run against the hosted project.

## What it is

`hone-stage-run.sh STAGE-MANIFEST` is the one Mac entry point. It is **generic**: everything stage-specific is in a manifest (`stages/0254.conf`): the apply and reconcile script paths, the marker and tombstone paths, the approval word, the line that means verified, the idle and hard limits, the full sha256 of every pinned script, and the **prompt table** (kind + exact prompt text, in order). A later stage (0255, ...) is a new manifest, not new runner code.

It runs the **reviewed, unmodified** scripts: the apply script (which itself runs the four pinned reads, the dry run, ONE push and the pinned read-back) and then the reconcile script. `run.exp` (macOS ships `/usr/bin/expect`) plays the person at the terminal through a pty, because the reviewed scripts read from `/dev/tty` and must not change.

## The flow, as the operator sees it

1. `bash hone-stage-run.sh stages/0254.conf`
2. Refusals before anything is shown (nothing is called): wrong platform, a forbidden environment variable, no terminal, a pinned file missing or its sha256 different, an APPLY-STATE marker, a FAILED-LOGIN tombstone.
3. The reviewed apply script prints its own summary (target, sealed sha, bundle, what runs, what stops it, "no settings write").
4. **Approval:** the runner asks you to type exactly the approval word (`APPLY`). Anything else cancels: NOT APPLIED, nothing connected.
5. **Credentials, once:** the access token and database password, hidden. They live only in the driver's memory and on the child's pty.
6. Automatic, no further input: the four reads, the dry run, ONE push, then the read-back. The read-back script asks for token and password itself (a second entry in the reviewed script); the driver answers it from step 5, so you type nothing.
7. If, and only if, the apply script reports `RESULT: APPLIED+VERIFIED` and the marker is `APPLIED-UNVERIFIED`, the **reconcile runs by itself** (it makes no connection and takes no credentials), archives the marker on the read-back evidence and writes its record.
8. **One result block** (`ONE-COMMAND RESULT: ...`), also saved with a masked transcript under `~/hone-s1/one-command/run.*` (mode 700).

Outcomes: `APPLIED+VERIFIED` (marker archived) | `APPLIED+VERIFIED (reconcile did NOT clear the marker)` | `NOT APPLIED` | `UNKNOWN -> reconcile` (never a rerun). The outcome is classified from what is on disk (marker presence and word), not from the driver's word alone.

## Prompt table (stages/0254.conf)

| # | kind | prompt (exact) | answered with |
|---|---|---|---|
| 1 | approve | `Type  APPLY  to run this now (nothing has connected yet): ` | the word you typed (must equal the manifest's approval word) |
| 2 | secret-token | `Supabase access token (not shown): ` | the token, only after the child turned echo off |
| 3 | secret-password | `Database password (not shown): ` | the password, same rule |
| 4 | secret-token | `Supabase access token (not shown): ` (read-back) | the same token |
| 5 | secret-password | `Database password (not shown; only its presence is used here): ` (read-back) | the same password |

A prompt that is not the next one in the table is **never answered**. The child stalls, the idle limit (600 s in the shipped manifest) ends the run, the child's whole process group is told to stop, and the result is NOT APPLIED (before the push) or UNKNOWN (after it).

## Approval sentence template (for Sam)

"Approve running stage `<STAGE>` with `hone-stage-run.sh` sha256 `<runner>`, `run.exp` sha256 `<driver>` and manifest sha256 `<manifest>` (printed at the start of the run), which applies exactly the sealed migration `<file>` (sha256 `<sealed>`) online by the reviewed scripts `<apply sha>`, `<reconcile sha>` and `<read-back sha>`, with no settings write, one push and no retry; I accept that an interruption after the push leaves the result UNKNOWN and that the next step is then the read-back and the reconcile, never a rerun."

## What CI proves (macOS arm64 /bin/bash 3.2 + /usr/bin/expect, and Linux; 40 of 40 each)

Stubs for the CLI and the read-back; canary secrets; a real pty with a harness that plays the person; the REAL text of the 0254 online apply and reconcile scripts.
- happy path: three lines typed (approval, token, password), four pinned reads, one dry run, ONE push, read-back, automatic reconcile (class ALL), marker archived, one result, run dir mode 700, no canary in any file or output
- settings untouched: the only CLI calls are the four pinned reads, one dry run and one push; the runner and driver name no database client, statement or setting (static check)
- decline: anything but the approval word -> NOT APPLIED, no credential asked, no call
- refusals before any prompt: changed reconcile or read-back script, missing pinned script, existing marker, existing tombstone, manifest without prompts, malformed manifest field
- stall before the push -> STOP, NOT APPLIED, nothing pushed; stall after the push -> UNKNOWN, marker stays, one push, no automatic reconcile
- an unexpected prompt is never answered -> STOP, NOT APPLIED, no call
- authentication failure at the first read (one attempt, tombstone, no retry) and at the push (one attempt, never reported applied)
- killed push -> UNKNOWN; read-back showing 246 rows -> UNKNOWN; neither runs the reconcile
- a real Ctrl-C (terminal interrupt character) before the push -> NOT APPLIED, nothing pushed; after the push -> UNKNOWN, marker stays
- generic: a different stage (other approval word, paths, prompt table) runs from its manifest alone
- two mutations of the runner (reconcile after an unverified push; an unverified push reported as NOT APPLIED) are caught

## Remaining exceptions (not proven, or deliberately open)

1. Nothing ran against the real `supabase-go`, the hosted project or an operator Mac: CI uses stubs on macos-14. Real timings of the reads, dry run and push are unknown.
2. The idle limit is 600 s of no output (Insurance's 10-minute allowance). The longest silent stretch of the real run has not been measured; if a real step is silent longer, the run stops and the result is NOT APPLIED or UNKNOWN (safe, but the attempt is lost).
3. A half-printed prompt (no newline) that the driver does not recognise is not shown in the stop reason (CI limitation found in run 8); the STOP still happens and nothing is answered. Unrecognised prompts that end a line are shown.
4. The token and password stay in the driver's memory until the run ends (the read-back needs them); the reviewed script's printed sentence that they are "cleared before the push" is not changed (it concerns the apply script's own copy).
5. The runner does not install the pinned scripts; the Mac package and its installers (peer condition C4) are separate and need Insurance's byte-diff.
6. `expect` behaviour is proven on macos-14; the operator's macOS version is not.
7. The reconcile NONE route (a second push after an in-flight marker) is untouched and still manual; this runner only runs the reconcile after APPLIED+VERIFIED.

## Hands-on time (estimate, not measured on a real run)

About 30 seconds: start the command, type the approval word, paste the token, paste the password. Everything else is unattended; the CI happy path takes seconds against stubs, the real run is expected to take a few minutes of waiting for the reads, push and read-back. The previous procedure needed separate commands for apply, a second credential entry for the read-back, and a manual reconcile.

## Two confirmations (added for 0254-after-0257, Z4)
A manifest may carry a SECOND `approve` prompt (the stage asking again after its own dry-run listing). The credentials are still typed once; the
second approval is shown with its own text ("Second confirmation...") and declining it leaves nothing applied. The first PROMPT line must still be `approve`;
more than two approve prompts are refused. Proved by the two TWO CONFIRMATIONS checks (accept: 4 lines typed; decline: no marker, NOT APPLIED).
A second approve must be listed AFTER the access-token and password prompts (the runner refuses the manifest up front otherwise; one negative control). The driver tolerates a late answer to a stage that bounded its own second prompt.
