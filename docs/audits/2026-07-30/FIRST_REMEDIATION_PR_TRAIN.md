# First remediation PR train — derived from canonical data at `c64366c9ba4130283932bbe21e32bf2ed62c4975`

**Nothing here is implemented.** Each PR needs its own authorization; every migration needs separate
migration-only authorization.

**How to read this table**

- **Migration** is *derived*: it is true when any finding this PR carries requires one at this PR
  (`migration_required`, or `migration_required_by_pr` for a phased finding). **Rollback** is derived
  the same way — a migration PR is rolled back by a forward fix, never by editing an applied migration.
- **Depends on** is *derived* from canonical `depends_on`, resolved to the PR that actually delivers
  each depended-on capability, plus the two hard ordering edges stated below. `—` means genuinely
  nothing blocks it.
- **Gate effect** says *Closes* only when the PR covers **every** open finding at that gate; otherwise
  *Contributes to*.
- **Production verification** is each finding's `acceptance_evidence` — what would prove the fix,
  not an inventory of tests that already exist.
- **Scheduling rule enforced here:** a code-only P1 is never packaged with migration work, so no
  code-only P1 can be delayed behind migration-only authorization it does not need.

**Hard ordering constraints**

1. **PR-11 must not be authorized until PR-10 is DEPLOYED** — not merely merged. L18 cannot be solved
   revoke-first: 26 call sites write the clinical tables directly, so revoking first breaks Willow's
   charting at apply time. This edge is in the `Depends on` column and in `pr_dependencies` in the
   machine-readable register, not only in this sentence.
2. **PR-01 precedes only what depends on privilege posture** (PR-10, PR-11, PR-12). PR-08 and PR-09 add
   constraints and triggers, not grants, and do **not** depend on it.

