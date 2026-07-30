# Review closure register — both review passes

This register is **authoritative** over the status column of any earlier review artifact. Where
`INDEPENDENT_REVIEW_FINDINGS.md` (the pass-1 record) and this file disagree, this file is correct;
the pass-1 file's status column is regenerated from this one.

**Pass 1** reviewed head `1468d051` and raised 33 items. **Pass 2** independently reviewed the
corrected head `7566a9c8` and raised **25 further items — including 12 pass-1 items whose recorded
closure was false.** Both sets are below. **No item is OPEN, deferred, or partially corrected.**

An item is marked corrected only where the change is visible in the primary artifacts and, where a
test is named, that test fails when the correction is reverted.

## Pass 1 — 33 items reviewed at head `1468d051`

| # | Sev | Disposition | Affected artifacts | Exact correction | Verification test |
|---|---|---|---|---|---|
| 1 | P2 | **REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.csv; DUPLICATE_AND_SUPERSESSION_MAP.md | Pass 1 recorded: "July-10 acceptance criteria and recommended remediation carried on all 40 rows." **That closure was false.** Three July-10 source columns (`Data/money/workflow/trust at risk`, `Business impact`, `Confidence`) were still dropped on all 40 rows. Now carried as `source_risk_at_stake`, `source_business_impact`, `source_confidence`. | source-preservation diff test (reads the source register) |
| 2 | P2 | **REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.csv | Pass 1 recorded: "July-18 classification carried on all 34 rows (DEPLOYED 5, OPEN 10, PARTIALLY FIXED 16, PRODUCTION VERIFIED 3)." **That closure was false.** July-18 `willow_impact` (34/34) and `rationale` (34/34), plus `category`, `provider_impact` and `data_migration_required`, were still dropped. Now carried as `source_willow_impact`, `source_classification_rationale`, `source_category`, `source_provider_impact`, `source_data_migration_required`. | source-preservation diff test |
| 3 | P3 | **REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.csv | Pass 1 recorded: "Undocumented `a \| b \| c` packing removed." **That closure was false.** The packing was removed for July-27 only. All 34 July-18 rows still packed five status columns into `source_rollout_considerations` as `code=…; migration=…;`, and DUPLICATE_AND_SUPERSESSION_MAP.md had been edited to deny packing existed. The five columns are now separate and the map states the true per-register mapping. | no-packed-columns test |
| 4 | P3 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.json | counts block renamed to source_rows_in_csv_* with an explicit note that `findings` holds canonical rows only. | re-verified at pass 2 |
| 5 | P1 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.{csv,json}; CURRENT_P0_P1_REPORT.md | F-BILL-001 split: the unbuilt platform stays NOT_A_LAUNCH_REQUIREMENT/P3; the live false public claim is now N-DOC-001 (P1, WILLOW_NOW). | re-verified at pass 2 |
| 6 | P2 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.json; LAUNCH_GATE_MATRIX.md | Status and gate now agree. | re-verified at pass 2 |
| 7 | P2 | **REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED** | EVIDENCE_LIMITATIONS.md | Pass 1 recorded: "CI evidence recorded." **That closure was false.** The edit cited run **30577864921** — this audit branch's own run — as the test evidence, not run **30572200532** at the production SHA, and understated it as covering only the unit and DB lanes. Both runs are all-lane green; they are now stated separately and only the production-head run backs F-EXEC-001. | CI-evidence test |
| 8 | P3 | **REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.json | Pass 1 recorded: "F-EXEC-001 no longer carries a forward implementation wave." **That closure was false.** Only `train` was changed. `F-EXEC-001` still carried `product_decision: signed-record retirement (permanent)` (copied from the clinical rows, with which it has no relationship) and `launch_gate: POST_GA`. Now `n/a` and `NONE_CLOSED`; the emitter no longer applies the clinical decision to any non-clinical finding. | closed-finding product-decision test |
| 9 | P3 | **CORRECTED_AND_VERIFIED** | RECONCILIATION_REPORT.md | Baseline table marks each row independently-verified vs supplied-not-verified. | re-verified at pass 2 |
| 10 | P3 | **DUPLICATE_OF_REVIEW_ITEM_16** | FIRST_REMEDIATION_PR_TRAIN.md | Same defect as item 16; corrected there. | see item 16 |
| 11 | P1 | **REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED** | all artifacts | Pass 1 recorded: "One authoritative Willow aggregate." **That closure was false.** The fact reached `willow_practitioner_fact`, `rationale` and `Willow_risk`, but the `missing_evidence` of `F-SEC-001`, `F-SEC-002`, `F-SCHED-001` and `F-PAY-001` still said the count could not be determined — reproduced verbatim in EVIDENCE_LIMITATIONS.md and CURRENT_P0_P1_REPORT.md. `F-PAY-001` therefore settled and re-opened the same question inside one record, and its unqualified escalation rule ("if Willow already has an employee practitioner") reads as already triggered, since the inactive row exists. All four rewritten; the rule is now qualified by ACTIVE. | corpus-wide stale-Willow scan + escalation-qualifier test (both mutation-checked) |
| 12 | P1 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.{csv,json}; CURRENT_P0_P1_REPORT.md; FIRST_REMEDIATION_PR_TRAIN.md | F-PAY-001 raised to P1, gate BEFORE_STUDIO_2, scheduled. | re-verified at pass 2 |
| 13 | P2 | **CORRECTED_AND_VERIFIED** | CURRENT_P0_P1_REPORT.md | 'Demoted from P1 — exact basis' table added; no demotion rests on 'only one studio'. | re-verified at pass 2 |
| 14 | P3 | **REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.json; EVIDENCE_LIMITATIONS.md | Pass 1 recorded: "Cross-finding evidence contradiction resolved." **That closure was false.** `F-PUBLIC-002` still named the Upstash configuration question as "the single highest-value fact to check next" while `F-OPS-001` recorded it closed by a production build gate; `F-SCALE-002` and `F-SCHED-003` repeated it. All three now cite F-OPS-001 and keep only the live-outage residual. | stale-Upstash test |
| 15 | P3 | **DUPLICATE_OF_REVIEW_ITEM_16** | FIRST_REMEDIATION_PR_TRAIN.md | Same defect as item 16; corrected there. | see item 16 |
| 16 | P1 | **CORRECTED_AND_VERIFIED** | FIRST_REMEDIATION_PR_TRAIN.md | Backup/restore mapped to F-OPS-004 + F-STAGE-001; the rate-limiter fail-open has its own PR. | re-verified at pass 2 |
| 17 | P1 | **REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED** | FIRST_REMEDIATION_PR_TRAIN.md; DEPENDENCY_REMEDIATION_PLAN.md | Pass 1 recorded: "Appointment command boundaries no longer depend on the L18 clinical refactor." **That closure was false.** The cited verification never checked ordering. Pass 2 mutation-proved it: deleting real `Depends on` cells from the PR train left the suite green. | PR-dependency-matches-derived-graph test (mutation-checked) |
| 18 | P1 | **CORRECTED_AND_VERIFIED** | FIRST_REMEDIATION_PR_TRAIN.md | F-PAY-001 is in the first train. | re-verified at pass 2 |
| 19 | P2 | **CORRECTED_AND_VERIFIED** | FIRST_REMEDIATION_PR_TRAIN.md | Gate column derived: 'Closes' only when the PR covers every open finding at that gate. | re-verified at pass 2 |
| 20 | P2 | **REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED** | FIRST_REMEDIATION_PR_TRAIN.md | Pass 1 recorded: "PR dependencies come from canonical depends_on." **That closure was false.** The fabricated edge was renumbered, not removed, and promoted into canonical data as `F-DATA-001.depends_on = [F-IMPORT-001]`, so the export copy correction still waited on import atomicity. `F-DATA-001`'s real dependencies (`F-SCALE-001`, `F-DATA-002`, `F-RET-001`) are now recorded, and its Phase-1 copy fix is scoped to a PR with no dependency. | PR-dependency test + finding-acyclicity test |
| 21 | P2 | **REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED** | FIRST_REMEDIATION_PR_TRAIN.md | Pass 1 recorded: "Willow-risk and production-verification cells populated." **That closure was false.** The Production-verification column was populated, but from `acceptance_evidence`, which was a byte-for-byte copy of `behavioural_test_evidence` in 59 of 60 findings — an inventory of existing tests, not a closure criterion. Every open finding now has a distinct, written acceptance criterion. | acceptance-evidence test |
| 22 | P2 | **CORRECTED_AND_VERIFIED** | LAUNCH_GATE_MATRIX.md | BEFORE_PUBLIC_SELF_SERVICE split into live-reachable defects vs unbuilt-capability gaps. | re-verified at pass 2 |
| 23 | P3 | **REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED** | DEPENDENCY_REMEDIATION_PLAN.md | Pass 1 recorded: "N-SEC-001 and L19b no longer depend on the privilege sweep." **That closure was false.** Same unguarded test as item 17. | PR-dependency test |
| 24 | P3 | **REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED** | DEPENDENCY_REMEDIATION_PLAN.md | Pass 1 recorded: "Comms-train ordering." **That closure was false.** The comms train was **deleted**, not given predecessors, so the recorded correction described something that does not exist. Trains are now regenerated from canonical membership with no gaps, and `F-OPS-002` is listed with a stated reason for being out of this tranche. | train-membership test + unscheduled-coverage test |
| 25 | P1 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.csv | Header/field counts reconciled on every row; production_reachable restored as its own column. | re-verified at pass 2 |
| 26 | P2 | **CORRECTED_AND_VERIFIED** | RECONCILIATION_REPORT.md | Blanket verification claims replaced with per-row attribution. | re-verified at pass 2 |
| 27 | P2 | **DUPLICATE_OF_REVIEW_ITEM_11** | multiple | Same defect as item 11; corrected there (and re-opened in pass 2 with it). | see item 11 |
| 28 | P2 | **DUPLICATE_OF_REVIEW_ITEM_16** | FIRST_REMEDIATION_PR_TRAIN.md | Same defect as item 16; corrected there. | see item 16 |
| 29 | P2 | **DUPLICATE_OF_REVIEW_ITEM_5** | MASTER_FINDINGS_REGISTER.json | Same defect as item 5; corrected there. | see item 5 |
| 30 | P3 | **CORRECTED_AND_VERIFIED** | MASTER_FINDINGS_REGISTER.json | train, depends_on, parallel_group and required_prs are distinct fields. | re-verified at pass 2 |
| 31 | P3 | **CORRECTED_AND_VERIFIED** | RECONCILIATION_REPORT.md §F | L18–L21 are real canonical rows. | re-verified at pass 2 |
| 32 | P3 | **CORRECTED_AND_VERIFIED** | RECONCILIATION_REPORT.md | Section lettering A–I contiguous. | re-verified at pass 2 |
| 33 | P3 | **CORRECTED_AND_VERIFIED** | RECONCILIATION_REPORT.md §A | The evidence-limitation column reports findings carrying missing_evidence. | re-verified at pass 2 |

