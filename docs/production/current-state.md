# Hone — Current Production State

**Canonical snapshot of what Hone is today.** This document is deliberately concise. It is
not a PR diary — per-capability evidence lives in
[capability-register.md](./capability-register.md), migration facts in
[migration-ledger.md](./migration-ledger.md), residual gaps in
[known-limitations.md](./known-limitations.md), and dated chronology in
[../14_AI_HANDOFF.md](../14_AI_HANDOFF.md).

> **No capability is described as "live" merely because a table, migration, component,
> route or flag exists.** Read the status words precisely — *designed*, *implemented*,
> *merged*, *DB applied*, *deployed*, *enabled*, *production exercised*, *human accepted*,
> *dormant*, *held*, *deferred*, *retired* are distinct, and a capability normally holds several
> at once. **Retired is terminal** — not a later phase, not a gate someone can grant.

> **This document pins the last runtime-bearing baseline, not its own documentation commit.**
> Later documentation-only commits may move the branch HEAD **above** the SHA below without
> changing anything Hone *does*.

---

## Reconciliation header

| Field | Value |
|---|---|
| **Reconciliation date** | 2026-08-30 |
| **Production branch** | `claude/build-hone-saas-hOex7` |
| **Current Git branch HEAD** | `bf6f09c4a987e0e251f414bdf5dfc520c5d02d42` — the PR #660 merge (CI-HARDEN-01B: every action pinned to a vetted SHA, `contents: read`, checkout token no longer persisted). Query GitHub for the live value; documentation-only commits may have advanced it since. |
| **Last runtime-bearing application HEAD** | **`0f07dae68efe06d493421af715cb0b7234153de9` — the PR #659 merge, and DELIBERATELY NOT the branch head above.** Derived mechanically, not asserted: the **nine** merges from the previous baseline `4fee652f` through `#659` (`#651`, `#653`, `#652`, `#654`, `#655`, `#656`, `#657`, `#658`, `#659`) change **21** deployed files across `app/`, `components/` and `lib/` — classified by `scripts/classify-changes.mjs`, the same map CI uses. Every one of those nine is runtime-bearing. The **two** merges since (`#631` canonical docs reconciliation, `#660` CI-HARDEN-01B) change **13** files — documentation, CI workflows and tests — and **not one deployed file**, so the branch advanced while the runtime baseline did not. **This is the baseline for every behavioural claim in this document.** |
| **Current Vercel Production deployment** | ⚠️ **NO DEPLOYMENT ID READ.** The Vercel commit status for `0f07dae6` reports **success**, and that status is the whole of the evidence that a production deployment for this head succeeded — no deployment id, alias or runtime probe was read, and none is asserted. |
| **Migration state** | **This document deliberately states no migration number.** Hosted max is declared once, machine-readably, in [`migration-state.json`](./migration-state.json). Repository max, total applied and the next free number are **derived** — run `npm run migration:state`. The current reconciled position, with checksums and apply evidence, is [migration-ledger.md](./migration-ledger.md) under *Current state*. A number copied into this table is a number that goes stale on the next apply; that is how the `0160`/`0163`/`0165` divergence happened. |
| **Database vs. application skew** | **None** — repository and hosted migration state reconcile, with nothing pending and nothing remote-only. Verified by `npm run migration:state` at this reconciliation. The reconciling numbers are **not** restated here; see [migration-ledger.md](./migration-ledger.md). |
| **Production Supabase project** | The single production project. Always re-read the linked ref from `supabase/.temp/project-ref` (gitignored) and verify with `supabase migration list --linked` before trusting any number here. **No credentials are recorded in documentation.** (The project ref itself appears in at least one older repo document, so treat it as an operational identifier rather than a secret — but do not add new copies of it.) |
| **Health** | ⚠️ **NOT RE-PROBED AT THIS RECONCILIATION.** The last probe was **2026-08-23**: `hone.care` **200** · `/login` **200** · `/dashboard` **307** (auth redirect) · `/api/health` **307**, all non-5xx, `ops_alerts` unresolved **4** (§13). Those readings describe a runtime **twenty-seven merges old** and are retained as dated evidence, not as current health. |
| **Tenant posture** | **Six studios in three classes — one real-customer, one controlled test, one synthetic, three empty.** Real-customer activity is **Willow Electrolysis only**. See **§0**, which is the canonical tenant register; do not restate its counts elsewhere. ⚠️ **Every tenant count in §0 was measured 2026-08-23 and was NOT re-measured on 2026-08-26** — see *What this reconciliation did and did not measure* below. |
| **Next operational gate** | The **deep production / security / code audit** (still not performed against this baseline). **Chloe's human acceptance testing** remains outstanding and is **independent** — see §15. |

### Immediately preceding runtime baseline

`4fee652fe67f9fdc06b7d5e719cdb73d5e6d294b` — the PR #649 merge (UI-01D, Client Profile tab
acknowledgement), the baseline this document carried before the 2026-08-30 refresh. Its code
remains live because the nine merges above were built on top of it.

### What this reconciliation did and did not measure