| PR | Title | Canonical findings | Train | Depends on | Migration | Willow risk | Production verification | Rollback | Gate effect |
|---|---|---|---|---|---|---|---|---|---|
| **PR-01** | Repo-wide default-privilege sweep | `L19a`, `L20` | T1-privilege | — | **yes** | low | Fresh-DB privilege matrix proving anon and authenticated hold no TRUNCATE/REFERENCES/TRIGGER on any of the 64… | forward-fix via a new migration | Contributes to BEFORE_THREE_STUDIOS |
| **PR-02** | Truthful public and in-app copy | `F-DATA-001`, `F-RET-001`, `F-DOC-001`, `F-COMP-001`, `N-DOC-001` | T0-copy | — | no | medium — live Willow surface | Phase 1: a copy truth-guard asserting the export UI states exactly what the export contains. Phase 2: a test … | revert the PR | Contributes to BEFORE_STUDIO_2; Contributes to WILLOW_NOW |
| **PR-03** | Server-authoritative charge amount | `F-PAY-001` | T2-payment | — | no | low — bounded to the owner today | Fake-Stripe browser test proving a submitted amount that does not match the booked service's authoritative pr… | revert the PR | Contributes to BEFORE_STUDIO_2 |
| **PR-04** | Custom-area keystroke commit fix | `CHLOE-001` | T3-charting | — | no | medium — live Willow surface | Fresh-DB/E2E: typing an N-character custom area produces exactly ONE committed area row; existing areas unaff… | revert the PR | Contributes to WILLOW_NOW |
| **PR-05** | Sentry bearer-path containment | `F-PRIV-001` | T4-privacy | — | no | medium — live Willow surface | Source-stated acceptance criteria (Hone_Independent_Audit_2026-07-27.md): Sentry scrub tests with realistic o… | revert the PR | Contributes to WILLOW_NOW |
| **PR-06** | Intake completeness and review-state integrity | `F-CLIN-003`, `F-CLIN-004` | T5-intake | — | no | medium — live Willow surface | Source-stated acceptance criteria (Hone_Independent_Audit_2026-07-27.md): Two-connection DB test: update clie… | revert the PR | Contributes to BEFORE_TEN_STUDIOS; Contributes to WILLOW_NOW |
| **PR-07** | Intake copy/template integrity | `F-COPY-001` | T5-intake | — | **yes** | low | Source-stated acceptance criteria (Hone_Independent_Audit_2026-07-27.md): DB test deletes/archives source/tar… | forward-fix via a new migration | Contributes to BEFORE_TEN_STUDIOS |
| **PR-08** | Practitioner attribution and session lineage | `F-SEC-001`, `N-SEC-001` | T6-identity | — | **yes** | low — bounded to the owner today | Source-stated acceptance criteria (Hone_Independent_Audit_2026-07-27.md): DB tests reject direct client/studi… | forward-fix via a new migration | Contributes to BEFORE_TEN_STUDIOS; Contributes to BEFORE_STUDIO_2 |
| **PR-09** | Session link validation | `F-PRIV-002` | T4-privacy | — | no | low | Source-stated acceptance criteria (Hone_Independent_Audit_2026-07-27.md): Tests assert raw email, phone and a… | revert the PR | Contributes to BEFORE_PUBLIC_SELF_SERVICE |
| **PR-10** | Clinical writes → narrow commands (application half) | `L18` | T7-clinical-dml | PR-01 | **yes** | low | Fresh-DB proof that authenticated holds no INSERT/UPDATE/DELETE on the 5 clinical tables, AND a deployed-buil… | forward-fix via a new migration | Contributes to BEFORE_TEN_STUDIOS |
| **PR-11** | Revoke obsolete clinical DML (revoke half) | `L18` | T7-clinical-dml | PR-01, PR-10 deployed | **yes** | low | Fresh-DB proof that authenticated holds no INSERT/UPDATE/DELETE on the 5 clinical tables, AND a deployed-buil… | forward-fix via a new migration | Contributes to BEFORE_TEN_STUDIOS |
| **PR-12** | Audit-table privilege hardening | `L19b` | T1-privilege | — | **yes** | low | Fresh-DB proof that service_role holds no TRIGGER on the 4 guarded tables, and that the 0160 lineage triggers… | forward-fix via a new migration | Contributes to BEFORE_THREE_STUDIOS |
| **PR-13** | Checkout default and note regression reproduction | `CHLOE-002` | T3-charting | — | no | medium — live Willow surface | Reproduce on the DEPLOYED build first; then assert the amount defaults from the booked service and the intern… | revert the PR | Contributes to WILLOW_NOW |
| **PR-14** | Atomic service reordering | `CHLOE-003` | T3-charting | — | no | low — bounded to the owner today | Reorder N services to an arbitrary target order and assert the persisted order matches exactly; concurrent re… | revert the PR | Contributes to BEFORE_STUDIO_2 |
| **PR-15** | Dashboard truncation and service-card legibility | `CHLOE-004`, `CHLOE-005` | T3-charting | — | no | medium — live Willow surface | Assert the full remember-note and latest-settings content is reachable (expand/wrap/tooltip) at the mobile br… | revert the PR | Contributes to WILLOW_NOW; Contributes to BEFORE_STUDIO_2 |
| **PR-16** | Appointment and schedule command boundaries | `F-SEC-002`, `F-SCHED-001` | T8-schedule | — | **yes** | low — bounded to the owner today | Source-stated acceptance criteria (Hone_Independent_Audit_2026-07-27.md): Direct DML negative tests for every… | forward-fix via a new migration | Contributes to BEFORE_STUDIO_2; Contributes to BEFORE_THREE_STUDIOS |
| **PR-17** | Public booking atomicity and kill switches | `F-SCHED-002`, `F-SCHED-003`, `F-PUBLIC-001`, `F-PUBLIC-002` | T9-public | PR-16 | **yes** | low | Source-stated acceptance criteria (Hone_Independent_Audit_2026-07-27.md): DB/browser test toggles the kill sw… | forward-fix via a new migration | Contributes to BEFORE_THREE_STUDIOS; Contributes to BEFORE_TEN_STUDIOS; Contributes to BEFORE_PUBLIC_SELF_SERVICE |
| **PR-18** | Timezone and slot correctness | `F-SCHED-004`, `F-SCHED-006`, `F-SCALE-002` | T9-public | PR-16 | no | low | Source-stated acceptance criteria (Hone_Independent_Audit_2026-07-27.md): Unit and browser tests for Toronto/… | revert the PR | Contributes to BEFORE_TEN_STUDIOS |
| **PR-19** | Public create-command eligibility and allocation | `F-SCHED-005` | T9-public | — | **yes** | low | Source-stated acceptance criteria (Hone_Independent_Audit_2026-07-27.md): Browser/DB tests for chosen practit… | forward-fix via a new migration | Contributes to BEFORE_THREE_STUDIOS |
| **PR-20** | Import atomicity | `F-IMPORT-001` | T10-data | — | **yes** | low — bounded to the owner today | Source-stated acceptance criteria (Hone_Independent_Audit_2026-07-27.md): Fault-injection DB tests at every p… | forward-fix via a new migration | Contributes to BEFORE_STUDIO_2 |
| **PR-21** | Retention, purge and storage lifecycle | `F-RET-001`, `F-STORAGE-001` | T0-copy, T10-data | — | **yes** | medium — live Willow surface | Copy component: a truth-guard asserting the privacy and terms pages state only retention behaviour that exist… | forward-fix via a new migration | Contributes to WILLOW_NOW; Contributes to BEFORE_TEN_STUDIOS |
| **PR-22** | Complete asynchronous export | `F-DATA-001`, `F-DATA-002`, `F-SCALE-001` | T0-copy, T10-data | PR-21 | **yes** | low — bounded to the owner today | Phase 1: a copy truth-guard asserting the export UI states exactly what the export contains. Phase 2: a test … | forward-fix via a new migration | Contributes to BEFORE_STUDIO_2; Contributes to BEFORE_TEN_STUDIOS |
| **PR-23** | Offline and degraded-mode handling | `F-OFF-001` | T10-data | — | **yes** | low | Source-stated acceptance criteria (Hone_Independent_Audit_2026-07-27.md): End-to-end sandbox offboarding test… | forward-fix via a new migration | Contributes to BEFORE_TEN_STUDIOS |
| **PR-24** | Public rate-limiter fail-open disposition | `F-OPS-001` | T11-ops | — | no | low | Source-stated acceptance criteria (Hone_Independent_Audit_2026-07-27.md): Fault-injection load tests with lim… | revert the PR | Contributes to BEFORE_PUBLIC_SELF_SERVICE |
| **PR-25** | Ops alerting and test assurance | `F-OPS-003`, `F-TEST-003` | T11-ops | — | no | medium — live Willow surface | Source-stated acceptance criteria (Hone_Independent_Audit_2026-07-27.md): Staging job test plus production no… | revert the PR | Contributes to BEFORE_STUDIO_2; Contributes to WILLOW_NOW |
| **PR-26** | Backup/restore proof and staging parity | `F-OPS-004`, `F-STAGE-001` | T11-ops | — | no | medium — live Willow surface | Source-stated acceptance criteria (Hone_Independent_Audit_2026-07-27.md): Restore a sanitized environment fro… | revert the PR | Contributes to WILLOW_NOW; Contributes to BEFORE_TEN_STUDIOS |

