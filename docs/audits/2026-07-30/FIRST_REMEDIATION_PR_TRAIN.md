# First remediation PR train — proposed from exact-production evidence at `c64366c9`

Selected from **this** reconciliation, not inherited from the July 27 roadmap. **Nothing below is
implemented in this task.** Each PR needs its own authorization; every migration needs separate
migration-only authorization.

Two hard ordering constraints govern the train:

- **PR-03 must not precede PR-02.** L18 cannot be solved revoke-first — 26 call sites write the
  clinical tables directly, so revoking before they move breaks Willow's charting the moment the
  migration applies.
- **PR-01 must precede anything that reasons about privilege posture**, because L19(a) and L20 share
  one root cause and must be swept and verified together.

| # | PR | Canonical findings | Scope | Depends on | Migration | Old-app/new-DB | New-app/old-DB | Lowest authoritative test | Production verification | Rollback | Willow risk | Gate closed | Parallel? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **PR-01** | Repo-wide privilege sweep | L19(a), L20 | `revoke truncate, references, trigger` from `anon`/`authenticated` on all 64 exposed tables; revoke `TRIGGER` from `service_role` on the 4 guarded tables; change `ALTER DEFAULT PRIVILEGES` so new tables never re-acquire them | — | **yes** (0161) | safe — no app path uses these | safe — app needs nothing | fresh-DB ACL matrix test asserting the full grid | `has_table_privilege` matrix + ACL drift test in CI | forward-fix via 0162 | none (unreachable today) | — | no (foundation) |
| **PR-02** | Clinical writes → narrow commands | L18 (app half) | Move the 26 direct writers onto reviewed RPCs/server actions; **no grant change** | PR-01 | no | n/a (app-only) | safe | DB suite proving each command enforces studio+client+session lineage | charting E2E green on exact head | revert PR | **medium** — touches live charting; needs Chloe canary | — | no |
| **PR-03** | Revoke obsolete clinical DML | L18 (DB half) | Revoke `INSERT/UPDATE/DELETE` from `authenticated` on the 5 clinical tables | **PR-02 deployed** | **yes** | **UNSAFE if PR-02 not deployed** | safe | fresh-DB test: direct DML denied, commands still work | ACL matrix + charting E2E | forward-fix | **high if ordered wrong** | — | no |
| **PR-04** | Practitioner attribution integrity | `N-SEC-001` | Composite same-studio FK and/or 0160-style guard on `sessions.practitioner_id` + `performed_by_practitioner_id` | PR-01 | **yes** | safe (no call site writes them from a payload — verify first) | safe | DB test: cross-studio and same-studio re-point both refused; ordinary edits unaffected | trigger/FK matrix | forward-fix | low | **BEFORE_STUDIO_2** | yes (with PR-05) |
| **PR-05** | Session link same-client validation | L19(b) | Validating trigger on `sessions.appointment_id` / `treatment_plan_id` — validate, don't freeze | PR-01 | **yes** | safe | safe | DB test: cross-client link refused, re-linking still works | trigger matrix | forward-fix | low | BEFORE_THREE_STUDIOS | yes |
| **PR-06** | Appointment/schedule command boundary | `F-SEC-002`, `F-SCHED-001` | Route appointment mutations through audited commands with ownership checks | PR-02 pattern | likely | — | — | DB + E2E | audit-row assertions | revert | medium | **BEFORE_STUDIO_2** | no |
| **PR-07** | Sentry/telemetry privacy | `F-PRIV-001` | Close the reachable privacy leak in telemetry | — | no | safe | safe | unit + config assertions | live scrubber check | revert | **WILLOW_NOW** | **WILLOW_NOW** | yes |
| **PR-08** | Intake merge/state integrity | `F-CLIN-004`, `F-CLIN-003` | Concurrency + state-machine fixes on intake merge | — | maybe | — | — | DB concurrency test | — | revert | **WILLOW_NOW** for 004 | WILLOW_NOW | yes |
| **PR-09** | Import atomicity | `F-IMPORT-001` | Make import all-or-nothing with safe retry | — | maybe | — | — | DB test w/ induced mid-import failure | import audit rows | revert | low | BEFORE_STUDIO_2 | yes |
| **PR-10** | Export completeness | `F-DATA-001` | Complete + scale-safe export | PR-09 | no | — | — | fixture-based completeness test | — | revert | low | BEFORE_STUDIO_2 | yes |
| **PR-11** | Ops alerting/runbook gaps | `F-OPS-003`, `F-OPS-004` | Close the alerting/runbook items rated WILLOW_NOW/STUDIO_2 | — | no | — | — | unit + runbook drift test | alert fires in staging | revert | low | WILLOW_NOW | yes |
| **PR-12** | Compliance evidence | `F-COMP-001` | Produce the missing compliance evidence artefact | — | no | — | — | docs truth-guard | — | revert | **WILLOW_NOW** | WILLOW_NOW | yes |
| **PR-13** | Test assurance | `F-TEST-003` | Close the WILLOW_NOW test-quality gap | — | no | — | — | mutation-checked suite | CI | revert | low | WILLOW_NOW | yes |
| **PR-14** | Backup/restore proof | `F-OPS-001`, `F-STAGE-001` | Prove restore works; staging parity | — | no | — | — | restore drill record | drill artefact | n/a | low | BEFORE_THREE_STUDIOS | yes |
| **PR-15** | Timezone/slot correctness | `F-SCHED-004`, `F-SCHED-006`, `F-SCALE-002` | DST + slot-generation correctness | PR-06 | maybe | — | — | property tests across DST boundaries | — | revert | medium | BEFORE_TEN_STUDIOS | no |

## Recommended first PR

**PR-01 (repo-wide privilege sweep).** It is the only item that is a strict prerequisite for two other
trains, it is verifiable entirely from `has_table_privilege` without touching application behaviour,
its blast radius on Willow is nil because nothing reachable uses those privileges today, and it
converts the largest single block of open findings from "documented" to "structurally impossible".

**PR-07 and PR-12 may run in parallel** — both are `WILLOW_NOW`, neither touches the database.
