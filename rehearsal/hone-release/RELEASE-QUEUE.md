# How OPS's release queue invokes the launcher (no new scheduler, no new platform)

The package adds NO scheduler, queue, worker pool or merge/apply authority. OPS's existing ranked queue and release plan stay the only orchestration. For one stage, OPS (or an agent working the queue) runs the following. **M** marks a step that stays MANUAL on purpose (a person with the authority does it); **A** marks a step an agent may run through the six-or-eight sudoers lines, and nothing else.

| # | Step | Who | Command / record |
|---|---|---|---|
| 1 | Package ready: reviewed bundle, list, head, receipt (OPS preparation) and, if the stage names governed-object checks, the verify bundle | OPS | existing release plan; files copied to `/srv/hone-release-inbox` (`bundle.tar`, `list.sha256`, optional `verify.tar`) |
| 2 | Exact-stage approval: Sam's typed values from the reviewed record, including the S0a record (sha, time, write counter for `quiet_db=idle`), the drain attestations and the compatible serving commit | **M** (root, Sam present) | `approve-package.sh ...` (INSTALL.md); this is the only approval and is never implied by green CI or by a queue position |
| 3 | Recovery evidence for the autonomous path: `read-backups` (then `idle-probe`, or `heartbeat` then `read-backups` again after the recovery point advances) | **A** | `sudo -n -u hone-release .../launcher read-backups` etc. The heartbeat is a HOSTED WRITE and needs its own approval wording (below) |
| 4 | GO/NO-GO package | **A** runs, **M** reads and binds | `launcher preflight` prints the package; the approver reads it and runs `bind-gonogo.sh gonogo_sha=<64 hex>` as root. The apply refuses without a fresh (30 min) binding of this exact package |
| 5 | Apply | **A** | `launcher apply` (ends `APPLIED-UNVERIFIED`) |
| 6 | Verify | **A** | `launcher verify` (history, stage checks, smoke, serving-source record, sha-chained receipt; state `APPLIED`, or `VERIFY-FAILED` and STOP) |
| 7 | Unknown outcome (`IN-FLIGHT`, `UNKNOWN-KILLED`, `VERIFY-FAILED`) | **A** reads (`reconcile`, `status`), **M** (root) clears the state after the read-back | never a retry from the queue |
| 8 | Promote the compatible application deployment, observe, record | **M** / OPS under Sam's delegation | existing release plan (not part of this package) |
| 9 | Record the apply in `docs/production/migration-state.json` and the ledger | OPS | existing record rules; the receipt head sha256 is quotable |

Not automated here, by design: merging, promotion, alias changes, studio communications, the S0a/row-4 attended gates on the Mac (`window-s0a`, `window-row4` keep their typed values), and clearing any blocked state.

## Approval wording the heartbeat needs (it is a hosted write)

Sam's approval for a stage that selects `quiet_db=heartbeat` must say, in these or equivalent words: "I authorize ONE heartbeat write to the production database: a single `pg_logical_emit_message` WAL message (no table, no row, no schema change) over the verify-full direct connection as the `postgres` role, once for approval <id>." The heartbeat statement also reads back the four timeout settings the real endpoint applied, so the first authorized heartbeat doubles as the hosted proof that the startup options are honoured.
