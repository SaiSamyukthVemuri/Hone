# Duplicate and supersession map

**No original ID is discarded, renamed or merged.** `MASTER_FINDINGS_REGISTER.csv` holds
**134 source rows**, one per source finding:

- 48 — `Hone_Independent_Audit_2026-07-27.md`
- 34 — `docs/roadmap/P1_MASTER_REGISTER_2026-07-18.csv`
- 40 — `Hone_Findings_Register_2026-07-10.csv`
- 5 — `Chloe production feedback — 2026-07-30`
- 2 — `NEW-2026-07-30 (this reconciliation)`
- 5 — `docs/production/known-limitations.md`

## What "preserved" means here, precisely

Every source register's own fields are carried into **explicit, individually-named columns** — one
audit column per source column. The CSV header is **generated from the source-row shape**, so a source
column cannot be silently dropped by a hand-maintained list.

- **July-27 audit (48):** evidence, failure scenario, affected, prerequisites, test limitations,
  acceptance criteria, recommended fix, rollout considerations.
- **July-18 register (34):** `source_evidence`, `source_production_evidence`,
  `source_acceptance_criteria`, `source_recommended_fix`, `source_recorded_disposition`,
  `source_classification_rationale`, `source_willow_impact`, `source_cross_tenant_impact`,
  `source_provider_impact`, `source_category`, `source_data_migration_required`,
  `source_required_regression_tests`, `source_rollback`, and the five status columns kept **separate**:
  `source_code_status`, `source_migration_status`, `source_deployment_status`, `source_enabled_status`,
  `source_exercised_status`.
- **July-10 register (40):** `source_evidence`, `source_acceptance_criteria`, `source_recommended_fix`,
  `source_recorded_disposition`, `source_risk_at_stake`, `source_business_impact`, `source_confidence`,
  `source_existing_controls`, `source_why_controls_insufficient`,
  `source_required_regression_tests`, `source_reproduction`.

**Corrections made in pass 2.** The first pass packed the five July-18 status columns into
`source_rollout_considerations` under an undocumented `key=value;` convention, dropped seven source
columns outright — July-18 `willow_impact` and `rationale` on all 34 rows, July-10
`Data/money/workflow/trust at risk`, `Business impact` and `Confidence` — and loaded four July-10
columns into audit columns that mean something different (`Existing controls` under
`source_production_evidence`, `Required regression tests` under `source_test_limitations`). All three
defects are fixed: **no packing remains**, **no source column is dropped**, and every column now
carries what its name says. A test re-reads `docs/roadmap/P1_MASTER_REGISTER_2026-07-18.csv` and fails
if any non-empty source cell appears in no audit column.

`source_test_limitations`, `source_rollout_considerations`, `source_production_evidence` and
`source_failure_scenario` are **empty for the registers that have no such column** rather than being
filled with the nearest-looking field.

## Register overlap

July-10 and July-18 share **18 IDs**. Each is recorded **once per register**, with that
register's own severity, date and disposition — Phase 1 forbids collapsing two source rows.

Shared: `HNE-SEC-001`, `HNE-STO-001`, `HNE-DEP-001`, `HNE-ADM-001`, `HNE-SAA-001`, `HNE-LOC-001`, `HNE-PAY-001`, `HNE-JOB-001`, `HNE-SEC-002`, `HNE-REC-001`, `HNE-REC-002`, `HNE-CAL-001`, `HNE-AUD-001`, `HNE-PAY-002`, `HNE-EXP-001`, `HNE-RBAC-001`, `HNE-CONC-001`, `HNE-PRV-001`

## Signed-record supersession — permanent

| Historical ID | Disposition |
|---|---|
| `HNE-REC-001` | **RETIRED — not a future enablement item.** The July-18 framing as work toward enabling finalization is void: the flag is pinned `false` by a validated CHECK. |
| `HNE-REC-002` | **RETIRED**, same decision. |
| `F-CLIN-000` | Reachable half **PRODUCTION_VERIFIED** (0159 §5c); signed-record half retired. |
| `F-CLIN-001`, `F-CLIN-002` | **SUPERSEDED_BY_PRODUCT_DECISION** — no snapshot v2 will be built. |

**Excluded from every train:** snapshot v2, a signed structured-area correction framework, re-enabling
either clinical flag, and any Finalize/signed-Correction surface.

## Historical rows not individually re-verified

The 74 July-10/July-18 rows carry **every non-empty cell of their source register** (verified
programmatically, not asserted) but were **not** individually re-verified against `c64366c9ba4130283932bbe21e32bf2ed62c4975`; their canonical column reads `UNMAPPED_HISTORICAL` and their status
reads `NOT_INDIVIDUALLY_RE_VERIFIED` rather than a fabricated verdict. See `EVIDENCE_LIMITATIONS.md`.
