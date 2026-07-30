# First remediation PR train — derived from canonical data at `c64366c9ba4130283932bbe21e32bf2ed62c4975`

**Nothing here is implemented.** Each PR needs its own authorization; every migration needs separate
migration-only authorization. Gates are **derived**: a PR says *Closes* a gate only when it covers
every open finding at that gate, otherwise *Contributes to*.

**Hard ordering constraints**

1. **PR-07 must not precede PR-06.** L18 cannot be solved revoke-first — 26 call sites write the
   clinical tables directly, so revoking first breaks Willow's charting at apply time.
2. **PR-01 precedes only what actually depends on privilege posture** (PR-06/PR-07). PR-04 and PR-05
   add constraints and triggers, not grants, and do **not** depend on it.
3. **PR-11 (appointment command boundaries) is independent of the L18 clinical refactor.**

| PR | Title | Canonical findings | Train | Depends on | Migration | Willow risk | Production verification | Rollback | Gate effect | Parallel group |
|---|---|---|---|---|---|---|---|---|---|---|
| **PR-01** | Repo-wide default-privilege sweep | `L19a`, `L20` | T1 | — | **yes** | low | has_table_privilege matrix; no drift test exists yet. | forward-fix via a new migration | Contributes to BEFORE_THREE_STUDIOS | PG-privilege |
| **PR-02** | Truthful public copy + server-authoritative charge amount | `F-PAY-001`, `F-DOC-001`, `N-DOC-001` | T7, T0-copy | — | no | medium — live Willow surface | Fake-Stripe test proving a mismatched amount is refused ser… | revert the PR | Contributes to BEFORE_STUDIO_2; Contributes to WILLOW_NOW | PG-pay, PG-copy |
| **PR-03** | Custom-area keystroke commit fix | `CHLOE-001` | T0-charting | — | no | medium — live Willow surface | none found | revert the PR | Contributes to WILLOW_NOW | PG-chloe |
| **PR-04** | Practitioner attribution + session lineage integrity | `F-SEC-001`, `F-COMP-001`, `N-SEC-001` | T3, T11 | — | **yes** | medium — live Willow surface | tests/db/immutable-clinical-lineage.db.test.ts (417 lines) … | forward-fix via a new migration | Contributes to BEFORE_TEN_STUDIOS; Contributes to WILLOW_NOW; Contributes to BEFORE_STUDIO_2 | PG-identity, PG-ops |
| **PR-05** | Telemetry privacy containment + session link validation | `F-PRIV-001`, `F-PRIV-002`, `L19b` | T9, T3 | — | **yes** | medium — live Willow surface | None, and the gap is verifiable: tests/lib/observability/se… | forward-fix via a new migration | Contributes to WILLOW_NOW; Contributes to BEFORE_PUBLIC_SELF_SERVICE; Contributes to BEFORE_THREE_STUDIOS | PG-privacy, PG-identity |
| **PR-06** | Clinical writes → narrow commands | `L18` | T2 | PR-01 | no | high | ACL matrix asserted in tests/db. | revert the PR | Contributes to BEFORE_TEN_STUDIOS | PG-privilege |
| **PR-07** | Revoke obsolete clinical DML | `L18` | T2 | PR-01 | **yes** | high | ACL matrix asserted in tests/db. | forward-fix via a new migration | Contributes to BEFORE_TEN_STUDIOS | PG-privilege |
| **PR-08** | Checkout default + note regression reproduction | `CHLOE-002` | T0-charting | — | no | medium — live Willow surface | none found | revert the PR | Contributes to WILLOW_NOW | PG-chloe |
| **PR-09** | Atomic service reordering | `CHLOE-003` | T13 | — | no | low | none found | revert the PR | Contributes to BEFORE_STUDIO_2 | PG-chloe |
| **PR-10** | Dashboard truncation + service card legibility | `CHLOE-004`, `CHLOE-005` | T0-charting, T13 | — | no | medium — live Willow surface | none found | revert the PR | Contributes to WILLOW_NOW; Contributes to BEFORE_STUDIO_2 | PG-chloe |
| **PR-11** | Appointment & schedule command boundaries | `F-SEC-002`, `F-SCHED-001` | T4 | — | **yes** | low | None for this boundary. tests/db contains strong behavioura… | forward-fix via a new migration | Contributes to BEFORE_STUDIO_2; Contributes to BEFORE_THREE_STUDIOS | PG-schedule |
| **PR-12** | Intake merge & state integrity | `F-CLIN-003`, `F-CLIN-004` | T8 | — | no | medium — live Willow surface | None found. tests/app/intake/ contains only intake-submit-n… | revert the PR | Contributes to BEFORE_TEN_STUDIOS; Contributes to WILLOW_NOW | PG-intake |
| **PR-13** | Import atomicity | `F-IMPORT-001` | T10 | — | no | low | tests/db/quick-import.db.test.ts and tests/app/settings/imp… | revert the PR | Contributes to BEFORE_STUDIO_2 | PG-data |
| **PR-14** | Public booking atomicity & kill switches | `F-SCHED-002`, `F-SCHED-003`, `F-PUBLIC-001`, `F-PUBLIC-002` | T5 | PR-11 | **yes** | low | No test executed. Static trace of the deployed source at c6… | forward-fix via a new migration | Contributes to BEFORE_THREE_STUDIOS; Contributes to BEFORE_TEN_STUDIOS; Contributes to BEFORE_PUBLIC_SELF_SERVICE | PG-public |
| **PR-15** | Timezone & slot correctness | `F-SCHED-004`, `F-SCHED-005`, `F-SCHED-006`, `F-SCALE-002` | T6 | PR-11 | no | low | No test executed. I read the pinning unit tests directly; t… | revert the PR | Contributes to BEFORE_TEN_STUDIOS; Contributes to BEFORE_THREE_STUDIOS | PG-time |
| **PR-16** | Truthful partial-export correction | `F-DATA-001`, `F-DATA-002` | T10 | PR-13 | no | low | None. tests/app/settings/data/export-owner-gate.test.ts is … | revert the PR | Contributes to BEFORE_STUDIO_2; Contributes to BEFORE_TEN_STUDIOS | PG-data |
| **PR-17** | Complete asynchronous export | `F-DATA-001`, `F-SCALE-001` | T10 | PR-13 | **yes** | low | None. tests/app/settings/data/export-owner-gate.test.ts is … | forward-fix via a new migration | Contributes to BEFORE_STUDIO_2; Contributes to BEFORE_TEN_STUDIOS | PG-data |
| **PR-18** | Public rate-limiter fail-open disposition | `F-OPS-001` | T11 | — | no | low | tests/app/actions/waitlist-demo-rate-limit.test.ts exists b… | revert the PR | Contributes to BEFORE_PUBLIC_SELF_SERVICE | PG-ops |
| **PR-19** | Ops alerting + test assurance | `F-OPS-003`, `F-TEST-003` | T11 | — | no | medium — live Willow surface | tests/lib/cron/reminder-heartbeat.test.ts covers the pure c… | revert the PR | Contributes to BEFORE_STUDIO_2; Contributes to WILLOW_NOW | PG-ops |
| **PR-20** | Backup/restore proof + staging parity | `F-OPS-004`, `F-STAGE-001` | T11 | — | no | medium — live Willow surface | None possible — no code test can prove a restore. scripts/v… | revert the PR | Contributes to WILLOW_NOW; Contributes to BEFORE_TEN_STUDIOS | PG-ops |

## Recommended first authorization

**PR-02 — truthful public copy + server-authoritative charge amount.** It carries the only two
**WILLOW_NOW/BEFORE_STUDIO_2 P1s that are code-only and need no migration**: `N-DOC-001` (a live
public page describing a subscription and refund lifecycle that does not exist) and `F-PAY-001`
(the charge path moves live money with no server-side amount authority). Neither depends on any other
train, both are revertible by reverting the PR, and both are live today.

**PR-01** remains the prerequisite for the privilege trains (PR-06 → PR-07) and can run in parallel.
**PR-03** (custom-area keystroke duplication) is the other WILLOW_NOW code-only item and may also run
in parallel.
