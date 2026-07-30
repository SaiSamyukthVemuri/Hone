# Review closure register — all 33 frozen-head review items

Every item from the first frozen-head review of head `1468d051` has exactly one final disposition.
**No item is OPEN, deferred, or partially corrected.** A P1 is marked corrected only where the change
appears in the primary artifacts, not merely as a note here.

| # | Sev | Disposition | Affected artifacts | Exact correction | Verification test |
|---|---|---|---|---|---|
| 1 | P2 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.csv; DUPLICATE_AND_SUPERSESSION_MAP.md | All 40 July-10 rows now carry source_acceptance_criteria and source_recommended_fix from the source CSV's Acceptance criteria / Recommended remediation columns, plus 8 further source fields as explicit columns. Verified 0/40 empty. | source-preservation test asserts 0 July-10 rows missing either field |
| 2 | P2 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.csv | New explicit column source_recorded_disposition carries the July-18 classification verbatim (DEPLOYED 5, OPEN 10, PARTIALLY FIXED 16, PRODUCTION VERIFIED 3) plus source_production_evidence, acceptance criteria and proposed remediation. | source-preservation test asserts 0/34 empty and the 8 closed rows are visible |
| 3 | P3 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.csv | Undocumented `a \| b \| c` packing removed. Each source concept now has its own column (source_evidence, source_affected, source_prerequisites, source_production_evidence, …). | CSV header/field-count test + source-preservation test |
| 4 | P3 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.json | counts block renamed to source_rows_in_csv_total / source_rows_in_csv_by_register with an explicit note that `findings` holds canonical rows only and the two shapes differ deliberately. | JSON self-description test |
| 5 | P1 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.{csv,json}; CURRENT_P0_P1_REPORT.md | F-BILL-001 SPLIT. The unbuilt platform stays NOT_A_LAUNCH_REQUIREMENT/P3 gated BEFORE_PUBLIC_SELF_SERVICE. The live false public claim is now its own OPEN canonical finding N-DOC-001 (P1, WILLOW_NOW, train T0-copy, PR-02). | P1-in-report test; status/gate compatibility test |
| 6 | P2 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.json; LAUNCH_GATE_MATRIX.md | Status and gate now agree: the closed capability row keeps a forward gate with train NONE; the live claim carries WILLOW_NOW with a train and PR. | status/gate compatibility test |
| 7 | P2 | **CORRECTED_AND_VERIFIED** | EVIDENCE_LIMITATIONS.md | Now records CI run 30577864921/#912 at the audit head as executed-green evidence, and distinguishes suites actually run from file-inventory citations. | n/a (documentation) |
| 8 | P3 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.json | F-EXEC-001 product_decision is n/a and its train is NONE; it no longer carries a forward implementation wave. | closed-findings-have-no-train test |
| 9 | P3 | **CORRECTED_AND_VERIFIED** | RECONCILIATION_REPORT.md | Baseline table now marks each row as independently verified vs supplied-not-verified. | n/a (documentation) |
| 10 | P3 | **DUPLICATE_OF_REVIEW_ITEM_16** | FIRST_REMEDIATION_PR_TRAIN.md | Same PR-14 mis-mapping as item 16; corrected there. | see item 16 |
| 11 | P1 | **CORRECTED_AND_VERIFIED** | all artifacts | One authoritative aggregate everywhere: Willow has 2 practitioners — 1 ACTIVE owner, 1 INACTIVE non-owner; active non-owner count 0. Stored in MASTER_FINDINGS_REGISTER.json.willow_practitioner_fact and propagated to F-PAY-001, N-SEC-001 and the gate reasoning. | willow-fact consistency test |
| 12 | P1 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.{csv,json}; CURRENT_P0_P1_REPORT.md; FIRST_REMEDIATION_PR_TRAIN.md | F-PAY-001 raised to P1/PARTIALLY_FIXED, gate BEFORE_STUDIO_2 (not WILLOW_NOW: Willow has NO active non-owner practitioner), train T7, PR-02. Remediation names all four required elements. | P1-in-report test; every-open-P1-has-a-PR test |
| 13 | P2 | **CORRECTED_AND_VERIFIED** | CURRENT_P0_P1_REPORT.md | New 'Demoted from P1 — exact basis' table with one row per demotion, each citing the specific source and hosted fact. No demotion rests on 'only one studio'. | demotion-table test |
| 14 | P3 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.json; EVIDENCE_LIMITATIONS.md | F-PUBLIC-002's missing_evidence no longer names a fact F-OPS-001 already resolves. | n/a |
| 15 | P3 | **DUPLICATE_OF_REVIEW_ITEM_16** | FIRST_REMEDIATION_PR_TRAIN.md | Same defect as item 16. | see item 16 |
| 16 | P1 | **CORRECTED_AND_VERIFIED** | FIRST_REMEDIATION_PR_TRAIN.md | Backup/restore is PR-20 mapped to F-OPS-004 + F-STAGE-001. F-OPS-001 (rate-limit fail-open) has its own PR-18. Gates derive from the covered findings. | pr-train-references-valid-ids test; gate-derivation test |
| 17 | P1 | **CORRECTED_AND_VERIFIED** | FIRST_REMEDIATION_PR_TRAIN.md; DEPENDENCY_REMEDIATION_PLAN.md | F-SEC-002 (PR-11) no longer depends on the L18 refactor — appointment command boundaries are independent of clinical direct-DML. Dependency graph regenerated from canonical depends_on. | dependency-acyclic + order test |
| 18 | P1 | **CORRECTED_AND_VERIFIED** | FIRST_REMEDIATION_PR_TRAIN.md | F-PAY-001 is PR-02 in the first train. | every-open-P1-has-a-PR test |
| 19 | P2 | **CORRECTED_AND_VERIFIED** | FIRST_REMEDIATION_PR_TRAIN.md | Gate column is derived: a PR says 'Closes <gate>' only when it covers every open finding at that gate, otherwise 'Contributes to <gate>'. | gate-derivation test |
| 20 | P2 | **CORRECTED_AND_VERIFIED** | FIRST_REMEDIATION_PR_TRAIN.md | PR dependencies now come from canonical depends_on; the fabricated PR-10→PR-09 edge is gone and F-DATA-001's real dependency is recorded. | dependency test |
| 21 | P2 | **CORRECTED_AND_VERIFIED** | FIRST_REMEDIATION_PR_TRAIN.md | Every PR row has populated Willow-risk and production-verification cells; CHLOE-002's separate acceptance condition is preserved as its own row. | pr-train completeness test |
| 22 | P2 | **CORRECTED_AND_VERIFIED** | LAUNCH_GATE_MATRIX.md | BEFORE_PUBLIC_SELF_SERVICE is split into live-reachable defects vs unbuilt-capability gaps. | n/a |
| 23 | P3 | **CORRECTED_AND_VERIFIED** | DEPENDENCY_REMEDIATION_PLAN.md | N-SEC-001 (PR-04) and L19b (PR-05) no longer depend on the privilege sweep — they add constraints/triggers, not grants. | dependency test |
| 24 | P3 | **CORRECTED_AND_VERIFIED** | DEPENDENCY_REMEDIATION_PLAN.md | Comms train now has explicit predecessors and the ordering rule binds it. | dependency test |
| 25 | P1 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.csv | Header/field counts reconciled at 29/29 on every row; production_reachable restored as its own column. | csv-field-count test (mutation-checked) |
| 26 | P2 | **CORRECTED_AND_VERIFIED** | RECONCILIATION_REPORT.md | Blanket verification claims replaced with per-row source-vs-hosted attribution. | n/a |
| 27 | P2 | **DUPLICATE_OF_REVIEW_ITEM_11** | multiple | Same Willow contradiction as item 11. | see item 11 |
| 28 | P2 | **DUPLICATE_OF_REVIEW_ITEM_16** | FIRST_REMEDIATION_PR_TRAIN.md | Same PR-14 mis-mapping. | see item 16 |
| 29 | P2 | **DUPLICATE_OF_REVIEW_ITEM_5** | MASTER_FINDINGS_REGISTER.json | Resolved by the F-BILL-001 split. | see item 5 |
| 30 | P3 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.json | train, depends_on, parallel_group and required_prs are now distinct fields; remediation_wave is retained as an alias of train and no longer a restatement of the gate. | dependency + schema test |
| 31 | P3 | **CORRECTED_AND_VERIFIED** | RECONCILIATION_REPORT.md §F | L18/L19a/L19b/L20/L21 are now real canonical rows, so §F maps to canonical IDs rather than prose. | limitations-are-canonical test |
| 32 | P3 | **CORRECTED_AND_VERIFIED** | RECONCILIATION_REPORT.md | Section D (P2 disposition summary) restored; lettering A–I is contiguous. | section-lettering test |
| 33 | P3 | **CORRECTED_AND_VERIFIED** | RECONCILIATION_REPORT.md §A | The evidence-limitation column now reports findings carrying missing_evidence, not only rows whose status is EVIDENCE_LIMITATION. | n/a |

## Disposition totals

- **CORRECTED_AND_VERIFIED**: 28
- **DUPLICATE_OF_REVIEW_ITEM_<N>**: 5

All 33 accounted for. Corrected in commit recorded in the PR body.
