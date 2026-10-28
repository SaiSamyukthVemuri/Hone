# How OPS's release queue invokes the launcher (no new scheduler, no new platform)

The package adds NO scheduler, queue, worker pool or merge/apply authority. OPS's existing ranked queue and release plan stay the only orchestration. For one stage, OPS (or an agent working the queue) runs the following. **M** marks a step that stays MANUAL on purpose (a person with the authority does it); **A** marks a step an agent may run through the eleven sudoers lines, and nothing else.

| # | Step | Who | Command / record |
|---|---|---|---|
| 1 | Package ready: reviewed bundle, list, head, receipt (OPS preparation); the verify bundle for the stage (`tools/make-verify-bundle.py`, OPS reviews `review.md`); the compatible application deployment promoted | OPS | existing release plan; files copied to `/srv/hone-release-inbox` (`bundle.tar`, `list.sha256`, optional `verify.tar`) |
| 2 | Exact-stage approval: Sam's typed values from the reviewed record, including the S0a record (sha, time, write counter for `quiet_db=idle`), the drain attestations, the compatible serving commit, `serving_check`, and for `quiet_db=heartbeat` Sam's exact heartbeat sentence | **M** (root, Sam present) | `approve-package.sh ...` (INSTALL.md); never implied by green CI or a queue position |
| 3 | Recovery evidence, autonomous path only: `read-backups`; then either (`quiet_db=idle`) `wal-capture` at S0a and `idle-probe` within 30 minutes of it (two samples 10 minutes or more apart), or (`quiet_db=heartbeat`) `heartbeat` then `read-backups` again after the recovery point advances | **A** | `launcher read-backups` etc. The provider's latest point advanced in steps of about 20 minutes on the night of #1035: the 75-minute rule and the evidence ages allow for that wait |
| 4 | GO/NO-GO package | **A** runs `preflight`; **M** reads and binds | The approver reads the package **as root** (`sudo cat /var/lib/hone-release/state/GONOGO.json`) and types the `sha256` field from THAT file into `bind-gonogo.sh gonogo_sha=<64 hex>`, never a value relayed by the agent. The apply refuses without a fresh (30 min) binding of this exact package |
| 5 | Apply | **A** | `launcher apply`: connection-phase read-back (history, busy sessions, the four timeouts the endpoint applied), one dry run, one push; ends `APPLIED-UNVERIFIED` |
| 6 | OPS serving read-back (only if the approval says `serving_check=readback`) | OPS reads, **M** binds | OPS reads the production alias -> deployment -> git commit sha and READY state through its Vercel connector, then runs `bind-serving.sh commit=<40 hex> deployment=<id> alias_host=<host> observed_at=<UTC>` as root after the push |
| 7 | Verify | **A** | `launcher verify` (history, the approved verify bundle's checks, smoke, serving read-back or attestation record, sha-chained receipt; state `APPLIED`, or `VERIFY-FAILED` and STOP) |
| 8 | Unknown outcome (`IN-FLIGHT`, `UNKNOWN-KILLED`, `VERIFY-FAILED`, `FAILED-*`) | **A** reads (`reconcile`, `status`), **M** (root) clears the state after the read-back | never a retry from the queue |
| 9 | **Record the receipt head sha256 in the ledger.** The receipt is tamper-evident only to a reader who has its head hash somewhere else | OPS (**M**) | quote the `head` sha256 printed by `verify` in `docs/production/migration-ledger.md` and `migration-state.json` for the stage |
| 10 | Promote/observe/record as in the existing release plan | OPS | not part of this package |

Not automated here, by design: merging, promotion, alias changes, studio communications, the S0a/row-4 attended gates on the Mac, and clearing any blocked state.

## Approval wording the heartbeat needs (it is a hosted write)

For a stage that selects `quiet_db=heartbeat`, `approve-package.sh` REFUSES unless Sam types this sentence exactly, with the stage's approval id in place of `<ID>`, in the `heartbeat_auth` field; it records the sentence's sha256, and `heartbeat.sh` recomputes it and refuses without it. Once per approval.

> I authorize ONE heartbeat write to the production database: a single pg_logical_emit_message WAL message (no table, no row, no schema change) over the verify-full direct connection as the postgres role, once for approval <ID>.

The heartbeat statement also reads back the four timeout settings the real endpoint applied. Every apply on the direct form now does the same before its dry run (Insurance FX2), so the hosted startup-option proof no longer depends on the heartbeat.

## Machines' read gates (window reads) in the queue

`read-s1read` (after an S1 apply: the six S1 gate files, then Machines' pinned comparator; exit 0 only on `OVERALL PASS`; read-only evidence, it promotes nothing) and `read-gap` (the #1035 post-S3 gap read: 19 count rows, within 24 h of S3) are **A** steps with the read PAT only: `sudo -n -u hone-release /usr/local/libexec/hone-release/launcher read-s1read` / `read-gap`. `pitr-backups` is `read-backups` (same single GET). Each prints Machines' own verdict lines; a person reads the gap counts. Neither needs approval, a database password or the CLI.
