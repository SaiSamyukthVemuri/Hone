# Duplicate and supersession map

**No original ID is discarded or renamed.** 123 source rows are preserved in
`MASTER_FINDINGS_REGISTER.csv`: 48 from the July 27 independent audit, 34 from the July 18 P1
master register, 40 from the July 10 findings register, and 1 discovered in this run.

## Register overlap

The July 10 and July 18 registers share **18 IDs** — the July 18 register is partly a
re-registration of July 10 items, not a disjoint set. Those IDs appear **twice** in the source table
(once per register, with each register's own severity and date) because Phase 1 forbids merging two
source rows merely because they share an ID or a domain.

Shared IDs: `HNE-SEC-001`, `HNE-STO-001`, `HNE-DEP-001`, `HNE-ADM-001`, `HNE-SAA-001`, `HNE-LOC-001`, `HNE-PAY-001`, `HNE-JOB-001`, `HNE-SEC-002`, `HNE-REC-001`, `HNE-REC-002`, `HNE-CAL-001`, `HNE-AUD-001`, `HNE-PAY-002`, `HNE-EXP-001`, `HNE-RBAC-001`, `HNE-CONC-001`, `HNE-PRV-001`

July-18-only IDs (16): `P1-01`, `P1-02`, `P1-03`, `P1-04`, `P1-05`, `P1-06`, `P1-07`, `P1-10`, `P1-11`, `P1-13`, `P1-08`, `P1-09`, `P1-12`, `P1-ANALYTICS-01`, `P1-ANALYTICS-02`, `P1/P2-ANALYTICS-03`

July-10-only IDs (22): `HNE-BOOK-001`, `HNE-BOOK-002`, `HNE-INV-001`, `HNE-CSV-001`, `HNE-PORT-001`, `HNE-AUD-002`, `HNE-IMG-001`, `HNE-OBS-001`, `HNE-CI-001`, `HNE-TST-001`, `HNE-MIG-001`, `HNE-MEM-001`, `HNE-TIM-001`, `HNE-MKT-001`, `HNE-BLD-001`, `HNE-SEO-001`, `HNE-A11Y-001`, `HNE-RATE-001`, `HNE-OPS-001`, `HNE-ACT-001`, `HNE-DEPS-001`, `HNE-SUP-001`

## Signed-record supersession

The permanent retirement of signed/finalized clinical records supersedes these historical items.
**None may return to the roadmap.**

| Historical ID | Register | Disposition |
|---|---|---|
| `HNE-REC-001` | July 10 + July 18 | **RETIRED — not a future enablement item.** The July 18 register framed it as work toward enabling finalization. That direction is void: `clinical_finalization_enabled` is pinned `false` by a validated CHECK constraint and no role can enable it. |
| `HNE-REC-002` | July 10 + July 18 | **RETIRED with the same decision.** |
| `F-CLIN-000` | July 27 | Reachable half **PRODUCTION_VERIFIED** (0159 §5c); signed-record half **retired**. |
| `F-CLIN-001` | July 27 | **SUPERSEDED_BY_PRODUCT_DECISION** — finalization cannot race a child write because finalization cannot occur. |
| `F-CLIN-002` | July 27 | **SUPERSEDED_BY_PRODUCT_DECISION** — snapshot completeness is moot; **no snapshot v2 will be built.** |

**Explicitly excluded from every remediation wave:** snapshot v2, a signed structured-area correction
framework, re-enabling either clinical flag, and any practitioner-facing Finalize or signed-Correction
surface.

## Historical IDs not individually re-verified

The 74 July-10/July-18 source rows are preserved verbatim but were **not** individually re-verified
against `c64366c9ba4130283932bbe21e32bf2ed62c4975`; only the 48 July-27 findings plus the 1 new finding were. See
`EVIDENCE_LIMITATIONS.md`. Their canonical column reads `UNMAPPED_HISTORICAL` rather than a
fabricated status.