## PR scope detail

- **PR-01** — Revoke TRUNCATE/REFERENCES/TRIGGER from anon+authenticated on the 64 exposed tables; change ALTER DEFAULT PRIVILEGES so new tables never re-acquire them; add an ACL drift test.
- **PR-02** — One code-only PR correcting every live false published claim together: the terms and pricing pages' subscription/payment/refund lifecycle, the settings-vs-privacy hosting-region contradiction, the export UI's contents claim, and the retention/deletion commitment wording.
- **PR-03** — Compare the submitted amount server-side against the authoritative booked-service or custom price; owner-only override recorded with amount and reason.
- **PR-04** — Commit a custom treatment area once on confirm/blur instead of once per keystroke.
- **PR-05** — Stop transmitting replayable intake/portal/calendar-feed bearer tokens to Sentry.
- **PR-06** — Refuse 'Mark reviewed' for an unsubmitted intake or an intake belonging to another client; assert an exact row count; fix intake merge state.
- **PR-07** — Copy/template correctness in the intake path.
- **PR-08** — Composite same-studio FK and/or guard on the five practitioner FKs of sessions; closes the residual half of F-SEC-001.
- **PR-09** — Validating constraint on sessions.appointment_id / treatment_plan_id.
- **PR-10** — Move the 26 direct writers onto reviewed commands. NO grant change in this PR.
- **PR-11** — Revoke INSERT/UPDATE/DELETE from authenticated on the 5 clinical tables. MUST NOT be authorized until PR-10 is DEPLOYED.
- **PR-12** — Revoke TRIGGER from service_role on the guarded audit tables so the 0160 lineage triggers cannot be disabled.
- **PR-13** — Reproduce on the deployed build first, then fix and pin.
- **PR-14** — Single atomic reorder over the full ordered set.
- **PR-15** — Expand/wrap the memory note and settings summary; spacing and palette separation.
- **PR-16** — Route appointment and schedule-config mutations through audited commands with ownership enforcement.
- **PR-17** — Booking atomicity, kill switches and public-surface hardening.
- **PR-18** — DST-correct slot generation and bounded next-available scanning.
- **PR-19** — Eligibility and allocation under lock for the public create command.
- **PR-20** — All-or-nothing import with safe retry via a transactional RPC.
- **PR-21** — Implement the published retention commitments: purge job, hard-delete path, legal hold, storage-object removal.
- **PR-22** — Full async export at scale with a manifest-derived audit list.
- **PR-23** — Defined behaviour when the network or a dependency is unavailable.
- **PR-24** — Explicit decision and fix for the fail-open path during a live Upstash outage.
- **PR-25** — Close the WILLOW_NOW alerting and test-quality gaps.
- **PR-26** — Prove restore works; staging parity.

