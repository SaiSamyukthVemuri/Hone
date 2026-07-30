# Dependency-ordered remediation plan — `c64366c9ba4130283932bbe21e32bf2ed62c4975`

**Every row below is generated from canonical `train`, `depends_on` and `required_prs`.** Train
membership is exactly the set of findings whose `train` field equals that train — no glob, no
hand-added member. Dependencies are stated **per finding**, never as a blanket train-level edge, so a
train is never shown as blocked because one of its members is.

| Train | Findings | PRs | Per-finding dependencies |
|---|---|---|---|
| **T0-copy** | `F-DATA-001`, `F-RET-001`, `F-DOC-001`, `F-COMP-001`, `N-DOC-001` | PR-02, PR-21, PR-22 | `F-DATA-001` → `F-SCALE-001`, `F-DATA-002`, `F-RET-001` |
| **T1-privilege** | `L19a`, `L19b`, `L20` | PR-01, PR-12 | none — nothing in this train is blocked |
| **T10-data** | `F-DATA-002`, `F-IMPORT-001`, `F-STORAGE-001`, `F-OFF-001`, `F-SCALE-001` | PR-20, PR-21, PR-22, PR-23 | none — nothing in this train is blocked |
| **T11-ops** | `F-OPS-001`, `F-OPS-003`, `F-OPS-004`, `F-STAGE-001`, `F-TEST-003` | PR-24, PR-25, PR-26 | none — nothing in this train is blocked |
| **T2-payment** | `F-PAY-001` | PR-03 | none — nothing in this train is blocked |
| **T3-charting** | `CHLOE-001`, `CHLOE-002`, `CHLOE-003`, `CHLOE-004`, `CHLOE-005` | PR-04, PR-13, PR-14, PR-15 | none — nothing in this train is blocked |
| **T4-privacy** | `F-PRIV-001`, `F-PRIV-002` | PR-05, PR-09 | none — nothing in this train is blocked |
| **T5-intake** | `F-CLIN-003`, `F-CLIN-004`, `F-COPY-001` | PR-06, PR-07 | none — nothing in this train is blocked |
| **T6-identity** | `F-SEC-001`, `N-SEC-001` | PR-08 | none — nothing in this train is blocked |
| **T7-clinical-dml** | `L18` | PR-10, PR-11 | `L18` → `L19a` |
| **T8-schedule** | `F-SEC-002`, `F-SCHED-001` | PR-16 | none — nothing in this train is blocked |
| **T9-public** | `F-SCHED-002`, `F-SCHED-003`, `F-SCHED-004`, `F-SCHED-005`, `F-SCHED-006`, `F-SCALE-002`, `F-PUBLIC-001`, `F-PUBLIC-002` | PR-17, PR-18, PR-19 | `F-SCHED-002` → `F-SEC-002`; `F-SCHED-003` → `F-SEC-002`; `F-SCHED-004` → `F-SEC-002`; `F-SCHED-006` → `F-SEC-002`; `F-PUBLIC-001` → `F-SEC-002`; `F-PUBLIC-002` → `F-SEC-002` |

## PR-level dependency graph (derived)

| PR | Depends on |
|---|---|
| **PR-01** | — |
| **PR-02** | — |
| **PR-03** | — |
| **PR-04** | — |
| **PR-05** | — |
| **PR-06** | — |
| **PR-07** | — |
| **PR-08** | — |
| **PR-09** | — |
| **PR-10** | PR-01 |
| **PR-11** | PR-01, PR-10 deployed |
| **PR-12** | — |
| **PR-13** | — |
| **PR-14** | — |
| **PR-15** | — |
| **PR-16** | — |
| **PR-17** | PR-16 |
| **PR-18** | PR-16 |
| **PR-19** | — |
| **PR-20** | — |
| **PR-21** | — |
| **PR-22** | PR-21 |
| **PR-23** | — |
| **PR-24** | — |
| **PR-25** | — |
| **PR-26** | — |

The graph was walked for cycles at both the finding level and the PR level — **both are acyclic**.
The only *deployment*-ordered edge is **PR-11 after PR-10 deployed**; every other edge is a merge-order
edge.

## Explicitly NOT scheduled in this train

This train is a **first tranche**. It covers 41
of the 51 open/partial canonical findings. The
following are **not** covered by any PR here, and no arrow above should be read as covering them:

| ID | Sev | Gate | Why it is not in this tranche |
|---|---|---|---|
| `F-OPS-002` | P3 | BEFORE_50_STUDIOS | Cross-tenant Twilio STOP scan. P3/BEFORE_50_STUDIOS; no multi-tenant comms work is scheduled in this train, so there is nothing for it to gate. |
| `F-OPS-005` | P3 | BEFORE_TEN_STUDIOS | P3/BEFORE_TEN_STUDIOS ops gap; no PR in this tranche. |
| `F-TEST-001` | P3 | BEFORE_TEN_STUDIOS | P3 assurance gap; no PR in this tranche. |
| `F-TEST-002` | P3 | BEFORE_PUBLIC_SELF_SERVICE | P3 assurance gap; no PR in this tranche. |
| `F-GCAL-001` | P3 | BEFORE_TEN_STUDIOS | Google Calendar is dormant in production; no GCal PR is in this tranche. |
| `F-GCAL-002` | P3 | BEFORE_TEN_STUDIOS | Google Calendar is dormant in production; no GCal PR is in this tranche. |
| `F-CAL-001` | P3 | BEFORE_TEN_STUDIOS | Google Calendar is dormant in production; no GCal PR is in this tranche. |
| `F-ONB-001` | P3 | BEFORE_THREE_STUDIOS | SaaS self-service onboarding is unbuilt; no onboarding PR is in this tranche. |
| `F-ONB-002` | P3 | BEFORE_TEN_STUDIOS | SaaS self-service onboarding is unbuilt; no onboarding PR is in this tranche. |
| `L21` | P3 | POST_GA | P3/POST_GA residual; no PR in this tranche. |

Everything unscheduled is **P3**. No open P0, P1 or P2 is unscheduled.

## Open P0/P1 placement

| ID | Sev | Status | Train | PR | Gate | Depends on |
|---|---|---|---|---|---|---|
| `F-CLIN-004` | P1 | OPEN | T5-intake | PR-06 | WILLOW_NOW | — |
| `F-SEC-002` | P1 | OPEN | T8-schedule | PR-16 | BEFORE_STUDIO_2 | — |
| `F-PAY-001` | P1 | PARTIALLY_FIXED | T2-payment | PR-03 | BEFORE_STUDIO_2 | — |
| `F-PRIV-001` | P1 | OPEN | T4-privacy | PR-05 | WILLOW_NOW | — |
| `F-DATA-001` | P1 | OPEN | T0-copy | PR-02, PR-22 | BEFORE_STUDIO_2 | F-SCALE-001, F-DATA-002, F-RET-001 |
| `F-IMPORT-001` | P1 | OPEN | T10-data | PR-20 | BEFORE_STUDIO_2 | — |
| `F-COMP-001` | P1 | OPEN | T0-copy | PR-02 | WILLOW_NOW | — |
| `N-SEC-001` | P1 | OPEN | T6-identity | PR-08 | BEFORE_STUDIO_2 | — |
| `N-DOC-001` | P1 | OPEN | T0-copy | PR-02 | WILLOW_NOW | — |
| `CHLOE-001` | P1 | OPEN | T3-charting | PR-04 | WILLOW_NOW | — |