**This reconciliation is a documentation lane.** It re-derived what can be derived from the
repository and the Git graph, and it re-measured **nothing** in the production database, at
Vercel, or at any provider. It has been refreshed to each production head in turn —
`8418a755` (#648), `5ad81129` (#646) and `4fee652f` (#650, #649) on 2026-08-27, then
`0f07dae6` (#651, #653, #652, #654, #655, #656, #657, #658, #659) on 2026-08-30 — **the
measurement boundary below is unchanged by any of those refreshes — production moving is not
a reason to restate a figure nobody re-read.** Read the two lists as a boundary, not as a
caveat:

**Re-derived on 2026-08-30, from the repository at `bf6f09c4`:**

- the production branch head and the full merge ancestry back to `b9e0003f` (twenty-nine merges);
- the nine merges since the previous baseline `4fee652f`, and that **all nine are
  runtime-bearing** (none is documentation-only), by changed-path analysis;
- which of those merges are runtime-bearing, by changed-path analysis;
- repository migration max, total, next free number and pending set (`npm run migration:state`);
- hosted migration max as **declared** in [`migration-state.json`](./migration-state.json);
- every capability status below that rests on merged source, migrations or tests.

**NOT measured on 2026-08-30, and therefore carried forward with their original 2026-08-23
stamps rather than restated as current:**

- every per-studio row count in §0, and every derived figure that depends on them;
- payment counts, stored payment methods and Connect account status (§7);
- portal, intake and consent counts (§6);
- `ops_alerts` rows and the admin audit event count (§13);
- treatment-image counts (§12);
- HTTP health, and whether Sentry or PostHog is receiving events;
- **any production performance figure.** The PERF-02C measurement recorded in §1 was taken
  on a local stack against a synthetic fixture. Nothing was measured in production, and no
  production latency claim is made anywhere in this document.

A figure with a 2026-08-23 stamp is **evidence of what was true on 2026-08-23**. It is not a
claim about today, and a later reader must re-measure before treating it as one.

### Open pull requests are not production

**No open PR is described as shipped anywhere in this document.** At this reconciliation:

| PR | State | Why it is not production |
|---|---|---|
| **TRUTH-01B-1** — the first export-payload slice | **IN DEVELOPMENT**, no PR merged (carried by draft #647) | The registry and the disclosure landed in TRUTH-01A; **the export payload is byte-for-byte unchanged**, so nothing here is live. See §12. |
| **#647** — TRUTH-01B-1, the joinable archive | **OPEN**, and a **DRAFT** | Parked. `#648` records it as untouched. Nothing here is live. |

> **No head SHA is recorded for an open PR, deliberately.** An open branch's head moves whenever
> it is pushed to, so a SHA written here is stale the moment it is useful — the same defect this
> reconciliation exists to close, reintroduced in a table about not reintroducing it. This was
> not hypothetical: a draft of this very section pinned `#646` at a head that had already been
> superseded before the section was finished. **The durable property is the relationship, not the
> identifier**: check it with
> `git merge-base --is-ancestor <pr-head> <production-head>`, which answers *is this shipped?*
> whatever the head happens to be today. CI state is likewise omitted — it is a property of a
> SHA, not of a PR, and it is not evidence of deployment in any case.

## 0. Tenant register — real, controlled-test, synthetic

**This section is the canonical classification of every production tenant.** Other documents
reference it; they do not restate it. Every count below is a point-in-time measurement, not a
standing property.

> **The production database contains a sanctioned synthetic tenant.** Its generated rows are
> **never** real-customer activity and must never be added into a customer total. A total that
> mixes them is false even when its arithmetic is right.

*(all counts as of 2026-08-23T23:24:44Z, read-only per-studio query)*

| Studio | Class | Clients | Appointments | Practitioners | Sessions |
|---|---|---|---|---|---|
| `willow-electrolysis` | **Real customer** — the live pilot studio | **72** | **215** | 2 | 99 |
| `my-studio-9d37c5` | **Controlled test** — validation only | 7 | 26 | 2 | 33 |
| `hone-synthetic-twin` | **Synthetic** — sanctioned production test tenant, generated privacy-safe data | 50 | 141 | 1 | 68 |
| `my-studio-6cdef7` | Empty | 0 | 0 | 1 | 0 |
| `samhone` | Empty | 0 | 0 | 1 | 0 |
| `samidc` | Empty | 0 | 0 | 0 | 0 |
| **All tenants** *(includes synthetic — not a customer figure)* | — | **129** | **382** | **7** | **200** |

**Reading rules, which the rest of this document obeys:**

- **Real-customer activity is `willow-electrolysis` only: 72 clients, 215 appointments.**
- **Non-synthetic is not the same as real-customer.** Subtracting the Twin leaves **79 clients
  and 241 appointments**, and that remainder still contains the controlled test studio. Never
  present it as customer activity.
- **All-tenant totals may be quoted only when labelled as including synthetic rows.**
- `hone-synthetic-twin` is long-established and already load-bearing in
  [migration-ledger.md](./migration-ledger.md), which verifies *"Synthetic Twin preserved
  exactly"* at each apply. This register makes that classification canonical for every document.
- `my-studio-9d37c5` is the controlled test studio. That is not inferred from its name: it is the
  only studio with `practitioner_capacity_enabled`, `onboarding_v2_enabled` **and**
  `google_calendar_connection_enabled` true, it holds the single Google Calendar connection, and
  it is named as the test studio in `docs/roadmap/P1_RECONCILIATION_REPORT_2026-07-18.md`.

---

## 1. Charting and treatment memory

**Deployed · enabled for all studios · human acceptance pending.**

Session blocks, observation chips, treatment areas, probe-lot suggestion, and the
*Before Today* / *Treatment Intelligence* surfaces are in continuous operator use.
*(as of 2026-08-23, read-only per-studio query)* **Real-customer charting — Willow:
96 `session_blocks`, 86 `electrolysis_entries`.** Controlled test studio: 12 and 6.
Synthetic Twin: 66 and 1 — **not customer activity**. All tenants: 174 and 93.

The **Phase A charting correction** (PR #479, merge `3cabdca`, **code-only — no migration**)
is deployed and reachable:

- **One unified `Treatment observations & skin response` box.** What were previously two
  separate concepts — *Treatment observations* and *Client / skin response* — are now a
  single multi-select. The canonical constants live in `lib/sessions/charting-labels.ts`.
- **Reaction-driven analytics consume the unified representation.** The dashboard
  *Clients needing attention* card and the treatment-intelligence surfaces read the unified
  chip set, not a separate response field.
- **Legacy `reaction_type` compatibility is preserved.** `session_blocks.reaction_type` is
  folded into the unified set on load and display, so historical rows still surface on
  every reaction-aware surface. Nothing was migrated or rewritten.
- **Galvanic intensity is retired** from current writes and ordinary display.
  `galvanic_intensity_percent` is no longer supplied by any form, is never emitted by the
  write path, and is ignored if a forged spec supplies it. **Historical values are
  preserved** — the column was not dropped and existing rows were not modified.
  *`galvanic_ma` and `galvanic_duration_seconds` remain active galvanic readings.*
- **Exact thermolysis precision.** A stored `0.733` displays as **`0.733 seconds`** — never
  a lossily rounded `0.73`. Trailing zeros are trimmed (`lib/sessions/format-seconds.ts`).
- **Pulse is labeled `Thermolysis pulse count`** and sits inside the thermolysis section,
  in both the block setup form and the simplified entry form.
- **Larger `Additional notes`** field.

**Chloe has not yet performed on-device acceptance of any of the above.**

Also deployed on this baseline: conditional numbing notes (0156, kept only when
`numbing_status='used'`), inventory-backed probe-lot linkage (0155), and the in-form
"Copy settings" prefill (PR #473).

### Clinical read truth — a failed read is never "no history" (CLIN-01-B)

**Implemented · merged (PR #642, `a3b85af2`) · deployed · enabled for all studios.**
**No migration.**

The client profile ran two `session_blocks` reads that consumed `data` and **dropped `error`**,
so a failed read became `null ?? []` — byte-identical to a client with no charted history. Four
surfaces then made affirmative clinical statements nobody had read: *Last visit* said
`No recorded visits yet.`, *Last treatment* said `No charted treatments yet.`, *Treatment
Intelligence* reported every stat as a known zero, and *Before today* reported no watch or plan
notes and a complete procedure record.

At `0f07dae6` all four check `unavailable` **before** `hasHistory`, and
`session_blocks.caution_for_next_session` / `caution_note` — which reach the practitioner only
through the Watch/Plan band built from that same read — are protected on both the Overview and
Sessions tabs. Read failure now renders *clinical history could not be loaded*.

**Deliberate non-change, recorded so it is not mistaken for a gap:** `attachStructuredAreas`
still **throws** on a `session_block_areas` read failure, surfacing the error boundary. That is
loud, not a false absence, and was left alone.

Since **PR #659 (PERF-02C, merged, `0f07dae6`)** those same reads run differently while saying
the same thing. The clinical-notes summary and the two `session_blocks` reads are mutually
independent, and on the Overview tab they ran as three consecutive awaits; they are now one
`Promise.all` wave, with `attachStructuredAreas` still serial after it because it genuinely
consumes both block reads. **This is a reordering, not a dedupe** — per-tab query counts were
measured identical before and after, not assumed. CLIN-01-B's containment is preserved by
construction: each unit resolves with its own outcome and never rejects, so one read failing
still cannot blank the other's card, and the two unavailability flags and two
`logClinicalReadFailure` event names are unchanged.

**The measurement, with the condition that makes it meaningful.** On a local stack against a
synthetic client carrying **40 sessions and 80 `session_blocks`**, the Overview navigation's
server-render window (`clients → client profile`, response-headers to first useful content)
measured **588 ms → 530 ms, −58 ms**, n=22 per arm, interleaved, reproduced in both A→B
pairings. The parallelism itself was proven at the database rather than inferred from the
clock: sampling `pg_stat_activity` found **zero** instants with the summary and intelligence
reads concurrently active before, and **thirty** after. On a client with **no** charted
history the same change measures ≈0, because both `session_blocks` reads are gated on a
session count and never execute — so the figure is meaningless without its fixture and must
never be quoted bare. **Nothing was measured in production**, and no production latency
improvement is claimed.

**The merged #659 PR body carries an EARLIER measurement, and it is superseded here.**
That body reports `606 ms → 519 ms`, `−88 ms`, `−14.4%`. Those figures are real but they
were taken against `c94258eb`, before the final runtime-head correction; `df9674bb` — the
head that actually merged — was committed afterwards and re-measured, because the fix
changed the runtime blob and a number taken on a superseded blob cannot describe the
shipped one. For shipped-head reporting the canonical figure is the fixture-bound
**588 → 530 ms** recorded above, and the PR-body figures are **not** competing current
evidence. The PR body is history and is deliberately not rewritten. **Neither measurement
was a production latency measurement**; both were local, on the same synthetic fixture,
and no percentage is stated for the final-head run because none was derived for it.

The paired asymmetry check (the Sessions tab, which runs only one of the three units and
should therefore not move) is **inconclusive** rather than passing: the measurement harness
returns to the Overview tab between samples, so that control's own warm-up runs the code path
under test. That is measurement debt in a test-only harness — it ships nothing and no user can
reach it — and it is recorded as such, not as a product regression.

#### The Dashboard half — F2, closed by PR #648

**Implemented · merged · deployed · enabled for all studios. No migration.**

CLIN-01-B closed the **client profile**. The Dashboard *Before today* pipeline had the same
defect on a different pipeline and was **not** covered by it: its four Supabase reads
destructured `data` alone — the token `error` did not appear in
`lib/dashboard/before-today-previews.ts` at all — so a failed read arrived `null`, became `[]`,
and was rendered as an **answer**.

It went unnoticed because the row did not go blank. `pickLastTreatment` accepts a session on its
**live entries** alone, and those ride on the *sessions* read; so when the `session_blocks` read
failed for a client with real charted history, `hasHistory` stayed **true** while every
block-derived field collapsed to empty, and the row kept its confident voice.

All four reads now pass through one wrapper retaining **both** failure channels — PostgREST's
`error`, and a rejected invocation, which never sets `error` at all. Outcomes classify into two
**independent** facts, and the independence is the design:

- the three **clinical** reads are one evidence set → `clinicalUnavailable`;
- the **clients** read carries no clinical evidence → `clientRecordUnavailable`, which suppresses
  only the missing-from-record reminders.

So a failed clinical read never hides true record reminders, and a failed client read never
blanks a history that *was* read. `compactBeforeToday` checks `unavailable` **before**
`hasHistory` — both arrive as `hasHistory: false`, and collapsing them is exactly what lost the
distinction. **Invariant: a failed read is not an empty history.**

**What #648 explicitly does NOT claim, recorded because the claim was withdrawn:**
`DASHBOARD_RETURNING_AS_NEW = NOT_PROVEN`. The recon did **not** prove this failure renders
returning clients as *"New client · No charted history yet"*; the appointment-prep path has
separate error binding. It is not asserted, not tested and not repeated here.

**Still open, and deliberately out of #648's scope — do not read F2's closure as covering them:**

| Item | State |
|---|---|
| **F3** — SQL/JS recency ordering and tie authority | **Separate, confirmed P2. Open.** `ORDER BY`, latest-selection authority, `starts_at`/`created_at` semantics, truncation and tie-breaking are untouched — verified byte-identical to production bar indentation. |
| **F4** — optional-evidence / absence authority | **Latent, deferred.** The architecture is unchanged. |
| **HIST-01A** | Untouched. The `COMPLETE / PARTIAL / EMPTY_PROVEN / UNAVAILABLE` model is deliberately **not** introduced. |

**No migration, schema, RPC, DB policy or provider change**, and no production data mutation —
four runtime files and five test files.

## 2. Whole-session copy

**DB applied · merged · deployed · enabled · PRODUCTION EXERCISED · human acceptance pending.**

Migration **0157** was applied to production **2026-07-27T02:01:29Z**, *before* PR #478
merged at 13:12:34Z — migration-first. The application (PR #478, merge `96b28d6`) is
deployed and there is no feature flag.

Behaviour:

- **Editable ephemeral preview.** "Copy areas & settings from last session" renders a
  preview the practitioner can edit and remove cards from. The preview is component memory
  only.
- **Zero writes before the explicit commit.** Opening, editing or abandoning the preview
  creates nothing.
- **One atomic commit.** A single CTA reaches the server, which validates canonically and
  calls `copy_session_setup` — one transaction creating the reviewed destination records.
- **Source locking and stale-source rejection.** The commit carries an expected source
  session id and fingerprint; a source that changed underneath is refused.
- **Idempotency and a provenance ledger.** `session_copy_operations` records each operation
  under a `(target_session_id, idempotency_key)` UNIQUE, so a retry or double-submit is an
  at-most-once no-op.
- **Reusable setup only.** **Minutes and outcomes are never copied.**
- **Galvanic intensity is forced to a literal `NULL`** at the destination, and is excluded
  from the source fingerprint — so a forged spec cannot reintroduce it.

**Production exercise: yes** *(measured 2026-08-23; not re-measured since)*. `session_copy_operations` held **24 rows, all 24 on
`willow-electrolysis`**, from **2026-07-28T20:39:54Z** through **2026-08-23T19:40:49Z**
*(as of 2026-08-23, read-only query)*. The commit path and the provenance ledger have executed
repeatedly against real production data at Willow.

**What those 24 rows do NOT evidence.** They are **all accept-path commits**. The idempotency
guarantee is **enforced by the reviewed database contract** — the `(target_session_id,
idempotency_key)` UNIQUE in migration 0157 — but **no production duplicate-retry event has been
isolated**, and neither has a **stale-source rejection**. The guarantee is not weakened by this;
it is simply not *separately production-exercised*, and this document does not claim it is. Same
boundary as [known-limitations.md](./known-limitations.md) L2 and
[capability-register.md](./capability-register.md) §2.

<!-- canonical-facts:ignore-start reason=quotes-the-superseded-zero-row-claim -->
> **Corrected 2026-08-23.** This section previously read *"Production exercise: none —
> `session_copy_operations` holds 0 rows"*, and instructed readers not to call the feature
> production-exercised. That was written at the 2026-07-27 reconciliation and was true then.
> It stopped being true on 2026-07-28 and stayed in the document for roughly four weeks while
> 24 real operations accumulated. The original deployment verification did deliberately perform
> zero copy operations; that fact is preserved, and it is now history rather than current state.
<!-- canonical-facts:ignore-end -->

**This is exercise, not acceptance.** Chloe has not confirmed that she has used the feature and
accepts its behaviour, and 24 operations do not establish that she has. Human acceptance remains
**pending** — see §15 and [known-limitations.md](./known-limitations.md) L1.

## 3. Clinical finalization, corrections and amendments — RETIRED

**RETIRED by product decision (2026-07-29) and enforced in production by migration 0159, applied
and verified 2026-07-30.** Signed and
cryptographically finalized clinical records are **not a Hone product capability**. Treatment
sessions are ordinary, editable operational records, and practitioners correct charting mistakes
by editing them through the normal charting commands. Full reasoning, the retained legacy
artifact and the reintroduction bar:
**[../decisions/clinical-finalization-retired.md](../decisions/clinical-finalization-retired.md)**.

| | State |
|---|---|
| Phase 1 — finalization boundary (0119) | **RETIRED.** `clinical_finalization_enabled` is **false on every studio** (verified across all six, 2026-08-23) and is pinned false by CHECK constraint `studios_clinical_finalization_retired` — no role can turn it on. `EXECUTE` on `finalize_session` is revoked from every runtime role, and `sessions_guard_retired_finalization` refuses any transition into `finalized`/`void`. Historically production-exercised **exactly once**, on the controlled non-Willow test studio (1 finalized session + 1 snapshot, hash still re-deriving, retained unchanged). **Willow: 0 non-draft sessions, ever.** |
| Phase 2 — corrections & amendments backend (0120) | **RETIRED.** `clinical_corrections_enabled` is **false on all studios** and pinned false by `studios_clinical_corrections_retired`. **Never production-exercised** — 0 amendments, 0 clinical audit events, and `INSERT` is now refused on all three signed-record ledgers, so none can ever be produced. The generic 3-field correction UX was never approved, and no full-chart correction workspace will be built. |
| Reliability/observability (PR #402) | **RETIRED with Phase 2.** The amendment path it instrumented is unreachable. |
| Practitioner-facing Finalize / signed-record Correction controls | **REMOVED — both from the database and from the deployed source.** Migration 0159 pinned both flags `false` by validated CHECK constraint and revoked `EXECUTE` from every runtime role; PR #482 then deleted `FinalizeSessionCard`, `RecordVersionsPanel`, `finalize-actions.ts` and `correction-actions.ts`, and deployed successfully on 2026-07-30 (merge `d77d44346addd98f4829f757531011bc7ca0c0d1`). There is no Finalize or signed-Correction surface in the running application, and no runtime role can invoke the RPCs. |
| Append-only clinical notes (0126/0127) | **Live for all studios, no flag** — **Willow 52, Synthetic Twin 3, 55 all-tenant** *(last measured 2026-08-23; not re-measured at this reconciliation)*. **Unrelated to the above and NOT retired** — a correction here is a new row (`supersedes_note_id`), never a signed snapshot. |

**Migration 0159 drops nothing.** The 0119/0120 objects stay in place so those migrations remain
replayable, and the guards that protect the one legacy artifact are deliberately kept on. The
deployed backend — immutable snapshots, version lineage, `clinical_audit_events` and append-only
RLS — **is preserved and must not be weakened**, but
**not** so finalization can be enabled later: it is preserved because it keeps the legacy
evidence immutable, keeps the retirement fail-closed, and forbids `authenticated` `TRUNCATE` and
any write to the three signed-record ledgers. **One 0120 mechanism was deliberately NOT preserved:**
the `hone.correction_session_id` GUC permit is **removed** — `set_config` on a custom placeholder is
available to any role, so once the correction RPCs were `EXECUTE`-revoked the permit stopped being a
guarded escape and became an open one (reproduced as plain `authenticated`). Verified gone in
production: the guard body no longer references it, or `current_setting` at all. It does NOT stop
ordinary direct DML.

> ⚠️ **CORRECTED 2026-08-26.** This passage previously continued: *"`authenticated` still holds
> row INSERT/UPDATE/DELETE on `sessions`, `session_blocks`, `electrolysis_entries`,
> `laser_entries` and `treatment_images`, restricted only by RLS to same-studio rows — see
> known-limitations L18."* **That was true when written and is false at `6786b07b`.** Migration
> **0169** (applied 2026-08-03) revokes `insert, update, delete` from `authenticated` on all six
> of those tables by name; `authenticated` retains **SELECT only**, and every writer goes through
> one of the sixteen reviewed commands. **L18 is CLOSED**, so the sentence and the reference it
> cited contradicted each other on a security boundary — a reader auditing the write surface got
> opposite answers from two canonical documents. The correct statement is that the removed GUC
> permit was never what stopped direct DML; **0169** is. Ordinary operational audit trails
(`session_audit`, `record_keeping_audit_events`, `session_copy_operations`,
`admin_action_events`, `client_portal_access_events`), actor attribution, timestamps,
treatment-history integrity, whole-session-copy provenance and tenant isolation are all
**retained**. `clinical_audit_events` is **not** one of those — despite its name it records only
signed-record corrections/amendments and is retired with the rest.

Reintroducing finalization is **not a backlog item**. It would require a new explicit product
decision, an architecture review, a legal/privacy review, a migration plan and fresh acceptance.

## 3b. Clinical record lineage — ENFORCED IN PRODUCTION (migration 0160)

**The same-studio wrong-client / wrong-encounter re-parenting defect is closed: database-enforced,
deployed and production-verified.** Migration `0160_immutable_clinical_lineage.sql` was applied on
**2026-07-30T17:52:48Z–17:52:51Z**, SHA-256
`e56a1ee7efc95e561cd17a0c33750ee4aaaf2a956f425576af39ce4a0e6094d4`. It ran inside an **explicit
`BEGIN` / `SET LOCAL lock_timeout` / `COMMIT` transaction** and completed **without** the `SET LOCAL`
warning (SQLSTATE 25P01) that migration 0159's apply produced, and without any lock timeout (55P03).

**The defect it closed.** RLS correctly refuses a cross-*studio* move, but *within* a studio the member
policies are `using (is_studio_member(studio_id)) with check (is_studio_member(studio_id))`, and that
predicate still holds after a parent changes — so a raw PostgREST `PATCH` could move a whole treatment
session onto another client's chart, or move a settings block (and its structured areas) onto another
client's encounter.

**Protected identity fields** — pinned immutable on `UPDATE`, verified live in production:

| Column | Rule |
|---|---|
| `sessions.client_id` | immutable once the row exists |
| `sessions.studio_id` | immutable once the row exists |
| `session_blocks.session_id` | immutable once the row exists |
| `session_blocks.studio_id` | immutable once the row exists |
| `electrolysis_entries.session_id` | immutable once the row exists |
| `electrolysis_entries.block_id` | **clearable only to `NULL`** (the `ON DELETE SET NULL` cascade); never re-pointed at another block |
| `laser_entries.session_id` | immutable once the row exists |

Two `SECURITY INVOKER` trigger functions with `search_path` pinned empty
(`guard_immutable_clinical_lineage`, `guard_clearable_clinical_lineage`), driven by trigger-defined
`TG_ARGV` — never by browser input — plus five `BEFORE UPDATE OF …` row triggers, all enabled, each
present exactly once. `treatment_images` is deliberately **not** re-guarded: migration 0093's
`treatment_images_enforce_integrity` already enforces the stronger identity contract and remains enabled.

**Ordinary charting remains fully editable.** Notes, structured settings, areas and laterality, machine
values, probe information, numbing, observations, timings, pricing, aftercare, sort order and
soft-delete are all untouched — 0160 pins **no** clinical-content column. The correct remedy for a
mis-filed session is still soft-delete plus re-chart on the right client, which leaves an
actor-attributed audit trail instead of silently rewriting history.

**No signed-record capability returned.** 0160 adds no snapshot, no finalization, no signed correction
and no `record_status` logic — see §3.

**What 0160 changed, and did not.** It changed **no business data** (all row counts and lineage
checksums identical across the apply window, nothing created), **no RLS policy**, **no table grant**,
**no application configuration** and **no provider state**. Its two trigger functions carry the default
`PUBLIC` EXECUTE that every other guard trigger function in this schema carries; that is inert, because
PostgreSQL refuses direct invocation (`0A000: trigger functions can only be called as triggers`).

> **0160 does not close all clinical write risks.** It closes *re-parenting*, and nothing more.
> The residual clinical-write limitations are **L18**, **L19**, **L20** and **L21**, and
> **[known-limitations.md](./known-limitations.md) is canonical for whether each is open or
> closed** — this paragraph names them, it does not adjudicate them. As of 2026-08-23: **L18 is
> CLOSED** (migration `0169`, 2026-08-03, `authenticated` clinical write grants 12 → 0); **L19**,
> **L20** and **L21** remain **OPEN**. `sessions.treatment_plan_id` and `sessions.appointment_id`
> remain same-studio but **not** same-client validated.
>
> *This paragraph previously ended "All remain open", which stayed false for three weeks after
> `0169` closed L18. Restating another document's status is what made that possible, so the
> status now lives in one place and this one points at it.*

## 4. Probe inventory and record keeping

**Deployed · enabled · in use.** Sterile items, disinfectants and exposure incidents with
audit — **Willow: 8 `record_keeping_sterile_items` rows** *(as of 2026-08-23)*; Synthetic Twin
holds a further 5, which are not customer activity. Exposure-incident history is **owner-only**.
Overdue-disinfectant "Replace now" alerts are computed at read time and auto-resolve.

Migration 0155 adds a durable, probe-specific, same-studio link from a charted block to a
sterile-inventory item (pointer-only, `ON DELETE SET NULL`, frozen snapshot). No production
block carries a link yet. The legacy `probe_lots` table stays **dormant**.

## 5. Booking and calendar

**Deployed · enabled · in continuous use** — **215 appointments at Willow**, the live studio
*(as of 2026-08-23; see §0 for the full tenant register — the all-tenant figure includes
synthetic rows and is not a customer number)*.

Public booking (service selection, availability scan, intake gating, hashed-token
manage/cancel/reschedule), the practitioner calendar (mobile single-day timeline; desktop
week/month with preview drawer), atomic same-record **Move appointment** (0133), and
backward-packed slot anchoring with source-aware conflicts.

**Migration 0152** makes actual treatment overlap a **HARD** database constraint while the
configured buffer becomes a **SOFT** constraint an authenticated internal owner may
override. An owner override bypasses the buffer only — never a real overlap.

**The direct new-client consultation booking route is `Deferred by product decision`
(2026-07-27).** It is not built, not a launch blocker, and not the next engineering task.

**That deferral is not the whole picture for new-client intake — see §5b.** New-client booking at
Willow is currently **refused and routed to a waitlist**, which is a different capability from a
direct booking route and is live today.

## 5b. New-client waitlist (admission control)

Two different things share this name. They are at **different stages** and must not be merged
into one status sentence.

### WAIT-01 — the email-delivered waitlist. LIVE at Willow.

**Implemented · merged (PR #601) · deployed · ENABLED for one studio · production exercised.**

New-client booking at Willow is **refused and routed to a waitlist**. This is admission control:
a studio whose existing treatment clients cannot be served on a clinically useful cadence stops
accepting brand-new consultations, because each new client consumes capacity already spoken for.

- Gated by the server-only env var `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`, **present on the Vercel
  Production target and no other** *(verified 2026-08-23 by reading variable **names** only — no
  value was read, and none is recorded here)*.
- `GET /book/willow-electrolysis` returns **200** and renders `newClientWaitlistEnabled: true`
  *(verified 2026-08-23)*.
- **The commit point is the studio notification email, not a database row.** Under WAIT-01 a
  waitlist request is delivered; it is not stored.
- Default OFF, exact-slug match only. Clearing the env var is the entire kill switch.
- Release record: [releases/2026-08-19-willow-new-client-waitlist.md](./releases/2026-08-19-willow-new-client-waitlist.md).

### WAIT-02B Stage A — the durable waitlist. DEPLOYED DARK. Reachable by nobody.

**Implemented · merged (PR #629, `48f02389`) · DB applied (migration 0185) · deployed ·
NOT ENABLED · NOT production exercised.** Human acceptance is **not applicable** at this stage.

- The durable table `new_client_waitlist_entries` and both commands
  (`join_new_client_waitlist`, `remove_new_client_waitlist_entry`) **exist in production
  schema**. Migration 0185 is applied and frozen — evidence in
  [migration-ledger.md](./migration-ledger.md).
- **The table held 0 rows when last measured.** It held 0 at apply verification and **0 on
  2026-08-23** *(read-only query)*, and **has not been re-measured since**. ⚠️ That is evidence
  for 2026-08-23 and **not** a claim about today: it does not prove the table is empty now, nor
  that no prospect entry has been created since.
<!-- canonical-facts:ignore-start reason=quotes-the-superseded-present-tense-waitlist-row -->
  This row used to read *"holds **0 now** … **No prospect data is being collected**"*, which
  converted a dated measurement into a standing fact.
<!-- canonical-facts:ignore-end -->
  The second half compounded it, because the allowlist absence that would license that inference
  is **also** only verified to 2026-08-23. A table existing is not data being collected; a dated
  zero is not a present-tense one.
- **`NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` is absent from the Vercel Production
  environment** *(verified 2026-08-23, variable names only)*. **No studio is enabled. Willow is
  not enabled.** Willow's public booking page continues to serve the WAIT-01 behaviour above.
- **The application code shipped FIRST and DARK** — the reverse of the migration-first ordering
  used for 0183/0184. That was deliberate: WAIT-01 is already live, so shipping the durable path
  on the existing flag would have moved a live studio's commit point with no operator GO in
  between, and clearing the gate list to keep it dark would have reopened new-client booking —
  the exact failure the gate exists to prevent.
- **The public privacy policy is unchanged.**

### WAIT-02B Stage B1 — disclosure shipped, activation still ungranted. SHIPPED · NOT ACTIVATED.

**Implemented · merged (PR #637, `1013a97b`) · deployed · NO STUDIO ENABLED · NOT production
exercised.** **No migration.** Merging it enabled nothing, for anybody.

Stage B1 changed **two** things, and the difference between them matters:

1. **The public privacy notice now covers waitlist prospects.** `app/privacy/page.tsx` names
   **Prospective clients** as a covered category, describes what the waitlist form collects,
   states the purpose, says the request goes to one studio and no other, gives an account-free
   removal route, and describes waitlist retention. Policy `effectiveDate` **May 22, 2026**,
   `lastUpdated` **August 24, 2026** *(read from the deployed source at `6786b07b`)*. This is
   the defect Stage A's blanket prohibition existed to hold shut, and it is now closed.
2. **The Stage-A build prohibition is GONE, replaced by a Stage-B configuration report.**

> ⚠️ **CORRECTION — this section previously said the opposite, and it was carried forward
> unverified.** It stated that *"a Vercel production build fails while
> `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` enables one or more studios"* and that the gate has
> *"no bypass and no per-studio exception."* **Neither is true at `6786b07b`.** Gate 4 of
> `scripts/check-production-env-gates.mjs` is now **report-only** and its pinned contract says so
> in its own first two sentences: *"Gate 4 is report-only. It does not fail the build solely
> because of `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS`."* A reader relying on the old sentence
> would believe a build-time stop still guards prospect collection. It does not.

**What guards activation now is runtime membership, and it takes TWO allowlists, not one.**
Gate 4's contract, sentence 9: *"Naming a studio in `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS`
activates nothing unless that studio is also named in `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`."* The
durable variable selects the **commit point** for a studio that is *already* on the admission
waitlist; it cannot by itself put a studio onto one. An empty durable allowlist leaves every
studio on the non-durable (WAIT-01, email) path.

**Current posture: NOT ACTIVATED.** `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` was **absent from
the Vercel Production environment** when last read *(2026-08-23, variable names only)* and was
**not re-read on 2026-08-26** — so absence is carried forward as dated evidence, not re-asserted.
**Willow is not enabled on the durable path** and continues to serve WAIT-01.

**Stage B2 — activation — has not been granted and remains blocked.** It requires an explicit
per-studio operator GO and human activation smoke. Tracked as **L25** in
[known-limitations.md](./known-limitations.md).

> **Never describe the durable waitlist as "live".** It is *deployed*, *disclosed*, and
> *dormant*. The capability live for new clients today is WAIT-01, and its commit point is an
> email.

## 6. Client portal and intake

**Deployed · enabled · in use.** Magic-link portal login with an append-only access-event log,
portal messages and replies, intake forms with reminders and terminal-state immutability, and
versioned consent with e-signatures.

**Willow, the real-customer studio** *(as of 2026-08-23, read-only per-studio query)*: **32
portal sessions · 2 portal messages · 72 intake forms · 49 consent signatures.** Controlled test
studio: 6 · 9 · 6 · 3. Synthetic Twin: 0 · 0 · 50 · 0 — **not customer activity**.

**Launch readiness now requires a live treatment consent** (PR #643, `9eb3c317`, deployed,
**no migration**). A new studio starts with **zero** consent templates and nothing seeded one,
so the launch checklist could read *Done* on every row while the intake presented no consent at
all. `lib/consent/launch-readiness.ts` now requires at least one form with server-resolved
`studio_id`, `form_type = 'treatment_consent'`, `status = 'active'` **and** `is_live = true`.
Draft, archived, and active-but-not-live forms do not satisfy readiness. "Ready" therefore means
something operational: **the intake will actually present a treatment consent.**

⚠️ Consent template wording is **draft**. Lawyer review is required before relying on
enforceability. Hone's documentation does not claim signatures are legally binding.

## 7. Payments and Stripe

**Live-capable and genuinely production-exercised for two approved studios — but not broadly ready.**

- **Willow Electrolysis is live and charging.** **30 succeeded live-mode charges of 34
  attempts**, most recent **2026-08-20T22:48:49Z** *(as of 2026-08-23, read-only query)*. Her
  live Connect account has `charges_enabled` and `payouts_enabled` true. This is the strongest
  production-exercise evidence in the system. **The 4 non-succeeded attempts are the source of
  the 4 unresolved `ops_alerts` recorded in §13** — the two facts are one event, not two.
- The controlled test studio also holds a live account with 2 succeeded live charges.
- **The Synthetic Twin holds no payment rows at all** — zero charge attempts, zero stored cards.
  No payment figure in this document includes synthetic activity.
- **Card-on-file** (SetupIntent) with live/test isolation is in use — **Willow: 18 stored
  payment methods and 18 Stripe customers**; controlled test studio 2 and 3.
  `require_card_on_file` is **false on every one of the four `studio_payment_settings` rows**
  (two studios × live/test), and both studios read `stripe_account_status = 'enabled'`
  *(as of 2026-08-23, read-only query)*.
- **Receipts** are live. **Refunds** are deployed but have **zero production rows on this
  baseline**. **Disputes** are **alert-only** — 0 have occurred.
- **Live manual no-show / late-cancellation fees are HELD** by a server-side allow-list;
  only `session_payment` charges live. Willow's 3 test-mode charge attempts all succeeded;
  the **per-reason** split of those test-mode charges was **not re-measured** at this
  reconciliation and is not restated — see [known-limitations.md](./known-limitations.md).
- **Non-card settlement is recorded, not faked** (PR #636, `f9ad0f72`, migration **0187**,
  applied 2026-08-24). A completed appointment previously had exactly one way to stop showing
  *Checkout* — run a card charge — so a cash, e-transfer, waived or still-owing visit invited a
  **fabricated Stripe charge on a real client's card record**. `public.appointment_settlements`
  records the disposition instead. **The structural guarantee is the absence of a value:**
  `method` has **no `card`** and **no `hone`** member, so an attestation that a card was charged
  is *unrepresentable*, not merely discouraged. Stripe truth stays in `payment_charge_attempts`
  and nowhere else, so the two can never be summed into one another.
- **`unknown` is an absence, never a value.** 0187 wrote **zero rows** and backfilled nothing;
  every historical appointment keeps no disposition, which is the truthful answer. The table was
  created empty and held **0 rows** at post-apply verification *(2026-08-24; not re-measured at any
  later reconciliation)*. **no settlement had been recorded in production when last measured**, so this capability is
  **deployed and enabled but not production-exercised.**
- **Public-booking card collection is OFF and unwired.**
- **Deposits, packages and partial payments are not built.**
- **Broad self-serve live payments are not ready** — a new studio starts in test mode and is
  enabled only after supervised onboarding and approval.
- **No automatic, background, batch or public-triggered charge path exists.** Charging is one
  manual practitioner click.

## 8. Communications

Transactional email via Resend (confirmation, reminder, postcare, portal) is live and
fail-soft. **Postcare auto-send is deployed but defaults to `manual`** — opt-in per studio,
skipped if the Resend key or postcare text is missing.

✅⚠️ **Appointment reminders: production operation PROVEN 2026-08-12; scheduler OWNERSHIP still unverified.** The
schedule is owned by an **external scheduler outside this repository** — `vercel.json`
deliberately does not register it, so neither CI nor a successful deploy says anything
about whether reminders are firing. That gap was closed by direct observation rather than
inference: at production SHA `773dbc7008b5`, read-only Vercel request logs show
`GET /api/cron/appointment-reminders` on `hone.care` at **23:00:19Z / 23:15:10Z /
23:30:14Z** (2026-08-12), all **HTTP 200**, ~15 minutes apart, with an unauthenticated
probe returning `401`. **No authenticated invocation was made and no reminder was sent.**

What remains unverified is **human**, not runtime: the cron-job.org account owner, a backup
owner, a single-enabled-job dashboard confirmation, the named alert recipient, and one
observation of the `/admin` **Reminder scheduler** card reading Healthy (an HTTP 200 proves
the run, not that the fail-open Upstash heartbeat persisted). Until those are recorded,
describe reminder delivery as **running in production, ownership unattested** — see the
ownership register in
[docs/08_EMAIL_SMS_AND_CRON.md](../08_EMAIL_SMS_AND_CRON.md).

**Intake reminders moved to a 24h / 2h cadence** (PR #632, `5bbd37a5`, migration **0186**,
applied and verified 2026-08-24). 0186 adds exactly one column — `studios.send_intake_reminders`,
boolean NOT NULL DEFAULT TRUE — plus a comment; no function, index, policy, constraint or
trigger, and no DML anywhere in the file. **The 0098 7d/3d state is preserved, not
reinterpreted**: `intake_reminder_7d_*` / `intake_reminder_3d_*`, their partial indexes and both
`claim_email_send` / `record_email_result` branches remain intact and are **historical**. The
application simply stops writing them.

**SMS is pilot scale only**, env-gated on `TWILIO_*` with a per-studio toggle and per-client
consent, STOP/HELP handled. Broad-SaaS SMS (A2P/10DLC registration, sender strategy, rate
limiting) is **not built**.

Marketing conversion tracking is deployed but **inert per studio** — no studio has configured
a provider token, and configuring one is an enablement step, not a default.

## 9. Google Calendar

**DB applied · deployed · production-exercised exactly once · currently DORMANT.**

- **Willow Electrolysis is not connected to Google Calendar** and has never had an event
  synced.
- One connection exists, on the **controlled test studio only** (connected 2026-07-12,
  `destination_mode='dedicated_app_created'`). Granted scopes are least-privilege:
  `calendar.app.created` — **no** `events.owned`, **no** broad `calendar.events`.
- **Exactly one real outbound Google event has ever been created**, on 2026-07-18, on that
  test studio: one `calendar_sync_outbox` row (`op_type='event.create'`, `status='done'`,
  1 attempt) and one `calendar_event_links` row (`sync_status='synced'`,
  `last_sync_direction='hone_to_google'`).
  *This corrects earlier documentation that described both tables as empty.*
- **Every outbound / inbound-busy / two-way sync flag is `false` on every studio.** No worker
  is draining the queue, and no studio is intent-eligible. **Re-verified 2026-08-23** across
  all six tenants: `google_calendar_connection_enabled` is true on the controlled test studio
  and nowhere else; `google_calendar_outbound_sync_enabled`,
  `google_calendar_inbound_busy_enabled` and `google_calendar_two_way_updates_enabled` are
  false everywhere. The single connection, single outbox row and single event link all sit on
  that one test studio; **Willow holds none of the three**.
- **The calendar cron routes ARE registered and DO run daily** — `vercel.json` schedules
  `/api/cron/calendar-reconcile` at `0 9 * * *` and `/api/cron/calendar-sync` at `30 9 * * *`.
  They authenticate, find zero eligible studios and zero claimable jobs, and exit having done
  nothing. **Dormancy comes from the flags being off, not from the absence of a schedule.**
- Inbound busy import and two-way edits are **designed, not built**.

Deployed ≠ enabled. Each of the following needs **separate authorization**: connecting
Willow, enabling any outbound flag, activating the worker, and starting inbound/two-way work.

## 10. Multi-practitioner and practitioner capacity

**Deployed · enabled only on the controlled test studio · public assignment held off everywhere.**

- Tenant isolation is enforced by RLS (`is_studio_member`) plus composite same-studio
  foreign keys; migration **0151** closed the appointments cross-studio-reference gap.
- Multi-studio users are supported (studio switcher + re-validated httpOnly cookie).
- The practitioner roster is real: **2 practitioners at Willow**; 7 across all six tenants,
  which includes the controlled test and synthetic studios (§0).
- **`practitioner_capacity_enabled` is true only on the controlled test studio, and FALSE on
  Willow Electrolysis.**
- **`practitioner_capacity_booking_enabled` — the public-booking kill switch — is FALSE on
  every studio.** Public practitioner selection and assignment is not active anywhere.
  Both capacity flags were **re-verified across all six tenants on 2026-08-23**.
- Per-practitioner availability, scoped blocks and breaks, and the atomic internal
  booking / move / reassign commands (0135–0150) are deployed and follow the capacity flag.

**Schema and code existing is not launch readiness.** Broad multi-practitioner rollout
requires the deep audit and explicit authorization.

## 10b. Owner business surfaces (OWNER-CAP)

**Implemented · merged (PRs #638 `6e5283db`, #641 `a1639a84`, #645 `14be8198`) · deployed ·
enabled for owners of every studio.** **No migration. No RPC.**

`/dashboard/capacity` answers one question Chloe could not previously ask: **which of her active
treatment clients have fallen off the calendar** — the re-book worklist. Nothing else in
production answers it; `clients-needing-attention.ts` is clinical memory and
`practice-metrics.ts` is period-scoped service value.

- **Owner-only, and the server is the authority.** `app/(app)/dashboard/capacity/page.tsx`
  checks `practitioner.role !== "owner"` **before any capacity read is issued** and renders a
  refusal in place — it does not redirect. A practitioner who types the route sees no figures,
  no worklist and no client identity.
- **One Data API statement, one snapshot**, rooted on the studio's current non-archived clients
  with open-plan evidence embedded as a `count` rather than rows.
- **Owners have a permanent `Business` nav entry** (#645) on desktop and in the compact Menu,
  pointing at `/dashboard/capacity`. A practitioner sees no such item — absent, not disabled.
  It is named *Business* rather than *Capacity* deliberately, so later owner surfaces land
  behind the same word without renaming a tab under owners who already learned it. **Nav
  visibility is presentation only and protects nothing**; the route's own server check remains
  the authority.
- **Browser coverage** (#641): nine tests prove an owner reaches the page, an ordinary
  practitioner is refused **in place**, and the rebooking names are real links landing on the
  right client.
- **Slices 2 and 4 are not started.** Slice 2 (new-client demand and conversion) and Slice 4
  (treatment access and weekly capacity) exist only as an approved decomposition.

**Not production-exercised as a measured fact.** No usage of `/dashboard/capacity` was measured
at this reconciliation, and none is claimed.

### Owner financial truth surface — FIN-01A Slice 1 (PR #646)

**Implemented · merged · deployed · owner-only · NOT production-exercised as a measured fact.**
**No migration, no RPC, no new table, no schema work. Migration 0187 is untouched and no
settlement vocabulary changes.**

`/financials` answers one question: **what the calendar held in one studio-local period, and how
those appointments divided** — still to happen, completed, cancelled, no-show — with the
partition claim printed only when it is true.

- **Owner-only, refused before any query.** The role refusal is the **first statement** of
  `loadFinancialsView`, before a Supabase client is constructed, so a practitioner who types the
  URL causes **no studio-wide query** and receives no aggregate payload — not merely an
  aggregate they are not shown.
- **The route is unadvertised.** It is added to `NON_SEARCHABLE_ROUTES`, which **withholds** it
  from search; there is no `NAV_ENTRIES` row. Owners reach it through the existing *Business*
  entry established by #645.
- **It adds no money arithmetic of any kind**, and a source guard proves it: the slice
  references none of the three truth classes' ledger identifiers and reads **exactly one
  table**. The anchor is answered in **visits, not service value** — resolving a price per visit
  is money arithmetic and belongs to **Slice 2**.
- **Unknown is a closed vocabulary, not free prose.** `lib/finance/financial-fact.ts` carries a
  `Fact<T>` whose unknown side is one of `not_recorded`, `unavailable`, `unknowable`,
  `not_yet_supported`, `not_enumerable` — each with its own label, sentence and shape, because
  *"nobody has said what happened"* and *"Hone could not look"* are different claims.
  **`known(0)` is the only route by which a zero reaches this screen**, so a failed read renders
  a sentence naming the cause, never a zero.
- **Deliberately not OWNER-CAP's `Fact<T>`.** That one carries `reason: string`, which cannot be
  exhaustively checked; the two are structurally incompatible on purpose, so importing the wrong
  one is a type error. OWNER-CAP's type is left alone.
- **No external side effect** — no write, no Stripe call, no email, SMS, Google or analytics
  path. No browser E2E was added, deliberately: an `e2e/` spec would trip the spec-count pin.

**#650 made `Still to happen` temporally truthful.** Slice 1 counted `status = 'confirmed'` and
nothing else — and **status alone cannot say whether something is still ahead**. `confirmed`
means *on the calendar, not closed out either way*, and **nothing in Hone writes a terminal
status when an appointment elapses**, so a visit that came and went without being closed out
reported as upcoming indefinitely. The query selected only `status`, so the model could not
compute the right answer even in principle.

The whole widening is `.select("status")` → `.select("status, starts_at")`: still one table,
still no price, payment, settlement, charge, refund or Stripe column, still the owner gate before
a Supabase client is constructed, still the half-open studio-local window. `confirmed` now splits
on time into **`Still to happen`** (at or after the reference instant) and **`Past, still
confirmed`** (already started).

> **The new line is a fact about the RECORD, not about the visit.** It is not evidence the visit
> happened, was missed, or was cancelled. *"missed"*, *"no-show"*, *"completed"* and *"needs
> action"* are deliberately absent — no authority in production writes them.

⚠️ **The production figures behind that repair were measured by #650's own read-only audit on
2026-08-27, not by this reconciliation:** 29 of Willow's appointments were past and still
confirmed, oldest `2026-05-17`, with the live error at 1 row in 19 for the current month. They
are recorded here as that audit's dated evidence and were **not** re-measured.

**Slice 2 and beyond are not shipped.** The disposition chain and the two money bridges each
render one sentence naming the release rather than a zero or a stub.

## 11. Studio onboarding and self-service

Practitioner signup is **invite-only** — magic-link login creates an account only for an
email with a pending team invitation. Invitation reconciliation (0141) ensures nothing
fabricates consent and no membership activates merely because an Auth user was created
(**12 pending invitations across all tenants — 5 at Willow** *(as of 2026-08-23)*).

**Onboarding v2** (0140) is deployed with `onboarding_v2_enabled` true on the **controlled
test studio only**. Nudges and analytics remain deferred.

**Self-serve studio creation is not built.** New studios are provisioned through the
operator runbook.

## 12. Files, treatment photos and exports

Private `treatment-images` bucket, service-role-only access with short-TTL signed URLs,
per-file EXIF stripping, tenant-scoped paths, multi-file upload (3 `treatment_images` across
all tenants — 1 at Willow, 2 on the controlled test studio, **0 synthetic**, as of 2026-08-23).
Per-client procedure record pull with filtered print is live.

### Studio data export — completeness is now machine-accountable (TRUTH-01A)

**Implemented · merged (PR #644, `6786b07b`) · deployed · enabled.** **No migration.**

The export was an **implicit allowlist** — whatever somebody remembered to add. Nothing was
required to have an opinion about a table, so every migration that created one widened the gap
in silence while the product described the result as a *full* export.

`lib/export/resource-registry.ts` is now the one place a resource's export disposition is
decided, and the guards beside it make a **missing decision a build failure**. Schema authority
is the **database, not the file**: the guards take the live resource and column lists as
arguments, supplied by `information_schema` introspection on the fully migrated stack. Nothing
parses migration SQL.

Every resource carries exactly one of three dispositions, and the counts are **deliberately
recorded here as a shape rather than as three exact integers** — the registry is the authority
and a hand-copied count is the very drift this whole reconciliation exists to stop:

- **exported** — in the ZIP, with its file, headers, in-scope columns and row-count verification
  stated. Roughly **sixteen** resources.
- **excluded** — a decision on the record with its reason. Roughly **eighteen**.
- **pending** — studio-owned, **not** exported, and nobody pretending otherwise. Roughly
  **fifty-nine**, each carrying a ticket (`TRUTH-01B`, or `TRUTH-01C` for a small tail) and a
  tier. The Data settings page and the in-ZIP manifest **render this list**, so an owner is told
  what the archive does not carry.

> ⚠️ **The export PAYLOAD is byte-for-byte unchanged.** TRUTH-01A added no file, no table and no
> column. `tests/app/settings/data/export-emission-parity.test.ts` builds a real archive and
> pins every header row against base `a1639a84` column-for-column. **The export is still
> partial.** What changed is that its incompleteness is now declared, tested and shown to the
> owner instead of being invisible. **TRUTH-01B is what changes the payload, and it is not
> shipped.**

**Two withdrawals are recorded rather than glossed.** The application-source reachability
analyser TRUTH-01A originally carried was **withdrawn** as insufficiently robust, and nothing
replaces it. Pending entries therefore say *"TRUTH-01A makes no finding about which code paths
reach this table"* — neither claiming nor denying that anything uses it. Where a fact survives,
it comes from the database (for example `ON DELETE CASCADE` read from `pg_constraint`), not from
reading application code.

Finalized-record photo **content** immutability was never implemented, and is now **moot**:
signed/finalized clinical records are retired (§3), so no record is ever finalized and there is
no finalized-photo integrity claim to make. This is **not** a scheduled phase. The live
protections — private bucket, service-role-only access, path/identity CHECKs and the integrity
trigger that freezes identity columns after insert — are unaffected and remain in force.

## 13. Operations, alerts and observability

- `ops_alerts` — redacted, never-throws. **4 unresolved alerts** *(as of 2026-08-23,
  read-only query)*, out of 7 rows total. All four are `session_payment_charge_failed`,
  severity **warning**, all raised at Willow inside a two-minute window on
  **2026-08-23T19:30:48Z–19:32:39Z**. They correspond to the 4 non-succeeded live charge
  attempts in §7 — one event, counted two ways, not two separate problems.
  **This corrects a standing "0 unresolved" claim** that was true at the 2026-07-27
  reconciliation and was carried forward unverified. *(Unresolved rows are not a claim about
  incidents ever; equally, do not restate "zero" without re-reading the table.)*
- Admin action audit log (0113) at `/admin/audit` — append-only, service-role-only, no
  token/URL/IP/PII columns (**7 events across all tenants**; 3 carry a studio, 4 carry none,
  as of 2026-08-23).
- `scripts/verify-production.mjs` — read-only health check that **derives** the expected
  migration max from `supabase/migrations/` rather than hardcoding it.
- `scripts/check-stripe-gates.mjs` — a gate suite. **Passing gates is not proof of security.**
- Sentry and PostHog are merged and deployed with hardened settings. **Whether either
  console is receiving events, and whether `NEXT_PUBLIC_POSTHOG_*` is set in Vercel, is
  unknown pending verification** — it cannot be confirmed from code or the CLI.
- Rate limiting via Upstash **fails OPEN** — if it is down or unset, portal and booking rate
  limits bypass.

## 14. Known limitations and held capabilities

Full register with impact, mitigation, owner and next gate:
**[known-limitations.md](./known-limitations.md)**.

**Held behind a deliberate server-side gate** (do not enable without a dedicated PR + approval):
live manual no-show / late-cancellation fees · public-booking card collection · public
practitioner selection and assignment.

**Dormant** (deployed but not acting): all Google Calendar sync phases · practitioner capacity
at Willow · onboarding v2 at Willow · **the durable new-client waitlist (WAIT-02B) on every
studio** — see §5b. *(The parenthetical above previously read "structurally unable to act". For
the durable waitlist that is no longer accurate: Stage B1 replaced the build-time prohibition
with a report-only gate, so what keeps it dormant is now **runtime allowlist membership**, and
it takes two allowlists rather than one. It is dormant by configuration, not by structure.)*

**Shipped since the previous reconciliation, and NOT production-exercised:** non-card
appointment settlement (§7 — 0 rows) · `/dashboard/capacity` (§10b — no usage measured) ·
WAIT-02B Stage B1 (§5b — no studio enabled).

**Retired by product decision (2026-07-29), enforced by migration 0159:** signed / finalized
clinical records · signed-record corrections and amendments · practitioner-facing Finalize and
signed-Correction controls · any "snapshot v2". These are **not dormant and not held** — they
cannot be enabled by any role. See
[../decisions/clinical-finalization-retired.md](../decisions/clinical-finalization-retired.md).

**Not built:** deposits / packages / partial payments · broad self-serve live payments ·
inbound-busy and two-way calendar · broad-SaaS SMS · self-serve studio creation.

**Deferred by product decision (2026-07-27):** the direct new-client consultation booking route.

## 15. Human acceptance still pending

**Chloe has not yet accepted, on-device, any of the following:**

1. The unified **Treatment observations & skin response** box.
2. Galvanic intensity being absent from new charting.
3. `0.733` displaying as **`0.733 seconds`**.
4. The **Thermolysis pulse count** label and its placement inside the thermolysis section.
5. The larger **Additional notes** field.
6. **Whole-session copy.** *(Note the change of grounds: this is no longer waiting on a first
   production copy. **24 have now been performed at Willow**, 2026-07-28 to 2026-08-23 — see
   §2. What is still missing is Chloe's explicit confirmation that she has used it and accepts
   its behaviour. **Usage is evidence of exercise, not of acceptance.**)*
7. Conditional numbing notes (0156) and inventory-backed probe-lot linkage (0155).

Engineering deployment for all of the above is **complete**. Human acceptance is **not**.
Do not describe any of it as accepted, validated by Chloe, or signed off.

**Do not infer acceptance from usage.** For items 1–5 and 7, no per-item production-exercise
evidence has been measured in either direction, and none is asserted here. For item 6 the
exercise evidence is now strong and the acceptance record is still absent. Those are
independent dimensions, and only an explicit statement from Chloe closes the second one.

## 16. Next work

1. **Chloe's human acceptance testing** — may happen separately and later; it does not block
   the audit.
2. **The deep production / security / code audit.** Still not performed against this baseline.
   This remains the next substantive engineering and governance work.
3. **TRUTH-01B — change the export payload.** TRUTH-01A made the gap declared and testable;
   roughly fifty-nine studio-owned resources are still unexported and each carries a ticket.
   See §12.
4. **Broader second-studio and multi-practitioner rollout** — only after the audit and explicit
   authorization.
5. **WAIT-02B Stage B2 (activation)** — requires an explicit per-studio operator GO and human
   activation smoke. The disclosure blocker is closed; the authorization is not granted. See
   §5b and **L25**.
6. **Retention and deletion (F-RET-001)** — there is still **no automated retention or
   permanent-deletion lifecycle**: no purge job, no hard-delete path, no legal hold. The
   published policy is **accurate about that absence** — it says plainly that no automatic timed
   purge runs — so this is a **capability gap, not a breached commitment**. **P2 and open**; see
   [known-limitations.md](./known-limitations.md) **L27**, which records why the earlier
   P1 framing was withdrawn. Sequenced after a complete export and jointly with offboarding.

The direct new-client consultation booking route is **not** on this list. It is deferred by
product decision — a separate matter from the waitlist that is live today (§5b).

---

## How to re-verify this document

Never trust a number here without re-checking it. Nothing in this document is evidence for
any other document.

**Three rules this document now follows, and a re-verifier must keep:**

1. **No migration number is written here.** Hosted max is declared once in
   [`migration-state.json`](./migration-state.json); repo max and the next free number are
   derived by `npm run migration:state`. Copying either into prose is what produced the
   `0160`/`0163`/`0165` divergence, and `tests/docs/canonical-production-facts.test.ts` now
   fails the build if it comes back.
2. **Every production count carries an as-of stamp and a tenant scope.** A bare number with
   neither is not a fact, it is a fossil.
3. **Real-customer activity means Willow only.** All-tenant totals include the Synthetic Twin
   and must say so. See §0.
4. **An open PR is never production.** A branch, a green CI run and a mergeable state are not
   deployment. Before writing a capability down as shipped, confirm its merge commit is an
   **ancestor of the production head**. The open set at this reconciliation is listed under
   *Open pull requests are not production* above.
5. **This document is not evidence for itself.** No assertion here may be verified by citing
   another line of this file, and a figure carried forward from an earlier reconciliation is
   dated evidence rather than a current reading. Re-derive from the sources below, in order.

```bash
# 1. Production branch head
gh api repos/SaiSamyukthVemuri/Hone/branches/claude/build-hone-saas-hOex7 --jq .commit.sha

# 1b. Derived + declared migration state (never hand-copied)
npm run migration:state -- --json

# 2. Hosted vs repo migrations (guard the project ref FIRST)
cat supabase/.temp/project-ref          # must be the production project
supabase migration list --linked        # Local and Remote must reconcile

# 3. Read-only production state
supabase db query --linked "<verification sql>"   # never `db execute`

# 4. Health
curl -s -o /dev/null -w '%{http_code}\n' https://hone.care

# 5. Read-only health script
node scripts/verify-production.mjs
```

Source-of-truth order: production Git graph → Vercel deployment record →
`supabase migration list --linked` → read-only production queries → code and migrations at
the exact production SHA → merged PR metadata and CI → deployment/runbook reports →
existing documentation (as claims to verify, never as evidence).

See also: [capability-register.md](./capability-register.md) ·
[known-limitations.md](./known-limitations.md) · [migration-ledger.md](./migration-ledger.md) ·
[release-changelog.md](./release-changelog.md) ·
[../runbooks/migration-first-process.md](../runbooks/migration-first-process.md)
