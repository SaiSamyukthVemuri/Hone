---
title: Hone Canonical Roadmap & Development North Star
id: RDM-001
version: 1.17
publication_structure: v1.15 (RDM-001, 15 September 2026)
status: CANONICAL — repository working edition, synchronized from the v1.15 publication
owner: Sam Vemuri
as_of: 2026-09-20
repository: SaiSamyukthVemuri/Hone
production_branch: claude/build-hone-saas-hOex7
production_sha_at_sync: c6bc5949fda353610bbd3477b2395a5ed490cf1b
hosted_migration_max_at_sync: "0201"
hosted_state_authority: docs/production/migration-state.json
---

<!-- RDM-001 v1.17 | Level 3 WAIT priority decision + 20 September production synchronization. PERFORMED. -->
<!-- Working path: docs/roadmap/CANONICAL_ROADMAP.md (this file is the repository edition). -->
<!-- Source v1.15 MD SHA-256: 7795a75fa766a37aa84a31062e9d591ff0a5d5a7d4db4b7193edbdcb9ac36b8d -->
<!-- Source v1.14 MD SHA-256: 356b3ceda49850b26b6729d0a140100a5f5afd3809c625c7d3437d06e08cf2e2 -->
<!-- Source v1.14 DOCX SHA-256: 10367ba9b430279a87e5a966db3dbc50766e2b3726f8628152d847c855cef677 -->

# HONE / Operating brief

**Treatment Memory into daily practice**

Canonical Roadmap & Development North Star  ·  RDM-001  ·  v1.17

20 September 2026 decision edition  |  Level 3 WAIT becomes Hone's top product priority; synchronized through production #749

> **v1.17 records a product-priority decision, not a hidden release authorization.**
> Level 3 — the full Willow WAIT operating system — is now Hone's **top product priority**
> until Chloe can run and accept the complete real workflow. This edition also records
> the 20 September production tranche through #749. MultiPlex remains next after Level 3;
> ONB/UI/UX/marketing and supporting lanes may **build, review, refresh and ship in parallel release lanes** when they are independent of WAIT. Level 3 remains the top customer outcome, not a global freeze. Production concurrency remains one at the instant of each merge/provider/migration action: ready lanes use a fast serialized merge conveyor so one release does not invalidate another silently.
> No provider send, hosted mutation or migration number is authorized merely by this document. [§§0.10, 7–8, 23]

Hone helps an electrology practitioner carry reliable treatment context from one visit to the next and operate the surrounding booking, payment and record-keeping workflow. The immediate product outcome is Willow’s complete waitlist-to-consultation journey.

**Position at the recorded checkpoint**

| **Position** | **Recorded evidence and limit** |
| --- | --- |
| Gate A: supervised Willow pilot | A substantial clinical pilot, not yet evidence of repeatable commercial operation. Independent paid-studio proof is not established in this record. [§§3, 10] |
| Source and hosted observations | ⚠️ **SUPERSEDED OBSERVATION, PRESERVED AS DATED HISTORY (noted 2026-09-19).** The two readings that follow were true at the 17 September sync and are **not** current — §3 classifies the same SHA and deployment as superseded, and production has since advanced through at least #715, #727, #730, #734, #736 and #738. A fresh `git rev-parse origin/claude/build-hone-saas-hOex7` on **2026-09-20** returned **`249b7456982f6f7e1fa750b577552beda6758f19`** (merge of #739). **No replacement provider reading is asserted here** — the current deployment's `meta.githubCommitSha` was not read. THE DATED OBSERVATIONS: **VERIFIED_REPO:** production branch was `a946a983ac9b8da379bc869e21b32a5a3d50e548` after merged #712. **VERIFIED_PROVIDER:** the Vercel production deployment serving `hone.care` / `www.hone.care` carried that exact 40-character SHA. **VERIFIED_REPO:** ⚠️ **CORRECTED AND THEN RECONCILED 2026-09-19.** This row recorded both the hosted and repository maxima as `0198`, and described the following number as still free. `0199` was in fact **applied to production on 2026-09-18** from the reviewed #716 head, leaving production ahead of a repository that did not contain the file. **That divergence is now closed**: the applied `0199` file and its record were carried into the tree, so hosted max was **`0199`**, repository max **`0199`**, at parity with nothing pending. ⚠️ **UPDATED 2026-09-20:** `0200` (WAIT-P1-EXIT, #741) has since been applied, so hosted and repository maxima are both **`0200`**, still at parity with nothing pending, and **the next free number is NOT stated here** — it was stated as `0200`, and `0200` was then allocated and applied; derive it with `npm run migration:state`. `0199` is APPLIED and FROZEN — never edit it; any correction is a new forward migration. #709 and its 0197 are merged and applied. [§3; S37–S40, S42] |

**Usable baseline**

Historically shipped: clinical notes, multi-area charting, repeat-client fast start, Dashboard navigation, global search, card and attested-payment outcomes, booking management, sterile discard, owner capacity and Financials foundations. Historical-read authority, operational proof and full portability still have explicit limits. [§9]

**Current delivery**

WAIT-03 core is **MERGED / DEPLOYED** and, since v1.15, **PRODUCTION-EXERCISED END TO END** on the controlled test studio. The Invitation-capacity gap that v1.15 recorded — `no_admission_round` — was repaired by #709, which merged on 16 September with its migration 0197; #713 then added the live-invitation read as 0198. The post-0198 canary **passed all twelve seams** on the test studio, covering capacity opening, invitation, recipient proof, scoped slot offers, booking, atomic waitlist conversion and the fail-closed refusal on exhausted capacity. Post-canary cleanup is complete and no open canary state remains. #712 then shipped **WAIT-04A**, wiring three commands migration 0193 had already applied. ⚠️ **CORRECTED 2026-09-19: #712 IS NOT THE CURRENT PRODUCTION HEAD** — this paragraph said it was, which §3 in this same document now marks superseded. Production has advanced through at least #715, #727, #730, #734, #736 and #738; a fresh `git rev-parse origin/claude/build-hone-saas-hOex7` on **2026-09-20** returned `249b7456982f6f7e1fa750b577552beda6758f19` (merge of #739). **Re-read it rather than quoting any SHA from this paragraph.** Willow’s existing waitlist is preserved. **CORRECTED 2026-09-19 (WAIT-DOCS-RECON) — recorded, not deleted:** this sentence declared Willow’s durable WAIT switched off by intent, with no durable cutover performed — and that was **false when written**. Willow has been on the **durable** commit point since on or before **2026-08-25**; a read-only query on 2026-09-19 returned **28 durable Willow rows**, 27 of them `waiting`. The cutover was performed without a release record. What has **not** happened on that studio is anything beyond joining: **zero invitations have ever been issued there**, and owner device acceptance is outstanding. The continuity defect Chloe raised — rollout gating hiding the Waitlist navigation while the list still exists — is unchanged and still owed. WAIT-04 seams S1–S5 and Chloe device acceptance remain required; **no provider or SMS activation has occurred.** [§§3, 14.5, 15, 17, 23; S37–S40, S42]

**20 September 2026 — Level 3 WAIT checkpoint / TOP PRODUCT PRIORITY**

Production now includes the WAIT-P1-EXIT application release (#741, carrying the 0201
forward correction from #747), the **48-hour default** for invitation opportunities (#748), and the
owner-visible **read-only SMS sender status** (#749). #741 closes the redeemed-but-unbooked
dead end without inferring an appointment relationship Hone cannot prove; #748 changes the
normal/default invitation opportunity to 48 hours while preserving the 1..168 configured bound;
the live composer still permits another TTL, so the frozen no-expiry-choice 48-hour policy remains Level 3 work;
#749 lets an owner see sender state without provisioning, purchasing, releasing, adopting,
rewiring #716 or removing the shared fallback.

These releases move Hone through **Level 1 (durable queue)** and the shipped core of
**Level 2 (Invite-to-book)**. They do **not** complete the original Willow contract.
**Level 3 — Full WAIT Operating System** is now the sole top customer outcome. It is not
DONE until the retrospective Willow queue/provenance reconciliation, trustworthy owner
discoverability/control, WAIT-04B rich prospect profile, verified mobile + prospect
STOP/suppression, supported studio-sender provisioning/adoption and Willow sender proof,
**fixed 48-hour policy with no practitioner expiry choice**, email + eligible SMS as one opportunity,
the WAIT-specific 24-hour reminder, all four
recipient response choices, first-consult cancellation/reschedule/no-show boundaries, and
Chloe's real-device acceptance are complete. A controlled email-only canary may be used only
under the normal release/activation gates; this roadmap does not itself authorize a real
customer message or provider effect.

**Five-measure scorecard**

| **Measure** | **Initial reading from supplied evidence** |
| --- | --- |
| Accepted production outcomes / 7 days | UNMEASURED — merges are not user acceptance. |
| Scope-to-acceptance elapsed time | UNMEASURED — no matched start/acceptance series. |
| Unfinished delivery units + oldest age | PARTIAL — #741/#747, #748 and #749 are shipped. The active critical path is now **Level 3 WAIT**: retrospective Willow reconciliation/owner control → WAIT-04B profile authority → verified mobile + STOP/suppression → supported sender provisioning/adoption + Willow proof → **fixed/no-choice 48h enforcement** → WAIT-04C dual-channel + 24h reminder → WAIT-04D four responses → first-consult boundaries → Chloe acceptance. Full count and oldest age remain unmeasured. |
| Independent paying studios with proof | NOT ESTABLISHED — census missing; Willow excluded. |
| Support minutes / studio / week | UNMEASURED — no operator time log supplied. |

Owner: Sam. First measurement: next release-readiness checkpoint, using existing acceptance, release and support records. §20 defines windows, counts and missing-data handling. Unknown is not zero.

**Next three customer outcomes**

Derived from §23.6. These are outcome groups, not three oversized pull requests.

| **Order / owner** | **Outcome and completion evidence** |
| --- | --- |
| 1  ·  **LEVEL 3 — Full Willow WAIT Operating System**<br>Sam: release<br>Chloe: acceptance | **TOP PRIORITY.** Level 1 durable queue and the Level 2 Invite-to-book core are shipped; #741/#747 add the safe redeemed-no-booking exit, #748 makes the default opportunity 48 hours (the composer still allows other TTLs), and #749 exposes read-only sender state. Finish retrospective Willow reconciliation + owner control, WAIT-04B rich profile, verified mobile/STOP, supported Willow sender activation, **fixed/no-choice 48h policy**, email+eligible SMS, 24h reminder, four response choices, first-consult lifecycle rules, then record Chloe real-device acceptance. Only then call Willow WAIT launch DONE. |
| 2  ·  MultiPlex<br>Chloe: field contract<br>Builder: assigned by Sam | Capture the complete agreed MultiPlex settings and retrieve the relevant setup at the next visit. MPX-01 freezes fields; MPX-02/03 supply storage and charting; MPX-04/05 preserve memory and prep. Confirm the TM-01 dependency and record on-device acceptance. |
| 3  ·  September 7 workflow batch<br>Chloe: acceptance<br>One owner per item | Deliver notes fixes, reduced checkout friction, actionable disinfection, notification preferences and the agreed client-management/booking-privacy improvements. Keep each item bounded; record its acceptance separately. Follow the existing bugs → friction → features order. |

**Parallel and deferred**

FIN-02 remains isolated preparation; product priority is §23.6. Trust gates continue. **Level 3 WAIT is the top outcome but does not monopolize release throughput.** ONB, UI/UX, SIGNOUT and marketing may build/review and ship independently in parallel lanes when they do not overlap WAIT authority, migrations, provider effects or the same files. A bounded security-guard hardening lane, Laura/ONBOARD readiness proof, marketing successor architecture and inert charting groundwork may also move in parallel. Receipt follow-ons stay out of the critical path. Forecasting, bulk messaging and broad automation remain deferred. Developer-platform work does not change **Level 3 WAIT → MultiPlex** priority. [§23.8; S37, S40]

**Next release decisions**

| **Decision / accountable role** | **Next evidence or action** |
| --- | --- |
| Sam + WAIT-04 seam owner | **#709 is closed — merged 16 Sep, 0197 applied, and the P2 migration-state record resolved.** The standing role is now the WAIT-04 seam sequence, starting with its zero-migration units: the S2 invalidate caller (`invalidate_waitlist_invitation_proof`, **still zero callers**) and the S1 preference-grant callers (`issue_`/`redeem_`/`revoke_waitlist_preference_grant`, **all three still zero callers, and the grants table holds zero rows**). ⚠️ **CORRECTED 2026-09-19: the S3 resolver is NO LONGER A WAIT UNIT.** #715 merged the fail-closed resolver (`lib/sms/studio-sender.ts` calling `resolve_active_studio_sms_sender`); what is still uncalled is `resolveStudioSmsSender` itself, and wiring it belongs to the **platform communications** lane with #716, not to WAIT — see the S3 separation row in §0. Do not reopen shipped 0197/0198 runtime without a new finding. |
| Sam / release operator | **DISCHARGED 16 Sep — recorded, not deleted.** The standing instruction read: "Run read-only hosted preflight for 0197; with a fresh explicit T3 GO, apply/verify/reconcile 0197 before merging the application revision." 0197 was preflighted, applied, verified and reconciled, and 0198 followed through #713. ⚠️ **UPDATED 2026-09-19, AND AGAIN 2026-09-20:** hosted max is **`0201`** (the WAIT-P1-EXIT forward authority contraction, #747, applied 2026-09-20; `0200` — WAIT-P1-EXIT itself, applied the same day from the reviewed #741 head `6de5fb4c` — and `0199` both remain applied and frozen beneath it), so **no migration is assigned to this role today**. **THE NEXT FREE NUMBER IS NOT STATED HERE** — this row named `0200` as free while `0200` was being allocated, which is the hazard itself; derive it with `npm run migration:state`. A new number needs that fresh derivation, a single-allocator decision and its own T3 GO. Production concurrency remains one. |
| Sam / canary owner | **Discharged 16 Sep — CANARY_PASS, 12 of 12 seams, cleanup complete.** The run covered open capacity → invite → email → recipient proof → scoped slots → book → conversion/delivery/reload truth → full-capacity refusal. A future canary opens a new authorization; it does not inherit this one. |
| Sam + Chloe | ⚠️ **AMENDED 2026-09-19 — THE CUTOVER IS NOT PENDING.** This directed an operator to restore discoverability, implement owner-controlled New client intake, reconcile Willow’s existing queue, and only afterwards authorize the durable cutover. That last step happened on or before **2026-08-25**, ahead of all three. **What remains:** restore trustworthy waitlist discoverability; implement owner-controlled New client intake; reconcile Willow’s existing queue **retrospectively**; and write the activation's missing governance record. Complete WAIT-04 and record Chloe device acceptance before declaring Willow WAIT launch DONE. |

**Publish once; maintain one set of decisions**

**Repository synchronization has occurred.** This file — `docs/roadmap/CANONICAL_ROADMAP.md` — **is** the maintained working edition as of **v1.17**; the brief and DOCX are derived publications from it. Update it on a material decision or evidence change—not every commit. *Superseded v1.15 wording, recorded rather than deleted:* "The matching Markdown file is prepared for reviewed synchronization to docs/roadmap/CANONICAL_ROADMAP.md. It has not been committed. After synchronization, that file is the maintained working edition." [§§0.5, 0.10]

Read next: §23.6 for product priority; §23.1 for release exits; §14.5.7 for WAIT; §§16.6–16.8 for the developer platform; §20 for measurement; §§7–8 for release authority. Evidence limits remain in §3 and Appendix D.

# Operating map

Start with the two-page operating brief. Use §23.6 as the single current product-priority list, §23.1 for release exits, §14.5.7 for the frozen Chloe contract and §20 for five operating measurements. Read the detailed program and authority sections for the task at hand. §3 is dated evidence, not live telemetry; Appendix F is history, not runnable instructions.

[0. Document authority, evidence classes and decisions](#hone_s_0)

[1. North Star and product thesis](#hone_s_1)

[2. Mandatory boot and handoff protocol](#hone_s_2)

[3. Dated source, hosted and tooling observations](#hone_s_3)

[4. Standing product and engineering laws](#hone_s_4)

[5. Portfolio allocation and work-in-progress limits](#hone_s_5)

[6. Severity, priority and risk](#hone_s_6)

[7. PR lifecycle, review and stop laws](#hone_s_7)

[8. Release, migration and production discipline](#hone_s_8)

[9. Capability baseline and current deltas](#hone_s_9)

[10. Commercial milestones and launch gates](#hone_s_10)

[11. Wave 0 / roadmap maintenance](#hone_s_11)

[12. Known-finding reconciliation, not a new broad audit](#hone_s_12)

[13. Trust / security / reliability program](#hone_s_13)

[14. Practitioner product, WAIT-03 / WAIT-04, forecasting and Financials](#hone_s_14)

[15. SaaS activation and the COMMS rollout](#hone_s_15)

[16. Developer platform, control plane and authority re-entry](#hone_s_16)

[17. Chloe feedback and acceptance](#hone_s_17)

[18. Design partners and commercial proof](#hone_s_18)

[19. Grounded AI — later](#hone_s_19)

[20. Scorecard and portfolio health](#hone_s_20)

[21. Explicit not-building list](#hone_s_21)

[22. Definition of DONE for Hone v1](#hone_s_22)

[23. Current executive queue, release exits and accountable roles](#hone_s_23)

v1.15 changes: records merged/deployed #708 WAIT core, hosted 0192–0196, the controlled test-studio canary, #709/0197 Invitation-capacity authority repair, Willow navigation continuity and the accepted owner-control direction; records #702 automatic card receipt + PDF as shipped. WAIT → MultiPlex → September 7 remains the product order; WAIT is not DONE until the Willow journey and accepted WAIT-04 policy are complete. Retired overlays remain in F.7. [S37–S40]

v1.16 changes: synchronizes the v1.15 publication into the repository. Records #709/0197, #713/0198 and #712 (WAIT-04A) as merged, hosted max `0198` with `0199` unallocated, CANARY_PASS 12/12 with post-canary cleanup complete, and the Vercel exact-source match at `a946a983…`. Preserves all 89 repository v1.1 IDs and the SEC-09 clinical-finalization retirement in Appendix G. WAIT → MultiPlex → September 7 remains the product order; WAIT is not DONE until the Willow journey and accepted WAIT-04 policy are complete. [S42]

v1.17 changes: **Level 3 — Full WAIT Operating System becomes the sole top product priority.** Records #741/#747, #748 and #749 as shipped production software; the normal invitation default is now 48 hours, while the fixed/no-expiry-choice 48-hour policy remains open, the redeemed-but-unbooked exit is live under the 0201 authority contraction, and the owner can see truthful SMS sender state. These do not make WAIT SMS, the rich profile, the 24-hour WAIT reminder, four-response UX, first-consult lifecycle or Chloe acceptance complete. MultiPlex remains next only after Level 3 is operationally accepted; ONB/UI/UX remain parallel/subordinate and production concurrency remains one.

Appendices A–E retain artifact disposition, failed-workstream contracts, illustrative record schemas, source provenance and the historical Willow capacity baseline. Appendix F preserves superseded operating records. No roadmap item ID or accepted capability is deleted.

<a id="hone_s_0"></a>
# 0. Document Authority, Scope and Change Control

| **READ FIRST  This document governs direction and delivery discipline. It is not live production telemetry. Only §3 is the current operational snapshot; archived “current”, “next”, “GO” and migration numbers elsewhere are dated evidence and confer no authority.** |
| --- |

<a id="hone_s_0_1"></a>
## 0.1 What this document governs

Product strategy and the North Star for the practitioner and studio experience.

The permanent portfolio model: Trust/Security, Planned Product, SaaS/Activation, and the protected Interrupt reserve.

Milestones and launch gates from Willow through design partners, ordinary self-service studios, scale and enterprise.

The canonical roadmap item IDs, dependency order, PR decomposition, scope budgets and stop laws.

How Chloe feedback, incidents, audits, security findings and ad hoc requests enter the roadmap.

Engineering authority rules: server-owned truth, UNKNOWN semantics, migration discipline, release gates, review requirements and failed-branch handling.

What Hone deliberately is not building yet, and the definition of DONE for Hone v1.

<a id="hone_s_0_2"></a>
## 0.2 Authority is assigned by fact domain

| **Question** | **Authoritative evidence** | **What cannot substitute** |
| --- | --- | --- |
| What should Hone build? | Sam’s explicit accepted decisions and the maintained RDM-001 roadmap. New proposals remain labeled PROPOSED. | A PR body, builder preference or unclassified feedback cannot silently reset priorities. |
| What source is on the production branch? | Fresh GitHub ref and exact immutable commit. [S2] | An old handoff, branch name alone or local checkout. |
| What artifact is serving users? | Actual deployment/version evidence for the production service, followed by the relevant smoke. | A merged PR or production-branch SHA alone. |
| What schema/data state is hosted? | Fresh read-only production catalog/history/behavior. The canonical migration record is the dated, persistent report of that observation. [S3] | Repository filenames or a stale JSON declaration cannot overrule a newer hosted observation. |
| What exists at Twilio or another provider? | Authorized provider inspection, callbacks and actual effect/delivery evidence, scoped to the resource and time. | Zero Hone database rows do not establish zero external resources. |
| What was tested or reviewed? | Exact commit/base, test environment, selected/executed coverage, original reviewed commit and completed review outcome. | Green on another head, skipped tests, re-anchored comments, silence or a time-adjacent thumbs-up. |
| Does the practitioner accept it? | Named human acceptance on the intended workflow/device with result and date. | Unit tests, a screenshot of code or an author’s DONE declaration. |
| What is happening locally? | Dated worktree/branch/head/dirty state and ownership report. | An assignment is not proof it started; an unpushed commit is not merged capability. |

<a id="hone_s_0_3"></a>
## 0.3 Evidence labels and state vocabulary

Use VERIFIED_REPO, RECORDED_HOSTED_OBSERVATION, OPERATOR_REPORTED, USER_REQUIREMENT, ACCEPTED_PRIORITY, PROPOSED_DESIGN, HISTORICAL and UNKNOWN explicitly. A fresh read of a report does not refresh the event time of the observation it describes.

Track capability stages separately: DESIGNED → BUILT → MERGED → DEPLOYED → ENABLED → PRODUCTION-EXERCISED → USER-ACCEPTED. Finding dispositions remain CLOSED_EVIDENCED / OPEN / DOWNGRADED / SUPERSEDED / ACCEPTED_LIMITATION / EXTERNAL_DEPENDENCY / UNKNOWN. “Not verified here” is not “does not exist”.

These are human-governed record conventions, not a claim that an authoritative control-plane ledger or automatic readiness engine has shipped. Section 16 retains that program’s re-entry gate.

<a id="hone_s_0_4"></a>
## 0.4 Decision index — one current home per topic

The detailed contract lives in the section named below. Summaries, feedback records and historical overlays route to it; they do not become additional operating instructions. The original v1.11 overlay is preserved in F.7.1. [S33]

| **Decision domain** | **Maintained home** | **Scope** |
| --- | --- | --- |
| Current product order | §23.6 | One priority list; component milestones are §23.1. |
| Chloe WAIT requirements | §14.5.7 | Frozen launch contract; §14.5.9 is the acceptance matrix. |
| Source, schema and provider facts | §3; fresh evidence before action | Dated checkpoint only. Authority remains fact-domain-specific (§0.2). |
| Trust and commercial readiness | §§10, 13, 18 | Supervised Gate B is distinct from full v1 / Gate C autonomy. |
| Convergence and release discipline | §§7–8 | Existing thresholds and human production boundary remain binding. |
| Publication and measurement | §0.5; §20 | One working edition, derived publications and five operating measures. |
| Developer-platform adoption | §§16.6–16.8; supporting order §23.7 | One tooling backlog; dated canary evidence in §3.7. Product priority and authority re-entry remain separate. |
| **Design contract and design evidence** | **`DESIGN.md`** (binding contract); `docs/reviews/product-wide-design-audit-2026-09.md` (canonical evidence) | `DESIGN.md` is canonical for design decisions, subordinate to ENGINEERING_STANDARDS.md, and linked from CLAUDE.md. It classifies every statement **LAW** / **CONTRACT** / **PILOT** / **PRODUCT AUTHORITY REQUIRED**. The audit is **evidence and proposal, never authority** — nothing in it becomes a rule by being measured. Design product-authority questions stay open exactly as `DESIGN.md` records them; this index does not re-decide them. |

<a id="hone_s_0_5"></a>
## 0.5 Change control and publication

RDM-001 remains one logical roadmap. The maintained working edition is docs/roadmap/CANONICAL_ROADMAP.md after reviewed synchronization; the two-page brief and versioned DOCX ledger are publications of the same accepted decisions. Do not maintain three independent versions or build a new readiness/control-plane system. [S33]

Publication status for v1.15: this DOCX and matching Markdown edition are derived from the attached v1.14 pair (hashes in Appendix D) plus fresh GitHub evidence and Sam’s production/canary observations from 15 September local / 16 September UTC. That v1.15 document update itself performed no repository write, merge, hosted migration, provider action or customer send. **SUPERSEDED 2026-09-17 — recorded, not deleted.** It then read: "Repository synchronization remains PENDING. Until reviewed sync lands, identify this working copy as v1.15; an older repository copy must not silently override the newer accepted decisions." **That synchronization has landed — this file is it** (§0.10; Appendix D.0E). The repository edition is v1.16 and is now the working copy, so no newer unsynchronized accepted decision is outstanding. The v1.15 publication remains the structural source and its records are preserved unchanged. [S37–S41; S42]

Synchronization is a bounded RDM-001 documentation change: preserve IDs and source labels; compare the existing repository edition; retire contradictory active instructions; record the version, source document hash, accepted decision delta and review/commit reference. After sync, make ordinary edits in the maintained Markdown and publish the brief/DOCX from that accepted content. A copy or export is not proof of repository publication.

Refresh the operating brief when scope, release priority, a release decision or material evidence changes—not for every component commit. Record transient PR heads and terminal assignments in a dated session/release handoff. Update §3 only with named observations and their actual times. Archive superseded decisions; replace active contradictions and reference the single current home rather than appending another competing layer.

For every accepted change retain source, reason, affected IDs, superseded decision, dependencies, risk tier and acceptance owner. Mutable source, hosted and provider facts still require revalidation at the action boundary. This publication change neither supplies missing readiness evidence nor authorizes production. [§§0.2, 7–8]

<a id="hone_s_0_6"></a>
## 0.6 Change summary — recorded delivery stages

The product implementation readings below remain carried source evidence. The developer-tooling observations added in §3.7 do not refresh those stages or the hosted checkpoint. Subsequent product screenshots or assignments still require reconciliation before a new completion claim. [S32, S34, S35]

| **Evidence stage** | **Included in this edition** |
| --- | --- |
| Merged / deployed since v1.14 | #702 automatic successful-card receipt + Hone email + studio-branded PDF; #708 final WAIT release assembly carrying reviewed WAIT ancestry and migrations 0192–0196. Production branch at the v1.15 checkpoint was `a47eca0f…`. |
| Merged / deployed since v1.15 | #709 Invitation-capacity repair (migration 0197, merged 16 Sep); #713 owner read of `declined_at` completing the live predicate (migration 0198, merged 16 Sep); #712 WAIT-04A command wiring, no migration, merged 17 Sep. Production branch is now `a946a983…`. [S42] |
| Hosted / production exercised | 0192–0196 applied at the v1.15 checkpoint; **0197, 0198 and (on 2026-09-18) 0199 have since been applied and recorded**, leaving hosted max **`0199`** *(corrected 2026-09-19; this read `0198`)*. The post-0198 controlled canary ran the full twelve-seam journey to **CANARY_PASS**, including booking and atomic conversion, and post-canary cleanup is complete. No provider/SMS activation and no real message were part of any of it. [S42] |
| Active release candidate | None. The v1.15 candidate #709 **merged** on 16 September and its 0197 is applied; the P2 current-state migration-record contradiction it carried is resolved — `docs/production/migration-ledger.md` records both the 0197 and the 0198 apply. [S42] |
| Still required for Willow WAIT launch | The #709/0197 and canary steps are **done**. ⚠️ **AMENDED 2026-09-19 (WAIT-DOCS-RECON): “reconcile/migrate Willow” is PARTLY DISCHARGED — the durable migration already happened (on or before 2026-08-25). What remains under that heading is the legacy 2026-08-19→08-25 email-only window, the phone carry-forward, and the missing activation record — not the cutover itself.** What remains: restore Willow waitlist continuity → owner-controlled intake mode → finish Willow **data** reconciliation → complete WAIT-04 seams S1–S5 (S1 recipient responses **2 of 4**; S2 proof credential shape; S4 reminder/48h; S5 cancellation and re-entry) → Chloe device acceptance. [§§14.5, 15, 17, 23; S42] |
| ⚠️ **WAIT SMS outcome IS required; #716 itself is NOT the launch dependency** *(reconciled 2026-09-20)* | The earlier row incorrectly separated SMS from the launch contract. The frozen Chloe contract requires **email + eligible consented SMS as one invitation opportunity**, prospect STOP/suppression and a WAIT-specific reminder. What remains correctly separated is **#716's appointment-SMS no-fallback routing implementation**: it routes every appointment SMS through a studio-owned sender and removes the platform fallback, so it must not be used as a shortcut while sender activation is not product-operable/proven. #715's resolver and #749's read-only status are foundations, not the outcome. Level 3 may use a bounded WAIT-specific delivery path only after verified prospect mobile + suppression and a supported Willow sender are proven; whether #716 later ships is a separate platform-communications release decision. |

<a id="hone_s_0_7"></a>
## 0.7 Version lineage and v1.13 editorial decisions

v1.12 absorbed Work Plan v3. Its original decision overlay is retained in F.7.2. The accepted product order remains in §23.6, MultiPlex detail in §14.3, the September 7 batch in §14.6.1, and Visual Treatment Memory in §14.9. WAIT-INTAKE-01 remains an open decision; this editorial revision does not silently add or drop it. [S31]

v1.13 implements Sam’s acceptance of the document critique and qualified response: place a positive operating brief first; separate completion from component activity; replace the empty metric catalogue with five defined readings; publish a repository-readable edition; retire duplicate active overlays and pane coordinates. Source SHA and the accepted conversation decision are S32/S33.

Explicit corrections: §14.5.9 and the §23 opening no longer imply FIN-02 immediately follows WAIT; they route to §23.6. “Zero independent paying studios” is not a verified census in this source. Waitlist growth over roughly three weeks is not the engineering age of one unchanged specification. A supervised clinical pilot is not a whole-product safety certification. Earlier percentage and “hours, not days” assessments are not planning evidence.

No product scope, trust gate, authority rule, migration allocation or production authorization is changed by this editorial amendment. The current source/hosted checkpoint remains carried evidence. [S32, S33]

<a id="hone_s_0_8"></a>
## 0.8 v1.14 developer-platform amendment

This edition incorporates Sam's accepted Developer Platform / Agentic Engineering backlog: Graphify, Archify, the selected Matt Pocock skills, Apple/Emil design guidance, Context Mode, Herdr and Executor. The maintained backlog and operating boundaries are §§16.6–16.8; §23.7 records the supporting rollout order. These are not eight unstarted projects: retain each tool's actual stage and remaining acceptance gate. [S34–S36]

The supplied canary evidence is recorded separately in §3.7. It supports functional Context Mode use, one demonstrated Node-runtime split, and Herdr recovery in the named smoke environment. It does not establish fleet-wide installation, reliable automatic MCP startup, a host-reboot pass, crash-safe task execution or new production readiness. Prior Graphify/Archify/skills reports retain their original evidence limits. [S35, S36]

The WAIT → MultiPlex → September 7 workflow-batch product order in §23.6 is unchanged. Tooling does not become a hidden WAIT launch dependency, a new production mover or a reset of the retired control-plane program. Executor stays pending and subject to §16.5; no auto-merge, authoritative readiness engine or unattended production work is authorized by adding it to this backlog. Existing IDs, North Star, gates and historical records are retained. [S34, S35]

This is a document publication, not repository synchronization. The attached v1.13 editions remain the preserved source; source hashes and the accepted amendment are recorded in Appendix D. No live GitHub, hosted, provider or commercial census was performed for v1.14. The earlier completion percentages and round-count estimates in conversation are not adopted as planning evidence; report protected workflow exits under §§7.7, 20 and 23.1 instead.

<a id="hone_s_0_9"></a>
## 0.9 v1.15 WAIT-03 production/canary amendment

This amendment is evidence-driven rather than a scope reset. #708 moved the reviewed WAIT core from draft assembly to production; the controlled test-studio canary then proved public join and durable owner queue behavior and exposed the missing Invitation-capacity opening move. #709 is the bounded repair vehicle; 0197 is allocated to its narrow service-role consumed-count gateway and remains pending at this checkpoint. [S37–S39]

Two accepted product decisions are added without changing the WAIT → MultiPlex → September 7 order. First, existing waiting people must remain discoverable during legacy/durable migration; a rollout flag may not make the owner believe the list was deleted. Second, per-studio WAIT activation must become one server/database-owned **New client intake** setting (Open for booking / Waitlist / Closed). Vercel slug allowlists are rollout/kill-switch machinery, not the permanent studio workflow. Existing-client continuity remains binding.

The core release and the full Willow launch remain distinct states. WAIT-03 may be deployed while WAIT launch remains incomplete: 0197/#709, the production canary, Willow continuity/migration, and the accepted WAIT-04 contact/reminder/response/consultation policy still have their own gates. No automatic release, forecasting or provider activation is authorized by this amendment.

<a id="hone_s_0_10"></a>
## 0.10 v1.16 repository synchronization and post-#712 evidence refresh

This edition performs the repository synchronization that every edition from v1.12
onward recorded as outstanding. The v1.15 publication structure is adopted
unchanged: §§0–23 and the appendices, the §0.3 evidence labels, the §0.4 decision
index, the §§7–8 release authority, the §16 developer-platform boundaries and
§23.6 as the single product-priority list all carry over as published. No product
scope, authority rule, gate, priority order or migration allocation is changed
here. [§§0.5, 0.9]

Three things changed, and nothing else.

**One — mutable evidence was refreshed to the post-#712 state.** Every refreshed
fact was independently reverified at synchronization time against its own
authority rather than copied from a summary: the production SHA from
`origin/claude/build-hone-saas-hOex7`; the merge state of #709, #712 and #713 from
the GitHub API; hosted migration max from `docs/production/migration-state.json`
with the apply records in `docs/production/migration-ledger.md`; repository max by
census of `supabase/migrations/*.sql`; and the serving deployment SHA from Vercel
deployment metadata resolved **by hostname**, not by the project's nominal
production label. The v1.15 readings these replace are preserved in §0.6, §3 and
Appendix D.

**Two — instructions the evidence had made false were retired in place.** v1.15's
numbering hold treated `0198` as conditional next-free behind a pending `0197`;
both are now applied; `0199` followed on 2026-09-18 and is applied too, and ⚠️ **as of 2026-09-20 `0200` is applied as well** (WAIT-P1-EXIT, #741), so **the next free number is NOT stated here** — it was stated as `0200`, and `0200` was then allocated and applied; derive it with `npm run migration:state`. v1.15 recorded `no_admission_round`
as an open canary failure; the post-0198 canary passed all twelve seams. v1.15
recorded #709 as an unmerged draft. Each superseded statement is retained as a
dated record rather than deleted. [§§3, 23.3, 23.4]

**Three — the repository's own program was preserved as history.** The repository
roadmap had stood at v1.1 since 2 August 2026 and editions 1.2–1.14 never reached
it, so this synchronization crosses two ID generations whose vocabularies overlap
in only four tokens. All 89 v1.1 IDs are preserved in **Appendix G** with an
explicit disposition; none is deleted or renumbered. The clinical-finalization
decision the repository carried as SEC-09 is preserved in full in §G.1, because
the v1.15 source is silent on it and silence does not supersede a product
decision. [§G]

The WAIT → MultiPlex → September 7 workflow-batch order in §23.6 is unchanged.
Developer-platform and tooling promotion remains a supporting workstream under
§§16.6–16.8 and §23.7 and does not become a product prerequisite or a WAIT launch
dependency. No runtime, database, migration, provider or production change is
carried by this edition, and it authorizes none.

<a id="hone_s_1"></a>
# 1. Executive North Star and Product Thesis

| **NORTH STAR  Client enters the room -> client leaves the room: minimize navigation, clicks, repeated cognition and duplicated information while preserving clinical, booking and payment correctness.** |
| --- |

Hone is not trying to become another generic booking calendar. Its strategic moat remains longitudinal practitioner memory: what happened last time, what worked, what changed, what needs attention today, and what should happen next. Admission control extends that memory into a practice operating system: know not only whether a consultation slot is empty, but whether accepting that client leaves enough recurring treatment capacity to serve them well afterward.

<a id="hone_s_1_1"></a>
## 1.1 Strategic progression

| **Stage** | **Meaning** | **Proof of value** |
| --- | --- | --- |
| Treatment Memory | Remember the client across visits. | Prior settings, areas, modality, reactions, tolerance, cautions, notes, photos and next-visit instructions are retrievable in seconds. |
| Practice Memory | Remember unresolved operational work across the practice. | Closeout, rebooking, due clients, unfinished charting, payment and record-keeping become one truthful operating loop. |
| Practice Operating System | Turn memory into reliable studio execution. | Studio can onboard, import, operate, recover, export and leave Hone without founder intervention. |
| Admission Control / Capacity Intelligence | Turn observed demand, conversion, cadence and treatment capacity into a safe intake budget. | First-treatment lead time, latent recurring demand, waitlist pressure and outstanding invitations determine how many new clients may safely enter - not calendar whiteness alone. |
| AI-Native Practice Intelligence | Use grounded recorded facts to summarize and assist. | AI explains and drafts from authoritative facts; it does not invent clinical or financial truth. |

| **NEW PRODUCT LAW  OPEN SLOT != SAFE ADMISSION. A consultation can fit today while the treatment workload it creates cannot fit next week. Admission decisions must consider post-consultation treatment capacity and recurring demand.** |
| --- |

<a id="hone_s_1_2"></a>
## 1.2 CEO-level governing constraint

| **DO NOT CHASE BREADTH  Do not chase enterprise breadth, generic AI, commodity POS or broad integrations until ordinary studios can onboard, import, operate, recover, export and leave Hone without founder intervention.** |
| --- |

<a id="hone_s_1_3"></a>
## 1.3 What success should feel like

For Chloe/practitioner: the next action is obvious; previous treatment context is available without searching; charting starts from truth rather than memory; checkout and rebooking are part of the same visit workflow.

For the owner: money, capacity, due clients and unresolved work are truthful, separate from the practitioner daily Dashboard, and traceable to authoritative timestamps and records.

For a new studio: launch does not require Sam to perform hidden configuration or rescue partial imports.

For a client: booking, consent, payment, cancellation and rebooking are clear, safe and do not expose internal provider or audit details.

For engineering: source, database, CI, review and production evidence agree; unknowns are explicit; a failed branch cannot silently become architecture.

For prospective new clients: when treatment capacity is constrained, the experience should become a truthful waitlist or private invitation flow before they spend time choosing a consultation slot that the practice cannot responsibly support.

For capacity decisions: Hone distinguishes booked capacity from latent recurring demand, mature conversion evidence from immature cohorts, and provider acceptance from real inbox delivery; UNKNOWN remains visible rather than silently treated as spare capacity.

<a id="hone_s_2"></a>
# 2. New-Session Boot Protocol

| **MANDATORY  Before any Claude/ChatGPT/Codex session implements or releases work, it must re-establish current production and roadmap state. No future session may rely on the time-stamped snapshot in Section 3 as live truth.** |
| --- |

| **Step** | **Action** | **Required outcome** |
| --- | --- | --- |
| 1 | Read this roadmap | Identify the parent milestone, item ID, product contract, authority map, risk tier and stop law. |
| 2 | Revalidate production branch | Fetch current `claude/build-hone-saas-hOex7` and record exact SHA. |
| 3 | Revalidate migration truth | Read canonical migration state AND, for a production-affecting action, compare with hosted migration history. |
| 4 | Revalidate PR state | Current head, base, mergeability, open/closed/merged state, exact-head CI, Codex surfaces. |
| 5 | Revalidate dependencies | Confirm prerequisite roadmap items are actually DONE, not merely merged. |
| 6 | Establish authority map | For T2+: identify which layer owns each mutable fact before implementation. |
| 7 | Establish scope budget | Expected runtime files, tests and LOC; hard review threshold. |
| 8 | Work in a fresh branch/worktree | Rebuilds start from current production; failed branches are reference-only. |
| 9 | Run focused proof first | Behavioral tests and anti-vacuity controls before broad CI. |
| 10 | Release only from exact reviewed head | Changed head invalidates earlier authorization. Production concurrency is one. |

<a id="hone_s_2_1"></a>
## 2.1 The release packet and context handoff

For the next authorized unit, record TARGET · STATE_REVISION · EVIDENCE_SOURCE · OBSERVED_AT · EVIDENCE_CLASS · VERDICT · LIMITATION · OWNER · NEXT_GATE. Each fact names its own revision and observation time; one “verified now” heading must not make old provider, hosted or local reports appear fresh.

Before a saturated Claude session is cleared, save a secret-free durable checkpoint outside /tmp with worktree, branch, local/remote heads, dirty and unpushed work, resource owners, exact evidence links, unresolved findings, last authorized action and explicit HOLDs. On resume, re-read it and revalidate mutable facts; do not blindly reset to the checkpoint.

Use one watcher per exact revision. A superseded watcher is historical evidence. Never test against another worktree’s server, reset another lane’s shared database, discard unpushed work or interpret suggested terminal text as a command to execute.

<a id="hone_s_3"></a>
# 3. Recorded Operational Checkpoint and Tooling Evidence

| **CURRENT SNAPSHOT — 17 September 2026 UTC, post-#712. Revalidate before every production action.** |
| --- |
| v1.16 refreshes only the named facts below. Repository and hosted facts are fresh reads of their own authorities; the canary, cleanup and deployment facts are the durable release records of 16–17 September. §3.1–§3.7 retain historical provenance from v1.14, and the v1.15 checkpoint this edition supersedes is preserved in **Appendix D.0D (S37–S40)** alongside the §0.9 amendment — none of them is the current release state. [S37–S40, S42] |

| **Domain** | **Current evidence** | **Boundary / next verification** |
| --- | --- | --- |
| Production source | ⚠️ **SUPERSEDED OBSERVATION, PRESERVED AS DATED HISTORY (noted 2026-09-19).** What follows was true at the 17 September sync and is **not** the current head: production has advanced at least through #715, #727, #730, #734, #736, #738 and #739. A fresh `git rev-parse origin/claude/build-hone-saas-hOex7` on **2026-09-20** returned **`249b7456982f6f7e1fa750b577552beda6758f19`**, the merge of **#739**. *(This line read `11f2e9be121c6d02a9b1d29ee781b26bfb9c4b6b`, the merge of **#736**, when it was re-derived on 2026-09-19 — one day earlier. Each attribution belongs to its own SHA and neither is transferable to the other.)* Re-read the branch rather than quoting any SHA from this row. THE DATED OBSERVATION: **VERIFIED_REPO:** protected `claude/build-hone-saas-hOex7` at `a946a983ac9b8da379bc869e21b32a5a3d50e548`, merge of #712 (WAIT-04A). Its two parents are `77d092b5…` (the #713 merge) and `f690825b…` (the #712 head), each confirmed as an ancestor. | A repository SHA alone is not serving proof; the deployment row binds the live aliases separately. [S42] |
| Serving deployment | ⚠️ **SUPERSEDED OBSERVATION, PRESERVED AS DATED HISTORY (noted 2026-09-19).** The deployment below served the 17 September head and no longer serves production. **NO REPLACEMENT PROVIDER READING IS ASSERTED HERE:** the current deployment's `meta.githubCommitSha` was **not** read, so no new VERIFIED_PROVIDER claim is made — manufacturing one from a Ready-status listing is exactly the evidence inflation this table exists to prevent. Re-verify by hostname at the next release boundary. THE DATED OBSERVATION: **VERIFIED_PROVIDER:** Vercel deployment `dpl_H1ZcHgPARRR8csuN9yRscgiqY7fZ` READY, target production, `meta.githubCommitSha` = `a946a983…` — exact 40-character equality with the production head. Aliases `hone.care` and `www.hone.care` resolve to it. Resolved **by hostname**, so the answer is the deployment the domain actually serves. | Revalidate the deployment SHA at the next release boundary. No claim of authenticated browser acceptance beyond the recorded canary. [S42] |
| Hosted DB / migration ownership | ⚠️ **CORRECTED 2026-09-19 — THIS ROW CONTRADICTED ITS OWN CITED AUTHORITY.** It cited `docs/production/migration-state.json` for a hosted max of `0198`, and stated that the following number was neither allocated nor applied. `0199` **WAS** applied, on **2026-09-18**, from the reviewed #716 head. **VERIFIED_REPO:** ⚠️ **UPDATED 2026-09-20, THEN AGAIN THROUGH `0201`:** hosted max is now **`0201`** per `docs/production/migration-state.json`, repository max is **`0201`** by census of `supabase/migrations/*.sql` (repo and hosted at PARITY), and apply records for 0197, 0198, 0199, 0200 and 0201 are in `docs/production/migration-ledger.md`. `0201` is the WAIT-P1-EXIT forward authority contraction (#747) and is **applied and frozen** alongside `0200`. | 🛑 **DO NOT CLAIM `0199`, `0200` OR `0201` — ALL THREE ARE APPLIED AND FROZEN.** ⚠️ **UPDATED 2026-09-20:** **the next free number is NOT stated here** — it was stated as `0200`, and `0200` was then allocated and applied; derive it with `npm run migration:state`; a number is claimable only by that fresh derivation plus a new single-allocator decision. Parity holds: nothing sits above the hosted max and nothing is pending. Hosted state is declared in `migration-state.json`, never derived from filenames. [S42] |
| WAIT-03 runtime | #708 core is MERGED / DEPLOYED, repaired by #709 (0197) and completed by #713 (0198). WAIT-04A shipped in #712 with no migration. The test studio is enabled for legacy gate + durable WAIT. | Production-exercised end to end on the **test studio only**. A twelve-seam controlled pass is not Willow acceptance and not Chloe device acceptance. [S42] |
| Controlled canary | **CANARY_PASS — 12 of 12 seams** on the post-0198 head: Waiting, capacity opened, capacity re-read after reload, invite, translated practitioner outcome, delivery result, recipient proof, scoped eligible slots only, booking, atomic waitlist conversion, reload truth, and fail-closed refusal on exhausted capacity. **POST_CANARY_CLEANUP = COMPLETE**; no residual open canary state. The converted entry, redeemed invitation and resulting appointment were deliberately left in place — the database records that the canary happened. | The canary ran on the controlled test studio with a synthetic identity. It is evidence of the journey working, not of customer acceptance, and it involved no provider send. [S42] |
| WAIT-04A / #712 | **VERIFIED_REPO:** merged 2026-09-17T00:39:19Z with `--match-head-commit`; nine files, **no schema change**. It wired three SECURITY DEFINER commands that migration 0193 had already applied to production with zero callers. | A prebuild census found **nine** applied-but-uncalled commands, all belonging to S1–S5; #712 closed three. The rest stay dormant until their seam is built — an applied command with no caller is not a shipped capability. [S42] |
| Willow continuity | ⚠️ **CORRECTED 2026-09-19 — THIS ROW STATED THE OPPOSITE OF PRODUCTION.** It said Willow's durable WAIT was deliberately switched off. Willow has been on the **durable** commit point since on or before **2026-08-25**; 28 durable rows were measured 2026-09-19. **A cutover planned from this row would have re-performed one that already happened.** Willow's existing waitlist is preserved. Chloe observed that the Waitlist navigation can disappear when the durable flag is off, despite the list/data still existing. | ⚠️ **THESE WERE PRE-CUTOVER INSTRUCTIONS AND ARE RETIRED (2026-09-19).** They directed an operator to restore truthful discoverability ahead of a Willow cutover, and warned against resolving the navigation defect by quietly switching Willow's durable path on. **Willow was already durably enabled on or before 2026-08-25**, so neither is actionable — and an operator following the second could try to manipulate an activation that has already happened. **WHAT ACTUALLY REMAINS:** the navigation/discoverability defect itself is still owed; the 2026-08-19→08-25 email-only window still needs an import decision; and the activation still has no governance record. [S37] |
| Receipts | **VERIFIED_REPO:** #702 merged automatic successful-card receipt + existing Hone email + studio-branded PDF attachment. Manual receipt remains recovery; webhook/cash/e-transfer follow-ons remain separate. | Observe production behavior; receipt follow-ons do not take the WAIT migration/release slot. [S40] |
| Provider / SMS | No new provider activation, real SMS send, STOP exercise or Willow sender cutover is established by v1.15. The 0194 schema landed inside the WAIT assembly, but #674 runtime routing/cutover remains a separate provider gate. | WAIT-04 dual-channel work must revalidate real sender, consent/STOP and delivery truth before any approved handset canary. |
| Commercial / broader Trust | Standing Gate A–E and known Trust obligations remain. | No new independent paid-studio census, restore/offboarding closure or whole-project P0/P1-zero claim is made. |

**Historical-detail rule:** §3.1–§3.7 below explain how v1.14 reached its earlier checkpoint. Their old “current”, migration and draft-state wording is evidence history only; the table above is the v1.15 operational snapshot.

<a id="hone_s_3_1"></a>
## 3.1 Historical v1.14 capture — what had merged since the v1.10 evidence cutoff

| **PR / merge time UTC** | **Verified repository result** | **What remains separate** |
| --- | --- | --- |
| #676 · 6 Sep 23:28:10 | 4997f9a7 · existing studio-owned SMS-sender adoption engine, read-then-refuse. [S28] | Engine only; no operator caller, no evidence of live adoption/activation from the merge. |
| #667 · 7 Sep 00:43:47 | 5b6414c6 · thirteen Client Profile controls adopt Hone touch/focus primitives. [S21] | Real practitioner-device/assistive-technology acceptance remains distinct. |
| #678 · 7 Sep 20:55:21 | 15c3b997 · WAIT-EXPOSE-01: lifecycle callers and paginated queue reachability. B4 prototype split to #683. [S21] | It did not send invitations, prove recipients or complete bookings. Its Claim UI was subsequently rejected by Chloe. |
| #684 · 7 Sep 22:10:23 | cc576f71 · hide internal Claim/Claim next controls; truthful action vocabulary. [S21] | Rendering change only. Commands remain; the new Invite-to-book product still needs the draft stack and binding. |

<a id="hone_s_3_2"></a>
## 3.2 Historical v1.14 WAIT component register — one captured revision per row

| **Unit / captured head** | **Construction / dependency** | **CI captured; release evidence still missing** |
| --- | --- | --- |
| #681 · 7c7f6c5b | 0192 numbered recipient-proof and scoped-offer authority; production-branch target. [S22] | Accepted parent reported in session. CI/review not independently reacquired in this amendment; no apply or merge. |
| #682 · 9b2d243b | B2 wrappers + requested-slot scope + canonical booking seam; stacked on #681. [S23] | Prior acceptance reported. Exact final integration/ancestry and numbered-chain proof remain required. |
| #680 · f978bd81 | Email invitation / proof transport and recovery; production-branch target; no SMS or schema. [S26] | CI #1856 / 34177177645 SUCCESS. Current completed independent review not established here. Delivery is not yet wired to the user flow. |
| #683 · 962dcb46 | B4 Invite-to-book row/composer and typed adapter contract; still dormant / no adapter. [S24] | CI #1855 / 34176668090 SUCCESS. Current independent disposition and live binding remain gates. |
| #685 · 04990b5d | 0193 atomic admission plus preferences/manual/legacy/provenance; stacked on #681. [S25] | CI #1857 / 34177180308 SUCCESS. Later head than the ce33a30e review discussed earlier; do not carry its finding count as current. |
| #686 · f31146ae | B3 recipient route and canonical Book/Decline integration; stacked on #682. [S26] | CI #1858 / 34177392848 IN PROGRESS at capture. Author-produced delta checks are not independent acceptance. Proof delivery remains unwired in the recorded PR contract. |

CI observations are the pull-request-triggered runs returned for the exact SHAs above. They do not prove full-history documentation checks executed, a clean Codex outcome, hosted migration application, serving deployment or user acceptance. Later state must be re-read rather than appended as a second current checkpoint.

<a id="hone_s_3_3"></a>
## 3.3 Historical v1.14 immutable revision ledger

Production: cc576f71287a09943e47f4351d96dfa3a0d04dee

PR #681: 7c7f6c5b73a10c7bef03c628124b11c6e5a10b57

PR #682: 9b2d243bfaf793a07a11ee002bb268ed1a8f1d66

PR #685: 04990b5dbda0f730e19df94a2bf8c8b829f21445

PR #680: f978bd81fbf62e8975d5bd1894f032b35cba0146

PR #683: 962dcb46c6805a2fc3555abdedb24e7d9da76279

PR #686: f31146ae20770a4f6c7ef04c50963609088264a2

SMS #674 source checked: 77a92fc0f71db212b8fa4dc06a90bd34508387e6

<a id="hone_s_3_4"></a>
## 3.4 Corrections and conflicts that must not be silently carried forward

| **Earlier statement / ambiguity** | **Evidence-based disposition** |
| --- | --- |
| #674 and #681 both own a migration named 0192 | CORRECTED: #674 changed-file census and pinned source contain 0194_studio_sms_sender_outbound_lookup.sql. Its body and production ledger retain old 0192 wording. This is a documentation discrepancy, not a verified duplicate SQL filename. Global local-worktree allocation is still unknown. [S27] |
| Claimed → Release means back on the waitlist | CORRECTED: current production action label is Set aside; release lands in released. Requeue is the distinct Return to waitlist command. #684 PR-body descriptions are older than this source detail. [S21] |
| #682 cannot return a challenge id | CORRECTED: pinned B2 BeginProofOutcome includes proofChallengeId, rawChallenge, expiresAt, deliveryContact and maskedContact. Older PR-body coordination notes are stale. Challenge id stays server-side; it is not a code-derived hash. [S23] |
| All invitation booking is atomic; a lost slot never consumes an invitation | NOT THE BUILT B2 GUARANTEE: B2 intentionally consumes before appointment creation to prevent duplicate bookings. Creation failure after consume is a known terminal recovery case requiring truthful copy and operator booking. Do not claim all-or-nothing appointment+consume atomicity. [S23, S26] |
| A clean author delta or large passing suite equals final independent acceptance | INCORRECT: the session explicitly recorded same-author review conflicts and changing heads. Keep authored test evidence, completed independent exact-head review and integration evidence separate. [S19] |
| A green CI badge proves all documentation debt is closed | INCORRECT: inherited canonical-production-facts A3/A5/PR-state failures were reported to skip under shallow history. They remain an evidence limitation until the matching checks actually execute and pass. [S21, S24, S26] |
| WAIT-04 instructions mean implementation has started/completed | NOT ESTABLISHED: Sam authorized the build, and pane prompts were issued. The bounded PR search in this capture found the nine Sept 7-created PRs through #686, not a WAIT-04 completion record. Local progress remains unknown. [S19, S30] |
| A supervised pilot is a whole-product safety certification | QUALIFIED: Gate A supports supervised operation with explicit trust/operational limits. Neither this document nor the carried capture establishes whole-project safety, current P0/P1 zero or repeatable commercial readiness. [§§3.6, 10] |
| The document proves zero independent paying studios | NOT ESTABLISHED: no current commercial census is supplied. Report independent paid proof as not established, and do not count Willow. A missing measurement is not a verified zero. [§§10.2, 18, 20] |
| About three weeks of waitlist growth proves three weeks building one fixed specification | UNSUPPORTED INFERENCE: the quoted period describes accumulating demand. Track engineering lead time from the recorded agreed-scope date through acceptance, retaining scope changes explicitly. [§17.5; S33] |
| Component progress supports an 85–90% completion estimate or “hours, not days” delivery promise | WITHDRAWN AS PLANNING EVIDENCE: no measured integrated delivery plan supported those chat estimates. Record tested exits, remaining blockers and evidence-supported internal targets instead. [S33] |

<a id="hone_s_3_5"></a>
## 3.5 Work preserved outside the immediate WAIT release

| **Work** | **Disposition** |
| --- | --- |
| FIN-02A / FIN-02B local candidates | OPERATOR_REPORTED: candidate head ef191600 was handed for review; FIN02_RESUME.md, FIN02A_CANDIDATE.md, FIN02B_CANDIDATE.md and FIN02_INDEPENDENT_REVIEW.md were named under /home/sam/hone-handoffs. These files were not supplied/read for this update. No new migration number or deployed Financials arithmetic is inferred. [S19, S29] |
| #666 financial prototype | Fresh metadata: open, unmerged, non-mergeable. Preserve reusable model/UI/tests only under the #672 shared-snapshot contract. Do not merge the old multi-read architecture. [S29] |
| #668 source-authority contract | Open/unmerged at e436e09f; documentation candidate, not shipped authority/automation. Do not use its PR body to override the roadmap’s fact-domain or release rules. [S29] |
| #677 existing-sender configuration | Open/unmerged at ba27a1bf; separate inspect/configure engine, no product caller or provider activation established. [S28] |
| #679 earlier B3 prototype | Presentation provenance reused by #686; it is not an additional release dependency or permission to import its old B2 copy. [S26] |
| HIST / OPS / storage / ACL / UI breadth | Preserve existing named programs, findings and handoffs. No new closure, scope reset, authority re-entry or general implementation authorization is supplied by the WAIT work. [S18] |

<a id="hone_s_3_6"></a>
## 3.6 Evidence deliberately not established

v1.15 establishes only the fresh GitHub/source facts and operator-recorded hosted/deployment/canary facts named in the §3 current table. It still establishes no fresh provider/sender/STOP exercise, all-PR/finding census, commercial census, legal determination, restore/offboarding acceptance or WAIT-04 completion. The source’s known omissions remain routing obligations, not inferred absences. See §20. [S37–S40]

<a id="hone_s_3_7"></a>
## 3.7 Developer-tooling canary — recorded 9–10 September 2026

**Evidence class: OPERATOR_REPORTED.** Sam supplied terminal screenshots from 9 September local time / 10 September UTC. These are observations of the named development canary, not a fresh host inspection by this publication. They supplement, and do not re-date, the production-source and hosted checkpoint in §§3–3.6. The latest successful runtime/MCP probe shown was approximately 02:41 UTC on 10 September. [S35]

| **Surface** | **Recorded result** | **Limit / remaining evidence** |
| --- | --- | --- |
| Canary identity | Host `hone-dev-01`; Herdr session `hone-smoke`; worktree `/srv/hone/worktrees/herdr-smoke`. | Do not confuse the session name with the worktree name or infer other lanes' state. |
| Installed tooling | Context Mode 1.0.169, local plugin scope; Claude Code 2.1.267; Herdr 0.9.0. | Recorded versions, not latest-version advice or a fleet-wide installation census. |
| Context Mode health | Plugin, hook scripts, storage, server self-test and SQLite/FTS5 checks passed. | Doctor also ran through a CLI fallback while MCP was unavailable; installation health alone is not a connected tool. |
| Large-output analysis | The canary reported a repository census through `ctx_execute` without returning the bulk file/migration listing into the conversation. | Useful functional evidence, not a controlled context-savings benchmark. The canary's file counts are not current repository or hosted counts. |
| Compaction continuity | After `/compact`, the agent recovered the recorded CANARY_DECISION and CANARY_TASK; the transcript also records a durable memory write/restoration. | Demonstrates continuity in this setup, not a controlled attribution of recall to the plugin alone. Memory remains non-authoritative. |
| Runtime split | Actual `ctx_execute` reported Node v22.23.2. Native Bash resolved `/home/sam/.local/bin/node` to v20.20.2; npm reported 10.8.2. | This is one tested invocation path. Hooks, upgrades, child processes and other worktrees need the rollout checks in §16.7. |
| MCP recovery | Initial connection failed in the fresh session; `/mcp` reconnect succeeded and a real `ctx_execute` call then ran. | **WARN: automatic-start reliability remains open.** Manual recovery does not establish dependable unattended startup. |
| Herdr supervision | Unit enabled; `Linger=yes`; manual-to-systemd cutover and a deliberate main-process failure recovered with a new PID/restart count. Native `claude --resume` invocations were observed. | A real host reboot/boot-with-linger test remains pending. Arbitrary shell/test processes are not proven resumable or exactly-once. |
| Orchestration and worktree | Master/builder/reviewer smoke was reported complete. The shown repository probes reported a clean tracked tree and no commit/push. | User-local tooling/settings and a memory record did change. Permission-denied key injection and an already-idle wait result were explicitly reported; neither is proof of new task completion. |

**Recorded adoption decision:** Context Mode is accepted as a useful developer-platform component on the strength of the canary; Herdr's canary substantially passed. Routine rollout is still pending under §16.7. Preserve the MCP warning, user-wide dispatcher footprint and unfinished reboot test instead of converting CANARY PASSED into ROLLED OUT or DONE. No production merge, migration apply, provider action or new customer acceptance is established by these tooling tests. [S35]

<a id="hone_s_4"></a>
# 4. Standing Product and Engineering Laws

| **Law** | **Binding rule** |
| --- | --- |
| Suggested != Available | A valid practitioner-selected in-hours time must book normally even if Smart Scheduling did not suggest it. |
| Searchability | Anything a practitioner is authorized to see, configure or act on should be discoverable through Global Search. Search never creates permission. |
| $0 is a price fact | Authoritative amount 0 means no payment required. Missing/ambiguous pricing is not free and fails closed. |
| Dashboard = calm briefing | Dashboard answers Today, To do, Birthdays and very little else. To-do is the complete working queue. |
| Completed visit must resolve | Chart complete? Outcome resolved? Payment resolved? Next visit resolved? If no, it returns to To-do. |
| Server owns authority | Browser choices are inputs; server/database re-derive authoritative facts at execution. |
| UNKNOWN is first-class | Could not read / not loaded / unavailable is never collapsed into false, none, empty or closed. |
| Acknowledgements are scoped | Acknowledge exact reason/resource/interval/version. Re-evaluate server truth before execution. |
| Value equality is not a version | Values can repeat, revert or normalize. Concurrency needs explicit currentness/version semantics. |
| Write success != refresh success | A successful write remains successful even when subsequent refresh fails. |
| Database normalization wins | Do not approximate DB normalization such as PostgreSQL btrim with client-side trim. |
| One migration owner | Many dev branches may run; only one production migration/release train owns the next migration number. |
| No giant PRs | Large capabilities are decomposed into contract/schema/runtime/UI/memory/acceptance PRs. |
| Green CI is necessary, not sufficient | Exact-head independent review, migration gate, ancestry and production smoke are separate release evidence. |
| Failed branches preserve learning, not architecture | Reuse tests, scenarios, product contract and authority discoveries; rebuild code from current production. |
| Open slot != Safe admission | A consultation fitting on the calendar does not prove the practice can serve the recurring treatment workload it creates. Admission control is a distinct domain from slot legality. |
| Calendar white space != Future capacity | Unbooked future hours are not automatically spare: active clients with no future booking and immature cadence can create latent recurring demand. UNKNOWN demand is never treated as zero. |
| Waitlist invite != Appointment | Invitation grants a temporary opportunity to choose a legal consultation slot. It never creates or reserves an appointment by itself. |
| Provider acceptance != Inbox delivery | A successful provider API response means the provider accepted the send request. It does not prove inbox delivery, non-spam placement or human visibility. |
| Admission release is bounded | When capacity permits N new clients, release exactly N invitations. Never reopen unrestricted new-client booking from a single utilization threshold. |
| Existing-client continuity | New-client admission controls must not silently reduce an existing client's normal booking, rebooking or reschedule capability unless a separate explicit policy authorizes it. |
| Waitlist visibility != rollout state | Legacy/durable rollout flags may choose implementation paths, but they must not make an existing studio’s waiting people appear deleted or undiscoverable. During migration, the owner must retain a truthful route to the authoritative current list/history; hiding navigation is not a safe migration strategy. |
| Positive fact != Proven completeness | A fact that was actually read may render from partial history; negative/absence claims require a complete authoritative window. Truncation weakens absence claims, not positive evidence. |
| Clean review != Cleared findings | A later clean review does not erase earlier P0-P2 threads. Every finding remains OPEN until repaired and mechanically VERIFIED at a specific head, or explicitly accepted by human authority. |
| Test the protected behavior | A test for a loader, parser or guard does not prove the user-visible safety claim. Load-bearing evidence must exercise the final behavior or the actual failure class the guard exists to prevent. |
| Collection absence != Domain absence | Missing rows from a bounded, capped, sliced, filtered or failed child collection cannot authorize practitioner-visible "not recorded", "none", "new client" or equivalent absence prose. Positive observed facts and authoritative scalar-null facts are different evidence classes. |
| Review acknowledgement != Review completion | A comment, reaction or stale/re-anchored review object is not a completed exact-head review. Release authority requires the current-SHA outcome plus an individual audit of every prior P0-P2 thread. |
| Perceived speed != Fabricated progress | Acknowledge taps and pending work immediately and locally, but do not optimistically mutate clinical, payment or booking truth unless the operation is explicitly safe, reversible and reconciled on failure. |
| Reference != Dependency | External UI/reference sources may inform design. They do not authorize a runtime package, Client Component boundary, data serialization expansion or new product authority. |
| Structural optimization != Measured speed | Reducing awaits, rows or waves is an implementation-shape result. A performance claim requires comparable before/after timing evidence; a production improvement claim requires production evidence when environment/region/runtime materially differ. |
| Latest/Last != Highest row seen | Clinical recency is an exact authority question: cutoff, exclusions, clinical predicate and deterministic total order must be owned by the query/authority. A capped or partial window cannot prove none or latest merely because no better row was observed. |
| Absence requires EMPTY_PROVEN | For clinically or operationally authoritative questions, COMPLETE(value), PARTIAL(value, reason, bound), EMPTY_PROVEN(scope, completed_at) and UNAVAILABLE(reason, retryable) are distinct. Only EMPTY_PROVEN may authorize definitive "none" / "no history" / equivalent absence prose. |
| Operational proof != repository proof | Scheduler ownership, provider delivery, alerts, restore readiness and hosted storage policy cannot be closed by CI alone. Hosted evidence, drills and named human ownership are part of DONE. |
| Provider-verified money != studio-attested money | Card collections verified by Hone/Stripe and practitioner-attested cash/e-transfer/other settlement are different evidence classes. Financials may aggregate them only with explicit labels and no double counting; waived and still-owed are not collected money. |
| Latency is product quality | Practitioner actions should acknowledge immediately, but real request time is a first-class product concern. Measure and reduce server/network critical paths; do not use motion, skeletons or optimistic clinical/payment/booking state to hide latency. Performance targets are planning goals until comparable evidence proves them. |
| Practitioner intent, not state-machine vocabulary | Use Invite to book and truthful consequences. Hide Claim/Claim next; internal RPC/status names may remain unchanged. Never label release as return to waiting unless the atomic command actually does both. |
| Three clocks, three meanings | Invitation response deadline, proof-challenge expiry and verified-mutation capability expiry are separate authorities. A 48-hour invitation policy does not change the proof or capability TTL. |
| Consultation access is not treatment eligibility | Creating a client or booking a first consultation does not automatically authorize unrestricted ongoing treatment bookings. |
| Restriction is clinic-scoped and explicit | Only a confirmed consultation no-call/no-show triggers the accepted permanent self-service restriction. Owner manual exception does not automatically lift it; record correction is separately audited. |
| Contact data is not consent | A required mobile number is not SMS consent. SMS STOP/suppression, leaving the waitlist and other communication permissions remain distinct. |
| Wait estimate is not a promise | Forecast time to invitation separately from treatment access/demand. No exact queue number, date or confidence claim from uncalibrated sparse history. |

<a id="hone_s_5"></a>
# 5. Portfolio Operating Model and Capacity Allocation

<a id="hone_s_5_1"></a>
## 5.1 Permanent lanes

| **Lane** | **Default capacity** | **Mandate** |
| --- | --- | --- |
| Trust / Security / Reliability | 30% until known P1=0; then 15-20% | Close confirmed trust blockers; auth/RLS, privacy, payment authority, DR, production parity, provider operations, release integrity. |
| Planned Product | 55% | 35% practitioner/moat + 20% SaaS/activation. Product continues while ordinary P1 work runs. |
| Interrupt reserve | 15% protected | Live emergency, live Chloe P1 regression, or small high-friction quick win. Unused reserve flows to Product, not another audit. |

<a id="hone_s_5_2"></a>
## 5.2 Current stabilization and interrupt allocation

| **Period** | **Trust** | **Product** | **Interrupt** |
| --- | --- | --- | --- |
| Known-P1 burn-down baseline | 30% | 55% | 15% |
| During qualifying C1 emergency | Minimum required Trust work continues | Planned Product pauses only as needed | Interrupt may temporarily exceed 15%; sole production-moving candidate |
| After known P1=0 | 15-20% | 65-70% | 15% |

Current allocation: WAIT remains the sole major Product priority. The #709/0197 → apply → deploy → canary lane is **complete**; the primary lane is now the WAIT-04 seam sequence (S1–S5), beginning with its zero-migration units. A bounded WAIT continuity/owner-control lane, one Trust guard-hardening lane and ONBOARD-04/Laura synthetic readiness may prepare in parallel if they do not move production or contend with the WAIT database/release train. #699/#704 charting stays groundwork-only/frozen for production until a new migration owner is named — ⚠️ **CORRECTED TWICE, AND NOW NAMES NO NUMBER AT ALL** *(2026-09-19 it named the preceding number as still unclaimed; 2026-09-20 it named `0200`, which WAIT-P1-EXIT had by then allocated and applied)*. **`0200` IS APPLIED AND FROZEN.** Derive the free number with `npm run migration:state` and read the hosted head from `docs/production/migration-state.json`; this paragraph is not an allocation authority. **`0199` IS APPLIED AND FROZEN** — it was applied 2026-09-18 and must never be claimed. FIN preparation remains isolated. [§23.8; S42]

<a id="hone_s_5_3"></a>
## 5.3 WIP limits

One active Trust implementation PR.

One active major Product implementation PR.

One Product discovery/specification item.

Zero Interrupt PRs unless triggered by a qualifying event.

One production migration owner and one production-moving release candidate.

Normally no more than two active non-draft code PRs; three is the hard portfolio ceiling.

A qualifying C1 may temporarily exceed the normal Interrupt reserve, but it does not permanently reshuffle the roadmap. While active, the C1 becomes the sole production-moving candidate; sibling code PRs may continue only if they cannot disturb the release path.

Parked, stale and failed/reference PRs are not silently counted as active delivery. Their disposition is explicit; opening status in GitHub is not evidence of active authorization. Use §3 for the selected current register and §23 for assigned WIP.

Current assigned WIP is a time-limited WAIT release program: one WAIT-04 seam lane, which owns no migration *(⚠️ corrected 2026-09-20: this row has now named a stale "unallocated number" TWICE — first the preceding one, which was already applied and frozen, then `0200`, which WAIT-P1-EXIT allocated and applied on 2026-09-20. It no longer names one at all; derive it with `npm run migration:state`)*; one bounded WAIT continuity/owner-control lane; one Trust implementation; and at most one Product discovery/spec lane. Laura readiness is synthetic/local preparation, not a second production mover. #699/#704 remains inert until a new migration owner is named. More panes are not more production movers or a waiver of shared-resource rules or §7 stop thresholds. [S37–S39]

<a id="hone_s_6"></a>
# 6. Priority, Severity, Risk and Work Classification

<a id="hone_s_6_1"></a>
## 6.1 Severity is not priority

| **KEY PM RULE  P0-P3 describe defect severity. Product priority describes strategic value. Risk tier T0-T4 describes how much autonomous authority is allowed. These three axes must not be conflated.** |
| --- |

| **Axis** | **Values** | **Meaning** |
| --- | --- | --- |
| Severity | P0 / P1 / P2 / P3 | Impact if the finding is real. |
| Roadmap priority | Now / Next / Later / Not Now | When the work should consume capacity. |
| Risk tier | T0 / T1 / T2 / T3 / T4 | Required evidence, repair limits and human release boundary. |
| State | IDEA -> DONE lifecycle | Where the item is in delivery, independent of severity. |

<a id="hone_s_6_2"></a>
## 6.2 Risk tiers and automation authority

| **Tier** | **Examples** | **Automation / release rule** |
| --- | --- | --- |
| T0 | Docs, copy, tests, pure roadmap artifacts | Fully autonomous; max 2 bounded repairs; human review optional unless governance artifact. |
| T1 | Non-authoritative UI and presentation | Autonomous implementation; potential low-risk auto-merge later. |
| T2 | Server/product/booking logic | Authority map mandatory; max 1 autonomous repair; next fresh P1/P2 family -> architecture review. |
| T3 | Migrations, RLS, auth, clinical write authority | One bounded repair; human production release authorization required. |
| T4a | Controlled production enablement of a default-OFF studio/provider capability | Implementation may be T1-T3, but activation requires explicit human gate, production smoke, observable kill switch and rollback. |
| T4 | Payments, destructive production data, provider enablement | Explicit human authorization at every production-affecting boundary; default-off when possible. |

<a id="hone_s_6_3"></a>
## 6.3 Work-lane decision rules

| **Question** | **If yes** | **Lane** |
| --- | --- | --- |
| Does the primary outcome close auth, tenancy, money, privacy, data integrity, DR, production parity or operational proof? | Yes | Trust |
| Does it primarily solve a practitioner/studio workflow or moat problem? | Yes | Planned Product |
| Is it onboarding, provider lifecycle, studio lifecycle, multi-practitioner or self-service activation? | Yes | SaaS/Activation within Product |
| Is production broken/unsafe now? | Yes | Interrupt C1/C2 |
| Is it a small, clear, migration-free Chloe friction item under the quick-win threshold? | Yes | Interrupt C3 Quick Win |
| Is it ordinary feedback that belongs to an upcoming epic? | Yes | PRODUCT INPUT, attach to parent; do not spawn ad hoc PR |

<a id="hone_s_6_4"></a>
## 6.4 Quick-win eligibility

One clear user problem.

No migration.

No new authority boundary.

Approximately <=3 runtime files and <=300 net implementation LOC.

Independently releasable.

Can be proved without redesigning a subsystem.

<a id="hone_s_7"></a>
# 7. PR Lifecycle, Scope Budgets, Review and Stop Laws

<a id="hone_s_7_1"></a>
## 7.1 Canonical ticket lifecycle

IDEA -> PRODUCT_CONTRACT -> RECON -> AUTHORITY_MAP -> SCOPE_ESTIMATE -> READY -> IMPLEMENTING -> FOCUSED_PROOF -> PR_OPEN -> CI + CODEX -> CLEAN | REPAIR_1 | ARCHITECTURE_REVIEW -> RELEASE_READY -> PRODUCTION_LOCK -> MERGE/APPLY -> SMOKE -> DONE

<a id="hone_s_7_2"></a>
## 7.2 Every T1+ PR must state

Work item ID and parent milestone.

Original user problem / source quote when applicable.

Immutable product contract.

Authority map.

Risk tier.

Dependencies.

Expected file/LOC scope budget and hard-review threshold.

Acceptance criteria, including machine vs human evidence.

Anti-vacuity mutation plan for load-bearing invariants.

Explicit non-goals.

Migration and production-release posture.

Stop law.

Delivery result and discovery value at closure.

<a id="hone_s_7_3"></a>
## 7.3 Scope bands

| **Band** | **Expected size** | **Rule** |
| --- | --- | --- |
| S | <=3 runtime files, ~<=300 net implementation LOC | Default for quick wins and narrowly bounded repairs. |
| M | 4-8 runtime files, ~<=1,000 net LOC | Normal feature/Trust PR. |
| L | Larger than M | Must be split unless atomicity truly requires it and a human reauthorizes. |
| Hard review | >8 runtime files, >1,500 implementation LOC or >3x estimate | STOP for scope-expansion/architecture review. |

<a id="hone_s_7_4"></a>
## 7.4 Convergence and stop law

Trigger architecture review when 3 consecutive P0-P2 repair rounds occur.

Trigger architecture review when 2+ fresh findings share one root-cause family.

Stop when a repair repeatedly creates adjacent defects.

Stop when duplicated authoritative workflow exists across multiple surfaces and the patch is compensating per-surface.

Stop when scope grows >~3x or crosses the hard file/LOC budget.

T0/T1 max 2 repairs; T2 max 1 autonomous repair; T3 one bounded repair then human; T4 human at each production boundary.

No REPAIR_7. Close failed delivery vehicle, preserve evidence, and rebuild from current production.

AUTHORITY COMPONENT RULE: a component whose output downstream work must trust as complete, valid, durable or release-authoritative may not be self-certified by the same builder through a hand-enumerated completeness claim. Independent adversarial falsification is part of the proof, not an optional review after the fact.

AUTHORITY RE-ENTRY RULE: after repeated same-family authority failures, scope reduction alone is not a reset. Re-entry requires a different verification process with mechanically derived completeness, independent falsification by construction and fault injection at durable/authority boundaries.

<a id="hone_s_7_5"></a>
## 7.5 Review monitoring

CI green never clears a review finding.

Codex monitoring must inspect issue comments, submitted reviews and inline review threads.

Finding freshness is based on original reviewed commit / original_commit_id, not where GitHub visually re-anchors the thread.

Review silence is not approval; READY-BUT-UNREVIEWED = HOLD.

After review begins: no amend, rebase or force-push. Normal merge commits only.

Finding disposition remains monotonic as a HUMAN governance discipline: OPEN -> REPAIRED@sha -> VERIFIED@sha, or ACCEPTED_RISK by explicit human decision. No shipped software ledger currently owns this state; CP-005b V1 retired unmerged. A later clean review never implicitly closes an older finding.

Never batch-resolve review threads by assumption. Read each thread, verify the current head against the finding, reply with evidence, then resolve that thread only.

When two fresh findings share the same representational root cause (for example UNKNOWN collapsed into absence, or text parsing used as security authority), stop patching the instances and repair the model/verification method or retire the delivery vehicle.

Where an evidence checker can be fooled by source-text shape, prefer syntax-aware parsing or direct behavioral proof. A checker that proves itself rather than the protected failure class is not release authority.

<a id="hone_s_7_6"></a>
## 7.6 Emergency interrupt release profile

Use the smallest reversible design that closes the live harm. Default-OFF flags, server-owned authority and narrow rollback are preferred over schema changes during the containment window.

Focused proof comes first. Local exhaustive suites are not mandatory when they duplicate isolated CI and do not materially test the changed boundary; production build, targeted behavioral proof and one broad CI backstop remain required.

Review is bounded by risk tier. For a T2 emergency, one fresh exact-head changed-diff review is enough when clean; one repair round is allowed for a confirmed introduced/worsened P0/P1/P2, then one final review. No review round 3.

Dark deploy and feature activation are separate release boundaries. Stage A may ship code with behavior OFF; Stage B enabling real clients requires the stronger human-visible acceptance gates.

Operational shortcuts must carry an explicit sunset. Email may temporarily serve as the WAIT-01 operational record, but the durable waitlist must move to studio-scoped state before assisted or automatic release.

<a id="hone_s_7_7"></a>
## 7.7 Convergence in practice — deliver the protected workflow

The September session recorded unknown-state collapse, adjacent recovery defects, lock-order inversions, incomplete source guards, stale review attribution and CI churn. These are regression families, not permission for an unlimited repair loop. Apply §7.4 when its thresholds are met; a new prompt, renamed task or larger test count does not reset the stop condition. [S19, S24–S26, S33]

At a repeated root-cause failure, decide explicitly whether to repair the representation, simplify the proof to the actual protected behavior, or retire the delivery approach under the existing re-entry rules. Do not keep expanding proof machinery merely to satisfy the next syntax example. This does not waive real booking, authorization, consent, data-loss or concurrency defects, nor make all evidence defects cosmetic.

Finish a bounded change batch, push once and hold the candidate stable for CI and independent review. Avoid cosmetic pushes during acceptance. A moved head still invalidates whole-head release acceptance; file-scoped historical evidence survives only with explicit equivalence proof. One watcher per revision; missing review is not zero findings. [§7.5]

Name the integration owner and prepare the overlap plan, isolated fixtures and next demonstration while components converge, within existing authorization. Final assembly, integrated proof and production retain §23 gates. Describe progress by completed user-workflow exits—not by PR count, passing-test volume or unsourced percentages.

Keep authorship and acceptance separate. A builder’s adversarial self-test is useful evidence, not independent certification. Apply the role-based handoff in §23.2 and preserve exact revisions, environments, unresolved findings and next actions. No new broad audit or control-plane project is authorized. [S33]

<a id="hone_s_8"></a>
# 8. Release, Migration and Production Discipline

| **PRODUCTION CONCURRENCY = ONE  Development may run in parallel. Production movement is serialized. A migration-owning branch owns the next migration number until apply, verification and reconciliation are complete.** |
| --- |

| **Stage** | **Required proof** |
| --- | --- |
| Preflight | Production SHA unchanged; authorized PR head unchanged; exact migration bytes/checksum; migration list; dry-run only expected migration. |
| Apply | Human authorization when T3/T4; capture start/end and actual process exit code; no retry on unknown/failure without diagnosis. |
| Verify | Hosted migration list, schema/privilege behavior, row/data invariants as applicable. |
| Reconcile | Canonical migration-state and ledger updated honestly with evidence limits. |
| Merge | Exact authorized head, ancestry check, normal merge; changed head invalidates authorization. |
| Deploy | Vercel/production ready; live URL/version proof where applicable. |
| Smoke | Focused user workflow and critical negative controls. |
| Close | Remove temporary credentials; record final state; unlock next migration number. |

<a id="hone_s_8_1"></a>
## 8.1 Hetzner release operator direction

Hone development and release orchestration stay on the Hetzner Hone host; Sam's Mac is not part of the normal Hone release workflow.

Do not leave a personal owner-level Supabase PAT permanently available to every worktree.

Long-term target: protected production migration workflow with encrypted credentials, exact-SHA gate, dry-run, human approval for T3/T4, apply, post-apply proof and immutable logs.

Until that exists, use a controlled operator shell with temporary credentials and revoke/remove them after the release.

<a id="hone_s_8_2"></a>
## 8.2 Default-OFF studio activation and kill-switch law

Deploy dark first: production code may ship while a server-only studio flag is OFF, provided flag-OFF behavior is mechanically proven identical to current production for the affected workflow.

Activate one studio at a time. Feature configuration is not browser authority; the server re-derives whether the studio is enabled at execution.

Provider-backed success semantics must be named precisely. API acceptance, delivery, inbox visibility and human action are separate states.

The activation runbook must identify the exact kill switch and whether environment changes require a redeploy. Do not guess provider/runtime semantics.

A human production smoke owns real-client acceptance for T4a enablement; repository CI cannot mark the capability PRODUCTION-EXERCISED by itself.

<a id="hone_s_8_3"></a>
## 8.3 Approval is scoped; no source-of-truth shortcut

Priority NOW is not a defect severity of P0. A roadmap decision authorizes scheduling only. Merge, migration apply, provider purchase/adoption, real-message smoke and cohort activation each retain their own explicit human authorization. An old GO or a suggested terminal prompt does not survive a moved head, changed payload or changed production precondition.

The repair/convergence laws in §7 still apply to documentation and evidence defects as well as runtime defects. This amendment does not retroactively approve past repair rounds, reset counters by renaming a task, or exempt #674 because its remaining work is documentation. A triggered stop requires a recorded bounded re-entry/architecture decision, not another automatic repair cycle.

For the SMS outbound-lookup migration (0194 on #674 at this capture), inspect production duplicate-alert/index preconditions and lock impact before apply. Do not silently delete or resolve existing alerts to make an index pass. Schema staging and routing cutover are separate; Willow must retain service until a verified sender or separately reviewed safe transition exists. [S27]

<a id="hone_s_9"></a>
# 9. Capability Map: Baseline, Current Deltas and Acceptance Debt

| **EVIDENCE SCOPE  The standing capability baseline below is carried from v1.9 unless a source ID marks this update’s specific revalidation. Carried “shipped” means historically reported shipped, not a fresh whole-app deployment/acceptance test. Current operational facts are only in §3. No audit score or old test count is promoted to a current assurance claim.** |
| --- |

<a id="hone_s_9_1"></a>
## 9.1 Established baseline and verified deltas

| **Capability** | **State** |
| --- | --- |
| Tenant isolation and DB integrity | Strong foundation; no systemic cross-tenant bypass proven in Aug 16 audit. |
| Treatment Memory | Strong longitudinal data foundation and still the product wedge. #642 (Client Profile) and #648 (Dashboard Before Today) now fail closed on key clinical read failures instead of fabricating empty/no-history states. The systemic latest/recency/completeness authority is not fully closed: F3/HIST-01 exact ordering/EMPTY_PROVEN semantics remain open/parked. |
| Consultation + Skin/Hair notes | Shipped. |
| Multi-area same-settings charting | Shipped. |
| Repeat Client Fast Start | Shipped; keep Chloe acceptance evidence. |
| Dashboard truth cleanup | Substantially shipped and safer: #598 current-client/card/notes actions, #606 day navigation, #607 bounded selected-day prep and #648 fail-closed Before-Today read truth are production ancestry. Historical latest/recency authority and future full prep parity remain separate; performance waterfall/first-useful-paint is now an active optimization program. |
| Global Search settings/control completeness | V2-A and control completeness shipped. |
| Payments | Server-authoritative card payment foundations remain strong. PAY-SETTLE / #636 + migration 0187 preserve practitioner-attested cash/e-transfer/other/waived/still-owed truth. #702 is now merged: a newly committed successful card charge automatically sends the existing Hone receipt email with a studio-branded Hone PDF attachment; manual Send receipt remains recovery. Webhook-reconciled successes and cash/e-transfer PDF triggers remain separate. [S40] |
| Public booking management link | In-band management path shipped after commit. |
| Sterile-item structured discard lifecycle | Shipped. |
| Authenticated error containment | Shipped. |
| Self-hosted fonts/build determinism | Shipped. |
| Import safety containment | Ordinary owners cannot execute unsafe import; root resumability still open. |
| Reminder scheduler runtime/monitoring | Scheduler/runtime foundations exist, but the Aug 24 corrected audit did not independently prove production ownership, cadence/backlog/provider-delivery evidence, independent stale alerting or a recovery drill. Treat OPS-01 as REVALIDATE/OPEN until hosted proof closes it. |
| Owner Capacity / Business navigation | #638 owner capacity/rebooking worklist, #641 browser coverage and #645 permanent owner Business navigation are merged/deployed. This is truthful owner visibility, not the final admission-capacity formula. |
| Owner Financials foundation | Baseline #646/#650 and merged #652 copy remain. #672 governs the FIN-02 shared-snapshot replacement; #666 remains held. Sept 7 local FIN-02 candidate/review/handoff progress is operator-reported, not deployed earnings implementation. [S29] |
| Export truth registry | TRUTH-01A baseline is retained. #647 / TRUTH-01B-1 is now verified MERGED, with bounded columns/files and explicit remaining omissions. No complete archive, image-binary or Terms-policy closure is inferred. [S15] |

<a id="hone_s_9_2"></a>
## 9.2 Partial / incomplete

| **Capability** | **Missing completion** |
| --- | --- |
| Import | Operator-assisted containment exists; transactional resumability and self-service completion missing. |
| Export | The #647 bounded archive expansion is merged. Treatment-image binaries, complete high-volume enumeration/count authority and Terms §16 remain separate obligations; this update does not establish their closure. [S15] |
| Offboarding | No full resumable purge/provider/retention lifecycle. |
| Multi-studio | Technical tenancy foundation strong; business lifecycle incomplete. |
| Multi-practitioner | Technical foundation exists; commercial/public/practitioner-lane completion and controlled rollout incomplete. |
| Google Calendar | Outbound foundation; per-studio lifecycle and busy import incomplete. |
| Twilio/SMS | Provisioning #673/0191 remains recorded baseline. Existing-sender adoption #676 is merged; #677 configuration and #674 outbound routing are open. #674 source is 0194. WAIT dual-channel support is authorized follow-on work, not delivered by email-only #680. Sender continuity, consent/STOP and real delivery remain separate gates. [S27, S28] |
| Client portal/rebooking | Useful control surface; rebooking intelligence and lifecycle not complete. |
| Operations | Monitoring improved; restore drill and mature support/incident operations incomplete. |
| Accessibility | Retain UI-00 and shipped UI-01D/E baseline. #667 is now verified merged for thirteen Client Profile touch/focus controls. Other adoption and #669 remain subject to their own refresh/review. Real device and assistive-technology acceptance is not inferred. [S21] |
| New-client waitlist / admission control | WAIT-03 is merged/deployed through #708, repaired by #709 (0197) and completed by #713 (0198); hosted **0192–0199** *(corrected 2026-09-19; this read 0192–0198)*. The controlled test studio has production-exercised the **full twelve-seam journey**, including invitation, booking and atomic conversion. WAIT-04A shipped in #712. ⚠️ **CORRECTED 2026-09-19:** this said Willow remained on the legacy gate with durable WAIT switched off until continuity, owner control and reconciliation were complete. Willow has been on the **durable** commit point since on or before 2026-08-25 — the cutover preceded those three, which remain outstanding. WAIT-04 seams S1–S5 remain accepted/unverified follow-on policy, and nine commands applied to production still have no caller. [§§3, 14.5, 15; S42] |
| Capacity intelligence | OWNER-CAP #638 is MERGED/DEPLOYED, with #641 real browser coverage and #645 permanent owner Business navigation. It provides the owner-only active-treatment/no-future-treatment worklist, treatment booking depth and future treatment time from one fail-closed snapshot. Latent recurring-demand projection and safe-admission calculation remain open under REBOOK/ADMIT. |
| Selected-day Dashboard prep / historical truth | HIST/F3 authority contract and acceptance debt remain carried forward. Failed #608/#611/#613 vehicles do not authorize a runtime restart. Re-entry requires mechanically derived completeness, independent falsification and fault injection. Current deployed clinical truth is not re-audited here. |
| Hone UI design system | #609 merged/deployed. Semantic tokens and the small Hone-owned Button/SectionLabel/StatusPill/Field/Skeleton layer are live. Remaining work is adoption, accessibility/touch coverage, loading/pending language and incremental practitioner-surface presentation - not another framework. |
| Interaction performance / latency evidence | Preserve the historical #612 production measurements and existing PERF ladder. No new speed or flag-state verification was performed by v1.10. Speed stays product quality, but the current work queue is §23 rather than the older performance-first schedule. |
| Parallel-work browser isolation | TEST-PORT-01 shipped via #615: worktree-local app ports and unconditional no-reuse make cross-worktree server attachment fail loudly. Supabase/Postgres/Mailpit remain shared, so concurrent local db-reset evidence is still inadmissible. |
| Owner earnings timeline | FIN-01 baseline and #652 label correction are not complete earnings reporting. FIN-02A/B local candidate work is preserved; database snapshot proof, integrated model/UI, migration allocation, current review and owner acceptance remain. [S29] |

<a id="hone_s_9_3"></a>
## 9.3 Major open product capabilities

Before Today.

What Changed Today?

Visit Closeout.

Smart practitioner manual booking rebuild.

Calendar appointment-prep drawer rebuild.

MultiPlex structured charting + memory.

Appointment service/duration editing.

Rebooking Intelligence.

Cancellation cutoff.

Partial refunds.

Owner Financials.

Practice/Book Health.

Cancellation Recovery.

Low-touch onboarding and ordinary self-service.

Durable new-client waitlist + private invitation lifecycle.

Assisted admission control (Invite next N) and capacity intelligence.

Opt-in automatic waitlist release only after assisted-mode production validation.

Interpretation: this is the broader capability inventory, not a list of prerequisites to the first supervised paying design partner. Gate B entry is defined in §10; ordinary self-service and the full v1 destination remain separate. Current production priority is only §23.6. [S33]

<a id="hone_s_10"></a>
# 10. Milestones and Commercial Launch Gates

| **Gate** | **Purpose** | **Required state** |
| --- | --- | --- |
| A - Willow | Operate with real daily feedback. | Existing controlled-pilot safety; incidents and acceptance handled continuously. Current known historical-read debt must not become a definitive no-history claim on practitioner surfaces; use only evidence classes the current authority can support. Until OPS-01 is closed, reminder/scheduler health receives explicit operational review. When demand exceeds treatment capacity, new-client admission is truthfully contained without harming existing-client booking; kill switch and manual workaround are known. |
| B - 2-5 supervised design partners (DP-001) | Commercial/product learning while operator assistance still exists. | CURRENT-HEAD gate, not audit-head assumptions: AUTO-BOOT reconciles Run2B/Run3 and leaves no unresolved Stage A/B P0/P1; CLIN-01/HIST historical-truth authority is closed under the re-entry proof; OPS-01 hosted ownership/alert/drill evidence is closed; SEC-01, DATA-01, TRUTH-01 and PRIV-01 are closed or explicitly superseded with evidence; the five previously unreviewed authenticated-executable payment read/display helpers and hosted treatment-image authorization are dispositioned; DR-01A isolated DB+storage restore readiness passes; one proven complete manual archive + an operator offboarding exercise exist; onboarding/manual BILL-00/support owner/counsel-approved terms/privacy are repeatable. Durable waitlist may remain dark; if used, privacy/export/retention truth, separate activation authorization, kill switch and production smoke are required. Design partners pay from day one at the published founding rate via manual billing. |
| C - 10-50 ordinary self-service studios | Autonomy milestone. | Requires Gate B plus PAID_MEMORY_PROOF-001: at least two independent paying studios launch from the same runbook, Treatment Memory and Visit Closeout/rebooking are habitual and measurable, founder support burden is bounded, self-service import/export/offboarding/provider lifecycle is safe, DR-01B recurring production-shaped recovery evidence exists, and no generally offered waitlist/admission feature depends on founder inbox/manual database rescue. |
| D - 100+ studios | Scale milestone. | Queues/async jobs, storage lifecycle, quotas, noisy-neighbor controls, performance/SLO and mature ops. |
| E - Enterprise | Later strategic choice. | Only after ordinary SMB lifecycle is repeatable; enterprise controls are not an active roadmap priority. |

Gate B is supervised paid learning, not completion of the entire §22 v1 vision. Safe operator-assisted onboarding, import and offboarding may satisfy the defined supervised scope. This does not waive current-head trust, restore, archive/offboarding, billing, support or human-approved terms requirements. Gate C is the later autonomy milestone. [§18.1; S33]

<a id="hone_s_10_1"></a>
## 10.1 Design partner success metrics

Time to onboard.

Founder/operator minutes per studio.

Import completion and recovery rate.

Support requests per studio.

Appointments booked and sessions charted.

Treatment Memory and repeat-client usage.

Payment completion and rebooking.

Production incidents / escaped regressions.

Quality and frequency of product feedback.

<a id="hone_s_10_2"></a>
## 10.2 Stage B exit covenant - PAID_MEMORY_PROOF-001

| **MILESTONE  Gate B authorizes supervised paid learning only after its entry criteria are satisfied. PAID_MEMORY_PROOF-001 is the evidence covenant for graduating from supervised design partners toward Gate C self-service investment; it is not a shortcut around Gate B.** |
| --- |

| **Dimension** | **Required proof** |
| --- | --- |
| Trust | Current-head register has no Stage A/B P0/P1; CLIN/HIST, OPS, SEC, DATA, TRUTH and PRIV gate findings are closed/superseded with evidence; helper/storage evidence tail is dispositioned. |
| Clinical habit | Treatment Memory is used repeatedly in real care; unavailable/partial history cannot become definitive absence. |
| Workflow | Visit Closeout/rebooking/collection/follow-up is accepted on real practitioner devices and unresolved work remains visible. |
| SaaS repeatability | At least two independent paying studios launch using the same documented runbook with no undocumented founder-only routine step. |
| Operations | OPS-01 closed, named support/escalation owner, DR-01A isolated DB+storage restore exercise passed. |
| Portability/privacy | Canonical export manifest + one proven archive + recoverable offboarding case; retention/provider disconnect truth matches reality. |
| Commercial | Published/founding price accepted by independent studios; invoice/cancellation/support effort tracked. Willow is excluded from independent paid proof. |

<a id="hone_s_11"></a>
# 11. Wave 0: Clean Baseline and Roadmap Infrastructure

| **ID** | **Lane** | **Risk** | **Definition of done** |
| --- | --- | --- | --- |
| REL-593 | Trust/Product release - CLOSED_EVIDENCED | T3/T4 | Completed: #593 merged/deployed as 266b6092; hosted/repo migration max 0184; budget feature shipped. Historical apply-host truth correction is split to REL-EVID-01 rather than reopening the release train. |
| RDM-001 | PM / Governance | T0 | Maintain one accepted working edition at docs/roadmap/CANONICAL_ROADMAP.md after reviewed sync; derive the two-page brief and versioned DOCX; retain source lineage, the dated §3 checkpoint, §20 readings and one §23.6 queue. Prepared files are not a committed sync or production authorization. [S33] |
| AUTO-BOOT-001 | Trust/State | T2 | Mechanically reconcile the accepted Run2B/Run3 audit register and older finding families against current production. Classify every item CLOSED_EVIDENCED / OPEN / DOWNGRADED / SUPERSEDED / ACCEPTED_LIMITATION / EXTERNAL_DEPENDENCY / UNKNOWN. This is reconciliation, not a new broad audit. |
| DR-01A | Trust/Ops | T3 | Gate B restore readiness: inventory backups; name primary/backup restore owner; run an isolated database + storage restore exercise; verify application readability and basic recovery steps. Record measured evidence without inventing mature RPO/RTO. |
| DR-01B | Trust/Ops | T3 | Gate C recurring resilience: production-shaped recurring restore drill, measured RPO/RTO, capacity/incident communications, independent review and corrective follow-up. |
| TOOLCHAIN-01 | Trust/Test | T1 | Reproduce the focused audit/test environment from a clean checkout/install path. The Run2B local clean install exited nonzero internally; CI remains broad authority, but local independent replication must become reliable enough to falsify focused claims. |
| LANG-001 | Product quality | T0 | Hone Clear Language Standard; vocabulary dictionary, UNKNOWN/NONE rules, UI/error/docs rules; warning-only checker first. |
| PR-HYGIENE-001 | PM/Governance | T0 | Close stale reference PRs #520/#521/#536/#541/#543/#544 with replacement roadmap IDs; keep history. |
| ACCEPT-001 | Product acceptance | T0 | Seed formal Chloe acceptance register from the existing 17-item checklist; do not invent a new list. |
| WAIT-01 | Interrupt / Planned Product | T2 implementation + T4a activation | Emergency migration-free new-client waitlist **admission gate** went live for Willow after default-OFF dark deploy, existing-client smoke, studio-inbox canary and zero-business-write proof. ⚠️ **AMENDED 2026-09-19:** the admission gate was on at every measured instant — it is re-read per request, so its state after 2026-09-15 is not derivable from rows either — and Willow's submissions committed durably rather than through email at those instants — the durable branch took over on or before 2026-08-25, so the email is a notification and the row is the record. Continue observation and preserve kill switch; durable WAIT-02/03 remains the destination. |
| REL-EVID-01 | Trust / Release truth | T1/T2 | Resolve 0183/0184 apply-host provenance honestly: preserve #595 as failed discovery record, adjudicate #596 clean-room correction, close stale present-tense release claims and unlock the next migration train without weakening evidence standards. |

<a id="hone_s_12"></a>
# 12. AUTO-BOOT-001 and Canonical Findings Reconciliation

| **AUTO-BOOT RULE  AUTO-BOOT is not a new deep audit. It reconciles already-known overlapping registers against current production and assigns one canonical state to every item.** |
| --- |

<a id="hone_s_12_1"></a>
## 12.1 Required state vocabulary

| **State** | **Meaning** |
| --- | --- |
| CLOSED_EVIDENCED | Current code/DB/production evidence proves the finding closed. |
| OPEN | Still present and actionable. |
| DOWNGRADED | Still exists but risk/severity no longer matches old classification. |
| SUPERSEDED | Replaced by a different issue/capability or later architecture. |
| ACCEPTED_LIMITATION | Consciously accepted with owner and conditions. |
| EXTERNAL_DEPENDENCY | Cannot be closed by code alone; legal/provider/human dependency. |
| UNKNOWN | Allowed only as a temporary AUTO-BOOT result; must remain visible and route to verification. |

<a id="hone_s_12_2"></a>
## 12.2 Mandatory carry-forward reconciliation

| **Historical item** | **Concern** | **Routing if still open** |
| --- | --- | --- |
| F-COMP-001 | Canadian-hosting vs US-region truth claim | If OPEN -> TRUTH-01A immediately. |
| F-RET-001 | Published 30/90-day deletion promises not implemented | If OPEN -> TRUTH-01A copy correction + PRIV-01 capability. |
| N-DOC-001 | Terms/subscription/refund lifecycle describes unbuilt behavior | If OPEN -> TRUTH-01A. |
| F-PRIV-001 | Bearer URL/token/Sentry privacy risk | If OPEN -> SEC-CARRY-01 before design partners. |
| F-CLIN-004 | Intake review binding/authority | If OPEN -> CLIN-CARRY-01 before design partners. |
| Clinical direct DML | Old clinical-table DML finding | Expected closed by integrity train; prove, do not assume. |
| Appointment direct DML | Old appointment DML finding | Expected closed by 0172-0177; prove. |
| Actor attribution FK posture | Old attribution finding | Expected closed by 0178/0179; prove. |
| snapshot_appointment_buffer parity | Production/migration-chain divergence | If confirmed -> PARITY-01. |
| Payment persistence/authority | Older payment P1 families | Expected closed by payment train/#592; prove against current source and behavior. |

<a id="hone_s_12_3"></a>
## 12.3 AUTO-BOOT deliverables

Current production application SHA.

Hosted migration max, repo migration max, pending list and next free number.

Current enabled/dormant provider capabilities.

Canonical P0/P1/P2 register with evidence and source family.

Capability state: DESIGNED / BUILT / MERGED / DEPLOYED / ENABLED / PRODUCTION-EXERCISED / USER-ACCEPTED.

Open PR state and stale artifact disposition.

Roadmap dependency deltas.

No silent assumption that an older audit is still current.

<a id="hone_s_12_4"></a>
## 12.4 24 Aug 2026 audit register - historical severity, current-head reconciliation required

| **AUDIT AUTHORITY  The corrected Run2B package was produced at b9e0003 / hosted migration 0185. Its findings are authoritative as finding sources for that head, not as current status at production 46660c21 / migration 0187. AUTO-BOOT-001 must revalidate each item before implementation, closure or severity reuse.** |
| --- |

| **Finding** | **Run2B severity** | **v1.8 disposition before revalidation** | **Next canonical proof** |
| --- | --- | --- | --- |
| CLIN-01 | P1 / Stage A | PROVISIONAL OPEN - first trust question | HIST-01A four-state authority design; then exact historical question implementation only after re-entry accepted. |
| OPS-01 | P1 / Stage A | PROVISIONAL OPEN - first trust question | Hosted scheduler ownership/cadence/backlog/provider canary + independent stale alert + recovery drill. |
| SEC-01 | P1 / Stage B | REVALIDATE / probable Stage B blocker | Current public-booking possession + non-enumeration + provider-independent abuse bound. |
| DATA-01 | P1 / Stage B | REVALIDATE / probable Stage B blocker | Durable import ledger, resumable/idempotent executor, fault injection and truthful operator state. |
| TRUTH-01 | P1 / Stage B | REVALIDATE / probable Stage B blocker | Generated canonical export/resource manifest, expected-vs-exported counts and no unsupported complete/full wording. |
| PRIV-01 | P1 / Stage B | REVALIDATE / probable Stage B blocker | Recoverable offboarding case spanning export, access freeze, tokens, integrations, retention/legal hold and destructive purge evidence. |

Run2B corrected register: 0 P0 / 6 P1 / 9 P2 / 3 P3. Stage A: READY WITH CONDITIONS. Stage B: NOT READY. The accepted P2s include public-route security, WAIT privacy, onboarding, billing, accessibility, BCDR, Google Calendar, DB ACL and treatment-photo storage evidence; P3s include test/tooling, docs and multi-location breadth. Reconcile, do not blindly re-implement.

| **Historical audit score** | **Run2B** | **How v1.8 uses it** |
| --- | --- | --- |
| Tenant isolation | 86 / 100 | Strong baseline; preserve continuous cross-tenant proof. |
| Server authority | 88 / 100 | Strong baseline; do not weaken with UI/product work. |
| Clinical truth | 68 / 100 | Weakest product-trust domain; drives HIST-01A / CLIN priority. |
| Payments integrity | 90 / 100 | Strong at audit head; later PAY-SETTLE/0187 further strengthens settlement truth, but partial refunds remain separate. |
| Test confidence | 80 / 100 | Broad CI useful; exact-head adversarial review and fault injection remain mandatory for authority components. |
| Operational readiness | 48 / 100 | Weakest overall evidence area; drives OPS-01 and DR-01A before paid expansion. |

WAIT-PRIV-01 and the v1.9 audit-source ownership findings remain historical inputs. Do not reuse old #637-open or empty-allowlist statements as current state. New resource/retention/disclosure and real-studio activation still require their own current evidence.

The five authenticated-executable payment read/display DEFINER helpers and hosted treatment-image authorization/storage behavior remain a separately tracked Stage B evidence tail. Revalidate and disposition them before declaring Gate B ready; this document does not establish their closure.

Do not commission another broad security audit as the next step. Close or supersede the known corrected register through current-head evidence; broad re-audit is only warranted by a material architecture change or a new incident.

<a id="hone_s_13"></a>
# 13. TRUST-001 Detailed PR Program

| **PROVISIONAL MEMBERSHIP  The known work below is the canonical backbone, but AUTO-BOOT may insert carry-forward Trust items before or within it. TRUST-001 is a milestone, not a precommitted immutable PR list.** |
| --- |

| **ID** | **Domain** | **Risk** | **PR-level definition of done** |
| --- | --- | --- | --- |
| TRUTH-01A | Truth | T0/T1 | CLOSED_EVIDENCED via #644 for the bounded copy/registry/accountability slice: no unsupported 'full' export wording, one canonical resource registry and machine-derived manifest/audit metadata. TRUTH-01B/C/D/E remain separate portability work. Terms §16 remains OPEN_HUMAN_DECISION and was deliberately not edited. |
| OPS-01A | Ops | T1 | REVALIDATE / PARTIAL LOCAL ONLY. Provider/scheduler ownership and runtime evidence remain operational proof, not repository proof. Local operator tooling/runbook work has advanced, but no current hosted closure or recovery drill is claimed; primary/backup ownership and production cadence/backlog/provider-canary evidence must be verified. |
| OPS-01B | Ops | T2 | Controlled stale/missing scheduler drill; prove critical alert reaches owner and recovery clears correctly. |
| PARITY-01A | DB parity | T2 | Read-only compare hosted snapshot_appointment_buffer behavior/definition against fresh migration chain. Classify CLOSED or CONFIRMED. |
| PARITY-01B | DB parity | T3 | Conditional only if divergence confirmed: encode intended behavior in a new forward migration, fresh-chain proof, apply/reconcile. |
| SEC-01A | Booking security | T2 | Executable public-booking identity/abuse contract: spoofed known email, non-enumeration, duplicate submit, archived/unknown/existing, limiter outage, distributed-IP abuse. |
| SEC-01B | Booking security | T3 | Risk-adaptive email-possession challenge; no forced login for all; server-owned challenge and verification. |
| SEC-01C | Abuse resilience | T3 | Provider-independent emergency abuse bound; primary limiter outage must not become unlimited booking. |
| SEC-01D | Production enablement | T4a | Controlled default-off enablement, production non-enumeration/abuse smoke, evidence record. |
| DATA-01A | Import | T3 | Durable import_batch/import_source_row state model with deterministic row identity and explicit PARSED/VALIDATED/CLIENT_LINKED/MEMORY_LINKED/COMPLETE + failure states. |
| DATA-01B | Import | T3 | Idempotent executor: resume incomplete work; attach memory to already-created imported client; no recreate/skip trap. |
| DATA-01C | Import | T2 | Progress, retry and needs-review operator workflow with truthful status. |
| DATA-01D | Import | T3 | Failure injection at every persistence boundary; resume exactly; duplicate replay no-op; concurrency safe. |
| DATA-01E | Import enablement | T4a | Controlled self-service enablement only after operator cohort proves recovery; kill switch/rollback. |
| TRUTH-01B | Export | T2 | Parent export manifest/coverage program remains open in scope. #647 / TRUTH-01B-1 is verified merged for its bounded 27-column/five-file slice. Wider data classes, pagination, expected-versus-exported counts and binary portability remain separately proved. [S15] |
| TRUTH-01C | Export | T3 | Paginate every archive data source; remove Supabase max_rows truncation and truncated-parent dependent loss. |
| TRUTH-01D | Export | T2 | Expected vs exported counts; mismatch prevents a complete claim; manifest records omissions. |
| TRUTH-01E | Export | T2 | High-volume tenant and binary portability proof; avoid unbounded single-request memory work. |
| PRIV-01A | Offboarding | T3 | Studio closure state machine: REQUESTED -> ACCESS_FROZEN -> FINAL_EXPORT_VERIFIED -> TOKENS_REVOKED -> INTEGRATIONS_DISCONNECTED. |
| PRIV-01B | Offboarding | T3 | Retention/legal-hold classification for every data class; truthful purge/retain/backup expiry. |
| PRIV-01C | Offboarding | T4 | Resumable DB/storage/provider purge jobs; idempotent; operator-recoverable; destructive execution human-gated. |
| PRIV-01D | Offboarding | T3 | Completion certificate/audit: purged, retained, disconnected, when and why. |
| PRIV-01E | Offboarding drill | T4 | End-to-end non-customer closure drill with injected failure and recovery. |
| OPS-02A | Transactional delivery truth | T2/T3 | Define provider accepted / delivered / bounced / suppressed / inbox-unverified semantics for transactional email. Product success claims must not overstate provider acceptance; durable workflows may not depend permanently on an inbox as the only system of record. |
| AUDIT-RECON-01 | Current-head trust reconciliation | T2 | Reconcile Run2B/Run3 findings against current production 46660c21-or-later and hosted state. One canonical disposition per item with current evidence; historical severity is never silently promoted to current status. |
| DB-ACL-01A | Payment helper privilege evidence | T2 | Historical read-only recon is preserved; no new privilege change is authorized. Re-read the legitimate caller set and current hosted grants before a bounded least-privilege proposal. An old unclaimed migration number is not ownership. |
| STORAGE-01A | Treatment-image hosted authorization proof | T2/T3 | Hosted treatment-image bucket/policy/behavior proof: tenant boundary, object access path, unauthorized/cross-studio denial and storage lifecycle evidence. Repository policy text alone cannot close it. |
| DR-01A | Gate B restore readiness | T3 | Named restore owner + isolated DB/storage restore exercise before paid design-partner expansion. Evidence must include what was actually restored and what remains UNKNOWN. |

<a id="hone_s_13_1"></a>
## 13.1 Trust dependencies that the current product train cannot bypass

SEC-01B possession proof is a requirement at the new invitation identity boundary, not an excuse to force full account login on every prospect. Reuse a verified recipient/session mechanism when sound; typed email alone must not attach a booking to an existing clinical identity. None of this declares the broader public-booking security program closed. [S1, S14]

Scope conflict to resolve before implementation: the draft #665 body uses SEC-01C for duplicate/distributed-identity tooling, whereas this roadmap’s retained SEC-01C is the provider-independent emergency abuse bound. Preserve that ID’s roadmap meaning. Duplicate review/merge tooling remains a separate parent SEC-01 requirement to be explicitly scoped; do not overwrite or silently conflate the two. [S1, S14]

New waitlist/invitation resources must have explicit export, retention, consent and offboarding dispositions. Initial delivery is not permission to claim a complete archive or a legal retention promise. Commercial Gate B, restore, support ownership, privacy and hosted proof remain independently gated.

<a id="hone_s_13_2"></a>
## 13.2 WAIT evidence tail — retained, not a broad audit

Every new invitation, preference grant, policy, profile, delivery and restriction resource must join the canonical export/retention/offboarding inventory with an explicit disposition. The WAIT train exposed default-table-grant risk and missing export-registry registrations; broad default-grant guarding remains a separately recorded follow-up, not silently CLOSED by the local table fixes. Preserve the standing source-aware privilege and UNKNOWN laws. [S22, S25]

The accepted public/client policy still requires final disclosure/effective-date and accommodation/compliance review before general activation. This document records product intent and engineering boundaries; it does not supply a legal determination or declare commercial Gate B complete. [S18, S19]

<a id="hone_s_14"></a>
# 14. Practitioner Product / Chloe / Moat Detailed PR Program

<a id="hone_s_14_1"></a>
## 14.1 Contract-first rebuilds

| **ID** | **Product** | **Risk** | **Definition of done** |
| --- | --- | --- | --- |
| SMART-00 | Internal booking contract | T0/T1 | Freeze product contract, authority map, scope budget and structured regression corpus before runtime changes. Desired tests activated RED at SMART-01 start. |
| SMART-01 | Server-authoritative manual booking | T2 | Parent program: one server evaluation contract used by authenticated booking surfaces; candidate -> typed challenge/refusal -> scoped acknowledgement -> server re-evaluation -> execute. Delivery decomposes through SMART-01A-E; no comprehensive browser scheduling framework. |
| CAL-00 | Appointment prep contract | T0/T1 | Freeze lazy-load, identity/currentness, stored duration, write-result, refresh-failure, narrative provenance and mobile behavior rules. |
| CAL-01 | Appointment prep drawer rebuild | T2 | Minimal client presentation state; identity-keyed render authority; fresh server detail; governed notes/cancel/move; no mutable mirror reconciled by value equality; no migration expected. |
| SMART-01A | Calendar-date weekday derivation | T2 | Migration-free parity fix: requested studio-local calendar date determines weekday independent of fabricated UTC instants or machine timezone. Public/internal slot callers stay semantically aligned. Current delivery vehicle: PR #597. |
| SMART-01B | Capacity-OFF working-hours / eligibility DB authority (M1) | T3 | When practitioner capacity is OFF, Postgres must still enforce the intended working-hours/blockout/eligibility contract or an explicit accepted limitation must be recorded. Production preflight required because this may reject bookings previously accepted. |
| SMART-01C | Separate exception semantics for outside-hours / buffer / custom duration (M2) | T3 | Retire overloaded booked_outside_availability semantics. Buffer acknowledgement must not permanently disable future buffer enforcement; each exception reason has truthful audit attribution and scoped acknowledgement. |
| SMART-01D | Both authenticated booking surfaces on one server evaluation contract | T2/T3 | Migrate BookAppointment and QuickBook together. Browser displays proposal/challenges; server snapshot owns duration/availability/currentness; UNKNOWN fails closed; stale responses cannot authorize. |
| SMART-01E | Move / Reassign semantic parity | T2/T3 | Move/reassign stops treating custom time as automatically outside availability. Reuse the same authority concepts without creating a second exception dialect. |

<a id="hone_s_14_2"></a>
## 14.2 SMART-00 regression corpus

| **Case** | **Required behavior** |
| --- | --- |
| Suggested 15:10 | Normal booking. |
| Legal non-suggested 15:30 | Normal booking. |
| 15:30 audit | booked_outside_availability remains false. |
| True outside hours owner | Typed challenge + explicit ack. |
| True outside hours member | Refused. |
| UNKNOWN availability | Fail closed; never described as known outside-hours. |
| DST spring-forward nonexistent time | Rejected. |
| UTC+13/+14 | Correct local weekday/hour. |
| Stale service/date/practitioner/timezone/capacity | Cannot authorize. |
| Hard conflict | Never override. |
| Buffer conflict | Separate challenge. |
| Custom duration | Separate challenge. |
| Two exception reasons | All required acknowledgements. |
| Stale acknowledged reason/interval | Refused. |
| Failed refresh | Never restores authority. |
| Both internal surfaces | Identical semantics. |
| Public booking/reschedule | Unchanged candidate-set authority. |

<a id="hone_s_14_3"></a>
## 14.3 Treatment Memory differentiation

| **ID** | **Capability** | **Risk** | **Definition of done** |
| --- | --- | --- | --- |
| TM-01 | Before Today server projection | T2 | Historical projection consumes exact authority answers for prior-visit existence, latest treatment, latest recorded setup and latest watch/plan note before cutoff. Each answer is COMPLETE / PARTIAL / EMPTY_PROVEN / UNAVAILABLE; positive facts may render, but only EMPTY_PROVEN licenses definitive absence. Exact selected-visit detail loads separately. |
| HIST-01 | Exact historical question authority | T2 (T3 if new DB function/migration) | One database-owned contract per clinically meaningful question: prior visit exists, latest recorded setup before cutoff, latest watch/plan note, latest treatment visit and exact selected-visit detail. Own cutoff/exclusions/void filtering/clinical predicate/total order. Return COMPLETE(value), PARTIAL(value, reason, bound), EMPTY_PROVEN(scope, completed_at) or UNAVAILABLE(reason, retryable). Only EMPTY_PROVEN authorizes definitive absence. Child/detail completeness is proved by the authority, never several independently capped arrays. |
| HIST-01A | Historical authority re-entry verification architecture - FIRST | T2 | READY_FOR_REENTRY_DESIGN. Before another runtime implementation: mechanically derive the exact question/resource census; define the four-state result grammar; build an independent adversarial falsifier by construction; define malformed/unreadable/partial/truncated/concurrent fault injection. Runtime implementation remains HOLD until this verification design is accepted. |
| TM-02 | Before Today UI | T1/T2 | Five-second briefing on Today and selected appointment prep with the same useful preparation grammar. Positive recorded facts render independently. Collection-derived absence claims are structurally forbidden; authoritative scalar-null reminders require a fully read record. #608 is retired; replacement Prep V2 must rebuild clean-room from current production. |
| TM-03 | What Changed Today comparison contract | T2 | Same-as-last vs changed dimensions; pure comparison; prior visit never mutated. |
| TM-04 | Exception-based charting workflow | T2 | Practitioner marks changes, then canonical current chart persists; no stale copied authority. |
| MPX-01 | MultiPlex clinical discovery | T0/T1 | Chloe/device terminology map, including unresolved 1.1s; identify changed vs calculated and return-visit-important fields; no migration. Named field scope from Chloe: slow thermolysis duration/intensity, snap duration/intensity, snap count, probe series/gauge, Apilus preset number, plus the Apilus body-part + preset picker concept. |
| MPX-02 | MultiPlex structured storage | T3 | Precise clinically meaningful schema derived from MPX-01; backward compatible; no generic number_1/duration_2. |
| MPX-03 | MultiPlex charting UI | T2 | Treatment-room efficient entry using real device vocabulary and accessible controls. |
| MPX-04 | MultiPlex Treatment Memory | T2 | Exact prior setup and relevant outcomes available for reproduction/adjustment. |
| MPX-05 | MultiPlex prep integration | T1/T2 | Surface relevant prior MultiPlex state in Before Today/appointment prep. |

**v1.12 placement. **MultiPlex is the THEN production item after the WAIT release (Sam, 7 September). Sequence: MPX-01 Chloe field interview, no migration → MPX-02 storage, migration number by fresh census, migration applied and verified on hosted production before merged code reads the column → MPX-03 charting UI. MPX-04 / MPX-05 are the payoff: the next visit's Before Today shows the recorded MultiPlex settings unflattened. Confirm the TM-01 modality-extensibility contract flagged in the v1.1 review before MPX-02. Done means Chloe charts a MultiPlex session with the full field set on her device and sees it in the next visit's prep; acceptance recorded in ACCEPT-001. [S31]

<a id="hone_s_14_4"></a>
## 14.4 Workflow, appointment and rebooking

| **ID** | **Capability** | **Risk** | **Definition of done** |
| --- | --- | --- | --- |
| FLOW-01 | Closeout state model | T2 | Independent chart/outcome/payment/next-visit resolution state per appointment. |
| FLOW-02 | Visit Closeout workflow | T2 | Canonical Visit Closeout wedge: Treat -> Chart -> Aftercare -> Complete -> Collect/Receipt -> Rebook/Follow-up. Unresolved chart/outcome/payment/next-visit work returns to To-do. Do not create a second CLOSE-01 state model; Run3 CLOSE-01 maps to FLOW-01/02/03. Historical/clinical context must consume safe HIST authority. |
| FLOW-03 | Quick Checkout/receipt/rebooking integration | T2/T4 | Reuse current money authority; no weakened confirmation; successful visit resolution removes work. |
| PAY-UX-01 | Practitioner payment presentation | T1/T2 | Amount, card, status, Charge, Receipt, Refund; internal Stripe/provider detail hidden behind owner/operator disclosure. Attach to Closeout, not standalone redesign. |
| APPT-EDIT-01 | Governed service + duration command | T3 | Service suggests default duration; practitioner confirms; recompute ends_at/reservation/buffer; collision/availability; audit; Google update. |
| APPT-EDIT-02 | Appointment edit UI | T1/T2 | Clear old/new service/duration; stale appointment refusal; no direct appointment DML. |
| REBOOK-01 | Return-state model | T2 | Future booking, cadence, due soon/due/overdue/no-future-booking; deterministic, no AI guessing. |
| REBOOK-02 | Rebook from Closeout | T2 | Context-preserving next appointment; preferred service/duration; safe availability. |
| REBOOK-03 | Due-client To-do | T1/T2 | True due clients without future booking surface with one direct action and truthful reason. |

<a id="hone_s_14_5"></a>
## 14.5 New Client Admission, Waitlist and Capacity Intelligence

| **HISTORICAL PRODUCT DISCOVERY  The August 18 Willow capacity snapshot explains the admission-control program; it is not today’s capacity. The original measurements remain in Appendix E and must be recomputed before capacity decisions.** |
| --- |

The waitlist is therefore not a generic CRM list. It is the first control in a new admission system whose purpose is to match new-client acquisition to the recurring treatment capacity the practice can actually deliver.

| **ID** | **Capability** | **Risk** | **Definition of done** |
| --- | --- | --- | --- |
| WAIT-00 | New-client admission product contract | T0/T1 | Accepted policy now includes selected initial consultations, fixed 48-hour response policy, structured client responses and original-priority preservation for unsuitable offers. No public exact queue-number promise. Final consult restrictions and dual-channel details are in WAIT-04; no automatic appointment creation. |
| WAIT-01 | Emergency new-client waitlist gate | T2 + T4a | Migration-free/default-OFF containment. New clients are diverted before slot selection; existing clients remain normal; forged/stale new-client submits are refused server-side before mutation; studio provider acceptance is the temporary commit point; Stage B requires real inbox proof and a kill switch. |
| WAIT-02 | Durable studio-scoped waitlist | T3 | **DEPLOYED FOUNDATION / CONTROLLED TEST-STUDIO ENABLEMENT.** Hosted 0192–0196 are recorded applied. The test studio durable queue is production-exercised through join + owner queue. ⚠️ **CORRECTED 2026-09-19:** this said Willow remained legacy-enabled with the durable path switched off, pending explicit reconciliation/migration. Willow has been on the **durable** commit point since on or before 2026-08-25 (28 rows measured 2026-09-19). The reconciliation and migration it names are still outstanding — but they now follow a cutover that already happened, rather than gating one. Privacy/export/retention and general-studio activation remain separate. [§3; S37, S38] |
| WAIT-03 | Private invitation lifecycle and usable booking workflow | T2/T3 + T4a enablement | **MERGED / DEPLOYED, PRODUCTION-EXERCISED END TO END, STILL NOT USER-ACCEPTED.** #708 integrated the reviewed 0192–0196 stack; #709 added the Invitation-capacity workflow with 0197; #713 completed the live predicate with 0198. The test-studio canary then passed all twelve seams, including truthful consume/book recovery and the fail-closed refusal. **User acceptance is a separate state and has not happened:** the run used a synthetic identity on a controlled studio, with no provider send. [§3; S42] |
| ADMIT-01 | Admission-capacity metric contract | T2 | Define first-treatment lead time, mature consultation conversion, existing-client no-future-booking state, booked vs latent recurring demand, net bookable capacity, outstanding invitations and safe admissions/week. Prevent double counting. |
| OWNER-CAP-01 | Owner active-treatment + rebooking worklist | T1/T2 | DONE / PRODUCTION. #638 shipped the owner-only one-snapshot active-treatment/no-future-treatment worklist, booking depth and future treatment time with UNKNOWN fail-closed; #641 added real browser coverage and #645 gave owners permanent Business navigation. It remains an input to REBOOK/ADMIT, not the final safe-admission formula. |
| ADMIT-02 | Assisted admission control | T2 | Hone calculates Safe to invite N with a deterministic explanation; Chloe chooses Invite next N; server/database enforces exact N and invitation state atomically. Human-in-loop is the required production proving stage. |
| ADMIT-03 | Opt-in automatic release | T3/T4a | Studio default OFF. Same deterministic admission budget used by assisted mode; automatic worker may claim no more than N; expiration may release the next entry; monitored pilot and immediate pause/kill switch. |
| ADMIT-04 | Capacity-expansion economics | T1/T2 | Use waitlist growth, unmet admissions, treatment lead time, utilization and collected-value contracts to quantify when another practitioner day materially increases service capacity and revenue. No fabricated LTV or fixed-rate assumption. |
| WAIT-04 | **Level 3 — Chloe launch policy / contact / communication** | T2/T3 + T4a | **TOP PRIORITY / PARTIALLY EFFECTIVE / NOT COMPLETE.** Shipped pieces now include the production Invite-to-book core, the safe redeemed-no-booking exit (#741/#747), 48-hour default opportunity (#748; fixed/no-choice policy still open) and owner-visible read-only SMS sender status (#749). Still required before Level 3 is DONE: rich profile/legacy completion, verified mobile + prospect STOP/suppression, supported per-studio sender activation, email+eligible SMS, WAIT-specific 24h reminder, four response choices, first-consultation rules and Chloe real-device acceptance. |
| WAIT-FORECAST-01 | Time-to-invitation estimate | T2 | LATER / NOT BUILT. Instrument now. Forecast access to consultation invitation, not treatment start; show calibrated ranges only after enough matching history and accepted capacity assumptions. Maps to ADMIT-01, not a second admission engine. |

### 14.5.0 WAIT maturity levels — current product priority

| **Level** | **What it means** | **Current state** |
| --- | --- | --- |
| **Level 1 — Durable queue** | Studio-scoped durable join/removal, owner queue visibility, manual/legacy entry and basic availability/provenance operations. | **SHIPPED / active at Willow on the last measured durable interval.** Human acceptance is separate. |
| **Level 2 — Invite-to-book core** | Invitation capacity; scoped email invitation; recipient proof; permitted-slot booking; decline; atomic waitlist conversion; delivery truth; release/expire/requeue; safe redeemed-no-booking exit; 48-hour default opportunity. The fixed/no-choice 48-hour policy is not yet complete. | **SHIPPED SOFTWARE.** Controlled test-studio journey is production-exercised. Willow real-client exercise/acceptance is not inferred. |
| **Level 3 — Full WAIT Operating System** | Retrospective Willow reconciliation + owner control; complete profile; verified mobile and STOP; supported Willow sender; email+eligible SMS; WAIT 24h reminder; all four responses; first-consult lifecycle; Chloe acceptance. | **TOP PRIORITY — INCOMPLETE.** Independent UI/UX, onboarding, sign-out and marketing releases may continue and ship alongside it; Level 3 owns priority, not exclusivity. Shared migration/provider/authority conflicts still serialize behind the active WAIT unit. |

<a id="hone_s_14_5_1"></a>
## 14.5.1 Admission dependency law

WAIT-01 may ship before the durable queue because it is a reversible C1 containment mechanism; it may not become the permanent system of record.

WAIT-02 and WAIT-03 may be built before mature forecasting, but ADMIT-02 must not claim a safe release count until ADMIT-01 and REBOOK-01 provide truthful inputs.

REBOOK-01 is a dependency for mature capacity intelligence: an active treatment client with no future appointment is not zero demand.

HEALTH-01 consumes ADMIT-01 metrics; it does not define a separate capacity formula.

CANCEL-RECOVERY and WAIT-03 should converge on shared offer/claim/invitation primitives where the domain semantics truly match, rather than creating parallel race-handling systems.

Automatic release (ADMIT-03) is blocked until assisted release has production evidence that model recommendations agree with real practitioner capacity decisions.

<a id="hone_s_14_5_2"></a>
## 14.5.2 Capacity metric authority

| **Metric** | **Canonical meaning / authority** |
| --- | --- |
| First-treatment lead time | Earliest legal treatment-sized opening after consultation conversion; prefer an explicit standard duration such as 60 minutes for Willow analysis. Not the next arbitrary calendar gap. |
| New-client intake rate | First-ever consultation bookings per studio-local week. Existing clients and repeat consultations must not inflate acquisition rate. |
| Mature consultation conversion | Cohorts whose observation window has elapsed; report numerator, denominator and horizon together. Small 30/42-day cohorts remain directional, not authoritative. |
| Existing clients with no future booking | Active treatment clients with zero confirmed future non-consultation treatment. This is a visibility/latent-demand signal, not a direct forecast of hours. |
| Net bookable capacity | Configured open hours minus blocks inside open hours, then appointment and buffer occupancy under the authoritative scheduling contract. |
| Latent recurring demand | Projected treatment demand not already represented by future bookings. Any cadence model must subtract or match existing future bookings to avoid double counting. |
| Safe admissions/week | Deterministic remaining new-client budget after lead-time target, weekly cap, outstanding invitations and current/latent demand are considered. Never derive from one utilization percentage alone. |
| Waitlist pressure | Joined/waiting counts, age distribution and release/conversion rate. Queue position is not promised unless policy explicitly guarantees it. |

<a id="hone_s_14_5_3"></a>
## 14.5.3 Forecast and evidence limits

Do not add total cadence-implied hours on top of already-booked future treatment hours. Forecast only the unbooked residual or explicitly match expected occurrences to actual future bookings.

Do not use booked_outside_availability as an overload metric while M2 remains open; buffer/custom-duration exceptions contaminate that flag as a pure outside-hours signal.

Treat insufficient history as UNKNOWN, not zero. At the Willow snapshot, 12 of 17 active treatment clients lacked enough history for a stable cadence estimate.

Later-visit cadence and duration samples are immature. Visit 1 has useful evidence; visits 2-5 have small denominators and must not drive permanent automatic release by themselves.

A studio may manually choose a stricter cap than the model recommends. Automation is an operational aid, not a right to consume the practitioner's calendar.

<a id="hone_s_14_5_4"></a>
## 14.5.4 Manual -> assisted -> automatic maturity

| **Level** | **Behavior** | **Release boundary** |
| --- | --- | --- |
| Manual | Studio sees durable waiting list and manually contacts/invites people. | Required immediately after durable queue exists; establishes real queue behavior and policy. |
| Assisted | Hone displays Safe to invite N and practitioner presses Invite next N. | Required proving stage before automatic release; measure recommendation acceptance/override. |
| Automatic | Studio opts in; deterministic engine claims at most N and sends private invitations under TTL/kill-switch policy. | T4a production pilot only after assisted mode is stable and capacity metric contracts are accepted. |

<a id="hone_s_14_5_5"></a>
## 14.5.5 WAIT-03 — accepted architecture and constructed component map

| **CORE IS LIVE; FULL WILLOW LAUNCH IS NOT DONE** |
| --- |
| #708 moved the reviewed WAIT-03 core and migrations 0192–0196 into production; #709/0197 and #713/0198 completed the chain. The component table below is now **architectural provenance**, not a merge plan. The Invitation-capacity step is restored and the canary has completed with a twelve-seam pass. Production acceptance remains the user journey: Willow continuity/owner control and the accepted WAIT-04 policy still require their own evidence and authorization. [S42] |

| **Component / owner** | **What was built or decided** | **Integration boundary** |
| --- | --- | --- |
| B1–B1.5c / #681 / 0192 | Stored offer scope and admission allowance; separate recipient proof; DB-locked mutation capability bound to invitation/studio/recipient; explicit grants/revokes. [S22] | URL allows view/request proof, not book/decline. Capability is DB-owned at ≤30 minutes; challenge remains separately bounded at 1–60 minutes. |
| B2 / #682 | Typed server wrappers; requested-slot scope evaluated in studio timezone; public booking reuse; unknown codes yield unavailable. proofChallengeId and rawChallenge are returned server-side. [S23] | No second booking engine. Brand/type discipline is not the runtime security boundary; locked DB proof checks remain required. |
| ADMIT / #685 / 0193 | Atomic waiting/claimed → invited wrapper; stored preferences and provenance; manual/legacy entry support; ranked claims and admission policy. [S25] | Issuance refusal unwinds the internal claim. No provider call in the transaction. Lock order, post-lock time, FK compatibility and existing lifecycle interactions require DB concurrency proof. |
| Delivery / #680 | Invitation email and separate proof-code email; secret-free event idempotency, retry/recovery classification, source/privacy guards. [S26] | Email-only component. Invitation and challenge lifecycle scopes differ. Provider uncertainty is not permission to invalidate a live invitation or proof. |
| B4 / #683 | One Invite-to-book action and compact service/date/day/expiry composer; presentation-safe UNKNOWN model; ARIA and dormancy work. [S24] | Still unwired. WAIT-04 removes the user-selectable expiry in favor of fixed policy; that follow-on must align types, UI and DB together. |
| B3 / #686 | /invitation/[token] recipient experience; proof form; server-filtered availability; canonical Book/Decline; phone and recovery repairs. [S26] | Recorded branch contract still lacks proof sending. Four-choice response UX is new WAIT-04 scope, not already built by this branch. |
| WAIT-ENTRY-01 / WAIT-PREF-01 | Existing roadmap children now have partial implementation in #685 and new profile/response requirements in WAIT-04. [S19, S25] | Do not duplicate preference or legacy-import engines. Reuse actual authority while preserving truthful join dates, provenance and consent. |

### 14.5.5A Three clocks; one protected recipient boundary

Keep the invitation response deadline, the permitted appointment date range, the proof-challenge expiry and the verified capability expiry distinct. The date range is fixed at issuance, not a moving “next N days” at browsing. For Willow’s newly accepted policy the invitation window is 48 hours; #680 requests a 20-minute proof challenge; #681 separately owns the capability’s hard 30-minute ceiling. The last two are not invitation expiry and do not inherit 48 hours. [S19, S22, S26]

Open/preview/reload/GET must never book, consume, decline or remove. The browser receives presentation state, masked contact and permitted slots—not raw stored email/phone, internal ids/hash fields, the returned proof secret or proofChallengeId. The user may type a received code; the server never sends that code to the browser as a return value. Capability stays HttpOnly and is rechecked at the locked mutation. [S22, S23, S26]

### 14.5.5B Booking atomicity and the accepted recovery limitation

| **DO NOT OVERSTATE ATOMICITY** |
| --- |
| Atomic admission is not atomic appointment creation. #685 rolls back partial claiming if issuing an invitation fails. Separately, current B2 consumes the invitation before calling the existing appointment command. If creation then fails, the invitation is spent and no appointment may exist. [S23, S25] |

The client outcome must distinguish confirmed booked, definitively consumed without booking, and indeterminate transport outcome. “Already used” alone does not prove “appointment already booked” or a confirmation email. A definitive consumed-without-booking case directs the client to the studio; direct practitioner recovery remains possible. An ambiguous request must be reconciled before another booking attempt to prevent duplication. This explicit limitation supersedes the v1.10 idealized “a lost slot never consumes the opportunity” assertion; the old wording is archived in F.6. [S19, S23, S26]

The final integrated acceptance must prove this limitation is visible and recoverable without inventing a second booking engine or silently calling release/reissue on a spent invitation. A future true atomic consume+book redesign is a separate authorization, not presumed work already completed.

<a id="hone_s_14_5_6"></a>
## 14.5.6 WAIT-03 delivery children and binding plan

| **Retained item** | **Now maps to** | **Remaining definition of done** |
| --- | --- | --- |
| WAIT-03-SCOPE | 0192/#681 + B2/#682 → #708 | **MERGED / DEPLOYED core.** Exact scope and mutation-time legality remain binding; empty/unreadable scope never means unrestricted. Re-prove in the resumed canary rather than reopening the frozen component. |
| WAIT-03-SELF | 0192/#681 + B3/#686 → #708; richer responses in WAIT-04B,D | **MERGED / DEPLOYED core.** Proof-bound recipient mutations remain. Four-choice Chloe taxonomy, reminder/deadline and consult rules remain WAIT-04 scope. |
| WAIT-03-DELIVERY | Email #680 → #708; dual-channel WAIT-04C | **Email core shipped.** Provider acceptance/delivery truth still applies. SMS/STOP/reminder are not implied by #708 and need separate activation proof. |
| WAIT-03-ACCEPT | #708 + #709/0197 + #713/0198 production, controlled test-studio canary | **FULL PASS — 12 of 12 seams**, invitation through booking, atomic conversion, reload truth and the fail-closed refusal on exhausted capacity. Post-canary cleanup complete. This is journey proof on a controlled studio; it is **not** Chloe acceptance and not Willow activation. |
| WAIT-ENTRY-01 | Manual/legacy #685 + profile WAIT-04A,B | Durable entry works for the controlled join **and for Willow, which has been on the durable path since on or before 2026-08-25**. ⚠️ *(Corrected 2026-09-19: this said legacy/profile-completion and original-priority migration remain **before** the Willow durable cutover.)* Those remain **outstanding after it** — the cutover did not wait for them. |
| WAIT-PREF-01 | Preference authority #685 + WAIT-04A,B,D | Existing weekdays/weekends/both authority remains; richer intake/prioritization is after the core canary and must preserve queue history. |

Dependency shape: #681 → #682 → #686. #685 is a sibling above #681. #680 is the transport component. #683 consumes the final authenticated adapter. WAIT-04 extends the accepted behavior and binds these through one integration owner. It is not safe to guess a linear merge order from the PR numbers; derive exact ancestry and changed-file overlap first. [S22–S26]

Binding points to prove: practitioner adapter → authenticated atomic admission; issuance result → invitation email/SMS; request proof → challenge issuance → separate proof delivery; client Book/Decline/response → B2 and the matching DB authority; current route privacy registry → actual public route. Do not expose an unwired control or remove a dormancy guard before its replacement integrated behavior is proved.

<a id="hone_s_14_5_7"></a>
## 14.5.7 WAIT-04 — frozen Chloe launch contract

| **LEVEL 3 TOP PRIORITY — PARTIALLY EFFECTIVE, NOT COMPLETE** |
| --- |
| Sam has now made the full Level 3 WAIT operating system Hone's top product priority. Parts of the frozen contract are already effective in production: the email Invite-to-book core, the **48-hour default** opportunity and redeemed-no-booking exit. The frozen fixed/no-expiry-choice 48-hour policy is still open because the live composer continues to permit alternate TTLs. #749 exposes sender state but does not provision or route SMS. The remaining profile, verified-mobile/STOP, dual-channel reminder/response and first-consult rules stay required. This roadmap authorizes bounded development, not a migration number, provider effect, real-customer send or launch acceptance. [S19] |

### 14.5.7A Join and complete a waitlist profile

| **Field / path** | **Required behavior** |
| --- | --- |
| First and last name | Separate, required fields for new joins. Preserve legitimate name characters; no fabricated split of a legacy combined name. No policy requiring a particular name format beyond the accepted two-field collection. |
| Email and mobile | Both required for new joins, validated through canonical server rules. A contact phone is not consent and not proof of identity; a typed email cannot impersonate an existing client. |
| Treatment areas | Required controlled multi-select of canonical treatment-area IDs. Multiple areas supported. No free-text urgency, notes or “Other—tell us more” box. Validate allowed IDs server-side; no arbitrary string accepted as an area. |
| Availability | Required structured weekdays / weekends / both, using the existing preference vocabulary. No duplicate policy/weekday authority. |
| SMS permission | Separate explicit unchecked operational-SMS opt-in with version/time/source and current suppression. Refusing SMS permission is not silently converted to consent merely because mobile is required. |
| Legacy incomplete entries | Preserve records and original waiting priority. Mark incomplete honestly; allow secure recipient completion or authorized practitioner completion. Do not invent names/phone/areas/consent or erase email-only prospects. |
| Invitation eligibility | New Invite-to-book requires the agreed complete profile. Existing live offers/appointments must not be invalidated merely by installing new validation. A migration/activation compatibility plan and tested operator path are required. |
| Public response | No exact position guarantee or fabricated wait-time estimate. Explain that an invitation is sent when matching consultation times become available. Profile completion never resets waiting priority. |

### 14.5.7B Invitation and response policy

| **Moment / client choice** | **Required product result** | **Authority / race condition** |
| --- | --- | --- |
| Send invitation | Email plus eligible consented SMS; one opportunity and one response deadline, not two invitations. Fixed 48 hours; no expiry question in Chloe’s composer. | Server/DB deadline and policy version; scope is fixed appointment dates/days. Delivery failure does not fabricate an issuance failure. |
| 24-hour reminder | One reminder through eligible channels if the invitation is still awaiting response. | Per-invitation/channel/event dedupe; re-check consent, lifecycle and deadline immediately before send; never remind after book/response/remove. |
| Book a time | Only permitted live consultation slots; record confirmed booking result. | Proof-bound capability plus current admission, identity, scope and booking authority. No unrestricted treatment rights from first client creation. |
| These times don’t work—keep my place | Close the current offer and return/remain waiting with original waiting-time priority. | Atomic response/return; no repeat invitation to the same declined offer; one result under book/revoke/expiry races. |
| Update my availability—keep my place | Update structured preference, close this offer, preserve waiting-time priority. | One governed response path; no mutation of another studio/entry; avoid partial “updated but stranded” results. |
| Remove me from the waitlist | Leave the active list and stop further automated waitlist invitation/contact attempts. | Explicit opt-out event. No-contact for this waitlist is not silently applied as a global clinical-record purge or unrelated appointment-cancellation policy. |
| No response at 48 hours | Remove from the active waitlist under the disclosed policy, not permanently ban the person. | Only after authoritative deadline, no qualifying response and sufficient delivery opportunity evidence. Missing/failed/ambiguous delivery cannot silently become client disinterest. |
| SMS STOP | Stop SMS through the existing suppression authority. | STOP is not, by itself, leave-waitlist or consent to another channel. Respect distinct policies and do not bypass phone-wide suppression. |

### 14.5.7C First-consultation boundaries

| **Event** | **Accepted clinic rule** | **Required implementation detail** |
| --- | --- | --- |
| Request to reschedule online | No client-controlled rescheduling of first consultations. | Enforce in confirmation/reminder/portal/old-link routes and server mutation, not only one hidden button. Opening a link does not cancel anything. |
| Cancel and return to waitlist | Client confirms cancellation and a NEW waiting-time priority; previous spot is not held. | Atomic governed cancellation/return behavior or explicit truthful recovery; link new waiting cycle to original history. Do not overwrite the old joined_at. |
| Cancel and leave | Cancel without forcing someone back into waitlist contact. | Explicit separate intent, clear consequences and current cancellation authority. |
| Clinic-initiated / practitioner-approved move | Clinic can move the appointment without a waitlist penalty. | Authorized practitioner command, reason/audit where required; remains booked; does not silently grant future client reschedule rights. |
| Consultation no-call/no-show | Permanent clinic-scoped self-service booking restriction; no automatic expiry/reinstatement. | Explicit authorized confirmation of the actual no-call/no-show, not appointment-time passage or missing completion. Exclude ordinary cancellation/advance contact from this classification. |
| Owner exception | Chloe may manually book an exceptional case. | Manual booking does not clear the restriction. Audit the exception; preserve other clinical/scheduling checks. |
| Incorrect no-show / protected need | Support explicit owner correction and a private accommodation/review path. | Correction and exception are distinct records. No cross-clinic blacklist, automatic punishment of ambiguous identity or assertion of legal compliance from code. |
| Client identity / scope | Restriction belongs to the clinic’s authoritative client/person identity. | Do not use unverified browser email alone, leak blocked-person status or treat a shared phone as sufficient proof. Known limitations require explicit disclosure. |
| Existing treatment clients | Preserve unrelated treatment booking/cancellation/rescheduling semantics. | Use a canonical first-consultation classification, not a service-name string guess or blanket ban on every reschedule. |

### 14.5.7D Work packages and explicit authorizations

| **Delivery unit** | **Assigned output** | **State / boundaries** |
| --- | --- | --- |
| WAIT-04A / profile and join | Typed fields/validation, mobile-accessible join/profile presentation, canonical areas and consent model; reuse the shipped availability/manual/legacy-entry authority. | **PARTIAL FOUNDATION SHIPPED.** #712 made availability/manual/legacy commands reachable; richer profile components/contracts exist but remain dormant until WAIT-04B supplies durable authority and privacy changes atomically. |
| WAIT-04B / policy authority | Persist/bind the complete prospect profile; preserve legacy priority/provenance; completion capability; verified-mobile authority; prospect STOP/suppression integration; response/deadline/reminder and first-consult policy records as required. | **NOW — TOP ACTIVE BUILD.** Derive migration need/number fresh; never edit applied history. Split into bounded children rather than one giant migration/PR. Privacy wording changes in the same release that starts collecting the richer fields. |
| WAIT-04C / dual-channel delivery | Consent-aware email + eligible SMS as one opportunity, per-channel delivery truth, WAIT-specific 24-hour reminder, retry/UNKNOWN handling and safe timeout inputs. | **NEXT INSIDE LEVEL 3.** Requires verified prospect mobile + STOP and a supported product-operable Willow sender lifecycle. #749 status visibility is only the first product surface; #716 routing remains held until sender activation is proven end to end. |
| WAIT-04D / response UX | Four client choices, consequence copy, policy acknowledgement, contact/profile completion and truthful practitioner outcomes; **remove the expiry selector and enforce the frozen 48-hour policy**. | **NEXT INSIDE LEVEL 3.** Book/Decline already exist in the core; add the accepted keep-place/update-availability/remove taxonomy against the matching authority, remove practitioner TTL choice, then prove real-device Chloe acceptance. |
| WAIT-FORECAST-01 / ADMIT-01 | Record inputs/events now; later calibrated estimate of time to invitation. | LATER / no estimator implementation authorized as a launch blocker. No AI probability or fixed-date claim from a two-and-a-half-week anecdotal sample. |

### 14.5.7E Bounded decisions still needed inside implementation

The product intent is frozen; the following are technical/activation decisions, not a request for another product-discovery phase. They must be recorded and tested before enabling the affected behavior.

| **Seam** | **Why it cannot be guessed** |
| --- | --- |
| 48-hour clock + delivery threshold | The session used both “sent” and “delivered/accepted” wording. Provider acceptance does not prove inbox visibility. Specify the deadline anchor, eligibility evidence, bounce/failure treatment and delayed-send handling together; do not silently shorten the promised response opportunity or auto-remove on UNKNOWN. |
| 24-hour reminder + raw-token-once | The current stack cannot reconstruct a token from its hash, and #680 has no durable general reminder subsystem. Choose a reviewed bounded reminder/link/recovery design that preserves one opportunity, deadline and credential policy. Do not persist plaintext secrets or mint a new offer just to make a reminder work. |
| SMS sender / routing | The request for dual visibility does not activate a sender. Revalidate the actual live SMS path, consent/STOP coverage and sender ownership before choosing reuse or cutover. #674 remains held even though its file is renumbered. |
| Queue-priority semantics | Preserve original waiting-time priority for unsuitable times/preferences, but do not promise an absolute ordinal across availability/service matching. Cancellation requires a new cycle with history retained; true re-entry and duplicate-active rules must be proved. |
| Legacy activation / policy version | Choose an effective date, notice/acknowledgement and existing-offer/appointment compatibility behavior. Do not retroactively apply the new no-response or consultation penalties from old reminder timestamps. |
| Restrictions, retention and public wording | Permanent self-service denial is the accepted product rule; identity matching, correction/exception permissions, retention/export disposition and accommodation/legal review remain explicit. Permanent restriction is not permission to retain all client data forever. |
| Profile correction / recipient binding | Contact changes after an invitation is issued must not redirect a code to a new unverified recipient or leave stale capability authority alive. Reuse reviewed binding/reissue semantics; incomplete legacy data cannot manufacture identity. |

<a id="hone_s_14_5_8"></a>
## 14.5.8 Wait-time forecasting — instrument now, estimate later

Accepted direction: estimate “time until an invitation to book a consultation,” not “time until treatment begins.” Consultation capacity, opportunity timing, client availability and recurring treatment demand are separate quantities. The estimate is a planned product capability; no algorithm, trained model, calibrated probability or current Willow wait range is established. [S19]

| **Forecast layer** | **Inputs / output** | **Evidence before customer display** |
| --- | --- | --- |
| Before consultation: access | Queue age/eligibility; weekdays/weekends/both; real consultation release capacity; outstanding offers; booked, unsuitable-time, leave and no-response outcomes. Output: a range to invitation. | Known cohort and observation window; cold-start/insufficient-history state; validation against later invitation dates. No exact queue number, fixed date or unsupported confidence level. |
| After consultation: treatment impact | Practitioner assessment of session length/cadence and mature observed history, matched against future bookings. Output: residual recurring demand and potential capacity impact. | No guessed treatment hours from body area alone; no counting cadence-implied hours twice on top of already-booked hours. Preserve ADMIT-01/REBOOK-01 authority. |
| Operator planning | Waiting count/age, matching demand, offered capacity, response/consult conversion, cancellations and actual throughput. | Display descriptive facts separately from modeled scenarios. An estimated conversion rate does not authorize more than the owner’s bounded N invitations. |
| Client experience | Range and last-updated context when validated; otherwise a clear “not enough information to estimate yet.” | Example ranges/probabilities in this chat were illustrative, not computed from Willow. Do not promote them to a saved estimate or business claim. |

Record versioned event times for joined, profile completed, invitation issued, per-channel queued/accepted/delivered/failed/suppressed, reminder, response, booked, consult cancellation/re-entry and confirmed no-show restriction/correction. Event identity and duplicate prevention matter more than adding a chart. Automatic invitation release remains ADMIT-03 and stays behind assisted-mode production evidence. [S19]

<a id="hone_s_14_5_9"></a>
## 14.5.9 Final acceptance matrix — the release is the journey

**Current v1.16 canary checkpoint:** the controlled test studio has passed the **complete twelve-seam journey** — public join, owner durable queue, capacity opening and re-read, invitation, translated practitioner outcome, delivery result, recipient proof, scoped eligible slots, booking, atomic conversion, reload truth, and the fail-closed refusal on exhausted capacity. The `no_admission_round` gap is repaired and post-canary cleanup is complete. **No row below is waived by that pass:** the run used a synthetic identity on a controlled studio with no provider send, so real email/SMS delivery, consent/STOP and Chloe device acceptance still need their own evidence before any Willow durable migration. [S42]

| **Scenario** | **Required evidence / pass condition** |
| --- | --- |
| New join | Valid first/last/email/mobile/areas/preference accepted; missing/invalid fields and arbitrary area strings refused server-side. No free-text urgency path. SMS consent false remains false. |
| Legacy completion | Email-only prospect completes safely and retains original queue history/priority; no invented contact fields or accidental new-client duplication. |
| Practitioner invitation | Invite to book → service/date/day selection → fixed 48-hour policy → send. No Claim, Claim next or Reinvite; failed issuance leaves no partial hidden claim. |
| Email + SMS | One opportunity, eligible channels only; correct clinic sender identity, STOP/suppression respected, separate outcomes, no duplicate send on retry. No raw credential in logs/analytics/idempotency digests. |
| Recipient proof | Link alone cannot book/decline or mutate queue; proof delivered through the bound recipient channel; expired/cross-invitation capability refused and recovery is truthful. Secret/code/id not returned in browser state. |
| Availability / phone | Complete authorized range is reachable through bounded retrieval; day 22+ and final authorized day tested; out-of-scope absent/refused; stored phone server-only, missing-phone input satisfiable; timezone/DST stable. |
| Book outcomes | One appointment at most; distinguish confirmed booking, consumed-without-booking and indeterminate operation. No false “already booked”/confirmation copy; operator recovery tested. |
| Alternative responses | Times do not work and availability update both close current offer and preserve priority; leave stops waitlist contact; old link cannot mutate a newer opportunity. |
| Reminder / deadline | 24-hour reminder deduped and suppressed after response. 48-hour removal uses post-lock time and accepted evidence rule; failed/unknown delivery and concurrent book/respond do not punish the client. |
| Consultation cancellation | Public reschedule unavailable through every relevant route; cancel-and-return creates linked new waiting cycle only after confirmation. Clinic-approved move no penalty; ordinary treatment behavior unchanged. |
| No-call/no-show | Explicit confirmed first-consultation event creates permanent clinic restriction; no auto-expiry; automated invitation/public-booking bypass refused; manual owner exception works without clearing it; correction audited. |
| Authority / races | Tenant, actor, grants, read failure, lifecycle/expiry/redeem/booking and lock-order races proved on the numbered chain. Negative controls reproduce each protected failure class. |
| Release acceptance | Exact assembled SHA/base, executed CI lanes, independent review, hosted migration verification, real deployment, approved canary, rollback/kill-switch proof and Chloe device acceptance. Component-unit tests alone do not mark this DONE. |

Build against fake email/SMS transports and isolated fixtures first. Real handset/mailbox canaries require a separately approved recipient and provider action. Refresh mutable facts at the release boundary; do not reopen unrelated code once the integrated contract is stable. The next product order is defined only by §23.6. FIN-02 is parallel preparation, not the immediate default successor to WAIT. Forecasting and general automation are not WAIT-launch prerequisites. [S18, S19, S31, S33]

<a id="hone_s_14_6"></a>
## 14.6 Explicit Chloe asks restored to roadmap

| **ID** | **Ask / capability** | **Risk** | **Definition of done** |
| --- | --- | --- | --- |
| DENSITY-01 | Desktop density | T1 | Wide-capable shell ~1440-1600px; wide Calendar/Dashboard/Clients/Records/analytics; forms/settings/intake/consent/narrative stay readable. Ideal migration-slot filler. |
| RECORDS-01 | Disinfectant To-do | T1/T2 | Due/overdue disinfectant enters canonical To-do with Records action; replacement/discard resolves. Do not rebuild sterile discard. |
| SEARCH-02A | Search V2-B projections | T2 | Authorized clinical/operational search projection/index model; no permission widening. |
| SEARCH-02B | Search V2-B UI | T1/T2 | Clients, appointments, services, practitioners, treatment areas/settings, MultiPlex, probes/lots, notes, records, consent/notifications as authorized. |
| CANCEL-CUTOFF-01 | Self-cancellation cutoff | T3 | Per-studio default OFF policy (e.g. 24h); calm client copy; staff can still cancel; server/DB authoritative. Not Cancellation Recovery. |
| PAY-REFUND-01 | Partial refund ledger | T4 | Still OPEN. Multiple refund events, original/total/remaining refundable, reason/operator/time, Stripe reconciliation, history and over-refund protection. The Aug 24 audit confirmed partial refunds were not implemented at its head; v1.8 does not claim otherwise. |
| FIN-01 | Owner Financials parent | T2/T4 | Keep the existing owner Financials/appointment spine. #652 is merged copy truth, not earnings arithmetic. The delivery destination is FIN-02A/B under #672’s domain/snapshot contract; #666 is held. Preserve separated provider, attested, service-value, outstanding, waived and UNKNOWN authorities. [S8, S16] |
| FIN-01A | Money by day/week/month/custom range | T2/T4 | Original Chloe outcome preserved. Complete through FIN-02A/B, not another independently timed application loader. Existing appointment labels and temporal split remain baseline; no complete earnings claim until evidence and acceptance permit it. [S8, S16] |
| HEALTH-01 | Practice/Book Health | T2 | After Closeout/Rebooking/Financials metric contracts: future booked weeks, capacity/utilization, rebooking, due clients, unresolved closeout, cancellations, collections; no fake AI score. |
| CANCEL-RECOVERY-01 | Cancellation recovery model | T2/T3 | Released capacity -> eligible due clients -> offer/claim/rebook attribution model. |
| CANCEL-RECOVERY-02 | Recovery workflow + measurement | T2/T3 | Offer, claim, rebook; recovered hours/value measured truthfully. |
| DASH-FAST-01 | Current-client Dashboard actions | T1/T2 | Current appointment highlight uses one render-time clock; Consultation notes navigates to canonical writer; card-on-file shows CARD ON FILE / NO CARD / UNAVAILABLE from one batch read; portal link is offered only on trusted no-card state. Current delivery vehicle: #598. |
| DASH-FLOW-01 | Inline treatment expand | T1 | View full treatment expands in place on the Dashboard instead of navigating away; the earlier expanding-details question is resolved with Chloe on-device and recorded in ACCEPT-001. |
| TODO-CLEAN-01 | To-do widget truth | T1 | Plan-next-session pseudo-task suppressed; real Show N more / Show less expansion; completed booking-page and getting-started cards removed; the Prepare card at zero is explained or removed. Adjudicate against PR #572 in ACCEPT-001; re-home here if unmerged. |
| FREE-CONSULT-01 | Zero-amount service truth | T2 | Zero-amount services resolve to a discriminated free state showing no payment required; Prepare/Run charge structurally unreachable; ambiguous price fails closed. Adjudicate against PR #572 in ACCEPT-001. |
| FEEDBACK-01 | Pilot feedback routing | T1/T2 | In-app feedback button routes to a real intake destination per Section 17 feedback objects, not direct email to Sam; sender gets acknowledgment; entries triaged like any interrupt class. |
| PROBE-02 | Probe lot/batch auto-fill | T1/T2 | Probe lot/batch carries forward from the prior session as a confirm-not-assume prefill; auditable; never silently copied into a finalized record. |
| CARD-REMIND-01 | One-click card reminder | T2/T3 | From a trusted Dashboard no-card state, one click sends a calm card-on-file request email through the existing transport; per-client rate limit; consent-aware; logged without PII; no payment detail in the email. |
| UNCOLLECTED-01 | Uncharged-visit detection | T1/T2 | Completed appointment with non-zero authoritative service value, no succeeded provider-verified card money and no resolving appointment_settlement should surface as unresolved payment work until charged or settled. Deterministic join, no AI guessing. PAY-SETTLE states (cash/e-transfer/other/waived/still owes) must prevent false alarms and preserve still-owed as unresolved. |
| PAY-EXTERNAL-01 | External payment / settlement recording - CLOSED_EVIDENCED via PAY-SETTLE | T3/T4 - DONE | Delivered through #636 + migration 0187 and production-smoked. Append-only appointment_settlements records paid_cash, paid_e_transfer, paid_other_external, waived and still_owes with actor/time, amount and independent quoted_amount snapshot; owner-only corrections preserve originals. No fake Stripe mutation. Production smoke: paid_cash 1000 vs quoted snapshot 1234, zero payment attempts. External-payment refund semantics remain out of scope; PAY-REFUND-01 still owns partial/provider refund ledger work. |
| DASH-DAY-01 | Selected-day Dashboard navigation | T1/T2 | Previous / Today / Next changes the one-day briefing through canonical server-rendered day state, preserves Calendar handoff and mobile tap stability, and never repurposes real-today authorities. Shipped by #606. |
| DASH-PREP-01 | Selected-day full prep parity | T2 | Tomorrow/future rows preserve the useful Today prep categories, but the delivery vehicle must consume HIST-01 exact answers. #608 and #611 are retired; #613 is stopped unmerged after seven P1s. Next implementation starts fresh from current production with no bounded-window absence/latest inference, no null collapse of unavailable, and canonical exact detail on demand. |
| PERF-UX-01 | Slow-click / interaction latency | T1/T3 | Preserve the historical #612 merged/production-remeasured result and PERF-03 measured ladder. Do not reuse an earlier “unmerged” statement. Current whole-app speed and feature-flag state must be measured again before new claims. UI acknowledgment cannot fabricate backend progress. |
| UI-V2-01 | Practitioner UI V2 | T1/T2 | Use the live #609 Hone-owned foundation. Canonical sequence: UI-01 perceived-speed floor -> UI-02 foundation/accessibility adoption -> UI-03 Dashboard presentation after Prep V2 -> UI-04 Charting -> UI-05 Client Profile -> UI-06 Calendar polish. Preserve clinical density and Server Components; no external UI framework or motion runtime. |

<a id="hone_s_14_6_1"></a>
### 14.6.1 Chloe 7 September evening batch - Work Plan v3 Priority 3

Source: the recorded 9:30 PM session (§17.7). These rows are the third block of the immediate execution list (§23.6). Order inside the batch: bugs first (DASH-NOTE-01/02), then friction (FLOW-03 checkout, RECORDS-01 action, NOTIF-PREFS-01), then features (CLIENT-STATUS-01, BOOK-PRIVACY-01). One PR per item; migration-first wherever a column is added; Chloe on-device acceptance per item recorded in ACCEPT-001. None of these takes a production slot ahead of WAIT and MPX. [S31]

| **ID** | **Ask / capability** | **Risk** | **Definition of done** |
| --- | --- | --- | --- |
| DASH-NOTE-01 | Pinned notes truncated on the Dashboard day view | T1 | Full pinned-note text on the day view, or expand-in-place. A long pinned note is fully readable without navigating away. She pins notes specifically to see the whole thing. |
| DASH-NOTE-02 | Last-session note replaced by today's note after charting | T1/T2 | The note shown against an appointment is the latest note from before that appointment, excluding the appointment's own session, and it stays until the client's next appointment. This is the HIST-01 latest-watch/plan-note-before-cutoff question; the fix is in the read, not the display. Decide narrow read fix vs HIST-01 re-entry; either way no bounded-window absence inference and no null collapse of UNAVAILABLE. |
| FLOW-03 (checkout) | Checkout is about ten clicks with about a minute of client wait (carried from the August backlog) | T2/T4 | Audit and count the current click path on Chloe's device before any redesign; agree the reduced path with Chloe; record the new count. Reuse the PAY-SETTLE (#636 / 0187) outcomes card, cash, e-transfer, waived, still-owed; no weakened confirmation. |
| RECORDS-01 (action) | Overdue disinfection notification resolves in one flow | T1/T2 | From the notification: "Did you replace this?" → Yes → pick date → logbook entry filled in. Logbook write under explicit per-command RLS policies; no FOR ALL, no FOR DELETE on logbook records. Do not rebuild sterile discard. |
| NOTIF-PREFS-01 | Per-type notification toggles | T1/T2 | Enumerate the current notification catalogue; every type (card added, card changed, birthdays, waitlist joins, maintenance overdue, others found in the census) can be switched off per user and stays off. Per-user, not per-studio, as Chloe framed it. |
| CLIENT-STATUS-01 | Client status buckets | T2/T3 | Active / Paused / Completed / Archived, manually assigned. Paused = client said they may continue later; Completed = treatment finished, may return for touch-ups. Migration (status column or enum), clients-list filter, manual set on the client profile. Foundation for BULK-MSG-01. |
| BOOK-PRIVACY-01 | Public booking link exposes schedule density | T2/T3 | A client using the booking link cannot infer how full or empty the calendar is, and Chloe stops blocking dummy slots to look busy. Same scoped-horizon / limited-slot-exposure mechanism as WAIT-03; decide whether existing clients rebooking get the same scoped view. Server / DB authoritative; ordinary booking correctness unchanged. |
| BULK-MSG-01 - DEFERRED | Email or SMS all clients in a selected bucket | T3 | Deferred by Chloe. Her examples: leave notice to Active; review requests to Completed; "want to continue?" check-ins to Paused. Depends on CLIENT-STATUS-01 and the COMMS lanes; consent-aware; email-first. Not generic marketing automation (§21). |
| WAIT-INTAKE-01 - OPEN | Interest level at waitlist join | T1/T2 | Open decision (§0.7). If added to WAIT-04A: required structured select (ready to start now / curious with questions / had electrolysis before), filterable in the owner waitlist view, no free text, no demographic field, joined_at untouched. If dropped, record the drop in ACCEPT-001 so it is not re-raised as a gap. |

<a id="hone_s_14_7"></a>
## 14.7 Interaction Speed, UI V2 and Engineering Experience

PRODUCT RULE  Perceived polish does not outrank clinical truth. Speed work is measured before optimization; UI work centralizes repeated interaction contracts before surface redesign; practitioner information density is an asset, not clutter to delete.

| **ID** | **Capability** | **Risk** | **Definition of done** |
| --- | --- | --- | --- |
| UI-00 | Hone UI foundations - DONE / live | T1 | #609 merged/deployed. Semantic tokens plus Button, SectionLabel, StatusPill, Field/FieldLabel and Skeleton; 44px touch floor, focus-visible, press/pending and reduced-motion contracts; no new dependencies and no primitive forces a Client Component. |
| PERF-00 | Authenticated route timing baseline - DONE / measured | T3 | #610 merged/deployed and supplied the before-window. The corrected comparison used 38 baseline client-profile.domain samples: p50 584 ms, p75 654 and p95 698. Instrumentation is dark after the completed post-#612 window; any future sampling still requires operational revalidation. |
| PERF-01A | Authenticated shell single-resolution - PRESERVED / PARKED | T3 | Historical local/recon status is preserved, not revalidated as running work. Activate only when scheduled under §23. Mechanically trace /dashboard, /clients, /clients/[id], /calendar and /records and eliminate duplicate auth.getUser / active-membership resolution inside one request when safe. Target <=1 physical auth user call and <=1 active-membership SELECT per normal authenticated request, request-scoped only; no global/cross-request tenant cache. Local implementation/recon only until independently proved. |
| PERF-01B | Dashboard waterfall collapse - PRESERVED / PARKED | T2 | Historical local/recon status is preserved, not revalidated as running work. Activate only when scheduled under §23. Map every Dashboard server read by dependency, serial wave, round-trip count, above-fold necessity and actual use. Remove zero-value reads, start true independents together and define the smallest truthful critical render path. No code mutation until the current waterfall is mechanically derived. |
| PERF-01C | First-useful-paint / streaming architecture - PRESERVED / PARKED | T2 | Historical local/recon status is preserved, not revalidated as running work. Activate only when scheduled under §23. Design Server Component/Suspense boundaries so shell -> appointment roster -> critical clinical prep can arrive before lower-priority business/admin/assistant cards. Avoid spinner soup, layout shifts and false clinical/payment progress. Implementation follows evidence from PERF-01B. |
| PERF-02 | Client Profile read decomposition - DONE / #612 | T2 | #612 merged/deployed as 69d9f36f. Post-merge production remeasure: p50 244 ms, p75 310, p95 432 vs baseline 584/654/698 (N=38 each; one 892 ms likely cold-start outlier; post set all Overview). Runtime improvement supported. Static completeness-proof machinery remains retired. |
| PERF-03 | Client Profile remaining-wave census + 8 -> 2-3 collapse - NEXT | T2 | Client Profile-specific measured ladder remains valid after #612, but it is no longer the only speed workstream. Preserve its remaining-wave census/2-3-wave target and production measurement discipline while PERF-01A/B/C address whole-app shell and Dashboard pain. |
| PERF-04 | Client Profile DB aggregation / query shape / indexes | T2/T3 | Only after PERF-03 timing proves remaining multi-table round trips dominate. Prefer a database-owned aggregate/RPC or equivalent exact query for expensive joined summaries; then EXPLAIN ANALYZE the slow queries and add only compound indexes matching real filters/order. Audit wide select(*) payloads after larger latency sources. No broad index spray or clinical latest/last cache. |
| PERF-05 | Public-route middleware / static-delivery audit | T2/T3 | Separate from authenticated Client Profile work. Verify whether public/static routes pay unnecessary auth.getUser or other authenticated middleware costs before route classification. Preserve auth/non-enumeration/security semantics; optimize only from measured public-route evidence. Do not reframe the authenticated practitioner app as a static site. |
| UI-01 | Perceived-speed floor - PARTIAL SHIPPED | T1/T2 | #649 UI-01D shipped truthful Client Profile tab acknowledgement without disabling unrelated tabs or dropping focus. #651 UI-01E shipped >=44x44 geometry/hit targets for 12 confirmed navigation links. Route-level/loading and remaining interaction families continue; no animation may disguise backend latency. |
| UI-02 | Foundation adoption + accessibility floor - ACTIVE NEXT | T1/T2 | #609 remains the foundation. #651 closed one navigation-target class, and #667 is now merged for thirteen Client Profile touch/focus controls. Remaining disclosure/toggle and other adoption families, mobile-safe fields, focus-visible and non-color-only status stay open; real iPhone/iPad/assistive-tech acceptance remains required. [S21] |
| UI-03 | Dashboard V2 presentation | T1/T2 | After selected-day Prep V2 truth settles: keep the one-day briefing and all meaningful clinical facts, reduce dead whitespace/action competition, establish one clear primary row action and quiet secondary actions, mobile-first. Presentation only; do not redesign clinical authority. |
| UI-04 | Charting V2 | T1/T2 | Reduce treatment-room click cost, fix keyboard/accessibility and save/field interaction debt, keep previous-treatment context nearby, and preserve all existing clinical write contracts. No decorative motion project. |
| UI-05 | Client Profile V2 | T1/T2 | Clarify Who is this / What should I know / What happened last / What needs attention / What next. Reduce duplicated navigation and expensive transitions while keeping clinical ownership and deep-link behavior intact. |
| UI-06 | Calendar polish | T1/T2 | Polish rather than rewrite: event hierarchy, status/service encoding, mobile continuity, accessibility and handoff from selected-day Dashboard. Preserve existing rebuilt mobile calendar authority and scheduling semantics. |
| TEST-PORT-01 | Parallel worktree browser isolation - DONE / #615 | T1 | #615 merged as 6fe93ccf. Local worktrees derive bounded candidate app ports and Playwright never reuses an already-running Hone server; occupied ports fail loudly. CI stays pinned to 3111. Shared Supabase/Postgres/Mailpit remain an explicit limitation; concurrent local db resets are inadmissible. |

<a id="hone_s_14_7_1"></a>
### 14.7.1 UI reference and dependency policy - v1.9

HARD CONSTRAINT: Hone-owned clinical truth, data minimization, Server Component boundaries, 44px/focus/mobile rules and #609 tokens/primitives outrank every external reference.

KEEP ACTIVE: WAI-ARIA APG for interaction semantics; Next.js documentation for loading/prefetch/rendering mechanics; Hone's own shipped precedents; real healthcare-product precedent such as Jane App public practitioner help material.

TABLER: no package migration now. If future icon inconsistency becomes a real usability problem, use a small local components/ui/icon.tsx with hand-picked MIT-licensed SVG paths and keep package.json untouched unless separately justified.

DISCOVERY/BOOKMARK ONLY: Watermelon and Shoogle. Shoogle MCP is real, but Hone is not a shadcn codebase and the current payoff does not justify installation. Mobbin MCP requires paid access and produced no usable reference evidence in this recon.

DROP FROM ACTIVE ROADMAP: 10x (native-app generator; no native track), Swishy (motion asset generator, not interaction authority), Componentry, Unlumen, Skiper, Cult, Blockus, Wensity and Macro. Haikei remains asset-only and must have licensing verified before any shipped commercial asset.

BKLIT: remove from commercial implementation planning. The top-level project license verified as CC BY-NC 4.0 / noncommercial. bklit-ui has different licensing, but the chart stack/dependency maturity does not justify adoption. Use a boring stable chart solution only when an actual metric proves a chart is better than a number/table.

MOTION RUNTIME: Motion/Framer Motion is not authorized. Simple opacity/transform/height/press/disclosure behavior belongs in Hone CSS and must respect reduced-motion.

EMIL KOWALSKI DESIGN SKILLS: #639 is MERGED as development-only tooling and vendors six reviewed/patched skills. They are agent guidance, not runtime dependencies or product authority. Hone-owned clinical truth, #609 primitives, WAI-ARIA/Next.js semantics and reduced-motion/accessibility rules outrank every skill suggestion.

APPLE DESIGN (OPERATOR-LOCAL): ~/.claude/skills/apple-design/SKILL.md is installed globally on hone-dev-01 for Claude Code. It is not in Hone's skills-lock.json or repository tree at this checkpoint. Use it as guidance for response, interruptibility, spatial consistency and restraint; never let it authorize a package/runtime change or conceal measured backend latency.

DEVELOPER-PLATFORM FOLLOW-THROUGH: retain these Apple/Emil constraints while codifying one Hone-owned DESIGN.md and the selected engineering skills. Status, scope and acceptance are maintained in §16.6; supporting rollout order is §23.7. This is not a second UI framework or permission to adopt new runtime dependencies. [S35, S36]

<a id="hone_s_14_7_2"></a>
### 14.7.2 Client Profile performance ladder - measured order of attack

EVIDENCE FIRST: #612 is now production-validated. Corrected before/after client-profile.domain comparison is p50 584 -> 244 ms, p75 654 -> 310 ms and p95 698 -> 432 ms (N=38 each). One isolated 892 ms post sample likely reflects cold start; the post set was entirely Overview. This is production evidence, not a prediction.

ORDER OF ATTACK: #612 release is complete -> PERF-03 remaining-wave timing/collapse -> PERF-04 database aggregation/query-shape/index work only if timing says it is needed -> UI streaming/pending improvements in parallel. Public-route middleware remains a separate audit.

PLANNING TARGETS, NOT PROMISES: a production Client Profile p50 under ~250 ms is a strong target; ~150-200 ms is a stretch. Earlier 400-500 ms and 250-350 ms bands were planning estimates for intermediate stages, not acceptance thresholds.

CACHING RULE: stable studio config/feature metadata may be candidates later. Clinical latest/last/history state is not a broad-cache target; correctness, invalidation and authority must be explicit first.

PERCEIVED SPEED: render/acknowledge the useful shell as early as truthfully possible, then stream secondary cards where Next.js boundaries make sense. Immediate feedback may not fabricate clinical/payment/booking progress.

<a id="hone_s_14_8"></a>
## 14.8 FIN-02 — coherent financial authority, then the interface

FIN-01/FIN-01A retain the owner’s original question: how much money did the practice make, by studio-local day, week, month or custom period? FIN-02 is the replacement implementation path accepted in merged #672. Existing Business navigation and the Financials spine are reusable baseline; the unmerged #666 Business hub/UI is a prototype, not automatically production capability. [S8, S16]

| **Unit** | **Contract** | **Definition of done** |
| --- | --- | --- |
| FIN-02A | One shared database snapshot under invoker rights/RLS, returning all relevant inputs and the statement-consistent instant plus studio-local snapshot date. | Real DB concurrency/fault/tenant tests establish shared visibility. Several READ COMMITTED statements do not become one snapshot merely by being in a transaction. |
| FIN-02B | Adapt the reusable financial model and UI to that authority; no fallback to independently timed reads. | All derived consumers use the same returned inputs/date. UNKNOWN remains contagious; owner-only routes and real owner acceptance are proved. |
| Pricing / privileges | Preserve the 0187 pricing law and frozen settlement quote precedence. Reuse the existing TypeScript resolver over shared-snapshot inputs where specified. | No EXECUTE grant to expose the privileged quote helper, no definer-rights shortcut, no separate application clock for price eligibility; parity tests cover any additional expression. |
| Money vocabulary | Provider-verified movement, collected-on-delivered work, studio-attested settlement and service value remain distinct evidence classes. | Refunds, still-owed precedence, fully-refunded state, undated/ambiguous evidence and missing collection data cannot become false paid, zero, earnings or complete totals. |

Authoritative detailed design: docs/product/financials-domain-contract.md at the production revision in §3. This roadmap summarizes rather than replaces its result vocabulary, oracle map, pricing precedence or snapshot rules. FIN migration numbering remains unallocated by this document. [S8]

<a id="hone_s_14_8_1"></a>
### 14.8.1 September 7 local FIN progress and preserved handoff

OPERATOR_REPORTED: FIN-02A/FIN-02B candidate work and an independent review were reported locally. The screenshot named ef191600 as a review candidate and /home/sam/hone-handoffs/FIN02_RESUME.md with FIN02A_CANDIDATE.md, FIN02B_CANDIDATE.md and FIN02_INDEPENDENT_REVIEW.md. This document did not read those local files, run their tests or establish a pushed replacement FIN PR. Preserve them before clearing any pane. [S19, S29]

The reported review found a reachable model defect and missing guard against landing consumers before the snapshot authority; it also called for non-vacuous consultation-completeness and ambiguous-quote tests. These are carried review inputs, not a new current severity census. A master-control file census also reported tests/app/financials/financials-truth.test.ts shared with the WAIT train, superseding the earlier “fully disjoint” claim. Recheck this overlap before integration. [S19]

FIN remains FIN-02A → FIN-02B → integrated owner acceptance → serialized release. No numbered FIN migration is allocated here. No stale #666 multi-read loader, granted privileged pricing helper or independent application clock may bypass the accepted shared-snapshot contract. Local preparation may continue only when it does not disrupt WAIT-owned files or shared resources.

<a id="hone_s_14_9"></a>
## 14.9 Visual Treatment Memory - post-WAIT product experiment

**Position. **Recorded as a post-WAIT product experiment, not a ninth engineering train. No vgpu in package.json today. After the WAIT train releases, one pane may take a short R&D spike with no production dependency; vgpu must prove it produces something meaningfully better than React / Canvas before it is adopted. The feature is the product idea; vgpu is one possible implementation technology. Do not conflate them. [S31]

**Concept. **Connect what was done (settings, timing, modality, area, session history, tolerance) with what it looked like (treatment photos over time). Booking software shows an appointment history; a treatment-memory product shows how treatment evolved, and it gets more valuable as longitudinal data accumulates. Target shape on an area click: LEFT CHIN → first treated, last treated, sessions, treatment time → recent approach (modality, timing, intensity) → pattern (tolerance change, intensity trend, settings stability) → photo timeline → compare first vs latest → open history.

**Facts checked 7 September. **Production is Next.js 15.5.22 + React 19 + TypeScript with Sharp 0.35.3 already in the image pipeline; the clinical primitives exist (session_block_areas, treatment_images). vgpu is Vercel Labs' TypeScript WebGPU library (browser + headless Node + deterministic mock testing, WGSL tooling), npm 0.4.0, published very recently: an experimental dependency. [S31]

| **ID** | **Capability** | **Risk** | **Definition of done** |
| --- | --- | --- | --- |
| VISUAL-01 | Treatment Memory Map - P2 product experiment | T1/T2 | React + SVG, no new graphics dependency. Face / body outline, clickable regions, heat intensity by minutes, session count, last treatment, laterality, tooltip / details, timeline filters, all from existing structured areas and treatment history. SVG gives accessibility, selectable regions, labels, keyboard control, print / PDF friendliness and easy browser testing. Done when Chloe can click an area on a client's map and see sessions, treatment time, last treated and recent settings from existing data, and her usage has been observed. Gate before VISUAL-02: validate that Chloe actually uses it. |
| VISUAL-02 | Longitudinal Photo Compare - P2 / high-upside R&D | T2 | Isolated vgpu / WebGPU experiment: synchronized before / after, overlay, opacity / flicker, synchronized pan / zoom, image registration previews, difference heatmaps, masks. Progressive enhancement only; this is where shader rendering gives something materially better than DOM / SVG. Adoption requires the spike to prove that advantage. |
| VISUAL-03 | Visual Treatment Intelligence - later | T3 | Registration assistance, difference maps, longitudinal overlays, assisted comparisons, possible on-device image analysis. Not scheduled. |

**Constraints (frozen). **

WebGPU is disposable from the user's perspective. Supported → enhanced comparison. Absent, device lost or render error → normal image comparison. Never → client profile unavailable. WebGPU is limited availability, not Baseline, so no browser or device can be assumed to expose it.

No clinical truth depends on GPU output. A shader visualizes data; it is never the authority for treatment history, settings, areas, image provenance or clinical records.

The image boundary stays permanently: untrusted upload → existing Hone validation / security → Sharp sanitization → private storage → authorized signed image → optional visualization layer.

No fake precision. A difference map says "visual comparison". It never says "hair reduction: 31.8%" unless a measurement system is built and clinically validated to deserve that claim.

Wording: vgpu provides rendering and compute primitives that could make real-time image and visualization experiences practical. Hone builds the photo comparison and treatment visualization itself.

Library selection is judged on footprint, TypeScript fit, shader ergonomics, testing, browser / Node consistency, performance, fallback story and maintenance risk. Agent / MCP tooling is not a reason to choose it.

<a id="hone_s_15"></a>
# 15. SaaS Platform and Activation Program

| **ID** | **Program** | **Risk** | **Definition of done** |
| --- | --- | --- | --- |
| STUDIO-01 | Studio create/provision/configure lifecycle | T3 | Create studio, provision owner, configure core settings with server-owned authority. |
| STUDIO-02 | Invites/roles/ownership transfer | T3 | Invite staff, role changes, ownership transfer with audit and tenant-boundary tests. |
| STUDIO-03 | Suspend/close/export/provider disconnect | T4 | Operational lifecycle integrated with export/offboarding and provider state. |
| STUDIO-04 | Tenant-boundary matrix | T3 | Cross-subsystem tenant isolation matrix continuously tested. |
| PRACT-01 | Public Any Available + practitioner choice | T2/T3 | Public choice without weakening service/practitioner eligibility. |
| PRACT-02 | Eligibility + practitioner availability | T2 | Per-service eligibility and practitioner-specific availability. |
| PRACT-03 | Calendar lanes + practitioner Today/To-do | T2 | Practitioner-specific operational views; owner can see whole studio appropriately. |
| PRACT-04 | Controlled multi-practitioner production pilot | T4a | Real supervised pilot with monitoring and rollback. |
| GOOGLE-01 | Hone -> Google lifecycle | T3/T4a | Connection, calendar selection, reconnect, per-studio activation, mapping, retry/reconciliation, dead-letter visibility, disconnect. |
| GOOGLE-02 | Google busy import | T3 | External Google event -> busy interval only. Never invent a Hone appointment. |
| SMS-01 | Delivery truth and retry lifecycle | T3 | Provider callbacks, delivery state, retry/exhaustion, ops visibility. |
| SMS-02 | Per-studio config and cost/rate protection | T3/T4a | Consent/STOP, per-studio enablement, limits and cost breaker. |
| ONBOARD-01 | Owner signup + studio creation | T2/T3 | Low-touch identity-to-studio path. |
| ONBOARD-02 | Services/hours/providers/staff readiness | T2 | Guided readiness without Dashboard clutter. |
| ONBOARD-03 | Billing + activation state | T4 | Truthful subscription/activation model once commercial billing exists. |
| BILL-00 | Design-partner charging mechanics | T2 | Decide and document DP charging: manual Stripe invoice or payment link, founding price honored or marketing site corrected via the truth register, cancellation/refund terms consistent with TRUTH-01A. No subscription automation; ONBOARD-03 remains the Gate C billing system. Prerequisite for onboarding partner 1 as paid. |
| ONBOARD-04 | Launch without Sam proof | T2/T3 | A new studio reaches live without hidden founder-only routine steps. |
| WAIT-SAAS-01 | Per-studio admission settings | T2/T3 | Replace founder-managed per-studio Vercel slug activation with **one server/database-owned New client intake mode**: Open for booking / Waitlist / Closed (exact schema/name to be designed under authority map). Existing-client booking continuity remains separate. Turning WAIT off must not delete or hide queue/history. Environment allowlists may remain only as staged-rollout/emergency kill switches, not permanent studio authority. Willow’s fixed 48-hour/profile/consult rules remain studio policy, not a silent global default. |
| WAIT-CONTINUITY-01 | Existing waitlist visibility during legacy → durable migration | T1/T2 | An owner with waiting people must always have a discoverable truthful waitlist path even when durable rollout is OFF. Legacy and durable data sources are reconciled explicitly; navigation may route to the authoritative current source but must never imply deletion. Chloe’s 15 Sep hidden-tab incident is the acceptance case. No durable enablement or data migration is authorized merely to make the tab appear. [S37] |

<a id="hone_s_15_1"></a>
## 15.1 COMMS delivery map within SMS-01 / SMS-02

| **Unit** | **Verified construction state** | **Next proof / HOLD** |
| --- | --- | --- |
| COMMS-01B / #673 / 0191 | Provisioning foundation merged; applied state remains a dated recorded observation. [S27] | Do not reapply. Verify provider and current sender truth at activation, not from zero old DB rows. |
| Existing-sender adoption / #676 | MERGED 4997f9a7: separate owned-number adoption engine; inspect ownership/association/configuration and refuse unsafe state. [S28] | Engine is not live adoption. No automatic service rewrite or replacement-number purchase. |
| Existing-sender configuration / #677 | OPEN ba27a1bf: inspect separately from claim/mutation; bounded webhook/callback configuration capability. [S28] | No caller/configuration/real Twilio action established. Preserve post-write read-back, recovery and lease semantics. |
| COMMS-01B2 / #674 / 0194 | OPEN 77a92fc0; file is 0194_studio_sms_sender_outbound_lookup.sql. Old body says 0192. [S27] | HOLD routing/cutover until exact-head review, allocation/contiguity, production data/index preflight and verified sender continuity. |
| COMMS-01C-A / B | Prior local server/UI work preserved, not re-censused here. [S18, S19] | Do not duplicate #676/#677 or infer clean local status. Re-read actual worktrees and ownership before resuming. |
| WAIT-04C dual-channel contact | AUTHORIZED follow-on scope; separate from the email-only #680 component. [S19, S26] | Reuse a genuinely supported live send path only after verifying it. Neither shared-sender readiness nor dedicated-sender cutover is assumed. |
| SMS-01 / SMS-02 remaining | Delivery callbacks, retry/exhaustion, quotas/cost controls, suspension/disconnect and operator visibility remain. | Initial WAIT texts or a sender adoption do not close the entire SMS program. |

<a id="hone_s_15_2"></a>
## 15.2 Willow continuity and no circular sender dependency

The session proposed using existing shared SMS for early WAIT invitations rather than waiting for dedicated studio numbers. Record that as a conditional integration route, not verified operational readiness or permission to restore a generic fallback inside #674. Verify current provider ownership, sender identity, callback/STOP path, consent and suppression before a real send. An ACTIVE row, provider configuration and a received canary remain distinct facts. [S19, S27, S28]

Do not deploy mandatory studio routing while Willow lacks a verified working sender and the only means of adoption/configuration is postponed behind that deployment. #676 addresses adoption as a separate capability; #677 addresses configuration as a separate candidate. Actual orchestration/caller support and safe recovery remain to be proven. No purchase, activation, silent reconfiguration or billable effect is authorized by this document.

<a id="hone_s_15_3"></a>
## 15.3 Dual-channel WAIT delivery and initial COMMS DONE

WAIT invitation and reminder events must distinguish email and SMS attempts, provider acceptance, delivered/failed/suppressed and unknown outcomes. One channel failure must not mint a second active invitation; a partial send must not be reported as complete dual delivery. Re-check current consent and lifecycle at send time, preserve dedupe across retries/callbacks, and use a stable event identity that does not reveal a proof-code verifier. [S19, S26]

The initial dedicated-COMMS milestone still requires deployed authority, supported adoption/provisioning and configuration, correct sender observed on a real handset, authenticated STOP plus subsequent suppression, no duplicate purchase under retry/reload, named monitoring/rollback and operator acceptance. An authorized WAIT shared-path canary does not satisfy these dedicated-sender conditions. External-studio location/registration/rollout readiness remains unverified by this update.

<a id="hone_s_16"></a>
# 16. Control Plane, Developer Platform and Autonomous Development

The original control-plane program and its retirement/re-entry gates in §§16.1–16.5 remain unchanged. The non-authoritative Developer Platform / Agentic Engineering backlog is maintained in §§16.6–16.8; adoption of support tools does not supply missing control-plane authority. [S34, S35]

| **GOAL  Notes -> roadmap -> dependency DAG -> READY item -> bounded engineering contract -> clean worktree -> implementation -> focused proof -> PR -> CI + Codex -> classified repair -> release decision -> production smoke -> accepted-state update -> next item.** |
| --- |

| **ID** | **Capability** | **Rule** |
| --- | --- | --- |
| CP-001 | Trust root / pinned-key integrity | Historical private-repository protection blocker is not assumed current for this repository. Revalidate the intended control-plane repository/permissions on re-entry. PARKED; no unattended continuation or new authority implementation is authorized. |
| CP-002 | Accepted-state and decision ledger | CAS/accepted-state foundation; deterministic authority, not LLM self-authorization. |
| CP-003 | Roadmap queue and dependency DAG | Machine-readable items, READY calculation, WIP limits and mechanical scope-budget/hard-stop enforcement. |
| CP-004 | Worker dispatcher | Clean worktree creation, branch lifecycle and task execution with isolated local browser/server resources so parallel workers cannot test another tree. |
| CP-005 | PR / CI / Codex evaluator | V1 PARTIAL. Observation-only CP-005a shipped via #616: exact-head PR/CI/review facts and provenance. Authority-bearing findings/readiness/ledger successors #617-#623 retired unmerged. Do not resume the authority half until Section 16.5 re-entry conditions are met. Never merge. |
| CP-006 | Production release lock | Production concurrency one; migration number/authorization lock. |
| CP-007 | Bounded repair / stop-law engine | NOT STARTED / NOT_NOW. The planned stop-law engine depended on authoritative durable state that did not survive review. Manual stop-law discipline remains binding. Re-entry requires Section 16.5; never auto-merge. |
| CP-008 | Low-risk auto-merge | T0/T1 only after protections and accepted-state machinery are mature. |
| CP-009 | Production verifier | Deploy/version/smoke/provider evidence; cannot mark operational items DONE from repository proof alone. |
| CP-010 | Continuous roadmap executor | Select next READY item, execute within governance, stop at human gates. |

<a id="hone_s_16_1"></a>
## 16.1 Supporting automation items

AUTO-001: machine-readable roadmap objects.

AUTO-002: DAG planner - what can be built now.

AUTO-003: risk classifier.

AUTO-004: worktree/PR executor.

AUTO-005: review loop.

AUTO-006: release-train controller (development many, production one).

AUTO-007: production verifier.

<a id="hone_s_16_2"></a>
## 16.2 Machine vs human completion

A merged PR is not automatically DONE when acceptance requires hosted provider state, human usability, production enablement or destructive execution.

Evidence requirements are typed: repository CI, DB behavioral proof, hosted provider state, production smoke, user acceptance, legal/external dependency.

Phase 1: Sam merges all PRs. Later low-risk auto-merge only after control-plane protection and accepted-state authority exist.

<a id="hone_s_16_3"></a>
## 16.3 Historical control-plane state - 23 Aug 2026

SHIPPED OBSERVATION/EXECUTION SUPPORT: existing ci:plan, verify:changed, verify:prepush, browser sharding and exact-head release discipline remain. TEST-PORT-01 (#615) adds per-worktree app-port isolation/no server reuse. CP-005a (#616) adds read-only exact-head GitHub/CI/review fact provenance. Do not rebuild these.

CP-005a is the only shipped CP-005 slice. It reports current head, exact-head checks, review/comment provenance, fresh/carried/stale evidence and UNKNOWN read failures. It does not own finding disposition, readiness, stop-law state or merge authority.

CP-007 was NOT started. Architecture-stop/retire behavior remains process-proven because the operator applied the standing stop laws manually across #608, #612 evidence work, #613 and #617-#623. Do not count manual discipline as shipped automation.

WORKTREE APP-SERVER ISOLATION IS SHIPPED. Remaining shared local resources are Supabase/Postgres/Mailpit; concurrent runs that reset or otherwise mutate the shared local database remain inadmissible. This is a declared limitation, not a new control-plane project priority.

Evidence machinery must be simpler than the failure class it protects. The Cycle 2 retrospective sharpens this: the builder may not certify the completeness of its own authoritative enumeration/validator. Exact-head adversarial review is independent falsification and remains mandatory; authority components require a stronger re-entry process before implementation.

<a id="hone_s_16_4"></a>
## 16.4 Cycle 2 experiment outcome - CLOSED 23 Aug 2026

OUTCOME: TEST-PORT-01 shipped via #615 and CP-005a shipped via #616. Seven authority-bearing successors (#617-#623) were retired unmerged; CP-007 was never started. Dev Engineering V1 is CLOSED and must not spawn a smaller successor under the same verification process.

RETROSPECTIVE COUNT: 39 findings were raised at exact heads during the program. 1,115 implementation lines shipped; 2,438 implementation lines were discarded. The final stretch after CP-005a consumed about 8h15 with zero merged output. These figures are program evidence, not a productivity target.

OBSERVATION VS AUTHORITY: observation-only components shipped and held. Authority-bearing components - verdict/completeness semantics, normalized validity, fact packet and durable ledger - went 0-for-7. Every retired authority vehicle was CI-green and failed exact-head adversarial review against its own stop law.

REPEATED FAILURE MECHANISM: verification was circular. The builder enumerated cases, implemented the authority and then claimed that enumeration was complete. Omitted surfaces repeatedly fell through permissive defaults at evidence semantics, verdict aggregation, schema validation and file I/O. Scope shrank; the mechanism did not.

BEST DIAGNOSTIC: a negative control that FAILED TO FIRE exposed blind spots more reliably than a large passing suite. Passing tests often proved what the builder remembered; a non-firing mutation/control revealed what it had not modeled. Fault injection at durable/authority boundaries becomes a re-entry requirement.

SAFETY RESULT: no failed authority vehicle merged, no durable production data was lost, and the manual stop laws fired before production mutation. The experiment returned a negative capability result at low production cost; preserve fixtures, exact-head review evidence and the two shipped observation tools.

PROGRAM DISPOSITION: Phase 1 continues with a permanent human merge/release gate. No CP-005 ledger/readiness authority, CP-007 stop engine, auto-merge or continuous executor is authorized. Return engineering capacity to Hone product work.

<a id="hone_s_16_5"></a>
## 16.5 Authority-component re-entry gate

NO RE-ENTRY BY SCOPE REDUCTION. A smaller validator, ledger or stop engine is not evidence that the failure mode changed. The verification process must change first.

MECHANICAL COMPLETENESS. Prefer generated validators/schemas, total functions or another mechanism whose coverage is mechanically derived from the authoritative shape rather than a hand-written list of remembered cases.

INDEPENDENT FALSIFIER BY CONSTRUCTION. The component that tries to disprove the authority must be independent of the builder and run against the exact head before merge; the builder cannot declare its own validation complete.

FAULT INJECTION PRECONDITION. Any durable/authoritative component must prove malformed, unreadable, partial, interrupted and concurrent states fail without data loss or permissive defaults. For durable writes, failed validation implies no write and byte/state preservation where applicable.

Until all three conditions are satisfied, authoritative control-plane state remains NOT_NOW. Observation-only reporting may continue when bounded and independently reviewed.

<a id="hone_s_16_6"></a>
## 16.6 Developer Platform / Agentic Engineering — one supporting workstream

**Purpose:** improve source understanding, architecture review, engineering consistency, design quality and session continuity without creating a competing operating system for Hone. This is Sam's accepted tooling backlog, not a blanket implementation GO. The evidence checkpoint is §3.7; the supporting order is §23.7; the product sequence remains §23.6. [S35, S36]

### 16.6A Status register — adopted direction is not completed rollout

| **Item** | **Recorded status** | **What is actually left / acceptance exit** |
| --- | --- | --- |
| Graphify | **PILOT PENDING** — selected for code discovery. | Run the local code-only pilot, stamp the source SHA, and spot-check extracted relationships against source. No docs/media ingest, read-blocking hook, post-commit hook or always-on indexing. Temporary pilot output stays outside tracked Hone source. Decide adoption from demonstrated usefulness; do not assume the pilot already ran. [S36] |
| Archify | **PILOT PASSED / ADOPT** — prior local result reported; adoption direction retained. | Incorporate intended architecture, trust boundaries and before/after deltas into relevant architecture reviews. Preserve PROPOSED versus IMPLEMENTED labels and source/review references. Reuse the completed pilot; do not repeat exploratory evaluation. It is not a source-truth discovery engine. [S35, S36] |
| Matt Pocock skills | **SELECTED / OPERATIONALIZATION PENDING.** | Distribute only the reviewed subset, document provenance/local patches and map each skill to a workflow trigger. Confirm actual installed scope before reporting rollout complete. Skills improve engineering behavior; they do not supply independent review or release permission. [S35, S36] |
| Apple design guidance | **INSTALLED OPERATOR-LOCAL** — carried record. | Codify the relevant response, interruptibility, spatial consistency and restraint principles in Hone's own `DESIGN.md`. The recorded global skill is outside Hone's repository/skills lock; it is guidance, not a Hone runtime dependency. Preserve §14.7.1 precedence. [S34, S36] |
| Emil design guidance | **DEVELOPMENT-ONLY SKILLS MERGED / STANDARDIZATION PENDING.** | Preserve the six reviewed/patched skills carried through #639 and their Hone overrides. Fold interaction, accessibility and restrained motion guidance into the same design standard rather than accumulating disconnected prompts. No new motion runtime or UI framework. [§14.7.1; S34, S36] |
| Context Mode | **CANARY PASSED / ROUTINE ROLLOUT PENDING.** | Preserve actual MCP use, large-output handling, compaction continuity and the tested Node split. Complete runtime-scope cleanup, startup/reconnect reliability and controlled fresh-session rollout after WAIT checkpoints. The manual-reconnect WARN stays visible. [§3.7; S35] |
| Herdr | **CANARY SUBSTANTIALLY PASSED / PROMOTION PENDING.** | Extend beyond `hone-smoke` only after durable lane handoffs. Finish the authorized host-reboot/linger test, name operational ownership and document session versus task recovery. Do not equate supported Claude resume with arbitrary shell/test recovery. [§3.7; S35] |
| Executor | **PENDING / SCOPE AND RE-ENTRY GATED.** | Retain the resumable, idempotent execution goal; identify the exact implementation and owning roadmap item before build/adopt. Prove interrupted execution, retry and concurrency under the applicable gate. This is not authority to revive CP-005b, CP-007 or continuous auto-release. [§16.8; S34, S35] |

**Selected Matt Pocock subset:** `diagnosing-bugs`, `handoff`, `research`, `code-review`, `writing-for-agents`, `improve-codebase-architecture`, `domain-modeling`. These are the recorded selection names, not a claim that their current upstream revisions are installed or verified. Adoption is selective, not a marketplace-wide import. [S36]

### 16.6B Organization and practical workflow

| **Group** | **Components** | **Role in one coherent system** |
| --- | --- | --- |
| Agent orchestration and continuity | Herdr; Context Mode; later Executor | Keep agent work reachable, reduce bulk-output context pressure, and eventually make explicitly authorized execution recoverable. These are three different recovery problems, not interchangeable guarantees. |
| Architecture intelligence | Graphify; Archify | Graphify investigates source relationships; Archify explains intended/reviewed structure. Compare them to investigate possible drift; confirm conclusions against source and runtime evidence. |
| Engineering practice | Selected Matt Pocock skills | Debug, research, hand off, review and model domains with explicit assumptions, bounded scope and an independently testable result. |
| Product / UI quality | Apple guidance; Emil skills; Hone `DESIGN.md` | One Hone-owned design standard applied to real practitioner surfaces, with the existing tokens/primitives and device/accessibility proof. |

The workflow is **understand relationships → review intended architecture → perform bounded engineering → apply Hone design rules → preserve useful context/session continuity → execute only within authorization → verify with GitHub, CI and independent review**. Use the relevant tools for a task; do not require every tool on every small change. Executor is the future execution step, not a capability supplied by the canary.

`DESIGN.md` is a planned codification, not a replacement UI system. Before writing it, reconcile existing design documents and #609 primitives, then establish one maintained home linked from the agent rules. Cover clinical information density, clear primary actions, mobile/touch geometry, keyboard/focus, reduced motion, truthful pending/error/UNKNOWN states and measured latency. Keep Apple/Emil references subordinate to §14.7.1; a skill suggestion cannot introduce a package, Client Component boundary or optimistic clinical/payment/booking truth.

### 16.6C Authority and evidence remain outside the tooling layer

Sam's latest explicit instruction governs scope and permission. Fresh Git/GitHub, serving deployment, hosted database and provider observations answer their own fact domains under §0.2. Exact-revision CI and independent review support the release decision; GO/HOLD/STOP and human production boundaries remain §§7–8 and §23.3. Tools, generated diagrams, indexes, memories and skills sit below those authorities and cannot override them.

**Permanent Context Mode rule:** Context Mode is an analysis and memory layer only. Git, GitHub, hosted database state and Sam's latest authorization remain authoritative. A recovered instruction is historical context until mutable facts and the current authorization are revalidated. An agent session resuming is not a release GO.

GitHub + CI + Codex remain durable evidence sources, not a self-authorizing loop. Preserve authorship independence, original reviewed revisions, prior open findings and UNKNOWN failures. No graph, remembered checklist, passed doctor or builder-produced test count may declare complete coverage, safe production state or autonomous readiness.

<a id="hone_s_16_7"></a>
## 16.7 Context Mode + Herdr — controlled rollout and cleanup

**Current boundary:** functional canary accepted; general rollout not complete. Keep the active WAIT engineering environment stable until its owners have saved durable checkpoints. Do not install/reload plugins into saturated in-flight agents, reboot the host or replace the current session manager merely because the smoke test passed. New routine sessions are the rollout target. [S35]

### 16.7A Preserve the working evidence; inventory the experimental footprint

The successful setup used user-local Node runtimes and dispatchers, not a Hone application dependency. The following are recorded paths to inspect before a cleanup or promotion; their present contents and continued necessity must be read, not inferred. [S35]

| **Recorded path / surface** | **Rollout treatment** |
| --- | --- |
| `~/.local/bin/node`, `~/.local/bin/npm`, `~/.local/bin/npx` | Working dispatchers were installed here. This is a **shared user PATH**, not a canary-only boundary. Other processes resolving these names may be affected; unchanged default version alone does not prove unchanged runtime semantics. |
| `~/.local/context-mode-node-shim/` | Earlier experiment; existence and use on the host remain to be confirmed. Do not assume it was installed successfully or delete it by name alone. |
| `herdr-hone-smoke.service.d/node22.conf` under the user systemd directory | Inventory the effective unit/drop-ins and actual process environment. Saved shell state and shell startup may differ from the unit's PATH; the earlier cause was not conclusively established. |
| NVM Node 20.20.2 and 22.23.2 | Preserve both recorded runtimes until a reviewed replacement and rollback exist. These exact versions describe the canary, not permanent version-selection policy. |
| Canary-local plugin settings, plugin cache and Context Mode storage | Record scope, version, enabled hooks/MCP entrypoints and storage/retention behavior. Local plugin enablement does not imply every cache, memory record or executable is worktree-local. |

The promotion design should narrow and simplify runtime selection. Explicit per-tool runtime pinning is preferable to silently expanding a user-wide dispatcher, but the exact arrangement must be selected from the installed launch paths. A substring-routing demonstration is not sufficient proof: execute the real MCP tool and relevant hook/child-process paths. Do not alter Hone's `package.json`, CI or serving runtime just to satisfy a developer plugin.

### 16.7B Rollout exits

| **Gate** | **Evidence required before the next stage** |
| --- | --- |
| 1. Safe checkpoint and scope | Named operator, affected sessions/worktrees and maintenance window; dirty/unpushed work preserved; current WAIT and shared-resource ownership respected. No production operation or active shared DB run is interrupted. |
| 2. Runtime and permission boundary | Fresh native Bash, node/npm/npx, Claude launch, Context Mode MCP, hooks and spawned processes use their intended runtimes. The canary target was Hone Node 20 / Context Mode Node 22. Record affected user-wide paths; no silent permission expansion or unrelated shell/profile rewrite. |
| 3. Connected startup and recovery | Verify real `ctx_execute` availability, not doctor alone. Exercise fresh start and supported reconnect; record automatic-start failures, frequency and recovery. Manual reconnect remains an explicit warning until routine startup is demonstrated. |
| 4. Continuity without false task success | Reconnect, process restart and compaction preserve the intended agent context where supported. Compare native session identity and new task evidence; an already-idle wait response is not completion. Arbitrary tests/jobs need their own checkpoints/restart procedure. |
| 5. Bounded new-session promotion | Enable one named new engineering session first, verify task behavior and existing Git/CI workflow, then expand deliberately. Record plugin/skill versions, local overrides and rollback. No fleet-wide retrofit of 99%-context conversations. |
| 6. Host boot and rollback | Separately authorize the real host reboot only after all lanes are safe; verify enabled unit + linger + actual boot recovery. Prove the scoped rollback/fallback without removing shared tools or another lane's work. |

Context Mode's output reduction is not a filesystem, credential or security sandbox. Exclude secrets and customer/clinical data from tooling indexes or diagnostics unless separately authorized; preserve the existing access, redaction and retention rules. Do not enable a hosted dashboard, new external ingestion, Bun, extra language runtimes or broad Bash permissions merely to make a diagnostic green.

Herdr preserves/resumes supported agent sessions; Executor would own durable task progress. Wi-Fi reconnect, Herdr-server restart and host reboot are separate tests. A restored layout or `claude --resume` is not evidence that a half-run migration, provider request or arbitrary shell command can safely be replayed. Those operations retain their own currentness, idempotency and human gates.

The rollout record must state version/scope, host/worktree, observed time, actual tested entrypoints, remaining limitations, owner, next gate and rollback. Tool updates invalidate version-specific assumptions and require proportionate revalidation. This section is a gate definition, not an installation script or permission to change the host now.

<a id="hone_s_16_8"></a>
## 16.8 Executor — preserve the goal without reviving retired authority

The backlog records **Executor = pending: build/adopt a resumable, idempotent execution layer and prove crash/retry behavior**. The supplied amendment does not identify one exact external repository or settle which Hone execution boundary it means. Keep that implementation choice explicit rather than inventing a product/version or treating multiple roadmap executors as one. [S35]

| **Execution scope** | **Existing home / boundary** |
| --- | --- |
| Bounded engineering task/worktree execution | CP-004 / AUTO-004 describe worker/worktree execution. Any proposed implementation needs a named unit, scope, isolated resources and human-directed task boundaries. Session orchestration alone does not prove resumable jobs. |
| Continuous roadmap selection, readiness, repair or release | CP-002/003/005/006/007/008/009/010 cover these distinct responsibilities. The retired authority program stays NOT_NOW until §16.5 is satisfied and Sam explicitly authorizes re-entry. No automatic merge or production step is implied. |
| Product-data import execution | DATA-01B with DATA-01A/01D (§13) owns resumable import, row identity, memory attachment and fault injection. It remains Trust/product work, not a developer-tool installation and not replaced by Herdr or Context Mode. |

Before an Executor build/adopt decision, identify the intended implementation and owning item, durable state and effect boundaries, concurrency/resource ownership, retry policy and exact human stop points. Reuse surviving observation support; do not rebuild a findings/readiness oracle under a new tool name.

Acceptance must exercise interruption before and after durable writes, replay, duplicate/concurrent workers, incomplete or unreadable state and an unknown external effect. Resume must neither lose completed work nor repeat an irreversible effect blindly. Independent falsification and fault injection are prerequisites wherever output is trusted as complete, valid, durable or release-authoritative (§16.5). A smaller scope or passing self-test does not reset the existing stop law.

**Disposition:** retained in the developer-platform backlog, later and gated. This publication supplies no Executor implementation, CP authority re-entry, auto-merge, migration allocation or provider authorization.

<a id="hone_s_17"></a>
# 17. Feedback Intake, Interrupt Policy and Acceptance Program

<a id="hone_s_17_1"></a>
## 17.1 Interrupt classes

| **Class** | **Examples** | **Response** |
| --- | --- | --- |
| C1 Emergency | P0, cross-tenant access, payment corruption, data loss, live booking outage, broken clinical charting, safety/privacy incident; live new-client over-intake where accepted consultations materially exceed near-term treatment capacity and create a client-experience/safety-of-service incident | Interrupts all lanes; fix immediately. |
| C2 Live Chloe P1 regression | Cannot chart/complete/pay/access intake; wrong treatment history/consent; major booking correctness | May interrupt next Product PR; small focused repair; no roadmap reshuffle unless structural. |
| C3 Ordinary feedback | Move button, wording confusion, show X, friction | Weekly triage: QUICK WIN / PRODUCT INPUT / DISCOVERY / NOT NOW. |

<a id="hone_s_17_2"></a>
## 17.2 Feedback object

source | original_quote | received_at | surface | workflow_stage | frequency | current_workaround | harm{money,clinical,time,confusion,client_experience,capacity} | classification | parent_initiative | risk_tier | migration_required | acceptance_owner

<a id="hone_s_17_3"></a>
## 17.3 Acceptance debt is real work

| **FOUR DIFFERENT STATES  MERGED != DEPLOYED != PRODUCTION VERIFIED != USER ACCEPTED. Future automation must model each separately.** |
| --- |

| **Acceptance seed** | **Initial roadmap status** |
| --- | --- |
| Mobile Mark completed | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Quick Checkout + receipt | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Smart scheduling 11:30 case | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Pinned-note editing | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Card-change notifications | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Charting chip separation | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Collapsed Add settings | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Larger notes field | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Conditional numbing notes | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Probe inventory lot linkage | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| In-form Copy settings | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Whole-session copy | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Willow consultation booking link | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Start from last session | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Inline dashboard expansion | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| #486 memory visibility | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Notification Centre | REVALIDATE / record PASS, FAIL, ACCEPTED LIMITATION, DEFERRED or NOT TESTED |
| Willow new-client waitlist / existing-client continuity | **DATA/LEGACY OPERATION PRESERVED; UX CONTINUITY REOPENED.** Willow’s existing waitlist remained present and legacy WAIT stayed enabled, but Chloe observed that the Settings Waitlist navigation disappeared while durable WAIT was intentionally OFF. ⚠️ **AMENDED 2026-09-20:** this directed closing WAIT-CONTINUITY-01 ahead of a migration that had in fact already happened (on or before 2026-08-25). The defect is unchanged and still owed — rollout state must not make the list appear deleted — but it is now **remediation after the fact**, not a gate before one. |
| WAIT-03 controlled test-studio canary | **FULL PASS — 12 of 12 seams**, invitation through proof, booking, atomic conversion and reload truth, plus the fail-closed refusal when capacity is exhausted. `no_admission_round` is repaired by #709/0197. Cleanup complete; the converted entry, redeemed invitation and resulting appointment were deliberately preserved as evidence. The acceptance debt that remains is Chloe device acceptance, not the journey. |
| Capacity lead-time / safe-admission recommendation | REVALIDATE after ADMIT-01/02 / record practitioner agreement, override reason and outcome; do not invent acceptance before assisted pilot |
| Dashboard current-client/card/consultation actions (#598) | MERGED / DEPLOYED. REVALIDATE on Chloe device as part of the current Dashboard acceptance train; card truth remains three-state and portal link only on trusted no-card. |
| Dashboard selected-day navigation (#606) | MERGED / DEPLOYED. Navigation itself shipped; user acceptance exposed prep-parity debt in the next layer rather than a day-navigation failure. |
| Dashboard selected-day full prep parity (#608) | FAILED DELIVERY VEHICLE / RETIRED. #608 closed unmerged after five same-family P1s. Acceptance remains OPEN on a clean-room Prep V2 replacement: future day must preserve positive prep facts without collection-derived absence claims. |
| Interaction latency / slow clicks | Historical production measurement and #612 improvement are preserved in the evidence baseline. No new v1.10 speed measurement was run; verify present behavior before a new claim. |
| Hone UI V2 | FOUNDATION SHIPPED / RECON COMPLETE. #609 is live; final read-only recon defines UI-01..UI-06. User acceptance begins with real migrated practitioner surfaces and iPhone/iPad evidence, not library screenshots. |

<a id="hone_s_17_4"></a>
## 17.4 Chloe feedback record — 6 September 2026 (historical input)

The following is preserved as the 6 September source record. Its proposed defaults and “not yet authorized” statements are superseded by §17.5 and the accepted WAIT-04 contract; they are not today’s work assignment.

Source: messages pasted by Sam into this thread. Times below are reproduced as provided; no timezone was supplied for the original message timestamps. This is direct product input, not GitHub implementation evidence. [S7]

12:25:12 PM — “i want a way on hone to send the waitlist clients of my choosing a secure portal to book that ONLY has a specific booking horizon or specific days. For example: they can book in the next two weeks but not beyond that”

Same message — “they can decline and go back on the waitlist/wait for the next booking slots to open”

12:25:29 PM — Chloe says she needs this soon to add people and is unsure how to approach it effectively. At 12:44:46 PM she explicitly welcomes a better alternative.

| **Field** | **Recorded disposition** |
| --- | --- |
| Parent / classification | WAIT-03 / Planned Product input with urgent capacity and revenue value. Not automatically a live P0 defect or migration-free quick win. |
| Acceptance owner | Chloe for the Willow user workflow; Sam for scope, sequencing and production authorization. |
| Confirmed need | Chosen recipients; restricted appointment horizon or days; secure booking; decline and remain waiting. |
| Proposed defaults | Email first; one eligible initial appointment; owner-chosen intake cap; small groups; fixed dates; lightweight recipient verification and minimal operator-add path where necessary. |
| Decisions still open | Exact appointment/service, group/cap behavior, response deadline, decline cooldown, reissue/identity UX, quota behavior after cancellation and scope of ongoing access. |
| Current assignment | Contract + authority map + acceptance matrix, separate worktree. No output/acceptance received in this update; implementation, real invitations and production changes are not authorized by the assignment. |

Earlier September 3 weekday/weekend preference, manual-entry and email-only prospect needs are carried forward as user-reported context, not a fresh database census. Their minimal useful parts attach to WAIT-PREF-01 / WAIT-ENTRY-01; broad import or automatic prioritization is not silently added to the first release.

<a id="hone_s_17_5"></a>
## 17.5 Chloe’s final WAIT policy input — 7 September working session

Source record: Chloe’s feedback pasted into this conversation, followed by Sam’s execution approval. These quotations record why the product contract exists; §14.5.7 alone carries its current operational rules. Exact message timestamps were not supplied. Demand/no-show reports are not a reconciled database census. [S19]

| **Source wording / concern** | **Accepted roadmap consequence** |
| --- | --- |
| “the client should recieve it as a text and email to increase visibility” | WAIT-04C dual-channel invitation and reminder, consent/suppression respected; provider outcomes are evidence classes, not assumed visibility. |
| “these times dont work but want to stay on waitlist” / “get off the waitlist and no longer be contacted” | Four explicit recipient choices, preserve-priority vs leave outcomes and truthful consequences; replace generic Decline. |
| No response “within 48 hours” → presumed no longer interested | Fixed response policy, one 24-hour reminder, auditable timeout outcome and delivery-failure protection. Not a permanent no-show restriction. |
| Require “first and last name and phone number and email” and structured treatment areas; no “PLEASE ASAP BOOK ME” | Required profile for new joins and secure legacy completion; controlled multi-select, no urgency/comments box. |
| Consults move “WEEKS out”; treatment need unknown before assessment | No self-service first-consultation reschedule; explicit cancel-and-return with new priority; practitioner-approved move no penalty; consultation booking does not confer full treatment eligibility. |
| “permanent ban” for consultation no-call/no-show; owner can manually make an exception | Permanent clinic-scoped self-service restriction; owner manual booking does not clear it; explicit no-show confirmation/correction and audit. |
| “30+ people … maybe 2.5 weeks” and “2 no call no shows” | USER_REPORTED pressure, not reconciled active queue/appointment counts. Do not convert to a production capacity model or assume all records are in the durable database. |
| Can Hone estimate waiting time? | WAIT-FORECAST-01 planned time-to-invitation range; event instrumentation now, calibrated estimator later. Post-assessment treatment demand is a separate forecast. |

<a id="hone_s_17_6"></a>
## 17.6 New acceptance debt and activation boundaries

Acceptance scope and pass conditions are maintained in §14.5.9, with named practitioner/device results recorded in ACCEPT-001. This source record creates no additional copy of the contract and marks no new item USER-ACCEPTED. [S19, S33]

Chloe’s rejection of the Claim surface is a negative acceptance result for that interaction model, not proof that the replacement has passed. #684 is the source-level containment; #683/WAIT-04 and final binding own the useful destination. Preserve both learning and the remaining work. [S21]

<a id="hone_s_17_7"></a>
## 17.7 Chloe recorded feedback session - 7 September, 9:30 PM (Work Plan v3 source)

Source record: four voice notes recorded by Sam with Chloe on 7 September, 9:30 PM, automatically transcribed and organized in Work Plan v3. These are product inputs, not implementation or measurement evidence. Confirm ambiguous wording before scoping. The current WAIT contract is §14.5.7; the batch definitions are §14.6.1; product sequencing is §23.6. [S31]

| **Source wording / concern** | **Accepted roadmap consequence** |
| --- | --- |
| A client told her "you are really busy" from the open booking link; she has been "walking off random" slots to look artificially busy; "it basically needs to improve privacy" | BOOK-PRIVACY-01 (§14.6.1): booking gets waitlist-style rules so schedule density is not readable. |
| "It's still a lot of clicks right now to check people out ... probably 10 clicks ... they wait like a solid 60 seconds" | FLOW-03 checkout: audit and count first, then the agreed reduced path. Carried from the August backlog. |
| Pinned notes on the Dashboard "showing up clipped ... dot dot dot ... no way to expand it" | DASH-NOTE-01. |
| After charting, the Dashboard note "has updated to today's note ... it should remain as last week's note ... until her next appointment" | DASH-NOTE-02, framed as the HIST-01 latest-note-before-cutoff question. |
| "A place to toggle on the notifications that you want and don't want" (cards added / changed, birthdays, waitlist) | NOTIF-PREFS-01, per user. |
| Disinfection overdue notice: "one click ... did you replace this ... select the date, and then it fills out the form for me" | RECORDS-01 action from the notification into the logbook entry. |
| Client buckets: "active, paused, ... completed" with future "email all active clients" / review requests / check-ins | CLIENT-STATUS-01 now; BULK-MSG-01 deferred by Chloe ("not an important feature now"). |
| Waitlist: gauge "interest level" at join so ready-to-start prospects come in first; availability options beyond weekdays / weekends / both | WAIT-INTAKE-01 open decision (§0.7); availability stays structured weekdays / weekends / both now, granular options deferred. |
| "30 people joining the waitlist in just under 3 weeks" | USER_REPORTED pressure, not a reconciled active-queue count (same treatment as §17.5). |
| Prioritize by interest rather than identity: "I don't know if that's always fair either. So I am trying to just go by interest." | Readiness / availability sorting only; no demographic field anywhere in intake. |
| "When do I start charging for consults ... $45, $35 ... I don't want to do 100 more consults for free"; fairness to people already waiting for a free consult | Business decision, open (Chloe): fee level, effective date, grandfathering. If adopted, product dependency is a consult as a paid booking type. No build item scheduled. |
| Consult value-add (mini aftercare, hypochlorous acid spray) - "I sometimes turn people away from electrolysis to laser" | Business decision, open. No build item. |
| Sam: MultiPlex "to be next, after that ... so easy, I just needed your full input" | MPX placement (§0.7, §14.3): Chloe field interview first. |
| App speed "fine ... not my favourite" | No new item. PERF-UX-01 and the PERF-03 ladder are unchanged. |

<a id="hone_s_18"></a>
# 18. Design Partner, Growth and Fundraising Measurement

<a id="hone_s_18_1"></a>
## 18.1 DP-001 supervised cohort

Target 2-5 trusted design partners after Gate B.

Operator-assisted onboarding/import/offboarding is acceptable at this gate if underlying processes are safe and truthful.

Do not delay commercial learning for full automated PRIV-01 when no design partner needs it immediately.

Do not allow supervised status to become a permanent excuse; measure founder/operator effort explicitly.

Design partners pay from day one at the published founding rate via manual invoicing; free pilots are not design partners. Willow is excluded from commercial proof metrics.

No invoice before TRUTH-01A and counsel-approved terms/privacy are closed.

Choose partner 1 shape deliberately: a multi-practitioner studio pulls PRACT-01/PRACT-02 forward as prerequisites; a solo studio does not.

<a id="hone_s_18_2"></a>
## 18.2 Commercial proof metrics

Sessions charted in Hone.

Percentage of repeat visits using prior Treatment Memory.

Time from appointment to chart complete.

Visit Closeout completion.

Rebooking rate and due clients rebooked.

Cancelled capacity recovered later.

Collected value and unresolved payment work.

Support minutes per studio and time-to-launch.

<a id="hone_s_18_3"></a>
## 18.3 Fundraising narrative

| **FUNDRAISING THESIS  Hone is not another appointment calendar. It is the operating memory and admission-control layer for electrology practices. The investment case becomes strong when multiple studios repeatedly use longitudinal treatment memory, workflow completion improves, rebooking/retention value is measurable, demand can be admitted without overwhelming recurring treatment capacity, and support does not scale linearly with studios.** |
| --- |

New-client waitlist joins, invitations and consultation conversions when the studio uses admission control.

First-treatment lead time and percentage of active treatment clients with no future booking.

Safe-admission recommendations accepted vs overridden by practitioner, with reason.

Measured unmet demand and whether adding practitioner capacity/day actually converts into collected value.

<a id="hone_s_19"></a>
# 19. AI-Native Hone: Later, Grounded and Controlled

| **Phase** | **Capability** | **Boundary** |
| --- | --- | --- |
| AI-01 | Pre-Visit Brief | Summarize authoritative last-session and longitudinal facts; explicitly separate facts from generated summary. |
| AI-02 | Charting Assistance | Rewrite practitioner wording, summarize recorded treatment, flag missing fields; never invent clinical facts or autonomously finalize. |
| AI-03 | Longitudinal Treatment Memory Q&A | Answer questions such as settings used on chin over last five visits, grounded to recorded sessions. |
| AI-04 | Practice Intelligence | Explain overdue clients, weak future weeks, waitlist pressure and capacity using defined metric contracts. AI may explain a deterministic admission recommendation; it may not invent or authorize the release count, create appointments, or override server/database admission limits. |

| **NOT A CHATBOT ROADMAP  AI follows Treatment Memory, Practice Memory and truthful metrics. It does not precede them.** |
| --- |

<a id="hone_s_20"></a>
# 20. Five-Measure Operating Scorecard

These five readings are the founder-facing scorecard. The initial values are evidence-limited, not populated with invented zeros. No fresh measurement pass was performed for this editorial update. The former broad catalogue is retained in F.7.4 as optional diagnostics—not five dozen active reporting obligations. [S32, S33]

| **Measure** | **Initial reading** | **Definition / observation window** | **Accountable owner** |
| --- | --- | --- | --- |
| 1. User-accepted production outcomes | UNMEASURED | Trailing 7 days ending at an explicit measurement time. Count distinct outcomes with deployed/verified evidence and dated user acceptance; not commits, PRs or a repeated fix. | Sam; Chloe supplies workflow acceptance. |
| 2. Scope-to-acceptance elapsed time | UNMEASURED | Median elapsed days for outcomes accepted in the trailing 28 days; report sample size. Start at recorded agreed scope, end at user acceptance. Include waiting/rework; retain scope-version changes. | Sam / delivery owner. |
| 3. Active unfinished delivery units + oldest age | PARTIAL: #708, #709/0197, #713/0198 and #712 (WAIT-04A) are all released. WAIT continuity/owner-control, WAIT-04 seams S1–S5 and Chloe acceptance remain active. Full count and age still unmeasured. | Point-in-time census of authorized unfinished units. Separate active from parked/retired; link components to their customer outcome. Oldest age uses agreed-scope date, not last push. | Sam / delivery owners. |
| 4. Independent paying studios meeting proof criteria | NOT ESTABLISHED; no commercial census | Point-in-time count backed by payment and required cohort evidence; cite criteria and observation date. Exclude Willow. Do not infer zero from missing records. | Sam / commercial owner. |
| 5. Founder/operator support minutes per studio | UNMEASURED | Trailing 7 days per studio. Record onboarding, routine help, recovery and manual operations; report studio count and missing logs. Do not substitute development time. | Sam / operations owner. |

<a id="hone_s_20_1"></a>
## 20.1 First measurement and evidence trail

At the next release-readiness checkpoint, Sam owns a bounded measurement pass using existing ACCEPT-001 records, release evidence, the authorized-work inventory, billing records and a simple support log. Pair acceptance with a serving/deployment record for measure 1; recover agreed-scope and acceptance times for measure 2; reconcile local/draft/parked work for measure 3; verify the independent cohort for measure 4; collect support time for measure 5. No new analytics subsystem is required.

Each published reading records value, unit, cohort/window, measured-at, evidence, owner and missing-data limits. The first measurement timestamp remains PENDING until the pass is performed. An unavailable value remains UNMEASURED or NOT ESTABLISHED with its next collection action. If a complete census genuinely establishes zero, publish zero with that census—not before.

The six old WAIT-03 draft candidates in historical §3.2 have now converged into deployed #708; they are no longer six active delivery units. #709/0197, #713/0198, #712 (WAIT-04A) and the controlled canary are likewise complete. The current unfinished WAIT work is continuity/owner control, Willow reconciliation/migration and the accepted WAIT-04 policy — seams S1–S5 plus Chloe device acceptance. No complete elapsed-time or support-time series is supplied, and independent paid proof remains not established. [S42]

<a id="hone_s_20_2"></a>
## 20.2 Use readings to manage delivery

Review weekly and at a material release decision. Ask what reached the practitioner, how long it took, what remains unfinished, whether an independent studio paid and used it, and how much operator work it required. Keep PR merges, test counts, review rounds and CI failure causes as diagnostics when they explain these outcomes. Do not optimize them as substitutes for customer value.

Internal target dates or ranges are allowed when an owner records remaining work, assumptions and the next decision checkpoint. Targets are not guarantees and cannot bypass authority gates. The absence of a defensible target should trigger a bounded planning decision, not an unsupported “hours, not days” promise. [S33]

<a id="hone_s_21"></a>
# 21. Explicit Not-Building List

Generic AI chatbot or autonomous clinical advice.

Enterprise breadth before ordinary-studio self-service works.

True Google-driven appointment mutation before safe busy import and authority design.

Generic marketing automation.

Commodity POS / broad inventory catalogue / tax engine / line-item retail accounting without validated need.

Packages/deposits/split-payment architecture merely because competitors have them.

Draggable Dashboard widgets before the static operational hierarchy is correct.

Generalized browser scheduling framework or another comprehensive client-owned booking controller.

Giant cross-product client state manager.

Multi-location enterprise abstraction before the small-studio lifecycle is repeatable.

Unattended T3/T4 production releases.

Another broad security audit as a substitute for closing the accepted Run2B/Run3 register. Current-head reconciliation and bounded closure come first; a new broad audit needs a material architecture change, incident or a deliberate post-gate assurance objective.

Reopening/cherry-picking #588/#589/#594 implementations. Only tests, scenarios, authority discoveries and product contracts survive.

Automatic waitlist release before a durable studio-scoped queue, private invitation lifecycle and assisted-mode production evidence exist.

Unrestricted reopening of public new-client booking because one utilization percentage falls below a threshold.

Permanent reliance on a studio inbox as the only waitlist system of record.

AI-selected admission counts or autonomous appointment creation from waitlist state.

Hosting migration (including Railway) as a substitute for fixing measured application round trips. Revisit only after app-level bottlenecks are closed and a compliance/performance/cost benchmark justifies a move.

Broad caching of clinical latest/last/history state as a first-line performance fix. Stable configuration may be cached later under explicit invalidation; clinical recency/history truth stays server/database authoritative.

Another Dev Engineering authority V1 under the same builder/self-certifying completeness process. No local readiness oracle, authoritative findings ledger or automated stop engine is authorized until Section 16.5 re-entry conditions are met.

WAIT-specific not-building boundary: no guaranteed invitation date/queue ordinal, no speculative per-client treatment-hours model before assessment, no automatic invitation-volume recommendation from a thin sample, no global clinic blacklist, no generalized marketing campaign engine, and no new control-plane readiness oracle. The accepted WAIT-04 launch policies are not permission to widen these scopes.

vgpu / WebGPU as a package dependency before VISUAL-02 proves a material advantage over React / Canvas in an isolated spike (v1.12, §14.9).

<a id="hone_s_22"></a>
# 22. Definition of DONE for Hone v1

| **HONE v1  An ordinary small electrology studio can discover Hone, onboard, import its records, configure the practice, treat clients, collect payments, rebook, recover from common failures, export its data and leave Hone without Sam operating the product for them. Where demand exceeds treatment capacity, the studio can also contain new-client intake truthfully without harming existing-client continuity or depending on a founder-run workaround.** |
| --- |

| **Dimension** | **DONE means** |
| --- | --- |
| Trust | P0=0; P1=0 for ordinary-studio gate after current-head reconciliation; CLIN/HIST, SEC-01, DATA-01, TRUTH-01, OPS-01 and PRIV-01 closed/superseded with evidence; payment/helper/storage evidence tail dispositioned; production parity proven; DR-01A passed before paid expansion and DR-01B before Gate C maturity. |
| Clinical product | Treatment Memory reliable; Before Today; What Changed Today; advanced modality data such as MultiPlex faithfully chartable and retrievable. |
| Daily workflow | Prep fast; charting fast; Visit Closeout exists; payment and receipt in flow; rebooking part of workflow; unresolved work returns to To-do. |
| SaaS | Studios 2-5 launch safely; onboarding repeatable; import resumable; providers per studio; multi-practitioner controlled rollout; no founder-only routine launch steps. |
| Operations | Reminder ownership/heartbeat/backlog/provider canary and stale alert proven in hosted production; restore owners/drills work; migration release path controlled; release ledger truthful. |
| Portability/privacy | Export claims match capability; offboarding works; retention claims match reality; provider disconnect/purge exists. |
| UX | Real iPhone/iPad; keyboard/VoiceOver/NVDA/focus/contrast/200% zoom; weak network and interruption tests; treatment-room timing. |
| Commercial | PAID_MEMORY_PROOF-001 achieved: at least two independent paying studios use Hone from the same runbook; Treatment Memory is habitually used; Visit Closeout/rebooking/collection value is measurable; support burden is bounded. Willow is not counted as independent commercial proof. |
| Demand / admission | Where generally offered: durable studio-scoped waitlist, secure invitation lifecycle, tested contact/response/consultation policy, existing-client continuity, truthful delivery and recoverable operator workflow. Assisted safe-admission metrics need their own evidence; calibrated wait-time forecasting is a separate capability. Automatic release remains optional unless proven necessary. |

<a id="hone_s_23"></a>
# 23. Current Executive Queue, Release Exits and Accountable Roles

| **ONE PROGRAM, ONE PRODUCTION MOVER** |
| --- |
| The customer outcome is the complete Willow WAIT journey, not a collection of clean components. Use §23.1 for the delivery exits and §23.6 as the single current product-priority list. Read-only planning and isolated preparation remain permitted within scope; final binding, proof and release retain their gates. Dedicated SMS cutover and every Trust/commercial boundary remain separate. [S19, S31, S33] |

<a id="hone_s_23_1"></a>
## 23.1 Delivery milestones and exact stop points

| **Order** | **Deliverable** | **Exit / gate** |
| --- | --- | --- |
| **NOW — TOP PRIORITY** | **LEVEL 3 — Full Willow WAIT Operating System** | Close the remaining Level 3 chain in order: retrospective Willow queue/provenance reconciliation + trustworthy owner control → WAIT-04B complete profile/verified mobile/STOP authority → supported Willow sender provisioning/adoption/test → **enforce the fixed 48h/no-expiry-choice policy** → WAIT-04C email+eligible SMS + WAIT 24h reminder → WAIT-04D four responses → first-consult cancellation/reschedule/no-show/exception rules → Chloe real-device acceptance. **Parallel release rule:** unrelated UI/UX, onboarding, sign-out and marketing units may refresh/gate/merge while this program continues. Only one production merge/provider/migration mutation occurs at a time, and each next release revalidates against the moved production head. |
| ~~NOW A~~ · **DONE 16 Sep** | ~~Close #709 at one exact head~~ | Completed: #709 merged, 0197 applied, and the P2 current-state migration record resolved. Original gate preserved for the record: "Fix only the remaining P2 current-state migration record; fresh exact-head Codex + CI; freeze runtime/0197 if clean." |
| NOW B, parallel | **WAIT-CONTINUITY-01 + owner-control design** | Restore Chloe’s waitlist discoverability without durable-enabling Willow; specify one server/database-owned Open / Waitlist / Closed intake mode. No production migration slot while #709 owns 0197. |
| ~~RELEASE 1~~ · **DONE 16 Sep** | ~~0197 hosted preflight → apply → verify → reconcile~~ | Completed under its stated gate. Hosted max moved to 0197, and then to 0198 through #713. Original gate preserved for the record: "exact 0197 bytes/checksum; service-role gateway privilege proof; explicit Sam T3 GO; hosted max becomes 0197 before application merge." |
| ~~RELEASE 2~~ · **DONE 16 Sep** | ~~Merge/deploy #709~~ | Completed. No Willow enablement and no provider action occurred, exactly as the gate required. |
| ~~PROVE~~ · **DONE 16 Sep** | ~~Resume the same test-studio canary~~ | Completed as **CANARY_PASS, 12 of 12 seams**: capacity → invite → proof → scoped slot → booking/conversion → reload truth, with the second invite refused when full. Cleanup complete. Journey proof only — not user acceptance. |
| MIGRATE WILLOW | **Continuity + owner setting + queue reconciliation** | ⚠️ **AMENDED 2026-09-19 — THE LAST STEP ALREADY HAPPENED.** This directed an operator to reconcile the existing legacy/email-only people, preserve original priority/provenance, show Chloe the resulting list, and only afterwards switch the durable path on. Durable WAIT was enabled on or before 2026-08-25, *before* any of the reconciliation steps that were supposed to precede it. **The reconciliation is now owed retrospectively, not as a gate**: the legacy email-only window, priority/provenance for those people, and showing Chloe the resulting list all remain outstanding. Never use navigation disappearance as migration. |
| COMPLETE WAIT LAUNCH | **WAIT-04A–D accepted policy** | Finish profile/legacy completion, four response choices, fixed 48h + 24h reminder, eligible email+SMS/STOP and first-consultation rules; approved real canaries and Chloe device acceptance. Only then mark Willow WAIT launch DONE. |
| THEN | **MultiPlex → September 7 batch**; FIN-02 continues isolated preparation | MPX-01 field contract first, then migration-first MPX-02/03 and TM payoff; Chloe acceptance. FIN keeps its shared-snapshot contract and gets no production slot ahead of MPX unless Sam explicitly reorders. |
| LATER | Calibrated wait estimate, ADMIT assisted/automatic and broader self-service | Evidence-driven sequencing. ONBOARD-04/Laura readiness may be proved synthetically in parallel, but real studio activation retains Gate B and its own release boundary. |

Planning checkpoint: Sam names the integration owner before assembly; that owner records the next integrated demonstration, remaining critical-path work and any evidence-supported internal target. Scope, acceptance and target changes are dated. Preparation must not wait merely for unrelated merges, but no preparation status is promoted to production readiness. [S33]

<a id="hone_s_23_2"></a>
## 23.2 Accountable roles and session handoff

Roles persist across terminal layouts. The old eight-pane assignment is preserved in F.7.3 as a historical handoff, not live telemetry. Record current pane, session, worktree, branch and revision only in the dated session handoff. No software staffing assignment is inferred from a terminal title. [S33]

| **Role** | **Accountable person / assignment** | **Responsibility and boundary** |
| --- | --- | --- |
| Product and release decision owner | Sam | Owns accepted scope, priority, bounded stop/re-entry decisions and explicit production authorization. Keeps one production mover. |
| Practitioner acceptance owner | Chloe for Willow | Confirms workflow and device acceptance against the agreed contract; records the result in ACCEPT-001. |
| Component / follow-on builder | Named per authorized unit | Owns assigned files and bounded repair; supplies tests and handoff. Cannot certify independent acceptance of authored changes. |
| WAIT integration owner | Sam to designate before assembly; not identified by this edit | Owns file overlap, dependency assembly, live adapters and the complete acceptance matrix. Prepares isolated fixtures under current scope; requests final independent review. |
| Independent acceptance reviewer | Named for the exact candidate; no authorship conflict | Attempts to falsify the protected behavior and records revision/environment/findings. No silent edit or self-acceptance. |
| Release / operations operator | Sam or separately authorized named operator | Runs approved preflight, migration/deployment/enablement, canary and rollback checks. Provider and customer actions need their own authority. |

Session handoff: role; owner; unit; worktree/branch; local and remote heads; dirty/unpushed work; environment/resource ownership; exact evidence; unresolved finding; last authorized action; next checkpoint; HOLDs. Preserve FIN/HIST/COMMS work when roles move. Confirm authorship before assigning a reviewer. [§2.1]

<a id="hone_s_23_3"></a>
## 23.3 GO / HOLD / STOP

| **Gate** | **Meaning** |
| --- | --- |
| GO — authorized development | **Level 3 WAIT** bounded work is authorized as the primary product program: retrospective reconciliation/discoverability, WAIT-04B profile + verified-mobile/STOP authority, supported sender provisioning/adoption/test, WAIT-04C dual-channel + 24h reminder, WAIT-04D response UX and first-consult boundaries. **Parallel ONB/UI/UX/SIGNOUT/marketing units may build, review and ship when independent and exact-head clean.** Provider effects, customer sends and any new migration still require their own exact gates. |
| HOLD — release / activation | Real provider sends and WAIT-04 effective policy each require their exact current gates and separate human authorization. ⚠️ **Willow durable enablement is NO LONGER ON THIS HOLD** *(corrected 2026-09-19)* — it was taken on or before 2026-08-25. What is held in its place is the **data reconciliation** that was supposed to precede it, and the **governance record** it never received. The 0197 apply and #709 merge this row previously held are **done**; the hold now covers what follows them. |
| HOLD — numbering | **SUPERSEDED 2026-09-17 — recorded, not deleted.** The hold read: "0197 is allocated to #709 and remains pending; hosted max is 0196. Treat 0198 as next-free only after 0197 apply/verify/reconcile releases the migration lock." Both 0197 and 0198 are now applied, `0199` followed on 2026-09-18, and ⚠️ **as of 2026-09-20 `0200` is applied too**, so hosted max is **`0201`** (⚠️ advanced again 2026-09-20 when the `0201` authority contraction was applied). **the next free number is NOT stated here** — it was stated as `0200`, and `0200` was then allocated and applied; derive it with `npm run migration:state`. WAIT-04, MPX and FIN still do not claim a number from this document; S1–S5 migrations require a new single-allocator decision. |
| STOP — evidence or authority failure | Moved authorized head/base; unexpected hosted/provider state; uncertain billable effect; conflicting ownership or shared DB contention; malformed/unavailable facts treated as success; bearer/identity bypass; stale review treated as current; same-family or scope threshold without recorded re-entry. |
| No hidden waiver | User urgency and build authorization do not bypass §7 stop laws, independent authority proof, Gate B, consent, provider readiness, migration checks or production-concurrency-one. No unattended T3/T4 release. |

<a id="hone_s_23_4"></a>
## 23.4 Integration and production release packet

Packet must name: exact production SHA; all component/follow-on SHAs and parents; changed-file overlap/merge plan; final numbered migration order and checksums; actual hosted preflight; feature/policy versions and flags; invitation/proof/SMS binding; data/export/retention dispositions; executed test matrix and failure controls; independent reviewer; legal/provider/human limits; controlled canary recipients; rollback/kill switch; and user acceptance owner.

Migrations **0192–0201 are recorded hosted/applied**; never edit any of them. 0197 (the Invitation-capacity consumed-count gateway, #709) and 0198 (the live-invitation read, #713) completed the WAIT-03 chain, **`0200` (WAIT-P1-EXIT, the redeemed-but-unbooked escape hatch, #741) was applied 2026-09-20** from the reviewed head `6de5fb4c`, and **`0201` (its forward authority contraction, #747) was applied the same day** — 0201 does not edit 0200, it redefines the command so the exit stops reading `public.appointments` at all. ⚠️ **THIS DOCUMENT NO LONGER STATES THE NEXT FREE NUMBER, DELIBERATELY.** It named `0200` as free while `0200` was being allocated, which is the exact hazard that already cost this programme once when `0199` was applied while the canonical docs still called it available. The next free number is **DERIVED, never transcribed**: run `npm run migration:state`, and read the hosted head from `docs/production/migration-state.json`. A number is claimable only by that fresh derivation plus a single-allocator decision, never by assumption and never from this line. `0199` (WAIT S3 reminder candidate selection) was applied 2026-09-18 from the reviewed #716 head and reconciled into the tree on 2026-09-19; **#716's routing runtime remains unmerged and on HOLD.** The 0194 schema extracted from the communications work is applied, but #674 runtime sender routing/cutover remains a separate provider operation that no one has performed; schema presence is not provider readiness. Additional WAIT-04/MPX/FIN migrations require a new single-allocator decision. [S42]

A completed provider call must be labeled accepted, delivered or unknown according to evidence. The first live journey must include both a booking and a non-booking response, a no-response/delivery-failure protection check, cancellation/re-entry, and a manually confirmed no-show restriction/exception on approved synthetic data. No unapproved real client is used as a test fixture.

<a id="hone_s_23_5"></a>
## 23.5 Long-term destination unchanged

Treatment Memory remains the moat. Complete trustworthy historical preparation only under accepted HIST re-entry; make Visit Closeout/Rebooking the daily loop; deliver truthful Financials and Practice Health; use measured demand for assisted admission and only then opt-in automation; prove safe import/export/offboarding and repeatable studio activation. Paid design-partner learning and operational evidence precede broad self-service. Forecasting is a useful extension, not a reason to delay the minimum accepted WAIT journey. [S18, S19]

<a id="hone_s_23_6"></a>
## 23.6 Single Current Product Sequence — Work Plan v3 retained

This is the sole maintained product-priority list. Sam’s Work Plan v3 ordering and v1.13 delivery discipline are retained. The v1.14 supporting developer-platform sequence is §23.7, not a replacement product queue. The operating brief, §14 and feedback records refer here. §23.1 defines exits, §23.3 GO/HOLD/STOP, and §23.4 the release packet. None is a production authorization. [S31, S33–S35]

| **#** | **Item** | **IDs** | **State / gate** |
| --- | --- | --- | --- |
| 1 | **LEVEL 3 — Full Willow WAIT Operating System** | ~~#709/0197~~ done; ~~test-studio canary~~ done; ~~#741/#747 exit~~ done; ~~#748 48h default~~ done; fixed/no-choice 48h policy open; ~~#749 sender status~~ done; WAIT-CONTINUITY/owner control; retrospective Willow reconciliation; WAIT-04B/C/D; Chloe acceptance | **TOP PRODUCT PRIORITY, NOT A GLOBAL RELEASE FREEZE.** Level 1 durable queue and Level 2 Invite-to-book software are shipped. Finish the complete Level 3 chain in §23.1; do not call WAIT DONE from email-only Book/Decline or sender-status visibility. Independent UI/UX/onboarding/sign-out/marketing releases may ship concurrently through the serialized release conveyor. MultiPlex starts after Level 3 is operationally accepted. |
| 2 | MultiPlex capture | MPX-01 → MPX-02 → MPX-03; MPX-04/05 payoff | THEN, after Willow WAIT launch is operationally accepted. Chloe field interview first; TM-01 contract check; migration-first; on-device acceptance. |
| 3 | Chloe 7 September evening batch: bugs → friction → features | DASH-NOTE-01/02; FLOW-03 checkout; RECORDS-01 action; NOTIF-PREFS-01; CLIENT-STATUS-01; BOOK-PRIVACY-01 | After MPX. One PR per item; §14.6.1 definitions; no production slot before rows 1 and 2. |
| 4 | Financials | FIN-02A / FIN-02B (§14.8) | Parallel preparation only; production slot follows MPX unless Sam reorders; no #666 fallback; no migration number from this document. |
| 5 | Deferred by Chloe | BULK-MSG-01; granular availability; WAIT-FORECAST-01 | Not now. |
| 6 | Visual Treatment Memory | VISUAL-01 / 02 / 03 (§14.9) | Post-WAIT product experiment; no vgpu dependency before VISUAL-02 proof (§21). |
| 7 | Business decisions still open | Paid consults; consult value-add (§17.7) | Chloe decides; not build items. |
| 8 | Open product decision | WAIT-INTAKE-01 interest/readiness level (§0.7, §14.6.1) | Decide before the richer WAIT intake binds: add as a structured select or explicitly drop. |

**Product-wide design programme — subordinate to Level 3 WAIT.**
**UX-01 is SHIPPED** (#743). **UX-02 remains an AUTHORIZED candidate**
that must be refreshed and revalidated from then-current production before release;
if independent of the active WAIT unit, it may ship through the parallel release conveyor rather than waiting for Level 3 completion. UX-03 … UX-11 remain
`PROPOSED_DESIGN`: **PROPOSED / NOT SCHEDULED**, carrying **no implementation
authority**. **Appearing in the sequence never authorizes a
stage** — each needs its own acceptance recorded here. MOTION-01 remains a
**PILOT, not adopted**, and keeps its sequencing constraint. The contract and the
open design questions live in `DESIGN.md` (§0.4). No dates and no implementation
PR numbers are allocated by this entry.

**Rules that hold across the list. **

Production concurrency stays one **per merge/provider/migration action**, but development and release preparation are parallel. Level 3 WAIT owns product priority; independent ONB/UI/UX/SIGNOUT/marketing/support candidates may merge between WAIT release units after refreshing/revalidating against the current production head.

Migration truth is now: hosted/applied 0192–**0201** (⚠️ updated 2026-09-20 and advanced again the same day: `0200` is WAIT-P1-EXIT, #741, and `0201` is its forward authority contraction, #747 — 0201 does not edit 0200, it redefines the command so the exit stops reading `public.appointments`), with parity between hosted and repository maxima and nothing pending; **the next free number is NOT stated here** — it was stated as `0200`, and `0200` was then allocated and applied; derive it with `npm run migration:state`. The 0194 schema is applied through the WAIT assembly while #674 runtime routing remains a separate, unperformed provider operation. New WAIT-04, MPX-02 and FIN migrations remain unnumbered. The decision index (§0.4) is a pointer, not a second ledger.

Chloe's WAIT requirements are frozen (§14.5.7) and are now the **Level 3 execution contract**. No more product discovery on WAIT until that contract works end to end; reopen only for a real operational defect or an explicit Sam/Chloe product decision.

One PR per item; no item absorbs another; the six WAIT-03 PRs take only current-head blockers and new requirements go in the WAIT-04 slices.

Migration-first: migration applied and verified on hosted production before merged code reads the column; no production writes from Chloe's machine before that.

Strict CI gates on every PR; docs and registers updated in the same PR as the behaviour change.

Bind once, on one stable head, from a pane that did not review the pieces being bound.

Chloe on-device acceptance recorded in ACCEPT-001 per item before it is marked done.

Delivery reporting rule: name the customer outcome, the next acceptance event, its owner and the actual blocker. Keep the accepted WAIT contact, dual-channel, response and consultation rules intact; an email-only Book/Decline prototype is not the agreed Willow launch. Use §20 to measure pace. A new document edition, clean component or large test total does not count as that outcome. [S33]

<a id="hone_s_23_7"></a>
## 23.7 Supporting developer-platform rollout order

This is the order **within the supporting Developer Platform / Agentic Engineering workstream**, not a replacement for §23.6. WAIT remains the immediate customer outcome; MultiPlex remains next in the product sequence. Platform promotion follows safe WAIT checkpoints and the existing WIP/resource limits, without taking a product production slot or delaying an already-authorized customer outcome. [S35]

| **Order** | **Supporting work** | **Exit / accountable role** |
| --- | --- | --- |
| 1 | Context Mode + Herdr promotion | After current WAIT work is durably frozen and Sam schedules the rollout: inspect/simplify runtime machinery, prove fresh-session behavior and MCP reliability, then promote deliberately. Complete the separately authorized reboot/linger proof. Sam names the operator; §§3.7 and 16.7 retain the outstanding gates. |
| 2 | Graphify code-only pilot | Source-stamped local pilot and source spot-checks; adoption decision from usefulness and limits. No source edits, automatic hooks, always-on ingestion or production changes. Sam names the pilot owner. |
| 3 | Matt Pocock + Apple/Emil standardization | Reviewed selected skill manifest and workflow triggers; one Hone-owned `DESIGN.md` and agent-rule links using existing primitives. Owner assigned per bounded change; no runtime dependency or authority expansion. |
| Standing adoption | Archify in architecture reviews | Use the completed pilot's learning and accepted intended-architecture role. No repeat exploratory pilot; label proposed/implemented structure and tie it to evidence. |
| Later / gated | Executor | Resolve implementation/roadmap ownership, then satisfy the relevant scope and §16.5 re-entry proof before any build. Crash/retry/concurrency evidence and explicit human boundaries are required. |

**No new tool-installation sprint is authorized by this table.** The next concrete platform action is a named, bounded rollout/cleanup ticket at a safe checkpoint, not simultaneous work on all eight items. Existing WAIT acceptance, Trust/commercial gates and production-concurrency-one remain unchanged. Record terminal coordinates and transient heads only in the dated session handoff, not in this roadmap.

<a id="hone_s_23_8"></a>
## 23.8 Current parallel support lanes — subordinate to WAIT

These lanes may prepare **and, when independent and exact-head clean, ship** in parallel release lanes. **Level 3 WAIT is the primary product lane, not an exclusive production lock.** More panes still do not create simultaneous production mutations: merges/provider/migrations serialize at the final action.

| **Lane** | **Current treatment** | **Boundary** |
| --- | --- | --- |
| ONB + UI/UX + SIGNOUT | Continue bounded Day-1/onboarding and product-quality work in parallel with WAIT. | May refresh, gate and merge independently when there is no WAIT file/authority/migration/provider conflict. After any production move, revalidate the next exact head before merge. |
| Marketing successor architecture | Replace #744's parser/evaluator approach with the simpler declared-scope/truth-register successor. | Build/review in parallel and may ship when the successor is exact-head clean and independent. **Do not ship #744's failed parser architecture or resume its syntax-patch loop.** |
| Trust / security guard hardening | Preserve the IDOR/ACL audit evidence and close the bounded test-coverage defects before adding more privileged commands where practical. | No broad new audit and no competing migration unless separately scheduled. |
| Laura / ONBOARD-04 readiness | Run a synthetic fresh-studio path: owner/invite acceptance → service → availability → client → booking → chart/completion → email/test-payment posture. Correct the runbook’s missing mandatory accept-invitation step. | No real Laura mutation until launch is authorized; no hidden Sam-only configuration accepted as normal. |
| #699 Start charting / #704 groundwork | Keep reviewed resolver/guard groundwork preserved and inert. | No reachable CTA and no migration allocation until WAIT releases the migration lock; rebuild/revalidate from then-current production before release work. |
| Receipts | #702 automatic successful-card receipt + PDF is shipped; observe and use manual Send as recovery. | Cash/e-transfer/other-external PDFs, webhook-success automatic receipts and durable recovery are follow-ons, not WAIT blockers. |
| CI cost #688 | Keep prepared/held until the WAIT release train stabilizes. | No CI-governance change while a migration/release candidate is moving unless it is required to restore trustworthy CI. |
| FIN-02 | Continue only isolated FIN-02A/B preparation under the shared-snapshot contract. | Production slot follows MPX unless Sam explicitly reorders; no old #666 fallback. |
| Developer platform | Context Mode/Herdr/Graphify/skills follow §23.7 only at safe checkpoints. | No tooling installation or reboot may disturb the active WAIT release/canary. |

# Appendix A. Historical Artifact Disposition

| **HISTORICAL BASELINE  The original table is retained in Appendix F.5 as the historical artifact/disposition register. “Open”, “current”, “close”, “refresh” and old SHA references in it are NOT today’s instructions. Selected newly verified statuses are in §3; any other artifact must be fetched before action. Nothing in this appendix revives a failed delivery vehicle.** |
| --- |

The full original artifact table is preserved in Appendix F.5, including retired vehicles and their reasons. The live selected-PR register in §3 supersedes its old #647/#652/current-head claims. No historical row is silently promoted to a new authorization.

# Appendix B. Failed Smart/Calendar Workstreams - Preserved Contract

## B.1 Smart Scheduling / internal manual booking

Original requirement remains valid: Smart may suggest 15:10 while practitioner intentionally chooses 15:30 inside real working hours; 15:30 must book normally and must not be recorded as outside availability.

#589 repeatedly exposed stale windows, UNKNOWN-vs-CLOSED, date/target/capacity/timezone identity, buffer acknowledgement, duration authority, DST and two-surface drift.

#594 attempted a comprehensive browser controller and produced more authority/state defects; stop law correctly fired.

Final rebuild law: browser chooses candidate; server decides what candidate means. Re-evaluate after acknowledgement. Public booking/reschedule remain candidate-set-authoritative.

Do not reuse the state machine/controller architecture. Preserve regression cases, tests and authority discoveries.

Current PR #597 is a narrow correctness prerequisite, not the full SMART-01 rebuild: calendar weekday is a property of the requested studio-local date, not a fabricated UTC instant.

M1 is now a named authority gap: capacity-OFF studios do not receive the intended working-hours/blockout/eligibility enforcement from Postgres. Treat as separate T3 work with production preflight.

M2 is now a named integrity gap: booked_outside_availability conflates real outside-hours, buffer exception and custom-duration exception; buffer acknowledgement can disable future buffer enforcement. Separate exception semantics before both internal surfaces converge.

The final sequence is contract -> narrow parity fix -> DB authority/exception semantics -> both authenticated surfaces together -> Move/Reassign parity. Do not opportunistically bury M1/M2 inside unrelated UI work.

## B.2 Calendar appointment prep drawer

Original requirement remains valid: desktop click -> bounded prep workspace with current appointment, last treatment, narrative provenance, intake status, notes, reschedule/cancel/full details; mobile remains full page.

#588 failed because the drawer became a long-lived mutable mirror of server appointment state without version/currentness semantics.

Preserve requirements: fresh schedule/status, stored duration_minutes, failed refresh loses action authority, note write cannot visually revert, A cannot render beneath B, server canonical result/normalization, no week-level clinical bulk.

Final rebuild law: drawer may hold presentation state, but must not maintain a mutable server-state mirror whose correctness depends on value equality.

# Appendix C. Machine-Readable Roadmap Object Schema

| **ILLUSTRATIVE ONLY  The schemas below show record shape, not live READY work, executed code, accepted-state authority or production permission. Machine field names are examples pending the control-plane re-entry gates. Priority and defect severity are separate axes.** |
| --- |

```yaml
id: SEC-01B
title: Risk-adaptive public-booking possession challenge
milestone: TRUST-001
lane: trust
priority: NEXT
severity: P1
status: PRODUCT_CONTRACT
risk_tier: T3
source:
  - audit_2026_08_16
product_contract: >
  Knowledge of an existing client email is not sufficient proof of possession when the risk policy requires verification.
authority:
  identity_linkage: server
  challenge_verification: server
  rate_limit: server_and_provider
  ui_state: browser
dependencies:
  - AUTO-BOOT-001
  - SEC-01A
scope_budget:
  expected_runtime_files: 8
  expected_test_files: 6
  expected_loc: 900
  hard_review_runtime_files: 12
  hard_review_loc: 1500
acceptance:
  - no_email_enumeration
  - spoofed_known_email_challenged_when_policy_requires
  - duplicate_submit_safe
  - limiter_outage_bounded
evidence_required:
  - focused_tests
  - anti_vacuity
  - exact_head_ci
  - exact_head_codex
autonomy:
  implement: true
  repair_rounds: 1
  production_release: human_required
delivery_result: null
discovery_value: null
```

## C.1 Required finding record

severity | root_cause_family | introduced_by_branch | reviewed_commit | same_family_count | repair_round | runtime_or_evidence_classification | disposition

## C.2 Example product object - ADMIT-02

```yaml
id: ADMIT-02
title: Assisted new-client admission control
milestone: PRACTICE_OPERATING_SYSTEM
lane: product
priority: NEXT
status: BLOCKED
risk_tier: T2
source:
  - willow_capacity_analysis_2026_08_18
product_contract: >
  Hone may recommend exactly how many new clients can be invited, but the recommendation must be derived from defined capacity/admission metrics and the practitioner remains the release authority until assisted mode is production-accepted.
authority:
  metric_projection: server
  waitlist_claim: database_command
  invite_token: server_and_database
  practitioner_approval: authenticated_ui_input
  final_release_count: server_database
dependencies:
  - WAIT-02
  - WAIT-03
  - ADMIT-01
  - REBOOK-01
acceptance:
  - safe_to_invite_n_is_explainable
  - outstanding_invites_consume_budget
  - no_double_count_booked_and_latent_demand
  - invite_exactly_n_atomic
  - existing_client_booking_unchanged
evidence_required:
  - focused_tests
  - db_concurrency_proof
  - exact_head_ci
  - practitioner_acceptance
  - production_smoke
autonomy:
  implement: true
  repair_rounds: 1
  production_release: human_required
delivery_result: null
discovery_value: null
```

# Appendix D. Evidence Basis and Provenance

## D.0E v1.16 repository synchronization source and publication record

### S42 · Post-#712 production evidence, reverified at synchronization time

**Source ID allocation.** This record is **S42**, not S41. `S41` was already
issued by the v1.15 publication for its own source pair and accepted roadmap
update (see D.0D below), and that identity is preserved unchanged along with
every citation of it. Source IDs are append-only: a new evidence record takes
the next free number rather than reusing one.

Every fact in this edition's refreshed rows was read from its own authority on
17 September 2026, not carried from a summary. Nothing here was accepted on the
strength of an earlier document saying it.

| Fact | Authority read | Reading |
| --- | --- | --- |
| Production head | `origin/claude/build-hone-saas-hOex7` after `git fetch` | `a946a983ac9b8da379bc869e21b32a5a3d50e548`, the merge commit of #712 |
| #709 / #712 / #713 | GitHub API | all MERGED — #709 at 2026-09-16T11:47:08Z, #713 at 2026-09-16T21:09:49Z, #712 at 2026-09-17T00:39:19Z |
| Hosted migration max | `docs/production/migration-state.json` | `hosted_migration_max` = `0198`; no server-generated apply timestamp was captured, so none is asserted |
| Apply records | `docs/production/migration-ledger.md` | apply records present for both 0197 and 0198 |
| Repository migration max | census of `supabase/migrations/*.sql` | `0198`, 197 files, no `0199` present |
| Serving deployment | Vercel deployment metadata resolved by hostname | `dpl_H1ZcHgPARRR8csuN9yRscgiqY7fZ`, READY, `meta.githubCommitSha` = `a946a983…`, exact 40-character match |
| Canary | durable release record, post-0198 controlled run | CANARY_PASS, 12 of 12 seams; POST_CANARY_CLEANUP complete |
| WAIT-04 seams | post-WAIT-04A remaining-gap census | S1 partial (2 of 4 responses), S2 partial, S3 dormant and needing provider proof, S4 partial/not built, S5 not built, S6 needs human acceptance |

**Evidence limits, stated rather than glossed.** The canary ran on the controlled
test studio with a synthetic identity; it is not customer acceptance and not Chloe
device acceptance. The twelve-seam pass involved **no provider send** — no real
SMS, no STOP exercise, no sender cutover — so it says nothing about provider
readiness. A2P/10DLC remains unmodelled. Willow was not touched, not queried by
identity, and **no durable cutover was performed**. The hosted apply instants are
operator-observed client-side windows, never server apply times, exactly as
`migration-state.json` records. Nine SECURITY DEFINER commands remain applied to
production with no caller; #712 closed three of twelve such gaps and the rest are
dormant, which is not the same as shipped.

**What this synchronization did not do.** No runtime code, database, migration,
provider or production state was changed. No migration number was allocated. No
test unrelated to roadmap publication was modified. No product priority was
reordered. No frozen developer-platform tool was promoted.

## D.0D v1.15 WAIT-03 production/canary source and publication record

### S37 · Current conversation + controlled production/canary evidence

Source: Sam’s 15 September 2026 release session and screenshots in this conversation. OPERATOR_REPORTED observations: hosted migrations 0192–0196 applied/verified; Vercel Production deployment bound to source `a47eca0f8ec08718aa16b8a18e95e0416778418d` with `hone.care` / `www.hone.care` aliases and public smoke; test studio `my-studio-9d37c5` enabled for WAIT + durable WAIT; signed-in Waitlist tab and public intake rendered; one controlled entry joined and remains `Waiting`; Invite-to-book reached the composer but failed closed with `no_admission_round`; no provider activation or real message was part of the activation.

The same source records that Willow’s existing legacy waitlist remained enabled/preserved and Willow durable mode remained OFF, while Chloe observed that the Settings Waitlist navigation disappeared. Sam had to show her that the underlying list/data still existed. This is product/acceptance evidence for WAIT-CONTINUITY-01, not proof of data loss. Sam accepted the direction that normal studios need a self-service New client intake control rather than founder-managed per-studio Vercel slug edits.

### S38 · #708 final WAIT release assembly and current production ref

Fresh GitHub evidence read for v1.15: protected production branch `claude/build-hone-saas-hOex7` at `a47eca0f8ec08718aa16b8a18e95e0416778418d`, merge commit for PR #708, “FINAL WAIT RELEASE ASSEMBLY — production ⊕ #703 (carries #695 + #701), migrations 0192→0196.” Repository ancestry proves the code merge; hosted apply/deployment remains S37 operator evidence.

[PR #708](https://github.com/SaiSamyukthVemuri/Hone/pull/708)

[Pinned production commit](https://github.com/SaiSamyukthVemuri/Hone/commit/a47eca0f8ec08718aa16b8a18e95e0416778418d)

### S39 · #709 Invitation-capacity repair / pending 0197

Fresh GitHub evidence read for v1.15: PR #709 is OPEN/DRAFT and mergeable. Captured reviewed head `4aad63ac47f21e82999199a752f8a98780fd7a0e` carries migration 0197 and the Invitation-capacity UI/authority repair. Exact-head CI run #2022 (`35038476358`) completed SUCCESS. The clean-chain DB lane and previously failing delivery-status browser shard passed on this head. Codex’s remaining fresh finding at capture is P2 `4021340016`: the current migration-state record still contains a stale “pending none / parity” row despite repo max 0197 / hosted 0196 / pending 0197. 0197 is **AUTHORED/PENDING, NOT HOSTED**; no merge/apply is authorized by this record.

[PR #709](https://github.com/SaiSamyukthVemuri/Hone/pull/709)

[CI #2022](https://github.com/SaiSamyukthVemuri/Hone/actions/runs/35038476358)

### S40 · #702 automatic card receipt + PDF

Fresh GitHub evidence: PR #702 is merged. Its product contract: when a newly committed card charge succeeds, Hone automatically sends the existing HTML/text receipt email with one studio-branded Hone-generated PDF attachment. Manual Send receipt remains recovery; webhook-only success, cash/e-transfer/other-external triggers and durable background recovery remain explicitly separate gaps.

[PR #702](https://github.com/SaiSamyukthVemuri/Hone/pull/702)

### S41 · v1.15 source pair and accepted roadmap update

Source files supplied by Sam for this update:

- `HONE_CANONICAL_ROADMAP_v1_14_DEVELOPER_PLATFORM(3).md` — SHA-256 `356b3ceda49850b26b6729d0a140100a5f5afd3809c625c7d3437d06e08cf2e2`.
- `HONE_CANONICAL_ROADMAP_NORTH_STAR_v1_14_DEVELOPER_PLATFORM_EDITION(2).docx` — SHA-256 `10367ba9b430279a87e5a966db3dbc50766e2b3726f8628152d847c855cef677`.

Sam’s current instruction is to update the canonical roadmap using the progress made since the 9 September edition. Accepted current sequencing remains **WAIT first → MultiPlex → September 7 batch**, with isolated Financials preparation. The WAIT row is now refined into #709/0197 release, same-entry canary completion, continuity/owner control, Willow reconciliation/migration and WAIT-04 completion before Willow launch is marked DONE. Parallel lanes remain subordinate to the one production mover.

### v1.15 publication result and scope

Full updated Word and matching Markdown editions prepared as v1.15. Intended reviewed repository destination remains `docs/roadmap/CANONICAL_ROADMAP.md`; synchronization is **PENDING**. This document update performs no repository write, PR mutation, merge, hosted migration, deployment, provider action, Willow enablement or customer send. Mutable production, hosted and PR facts must still be revalidated at the action boundary.

## D.0C v1.14 developer-platform source and publication record

### S34 · Attached v1.13 source pair

`HONE_CANONICAL_ROADMAP_v1_13(1).md` — SHA-256: 5bbf321104f47ceabdb394f56f2d46e21d2932b6f8c3689300af511e03b1d4a5.

`HONE_CANONICAL_ROADMAP_NORTH_STAR_v1_13_DELIVERY_EDITION(1).docx` — SHA-256: 32e03671f400b664e71addc70158dd6d568c4e1b8e56ff20b1e7f780283b9acc. The supplied Word edition was 119 rendered pages.

These are the preserved full roadmap sources for v1.14. Existing North Star, IDs, fact-domain authority, dated production/hosted checkpoint, product ordering, CP retirement/re-entry conditions and Appendices A–F are retained. No refreshed production, provider, paid-studio or code-review census is claimed.

### S35 · Accepted developer-platform amendment and supplied canary evidence

Source: Sam's current instruction, “ok update this add all this,” with the pasted Developer Platform / Agentic Engineering backlog, plus the supplied 9 September local / 10 September UTC Context Mode and Herdr terminal screenshots in this conversation. Acceptance applies to backlog inclusion, the stated tool roles and supporting sequence; it does not turn a pilot into fleet-wide installation or a suggested terminal command into execution evidence.

The screenshots record the canary identities, versions, doctor checks, large-output task, memory/compaction interaction, service recovery, MCP connection failure and manual reconnect, and final Node 20/native Bash versus Node 22/actual MCP result. The working dispatcher paths are user-wide. Record functional canary success with those limits; no isolated performance benchmark, filesystem security boundary or reboot pass was supplied. §3.7 is the observation home, §§16.6–16.8 the tooling contract, and §23.7 the supporting sequence.

### S36 · Prior tooling decisions — selectively retrieved, historical

`HONE_DETAILED_NEXT_CHAT_HANDOFF_2026-08-27.md`, §§26–29: operator-local Apple skill, existing Emil skills/local patches, reported successful Archify pilot and Graphify's still-pending code-only plan. The Graphify plan excludes docs/media ingest, read-blocking and post-commit hooks, and always-on indexing; temporary output was proposed under `/tmp/hone-graphify/` with a source SHA. A retained result/handoff must not rely on temporary storage alone.

`Pasted markdown(20260905-180554).md`: prior tooling-stack decision and the seven named Matt Pocock skills. Only the items requested in the current amendment are carried into the new workstream. Other historical tool recommendations and old release/pane sequences from these sources are not revived. These are records of prior decisions/reports, not newly executed pilots or current upstream verification.

### v1.14 publication result and scope

Full updated Word and matching Markdown editions prepared as v1.14. Intended reviewed repository destination remains `docs/roadmap/CANONICAL_ROADMAP.md`; synchronization is **PENDING**. No repository write, PR, commit, merge, host/tool installation, migration, deployment, provider action or customer send was performed by this document update. No new operational status is inferred from its publication date.

## D.0B v1.13 editorial source and publication record

### S32 · Attached v1.12 source

HONE_CANONICAL_ROADMAP_NORTH_STAR_v1_12_2026-09-08_CONSOLIDATED.docx. Source length: 113 rendered pages. SHA-256: ece4316e7153e435f19f2658e3b8e9efd59a991e534144bdf7dae88506f055c2

Retained source for roadmap IDs, North Star, program contracts, Gate A–E, evidence classes, dated §3 checkpoint, Work Plan v3 priorities and historical archive. v1.13 does not refresh the source’s GitHub, hosted, provider or commercial observations.

### S33 · Accepted document critique and editorial direction

Source: Sam’s pasted assessment of v1.12, the assistant’s qualified response, and Sam’s subsequent instruction: “ok update the document with all this.” Accepted editorial actions: two-page positive operating brief; one maintained Markdown edition with derived publications; one current priority list; correction of contradictory active FIN sequencing; five outcome-based readings with explicit missing evidence; role-based ownership; application of existing stop laws rather than more process machinery.

Qualifications preserved: supervised pilot is not blanket safety certification; independent paid proof is not a verified customer census; roughly three weeks of waitlist growth does not establish engineering age; prior completion percentages/time promises lack a measured integrated plan. No new scope, legal ruling, software implementation, repository sync or production change is established by this edit.

Publication result: full updated DOCX plus matching full Markdown prepared locally. Repository destination: docs/roadmap/CANONICAL_ROADMAP.md. Commit/PR/reference: NOT CREATED by this task. Reviewed synchronization remains pending; a later publisher must record its actual version/commit. The edition is a document update, not a new operational census.

## D.0A v1.11 source register — decisions, source and observation limits

Evidence capture is revision-specific. GitHub metadata establishes PR/ref/merge facts; PR bodies are attributed construction reports, not current code-review verdicts. Selected pinned files correct stale prose. CI runs establish only the returned run status at the captured SHA. Current conversation decisions are product authority, not implementation evidence. No fresh hosted or provider query was made.

### S18 · Attached v1.10 source

HONE_CANONICAL_ROADMAP_NORTH_STAR_v1_10_2026-09-06_RECONCILED(1).docx · 88 source pages. SHA-256: 6ab4d8e21c0086eab0d749a6b3644b7ca25096d08f00ce116aa38a9cff599304

Base organization, terminology, all retained IDs, North Star, trust/portfolio/release laws, Gate A–E, historical evidence and Appendix F. Unmodified source preserved separately; this v1.11 is an updated standalone edition.

### S19 · Current conversation and user-supplied terminal evidence

Sam’s WAIT priority and execution approval; Chloe’s Claim rejection; required first/last/email/mobile, controlled areas and availability; dual SMS/email; four responses; fixed 48h policy and 24h reminder; cancellation/new-priority, no public consult reschedule and permanent clinic no-show restriction with manual exception; question about wait-time estimation. Screenshots preserve local FIN handoffs, changing heads, review families, self-authorship conflicts, database sharing and integration assignments. Statements remain USER_REQUIREMENT, ACCEPTED_PRIORITY or OPERATOR_REPORTED as appropriate; no raw screenshots are promoted to hosted proof.

### S20 · Production source ref and current production model

Production ref cc576f71287a09943e47f4351d96dfa3a0d04dee; protected branch. Current production action model says Set aside for release from claimed and Return to waitlist only for requeue.

[Pinned production commit](https://github.com/SaiSamyukthVemuri/Hone/commit/cc576f71287a09943e47f4351d96dfa3a0d04dee)

[Pinned production waitlist action model](https://github.com/SaiSamyukthVemuri/Hone/blob/cc576f71287a09943e47f4351d96dfa3a0d04dee/lib/waitlist/admission-model.ts)

### S21 · Newly merged product work

[PR #667 · Client Profile touch/focus adoption](https://github.com/SaiSamyukthVemuri/Hone/pull/667)

[PR #678 · WAIT lifecycle exposure and pagination](https://github.com/SaiSamyukthVemuri/Hone/pull/678)

[PR #684 · Hide internal Claim model](https://github.com/SaiSamyukthVemuri/Hone/pull/684)

PR metadata verifies merge commits/times in §3.1. Source detail outranks older PR-body wording. No new current-user or serving-artifact test performed by this amendment.

### S22 · #681 / 0192 recipient-proof authority

Open/draft/unmerged at 7c7f6c5b73a10c7bef03c628124b11c6e5a10b57. Body reports numbered-chain construction, capability/challenge split and WAIT number ownership; it is not fresh hosted proof.

[PR #681](https://github.com/SaiSamyukthVemuri/Hone/pull/681)

### S23 · #682 / B2 and pinned proof interface

Open/draft/unmerged at 9b2d243bfaf793a07a11ee002bb268ed1a8f1d66. Pinned source explicitly returns proofChallengeId and rawChallenge; old missing-id prose is superseded. PR contract explicitly records consume-before-book and operator recovery.

[PR #682](https://github.com/SaiSamyukthVemuri/Hone/pull/682)

[Pinned B2 server interface](https://github.com/SaiSamyukthVemuri/Hone/blob/9b2d243bfaf793a07a11ee002bb268ed1a8f1d66/lib/booking/waitlist-invitation.ts)

### S24 · #683 / B4 practitioner surface

Open/draft/unmerged at 962dcb46c6805a2fc3555abdedb24e7d9da76279. Unwired adapter contract and UI construction reported; later WAIT-04 policy not yet implied.

[PR #683](https://github.com/SaiSamyukthVemuri/Hone/pull/683)

[Exact-head CI #1855 · SUCCESS at capture](https://github.com/SaiSamyukthVemuri/Hone/actions/runs/34176668090)

### S25 · #685 / 0193 admission and preferences

Open/draft/unmerged at 04990b5dbda0f730e19df94a2bf8c8b829f21445. Atomic claim/issue, provenance, preference and lock-order repair history. PR body retains earlier test counts; these are not relabeled as new-head independent runs.

[PR #685](https://github.com/SaiSamyukthVemuri/Hone/pull/685)

[Exact-head CI #1857 · SUCCESS at capture](https://github.com/SaiSamyukthVemuri/Hone/actions/runs/34177180308)

### S26 · #680 Delivery and #686 recipient experience

#680 open/draft at f978bd81fbf62e8975d5bd1894f032b35cba0146; #686 open/draft at f31146ae20770a4f6c7ef04c50963609088264a2. Bodies explicitly separate email-only transport and unwired recipient proof delivery. Construction/repair history is attributed; final clean review not asserted.

[PR #680](https://github.com/SaiSamyukthVemuri/Hone/pull/680)

[Exact-head #680 CI #1856 · SUCCESS at capture](https://github.com/SaiSamyukthVemuri/Hone/actions/runs/34177177645)

[PR #686](https://github.com/SaiSamyukthVemuri/Hone/pull/686)

[Exact-head #686 CI #1858 · IN PROGRESS at capture](https://github.com/SaiSamyukthVemuri/Hone/actions/runs/34177392848)

### S27 · Migration and SMS numbering evidence

Production migration-ledger.md at cc576f71 carries the 2026-09-06T16:03:53Z hosted observation, not a new one. #674 changed-file census and pinned 77a92fc0 source establish the renumbered 0194 file; old 0192 PR/ledger references remain stale. No global local-worktree next-number allocation or apply is inferred.

[Pinned production migration ledger](https://github.com/SaiSamyukthVemuri/Hone/blob/cc576f71287a09943e47f4351d96dfa3a0d04dee/docs/production/migration-ledger.md)

[Pinned #674 migration 0194](https://github.com/SaiSamyukthVemuri/Hone/blob/77a92fc0f71db212b8fa4dc06a90bd34508387e6/supabase/migrations/0194_studio_sms_sender_outbound_lookup.sql)

### S28 · Existing-sender adoption and configuration

#676 verified merged as 4997f9a7; #677 verified open/unmerged at ba27a1bf. Engines and prerequisites, not provider activation evidence.

[PR #676 adoption](https://github.com/SaiSamyukthVemuri/Hone/pull/676)

[PR #677 configuration](https://github.com/SaiSamyukthVemuri/Hone/pull/677)

### S29 · Preserved FIN / source-authority work

#666 metadata open/unmerged/non-mergeable. #668 open/unmerged at e436e09f. FIN local candidate/handoff evidence comes only from S19; those files were not read here. #672 financial contract remains the existing retained design source S8.

[PR #666 reference prototype](https://github.com/SaiSamyukthVemuri/Hone/pull/666)

[PR #668 documentation candidate](https://github.com/SaiSamyukthVemuri/Hone/pull/668)

### S30 · Bounded new-PR discovery

GitHub repository PR search for created >= 2026-09-07 returned total_count 9 and incomplete_results false at capture, covering #678–#686. No WAIT-04 PR was established by that bounded search. This does not establish absence of local branches, work outside the search window or later pushes.

No new external legal/provider-policy research was used to rewrite the product contract. Consent, accommodation, privacy and commercial requirements already discussed are carried as implementation/activation checks, not a legal-compliance certification. All links above are source records; later PR-page updates do not change the immutable SHAs captured in §3.

### S31 · Work Plan v3 and the 7 September recorded session

Hone Work Plan v3 (Hone_Work_Plan_v3_2026-09-07.docx, prepared with Claude on 7 September 2026) consolidating: the recorded Chloe session (four voice notes, 7 September 9:30 PM, auto-transcribed); Sam's instruction that MultiPlex is Chloe's next priority after the waitlist; Chloe's waitlist policy inputs (already S19); the WAIT status and frozen-contract material of the same evening; and the Visual Treatment Memory / vgpu review. Sam's 8 September instruction: v3 is the most important immediate list of items to work now; consolidate it with the North Star document.

Observation limits: the transcript quality is poor and the items were read by Sam and Claude, so ambiguous rows are confirmed with Chloe before scoping. v3's statement that #674 also claims 0192 is superseded by S22-S27 (#674 carries 0194). No repository, database, provider or GitHub state was read for this edition; §3 revisions are carried from v1.11 unchanged.

## D.0 Historical v1.10 source register — retained provenance

The following S1–S17 entries describe the v1.10 source basis. Their old current-head, assignment and proposal wording is historical. New facts and accepted decisions are S18 onward; no re-read of an old report refreshes its observation time.

**S1 · Attached v1.9 source, 88 pages**

User-provided DOCX; original SHA-256: 82fd9f8330f747b6dd0e22624712cfcaafd2480234b095adafeae73dfe40e43f. Standing North Star, portfolio, stop laws, programs and historical evidence. Source snapshot dates range from August 18 to September 4, not current runtime.

**S2 · Production branch ref**

Fresh GitHub ref; ea70bd0543993937ba42259037c903fac6c6fc15. Proves repository branch state, not deployed artifact.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/commit/ea70bd0543993937ba42259037c903fac6c6fc15)

**S3 · Canonical migration record**

Pinned production source. Records hosted observation 2026-09-06T16:03:53Z: 0191 / 190 rows / 0192 absent / sender rows zero. No new hosted query in this amendment.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/blob/ea70bd0543993937ba42259037c903fac6c6fc15/docs/production/migration-state.json)

**S4 · PR #674 current candidate**

Read at head f26a2fef1396a52733930976e45996f56574a649. Open/unmerged, base ea70bd0543993937ba42259037c903fac6c6fc15. PR body includes historical test evidence and explicit Willow HOLD.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/pull/674)

**S5 · PR #675 merged apply-record reconciliation**

Merged at ea70bd0543993937ba42259037c903fac6c6fc15 on 2026-09-06T17:06:05Z. Scope docs/tests only.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/pull/675)

**S6 · #674 CI and review provenance**

Run #1770 / 34049932690 at f26a2fef1396a52733930976e45996f56574a649 completed SUCCESS when re-read. Exact-head Codex reported the Willow sender cutover P1 at 17:56:46 UTC (review comment 3944782249); no clean review verdict. Prior green #1769 / 34048199544 tested 2be47afc. Reviews must be bound to original reviewed commits; earlier docs findings at 2be47afc are not new-head findings merely because re-anchored.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/actions/runs/34049932690)

**S7 · Current conversation decisions and Chloe messages**

Sam’s explicit Twilio → WAIT → FIN order; latest two-lane assignment; Chloe’s 6 September 12:25/12:44 messages pasted by Sam, timezone unspecified. User requirements, accepted priority and assistant-proposed defaults are distinguished. No completed new WAIT contract was supplied.

**S8 · FIN contract and held prototype**

PR #672 merged design; #666 open/unmerged prototype. Pinned detailed financials-domain-contract.md governs single-snapshot, invoker/RLS, pricing/time and oracle semantics.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/blob/ea70bd0543993937ba42259037c903fac6c6fc15/docs/product/financials-domain-contract.md)

**S9 · WAIT-03 delivery and caller boundary**

PR #664 verified merged. Its post-merge record identifies join/remove as wired and the other lifecycle commands as database-ready; no owner acceptance claimed. Production queue/actions confirm the limited surface.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/pull/664)

**S10 · Current candidate environment example**

Pinned f26a2fef1396a52733930976e45996f56574a649 example now leaves legacy sender keys inert and names ACTIVE database routing.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/blob/f26a2fef1396a52733930976e45996f56574a649/.env.local.example)

**S11 · Current candidate migration ledger**

Pinned f26a2fef1396a52733930976e45996f56574a649. Current table repo 0192/pending [0192]; older paragraph inside current 0191 narrative still says absent/pending empty. Historical September 4 table restored.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/blob/f26a2fef1396a52733930976e45996f56574a649/docs/production/migration-ledger.md)

**S12 · COMMS-01B foundation**

PR #673 verified merged; body describes one-claim/one-number, fencing, provider-test gates, inherited-test limitations and unperformed real provider exercise. Body’s old 0191-pending state is superseded by S3.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/pull/673)

**S13 · Parked UI candidates**

PR #667 open at 21652f15; PR #669 open at 525c30d2. Metadata fresh; not an independent re-test or delivery claim.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/pull/667)

**S14 · SEC-01A draft**

PR #665 verified draft/open at f44252e4. Contract does not close possession proof. Its SEC-01C label conflicts with retained roadmap abuse-bound scope; explicit reconciliation required.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/pull/665)

**S15 · TRUTH-01B-1 export slice**

PR #647 verified merged; explicit limited expansion, no complete/binary archive claim.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/pull/647)

**S16 · FIN-01B headline correction**

PR #652 verified merged; label correction only, arithmetic unchanged.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/pull/652)

**S17 · WAIT and booking authority source**

Pinned production 0188/0189/0190 lifecycle, settings/waitlist actions, and 0170/0171 booking/reschedule sources already inspected in this working thread. One-shot redemption is separate from booking; current invitation schema lacks the proposed date/service/cap scope.

[Open pinned source / source record](https://github.com/SaiSamyukthVemuri/Hone/blob/ea70bd0543993937ba42259037c903fac6c6fc15/supabase/migrations/0188_new_client_waitlist_invitations.sql)

Additional references for paired source IDs:

[S6 · Exact-head P1: gate sender routing until ACTIVE rows exist](https://github.com/SaiSamyukthVemuri/Hone/pull/674#discussion_r3944782249)

[FIN #672](https://github.com/SaiSamyukthVemuri/Hone/pull/672)

[Held FIN #666](https://github.com/SaiSamyukthVemuri/Hone/pull/666)

[UI #669](https://github.com/SaiSamyukthVemuri/Hone/pull/669)

[WAIT operator source](https://github.com/SaiSamyukthVemuri/Hone/blob/ea70bd0543993937ba42259037c903fac6c6fc15/app/(app)/settings/waitlist/actions.ts)

## D.1 Historical source ledger retained from v1.9

The following entries are historical source provenance, including earlier “current” observations. They are not refreshed factual claims in v1.11. Their role is to preserve the original evidence trail and explain how the standing contracts arose.

User-provided raw roadmap/feedback document: “This one is different from the earlier Budget findings.docx” (272 pages of accumulated roadmap/product/security notes).

User-provided consolidated source: HONE_CONSOLIDATED_NOTES_2026-08-16.md, whose Aug. 16 Section 8.10 is the canonical pre-v1 roadmap and whose Sections 4-10 preserve failed-workstream lessons and overlapping findings registers.

User-provided Aug. 16 independent deep security/product/UI/UX audit summary: no P0, five headline P1s, Willow/2-5 design partners ready with conditions, 10-50 ordinary studios not yet ready.

GitHub state revalidated during roadmap creation for #593, #541/#543/#544, #536, #520/#521 and the production commit timeline. Mutable GitHub state must be revalidated after this document timestamp.

Control-plane PR #1 state and stated private-repository GitHub protection blocker.

Observed release evidence carried forward from v1.1: the 0183/0184 migration-first sequence and temporary credentialed Hetzner release path. Current v1.2 state supersedes the old snapshot: hosted/repo are now 0184, #593 is merged/deployed, and the next migration is unclaimed.

User-provided canonical source: HONE_CANONICAL_ROADMAP_NORTH_STAR_v1.1 (17 Aug 2026), carried forward rather than replaced; v1.2 is an explicit controlled amendment.

Current GitHub revalidation for v1.2: production/default branch 266b6092; #597 and #598 open/unmerged/mergeable; #596 open clean-room evidence candidate; no remote WAIT-01 branch/PR visible at snapshot.

Willow read-only production capacity evidence gathered 18 Aug 2026: first-ever consultation pipeline, mature conversion cohorts, treatment-visit progression, net weekly capacity, next usable opening and active-client future-booking depth.

Operator-reported current state: WAIT-01 emergency implementation is running on the Hetzner development host. This is contextual state only until a branch/commit/PR and exact-head evidence exist.

GitHub revalidation for v1.4: production branch at 96a76c4a55e0b89e1fc5bfac4ebc9d5b8a1a5755; #608/#609/#610 open and unmerged; #608 exact-head CI run 1386 green with one resolved and one open P1 thread; #609 exact-head CI run 1384 green with one open P2; #610 head 7503552d with repeated source-guard P2 family and CI still in progress at snapshot.

Operator/Chloe production feedback on 20 Aug 2026: selected-day navigation works, but future-day rows still lacked the same old notes/prep context as Today; separate feedback reported that some clicks/pages feel too slow and requested a meaningful UI upgrade.

Read-only UI/performance reconnaissance on 20 Aug 2026: source-level evidence of repeated identity/studio resolution, long serial await chains, sparse loading/streaming feedback, widespread visual duplication, sub-44px controls and mobile form-size/focus debt. These are hypotheses/structural findings until production timing or user acceptance proves the runtime effect.

External UI sources reviewed for direction: Watermelon UI and Motion Primitives are not adopted as dependencies by this roadmap version; use as selective references only. Hone retains its own clinical density, server/data boundaries and design language.

GitHub revalidation for v1.5: production branch at 88bba0e13e2e125610fdd68a2574d35f5f6d3943; #608 closed unmerged/retired; #609 merged/deployed as f698b5ac0a3d3ed9f2955305318cd23d75e44571; #610 merged/deployed as current production. #597 remains open behind the train.

#608 convergence record: five same-family P1s established that capped/sliced child-collection absence cannot safely license negative clinical prose. The final vehicle was closed rather than patched again; replacement requires clean-room positive-evidence architecture.

#610 governance record: exact-head CI/review eventually cleared after correcting watcher logic that confused acknowledgement/stale review objects with completed review. Eleven historical threads were individually verified/resolved; anti-vacuity showed "all tests pass" had twice been true of broken instrumentation.

Read-only final UI V2 recon on 20/21 Aug 2026: 218 claims confirmed, 97 corrected, 6 unverifiable after stopping further expansion. No repo code changed. Canonical outcome is #609-owned primitives plus UI-01..UI-06; no new UI framework, icon package or motion runtime.

External-reference correction: Bklit top-level licensing was verified noncommercial and removed from commercial planning; Shoogle MCP is real but not installed/recommended for the current non-shadcn codebase; Mobbin MCP requires paid access and yielded no usable recon evidence; Tabler remains optional MIT SVG-source material later.

Performance operation status at v1.5 amendment: operator explicitly authorized a bounded HONE_PERF_TIMING Production window after #610, including enable/redeploy/sample/darken/redeploy, but this roadmap has not received the completion report. No production latency numbers or final Vercel flag state are asserted here.

GitHub revalidation for v1.6: production base remains 88bba0e1; #612 is open/unmerged at dc86ef792b with CI run 1414 success and an exact-head runtime-only Codex clean review; #613 is open/unmerged at 14baa341 after seven exact-head P1s; #611 is closed unmerged.

#612 same-fixture runtime evidence recorded from the exact-head review request: local client-profile.domain p50 352 ms -> 71 ms and p95 402 ms -> 201 ms, 50 samples per tab per side in ABBA order; identity control 173 -> 170 ms; reads 31-38 -> 7-25; observed waves 18-20 -> 4-9. These are local A/B measurements, not production latency claims.

#613 convergence record: 11,562 unit, 2,188 DB, 335/335 browser and 7/7 mutation checks were green while Codex still found seven P1s. This is direct evidence that test volume cannot override a representational stop law. Root families: unavailable collapsed into absence; caps/truncation presented as completeness; proxy evidence/array position presented as exact clinical fact.

Production-source revalidation at 88bba0e1 confirms lib/dashboard/before-today-previews.ts still performs several reads without binding errors and maps missing data through ?? []; its sessions read is capped and ordered by started_at without a total id tie-break. This is current evidence for the remaining historical read/presentation truth item.

New Chloe product input in this amendment: owner needs "how much money did I make?" by day, week, month and custom date range. Routed to FIN-01A; total truth is bounded by external-payment/refund/collection authority rather than treated as a standalone chart request.

Performance planning correction: Railway/hosting migration, JSON compression and generic caching are not current first-order levers. Measured priorities are Client Profile round-trip/wave structure, truthful loading/streaming, then DB aggregation/query/index work if timing proves it; public-route middleware cost is a separate audit.

Control-plane evidence: repeated manual tmux/session recovery, exact-head watcher reconstruction and stop-law adjudication across #610/#612/#613 now satisfy the roadmap pain-before-platform rule. Cycle 2 therefore starts TEST-PORT-01 + CP-005 + CP-007 rather than another ad hoc manual protocol.

GitHub revalidation for v1.7: production branch HEAD 3a469e17; #612 merged as 69d9f36f, #615 merged as 6fe93ccf and #616 merged as 3a469e17. #613 remains open/unmerged at 14baa341; #597 remains open/mergeable on its older base.

#612 post-merge production remeasurement: corrected client-profile.domain comparison p50 584 -> 244 ms, p75 654 -> 310 ms, p95 698 -> 432 ms, N=38 before/after. One 892 ms post outlier is isolated; all post samples were Overview. Instrumentation was darkened again after the window.

Dev Engineering V1 retrospective: seven consecutive authority-bearing vehicles #617-#623 retired unmerged after exact-head adversarial findings while CI was green. Program totals recorded by the retrospective: 39 exact-head findings, 1,115 implementation lines shipped, 2,438 discarded, and an 8h15 final stretch after CP-005a with zero merged output. The failure mechanism was circular completeness/self-verification, not scope size.

Control-plane cleanup after the stop: the shared stash was verified against pushed history then dropped; eight retired CP-005 worktrees were removed; remote recovery branches and the fixture corpus were preserved; the main /srv/hone/repo checkout was cleanly fast-forwarded to 3a469e17. These are operator-state facts, not product capabilities.

User-provided 24 Aug 2026 independent audit packages: Run 1, Run 2, corrected Run 2B and Run 3 at audit source b9e0003fa5809b328fffeb8d352af319138bd531. One duplicate Run2B archive was empty and excluded. Corrected Run2B is the accepted severity register for that audit head: 0 P0 / 6 P1 / 9 P2 / 3 P3; Stage A ready with conditions, Stage B not ready.

Run 3 was consumed as a roadmap amendment source, not as current production truth. It identifies the central risk as unavailable/partial/ambiguous evidence becoming a confident domain fact; proposes the four-state HIST authority contract, OPS hosted proof, Stage B gate hardening, DR-01A/DR-01B split and PAID_MEMORY_PROOF-001.

GitHub production revalidation for v1.8: claude/build-hone-saas-hOex7 at 46660c21c657b67505bf40350ceb8c5ebfb36f63 after #640. Branch protection remains enabled. #637 and #638 are open/mergeable release candidates on the #640 base; #639 is open tooling-only on an older base and is deliberately parked last.

PAY-SETTLE evidence after the audit head: #636 merged/deployed, migration 0187 applied/verified/frozen, canonical state reconciled by #640, and a controlled synthetic authenticated UI smoke passed. Stored settlement was paid_cash, amount_cents=1000, quoted_amount_cents=1234; no payment attempts were created. Smoke closeout is durably recorded on merged PR #636.

Current migration checkpoint: canonical repo max 0187, hosted max 0187, pending [], next free 0188. This checkpoint is timestamped evidence only; every future migration action re-runs the Section 2 + Section 8 gates.

Current WAIT evidence: #637 remains code/readiness only; production durable allowlist empty and Willow durable mode disabled. The roadmap must not confuse merged disclosure/readiness code with T4a activation or with the separate policy effective-date/account-holder-notice decision.

Current OWNER-CAP evidence: #638 has one-snapshot read model, UNKNOWN fail-closed rules, treatment-only booking-depth semantics and an actionable client rebooking worklist; it remains unmerged until exact-head review completion.

Current design-tooling evidence: #639 contains only .agents/.claude skill files and skills-lock.json; it is non-authoritative development guidance, not a runtime UI package or product dependency.

GitHub live revalidation for v1.9 at ~18:07 UTC 27 Aug 2026: production branch 662ac68d after merged #651; canonical migration state hosted/repo 0187, pending [], next free 0188; production-push CI #1595 completed SUCCESS.

Merged release chain since the v1.8 #640 checkpoint includes #637, #638, #639, #641, #642, #643, #644, #645, #646, #648, #649, #650 and #651. Each capability statement in the v1.9 amendment is derived from current PR state/body plus production ancestry; historical PR prose remains evidence only.

Current open-PR revalidation: #647 is OPEN/DRAFT at 8c71fa4f with CI #1593 SUCCESS; #652 is OPEN/NON-DRAFT at 107272cd with CI #1594 SUCCESS; #631 is OPEN at 17dae022 and stale/non-mergeable after #651. #647/#652 successful CI applies to their pre-#651 heads and must be reacquired after refresh. These are mutable snapshot facts and require revalidation before action.

Operator-local environment evidence: Emil Kowalski apple-design installed globally for Claude Code at ~/.claude/skills/apple-design/SKILL.md on hone-dev-01; Hone repository remained clean during install. This is tooling context, not GitHub/repo/product authority.

Current performance-program operator state: PERF-01A shell single-resolution implementation/recon, PERF-01B Dashboard waterfall audit and PERF-01C first-useful-paint/streaming design are local/read-only/no-PR at this checkpoint. No production speed improvement is asserted by their existence.

## D.2 Standing provenance rules for future reviewers

Implementation, database behavior, rendered behavior and actual behavioral test assertions outrank prose.

Current evidence outranks historical conclusions.

Historical audits remain valuable as finding sources but must be reconciled before reusing severity/status counts.

Where this roadmap intentionally contains a time-stamped operational snapshot, it is clearly labeled snapshot-only.

# Appendix E. Historical Willow Capacity Evidence — August 18 Baseline

| **HISTORICAL EVIDENCE ONLY  These August 18 measurements explain the origin of WAIT/ADMIT. They are not September 6 capacity, a present intake quota or proof of today’s clients/flags. The temporary two-consultations/week recommendation below is historical; remeasure and obtain a current owner decision before using it.** |
| --- |

## E.1 Studio baseline

| **Field** | **Observed value** |
| --- | --- |
| Studio | Willow Electrolysis |
| Studio id | 38cb3a8b-f0f1-409e-9ea4-ffa4b95cb4c6 |
| Slug | willow-electrolysis |
| Timezone | America/Toronto |
| Active practitioners | 1 |
| Active/non-archived client records | 65 - NOT equivalent to active treatment clients |
| Studio buffer | 20 minutes |
| Default appointment duration | 60 minutes |
| Practitioner capacity | disabled |
| Practitioner-capacity booking | disabled |
| Public booking horizon | 2 months |

## E.2 New-client pipeline

| **Horizon** | **All confirmed consultations** | **First-ever new-client consultations** | **Distinct clients** |
| --- | --- | --- | --- |
| Next 7 days | 8 | 8 | 8 |
| Next 14 days | 17 | 17 | 17 |
| Next 28 days | 24 | 24 | 24 |

Observed first-fortnight intake pace: 17 / 2 weeks = 8.5 new-client consultations per week. All 17 checked 14-day consultations were first-ever appointments for recently created distinct clients.

## E.3 Consultation conversion

| **Within days** | **Matured consults** | **Booked conversions** | **Booked conversion %** | **Attended conversions** | **Attended conversion %** |
| --- | --- | --- | --- | --- | --- |
| 7 | 25 | 8 | 32.0% | 8 | 32.0% |
| 14 | 17 | 11 | 64.7% | 11 | 64.7% |
| 30 | 5 | 4 | 80.0% | 4 | 80.0% |
| 42 | 4 | 3 | 75.0% | 3 | 75.0% |

Planning rule: use the 14-day 64.7% rate as the current operational signal. The 30/42-day percentages are directionally useful but not authoritative because n=5 and n=4.

## E.4 Early treatment progression

| **Treatment visit** | **Clients reaching visit** | **Median days from prior step** | **Median duration** |
| --- | --- | --- | --- |
| 1 | 16 | 7.0 | 60 min |
| 2 | 4 | 4.9 | 53 min |
| 3 | 4 | 2.6 | 45 min |
| 4 | 3 | 2.0 | 30 min |
| 5 | 2 | 3.9 | 45 min |

Visit 1 is the strongest repeatable evidence: converted clients typically need a 60-minute first treatment about 7 days after consultation.

Visits 2-5 are immature samples. They show repeat care and possible duration taper, but they are not yet a safe basis for permanent cadence automation.

## E.5 Weekly net capacity snapshot

| **Week start** | **Net capacity h** | **Already booked capacity h** | **Currently free h** | **Booked %** |
| --- | --- | --- | --- | --- |
| 2026-08-16 | 7.00 | 6.50 | 0.50 | 92.9% |
| 2026-08-23 | 21.00 | 19.25 | 1.75 | 91.7% |
| 2026-08-30 | 28.50 | 18.17 | 10.33 | 63.7% |
| 2026-09-06 | 28.75 | 12.00 | 16.75 | 41.7% |
| 2026-09-13 | 28.00 | 6.67 | 21.33 | 23.8% |
| 2026-09-20 | 28.00 | 1.33 | 26.67 | 4.8% |
| 2026-09-27 | 28.75 | 1.83 | 26.92 | 6.4% |
| 2026-10-04 | 28.00 | 0.00 | 28.00 | 0.0% |
| 2026-10-11 | 14.00 | 0.00 | 14.00 | 0.0% |

Next usable 30-, 60- and 90-minute opening all resolved to approximately 12.8 days away at the snapshot. The identical lead time indicates the near-term problem is not merely fragmentation of one long duration class.

Do not interpret the steep September booked-percentage decline as abundant true capacity. Future recurring work is incompletely represented on the calendar.

## E.6 Active treatment booking depth

| **Active treatment clients** | **Zero future** | **1+ future** | **2+ future** | **3+ future** | **% zero future** | **Future treatment hours already committed** |
| --- | --- | --- | --- | --- | --- | --- |
| 17 | 7 | 10 | 7 | 2 | 41.2% | 15.50 h |

Only 2 of 17 active treatment clients had three or more future sessions booked. Seven had none. This proves that future calendar occupancy is an incomplete proxy for recurring client demand.

## E.7 Cadence evidence and limitation

| **Cadence cohort** | **Active clients** | **Median gap days** | **Median duration** | **Implied treatment hours/week** |
| --- | --- | --- | --- | --- |
| Insufficient history | 12 | UNKNOWN | 60 min | UNKNOWN |
| Weekly bucket | 4 | 2.5 | 60 min | 14.33 h |
| Biweekly bucket | 1 | 16.5 | 38 min | 0.27 h |

Twelve of 17 active clients lacked sufficient history. Their demand must remain UNKNOWN, not zero.

The four-client weekly bucket is unusually intensive and may reflect early-course treatment cadence; do not generalize 14.33 h/week to every client or add it blindly on top of already-booked future sessions.

Any future forecast must reconcile expected visits against actual future bookings before aggregating residual latent demand.

## E.8 Business interpretation and temporary policy

Predeclared capacity verdict: TIGHT. The next 60-minute opening was within the 8-14 day tight band; near-term utilization exceeded 90% in the next full week.

Current 8.5 consultations/week is too aggressive relative to a roughly 28-hour normal future net-capacity week and the treatment workload created by conversion.

Temporary operating recommendation: honor existing confirmed consultations, pause incremental intake while the backlog converts, then reopen around 2 new consultations/week and remeasure. This is a risk-control setting, not a permanent mathematically proven optimum.

New incremental demand should enter WAIT-01 immediately; durable queue and assisted release follow only after production containment is stable.

An extra working day should be evaluated using measured waitlist pressure, treatment lead time, utilization and collected-value contracts. Capacity is not revenue until demand fills it, and revenue projections must remain scenario-labeled.

## E.9 Evidence exclusions

All capacity analysis described here was read-only; no production writes were performed by the analysis.

booked_outside_availability is excluded as a pure overload metric because current Smart M2 evidence shows the flag is contaminated by buffer and custom-duration exception semantics.

Later cohort conversion/cadence estimates remain sample-limited and should not be promoted to automated policy without fresh mature evidence.

The emergency WAIT-01 email-backed queue has no durable ordering/claim semantics; it cannot safely power automatic release.

Every future capacity/admission run must re-read current studio configuration, bookings, blocks, active-client state and invitation state rather than reusing this snapshot as current truth.

# Canonical Closing Statement

| **THE RULE TO PRESERVE  Trust work is continuous but bounded. Product work is continuous but cannot bypass trust. Interrupt work is protected but cannot silently become the roadmap. Treatment Memory remains the moat; admission control extends it into a Practice Operating System. Evidence establishes current facts; this roadmap determines how Hone acts on them.** |
| --- |

Version 1.14 retains the v1.13 operating brief, single product sequence, five evidence-limited readings and accountable roles, and adds the developer-platform backlog, recorded canary evidence and controlled rollout gates. The full North Star, accepted capabilities, authority laws and history remain. Start with the brief, then §§23.6, 14.5.7 and 20; use §§16.6–16.8 and 23.7 for supporting tooling.

**SUPERSEDED 2026-09-17.** That sentence read: "A matching Markdown edition is prepared, not committed. Repository synchronization requires its reviewed publication record." This file **is** that synchronization, published under its reviewed record in §0.10 and Appendix D.0E. Version 1.16 additionally revalidates source, hosted and deployment state — the one thing the editorial editions explicitly did not do — and changes none of it. **The next milestone is the accepted customer journey, not another document or component-readiness claim.**

# Appendix F. Superseded Operating Records

| HISTORICAL ARCHIVE — DO NOT EXECUTE  F.1–F.5 retain earlier operating overlays unchanged. F.6 retains the superseded v1.10 decision/checkpoint/WAIT contract/queue blocks. Their old “current”, “next”, “GO”, migration numbers and proposed policies are historical; v1.11 §§0, 3, 14.5 and 23 govern current direction. No historical command grants present authority. |
| --- |

## F.1 September 4 GitHub-grounded front matter

### Historical record — GitHub-Grounded Current State

Evidence cutoff: 4 September 2026, 03:10 ET · This block supersedes every mutable status statement in the underlying 27 August 2026 edition. The architectural north star and governing laws below remain in force unless this block explicitly changes them.

| **PRODUCTION DATABASE**<br>**0190 LIVE + VERIFIED** | **APPLICATION RELEASE**<br>**PR #664 OPEN** | **NEXT PRODUCT RELEASE**<br>**FIN + BUSINESS** |
| --- | --- | --- |

**Canonical read: **WAIT-03 is no longer a pre-apply database project. Migration 0190 has been applied to Hone production and post-apply verified. The remaining work is to clear one CI-infrastructure cancellation on the truth-recording head, merge PR #664, verify the production deployment, and then publish FIN + Business as the next production-moving product release.

| **SOURCE DISCIPLINE**<br>**All completion claims in this update come from GitHub PR metadata, repository files, commits, and GitHub Actions. Local terminal work is treated as non-canonical until it is pushed and reviewable. The one exception is the owner’s sequencing decision that FIN + Business goes next; it is labelled as a decision, not GitHub proof of implementation.** |
| --- |

1. Executive state

| **Deployment branch** | **claude/build-hone-saas-hOex7 @ 389a3e12588e** |
| --- | --- |
| **Active release PR** | #664 · feat(waitlist): make invitation claim/redeem lifecycle atomic (WAIT-03) |
| **PR branch / head** | feat/wait03-invitation-lifecycle @ 2a23e3e7e6fa |
| **PR state** | OPEN; mergeable YES; merged NO; draft NO |
| **PR size** | 38 commits · 25 files · +12895 / −89 |
| **Hosted DB state** | max 0190; 0190 applied + verified; pending none; next free 0191 |
| **Truth-recording head** | 2a23e3e7e6fa (canonical production state recorded on the PR branch) |
| **Latest CI at cutoff** | #1710 · overall CANCELLED because Google E2E hit its hard timeout |
| **Owner release decision** | FIN + Business is next after WAIT-03 merge and production verification |

Important split: the hosted production database is at 0190, while the application deployment branch has not yet absorbed PR #664. The PR branch carries the post-apply truth record; the deployment branch remains the application baseline until merge.

2. Delta since the 27 August edition

| **Migration** | **Purpose** | **State** | **Production meaning** |
| --- | --- | --- | --- |
| **0188** | Private waitlist invitation lifecycle | **Applied + frozen** | Atomic claim/issue/redeem/expire/release lifecycle; one-live invitation; append-only provenance; structural tenancy. |
| **0189** | Wall-clock temporal authority | **Applied + frozen** | Moved WAIT temporal decisions/stamps to post-lock clock authority and structural cycle identity. |
| **0190** | TTL anchor + evidence immutability | **Applied + verified + frozen** | Anchors issuance/expiry to the reviewed post-lock instant and prevents legal status transitions from rewriting unrelated earned evidence. |

WAIT-03 production result

- 0190 applied exactly once; production migration history advanced to 0190 with no pending or remote-only versions.
- Post-apply definitions matched the reviewed target; TTL anchor and provenance-immutability repairs are live.
- No apply-time business rows changed, no backfill ran, and the impossible-state census remained zero.
- ACL and RLS posture remained valid; no cross-studio or role-access widening was introduced.
3. Remaining WAIT-03 gate

**The remaining red is infrastructure, not product behaviour. **On GitHub Actions run #1710, every substantive job passed except the Google browser E2E job. That job completed dependency installation, local Supabase startup, the full migration chain through 0190, and 12 of 13 Playwright tests with zero assertion failures before the existing 10-minute job ceiling cancelled it as the final test began.

| **GitHub Actions job** | **Conclusion** |
| --- | --- |
| google browser e2e (fake google) | **CANCELLED** |
| typecheck / lint / build / test / safety gates | **SUCCESS** |
| db integration (local supabase) | **SUCCESS** |
| browser shards 1–4 (extended) | **SUCCESS** |
| payment browser e2e (fake stripe) | **SUCCESS** |
| mobile completion e2e | **SUCCESS** |

Exact remaining sequence

1. Raise the Google E2E hard failure ceiling from 10 to 15 minutes; do not change the test selection or assertions.
1. Run one exact-head CI cycle and one exact-head Codex review.
1. Refresh PR #664’s superseding current-state block from 0189 to 0190.
1. Resolve only demonstrably fixed current review threads.
1. Merge #664, verify the production deployment, and release the shared DB/release slot.
4. Production release train

**Production-concurrency-one remains governing. **Parallel lanes may prepare bounded work, but only one package may move the deployment branch or production database at a time.

| **#** | **Release unit** | **Required transition** | **Gate** |
| --- | --- | --- | --- |
| **1** | **WAIT-03 / PR #664** | Close CI metadata gate → merge → verify production deployment | **GO** |
| **2** | **FIN + Business** | Refresh onto production → final focused/prepush/browser gates → publish PR → ship | **NEXT** |
| **3** | **SEC-01A / PR #665** | Refresh draft contract package after FIN; revalidate before promotion | **DRAFT** |
| **4** | **Storage / Privacy** | Publish only GitHub-reviewable bounded units; assign next-free migration number at release time | **HOLD** |
| **5** | **OPS** | Ship machine-owned reliability fixes; keep human owner/drill decisions explicit | **HOLD** |
| **6** | **UI / Charting** | Publish the smallest audited primitive-adoption package; no new design-system expansion | **HOLD** |
| **7** | **ACL / Trust repair** | Complete behavioural grant-back evidence, then ship bounded least-privilege repair | **HOLD** |
| **8** | **HIST-01A** | Remain held until mechanical completeness, independent falsifier, fault injection, and human re-entry acceptance | **BLOCKED** |

5. Workstream status — canonical GitHub view

| **Workstream** | **GitHub truth** | **Canonical status** | **Next gate** |
| --- | --- | --- | --- |
| **WAIT-03** | PR #664 open, mergeable, head 2a23e3e7; 0190 live; CI #1710 Google lane timeout | **GO — final gate** | 15-minute Google ceiling → one CI/Codex → merge |
| **FIN + Business** | No canonical GitHub PR at the cutoff | **NEXT — owner decision** | Publish only after #664 merges; GitHub then becomes authority |
| **SEC-01A** | PR #665 OPEN / DRAFT: test(security): pin public-booking SEC-01A contract | **DRAFT** | Keep draft; rebase/revalidate after FIN unless a true blocker changes order |
| **Storage / Privacy** | No release-ready GitHub PR established by this snapshot | **HOLD** | Convert local claims into small pushed PRs; no “retain forever” policy by default |
| **OPS** | No production-moving GitHub PR established by this snapshot | **HOLD** | Publish machine-owned fixes only; keep owner/drill inputs separate |
| **UI / Charting** | No pushed UI release package established by this snapshot | **HOLD** | Publish bounded charting primitive-adoption work after upstream releases |
| **ACL / Audit** | Audit findings are not closed by local notes; GitHub behavioural proof still required | **HOLD** | Observe legitimate caller set, then publish bounded least-privilege repair |
| **HIST-01A** | No runtime authorization or merged re-entry package | **BLOCKED** | Accept all three re-entry gates before any runtime implementation |

Interpretation law: “no canonical GitHub PR” does not mean no local work exists; it means the roadmap refuses to count unpushed work as complete, reviewable, or release-ready.

6. GO / HOLD / STOP boundaries

| **GO NOW**<br>**• CI-only Google E2E timeout correction.**<br>**• One exact-head CI and Codex review.**<br>**• PR #664 metadata refresh to 0190.**<br>**• Merge #664 only after the exact head is green.**<br>**• Verify production deployment, then refresh FIN.** | **HOLD**<br>**• FIN publication until #664 settles.**<br>**• SEC draft promotion until FIN clears the slot.**<br>**• Storage, OPS, UI, ACL and HIST release movement.**<br>**• Any numbered migration assignment until the release unit owns next-free.** | **STOP**<br>**• Editing frozen 0188, 0189 or 0190.**<br>**• Reapplying 0190.**<br>**• Merging #664 while required exact-head gates are red.**<br>**• Treating a timeout cancellation as a product failure—or ignoring it as green.**<br>**• Counting local-only work as canonical completion.** |
| --- | --- | --- |

7. FIN + Business — next release definition

**Owner sequencing decision: **FIN + Business is the next product release after WAIT-03. This is a priority decision, not a GitHub implementation claim. Until a FIN branch/PR is pushed, the canonical repository only proves that the release is planned.

- Top-level owner navigation: Business.
- Business landing route: /business.
- Business sub-navigation: Overview · Capacity · Financials.
- Capacity remains at /dashboard/capacity; Financials remains at /financials for the first release to avoid route churn.
- Financial facts must preserve authority classes: completed service value, collected money, outstanding, refunds, waived, and UNKNOWN must not be collapsed into a misleading single number.
- Dashboard answers “What needs attention today?”; Business answers “How is the practice doing?”
GitHub admission criteria for FIN

- Branch refreshed from the post-#664 production head; no hidden dependence on the old base.
- Business/Capacity/Financials owner-only navigation is independently authorized server-side.
- Focused financial model tests, navigation tests, typecheck, lint, build and exact selected browser lanes pass.
- One exact-head Codex review is clean.
- No unsupported “revenue” or “zero” claim enters the UI where authority returns UNKNOWN.
8. Known debt intentionally not lost

| **Item** | **Canonical treatment** |
| --- | --- |
| **WAIT operator surface** | A redeemed prospect who never books still needs a separate operator lifecycle ruling; not silently folded into WAIT-03. |
| **Messaging opt-out** | SMS STOP is not waitlist removal; messaging consent remains a separate authority before any SMS invitation delivery. |
| **CI runtime economics** | Hard ceilings were repeatedly inside normal runner variance. Keep ceilings finite, but measure installation/setup separately from product-test time. |
| **Node/runtime maintenance** | GitHub Actions logs show Node 20 deprecation warnings for at least one action; track as CI maintenance, not a release blocker for #664. |
| **Historical authority** | HIST remains a re-entry program, not a feature queue. Only EMPTY_PROVEN may license absence; runtime remains held pending accepted falsification/completeness/fault-injection gates. |

9. GitHub evidence ledger

[PR #664 — WAIT-03](https://github.com/SaiSamyukthVemuri/Hone/pull/664) — Open/mergeable release PR; exact head 2a23e3e7e6fa at cutoff.

[PR #665 — SEC-01A](https://github.com/SaiSamyukthVemuri/Hone/pull/665) — OPEN draft security contract PR.

[CI run #1710](https://github.com/SaiSamyukthVemuri/Hone/actions/runs/33842250663) — Post-0190 truth-recording run; all substantive jobs green except Google E2E cancelled by its 10-minute ceiling.

[Migration state at PR head](https://github.com/SaiSamyukthVemuri/Hone/blob/2a23e3e7e6faaed81abb4dceb6406a91c5fdc688/docs/production/migration-state.json) — Canonical branch record: hosted/repo max 0190, pending none, next free 0191.

[Migration ledger at PR head](https://github.com/SaiSamyukthVemuri/Hone/blob/2a23e3e7e6faaed81abb4dceb6406a91c5fdc688/docs/production/migration-ledger.md) — Durable 0188/0189/0190 production history and verification narrative.

[Deployment branch](https://github.com/SaiSamyukthVemuri/Hone/tree/claude/build-hone-saas-hOex7) — Application production branch; GitHub branch SHA 389a3e12588e at source capture.

Evidence rule for the rest of this document: where the underlying 27 August text conflicts with this front block on branch SHA, migration max, active PR, release gate, or sequencing, this front block controls.

## F.2 Version 1.2–1.9 decision history

### Historical record — 0.4 Version 1.2 decision delta

REL-593 is no longer an active release train: #593 merged and production now points at 266b6092f22ffd6d656a967be527abcf9437a95f; hosted and repository migration max are both 0184 with no pending migration.

A live Willow capacity incident created WAIT-01 as a C1 Interrupt: new-client demand is temporarily gated into a reversible, migration-free waitlist while all existing confirmed consultations and existing-client booking remain intact.

The strategic roadmap gains a New Client Admission / Waitlist program. The durable destination is not a generic queue: Hone should admit exactly the number of new clients the practice can safely serve after consultation conversion and recurring treatment demand are considered.

HEALTH-01 expands from calendar utilization into truthful admission capacity. REBOOK-01 becomes a dependency because future calendar white space cannot be interpreted without recurring-client demand and no-future-booking state.

SMART-01 is decomposed further because current work surfaced M1 (capacity-OFF working-hours/eligibility authority gap) and M2 (outside-hours/buffer/custom-duration exception conflation). These must be resolved before internal booking surfaces converge.

Automatic waitlist release is explicitly Later. The maturity path is manual containment -> durable queue -> private invitation -> assisted Invite next N -> opt-in automatic release only after the deterministic model agrees with real practitioner decisions.

### Historical record — 0.5 Version 1.3 decision delta - commercial amendment

Version 1.3 is an additive commercial amendment. No engineering scope, launch gate, safety law or trust requirement from v1.2 is removed or weakened; all v1.2 content is carried forward unchanged.

BILL-00 is added to the SaaS Platform and Activation Program: decide and document design-partner charging mechanics - manual Stripe invoice or payment link, founding price honored or the marketing site corrected through the truth register, and cancellation/refund terms consistent with TRUTH-01A. No subscription automation is built for this; ONBOARD-03 remains the Gate C billing system.

Gate B design partners pay from day one at the published founding rate. The first paid customer and the first design partner are the same event. Free pilots are not design partners, and Willow is excluded from commercial proof metrics.

Charging precondition set: no studio is invoiced before TRUTH-01A is closed, counsel-approved terms/privacy are in place, and the Gate B trust set (SEC-01, OPS-01, safe paginated export, resumable operator import, DR-01, support owner, manual offboarding runbook) is satisfied.

Partner 1 shape is a deliberate decision, not first-responder default: a multi-practitioner partner (e.g. the standing NV Electrolysis inbound, 2-5 staff, currently on Jane) pulls PRACT-01/PRACT-02 forward as onboarding prerequisites; a solo partner does not.

Bookkeeping updates recorded by this delta: executive queue gains item 13 (BILL-00 before DP-001 preflight); cycle 6 adds the charging-mechanics decision; cycle 7 onboards partner 1 as paid; queue item 5 freeze target and the RDM-001 maintenance row/version markers move from v1.2 to v1.3.

### Historical record — 0.6 Version 1.3.1 decision delta - Chloe feedback completeness and export re-sequencing

Purpose: 100% of Chloe pilot feedback becomes named roadmap objects. Nothing engineering-wise is removed; one Gate B precondition is re-sequenced and recorded below.

Six items added to 14.6 Explicit Chloe asks: DASH-FLOW-01 (inline treatment expand), TODO-CLEAN-01 (To-do widget truth), FREE-CONSULT-01 (zero-amount service truth), FEEDBACK-01 (pilot feedback routing), PROBE-02 (probe lot/batch auto-fill), CARD-REMIND-01 (one-click card-on-file reminder email).

Latest feedback (18 Aug 2026) traceability: Dashboard current-client highlight, a consultation-notes start button, and card-on-file visibility next to upcoming clients are already covered by DASH-FAST-01 via PR #598. The one-click reminder email is the only new capability in that batch and becomes CARD-REMIND-01.

MPX-01 definition now names the exact device fields from Chloe: slow thermolysis duration/intensity, snap duration/intensity, snap count, probe series/gauge, Apilus preset number, and the Apilus body-part + preset picker concept.

ACCEPT-001 must adjudicate PR #572: if merged, TODO-CLEAN-01 and FREE-CONSULT-01 are acceptance checks; if unmerged, they are the delivery items. Either way they stop being homeless.

Export re-sequenced per operator decision: the Gate B precondition softens from safe paginated export to a tested manual export runbook with one proven complete archive. Paginated self-serve export and PRIV-01 automation remain Gate C. DR-01 backup/restore is unchanged and is not export. The principle stands: no money taken for custody of clinical records Hone cannot hand back; a proven runbook satisfies it at Gate B.

Section 0.5 is retained unedited as the historical v1.3 record; where it references safe paginated export in the Gate B trust set, this delta supersedes it.

### Historical record — 0.7 Version 1.3.2 decision delta - money truth for the treatment room

Two new Chloe asks (18 Aug 2026) become named items in 14.6: UNCOLLECTED-01 (tell me if I forget to charge someone) and PAY-EXTERNAL-01 (record a cash or e-transfer payment so income records stay accurate). The other four asks in the same feedback batch were already captured in v1.3.1 and DASH-FAST-01.

Pairing law: UNCOLLECTED-01 and PAY-EXTERNAL-01 ship together or the detector is untrustworthy. Without external-payment recording, every cash visit is a false alarm; without the detector, cash rows exist but a forgotten charge still loses money silently.

FIN-01 consequence: collected value must split provider-verified card collections from attested external payments. External records are operator attestations, not provider receipts, and reporting must say so rather than blending them.

Revenue-actuals consequence: the coverage metric in the read-only actuals analysis (completed non-zero visits without a linked charge) is the pre-launch detector for both items and will reveal whether off-platform payment already exists at Willow.

Sequencing constraint recorded: a durable external-payment record almost certainly requires a migration, so PAY-EXTERNAL-01 implementation waits behind REL-EVID-01 and the single authorized 0185 owner. Its product contract may be designed immediately. The minimal UNCOLLECTED-01 To-do card is a read-only projection, needs no migration, and may ride the early Chloe batch before full Closeout absorbs it via FLOW-01/FLOW-02.

Refunding an external payment is explicitly out of scope for v1 and is noted for PAY-REFUND-01 later; corrections to external records are audited events, never silent edits or deletions.

### Historical record — 0.8 Version 1.4 decision delta - post-WAIT-01 Dashboard parity, speed and UI foundation

WAIT-01 has moved from emergency implementation to a live Willow pilot: #601/#604 are in production ancestry, Stage A dark smoke and Stage B controlled activation passed, the human inbox canary was observed, existing-client continuity was preserved, and rollback was not required. The email-backed V1 remains temporary; WAIT-02/03 and ADMIT-01/02 still own the durable destination.

The Chloe Dashboard train materially advanced: #598 shipped current-client highlight, consultation-notes access, three-state card status and a trusted no-card portal-link action; #606 shipped Previous/Today/Next selected-day navigation; #607 shipped appointment-bounded future-day prep retrieval, lazy full-treatment disclosure and mobile fixes. Chloe production acceptance then proved that #607 was still not full Today-equivalent prep, creating #608 as the corrective parity vehicle.

#608 exposed a recurring truth-model lesson: positive recorded facts and negative absence claims require separate completeness authority. A later clean-looking state or a successful data-layer assertion is not enough; user-visible behavior must be proved at the final rendering layer. Two P1 findings in the same partial-history/completeness family trigger the Section 7.4 architecture-review threshold; any further same-family repair loop must retire or redesign the vehicle rather than patch indefinitely.

Chloe also reported slow-feeling clicks and requested a meaningful UI upgrade. The roadmap therefore adds a measured performance program and a Hone-owned UI system: measure before optimizing, preserve server-rendered clinical boundaries, centralize mobile touch/focus/pending rules, and redesign high-value practitioner surfaces incrementally rather than importing a wholesale component registry.

Watermelon UI and Motion Primitives are reference sources, not production dependencies in the current plan. Hone should selectively borrow interaction/design ideas while owning its primitives, tokens and accessibility contracts. Haikei remains marketing/onboarding-only; Manus remains optional ideation with no runtime or engineering authority.

The existing control-plane program remains the automation destination. Live development proved specific gaps to fold into CP-003/004/005/007: mechanical scope-budget enforcement, unique worktree browser/server isolation, a durable findings/thread ledger, and a merge gate that requires every prior P0-P2 finding to be verified or explicitly accepted rather than erased by a later review.

At this snapshot the active non-draft code PR count is at the hard ceiling of three (#608, #609, #610). No fourth implementation PR should open until one closes or is explicitly reclassified. Production movement remains serialized even while development runs in parallel.

### Historical record — 0.9 Version 1.5 decision delta - convergence, measured-speed gate and UI V2 implementation map

#609 and #610 have crossed the release boundary. #609 UI foundations merged/deployed as production ancestry at f698b5ac0a3d3ed9f2955305318cd23d75e44571. #610 route-timing instrumentation then merged/deployed as 88bba0e13e2e125610fdd68a2574d35f5f6d3943, which is the current production application SHA at this amendment.

#608 is retired, not repaired. It closed UNMERGED at ceec7755e55d3847604da5be5de75f25b7b60698 after five fresh P1s in one partial-history/completeness/false-absence family. Its tests, scenarios and appointment-bounded-consolidation discoveries survive; its implementation ancestry does not. The replacement selected-day Prep V2 must rebuild fresh from current production with no cherry-pick.

NEW CLINICAL TRUTH LAW: collection absence != domain absence. A positive fact that was read may render. An authoritative scalar field that was fully read may support a scoped missing-value reminder. A missing row from a capped, sliced, filtered or failed child collection may not become "not recorded", "none", "new client" or any other absence claim.

#610 is measurement infrastructure, not an optimization result. HONE_PERF_TIMING remains OFF by default in source. A bounded production measurement window has been explicitly authorized, but no completed production timing sample or final Vercel flag state is recorded in this roadmap amendment; revalidate live Vercel state before assuming the window started or darkened.

UI-V2 recon is complete and materially narrows the plan: Hone does not need a new UI framework. #609 is the production foundation; the open work is adoption, perceived-speed feedback, accessibility/touch coverage and high-value surface presentation. Canonical implementation IDs are now UI-01 Perceived-speed floor, UI-02 Foundation adoption + accessibility floor, UI-03 Dashboard V2 presentation, UI-04 Charting V2, UI-05 Client Profile V2 and UI-06 Calendar polish. This supersedes the older v1.4 UI-01/UI-02 numbering.

Reference policy is reduced: WAI-ARIA APG, Next.js documentation, Hone's own shipped precedents and real healthcare-product precedent are active reference authorities. Tabler may later supply a small hand-picked SVG path set, not a package migration. Watermelon/Shoogle and similar registries are discovery/bookmarks only. Motion/Framer Motion is not authorized. Bklit is removed from active commercial planning after license verification showed the top-level project is noncommercial.

REVIEW GOVERNANCE ADDITION: acknowledgement != completion. An exact-head release gate must distinguish stale/re-anchored review objects and acknowledgement reactions from a completed clean Codex outcome at the current SHA, while also auditing every prior P0-P2 thread individually. #610 proved that both "all tests pass" and "review responded" can be false-positive release signals.

The current product sequence is now: selected-day Prep V2 correctness in a clean-room vehicle; complete the controlled #610 measurement window and rank real bottlenecks; UI-01/UI-02 may proceed off the live #609 foundation; UI-03 Dashboard presentation waits for Prep V2 truth to settle. Production concurrency remains one.

### Historical record — 0.10 Version 1.6 decision delta - measured Client Profile speed, historical truth closure, owner financials and control-plane acceleration

#612 (PERF-02) is now a split-verdict vehicle rather than a test-authority failure. Static/read-graph completeness proof is RETIRED. Runtime validation on the same local fixture, same stack and same client-profile.domain span used 50 samples per tab per side in ABBA order: p50 352 ms -> 71 ms (-79.8%), p95 402 ms -> 201 ms, identity control 173 ms -> 170 ms, REST reads 31-38 -> 7-25 and observed serial waves 18-20 -> 4-9. Exact-head CI run 1414 is green and exact-head Codex at dc86ef792b found no major runtime issue. The PR remains OPEN and UNMERGED; this is strong local A/B evidence, not a production-latency claim.

The production PERF-00 window is now an actual baseline, not only an authorization: 38 valid perf_route_timing lines ranked client-profile.domain first at p50 584 ms, p75 654 ms and p95 698 ms (N=12). Identity was only about 11% of that surface, so identity memoization is not the next Client Profile lever unless a later sample says otherwise.

PERF-03 is added as the next conditional Client Profile performance item: remaining-wave census plus an 8 -> 2-3 dependency collapse. Measure each remaining wave, start independent reads together, make the initial load pay for identity + client core + current tab, and treat the slowest remaining dependency as the next target. If multi-table round trips still dominate, use one database-owned aggregate/RPC or equivalent query contract; then use EXPLAIN ANALYZE and compound indexes against measured slow queries. Streaming and truthful pending UI improve perceived speed in parallel.

Caching and hosting migration are explicitly not the first performance response. Clinical latest/last truth is a poor broad-cache target. Cache stable configuration only after evidence warrants it. Railway or another hosting move is NOT_NOW as a speed fix while application round-trip structure remains the measured bottleneck. Public-route middleware/static-delivery cost stays a separate audit; payload width/select(*) is a later query-shape concern, while HTTP compression is not a current priority.

#613 is a second clean-room historical-read vehicle that has now hit the architecture stop. It remains OPEN, UNMERGED and frozen at 14baa34103ce14fe47cb9ae472bec91baf95a7c1 after exact-head Codex found seven P1s despite 11,562 unit tests, 2,188 DB tests, 335/335 browser tests and 7/7 killed mutations. The findings collapse into three families: unavailable/indeterminate -> null -> false absence; bounded/capped reads -> false completeness; and proxy evidence/array position -> wrong selection or projection. Do not patch the seven instances.

HIST-01 is added as the replacement architecture contract. Clinically meaningful historical questions are exact database-owned questions - prior visit existence, latest recorded setup before cutoff, latest watch/plan note, latest treatment visit and exact selected-visit detail - each returning observed(value), none-proven or unavailable(reason). A capped global history window may not authorize none/latest. Cutoff, own-appointment/session exclusion, void filtering, the actual clinical predicate and deterministic total order belong to the authority. Exact-session detail loads separately after selection.

Current production is safer than the old history model but the systemic read/presentation truth family is not closed. The newer appointment-prep loader binds key errors, separates same-client appointments, excludes the appointment's own session and fixed one truncation-as-absence path. The older Today/Before-Today path at production 88bba0e1 still discards database errors on multiple reads and then uses ?? [], so read failure can still become apparent absence; deterministic total recency and child completeness are not globally owned.

FIN-01A is added from Chloe feedback: the owner needs a truthful answer to "how much money did I make?" by day, week, month and custom date range. The primary number is net collected money under studio-local time authority, with completed service value, outstanding/uncollected, refunds and collection rate shown separately. Provider-verified card collections and operator-attested external payments must remain distinct; Hone must not call total earnings complete while off-platform payment recording is unknown.

The UI strategy is reaffirmed, not reset: #609 is the Hone-owned foundation; UI-01/UI-02 own pressed/pending/loading, 44px/mobile/focus semantics and selective primitive adoption. Watermelon/Shoogle/Motion remain references or rejected runtime dependencies as already recorded. No animation may disguise backend latency or move clinical/payment authority client-side.

Control-plane Cycle 2 is pulled forward as the answer to repeated manual orchestration. TEST-PORT-01 + CP-005 + CP-007 are the first bounded slices: worktree-local browser resources, exact-head PR/CI/Codex provenance with a monotonic findings ledger, and deterministic repair/architecture/test-authority stop decisions. #610/#612/#613 become acceptance fixtures. Phase 1 still has no auto-merge and no unattended T3/T4 production action; the system must return to Sam only for a real human gate.

### Historical record — 0.11 Version 1.7 decision delta - production speed result, Dev Engineering V1 closure and product reset

Version 1.7 is a corrective amendment after the completed PERF-02 release and the Control-plane Cycle 2 experiment. It supersedes v1.6 current-state and sequencing claims where they conflict, while preserving the North Star, product laws, WAIT/ADMIT maturity model, UI strategy, Trust gates and human production boundary.

#612 (PERF-02) MERGED/DEPLOYED as 69d9f36f6b89b5272e491f593611e6d4075d1b8d. The post-merge production remeasurement on the same client-profile.domain path recorded p50 584 -> 244 ms (-58.2%), p75 654 -> 310 ms (-52.6%) and p95 698 -> 432 ms (-38.1%), using 38 baseline and 38 post samples in the corrected comparison. One 892 ms post sample is an isolated likely cold start; all 38 post samples were Overview loads. HONE_PERF_TIMING was darkened again after the window. The production speed improvement is supported; the p95 estimate is less robust than p50/p75.

PERF-03 is now the next Client Profile performance item rather than a conditional release follow-up. The measured shape after #612 is approximately four serial waves on light tabs and up to nine on Overview. Instrument each remaining wave, collapse independent work toward 2-3 waves, and consider DB-owned aggregation/RPC or index/query-shape work only when timing proves the remaining bottleneck.

TEST-PORT-01 shipped through #615 as merge 6fe93ccf8d03e0c34fd6c6daa666a73fe3d8eeed. Local browser worktrees derive their own candidate app ports and Playwright never reuses another running Hone server, so a collision fails loudly rather than silently testing the wrong tree. Supabase/Postgres/Mailpit remain shared; concurrent runs involving local database reset are still inadmissible.

CP-005a shipped through #616; production branch HEAD is now 3a469e17f892163dd483043370188433965fbd66. The shipped tool is observation-only: exact-head PR/CI/review provenance, stale/current evidence and read-only status reporting. It owns no findings state, readiness decision, stop-law state or merge authority.

DEV ENGINEERING V1 IS CLOSED. PRs #617 through #623 were seven consecutive authority-bearing delivery vehicles retired unmerged after exact-head adversarial review found a fresh P1/P2 at the current head. Every vehicle was CI-green when retired. CP-005b/CP-005c did not ship; CP-007 was not started. Do not start a smaller successor under the same process.

RETROSPECTIVE LAW - OBSERVATION != AUTHORITY. Components that only observe/report have a positive record (#615/#616). Components whose output another component or operator must trust as complete/valid/readiness authority went 0-for-7. Scope reduction did not change that result. Manual stop laws, scope budgets and architecture-review discipline worked as operator process, not as shipped automation.

AUTHORITY RE-ENTRY GATE. Re-enter authoritative control-plane work only under a different verification process: completeness derived mechanically rather than hand-enumerated by the builder; an independent adversarial falsifier in the loop by construction; fault injection as a merge precondition for durable/authority components; and no builder self-certification that its own validator/enumeration is complete. A smaller artifact alone is not re-entry evidence.

#613 remains OPEN/UNMERGED and frozen at 14baa34103ce14fe47cb9ae472bec91baf95a7c1 with seven exact-head P1s. Do not patch it. HIST-01 remains a valid product/truth contract, but a new authority implementation is HOLD until the authority re-entry gate above is satisfied. The older production Today/Before-Today read/presentation debt therefore remains open.

PRODUCT RESET. The next delivery focus returns to visible Hone value: UI-01 perceived-speed feedback first, PERF-03 measured wave collapse next, and FIN-01A owner-money contract/read model in the product-discovery lane. UI-02 follows the first visible UI ship. #597 remains a narrow correctness candidate to refresh from current production after the immediate product train. Waitlist V2 remains WAIT-02/WAIT-03, not a resurrection of #599/#600.

### Historical record — 0.12 Version 1.8 decision delta - audit reconciliation, PAY-SETTLE closure and trust-first product sequence

Version 1.8 is a controlled amendment to v1.7. It preserves every standing North Star, UNKNOWN/completeness law, production-concurrency rule, failed-branch law and human release boundary, while superseding v1.7 current-state and immediate-sequencing claims where they conflict with this amendment.

CURRENT PRODUCTION CHECKPOINT: GitHub production branch claude/build-hone-saas-hOex7 is verified at 46660c21c657b67505bf40350ceb8c5ebfb36f63 after #640. Canonical migration truth is repo 0187, hosted 0187, pending [], next free 0188. This is a timestamped checkpoint, not permission to skip Section 2 revalidation.

PAY-SETTLE is CLOSED_EVIDENCED and PRODUCTION-EXERCISED. #636 merged/deployed; migration 0187 is applied and frozen; a controlled synthetic practitioner-UI smoke recorded paid_cash with operator amount 1000 cents and an independently server-derived quoted_amount_cents snapshot of 1234 cents, created zero payment_charge_attempt rows and no Stripe/email/SMS attributable to the smoke. Provider-verified card money and studio-attested settlement remain separate evidence classes.

<!-- canonical-facts:ignore-start reason=version-1.8-historical-decision-delta-records-the-allowlist-state-as-it-stood-then -->
WAIT-02B Stage B1 (#637) and OWNER-CAP Slice 1 (#638) are the active product release candidates. Both are on the post-#640 production base and remain UNMERGED until exact-head CI + completed exact-head Codex gates are clean. #637 does not activate Willow: the production durable allowlist remains empty and the privacy effective-date/account-holder-notice decision remains a separate human gate. #638 is owner-only capacity/rebooking truth and must fail closed to UNKNOWN rather than publish partial absence.
<!-- canonical-facts:ignore-end -->

#639 vendors six design-engineering skills as development-only tooling. It changes no runtime/dependency/CI/production authority and should refresh/merge after the active product PRs so it does not cause avoidable production-base churn.

AUDIT INPUT: the accepted Run 2B correction at audit head b9e0003fa5809b328fffeb8d352af319138bd531 / hosted migration 0185 reported 0 P0, 6 P1, 9 P2 and 3 P3; Stage A was ready with conditions and Stage B was not ready. Those counts are HISTORICAL EVIDENCE, not current truth. AUTO-BOOT-001 must reconcile every finding against the current head before implementation or closure.

TRUST PRIORITY RESET: until current-head reconciliation proves otherwise, CLIN-01 and OPS-01 are the first trust questions to close because the audit found the weakest evidence in clinical truth and operational readiness. SEC-01, DATA-01, TRUTH-01 and PRIV-01 remain provisional Stage B blockers until individually revalidated and closed/superseded with current evidence.

CLINICAL AUTHORITY RE-ENTRY: HIST-01A becomes the first new authority design workstream after the in-flight release train. Clinically meaningful historical questions use COMPLETE(value), PARTIAL(value, reason, bound), EMPTY_PROVEN(scope, completed_at) and UNAVAILABLE(reason, retryable); only EMPTY_PROVEN licenses definitive absence. Runtime implementation remains HOLD until mechanically derived completeness, an independent falsifier and fault injection are accepted.

PRODUCT CONTINUES WHILE TRUST BURNS DOWN: non-authority product work may continue within the portfolio lane. FIN-01A remains strategically important and is now technically enabled by PAY-SETTLE settlement truth, but broad owner-money implementation follows the immediate trust reconciliation/HIST-01A/OPS-01 sequence. OWNER-CAP may finish because it is already in final review; UI-01/UI-02 may proceed only where they do not disguise or move authority.

PAID MEMORY PROOF: Stage B is not merely a checklist to onboard one studio. Before Stage C self-service investment, Hone must prove a repeatable paid cohort: at least two independent paying studios launch from the same runbook, Treatment Memory is habitually used, Visit Closeout/rebooking/collection behavior is visible, support burden is measured, DR-01A is exercised, export/offboarding are proven, and no Stage A/B P0/P1 remains. Willow is excluded from independent commercial proof.

### Historical record — 0.13 Version 1.9 decision delta - post-#651 performance-first operating state

Version 1.9 is a controlled current-state amendment to v1.8. It preserves the North Star, UNKNOWN/completeness laws, human production boundary, one-at-a-time production movement, failed-branch law, WAIT/ADMIT maturity model and Gate B trust requirements. Where v1.8 current-state or immediate-sequencing prose conflicts with this amendment, v1.9 wins; historical checkpoints remain evidence.

CURRENT PRODUCTION CHECKPOINT: production branch claude/build-hone-saas-hOex7 is verified at 662ac68d7bb5fa84383baf38efe041fdfe994b76 via merged PR #651 (UI-01E). Post-merge production-push CI run #1595 completed SUCCESS on that exact SHA. GitHub/CI settlement is therefore complete at this checkpoint; the Vercel Production deployment state was not independently revalidated by this roadmap update and remains a live pre-release check for the next production action.

MIGRATION TRUTH: canonical hosted migration max remains 0187; repository max remains 0187; pending is []; next free is 0188. No current lane owns migration 0188. 0187 remains frozen production truth.

CLOSED / SHIPPED SINCE THE v1.8 #640 CHECKPOINT: #637 WAIT-02B Stage B1 merged as code/readiness only with Willow durable mode still disabled; #638 OWNER-CAP Slice 1 shipped; #639 vendored six design-engineering skills as development-only tooling; #641 added real browser coverage for OWNER-CAP; #645 added permanent owner Business navigation; #642 and #648 closed two distinct clinical failed-read=>false-absence paths; #643 added live-treatment-consent launch readiness; #644 shipped TRUTH-01A export accountability; #646 shipped the owner Financials spine; #650 made Still to happen temporally truthful; #649 shipped Client Profile tab-navigation acknowledgement; #651 shipped the 44x44 navigation touch-target floor.

CURRENT OPEN PRs: #647 TRUTH-01B-1 remains OPEN/DRAFT at 8c71fa4f9922793e8181b846f4560932ebc2f3dd; CI #1593 completed SUCCESS on that head. #652 FIN-01B remains OPEN/NON-DRAFT at 107272cd4faccc4e47edc9781de5e0c95c363009; CI #1594 completed SUCCESS on that head. #631 HN-037 canonical production reconciliation remains OPEN at 17dae02257b2b967ad2ec530eef4fee21440fd0a and is stale/non-mergeable after #651. Because #647 and #652 were based on pre-#651 production, their prior exact-head review/CI evidence does not authorize merge from the new production base: refresh once, re-run exact-head gates, then decide.

PERFORMANCE PRIORITY RESET: site speed is P1 product quality. The active local program is PERF-01A authenticated-shell single-resolution, PERF-01B Dashboard waterfall collapse, and PERF-01C first-useful-paint/streaming architecture. Optimize real server/network critical path first; perceived-speed work may acknowledge immediately but may not disguise backend latency. Planning targets, not promises: local interaction acknowledgement <100 ms; warm authenticated navigation p75 <400 ms and p95 <800 ms; Dashboard first useful practitioner content p75 <1 s. Claims require comparable timing evidence.

APPLE DESIGN GUIDANCE: Emil Kowalski's apple-design skill is installed globally on hone-dev-01 at ~/.claude/skills/apple-design/SKILL.md and may guide new Claude UI/performance sessions. It is NOT in Hone's skills-lock.json, NOT a repository dependency, NOT runtime code and NOT product authority. Hone-owned clinical truth, #609 primitives, accessibility/reduced-motion rules and measured performance evidence outrank any design-skill suggestion.

PARKED LOCAL WORK PRESERVED: the F-RET deletion-request copy fix is a clean local commit with no PR; OPS-01B operator/scheduler tooling reached a local checkpoint without hosted closure; DB-ACL-01A has current read-only revalidation but no migration file; F3 latest/recency authority remains parked. None of these is silently promoted to shipped capability.

TERMS §16 REMAINS OPEN_HUMAN_DECISION. TRUTH-01A proved the self-serve export does not currently include treatment-image binaries while Terms defines Your Data broadly enough to include photos. Whether §16 is satisfied by self-serve export or an operator-assisted request remains a human legal-policy decision; no automated wording repair is authorized.

CURRENT RELEASE ORDER: #651 is settled. Next, mechanically refresh and exact-head gate #652 and #647 from production 662ac68d; #631 must reconcile the same stable production head before merge. Admit only one refreshed, clean candidate to the production-moving slot at a time. Performance work may continue locally/in read-only design lanes in parallel. Production concurrency remains ONE.

## F.3 August production checkpoints

## Historical record — 3. Historical State Snapshot - 23 Aug 2026 ~00:10 UTC (superseded by Section 3.3)

| **HISTORICAL SNAPSHOT  This section preserves the v1.7 mutable-state record observed around 23 Aug 2026 ~00:10 UTC. It is intentionally retained for audit history and MUST NOT be used as current production truth. Section 3.2 is the v1.8 checkpoint; Section 2 still requires live revalidation before every production-affecting action.** |
| --- |

| **Area** | **Snapshot** | **Interpretation** |
| --- | --- | --- |
| Production application branch | 3a469e17f892163dd483043370188433965fbd66 | #616 is the current production-branch head. #612, #615 and #616 are merged in ancestry; the latter two are engineering-tooling changes and do not widen product runtime authority. Revalidate again before any production action. |
| Hosted migration max | 0184 - LAST VERIFIED | No migration-affecting action is authorized by this amendment. Hosted migration history was not re-read here; 0184 remains the last independently verified maximum and must be revalidated before any 0185 ownership/apply decision. |
| Repository migration max | 0184 | Production still contains migrations through 0184; no 0185 migration file is established by this amendment. |
| Pending migration | repo none observed / hosted UNKNOWN in this update | Repository has no established 0185 owner in the current production snapshot. Hosted pending state must be re-read before migration ownership or apply decisions. |
| PR #593 | MERGED / DEPLOYED / HISTORICAL | Budget release train remains closed in ancestry; it is no longer current production head. |
| Smart #597 | OPEN, UNMERGED, mergeable | Smart PR1 remains open at 641390838dbf632bb379662d7b24f02df881fb87. Keep behind the current correctness/performance/UI train; refresh from current production before release consideration. |
| Dashboard #598 | MERGED / DEPLOYED | Merged as 46097b2f15d30810fdd393df33bdbe3a54a48c2d. Current-client highlight, consultation-notes access, card-on-file status and trusted no-card portal-link action are in production. |
| Release evidence #595/#596 | HOLD / GOVERNANCE | #595 remains a failed discovery record; #596 remains a clean-room correction candidate. Do not rely on either as current production truth without explicit adjudication. |
| Control plane Cycle 2 | CLOSED EXPERIMENT / OBSERVATION SLICES SHIPPED | #615 TEST-PORT-01 and #616 CP-005a shipped. Authority-bearing successors #617-#623 all retired unmerged after exact-head review; CP-007 was not started. Dev Engineering V1 is CLOSED/NOT_NOW pending the Section 16 re-entry gate. |
| WAIT-01 emergency new-client gate | LIVE / WILLOW PILOT | The migration-free waitlist containment is production-exercised for Willow after Stage A/B human gates. Existing-client continuity and zero-business-write canary passed; rollback was not required. Durable queue/invitation semantics remain open. |
| Stale/reference artifacts | #520/#521/#536/#541/#543/#544 plus failed #588/#589/#594 | Reference/evidence only. Preserve learning, not delivery vehicles; open historical PRs should be closed or explicitly dispositioned. |
| Dashboard #606 | MERGED / DEPLOYED | Merged as 456defde4fd3d184473fd74744770770d2c15872. Adds canonical Previous / Today / Next selected-day Dashboard navigation and preserves selected day when exiting to Calendar. |
| Dashboard #607 | MERGED / DEPLOYED / HISTORICAL PRODUCTION STEP | Merged as 96a76c4a55e0b89e1fc5bfac4ebc9d5b8a1a5755. Appointment-bounded selected-day prep subset, lazy treatment disclosure and mobile fixes remain in production ancestry; Chloe acceptance exposed later parity-model debt. |
| Dashboard #608 | CLOSED UNMERGED / RETIRED AFTER ARCHITECTURE STOP | Closed at ceec7755e55d3847604da5be5de75f25b7b60698 after five same-family P1s in partial-history/completeness/false-absence handling. Final valid P1 remains historical evidence. Do not reopen/cherry-pick; rebuild from current production. |
| UI foundation #609 | MERGED / DEPLOYED | Merged/deployed as f698b5ac0a3d3ed9f2955305318cd23d75e44571. Hone-owned tokens and Button/SectionLabel/StatusPill/Field/Skeleton primitives, 44px floor, focus-visible, pressed/pending and reduced-motion contracts are live. |
| Performance baseline #610 | MERGED / DEPLOYED / INSTRUMENTATION DARK BY DEFAULT | #610 remains the baseline instrumentation ancestor. Its production sample is the before side for the completed #612 remeasurement. HONE_PERF_TIMING is dark after the post-#612 window. |
| Selected-day Prep / historical truth | PR #613 STOPPED / OPEN UNMERGED | #613 remains frozen open/unmerged at 14baa34103ce14fe47cb9ae472bec91baf95a7c1 after seven exact-head P1s. Do not patch. HIST-01 remains the product contract; implementation is HOLD until authority-component re-entry conditions are met. |
| UI V2 final recon | COMPLETE / READ-ONLY | Final synthesis harvested 218 confirmed, 97 corrected and 6 unverifiable claims after stopping further expansion. No code changed. Conclusion: use #609 foundation; prioritize loading/pending feedback, touch/accessibility adoption, click cost and surface hierarchy over new libraries. |
| Performance evidence | POST-#612 PRODUCTION REMEASUREMENT COMPLETE | client-profile.domain corrected comparison: p50 584 -> 244 ms (-58.2%), p75 654 -> 310 ms (-52.6%), p95 698 -> 432 ms (-38.1%), N=38 before and N=38 after. One isolated 892 ms post sample is a likely cold start; all post samples were Overview. PERF-03 owns the next measured lever. |
| PR #612 / PERF-02 | MERGED / DEPLOYED / PRODUCTION VALIDATED | Merged as 69d9f36f6b89b5272e491f593611e6d4075d1b8d. Production remeasurement supports a material Client Profile speed improvement. Static completeness-proof work remains retired; PERF-03 starts from measured runtime behavior, not source-shape testimony. |
| PR #613 / historical authority | OPEN / UNMERGED / ARCHITECTURE STOP | Head 14baa34103ce14fe47cb9ae472bec91baf95a7c1. Seven P1s coexist with green CI/test suites. Same-family threshold fired. Preserve tests/scenarios/discoveries; implementation ancestry does not carry. |
| PR #611 | CLOSED UNMERGED / SUPERSEDED | Positive-evidence replacement vehicle was retired when bounded recency/completeness remained unsafe. Preserve discovery value only; do not revive implementation. |
| TEST-PORT-01 / #615 | MERGED / SHIPPED | Merge 6fe93ccf8d03e0c34fd6c6daa666a73fe3d8eeed. Per-worktree app-port derivation and no server reuse are live in the dev/test harness; shared local DB/Mailpit remains an explicit limitation. |
| CP-005a / #616 | MERGED / SHIPPED / OBSERVATION ONLY | Merge 3a469e17f892163dd483043370188433965fbd66. Exact-head GitHub/CI/review fact ingestion is live as read-only operator tooling. No durable findings state, readiness authority, stop engine or merge capability shipped. |
| Dev Engineering authority V1 / #617-#623 | CLOSED / 7 RETIRED UNMERGED | Seven authority-bearing successors failed exact-head adversarial review despite green CI. Preserve fixture corpus and retrospective laws; do not resume under the same self-certifying completeness process. |

### Historical record — 3.1 v1.7 historical production checkpoint and WAIT-01 interrupt contract

Production application branch HEAD is 3a469e17f892163dd483043370188433965fbd66 after #612, #615 and #616. #613 remains stopped/open-unmerged; #597 remains open on an older base and must be refreshed before release consideration. Revalidate before any production-affecting action.

Repository migration max remains 0184 with no established 0185 claimant in current production source. Hosted max remains LAST VERIFIED 0184 in this amendment and was not independently re-read; hosted migration truth must be revalidated before any 0185 ownership or apply decision.

WAIT-01 remains a live Willow pilot after Stage A dark proof, Stage B activation, human inbox canary and existing-client continuity checks. The V1 is temporary containment; the server-only studio flag remains the kill switch and WAIT-02/WAIT-03 own the durable destination.

Selected-day prep/history correctness remains unresolved. #608 and #611 are closed unmerged; #613 is stopped/open-unmerged with seven P1s. Preserve tests, scenarios and authority discoveries, not implementation ancestry. HIST-01 exact-question semantics remain the product contract, but a new authority implementation is HOLD until Section 16.5 re-entry conditions are met.

NEW CLINICAL TRUTH RULE: a positive fact actually read may render. A fully read authoritative scalar null may license a scoped missing-value reminder. Missing child rows from capped, sliced, filtered or failed collections may not become "not recorded", "none", "new client" or any other absence claim.

DEV ENGINEERING V1 RESULT: exact-head adversarial review was the only consistently successful falsifier across seven retired authority-bearing vehicles. Observation-only tooling shipped; authority-bearing tooling did not. Scope reduction did not change the outcome. Manual stop laws remain governance discipline, not software authority.

UI0 #609 is live. The next visible product sequence is UI-01 perceived-speed floor, then UI-02 foundation/accessibility adoption; UI-03 Dashboard presentation still waits for safe historical truth. No external UI framework or motion runtime is authorized.

PERF-02 #612 is merged and production-remeasured: client-profile.domain p50 584 -> 244 ms, p75 654 -> 310 ms and p95 698 -> 432 ms in the corrected N=38/N=38 comparison. One isolated 892 ms post sample is likely cold start; all post samples were Overview. HONE_PERF_TIMING is dark again.

The next Client Profile lever is PERF-03 measured remaining-wave collapse. Post-#612 behavior is roughly four waves on light tabs and up to nine on Overview; instrument each wave, parallelize true independents toward 2-3 waves, then consider DB aggregation/RPC and targeted indexes only if timing warrants.

No external UI runtime/package is authorized by this amendment. WAI-ARIA APG, Next.js docs, Hone precedents and real healthcare-product precedent remain references; Motion/Framer Motion remains rejected as a runtime dependency.

Production movement remains one-at-a-time. Human merge/release authority is permanent for Phase 1. Green CI and a responding reviewer are evidence, never automatic readiness; the current control plane has no shipped readiness/merge authority.

### Historical record — 3.2 Historical production checkpoint - 25 Aug 2026 ~01:40 UTC (superseded by Section 3.3)

| **SNAPSHOT ONLY  This checkpoint reconciles the current GitHub production branch and canonical migration record after #640. It is deliberately non-authoritative after creation: re-run Section 2 before any merge, migration, provider enablement or destructive action.** |
| --- |

| **Area** | **Verified snapshot** | **Interpretation** |
| --- | --- | --- |
| Production application branch | 46660c21c657b67505bf40350ceb8c5ebfb36f63 | #640 is merged; branch protection remains enabled. #636 PAY-SETTLE and migration-state reconciliation are in ancestry. |
| Migration truth | hosted 0187 / repo 0187 / pending [] / next free 0188 | 0187 is frozen. 0188 is available and unclaimed at this checkpoint. |
| PAY-SETTLE / #636 | MERGED / DEPLOYED / PRODUCTION-EXERCISED | External settlement path proved through authenticated production UI. One synthetic paid_cash row stored amount 1000 and independent quoted snapshot 1234; zero payment attempts created. |
| WAIT-02B Stage B1 / #637 | OPEN / MERGEABLE / FINAL REVIEW | Privacy + activation-readiness only. Willow durable mode remains disabled, production durable allowlist empty, no migration, no activation authority. |
| OWNER-CAP Slice 1 / #638 | OPEN / MERGEABLE / FINAL REVIEW | Owner-only /dashboard/capacity: one-snapshot active-treatment/rebooking worklist, treatment-only booking depth, UNKNOWN fail-closed. Not merged yet. |
| Design skills / #639 | OPEN / TOOLING ONLY | Six vendored design-engineering skills; no runtime/dependency/CI authority. Refresh and merge after product PRs. |
| Historical authority / #613 | STOPPED / OPEN-UNMERGED | Seven same-family P1s remain evidence. Do not patch/cherry-pick. HIST-01A verification architecture is the re-entry path. |
| Audit register | Run2B corrected: 0 P0 / 6 P1 / 9 P2 / 3 P3 at b9e0003 | Historical audit source only. Current-head AUTO-BOOT reconciliation required before any finding is called open or closed. |
| Production concurrency | ONE | Development may run in parallel; only one production-moving release at a time. |

PAY smoke evidence is durably recorded on merged PR #636; a separate docs-only production move is deliberately deferred until the next sensible reconciliation.

Current in-flight release rule: whichever of #637 or #638 obtains a genuine clean exact-head outcome first may merge first; the other must then refresh once from the new production head before its final gate. #639 remains last.

No audit finding is implemented directly from the b9e0003 register. Current source, hosted state, current tests/behavior and current exact-head review outrank historical severity/status.

### Historical record — 3.3 Current production checkpoint - 27 Aug 2026 ~18:07 UTC

| **SNAPSHOT ONLY  This checkpoint reconciles live GitHub production/PR state and canonical migration truth at ~18:07 UTC on 27 Aug 2026. It is already non-authoritative after creation: re-run Section 2 before any merge, migration, provider enablement or destructive action. #651 is merged and its GitHub production-push CI is green; Vercel Production state is still revalidated at the next release boundary.** |
| --- |

| **Area** | **Verified snapshot** | **Interpretation** |
| --- | --- | --- |
| Production application branch | 662ac68d7bb5fa84383baf38efe041fdfe994b76 | #651 UI-01E is merged into production. Branch protection remains enabled. This is the current branch head; post-merge GitHub CI #1595 completed SUCCESS. |
| Release settlement | PR #651 merged; CI #1595 SUCCESS | UI-01E is settled in GitHub/CI on production 662ac68d. Before the next merge, independently revalidate Vercel Production and the candidate branch against the current head. |
| Migration truth | hosted 0187 / repo 0187 / pending [] / next free 0188 | 0187 remains frozen. 0188 is available but currently unclaimed; no DB-ACL or other lane owns it at this checkpoint. |
| TRUTH-01B-1 / #647 | OPEN / DRAFT / head 8c71fa4f / CI #1593 SUCCESS | Adds 27 approved columns and five CSV resources without schema/storage/Terms changes. Successful CI is on the pre-#651 head; refresh from 662ac68d and reacquire exact-head CI + Codex before release. |
| FIN-01B / #652 | OPEN / NON-DRAFT / head 107272cd / CI #1594 SUCCESS | Changes owner-facing calendar-total copy to 'Appointments in this period'; arithmetic remains unchanged. Successful CI is on the pre-#651 head; refresh from 662ac68d and reacquire exact-head gates before merge. |
| HN-037 canonical reconciliation / #631 | OPEN / head 17dae022 / stale after #651 | Docs/tests-only canonical-five reconciliation. Current GitHub mergeability is false after production moved; it must refresh to the final stable production head and clear current review findings before merge. |
| Performance program | PERF-01A/B/C ACTIVE LOCALLY / NO PR | A: deduplicate authenticated shell identity/membership work; B: map/collapse Dashboard server waterfall; C: define first-useful-paint/streaming boundaries. Real latency first; Apple-style feedback cannot mask backend delay. |
| Design guidance | apple-design GLOBAL on hone-dev-01 / repo unchanged | Available at ~/.claude/skills/apple-design/SKILL.md for new sessions. Not in skills-lock.json, not vendored in the repo and not runtime/product authority. |
| Production concurrency | ONE | Development may run in bounded parallel lanes. Only one production-moving release may be in merge/deploy/smoke/settlement at a time. |

Release controller rule at this snapshot: #651 has settled successfully in GitHub/CI, so the production lock is no longer occupied by that release. No other branch is currently merge-authorized: #647, #652 and #631 must first refresh from production 662ac68d (as applicable), re-establish mergeability, and reacquire fresh exact-head CI + Codex evidence before one of them may enter the single production-moving slot.

Performance work is intentionally parallel and local/read-only until a bounded patch is independently proved. F-RET, OPS, DB-ACL and F3 remain preserved rather than discarded.

## F.4 August executive queue and paired cycles

## Historical record — 23. Immediate Executive Queue and Paired Delivery Cycles

### Historical record — 23.1 Immediate executive queue

1. #651 UI-01E IS SETTLED: production is 662ac68d and post-merge CI #1595 completed SUCCESS. Treat this as the stable GitHub/CI base for the next refresh; independently revalidate the actual Vercel Production deployment before authorizing the next merge.

2. REFRESH BEFORE RELEASE: #652 FIN-01B and #647 TRUTH-01B-1 both have successful CI on their pre-#651 heads, but that evidence is now stale for release because production moved. Mechanically compare overlap, merge current production 662ac68d into each with a normal merge commit if clean, then reacquire fresh exact-head CI + Codex. #647 stays draft until deliberately promoted. #631 likewise needs one final refresh/reconciliation from stable production before its final gates.

3. FINALIZE CANONICAL TRUTH AFTER THE PRODUCT HEAD STOPS MOVING: #631 HN-037 is open and stale after #651. Refresh it once onto the final stable production head, repair only current review/control defects, update chronology for all newly shipped PRs, and require one fresh exact-head CI + Codex. Do not let the canonical docs chase every in-flight local branch.

4. PERFORMANCE IS NOW P1 PRODUCT QUALITY: run PERF-01A authenticated-shell single-resolution, PERF-01B Dashboard waterfall collapse and PERF-01C first-useful-paint/streaming in parallel local/read-only lanes. Optimize real request time first; Apple-style feedback may acknowledge immediately but may not hide backend delay.

5. PRESERVE CLINICAL TRUTH: #642 and #648 close important failed-read=>false-absence paths, but F3/HIST latest/recency/completeness authority is not globally closed. Do not broaden caching or reintroduce capped-window absence/latest inference as a speed shortcut.

6. KEEP TRUST WORK MOVING WITHOUT BLOCKING PRODUCT: OPS-01 hosted ownership/cadence/backlog/provider-canary/recovery proof remains open; DB-ACL-01A revalidation is complete but no migration exists; STORAGE/BCDR evidence and Terms §16 human decision remain separate gates.

7. EXPORT SEQUENCE: #644 TRUTH-01A is shipped. #647 TRUTH-01B-1 may continue toward a clean draft/ready state after refresh; treatment-image binaries/TRUTH-01C and Terms §16 remain out of scope. No self-serve 'complete archive' claim until the manifest/count/binary truth actually supports it.

8. FINANCIALS SEQUENCE: #646 and #650 are shipped; #652 is the narrow copy-truth correction. Do not pull broader money arithmetic into #652. Net collected, refunds, outstanding, completed service value and provider-verified vs studio-attested aggregation remain later FIN slices with explicit authority.

9. UI SEQUENCE: #649 UI-01D and #651 UI-01E are SHIPPED and #651 GitHub/CI settlement is complete. UI-01F/UI-01G may follow as bounded accessibility families, but PERF-01A/B/C outrank broad visual redesign until the app stops feeling slow. Apple Design is guidance, not permission to add a motion runtime.

10. PARKED LOCAL WORK IS NOT LOST: preserve the clean local F-RET copy commit, OPS local tooling, DB-ACL recon evidence and F3 investigation. Promote each only through a fresh bounded branch/PR when its slot arrives; do not silently merge local commits into unrelated work.

11. WAIT / ADMISSION REMAINS POLICY-GATED: #637 merged Stage B1 readiness, but durable Willow activation is still not authorized by a merge. Preserve the empty/default-off allowlist and require the separate human legal/effective-date/account-holder-notice decision plus T4a smoke if activation is ever requested.

12. GATE B / PAID DESIGN PARTNERS REMAIN BLOCKED ON CURRENT-HEAD TRUST EVIDENCE: no paid independent partner until current P0/P1 Gate B blockers are closed/superseded with evidence, OPS/DR/export/offboarding truth is sufficient and Terms/privacy decisions are human-approved. PAID_MEMORY_PROOF-001 still requires at least two independent paying studios before Gate C self-service investment.

Current release checkpoint: production branch HEAD is 662ac68d after #651; repo/hosted migration max remain 0187 with pending [] and next free 0188. Post-merge CI #1595 is SUCCESS, so #651 no longer occupies the production slot. #652/#647/#631 are not merge-authorized from their pre-#651 bases; refresh/re-gate first, then admit only one candidate to production at a time.

Audit/canonical checkpoint: #631 HN-037 is the live canonical-five reconciliation vehicle at head 17dae022, but it is stale/non-mergeable after #651 and still has current review-control work. Historical Run2B counts remain evidence sources, not current status.

Clinical/ops checkpoint: #642 and #648 shipped fail-closed read-truth repairs; F3/HIST recency authority remains parked. OPS hosted ownership/drill proof remains open; local tooling is not closure.

Product checkpoint: OWNER-CAP is shipped (#638/#641/#645). Financials foundation is shipped (#646/#650) with #652 copy truth open. TRUTH-01A is shipped (#644) with #647 draft expansion open. Whole-app performance is the active P1 product-quality program.

Review/control-plane checkpoint: exact-head adversarial review remains the independent falsifier. Review silence is HOLD. #615/#616 observation tooling stays useful; authoritative readiness/ledger/auto-merge remains NOT_NOW. Apple Design is operator guidance only.

Production concurrency remains ONE. Development may continue in bounded parallel lanes. #651 no longer occupies the production slot; the next production-moving candidate must first refresh from 662ac68d, reacquire exact-head CI + Codex, pass the release preflight including Vercel Production revalidation, and then enter the slot alone.

### Historical record — 23.2 Paired delivery cycles

| **Cycle** | **Trust / Reliability** | **Planned Product** | **Human / Commercial** |
| --- | --- | --- | --- |
| 0 | #609/#610 release truth + #608 retired evidence | #609 UI foundation and #610 PERF-00 are CLOSED delivery; #608 is CLOSED UNMERGED after architecture stop | Production at #610 merge 88bba0e1. WAIT-01 Stage A/B remains live; no completed PERF sample recorded yet. |
| 1 | #612 MERGED + #613 architecture stop | PERF-02 production validation + UI-01/UI-02 eligibility; HIST-01 contract preserved | #612 merged and remeasured at p50 244 ms / p95 432 ms. #613 remains stopped and does not merge. Historical implementation does not restart under the old verification process. |
| 2 | #636 PAY-SETTLE + #640 state record CLOSED; #637/#638 final review | #637 WAIT privacy/readiness + #638 OWNER-CAP worklist; #639 tooling parked | PAY production smoke PASS. Merge #637/#638 one at a time from exact reviewed heads; no Willow durable activation. |
| 3 | AUDIT-RECON-01 + HIST-01A re-entry design + OPS-01 hosted proof | OWNER-CAP follow-up browser proof; FIN-01A discovery; non-authority UI-01/UI-02 only | No paid partner. Accept the new historical verification process before runtime authority work. |
| 4 | SEC-01 + DATA-01 + TRUTH-01 + PRIV-01 current-confirmed P1 trains; helper/storage evidence tail | HIST-01 implementation only after re-entry acceptance; FLOW Closeout contract; FIN-01A read model | Gate B preflight begins only when Stage A/B P1 register is zero. DR-01A restore exercise in this band. |
| 5 | DR-01A + Gate B trust closure | Visit Closeout FLOW-01/02/03 + rebooking; FIN-01A implementation when truth dependencies are closed | Onboard first independent paid design partner only after Gate B entry criteria; pause and measure. |
| 6 | Trust maintenance + targeted evidence repair | FIN-01A + OWNER-CAP/rebooking learning; WAIT-03 only if durable WAIT path is authorized | Onboard second independent paid studio only after partner 1 evidence; build PAID_MEMORY_PROOF. |
| 7 | PAID_MEMORY_PROOF-001 adjudication | Treatment Memory habit/Closeout/rebooking + capacity/admission learning | If milestone passes, authorize Gate C investment. If not, close the measured gap before breadth. |
| 8 | TRUTH-01B/D | Visit Closeout + PAY-UX + HEALTH-01 capacity briefing | Partner learning; measure lead time, waitlist pressure, rebooking and closeout. |
| 9 | PRIV-01A/B | Appointment editing + rebooking + Cancellation Recovery offer/claim convergence | Partners 2-5 learning; measure released-capacity recovery. |
| 10 | PRIV-01C/D/E | Cancellation cutoff + partial refunds; ADMIT-03 pilot only if assisted evidence is strong | Self-service readiness; human authorization for any automatic-release pilot. |
| 11+ | Trust maintenance | Financials -> Health -> SaaS activation -> ADMIT-04 capacity-expansion economics | 10-50 gate preparation; decide whether automatic admission becomes general product. |
| 3A - 27 Aug current overlay | #631 canonical reconciliation stale-after-#651; OPS/DB-ACL/STORAGE evidence work preserved; no migration owner | #651 UI-01E merged/settled; #652 FIN copy + #647 export draft have green CI on pre-#651 heads but require refresh/re-gating; PERF-01A/B/C active local; UI-01F/G next | No new production move until a refreshed candidate reacquires exact-head gates from production 662ac68d. No paid partner. Apple Design is local guidance only; Terms §16 remains a human legal-policy decision. |

## F.5 Original v1.9 PR hygiene and artifact disposition

Historical table preserved from Appendix A. Every old present-tense status and imperative is reference-only. Current selected PR facts are in §3; failed-branch and human authorization laws remain binding.

| **Artifact** | **Disposition** | **Reason** |
| --- | --- | --- |
| #593 | MERGED / CLOSED_EVIDENCED | Budget release train completed as production SHA 266b6092; hosted/repo migration max 0184. Do not reopen the release train for historical evidence wording. |
| #588 | CLOSED UNMERGED | Calendar failed delivery vehicle; preserve regression corpus and product contract only. |
| #589 | CLOSED UNMERGED | Smart failed delivery vehicle; do not revive implementation. |
| #594 | CLOSED UNMERGED | Shared controller experiment; do not cherry-pick architecture. |
| #541/#543/#544 | CLOSE AS SUPERSEDED REFERENCES | Stale stacked synthetic-mirror drafts. Preserve privacy/test discoveries under future TEST-PLAT item. |
| #536 | CLOSE AS REFERENCE SPEC | 2,387-line stale metric spec. Extract metric-family contracts when parent capability begins. |
| #520/#521 | CLOSE AS HISTORICAL AUDITS | Superseded by 0172-0179 integrity series; findings belong in canonical register, not open PR queue. |
| CP-001 | PARK / DRAFT HOLD | Blocked by private-repo GitHub protection capability. Upgrade plan rather than weaken trust model. |
| WAIT-01 | LIVE / WILLOW PILOT | Emergency containment delivered through #601/#604 and activated under Stage A/B human gates. V1 remains temporary; durable queue/invitation work stays in WAIT-02/03. |
| #597 | KEEP ACTIVE / HOLD BEHIND CURRENT TRAIN | Smart PR1 weekday correction remains open on stale base 266b6092. Refresh from current production 3a469e17 before release consideration; preserve M1/M2 follow-ups and explicit P3 adjudication. |
| #598 | MERGED / DEPLOYED | Merged as 46097b2f; current-client highlight, consultation-notes action, three-state card status and trusted no-card portal action are production ancestry. |
| #595 | CLOSE AS FAILED DISCOVERY RECORD | Six review rounds exposed evidence-engineering convergence failure. Preserve history; do not merge/cherry-pick/reopen. |
| #596 | HOLD / CLEAN-ROOM CANDIDATE | Adjudicate as REL-EVID-01 after P0. If accepted, merge only from current production with normal history and bounded review; otherwise supersede explicitly. |
| #606 | MERGED / DEPLOYED | Selected-day Dashboard navigation shipped as 456defde. Preserve canonical day URL and Calendar handoff behavior. |
| #607 | MERGED / DEPLOYED / HISTORICAL STEP | Merged as 96a76c4a. Safe bounded selected-day prep subset and lazy disclosure remain production ancestry; no longer production head. Chloe acceptance exposed parity-model debt. |
| #608 | CLOSED UNMERGED / RETIRED | Closed at ceec7755 after five same-family P1s in partial-history/completeness/false-absence handling. Keep forensic tests/scenarios/authority discoveries; do not reopen, merge, cherry-pick or treat its implementation as architecture. |
| #609 | MERGED / DEPLOYED | UI foundations merged/deployed as f698b5ac. Semantic tokens and six small server-compatible primitives are live; no external UI dependency was added. |
| #610 | MERGED / DEPLOYED / DARK BY DEFAULT | Performance baseline merged/deployed as 88bba0e1 and remains the before-measurement ancestor. HONE_PERF_TIMING is dark after the completed #612 post-merge production window. |
| Selected-day Prep / history program | PRODUCT CONTRACT OPEN / DELIVERY VEHICLES STOPPED / IMPLEMENTATION HOLD | #608 and #611 are closed unmerged; #613 remains stopped open/unmerged after seven P1s. Preserve tests/scenarios/authority discoveries. HIST-01 remains the product contract, but another authority implementation is HOLD until Section 16.5 re-entry conditions are met. |
| #611 | CLOSED UNMERGED / RETIRED | Positive-evidence projection reduced false-absence surface but still relied on bounded recency/completeness. Preserve product/tests/discoveries; do not revive implementation. |
| #612 | MERGED / DEPLOYED / PRODUCTION VALIDATED | Merged as 69d9f36f. Production remeasure supports material improvement: p50 584 -> 244 ms, p75 654 -> 310, p95 698 -> 432 (corrected N=38 before/after). PERF-03 owns the next measured lever. |
| #613 | OPEN UNMERGED / STOPPED AFTER ARCHITECTURE LAW | Head 14baa341. Seven exact-head P1s collapsed into unavailable->null false absence, bounded->false completeness and proxy-evidence selection/projection. Do not patch. Preserve evidence and move to HIST-01 design. |
| #615 | MERGED / SHIPPED | TEST-PORT-01 clean successor merged as 6fe93ccf. Worktree app-server isolation/no reuse is live; shared local DB/Mailpit remains a declared limitation. |
| #616 | MERGED / SHIPPED / OBSERVATION ONLY | CP-005a merged as current production-branch head 3a469e17. Exact-head PR/CI/review fact/provenance reader shipped; no readiness/ledger/merge authority. |
| #617-#623 | CLOSED UNMERGED / DEV ENGINEERING V1 RETIRED | Seven authority-bearing control-plane vehicles retired after exact-head adversarial findings despite green CI. Preserve fixtures and retrospective laws; do not restart under the same verification process. |
| #599/#600 | CLOSE AS SUPERSEDED WAIT-01 VEHICLES | Emergency waitlist delivery ultimately shipped through #601/#604. #599/#600 are historical/failed clean-room vehicles and are not release candidates. |
| #636 | MERGED / DEPLOYED / PRODUCTION-SMOKED | PAY-SETTLE release. Migration 0187 + application shipped; authenticated synthetic UI smoke proved paid_cash 1000 with independent quote snapshot 1234, zero payment attempts and no Stripe/email/SMS attributable to the smoke. |
| #640 | MERGED / DEPLOYED / CANONICAL STATE | Recorded verified 0187 production apply and reconciled canonical migration state. Production branch is 46660c21 at the v1.8 snapshot. |
| #637 | MERGED / DEPLOYED / NO DURABLE WILLOW ACTIVATION | WAIT-02B Stage B1 privacy + activation-readiness code shipped. Production durable allowlist/Willow activation remain separate human/T4a decisions; merge alone did not authorize activation. |
| #638 | MERGED / DEPLOYED | OWNER-CAP Slice 1 shipped the one-snapshot owner capacity/rebooking worklist with treatment-only booking depth and UNKNOWN fail-closed; later #641/#645 completed browser coverage and permanent Business navigation. |
| #639 | MERGED / DEVELOPMENT TOOLING | Six vendored design-engineering skills with Hone-reviewed patch layer. No runtime/dependency/CI authority. Separate operator-local apple-design install is not part of this PR or repo. |
| #641 | MERGED / SHIPPED | OWNER-CAP browser coverage and browser-group registration; real owner/practitioner access and rebooking-link behavior proved. |
| #642 | MERGED / SHIPPED | Client Profile clinical read truth: failed session_blocks reads no longer become confident no-history/no-watch-plan/zeroed intelligence states. |
| #643 | MERGED / SHIPPED | Studio launch readiness requires at least one live active treatment consent; unknown read is a third state; no legal-compliance claim. |
| #644 | MERGED / SHIPPED / TRUTH-01A | Canonical export resource registry, copy truth, manifest/count/audit accountability; payload intentionally unchanged. Terms §16 stopped for human decision. |
| #645 | MERGED / SHIPPED | Permanent owner Business navigation to the capacity surface; compact/full header boundary corrected. |
| #646 | MERGED / SHIPPED / FIN-01A SLICE 1 | Owner-only Financials spine over appointment/disposition truth with explicit unknown vocabulary; no money arithmetic. |
| #647 | OPEN / DRAFT / STALE AFTER #651 | TRUTH-01B-1: 27 approved columns + five CSV resources. Head 8c71fa4f; CI #1593 SUCCESS on pre-#651 base. Refresh from 662ac68d and reacquire exact-head CI/Codex before release. |
| #648 | MERGED / SHIPPED | Dashboard Before-Today failed reads fail closed; successful empty remains distinct from unavailable. F3 recency/tie remains separate. |
| #649 | MERGED / SHIPPED / UI-01D | Client Profile tab navigation acknowledges requested destination, preserves focus and does not disable unrelated tabs. |
| #650 | MERGED / SHIPPED | Financials temporal truth: confirmed rows split into truly future vs past-still-confirmed using starts_at; stale statuses are not inferred into outcomes. |
| #651 | MERGED / PRODUCTION / CI SETTLED | UI-01E: 12 confirmed Client Profile navigation links receive real >=44x44 hit targets with geometry/hit-test proof. Merged to production as 662ac68d; post-merge CI #1595 SUCCESS. |
| #652 | OPEN / NON-DRAFT / STALE AFTER #651 | FIN-01B copy truth: 'Appointments in this period' replaces misleading 'Booked'; arithmetic unchanged. Head 107272cd; CI #1594 SUCCESS on pre-#651 base. Refresh from 662ac68d and reacquire exact-head gates before merge. |
| #631 | OPEN / GOVERNANCE / STALE AFTER #651 | HN-037 canonical-five reconciliation at 17dae022. Docs/tests only; currently non-mergeable after production movement and must refresh to final stable head before exact-head release gates. |

| **OPEN PR SEMANTICS  Open PR means realistically moving toward merge. Historical research, superseded delivery vehicles and long-lived specs belong in the roadmap/evidence register, not the active PR queue.** |
| --- |

**END OF EARLIER HISTORICAL ARCHIVE — v1.10 superseded operating records follow in F.6.**

## F.6 Superseded v1.10 operating records — 6 September 2026

| **HISTORICAL ONLY — SOURCE PRESERVATION** |
| --- |
| The following blocks are preserved from the attached v1.10, without promoting their old instructions or source claims. New decisions, source corrections and the current snapshot are in v1.11 §§0, 3, 14.5 and 23. The original complete v1.10 file is also retained by the user. |

### F.6 · Decision register

### Historical v1.10 — 0.4 v1.10 decision and supersession register

| **Decision** | **Source and change** | **Disposition** |
| --- | --- | --- |
| RDM-001 / order | Sam’s explicit sequence in this thread: Twilio → WAIT-03 → FIN. [S1, S7] | ACCEPTED_PRIORITY. Supersedes the 4 September FIN-next release train, not the long-term North Star. |
| WAIT parallelism | Prepare Chloe’s scoped, email-first invitation contract in a separate lane while SMS finishes. [S7] | Current authorization is contract/recon/acceptance design. Implementation follows contract review; production remains serialized. |
| Chloe scoped booking | Selected people, limited booking horizon or specific days, secure entry, decline and remain waiting; urgent need to add people. [S7] | USER_REQUIREMENT attached to WAIT-03. One booking, service choice, intake cap and verification UX are separately labeled proposed defaults. |
| FIN architecture | Merged #672 replaces the multi-read loader direction of held prototype #666. [S8] | FIN-02A shared-snapshot authority, then FIN-02B UI/model adoption. The contract is not shipped implementation. |
| Bounded WAIT completion | Ship the useful manual workflow and necessary operational completion before FIN; do not make all future ADMIT intelligence a prerequisite. [S7] | Advanced ranking, capacity forecasts and automatic release remain Later under their existing gates. |
| Source of truth | One operational checkpoint; fact-specific evidence; historical instructions archived. [S1] | No promotion from GitHub merge to hosted/provider/user completion. Repository publication of this amendment remains pending. |

### F.6 · Operational checkpoint

### Historical v1.10 — 3. Current Operational Checkpoint — 6 September 2026

| **SNAPSHOT ONLY  Cutoff 6 September 2026 · 18:08 UTC. GitHub and the selected source files were read for this update. No direct Supabase, Vercel or Twilio inspection was performed. “Hosted recorded” below means the committed observation, not a new live database query.** |
| --- |

| **Domain** | **State established** | **Evidence / limitation** |
| --- | --- | --- |
| Production branch | ea70bd0543993937ba42259037c903fac6c6fc15<br>claude/build-hone-saas-hOex7 | VERIFIED_REPO. #675 merge; not independent proof of the currently serving Vercel artifact. [S2, S5] |
| Hosted database, recorded | 0191; 190 history rows; 0191 once; 0192 absent | RECORDED_HOSTED_OBSERVATION at 2026-09-06T16:03:53Z. No apply instant or pre-apply census asserted by that reconciliation. [S3] |
| Production-tree migrations | Repo max 0191; recorded-hosted delta []; derived next free "0192" / numeric 192 | Production-tree derivation as recorded in S3, not rerun by this edit. #674 owns its authored 0192; a derived number is not cross-worktree allocation. [S3] |
| Active SMS PR #674 | f26a2fef1396a52733930976e45996f56574a649<br>OPEN / non-draft / mergeable | VERIFIED_REPO. Base ea70bd0543993937ba42259037c903fac6c6fc15. 11 commits / 16 files at capture. No merge authorization. [S4] |
| CI / current review | Run #1770 / 34049932690 completed SUCCESS on this exact head.<br>Codex raised a P1 at this exact head: gate sender routing until ACTIVE rows exist (17:56:46 UTC). This confirms the Willow cutover HOLD; no clean release verdict is claimed. | Prior #1769 SUCCESS tested 2be47afc, not the new head. Do not relabel earlier local 67/67 DB or 296/296 SMS results as new-head executions. [S4, S6] |
| Willow sender readiness | Recorded sender table 0 rows; no ACTIVE per-studio sender established | Do not cut over to mandatory studio routing under that state. Actual provider-resource existence is UNKNOWN to this update. [S3, S4] |
| WAIT-03 product | Lifecycle foundation in production ancestry; selected-recipient scoped booking not established as shipped | #664 is merged. Current queue/callers do not constitute the requested complete product. Contract assignment has no completion report yet. [S7, S9] |
| FIN-02 | Domain/snapshot contract merged; replacement implementation remains planned / parked | #672 is design authority. #666 is open/unmerged held prototype, not the release destination. [S8] |
| External studio / commercial | Location, provider registration, actual activation and full Gate B readiness not established here | External Studio #1 is a rollout target, not proof of an independently paid, launch-ready studio. [S1, S7] |

### Historical v1.10 — 3.1 New-source contradictions must stay visible

At #674 head f26a2fef1396a52733930976e45996f56574a649, .env.local.example now describes database-routed sending and the dated September 4 ledger table is restored. However, the current “What 0191 establishes” narrative still says 0192 is “ABSENT FROM THIS TREE” and pending is empty, while the current branch table correctly says repo 0192 / pending [0192]. This is a source-level documentation contradiction, not a claim that the hosted database changed. Its disposition must be rechecked on the next exact head; this roadmap does not silently mark all documentation clean. [S10, S11]

The source also reports inherited canonical-production-facts failures (A3/A5/RULE F) and explains that a green CI badge did not exercise all of those checks under shallow history. Preserve that evidence boundary; do not claim a comprehensive clean local suite or waive unrelated debt. This document is not a replacement audit of those tests. [S4, S12]

### Historical v1.10 — 3.2 Selected PR register — not an exhaustive repository census

| **PR / program** | **Verified GitHub state** | **Roadmap treatment** |
| --- | --- | --- |
| #664 / WAIT-03 | MERGED; f46521ca3221e84ed482ff4c15ed5511cebd52ca | Historical database lifecycle delivery. Do not reapply 0188–0190 or restart the old Google timeout gate. [S9] |
| #673 / COMMS-01B | MERGED; 7e4e09d897f403dd560571978fb33b72516f0fa7 | Provisioning foundation. Old PR-body “0191 pending” is stale; the later recorded hosted observation wins for that fact. [S3, S12] |
| #675 / 0191 record | MERGED; ea70bd0543993937ba42259037c903fac6c6fc15 | Documentation reconciliation finished; no runtime or database mutation by that lane. [S5] |
| #674 / COMMS-01B2 | OPEN; f26a2fef1396a52733930976e45996f56574a649 | Only current SMS implementation candidate in the assigned work plan; HOLD for exact-head closure and Willow cutover. [S4] |
| #672 / FIN contract | MERGED; 24c6dfd534b96f9f19c66d30a25a87027365e45e | Accepted intended domain/snapshot contract, not FIN-02 implementation. [S8] |
| #666 / FIN prototype | OPEN / unmerged / non-mergeable when read | Frozen reference for reusable model/UI and tests, not a branch to merge around the snapshot stop. [S8] |
| #667 / UI-01G | OPEN / unmerged; 21652f15a7ecf74f61b96d6f1191a7bcc45dba87 | Parked touch/focus adoption slice. Refresh and re-prove only when scheduled. [S13] |
| #669 / UI-01H-A | OPEN / unmerged; 525c30d24d5a0e943a187e9d85e311338997af53 | Parked section-switch acknowledgment. Old dependence on #666 is not an instruction to merge #666. [S13] |
| #665 / SEC-01A | OPEN / DRAFT; f44252e44fe525b45b679de4c65b04e849210bde | Contract candidate, not possession-proof closure. Scope-label conflict noted in §13.1. [S14] |
| #647 / export slice | MERGED; 1d6d7c48c2911fb5cc33d3e25f25b8bfaefaf1c5 | TRUTH-01B-1 bounded expansion; complete/binary archive is not established. [S15] |
| #652 / Financials copy | MERGED; a72b992fa053ec7acb4afeeb3223f4e924c7cdf9 | Appointments label correction; no money arithmetic. Remove from active release queue. [S16] |

### Historical v1.10 — 3.3 Next-number and release-ownership rules

0188–0191 are recorded applied and are frozen. #674 owns the authored 0192 in its branch, but this snapshot grants no apply. Production source derives 0192; the #674 branch derives 0193. Neither proves 0193 is unclaimed across local worktrees. COMMS-01C, WAIT and FIN receive a number only through the single operator’s fresh migration census and allocation. Do not preassign 0193/0194, rename FIN from a screenshot, or merge a superseded sibling migration.

### Historical v1.10 — 3.4 What this update did not verify

Actual serving deployment/version and current hosted schema; Twilio ownership, registration, number associations or delivery; current feature flags; local-only COMMS-01C/FIN/HIST worktree contents; a completed WAIT specification; the current whole-project P0/P1 census; commercial/legal acceptance and restore/offboarding exercises. Those remain explicit verification tasks when their release or commercial gate is reached, not inferred absences.

### F.6 · Selected-recipient contract and acceptance

### Historical v1.10 — 14.5.5 First WAIT-03 product slice — selected-recipient booking

| **REQUIREMENT VERSUS PROPOSAL  Chloe’s source request is selected people, a secure booking surface limited to a horizon or particular days, and decline-and-remain-waiting. The following delivery defaults are proposed for the contract, not claims of already accepted or implemented behavior. [S7]** |
| --- |

| **Element** | **Required behavior / proposed default** |
| --- | --- |
| Practitioner entry | Choose waitlist people → Invite to book. Keep one compact workflow, using existing Hone components. No new generic CRM, campaign builder or independent scheduler. |
| Booking scope | Persist explicit studio-local date bounds and allowed dates/days. “Next 14 days” is an issuance preset that becomes fixed dates; browsing later cannot move the horizon. Slots remain live within that scope. |
| Separate clocks | The response deadline controls whether an offer can still be accepted; permitted appointment dates control when the visit may occur. Expiry is not the booking horizon. |
| Appointment choice | Proposed default: one initial appointment for one existing eligible service. Confirm the service with Chloe; do not silently decide it must be a consultation or grant access to every service. |
| Manual intake limit | Proposed default: an explicit owner-selected limit and small recipient groups, not a mass first-come race. Count outstanding permissions and committed bookings consistently. This is a human cap, not an algorithmically proven “safe N”. |
| Opportunity, not reservation | Sending does not create an appointment, hold the whole calendar or promise a guaranteed time. Slot availability can change. Unrelated existing clients retain their normal booking rights. |
| Viewing and identity | GET/link preview/reload must not redeem, book, decline or remove. Use narrowly scoped recipient/session proof before consequential actions as the accepted contract requires. Do not promise a forwarded bearer link is non-forwardable. No clinical-record disclosure or typed-email identity shortcut. |
| Atomic booking | At the final authority, validate token/current invitation, exact scope, service, intake permission and the live slot, then commit booking and required invitation/waitlist evidence consistently. Reuse canonical scheduling/appointment laws and a consistent lock order. A lost slot does not consume the opportunity. |
| Client decline | “Not this round—keep me on the waitlist” is invitation-authorized, not an impersonated owner call. Preserve original waiting history, stop repeat offers of the same round, and distinguish decline, no response and explicit removal. An old link cannot affect a newer offer. |
| Rescheduling | The invitation-origin appointment cannot escape its permitted dates via the ordinary reschedule route unless Chloe explicitly approves. Keep cancellation available under applicable policy. Do not impose this restriction on unrelated appointments or existing clients. |
| Ongoing access | A first booking or newly created client record is not by itself ongoing eligibility. The feature must not let an “existing client” claim become a bypass into unrestricted new-client admission. |
| Email-first delivery | Use the existing email channel with explicit queued/accepted/delivered/failed/unknown semantics. A provider timeout or retry cannot create multiple valid invitations. Raw-token-once requires a deliberate recoverable-delivery or reissue/revocation design, not reconstruction from a hash. |
| Operator completion | See invited, booked, declined, expired, revoked and delivery-unconfirmed outcomes with a clear next action. New capability data stays part of the export/retention inventory; no raw token or personal/clinical payload in logs. |

Implementation truth: the deployed one-shot redeem command does not create an appointment and blocks ordinary requeue after redemption. Do not call it on page-open. A focused forward extension to the authority model is needed; “backend done, UI only” is not an adequate contract for this request. Applied 0188–0190 remain unchanged. [S9, S17]

### Historical v1.10 — 14.5.6 Scoped slice decomposition and acceptance

| **Child ID / parent** | **Bounded output** | **Release boundary** |
| --- | --- | --- |
| WAIT-03-SCOPE / WAIT-03 | Stored offer scope and the canonical booking boundary; exact service/date/permission checks. | Contract/authority map first; forward schema only when allocated. No browser-only enforcement. |
| WAIT-03-SELF / WAIT-03 | Prospect-authorized decline and safe return to waiting; old-link and concurrent-outcome protection. | No owner impersonation; book/decline/revoke/expiry races have one authoritative outcome. |
| WAIT-03-DELIVERY / WAIT-03 | Email invitation adapter, truthful delivery/reissue state and focused client page. | Real mailbox proof only after separate approval; independent of Twilio activation. |
| WAIT-03-ACCEPT / WAIT-03 | Owner selection, outcomes and real end-to-end acceptance. | Chloe can invite; one prospect books and one declines; no manual database repair. |
| WAIT-ENTRY-01 / WAIT-02/03 | Minimal practitioner-added prospect path when required; later broader legacy import. | No fabricated join dates, implied consent or duplicate active records. Pull into first release only if needed for intended recipients. |
| WAIT-PREF-01 / WAIT/ADMIT | Weekday/weekend preference capture and filtering, including optional decline feedback. | Supports Chloe’s choices; automatic prioritization and forecasts remain later contracts. |

These child IDs are introduced by this roadmap amendment for traceability; they do not assert corresponding pushed branches, migrations or completed implementation. Keep the existing parent WAIT-03 and ADMIT IDs. Merge/split delivery units only when atomicity and scope evidence justify it.

| **Failure case** | **Acceptance proof required** |
| --- | --- |
| Substituted date/service/tenant/client | Server/DB refusal; no cross-tenant read or write; no scope widening. |
| GET, preview scanner, refresh, back/forward | No lifecycle mutation, no token burn and no false decline. |
| Two tabs / retry after uncertain response | At most one booking; idempotent outcome recovery, not blind resubmit. |
| Concurrent final intake permission / final slot | One successful commit; losing caller receives truthful retry/remaining-state outcome. |
| Book versus decline/revoke/expiry | Consistent lock order and exactly one decision; post-lock time governs deadlines. |
| Slot disappears after selection | No appointment and no consumed invitation; another allowed slot may be chosen. |
| Old invitation after reissue | Old credential cannot book or decline the current offer. |
| Reschedule outside scope | Refused or explicit governed owner exception; ordinary cancellation remains available. |
| Delivery timeout / crash between token issue and send | No duplicate active invitation; durable unknown/retry/reissue state; booking success not undone by post-commit email failure. |
| No suitable time / not this round / no response | Clear client result and owner visibility; waiting history preserved; no fabricated queue-position guarantee. |
| Existing-client continuity / export | Unrelated booking/reschedule behavior preserved; new data has explicit portability/retention classification. |

The contract must also decide cancellation/quota replenishment, expiry after browsing, group changes while invitations are outstanding, service changes, recipient correction/reissue and any payment prerequisite. Until decided, use explicit HOLD rather than a permissive default. No separate global identity platform or scheduling engine is authorized by this slice.

Boundary after this release: finish only the operational additions required to run the accepted workflow, then proceed to FIN-02. ADMIT-01 forecasting, ADMIT-02 Safe to invite N, and ADMIT-03 automation retain their evidence prerequisites and are not a blanket FIN dependency.

### F.6 · Executive queue

### Historical v1.10 — 23. Current Executive Queue and Paired Delivery Cycles

| **ONE ROUTE FORWARD  Twilio → focused WAIT-03 → FIN-02. Development preparation may overlap; one authorized production-moving unit at a time. A confirmed live security/safety incident can interrupt under §17; ordinary feedback does not automatically become an emergency.** |
| --- |

### Historical v1.10 — 23.1 Delivery milestones and stop points

| **Order** | **Deliverable** | **Exit / boundary** |
| --- | --- | --- |
| NOW | Finish the initial studio-SMS rollout | Close exact-head findings and governance stop disposition; fresh 0192 preflight; protect Willow before cutover; finish required COMMS-01C; real sender, STOP and no-duplicate-purchase acceptance. No order that creates a provisioning/routing cycle. |
| PARALLEL | Prepare the email-first WAIT-03 contract | One isolated discovery lane. Resolve required scope and minimal authority changes; acceptance matrix and owner decisions. Assignment is not completed design or runtime authorization. |
| NEXT | Ship selected-recipient scoped booking | Complete a real invite → book OR decline/remain-waiting flow with trustworthy dates, service, authority, reschedule and delivery semantics. Manual/legacy entry only as needed for intended recipients. |
| BOUNDED FOLLOW-THROUGH | Make the accepted waitlist workflow operational | Necessary owner state/actions, expiry/reissue recovery and small preference/entry additions. No broad UI phase or full ADMIT engine before FIN. |
| THEN | FIN-02A → FIN-02B | Single shared snapshot + canonical pricing/time authority, then existing model/UI adoption, owner acceptance and production proof. |
| LATER / STANDING GATES | Remaining Trust, Treatment/Practice Memory, Closeout, Rebooking, ADMIT, SaaS and commercial proof | Preserve detailed programs and Gate A–E requirements. Advanced admission needs real recurring-demand inputs; enterprise and general AI do not jump ahead of ordinary-studio reliability. |

A provider-only external SMS dependency is not a permanent technical dependency for email invitations. Once the active schema/cutover risk is safely settled, Sam may explicitly allocate the production slot to a ready, independently proved email-first WAIT release rather than leave it idle. That exception changes scheduling, not security, review or migration requirements.

### Historical v1.10 — 23.2 Current window ownership — assignments, not proof of activity

| **Window** | **Assignment** | **Boundary** |
| --- | --- | --- |
| hone-ops01 | Exclusive #674 owner; SMS review closure and Willow cutover plan | No merge/apply/provider effect without separate GO. Save durable checkpoint before context reset. |
| hone-audit | #675 finished. New WAIT contract/acceptance assignment in a separate clean worktree | Do not become a second writer on #674; no runtime, migration numbering or real messages in this contract pass. |
| hone-storage | Preserve local COMMS-01C-A work; parked | Re-census before wake; no push, provider call or migration re-numbering from an old prompt. |
| hone-ui-next | Reserved COMMS-01C-B; parked | Do not build or replace the server layer owned by storage. |
| hone-fin01a | FIN work preserved / parked | No 0192/0193 patch/apply. Derive migration ownership only when FIN is authorized. |
| hone-truth | Completed read-only control-tower output / parked | Old /tmp artifact is contextual and vulnerable to loss, not live hosted authority. |
| hone-db-a | #673 foundation assignment complete / parked | No 0191 reapply, redundant production campaign or Twilio activation. |
| hone-hist | Preserved / parked | No runtime refresh or shared-resource campaign before accepted authority re-entry. |

### Historical v1.10 — 23.3 GO / HOLD / STOP

| **Gate** | **Meaning now** |
| --- | --- |
| GO — bounded preparation | Read-only evidence, the already assigned #674 correction/verification within its stop laws, and the isolated WAIT product contract. No production authority is implied. |
| HOLD — runtime/prod | Any #674 merge/cutover until Willow-safe prerequisites and exact-head gates are proven; any migration apply, real provider smoke/purchase or feature activation without specific authorization; WAIT runtime until contract acceptance; FIN while the focused WAIT train is unfinished. |
| STOP — hard boundary | Changed authorized head/base/schema; unexpected production data or provider ownership; uncertain billable effect; duplicate migration owner; shared DB contention; spoofed identity; inherited review treated as fresh; new same-family/convergence threshold without recorded re-entry; restoration of generic cross-studio sender fallback. |
| Not a hidden waiver | The source roadmap’s repair budget and authority re-entry requirements remain binding. Product urgency, high test counts, an old GO or documentation-only wording do not erase them. |

### Historical v1.10 — 23.4 Long-term destination after the current three milestones

Complete the guarded clinical-history/Before Today work only after accepted re-entry; make Visit Closeout and Rebooking the ordinary visit loop; expose truthful money and Practice Health; use observed capacity and preferences for assisted admission, then separately approved automatic release; prove safe import/export/offboarding and repeatable studio activation. Paid design-partner learning and support/restore evidence precede broad self-service. The exact ordering inside Later is evidence-driven, not a new fixed calendar promise. [S1]

END OF HISTORICAL ARCHIVE — return to v1.11 §§0, 3, 14.5 and 23 for current direction.

## F.7 v1.13 retired overlays and editorial correction record

HISTORICAL / REFERENCE ONLY. These blocks are copied from v1.12 to preserve decision and handoff provenance. They are not current instructions. Current product priority is §23.6; WAIT contract is §14.5.7; accountable roles are §23.2; the five headline measurements are §20. [S32, S33]

### F.7.1 Retired v1.11 decision overlay

### Historical v1.12 — 0.4 v1.11 decision and supersession register

| **Decision** | **Accepted direction / source** | **What it changes; what it does not** |
| --- | --- | --- |
| Priority / RDM-001 | Sam: make WAIT the urgent product priority; FIN preparation may continue separately. Latest instruction: execute Chloe’s requirements. [S19] | Supersedes the old Twilio → WAIT contract-only → FIN immediate queue. WAIT-03 convergence and WAIT-04 construction are Now. Dedicated-SMS cutover retains its own HOLD. |
| Practitioner workflow | Chloe rejected Claim. One primary action is Invite to book. [S19, S21, S24] | Internal claiming remains an implementation detail. #684 hides it in production source; the actual new invitation composer is still draft/unwired. |
| Client contacts / WAIT-04A | Require separate first and last names, email, mobile, canonical treatment-area multi-select and structured availability for new joins. [S19] | No urgency/comments box. Legacy incomplete records are preserved and completed without invented names, phones, consent or waiting dates. |
| Communication / WAIT-04C | Invitation by email plus SMS when valid consent/suppression and sender readiness permit; one 24-hour reminder. [S19] | Supersedes email-only launch scope, not the separation of invitation links and recipient proof. #680 alone is still an email delivery component. |
| Responses / WAIT-04B,D | Book; times do not work—keep place; update availability—keep place; leave waitlist. Fixed 48-hour response policy. [S19] | Replace generic Decline in client copy. No response is a distinct, auditable outcome, not a no-show. Delivery-evidence and clock details must be proved before automatic removal. |
| Consultations | No client-controlled first-consultation rescheduling. Cancel-and-return creates new waiting priority; practitioner-approved moves do not penalize. [S19] | Supersedes the earlier suggestion that an unrestricted successful client reschedule should retain access. Established-client treatment rules are not silently changed. |
| No-call/no-show | Permanent clinic-scoped self-service booking restriction after explicitly confirmed consultation no-call/no-show. Owner may manually book an exception without lifting the restriction. [S19] | Supersedes the earlier temporary-hold recommendation. Correction, audit and private accommodation review remain required; there is no automatic reinstatement or cross-clinic blacklist. |
| Forecasting | Estimate time to a consultation invitation, later; estimate recurring treatment demand only after assessment/credible history. [S19] | Instrumentation belongs in the new work now. No numeric wait estimate, probability band or safe-to-invite count is treated as implemented or validated. |
| Numbering | Source check confirms #674 has 0194, while WAIT #681/#685 carry 0192/0193. [S22–S27] | The stale #674 body is not a second actual 0192 file. WAIT-04 remains unnumbered until a fresh cross-worktree allocation; no 0195 assignment is made here. |
| Execution authorization | Sam approved starting the bounded new WAIT work. [S19] | Authorization and pane assignments are not evidence that a branch was created, tests ran or production changed. All existing review/apply/provider gates remain. |

### F.7.2 Retired v1.12 consolidation overlay

### Historical v1.12 — 0.7 v1.12 consolidation delta - Work Plan v3 absorbed

Source: Hone Work Plan v3 (7 September 2026), built from Chloe's recorded feedback session (7 September, 9:30 PM), Chloe's waitlist policy inputs (S19), the WAIT train state and the Visual Treatment Memory / vgpu review. Sam's instruction on 8 September: v3 is the most important immediate list of items to work now; consolidate it with this document. This edition absorbs v3 into RDM-001 without deleting or renumbering any existing ID. Where v3 and v1.11 disagreed on a fact, the v1.11 source check wins and the correction is recorded below. [S31]

| **Decision** | **Accepted direction / source** | **What it changes; what it does not** |
| --- | --- | --- |
| Immediate execution list | Sam: Work Plan v3 is the immediate list. Order: WAIT launch (WAIT-03 stack, WAIT-04A-D, one binding, proof, release) → MultiPlex (MPX-01 → MPX-02 → MPX-03, with MPX-04/05 as the memory payoff) → the 7 September Chloe batch (§14.6.1) → deferred items. [S31] | Supersedes the v1.11 THEN placement of FIN-02 as the next production mover. FIN-02A/B preparation continues in parallel per §0.4; its production slot follows MPX unless Sam reorders. WAIT Now/Next text, gates, HOLDs and production-concurrency-one are unchanged. Recorded in §23.1 and §23.6. |
| MultiPlex placement | Sam, 7 September: MultiPlex is Chloe's next highest priority after the waitlist. The build is small; the missing input was Chloe's full field set. MPX-01 discovery (Chloe field interview) freezes fields, types, units and ranges before MPX-02 authors any migration. [S31] | Confirms the MPX-01 named scope in §14.3. The TM-01 modality-extensibility dependency flagged in the v1.1 review must be confirmed closed or open before MPX-02. Migration number only by a fresh cross-worktree census; migration-first order applies. |
| Chloe 7 September evening batch | Recorded session: Dashboard pinned-note truncation; last-session note replaced by today's note after charting; checkout is about ten clicks with about a minute of client wait; actionable overdue-disinfection notification; per-user notification toggles; client status buckets; booking link exposes schedule density. [S31] | New rows DASH-NOTE-01/02, NOTIF-PREFS-01, CLIENT-STATUS-01, BOOK-PRIVACY-01 in §14.6.1. Checkout lands on existing FLOW-03; the disinfection action lands on existing RECORDS-01. Priority 3 in §23.6; no production slot before WAIT and MPX. |
| Waitlist interest level - OPEN | Chloe, 9:30 PM session: ask interest level at join (ready to start now / curious with questions / had electrolysis before), filterable so ready-now prospects are invited first. Not in the frozen §14.5.7 contract, which was fixed later the same evening. [S31] | Recorded as a bounded decision, not a contract reopening. Sam decides whether WAIT-04A adds it as one more required structured select under the same no-free-text rule, or drops it. Decide before 04A binds. No demographic field in either case. Row WAIT-INTAKE-01 in §14.6.1. |
| Deferred by Chloe | Bulk email/SMS by client bucket; more granular availability options (weeknights, lunch break, varies); wait-time estimator. [S31] | Not in the immediate list. BULK-MSG-01 (§14.6.1) depends on CLIENT-STATUS-01 and the COMMS lanes, consent-aware, email-first. The estimator stays WAIT-FORECAST-01 / LATER (§14.5.8). |
| Visual Treatment Memory | Review conclusion: the feature is the product idea; vgpu is one implementation technology. VISUAL-01 SVG treatment map (P2 experiment), VISUAL-02 vgpu / WebGPU photo compare (P2 R&D, isolated, progressive enhancement), VISUAL-03 later. No vgpu in package.json today. [S31] | New §14.9 with frozen constraints: WebGPU disposable from the user's perspective; no clinical truth from GPU output; the Sharp image boundary is permanent; no fake precision. Post-WAIT product experiment, not an active train. §21 records the dependency HOLD. |
| Business decisions | Decided by Chloe and already in §14.5.7: permanent no-show restriction with manual exception, no self-service consult reschedule, fixed 48-hour window, keep-place rules, priority by readiness not identity. Still open: paid consults ($35-45; effective date; grandfathering the roughly 30 already waiting) and a consult value-add item. [S31] | Open items are recorded in §17.7 and are not build items. If paid consults proceed, the product dependency is a consult as a paid booking type; nothing is scheduled for it here. |
| Numbering correction to v3 | v3 stated that #674 also claims 0192 and must move up. The §0.4 source check supersedes that: #674 carries 0194; only its PR body prose was stale. [S22-S27] | 0192 = #681, 0193 = #685, 0194 = #674 (held). WAIT-04 remains unnumbered until a fresh cross-worktree allocation. No 0195 is assigned here. |
| Priority wording in the vgpu review | That review recorded the order as WAIT → FIN in parallel → Laura → everything else. [S31] | Reconciled: WAIT first; MPX second per Sam; FIN as parallel preparation; Laura / self-service stays LATER in §23.1. No Laura-specific work is added by this edition. |

### F.7.3 Retired pane-location handoff

### Historical v1.12 — 23.2 Pane assignments — last authorized plan, not live process telemetry

| **Pane / nominal session** | **Role / handoff** | **Authority limit** |
| --- | --- | --- |
| Top-left / hone-truth | Master control; current source/migration census; freeze product decisions and record exact heads. | Read-only coordination. No silent renumber or migration apply. Save a durable checkpoint before clear. |
| Top-middle / hone-fin01a | Former FIN/integration-plan pane; newly assigned WAIT-04A join/profile experience. | New isolated draft; do not overwrite FIN work or treat the tab’s old #666 label as ownership. |
| Top-third / hone-storage | #685 admission authority owner; finish current bounded closure. | No simultaneous WAIT-04 writer in 0193; no shared DB reset or provider action. |
| Top-right / hone-ui-next | #680 email Delivery owner; WAIT-04C after stable acceptance. | One bounded repair/review cycle; no real send, sender purchase/configuration or duplicate review requests. |
| Bottom-left / hone-audit | #686 review capacity; authorship must be checked before calling it independent. | Read-only acceptance on pinned head. A prior author of the delta cannot supply independent certification. |
| Bottom-middle / hone-ops01 | #683 B4 owner; then WAIT-04D by explicit file assignment. | Do not edit recipient files concurrently with #686; resolve adapter ownership with integrator. |
| Bottom-third / hone-db-a | Newly assigned WAIT-04B unnumbered DB/policy prototype. | This replaces the older reserve-review assignment. Once authoring, this pane cannot independently accept that same authority. |
| Bottom-right / hone-hist | #686 builder or review-request coordinator; revalidate actual worktree/role. | Hold a pushed head stable while CI/review runs. Do not keep cancelling evidence with cosmetic pushes. |

Pane locations reflect the last authorized handoff only; no direct access to those terminal processes was used for this update. Builders retain sole ownership of their files, independent reviewers retain no-write authority, and the integration owner coordinates shared seams. Previously named FIN/HIST/COMMS work is preserved, not discarded by changing a pane’s assignment. [S19]

### F.7.4 Prior diagnostic catalogue — reference, not the five-measure scorecard

| **Scorecard** | **Measures** |
| --- | --- |
| Portfolio health | Open P0/P1; age of oldest P1; TRUST-001 completion; Product milestone completion; unplanned work %; migration queue; open non-draft PRs; PRs over scope budget. |
| Delivery health | Median PR cycle time; review rounds; scope variance; CI failure cause; escaped regressions; parked/abandoned work; delivery_result vs discovery_value. Add unresolved review-thread count, same-root-cause recurrence, architecture-stop rate, exact-head drift and false-green/false-red evidence caused by shared local test resources. Add exact-head review completion-source correctness (review/comment/reaction provenance) and false-clean watcher incidents. |
| Product health | Chloe acceptance rate; charting completion time; clicks treatment->closed visit; Treatment Memory usage; Closeout completion; rebooking completion; unresolved appointment work; support minutes/studio.; first-treatment lead time; new-client intake vs target; waitlist joins/age; outstanding invitations; safe-admission recommendation/override; active treatment clients with no future booking. Add selected-day prep parity acceptance, practitioner-reported slow-click frequency, measured authenticated route latency and pending/loading acknowledgement quality. Track selected-day Prep V2 acceptance separately from presentation, plus production PERF-00 sample size/confidence and Chloe-reported slow-click frequency. |
| Interrupt health | Interrupt capacity consumed; C1/C2/C3 counts; recurring issues; quick wins that should have been epic inputs; roadmap displacement. |
| Design partner health | Time to onboard; import recovery; support load; incidents; active usage; repeat visit memory; payment/rebooking; operator minutes.; waitlist/admission usage where enabled; unmet demand and capacity-expansion signal. |
| UI / interaction health | 44px touch-target coverage; mobile form controls >=16px where required; focus-visible and keyboard behavior; pressed/pending coverage; route loading-boundary coverage; shared primitive adoption; unnecessary Client Component boundaries; horizontal overflow; high-frequency click/transition cost; user acceptance on iPhone/iPad. |
| Scoped WAIT outcome health | Issued/queued/accepted/delivered/failed/suppressed by channel; profile completeness; response taxonomy; invitation-to-response/booking time; reminder/timeout accuracy; consult cancellation/re-entry; no-show restriction/correction/exception; operator minutes. Declare cohorts/windows and UNKNOWN. No count or model calibration claimed by this edit. |

### F.7.5 Superseded active wording and correction

| **Retired v1.12 wording / location** | **v1.13 disposition** |
| --- | --- |
| §14.5.9: Build against fake email/SMS transports and isolated fixtures first. Real handset/mailbox canaries require a separately approved recipient and provider action. Refresh all mutable facts at the release boundary; do not keep reopening unrelated code once the integrated contract is stable. After necessary WAIT operational completion, FIN-02 resumes the next major product delivery; forecasting and general automation are not prerequisites. [S18, S19] | Priority is §23.6; no immediate FIN default after WAIT. The original source and this excerpt preserve the prior wording. |
| §23 opening: Now: converge the existing WAIT-03 components and build the accepted WAIT-04 extensions in isolated draft lanes. Next: one final integration candidate and complete journey proof. Then: reviewed migration/deployment/enablement and Chloe acceptance; FIN-02 resumes the next major product release. Dedicated SMS cutover and every Trust/commercial gate remain explicit. [S19] | Opening now routes to the single product-priority list; MPX and the Chloe batch retain their accepted places. |
| §0.5 publication split: RDM-001 is the single logical roadmap, with this DOCX as the human-readable edition. The repository counterpart is docs/roadmap/CANONICAL_ROADMAP.md. This update did not modify it. Until a reviewed synchronization records the same version and decision delta, treat repository roadmap prose as the older policy edition where it conflicts with this explicit amendment. Do not create a competing roadmap or readiness engine. | Reviewed Markdown synchronization remains pending. The maintained repository working edition and derived brief/DOCX model is now explicit. No false sync claim. |
| Prior closing summary: Version 1.11 records the WAIT delivery work and Chloe’s accepted launch contract, separates merged surface changes from draft authority/transport/UI and authorized follow-on work, and preserves the North Star and longer-term portfolio. §§0, 3, 14.5 and 23 are the active decision, evidence, product and execution entry points. No unsupported percentage, forecast date or global clean-review claim is made. | v1.13 closing names the edited publication and actual source boundary; old version language is historical. |

No roadmap ID was deleted or renumbered. Source feedback remains evidence; full existing acceptance and trust gates are unchanged. The optional diagnostic catalogue above is retained for targeted investigation, not a requirement to populate every measure every week.

# Appendix G. Preserved repository program from roadmap v1.1

| PRESERVED RECORD — DO NOT EXECUTE  The repository roadmap stood at **v1.1** (18 July 2026 baseline, last modified 2 August 2026) while the published roadmap advanced to v1.15, so editions 1.2–1.14 never reached this file. Adopting the v1.15 publication structure therefore crosses two ID generations whose vocabularies overlap in only four tokens. Nothing in this appendix is a standing instruction. It exists so that no ID, evidence label or product decision the repository had recorded disappears in the synchronization. |
| --- |

<a id="hone_s_g_1"></a>
## G.1 Clinical finalization — RETIRED, carried forward intact

**Carried forward unchanged from repository roadmap v1.1 §SEC-09.** The v1.15
source is **silent** on clinical finalization: it neither restates the decision
nor supersedes it. Silence does not retire a retirement, so the record and its
full reasoning are preserved here verbatim and remain binding. The governing
decision record is **`docs/decisions/clinical-finalization-retired.md`**, and
migration `0159` enforces the decision in the database.

### SEC-09: Clinical finalization, amendments, and chart contract — **RETIRED (2026-07-29)**

**Status: RETIRED.** The ID is kept so nothing silently disappears from a canonical document, but
**no work maps to it and none may be opened against it.**

*Original instruction, superseded:* "Reconcile the already-deployed clinical finalization/correction work. Close any remaining gaps in immutable snapshots, amendment attribution, version conflicts, audit mandates, and customer-visible record provenance. Resolve the observation-chip/narrative contract across save, reload, history, print/export, copy-previous, finalization, and correction."

*Why retired:* signed and cryptographically finalized clinical records are **not a Hone product
capability**. Practitioner-signed snapshots, immutable finalized records, "snapshot v2",
cryptographic clinical-record hashes as a product feature, and any correction/amendment workflow
built around signed snapshots are permanently rejected. Treatment sessions remain **ordinary,
editable operational records**, and practitioners correct charting mistakes by editing them.
Migration **0159** enforces this in the database: both studio flags are pinned `false` by CHECK
constraint, `EXECUTE` on the finalize/correct/amend/snapshot RPCs is revoked from every runtime
role, transitions into `finalized`/`void` are refused, and `INSERT` is refused on all three
signed-record ledgers. Decision record:
**`docs/decisions/clinical-finalization-retired.md`**.

*What this does NOT retire.* Ordinary operational audit trails (`session_audit`,
`record_keeping_audit_events`, `session_copy_operations`, `admin_action_events`,
`client_portal_access_events`), actor attribution, timestamps, treatment-history integrity,
whole-session-copy provenance and tenant isolation are all **retained and must not be weakened**.
`clinical_audit_events` is **not** one of them — its CHECK admits only
`correction`/`amendment`, so it is part of the retired system despite its name. The
observation-chip / narrative chart-note contract (**P1-13**) was already closed on its own
evidence and is unaffected; it now covers save, reload, history, print/export and copy-previous
only, because there is no finalization or signed-correction state left to reconcile.

*Reintroduction is not a backlog item.* It would require a new explicit product decision, an
architecture review, a legal/privacy review, a migration plan and fresh acceptance — see §7 of the
decision record. Do not cite SEC-09 in any future PR.

<a id="hone_s_g_2"></a>
## G.2 Disposition of every roadmap v1.1 ID

All 89 identifiers the repository roadmap carried are listed below. None is
deleted and none is renumbered. Every row is a historical record: the v1.15
structure governs current direction, and no entry here grants present authority
or opens work.

| v1.1 ID | Title as recorded in v1.1 | Disposition under the v1.15 structure |
| --- | --- | --- |
| `SAFE-01` | Freeze Willow's behavioral contract | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§8.2, 15.2, 17 — default-OFF activation, Willow continuity, acceptance. |
| `SAFE-02` | Pin Willow's feature state | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§8.2, 15.2, 17 — default-OFF activation, Willow continuity, acceptance. |
| `SAFE-03` | Synthetic tenant fleet | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§8.2, 15.2, 17 — default-OFF activation, Willow continuity, acceptance. |
| `SAFE-04` | Release controls | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§8.2, 15.2, 17 — default-OFF activation, Willow continuity, acceptance. |
| `SAFE-05` | Shadow and canary behavior | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§8.2, 15.2, 17 — default-OFF activation, Willow continuity, acceptance. |
| `AUD-01` | Source establishment | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§3, 12 — recorded checkpoint and AUTO-BOOT-001 reconciliation. |
| `AUD-02` | Prior findings reconciliation | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§3, 12 — recorded checkpoint and AUTO-BOOT-001 reconciliation. |
| `AUD-03` | Feature and capability manifest | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§3, 12 — recorded checkpoint and AUTO-BOOT-001 reconciliation. |
| `AUD-04` | Full SaaS lifecycle walk | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§3, 12 — recorded checkpoint and AUTO-BOOT-001 reconciliation. |
| `AUD-05` | Studio A/B boundary matrix | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§3, 12 — recorded checkpoint and AUTO-BOOT-001 reconciliation. |
| `AUD-06` | Provider and operations audit | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§3, 12 — recorded checkpoint and AUTO-BOOT-001 reconciliation. |
| `SEC-01` | Public booking identity | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9, 13 — capability map and the TRUST-001 program. |
| `SEC-02` | Legal acceptance evidence | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9, 13 — capability map and the TRUST-001 program. |
| `SEC-03` | Intake token lifecycle | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9, 13 — capability map and the TRUST-001 program. |
| `SEC-04` | Intake concurrency and schema | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9, 13 — capability map and the TRUST-001 program. |
| `SEC-05` | Transactional booking and evidence | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9, 13 — capability map and the TRUST-001 program. |
| `SEC-06` | Cancellation and reschedule evidence | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9, 13 — capability map and the TRUST-001 program. |
| `SEC-07` | Payment-method and webhook integrity | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9, 13 — capability map and the TRUST-001 program. |
| `SEC-08` | Marketing consent dispatch | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9, 13 — capability map and the TRUST-001 program. |
| `SEC-09` | Clinical finalization, amendments, and chart contract — **RETIRED (2026-07-29)** | **RETIRED (2026-07-29)** — a terminal product decision, not a supersession. Preserved in full in §G.1. |
| `SEC-10` | Retention, legal hold, export, and purge | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9, 13 — capability map and the TRUST-001 program. |
| `SEC-11` | Admin and support security | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9, 13 — capability map and the TRUST-001 program. |
| `SEC-12` | Storage and photo lifecycle | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9, 13 — capability map and the TRUST-001 program. |
| `SEC-13` | MFA and high-risk reauthentication | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9, 13 — capability map and the TRUST-001 program. |
| `SEC-14` | Owner-facing audit log UI | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9, 13 — capability map and the TRUST-001 program. |
| `TEN-01` | Organization and default location | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `TEN-02` | Tenant ownership | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `TEN-03` | Roles and capabilities | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `TEN-04` | Ownership and membership lifecycle | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `TEN-05` | Tenant suspension and feature rollout | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `TEN-06` | Team calendar capacity | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `TEN-07` | Public practitioner assignment | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `SAA-01` | Public owner signup | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `SAA-02` | Plan catalog | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `SAA-03` | Stripe Checkout | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `SAA-04` | Canonical subscription reducer | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `SAA-05` | Atomic provisioning command | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `SAA-06` | Entitlements | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `SAA-07` | Dunning and access states | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `SAA-08` | Billing portal and invoices | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `ONB-01` | Onboarding state machine | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `ONB-02` | Launch health | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `ONB-03` | Client import | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `ONB-04` | In-product guidance | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `CAL-01` | c4b controlled update | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §9.3 and Appendix B.2 — preserved calendar contract. |
| `CAL-02` | c4c controlled delete | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §9.3 and Appendix B.2 — preserved calendar contract. |
| `CAL-03` | Recovery matrix | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §9.3 and Appendix B.2 — preserved calendar contract. |
| `CAL-04` | Self-service connection | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §9.3 and Appendix B.2 — preserved calendar contract. |
| `CAL-05` | Queue and quota operations | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §9.3 and Appendix B.2 — preserved calendar contract. |
| `CAL-06` | Controlled rollout | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §9.3 and Appendix B.2 — preserved calendar contract. |
| `COM-01` | Provider-independent communication domain | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§15, 15.1 — COMMS delivery map within SMS-01 / SMS-02. |
| `COM-02` | Transactional outbox | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§15, 15.1 — COMMS delivery map within SMS-01 / SMS-02. |
| `COM-03` | Tenant-fair worker | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§15, 15.1 — COMMS delivery map within SMS-01 / SMS-02. |
| `COM-04` | Twilio ISV architecture | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§15, 15.1 — COMMS delivery map within SMS-01 / SMS-02. |
| `COM-05` | Sender/compliance onboarding | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§15, 15.1 — COMMS delivery map within SMS-01 / SMS-02. |
| `COM-06` | Delivery callbacks and reconciliation | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§15, 15.1 — COMMS delivery map within SMS-01 / SMS-02. |
| `COM-07` | Indexed tenant-scoped inbound routing | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§15, 15.1 — COMMS delivery map within SMS-01 / SMS-02. |
| `COM-08` | STOP/START/HELP | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§15, 15.1 — COMMS delivery map within SMS-01 / SMS-02. |
| `COM-09` | Messaging health and cost | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§15, 15.1 — COMMS delivery map within SMS-01 / SMS-02. |
| `SUP-01` | Tenant-scoped support cases | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `SUP-02` | Safe diagnostics | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `SUP-03` | Time-bound human support access | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `SUP-04` | Documentation knowledge base | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `SUP-05` | Ask Hone bot | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `SUP-06` | Automatic escalation | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `SUP-07` | Bot evaluation | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §15 — SaaS platform and activation program. |
| `EDU-01` | Written guides | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§13, 18 — trust program and design-partner measurement. |
| `EDU-02` | Task videos | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§13, 18 — trust program and design-partner measurement. |
| `EDU-03` | Documentation lifecycle | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§13, 18 — trust program and design-partner measurement. |
| `EDU-04` | Marketing/content stream | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§13, 18 — trust program and design-partner measurement. |
| `EDU-05` | About Hone and company trust narrative | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§13, 18 — trust program and design-partner measurement. |
| `TRUST-01` | Public trust center | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §13 — TRUST-001 detailed PR program. |
| `GROW-01` | Provider-agnostic marketing integration domain | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §18 — growth and commercial proof metrics. |
| `GROW-02` | Finish Meta Pixel and Conversions API | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §18 — growth and commercial proof metrics. |
| `GROW-03` | Corporate marketing analytics | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §18 — growth and commercial proof metrics. |
| `DATA-01` | Canonical data inventory | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9.3, 10 — open capabilities and commercial launch gates. |
| `DATA-02` | Asynchronous export | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9.3, 10 — open capabilities and commercial launch gates. |
| `DATA-03` | Self-service cancellation | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9.3, 10 — open capabilities and commercial launch gates. |
| `DATA-04` | Offboarding orchestration | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9.3, 10 — open capabilities and commercial launch gates. |
| `DATA-05` | Accounting export | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9.3, 10 — open capabilities and commercial launch gates. |
| `OPS-01` | SLOs and synthetic journeys | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9.3, 16 — open capabilities and the control-plane workstream. |
| `OPS-02` | Sentry error tracking and safe tracing | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9.3, 16 — open capabilities and the control-plane workstream. |
| `OPS-03` | Abuse and cost controls | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9.3, 16 — open capabilities and the control-plane workstream. |
| `OPS-04` | Supabase PITR, backup, and disaster recovery | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9.3, 16 — open capabilities and the control-plane workstream. |
| `OPS-05` | Release attestation | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9.3, 16 — open capabilities and the control-plane workstream. |
| `OPS-06` | Better Stack uptime, cron monitoring, and public status | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9.3, 16 — open capabilities and the control-plane workstream. |
| `OPS-07` | PostHog product analytics | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9.3, 16 — open capabilities and the control-plane workstream. |
| `OPS-08` | Resend email reliability | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9.3, 16 — open capabilities and the control-plane workstream. |
| `OPS-09` | Operational dashboard and owner health | PRESERVED HISTORICAL. Superseded as a standing instruction by the v1.15 structure; current home: §§9.3, 16 — open capabilities and the control-plane workstream. |

**Why the whole list is kept.** The v1.1 program was organised as Phase 0–10 with
fourteen ID families; the v1.15 generation is organised around WAIT, MultiPlex,
the September 7 workflow batch and the supporting workstreams. Only four tokens
appear in both vocabularies, and they do not carry the same meaning across the
two generations. Dropping the v1.1 identifiers would have destroyed the audit
trail for every decision made against them between July and September 2026 —
including the one in §G.1, which is terminal and must remain findable by its
original identifier.
