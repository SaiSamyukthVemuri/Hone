---
type: read model
title: Treatment Intelligence summary
description: The client-profile Treatment Intelligence card — a pure, read-only rollup of a client's recorded electrolysis/laser charting history (charted sessions, block count, recorded minutes and hairs, hairs/min, first/last treated, latest tolerance, per-area latest recorded setup, commonly and latest recorded reactions, watch note and next-visit plan) — with its exact counting and grouping rules, soft-delete and failed-read handling, placement, consumers, and what it deliberately does not establish.
tags: [treatment-memory, treatment-intelligence, recorded-history, client-profile, read-model, clinical-read-truth]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-3bae44e51508539a63dfac8d
    resource: repo://app/(app)/clients/%5Bid%5D/page.tsx
  - id: openwiki-source-2d0c77e7a05e00d8236ac181
    resource: repo://components/treatment-intelligence-card.tsx
  - id: openwiki-source-19b78a5ed810c6cb7869ea48
    resource: repo://lib/dashboard/before-today-previews.ts
  - id: openwiki-source-cf0301a5f1fa20545af6e0b1
    resource: repo://lib/imported-treatment-memory.ts
  - id: openwiki-source-9b2ae69b46d8883fac67f92b
    resource: repo://lib/sessions/reaction-unified.ts
  - id: openwiki-source-dc9a1da612097e2d64e46019
    resource: repo://lib/sessions/treatment-intelligence.ts
  - id: openwiki-source-bf4a03832f84ac176dc48f73
    resource: repo://lib/supabase/queries.ts
  - id: openwiki-source-2cf2fd4a7390fd6a728ce089
    resource: repo://lib/treatment-time/area-bucket.ts
  - id: openwiki-source-cc6f53a714f18e3dc73c2221
    resource: repo://tests/app/clients/clinical-read-truth.test.ts
  - id: openwiki-source-91b794db41d662e206763ab6
    resource: repo://tests/app/clients/treatment-intelligence.test.ts
  - id: openwiki-source-0b5d79f2413c6a8d2476c8b6
    resource: repo://tests/app/sessions/whole-session-copy-metric-invariant.test.ts
  - id: openwiki-source-ab92d6e276365dff46322a67
    resource: repo://tests/lib/sessions/reaction-unified.test.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Treatment Intelligence summary