## Recommended first authorization

**PR-02 — truthful public and in-app copy.**

The derived facts, not a superlative: **7 open P1s** at WILLOW_NOW or BEFORE_STUDIO_2
need no migration — `F-CLIN-004`, `F-PAY-001`, `F-PRIV-001`, `F-DATA-001`, `F-COMP-001`, `N-DOC-001`, `CHLOE-001` — and the PRs whose whole
scope is code-only are **PR-02**, **PR-03**, **PR-04**, **PR-05**, **PR-06**, **PR-09**, **PR-13**, **PR-14**, **PR-15**, **PR-18**, **PR-24**, **PR-25**, **PR-26**. PR-02 is not the only code-only
option; it is the recommended **first** one for three reasons a reader can check against the register:

1. It is the only PR that corrects statements Hone publishes to the public and to a Canadian health
   practitioner — a terms and pricing page describing a subscription, payment-processing and refund
   lifecycle that does not exist, a settings page contradicting the privacy policy about where health
   data is hosted, an export UI overstating what it exports, and a retention commitment with no
   implementing code. Every one of those is false **today**, on a live page, with a real audience.
2. It carries **no migration, no flag and no data operation**, so it needs no migration-only
   authorization and is reverted by reverting the PR.
3. Its `Depends on` is genuinely `—`.

**PR-03** (server-authoritative charge amount) is the strongest companion: it is the only P1 touching
live money, and `F-PAY-001`'s amount half is live at Willow **today** regardless of practitioner count.
**PR-04**, **PR-05** and **PR-06** each carry a WILLOW_NOW P1, need no migration, and have no
dependencies — any of them may run alongside PR-02. **PR-01** also has no dependency, but it is the
prerequisite for the privilege trains (PR-10 → PR-11, PR-12) and is a migration PR, so it needs its own
migration-only authorization.
