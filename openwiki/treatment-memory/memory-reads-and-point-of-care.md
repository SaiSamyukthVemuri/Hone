---
type: read model
title: Treatment memory reads and point-of-care memory
description: How Hone assembles "what happened last time" — the single charted-session authority, the last-treatment loader and its fail-soft versus none-versus-unavailable contracts, point-of-care memory on the charting screen, the appointment-prep narrative, Before Today, imported history, global search recall, and the setup-only whole-session copy — with the rule that a failed clinical read is never presented as "no history".
tags: [treatment-memory, charting, read-model, before-today, whole-session-copy, clinical-safety]
sources:
  - id: openwiki-source-04c3958a8a9bb834f8fda65e
    resource: repo://e2e/before-today-imported.spec.ts
  - id: openwiki-source-cf0301a5f1fa20545af6e0b1
    resource: repo://lib/imported-treatment-memory.ts
  - id: openwiki-source-7174843b7a86ee3dec5a51a2
    resource: repo://lib/search/treatment-memory-merge.ts
  - id: openwiki-source-08676ad937ff5e16b78465fa
    resource: repo://lib/sessions/appointment-prep-memory.ts
  - id: openwiki-source-83e6790c1c4cd08c6c21d254
    resource: repo://lib/sessions/before-today.ts
  - id: openwiki-source-d5de37f4088ea5c9aa9cedce
    resource: repo://lib/sessions/charted-session.ts
  - id: openwiki-source-c235de40c37f7d970df73244
    resource: repo://lib/sessions/last-treatment-loader.ts
  - id: openwiki-source-9ac0dd3d2516f722a7271554
    resource: repo://lib/sessions/point-of-care-memory.ts
  - id: openwiki-source-ba4beaea0a6ba850c9286345
    resource: repo://supabase/migrations/0089_imported_treatment_memory.sql
  - id: openwiki-source-bc3bc1424cb3a62d2723dbf3
    resource: repo://supabase/migrations/0157_whole_session_copy_setup.sql
  - id: openwiki-source-4aaf813de4245b75456b4527
    resource: repo://tests/app/dashboard/today-two-authority-truth.test.ts
  - id: openwiki-source-8ed730e628967794b708209b
    resource: repo://tests/db/point-of-care-memory.db.test.ts
  - id: openwiki-source-a9f87fe69bcb9ce0a2bac358
    resource: repo://tests/db/whole-session-copy.db.test.ts
generated: { by: "claude-code", at: "2026-10-02T23:26:41.194Z" }
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T23:26:41.194Z
---

# Treatment memory reads and point-of-care memory

Treatment memory is the product's core promise: before and during a visit, the practitioner sees what was done
last time. Several surfaces answer that question at different distances from the client, and they share **one**
definition of "the last treatment" and **one** rule about failure.

| Surface | Builder | Shape |
|---|---|---|
| `/clients/<id>/sessions/new` | `buildLastSessionSummary` | five-second recap |
| live charting screen | `buildPointOfCareMemory` | the setup to reproduce |
| calendar appointment detail | `appointment-prep-memory` | full pre-visit read including narrative |
| client page | `before-today` | pre-treatment briefing |
| client page Overview | `buildTreatmentIntelligence` | recorded-history rollup of the client's charted sessions |

The Overview rollup has its own page: [Treatment Intelligence summary](treatment-intelligence-summary.md). It
covers counting rules, per-area grouping and what the summary does not establish. **Before Today**
takes its latest setup, tolerance and reaction from that rollup, and the dashboard previews run the same
pipeline.

How sessions, blocks and entries are written is on [Sessions, blocks and entries](sessions-blocks-and-entries.md).
Probe lots and record keeping are on [Probes, settings and record keeping](probes-settings-and-record-keeping.md).

## 1. One definition of "the last charted session"