**Treatment Intelligence** is a card on the client profile Overview. It rolls up a client's **recorded charting
history** into numbers and "latest recorded" facts a practitioner can review before or during a visit. It is
produced by one pure function,
[`buildTreatmentIntelligence`](../../lib/sessions/treatment-intelligence.ts#L189-L377), and rendered by
[`TreatmentIntelligenceCard`](../../components/treatment-intelligence-card.tsx#L82-L195).

Related pages:

- the session, block and entry model: [Sessions, blocks and entries](sessions-blocks-and-entries.md);
- the other memory surfaces (Last treatment, Before Today, appointment prep, imported history):
  [Treatment memory reads and point-of-care memory](memory-reads-and-point-of-care.md);
- a different, single-bucket attribution of minutes:
  [Treatment plans and treatment time](treatment-plans-and-treatment-time.md).

## 1. Purpose and safety boundary

The builder's own contract
([`treatment-intelligence.ts` L5-L27](../../lib/sessions/treatment-intelligence.ts#L5-L27)) is
**recorded-history analytics, never advice**:

| It is | It is not |
|---|---|
| a rollup of what practitioners **recorded** | a recommendation of settings |
| for practitioner review | a diagnosis or contraindication check |
| | a prediction or projection |
| | a statement that treatment "worked", or any cause-and-effect claim |

The wording follows from that:

- **Card copy.** Every label says "recorded", "historically", "commonly recorded" or "latest recorded". The
  header reads: "Based on recorded treatment areas and session history. Use professional judgment. This
  summary reflects recorded history only."
- **Gaps.** A missing fact stays `null` and renders **"Not recorded"**. Nothing is inferred or invented.
- **A test bans overclaiming words.** `tests/app/clients/treatment-intelligence.test.ts` fails if the card
  or builder contains "best", "recommend", "caused", "safe", "diagnos…", "treatment is working", "works best",
  "predicted" or "success"
  ([L307-L323](../../tests/app/clients/treatment-intelligence.test.ts#L307-L323)).
- **The builder is pure.** The same test asserts it imports no Supabase client and that the page's block
  read is a `select` filtered on `deleted_at is null`.

## 2. Overall figures

| Card stat | How it is derived |
|---|---|
| **Charted sessions** | sessions with at least one loaded block, or any electrolysis or laser entry. This is the same rule as the Last treatment card ([L205-L211](../../lib/sessions/treatment-intelligence.ts#L205-L211)) |
| **Treatment areas charted** | the number of loaded **blocks**. It is not a count of distinct areas: a multi-area block counts once, and one area charted in three sessions counts three ([L356-L369](../../lib/sessions/treatment-intelligence.ts#L356-L369)) |
| **Minutes** | sum of positive `session_blocks.minutes_performed` |
| **Hairs** | sum of positive `hairs_treated` from block entries, plus blockless legacy sessions (§5) |
| **Hairs/min** | `hairs ÷ minutes`, rounded to one decimal, only when **both** are positive ([L108-L118](../../lib/sessions/treatment-intelligence.ts#L108-L118)) |
| **First treated / Last treated** | earliest and latest `started_at` among charted sessions |
| **Latest tolerance** | `tolerance_rating` of the most recent block that has one, shown as `n/5` |

**Empty history.** With no charted session, `buildTreatmentIntelligence` returns `charted: false`,
`chartedSessions: 0`, `areasCharted: 0`, `null` for every other overall figure (`minutes`, `hairs`,
`hairsPerMinute`, `firstTreated`, `lastTreated`), no area cards (`areas: []`), and `null` reaction, tolerance,
watch-note and plan fields (`commonReactionLabel`, `latestReactionLabel`, `latestToleranceRating`,
`latestWatchNote`, `latestPlan`) ([L212-L231](../../lib/sessions/treatment-intelligence.ts#L212-L231)). The card
then says **"No charted treatment history yet."** The test "no charted history returns the empty state" pins
`charted: false` and `chartedSessions: 0`
([`treatment-intelligence.test.ts` L60-L67](../../tests/app/clients/treatment-intelligence.test.ts#L60-L67)), and
[`whole-session-copy-metric-invariant.test.ts` L50-L83](../../tests/app/sessions/whole-session-copy-metric-invariant.test.ts#L50-L83)
pins that an empty session left behind by the contained whole-session copy, with no blocks and no entries, is **not
charted** (`chartedSessions: 0`, `minutes: null`), and that only a saved block changes the totals.

## 3. Per-area memory

Area cards come from the block loop
([L260-L331](../../lib/sessions/treatment-intelligence.ts#L260-L331); names from
[`blockAreaNames` L120-L143](../../lib/sessions/treatment-intelligence.ts#L120-L143)):

**Grouping**

- **Key.** Areas group by **trimmed, case-insensitive** name. Blocks are walked oldest to newest, so the
  **newest original spelling** becomes the card's label.
- **Every treated area.** A block with structured areas (`0128`) contributes to **every** area it treated,
  so a "Cheeks + Sideburns" block appears under both cards. A block without structured rows falls back to
  `primary_area`, then the legacy `block_name`.
- **Laterality is aggregated out.** Only the area *name* forms the key, so left one visit and right the next
  stay one card.
- **No blank cards.** Blank or unresolved names produce **no card**, but their minutes and hairs still count
  in the overall totals.

**What each card shows**

- sessions, minutes, hairs and hairs/min for that area;
- first and last treated dates;
- **latest recorded setup**, taken from the area's most recent block: machine frequency, probe label, mode
  label (the Apilus modality wins; otherwise Thermolysis, Blend or Galvanic) and energy level;
- **commonly recorded reaction** (§4);
- **latest watch note**, from a block whose `caution_for_next_session` flag or `caution_note` is set. The note
  text is used, or "Previously noted" when only the flag is set.

Cards are ordered by last treated, newest first.

Tests pin each rule ([`treatment-intelligence.test.ts` L123-L270](../../tests/app/clients/treatment-intelligence.test.ts#L123-L270)):
grouping and spelling, crediting every structured area, legacy no-split by side, blank names, latest setup,
reaction tie-breaks, and latest tolerance, watch note and plan.

## 4. Recent-history signals

| Signal | Rule ([L153-L187](../../lib/sessions/treatment-intelligence.ts#L153-L187), [L333-L354](../../lib/sessions/treatment-intelligence.ts#L333-L354)) |
|---|---|
| **Reaction labels** | the **unified** set per block: the legacy `reaction_type` label plus every clinical-response chip in the block's **live** entries' `observation_chips`, deduped case-insensitively, with all responses kept ([`reaction-unified.ts` L51-L75](../../lib/sessions/reaction-unified.ts#L51-L75)). Ordinary observation chips are never a reaction |
| **Commonly recorded reaction** | the most frequent label across blocks; every label of a multi-reaction block counts; a tie goes to the most recent |
| **Latest recorded reaction** | **all** labels of the most recent block that has any, joined |
| **Latest tolerance** | the most recent non-null `tolerance_rating` |
| **Latest watch note** | the most recent block with a caution flag or note |
| **Plan for next visit** | the newest non-empty `next_session_note` among the sessions passed in |

`tests/lib/sessions/reaction-unified.test.ts` proves these rules for Treatment Intelligence
([L348-L399](../../tests/lib/sessions/reaction-unified.test.ts#L348-L399)):

- latest reaction reads the unified representation and keeps every label;
- legacy `reaction_type` is still summarised;
- safety-relevant responses reach the summary.

## 5. Counting rules

([L241-L254](../../lib/sessions/treatment-intelligence.ts#L241-L254))

- **Minutes** come only from `session_blocks.minutes_performed`, the same source as the treatment-time
  tracker. Entry-level legacy minutes are deliberately not added.
- **Hairs** come from the entries of each block (`entry_hairs`).
- **Blockless legacy sessions.** A session's own `electrolysis_entries` count **only when that session has no
  loaded blocks**, so a charted pass is never counted twice.
- **Non-positive values** (zero, negative, `null`, non-finite) contribute nothing.
- **No zero totals.** A minutes or hairs total, overall or per area, that sums to 0 becomes `null`
  ("Not recorded"), never a stated zero. The two counts, `chartedSessions` and `areasCharted`, are counts and are
  `0` when nothing is charted.
- **Hairs/min** exists only when both hairs and minutes are positive.

The DB-free test proves the blockless rule: a block's hairs are not re-added from the session row, a blockless
legacy session contributes its valid hairs, and a negative minute value is ignored
([`treatment-intelligence.test.ts` L59-L121](../../tests/app/clients/treatment-intelligence.test.ts#L59-L121)).

## 6. Data hygiene and read truth

**Soft-deleted rows are excluded before the builder runs:**

- `getClientById` loads sessions with `deleted_at is null`, and strips voided (`0114`) electrolysis and
  laser entries through `stripDeletedEntries`
  ([`queries.ts` L350-L410](../../lib/supabase/queries.ts#L350-L410));
- the intelligence read selects `session_blocks` with `deleted_at is null`;
- the page drops voided entries from both `entry_hairs` and the reaction chips
  (`app/(app)/clients/[id]/page.tsx` L639-L673, L762-L782).

**No history and a failed read are different states.** A read that fails, whether by returning an `error`
or by throwing, sets `intelligenceUnavailable`, and the builder is never run on the failure's empty array.

The page first builds a `blocks: []` value. That value is byte-identical to a client with no charted history,
so the card checks **`unavailable` before `charted`** and renders the clinical-unavailable notice
("Clinical history could not be loaded."). It never shows "No charted treatment history yet." or zeroed
stats for a read that did not happen
([card L87-L114](../../components/treatment-intelligence-card.tsx#L87-L114)). The proof is
`tests/app/clients/clinical-read-truth.test.ts`:

- recorded stats render on success;
- the true none-state stays truthful;
- under failure: no zeroed stats, no "Not recorded", no negative claim;
- page-source checks that each read's `error` is destructured and flagged.

## 7. Display, placement and data flow

**Placement.** The card is on the **Overview** tab only. It comes after "Client info", Before Today and the
clinical-notes summary, and before Pricing. A test pins "between Client info and Pricing" and also checks the
card is not on the Record Keeping page
([`treatment-intelligence.test.ts` L272-L305](../../tests/app/clients/treatment-intelligence.test.ts#L272-L305)).

**Read-only.** Nothing on the card writes.

**Read** (`app/(app)/clients/[id]/page.tsx` L539-L782):

- It is gated on the Overview tab and is the page's widest read: `session_blocks` for the client's newest
  **200** sessions, with per-entry hairs and chips, scoped by studio.
- Structured areas are attached for this read and the Last-treatment read in **one** query.
- It runs in the same `Promise.all` wave as the other clinical reads. Each unit contains its own failure, so
  one failing cannot blank another card.

**Consumers beyond the card:**

- **Before Today on the profile** takes setup, tolerance and reaction from this intelligence. Its
  `clinicalUnavailable` is the union of both clinical read failures, so it cannot assert absence off one
  half.
- **Dashboard Before Today previews** run the same pipeline per client
  ([`before-today-previews.ts` L372-L384](../../lib/dashboard/before-today-previews.ts#L372-L384)).
  They pass `entry_hairs: []`, so hair figures are not computed there.

## 8. What it does not establish, and limitations

**It does not establish:**

- that any treatment was effective or caused anything;
- that hair growth changed;
- what setting to use next;
- that a reaction pattern is clinically significant;
- that the record is complete.

"Commonly recorded" is a frequency of entries, nothing more. Hairs/min is arithmetic on recorded totals, not a
performance measure.

**Limitations visible in the code:**

1. **Per-area figures are not additive.** A multi-area block adds its **full** minutes and hairs to *every*
   area card it treated, while the overall totals count it once
   ([L274-L306](../../lib/sessions/treatment-intelligence.ts#L274-L306)). So area cards can sum to more than
   the overall total. The Treatment Time card instead credits such a block **once** to a combined bucket
   ([`area-bucket.ts` L1-L60](../../lib/treatment-time/area-bucket.ts#L1-L60)). The two cards answer different
   questions and can show different per-area minutes for the same client.
2. **Only the newest 200 sessions' blocks are read.** The builder still receives *all* the client's sessions.
   For an older session, the session-row entries can mark it charted and add hairs through the blockless rule.
   It contributes **no minutes and no area card**, so a client with more than 200 sessions has under-stated
   minutes (`app/(app)/clients/[id]/page.tsx` L639-L673, L762-L782; builder
   [L205-L254](../../lib/sessions/treatment-intelligence.ts#L205-L254)).
3. **Imported treatment memory is not part of this summary.** The builder's inputs are `sessions` and
   `session_blocks` only. Rows from `imported_treatment_memories` are shown separately, labelled as imported,
   in Before Today. The imported-memory module's own header lists surfacing in Treatment Intelligence as later
   work. See [Imported history](memory-reads-and-point-of-care.md#5-imported-history).
4. **Laser sessions** count as charted sessions through their entries, but contribute hairs only if they have
   electrolysis entries and minutes only through blocks.
5. **No production figures here.** How often the card is viewed, or how many clients have history, is not
   recorded in the repository and is not implied by this page.