## Pass 2 — 25 items reviewed at head `7566a9c8`

Twelve of these are pass-1 items whose recorded correction did not exist in the artifacts
(items 1, 2, 3, 7, 8, 11, 14, 17, 20, 21, 23, 24). That is the most important result of this pass: a
closure register is only worth what its verification tests can detect, and three of the tests cited in
pass 1 were proved vacuous by mutation.

| # | Sev | Disposition | Defect | Affected artifacts | Exact correction | Verification test |
|---|---|---|---|---|---|---|
| 01 | P1 | **CORRECTED_AND_VERIFIED** | Pass-1 item 11 falsely closed — four findings and two reports still called the Willow count unknown | MASTER_FINDINGS_REGISTER.json; EVIDENCE_LIMITATIONS.md; CURRENT_P0_P1_REPORT.md | `missing_evidence` rewritten for F-SEC-001, F-SEC-002, F-SCHED-001 and F-PAY-001 to state the hosted aggregate and only the genuinely unproven residue; the escalation rule is qualified by ACTIVE non-owner. | corpus-wide stale-Willow scan; escalation-qualifier test |
| 02 | P1 | **CORRECTED_AND_VERIFIED** | Pass-1 item 20 falsely closed — the fabricated export→import edge survived as canonical data | MASTER_FINDINGS_REGISTER.json; FIRST_REMEDIATION_PR_TRAIN.md | `F-DATA-001.depends_on` set to its real dependencies (F-SCALE-001, F-DATA-002, F-RET-001); Phase-1 copy correction moved to PR-02 with `depends_on_by_pr` empty, so it ships immediately. | PR-dependency test; finding-acyclicity test |
| 03 | P1 | **CORRECTED_AND_VERIFIED** | The closure register claimed no item was open while INDEPENDENT_REVIEW_FINDINGS.md marked 26 of 33 'OPEN — deferred' | INDEPENDENT_REVIEW_FINDINGS.md; REVIEW_CLOSURE_REGISTER.md | The pass-1 artifact's Status column is regenerated from this register and its stale non-canonical banner is dated and superseded. This register is authoritative. | review-item-disposition test (also scans INDEPENDENT_REVIEW_FINDINGS.md) |
| 04 | P1 | **CORRECTED_AND_VERIFIED** | F-EXEC-001's RETIRED closure cited run 30572200532 while the evidence appendix cited a different run covering fewer lanes | EVIDENCE_LIMITATIONS.md; MASTER_FINDINGS_REGISTER.json | Both runs re-read from the GitHub API. **30572200532 is at the production SHA `c64366c9` with all six lanes green** — that is F-EXEC-001's sole evidence. The audit branch's own run is now described separately and never as production evidence. The RETIRED closure is sound. | CI-evidence test |
| 05 | P2 | **CORRECTED_AND_VERIFIED** | The willow-fact test was vacuous — it grepped for a phrase no artifact contains | tests/audits/findings-register-consistency.test.ts | Replaced with a corpus-wide scan of every canonical string field plus three reports. Mutation-checked by reintroducing one stale sentence. | the test itself |
| 06 | P2 | **CORRECTED_AND_VERIFIED** | 'The only two code-only P1s' was false and the same page contradicted it two paragraphs later | FIRST_REMEDIATION_PR_TRAIN.md | The count is now generated from the register (7 code-only P1s at WILLOW_NOW/BEFORE_STUDIO_2) and PR-02 is justified by what it actually corrects, not by uniqueness. | recommended-first-authorization test |
| 07 | P2 | **CORRECTED_AND_VERIFIED** | acceptance_evidence was a byte-for-byte copy of behavioural_test_evidence in 59 of 60 findings | MASTER_FINDINGS_REGISTER.json; FIRST_REMEDIATION_PR_TRAIN.md | Every open finding now has a written closure criterion; July-27/10 findings use their source register's own acceptance criteria, attributed. | acceptance-evidence test |
| 08 | P2 | **CORRECTED_AND_VERIFIED** | 34 July-18 rows still packed five source columns under an undocumented `key=value;` convention, and the map denied packing existed | MASTER_FINDINGS_REGISTER.csv; DUPLICATE_AND_SUPERSESSION_MAP.md | Five separate columns; the map states the true per-register mapping. | no-packed-columns test |
| 09 | P2 | **CORRECTED_AND_VERIFIED** | Seven source columns were dropped outright, including July-18 willow_impact on 34/34 rows | MASTER_FINDINGS_REGISTER.csv | All carried. The CSV header is generated from the source-row shape, so a hand-maintained list can no longer drop a column. | source-preservation diff test |
| 10 | P2 | **CORRECTED_AND_VERIFIED** | Four July-10 columns were filed under semantically wrong destinations, inverting meaning twice | MASTER_FINDINGS_REGISTER.csv | Correctly-named columns added; the four destinations that do not exist in the July-10 register are now empty rather than filled with the nearest-looking field. | July-10 column-semantics test |
| 11 | P2 | **CORRECTED_AND_VERIFIED** | PR-13 and PR-15 declared 'Migration: no' while their own findings required one | FIRST_REMEDIATION_PR_TRAIN.md | Migration and Rollback are derived from the findings, not hand-set. | migration/rollback-derivation test |
| 12 | P2 | **CORRECTED_AND_VERIFIED** | The L18 app-first-then-revoke constraint was prose-only; the revoke PR's structured dependency did not name the app PR | FIRST_REMEDIATION_PR_TRAIN.md; MASTER_FINDINGS_REGISTER.json | `PR-11 → PR-10 deployed` is now a machine-readable edge in `pr_dependencies` and in the table's Depends-on cell, asserted explicitly by a test. Undefined 'parallel group' removed. | PR-dependency test |
| 13 | P2 | **CORRECTED_AND_VERIFIED** | The test cited for three ordering corrections never checked ordering — mutation-proved | tests/audits/findings-register-consistency.test.ts | Replaced with a test that parses the train table and compares every Depends-on cell to the derived graph. | the test itself (mutation-checked) |
| 14 | P2 | **CORRECTED_AND_VERIFIED** | The dependency plan claimed to be generated from canonical data but placed two train-NONE findings in T13 and fabricated a T2 dependency for two Chloe UI items | DEPENDENCY_REMEDIATION_PLAN.md | Train membership is now generated from the canonical `train` field with no globs, and dependencies are stated per finding, never train-wide. | train-membership test |
| 15 | P2 | **CORRECTED_AND_VERIFIED** | Two code-only WILLOW_NOW P1s were packaged into migration PRs behind lower-gate companions | FIRST_REMEDIATION_PR_TRAIN.md | The train was rebuilt on the rule that a code-only P1 is never packaged with migration work. F-PRIV-001 and F-COMP-001 now sit in code-only PRs. | trapped-P1 test |
| 16 | P2 | **CORRECTED_AND_VERIFIED** | F-CLIN-004 was demoted on grounds its own record refutes and that are not applied to the P1s beside it | MASTER_FINDINGS_REGISTER.json; CURRENT_P0_P1_REPORT.md | Raised to **P1/WILLOW_NOW**. Reversibility does not separate it from CHLOE-001 or F-COMP-001; a silenced clinical-safety prompt on a live studio is a P1. | F-CLIN-004 severity test |
| 17 | P2 | **CORRECTED_AND_VERIFIED** | Pass-1 item 14 falsely closed — three findings still cited the Upstash config fact F-OPS-001 resolved | MASTER_FINDINGS_REGISTER.json | All three rewritten to cross-reference F-OPS-001 and keep only the live-outage residual. | stale-Upstash test |
| 18 | P2 | **CORRECTED_AND_VERIFIED** | Pass-1 item 24's stated correction did not exist — the comms train was deleted, not given predecessors; the train numbering also skipped T12 | DEPENDENCY_REMEDIATION_PLAN.md | Trains renamed and regenerated from canonical membership with no gaps; F-OPS-002 carries a stated reason for being outside this tranche. | train-membership + unscheduled-coverage tests |
| 19 | P3 | **CORRECTED_AND_VERIFIED** | F-BILL-001 claimed it could not verify whether hone.care/pricing publishes plans — the page is in the frozen tree and does | MASTER_FINDINGS_REGISTER.json | The resolvable half deleted and what app/pricing/page.tsx actually publishes recorded. N-DOC-001 extended to cover the pricing page, so PR-02 corrects both surfaces together. | n/a (documentation) |
| 20 | P3 | **CORRECTED_AND_VERIFIED** | The pass-1 correction to F-PAY-001 deleted the only statement of its present-day Willow risk | MASTER_FINDINGS_REGISTER.json; CURRENT_P0_P1_REPORT.md | `Willow_risk` restored with the concrete mechanism and line references, keeping the 'no active non-owner' qualifier that justifies BEFORE_STUDIO_2 for the authorization half only. | n/a (documentation) |
| 21 | P3 | **CORRECTED_AND_VERIFIED** | The source-preservation guards only asserted non-emptiness and never opened either source register | tests/audits/findings-register-consistency.test.ts | The July-18 register is in-repo and is now diffed cell-by-cell against the CSV. | source-preservation diff test |
| 22 | P3 | **CORRECTED_AND_VERIFIED** | Fourteen open findings had no PR while the plan's train→PR arrows read as full coverage | DEPENDENCY_REMEDIATION_PLAN.md | The plan states it is a first tranche, lists every unscheduled finding with a reason, and the three P2 gate blockers (F-RET-001, F-STORAGE-001, F-OFF-001) were given PRs. Everything still unscheduled is P3. | unscheduled-coverage test |
| 23 | P3 | **CORRECTED_AND_VERIFIED** | F-RET-001 was gated BEFORE_PUBLIC_SELF_SERVICE while two structurally identical live-false-published-claim findings were WILLOW_NOW | MASTER_FINDINGS_REGISTER.json; LAUNCH_GATE_MATRIX.md | Split by component: the published claim is **WILLOW_NOW** and corrected in PR-02 with N-DOC-001 and F-COMP-001; the purge/legal-hold implementation stays BEFORE_PUBLIC_SELF_SERVICE in PR-21. | published-claim gate-parity test |
| 24 | P3 | **CORRECTED_AND_VERIFIED** | Pass-1 item 8's correction was applied only to `train` — F-EXEC-001 still carried the clinical product decision and a POST_GA gate | MASTER_FINDINGS_REGISTER.json; LAUNCH_GATE_MATRIX.md | product_decision `n/a`, gate `NONE_CLOSED`; the emitter no longer applies the clinical decision to any non-clinical finding. | closed-finding product-decision test |
| 25 | P3 | **CORRECTED_AND_VERIFIED** | Open/partial counts were inflated by one wherever EVIDENCE_LIMITATION was counted as open | RECONCILIATION_REPORT.md; LAUNCH_GATE_MATRIX.md; tests | One shared convention: EVIDENCE_LIMITATION is never open and always has its own column. Recorded in the register as `open_status_convention` and asserted against every gate heading. | count-convention test |

## Disposition totals

| | Pass 1 | Pass 2 |
|---|---|---|
| CORRECTED_AND_VERIFIED | 16 | 25 |
| REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED | 12 | — |
| DUPLICATE_OF_REVIEW_ITEM_<N> | 5 | 0 |
| **Total** | **33** | **25** |

**58 items, 58 final dispositions, none open.** Every pass-2 defect was corrected; none was refuted.

## What changed about how closure is verified

Pass 2 mutation-tested the guards that pass 1 cited as evidence and found three of them unable to
detect the defect they were credited with closing:

- the Willow-fact test grepped for a phrase (`practitioner count is unknown`) that appears in no
  artifact, while six live locations said the count could not be determined;
- the "dependency graph is acyclic and nothing precedes its dependency" test never read the PR train —
  deleting real `Depends on` cells left the suite fully green;
- the source-preservation tests never opened either source register, so they asserted only that a cell
  was non-empty.

All three are replaced with guards that read the artifact under test, and each was mutation-checked by
reverting the correction and confirming a red suite.