`lib/sessions/charted-session.ts` is the rule ([L1-L40](../../lib/sessions/charted-session.ts#L1-L40)).

`start_session` creates an **empty** session row the moment a modality is tapped, and abandoned empty rows are
common. Any surface that took `started_at desc limit 1` therefore showed a blank "previous session" while the real
treatment sat one row below.

The rule has two halves:

- **SQL half:** the caller filters to the studio and client, excludes soft-deleted rows and orders newest first.
  `getClientById` already does this.
- **Content half (pure):** excludes void and current sessions, applies the time bound, and requires the session
  to **contain charting** — at least one live settings block, live electrolysis entry or live laser entry.

The module records one **known divergence**: the dashboard's clients-needing-attention list uses a blocks-only
rule.

## 2. The last-treatment loader and the failure rule

`lib/sessions/last-treatment-loader.ts`:

- costs **one** round trip, a batched `.in("session_id", …)` read of the candidates' blocks;
- reads through the RLS-scoped user client and uses no service role;
- filters by `studio_id` as defence in depth;
- caps the batch at 600 rows ([L20-L50](../../lib/sessions/last-treatment-loader.ts#L20-L50)).

**Three outcomes are kept distinct**, because they are clinically different
([L182-L260](../../lib/sessions/last-treatment-loader.ts#L182-L260)):

| Outcome | Meaning |
|---|---|
| `selected` | a charted prior treatment was found |
| `none` | the reads succeeded and nothing charted exists |
| `unavailable` | the block read **failed**; nothing is known, and the code must never claim a treatment does not exist |

A failed read is logged with only its SQLSTATE, the studio id and the candidate count. It never logs the raw
message, which could echo session ids and clinical column names.

How each caller uses the outcome:

- **Charting screen and `/sessions/new`** keep a **fail-soft** contract. `loadLastChartedTreatment` returns `null`
  for `none` *and* `unavailable`, and the panel renders nothing. A memory panel must never take charting down,
  and these surfaces make no "no history" statement ([L155-L180](../../lib/sessions/last-treatment-loader.ts#L155-L180)).
- **Appointment prep** makes an explicit statement to the practitioner, so it carries an `unavailable` flag.
  - A transient timeout used to render "No previous treatment charted for this client." for a client with forty
    visits ([L371-L408](../../lib/sessions/last-treatment-loader.ts#L371-L408)).
  - The **narrative** (the plan note and legacy session notes) is returned separately. It survives both
    "nothing charted" and "blocks read failed", because a plan can be written on a visit that was never charted.
  - In the batched dashboard variant, a client whose window was **truncated** by the shared row budget comes back
    `unavailable`, never as "new client" ([L534-L541](../../lib/sessions/last-treatment-loader.ts#L534-L541)).
- **Before Today** carries two independent flags ([`before-today.ts` L45-L80](../../lib/sessions/before-today.ts#L45-L80)):
  - `clinicalUnavailable` — the blocks read failed;
  - `clientRecordUnavailable` — the client read failed.

  `unavailable` must be read **first**: when it is true, `hasHistory: false` means "could not find out". A failed
  client read must not produce "phone not recorded", and a failed clinical read must not suppress true record
  reminders.

The dashboard's Today row orders its answers *unavailable → new → silent → history*. The "no history" line needs
both authorities to agree, and an unavailable prep read never routes a client as new
([`today-two-authority-truth.test.ts` L65-L185](../../tests/app/dashboard/today-two-authority-truth.test.ts#L65-L185)).

## 3. Point-of-care memory

`buildPointOfCareMemory` is pure and client-safe. It extends the compact summary with what a practitioner needs
while treating ([`point-of-care-memory.ts` L1-L45](../../lib/sessions/point-of-care-memory.ts#L1-L45)):

- machine frequency;
- probe and lot;
- numbing;
- hairs treated;
- mode-valid machine readings.

Its rules:

- **Mode gating.** Readings come from `readingFieldOrder(mode)`, so a thermolysis block never shows stale
  galvanic values.
- **Retired inputs stay hidden.** `galvanic_intensity_percent` is never read.
- **Entry-level setup comes from the canonical pass**, the earliest live entry. Hairs are **summed** over live
  passes, and the pass count is shown when there is more than one.
- **Soft-deleted passes are excluded everywhere.**
- **Clinical text is never truncated.**
- **Labels come from the shared helpers** (areas, readings, seconds, tolerance, numbing, response), so the
  surfaces cannot drift.

DB proof ([`point-of-care-memory.db.test.ts` L343-L680](../../tests/db/point-of-care-memory.db.test.ts#L343-L680)):

- the newest **charted** session beats a newer empty one, and the newer empty one is flagged;
- multi-area minutes are credited exactly once;
- every field round-trips, including the exact 3-decimal thermolysis duration;
- other clients and studios never appear, and RLS itself blocks the read;
- soft-deleted blocks, entries and sessions are excluded;
- the statement count is fixed as history grows (no N+1);
- a client with no charted history yields no memory.

## 4. Appointment-prep narrative

The appointment detail page adds a narrative layer on top of point-of-care memory
([`appointment-prep-memory.ts` L1-L68](../../lib/sessions/appointment-prep-memory.ts#L1-L68)).

**Included** — only columns audited as practitioner-authored treatment text for that session:

- the session notes (legacy) and the next-visit note;
- the block caution, reaction (both legacy) and numbing notes;
- electrolysis entry comments;
- laser observation notes.

**Excluded, each with a stated reason:** structured chips, area identity, dead columns, deletion metadata, and
other record types.

**Duplicates are prevented structurally.** A note's identity is its source, area and text, and the notes section
is the single place free text renders.

## 5. Imported history

`imported_treatment_memories` (`0089`) is a **separate** destination for history migrated from paper cards or
other systems ([`0089` L1-L50](../../supabase/migrations/0089_imported_treatment_memory.sql#L1-L50)):

- it is not live charting, because `sessions` cannot represent flat historical rows;
- RLS lets members read and owners insert or void;
- there is no DELETE policy, so correction is by soft void;
- an append-only audit table is written only by a definer trigger.

The read model returns studio-scoped, non-voided rows through the RLS client, with provenance labels such as
"Imported from …" and recorded-history wording only, never advice
([`lib/imported-treatment-memory.ts` L8-L40](../../lib/imported-treatment-memory.ts#L8-L40)). Before Today shows it
labelled as not charted live (`e2e/before-today-imported.spec.ts`). Quick Import, the writer, is on
[Studio onboarding, settings and data portability](../studio/onboarding-settings-and-data-portability.md).

## 6. Global search recall

`lib/search/treatment-memory-merge.ts` merges two independent candidate paths
([L1-L26](../../lib/search/treatment-memory-merge.ts#L1-L26)):

- **direct** — the block's own text columns;
- **child** — a structured treatment area.

The child path is the only way a **secondary** area is findable: a block charted "Left Cheek · Right Sideburn"
keeps the legacy primary area "Cheek". The merge dedupes the overlap so one treatment is one result. It is pure
and owns no display logic.

## 7. Whole-session copy ("copy areas and settings from last session")

The preview is ephemeral. One explicit action calls `copy_session_setup` through the server action
([`0157` L1-L63](../../supabase/migrations/0157_whole_session_copy_setup.sql#L1-L63)).

| Property | How it is enforced |
|---|---|
| **Service-role only** | the RPC re-verifies an active membership, because `auth.uid()` is null |
| **Source-authoritative** | the RPC derives the eligible previous session itself and rejects a browser-chosen id that disagrees |
| **Stale-safe** | a fingerprint is recomputed in the transaction; a changed source creates **zero** rows |
| **Target-locked** | `FOR UPDATE`; the target must be an empty electrolysis draft |
| **Setup-only** | the insert column lists carry only machine and probe setup plus the area. Outcomes, probe lots and `minutes_performed` are never copied, so today's minutes start empty |
| **At-most-once** | the `session_copy_operations` ledger plus idempotency keys: same key and payload replays, same key with a different payload is ambiguous, and a new key after a commit is refused because the target is no longer empty |

The client side builds preview cards and the RPC payload only
([`lib/sessions/whole-session-copy.ts` L1-L50](../../lib/sessions/whole-session-copy.ts#L1-L50)).

[`whole-session-copy.db.test.ts` L215-L600](../../tests/db/whole-session-copy.db.test.ts#L215-L600) proves:

- outcomes and minutes are dropped and the ledger stays truthful;
- the idempotency and serialization behaviour;
- stale and source-authority rejections, including never picking another client's, a later or a laser session;
- target eligibility;
- non-members, inactive members and the `authenticated` role cannot execute it;
- a mid-batch failure rolls everything back.

## 8. End-to-end

`e2e/core-memory-loop.spec.ts` runs the whole loop in a browser
([L11-L21](../../e2e/core-memory-loop.spec.ts#L11-L21)):

1. public booking;
2. intake;
3. magic-link login;
4. charting;
5. a second appointment, where Before Today and Treatment Intelligence show the recorded memory;
6. the Record Keeping print;
7. a check that an anonymous visitor stays locked out.

## 9. Contradictions and open questions

1. **The imported-memory module says it is not surfaced yet.** Its header says surfacing imported memory in
   Before Today, Treatment Intelligence or the client page "is a LATER PR"
   ([`imported-treatment-memory.ts` L26-L27](../../lib/imported-treatment-memory.ts#L26-L27)). It is already
   imported by the client page and the Before Today card, and a browser spec proves it appears there.
2. **Two definitions of "charted" coexist.** `charted-session.ts` documents that the dashboard's
   clients-needing-attention list uses a blocks-only rule without the legacy-entry fallback
   ([L34-L38](../../lib/sessions/charted-session.ts#L34-L38)). The two can disagree for a client whose only
   charting is legacy entries.
3. **Fail-soft surfaces stay silent instead of showing "couldn't load".** On the charting screen and
   `/sessions/new` a failed read renders nothing, by design. A practitioner there cannot tell "no prior
   treatment" from "the read failed", but those surfaces make no claim either way. The explicit "couldn't load"
   state exists only on appointment prep and Before Today.
