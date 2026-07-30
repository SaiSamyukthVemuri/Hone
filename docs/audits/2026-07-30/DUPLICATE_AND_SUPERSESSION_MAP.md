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

Each source register's own fields are carried into **explicit columns** — `source_evidence`,
`source_failure_scenario`, `source_affected`, `source_prerequisites`, `source_test_limitations`,
`source_acceptance_criteria`, `source_recommended_fix`, `source_rollout_considerations`,
`source_production_evidence` and `source_recorded_disposition`. **There is no undocumented
`a | b | c` packing**; where a source had several related fields (personas / tenants / workflows) they
are joined into `source_affected` with a ` / ` separator and that is the only joined column.

The July-10 register's **Acceptance criteria** and **Recommended remediation** are carried for all 40
rows (previously dropped). The July-18 register's **classification** is carried for all 34 rows as
`source_recorded_disposition`: **5 DEPLOYED**, **10 OPEN**, **16 PARTIALLY FIXED**, **3 PRODUCTION VERIFIED** — so the
**8 rows that register already recorded as closed remain visible**.

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

The 74 July-10/July-18 rows are preserved in full but were **not** individually
re-verified against `c64366c9ba4130283932bbe21e32bf2ed62c4975`; their canonical column reads `UNMAPPED_HISTORICAL` and their status
reads `NOT_INDIVIDUALLY_RE_VERIFIED` rather than a fabricated verdict. See `EVIDENCE_LIMITATIONS.md`.
