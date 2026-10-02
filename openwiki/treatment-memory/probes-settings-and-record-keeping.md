---
type: domain model
title: Probes, treatment settings and record keeping
description: The electrolysis setup and safety-record model — the code-only probe catalog, machine readings and the pulse-delay range, numbing notes, structured observation chips and the unified reaction contract, inventory-backed probe lots with a same-studio composite FK, expiry versus discard as independent lifecycles, sterile-item and disinfectant logbooks — and, for each rule, whether the database or only the application enforces it.
tags: [probes, record-keeping, sterile-inventory, observation-chips, charting, validation]
sources:
  - id: openwiki-source-5ac4bfebd3f01c9163136f75
    resource: repo://app/(app)/clients/%5Bid%5D/sessions/%5BsessionId%5D/actions.ts
  - id: openwiki-source-deca2eb7e839d1db80ee45e6
    resource: repo://app/(app)/records/actions.ts
  - id: openwiki-source-0a7f1727d82c9ac5dce569e4
    resource: repo://docs/production/known-limitations.md
  - id: openwiki-source-64b7a8e7b8bb1b76c4a50a33
    resource: repo://lib/observation-chips.ts
  - id: openwiki-source-b64d9b0707def0396ea5efbb
    resource: repo://lib/probes.ts
  - id: openwiki-source-5229249317c61f6ec54a10c6
    resource: repo://lib/record-keeping/expiry.ts
  - id: openwiki-source-a0d0fe50fc13ef650c40e499
    resource: repo://lib/record-keeping/probe-inventory-validation.ts
  - id: openwiki-source-0ad8fffedc65eb82c9a4879c
    resource: repo://lib/record-keeping/probe-lot-inventory.ts
  - id: openwiki-source-9b2ae69b46d8883fac67f92b
    resource: repo://lib/sessions/reaction-unified.ts
  - id: openwiki-source-a05c9f389ffe9e24057fd5ef
    resource: repo://supabase/migrations/0086_record_keeping_audit_events.sql
  - id: openwiki-source-9be98b6b5bc9e7f7a617e554
    resource: repo://supabase/migrations/0088_exposure_incident_owner_access.sql
  - id: openwiki-source-40e847f6c6d50a5a3df0bdab
    resource: repo://supabase/migrations/0102_electrolysis_entry_pulse_delay.sql
  - id: openwiki-source-4c0e5c373811f917d62572ef
    resource: repo://supabase/migrations/0108_electrolysis_observation_chips.sql
  - id: openwiki-source-e091c7b298f336b502717a3c
    resource: repo://supabase/migrations/0155_probe_inventory_chart_linkage.sql
  - id: openwiki-source-5551d697b2187d7f35708da9
    resource: repo://supabase/migrations/0156_conditional_numbing_notes.sql
  - id: openwiki-source-d145251a83e89a782599d858
    resource: repo://supabase/migrations/0182_sterile_item_discard_lifecycle.sql
  - id: openwiki-source-b27ced57aade076f07abb176
    resource: repo://tests/db/probe-inventory-linkage.db.test.ts
  - id: openwiki-source-1ee7a7ace5306ea40f92a98e
    resource: repo://tests/db/sterile-item-discard-lifecycle.db.test.ts
generated: { by: "claude-code", at: "2026-10-02T22:34:57.394Z" }
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T22:34:57.394Z
---

# Probes, treatment settings and record keeping

This page covers what is recorded about **how** a treatment was performed and the studio's safety logbooks. The
recurring question is **where each rule is enforced**: Hone keeps the database permissive for clinical free text
and legacy rows, and puts most vocabulary rules in server-side validation.

Known limitation **L16** records this posture. Treatment-area and probe-lot validation is application-layer only,
except for the inventory link's real foreign key
([`known-limitations.md` § L16 — DB-level charting constraints are deferred](../../docs/production/known-limitations.md#l16--db-level-charting-constraints-are-deferred)).

| Rule | Database | Application only |
|---|---|---|
| probe catalog combination (brand, material, piece, shank, size, length) | — | ✓, validated against `lib/probes.ts` |
| sterile-item `probe_key` length ≤ 120 | ✓ `CHECK` | |
| linked inventory item belongs to the same studio | ✓ composite FK | ✓, re-validated server-side |
| linked item is a probe of the chosen type, has a lot, is unexpired or confirmed, and is not discarded | — | ✓ |
| `pulse_delay_seconds` within 0.03–1.90 | ✓ `CHECK` | |
| pulse delay only when `pulse_count > 1` | — | ✓ |
| `observation_chips` is a JSON array | ✓ `CHECK` | |
| chip labels come from the canonical vocabulary | — | ✓ |
| numbing note kept only when numbing was used; trimmed; blank becomes NULL | — | ✓ (no DB length cap by design) |
| treatment-area vocabulary | — | ✓ (L16) |

## 1. Probes and machine settings

**The probe catalog is code, not data.** `lib/probes.ts` enumerates only the valid brand, material, piece-type,
shank, size and length combinations, so impossible probes cannot be chosen. Server actions validate the option key
and store the decomposed fields on `session_blocks`. Adding a brand is a code change, because the probe columns
carry no DB enum or check on their values ([L1-L25](../../lib/probes.ts#L1-L25)).

**Pulse delay** (`electrolysis_entries.pulse_delay_seconds`, `0102`) records the seconds between high-frequency
pulses as `numeric(4,2)`. A range check allows NULL or 0.03–1.90. The "only when more than one pulse" rule
belongs to the application ([`0102` L1-L42](../../supabase/migrations/0102_electrolysis_entry_pulse_delay.sql#L1-L42)).

**Numbing notes** (`session_blocks.numbing_notes`, `0156`) hold one optional note when numbing was used. The
application normalizes it, and the database deliberately imposes no check or length cap on clinical free text
([`0156` L1-L33](../../supabase/migrations/0156_conditional_numbing_notes.sql#L1-L33)).

Mode-gated readings, the retired galvanic intensity and the canonical-pass rule are covered on
[Treatment memory reads and point-of-care memory](memory-reads-and-point-of-care.md#3-point-of-care-memory).

## 2. Observation chips and reactions

**Chips are stored structurally.** `0108` replaced chips stored as comma text inside `comments`, which could
silently desync, with `electrolysis_entries.observation_chips`: a `jsonb` array, default `[]`, checked to be an
array. There was no backfill; legacy rows migrate only when they are next edited and saved
([`0108` L1-L37](../../supabase/migrations/0108_electrolysis_observation_chips.sql#L1-L37)).

**One unified box.** Observation chips and the legacy reaction labels now share one multi-select. A legacy
`session_blocks.reaction_type` is folded in on load and display, never lost
([`lib/observation-chips.ts`](../../lib/observation-chips.ts#L13-L30)).

**One reaction contract.** `reaction-unified.ts` is what every reaction-driven surface reads
([L1-L30](../../lib/sessions/reaction-unified.ts#L1-L30)):

- reactions are classified **only** by the explicit reaction-chip definitions, never by guessing from wording;
- severity uses the existing reaction enum order;
- safety-response labels rank through a declared coded peer.

## 3. Probe lots: inventory-backed linkage (`0155`)

**The canonical inventory is `record_keeping_sterile_items`.** The legacy `probe_lots` table and
`electrolysis_entries.probe_lot_id` are described as **dormant** ([`0155` L1-L25](../../supabase/migrations/0155_probe_inventory_chart_linkage.sql#L1-L25)).

Schema:

- `probe_key` on the inventory row is a structured classification, length-checked and never inferred from the
  description.
- `session_blocks.probe_inventory_item_id` is a **same-studio composite FK** to `(studio_id, id)` with
  `ON DELETE SET NULL (probe_inventory_item_id)`. Deleting an inventory row clears only the link; the block and
  its `probe_lot_number` **snapshot** survive ([L27-L82](../../supabase/migrations/0155_probe_inventory_chart_linkage.sql#L27-L82)).
- The atomic block commands carry the new column. A forged cross-studio id fails the FK and aborts the
  transaction ([L84-L156](../../supabase/migrations/0155_probe_inventory_chart_linkage.sql#L84-L156)).

**Server-side resolution** — `resolveProbeInventorySelection` ([`probe-inventory-validation.ts` L1-L130](../../lib/record-keeping/probe-inventory-validation.ts#L1-L130)):

- **Manual path:** there is no link, and the trimmed text is the snapshot.
- **Establishing or changing a link:** the item must exist in the caller's studio (an RLS-scoped read), be
  classified for the newly selected probe, have a non-blank lot, and pass the expired-lot and discarded-lot
  policies. The snapshot is **derived from the database row**, never from client text. An expired lot may be
  linked only with explicit confirmation.
- **Unchanged link on edit:** when the stored id and probe both match values loaded server-side, the frozen
  snapshot is kept **without** re-validation. A later inventory edit, reclassification, expiry or discard
  therefore never blocks re-saving a historical record.

**Choosing and suggesting lots:**

- Identity is the inventory row id, never the lot number; two records can share a lot number
  ([`probe-lot-inventory.ts` L1-L69](../../lib/record-keeping/probe-lot-inventory.ts#L1-L69)).
- **Current stock** means **not expired and not discarded**, defined once in `isCurrentStock`.
- Expired and discarded rows remain in the foundational read, so history still resolves. They are gated only at
  the current-stock boundary: chooser ordering and auto-fill.
- Auto-fill uses the **last confirmed linked** selection, tracked separately from the display winner. Its history
  fallback is recency-based ([`probe-lot-suggestion.ts`](../../lib/record-keeping/probe-lot-suggestion.ts#L1-L40)).

DB proof ([`probe-inventory-linkage.db.test.ts` L69-L316](../../tests/db/probe-inventory-linkage.db.test.ts#L69-L316)):

- the length backstop works;
- a same-studio link stores both the id and the snapshot;
- cross-studio and forged ids fail the FK, through the command and through a direct insert;
- editing the inventory lot does not rewrite snapshots, and deleting it nulls only the link;
- manual lots stay valid and RLS hides other studios;
- old-version payloads without the new key fabricate no link.

## 4. Sterile items: expiry and discard are separate lifecycles

**`0182` adds `record_keeping_sterile_items.date_discarded`.** It is a nullable date with no default and no check,
mirroring the column `record_keeping_disinfectants` already had. Before it, a practitioner who threw a box away
could only say so in free-text notes, and the box kept being counted as current stock. **Nothing infers a discard
from text** ([`0182` L1-L100](../../supabase/migrations/0182_sterile_item_discard_lifecycle.sql#L1-L100)).

The rule is "**current inventory is not historical record existence**":

- discarded stock raises no expiry warning and is never suggested or auto-filled;
- historical reads still return it in full — the record list, lot traceability, export and search.

Discarding is an ordinary member UPDATE. There is still **no DELETE policy** on these logbooks. The column-generic
record-keeping audit trigger records both discard and un-discard with old and new values.

[`sterile-item-discard-lifecycle.db.test.ts` L72-L501](../../tests/db/sterile-item-discard-lifecycle.db.test.ts#L72-L501)
proves:

- the column shape matches the disinfectant precedent;
- a session linked before a discard stays valid and resolvable after it, and traceability, the record list and
  the export still find the item;
- there is still no DELETE policy;
- cross-studio read, discard and un-discard are refused, with a positive control;
- both transitions are audited.

**Display tiers** are pure functions of a studio-local "today":

- sterile items are "expiring" within **30** days, and expired means strictly before today
  ([`expiry.ts` L1-L30](../../lib/record-keeping/expiry.ts#L1-L30));
- disinfectant batches are "due soon" within **7** days of their replace-by date, and an actually discarded batch
  never alerts.

These are computed displays; no reminder is sent.

## 5. The `/records` logbook surface

`/records` (`app/(app)/records/page.tsx`) is the studio's inspection-style logbook. It holds sterile items,
disinfectant batches and exposure incidents, and lets a practitioner mark a session's aftercare as explained.

**Writes** (`app/(app)/records/actions.ts`):

- **Tenancy.** Every action derives the studio from the session, never from the form, and writes through
  the user-scoped client, so `is_studio_member` RLS isolates studios end to end.
- **Operator.** A disinfectant operator chosen from the dropdown is resolved server-side as a same-studio
  active practitioner. Anything else, including a cross-studio id, falls back to a free-text "Other"
  operator.
- **Aftercare.** Marking aftercare explained calls the `set_session_aftercare_explained` command (`0167`).

**Exposure incidents** carry sensitive personal and health details. Since `0088`:

| Action | Who |
|---|---|
| File a new incident | any member |
| Read or edit incidents | owner only |
| Read exposure-incident audit rows | owner only |
| Delete | nobody (no policy) |

([`0088` L1-L28](../../supabase/migrations/0088_exposure_incident_owner_access.sql#L1-L28))

**Audit trail.** `record_keeping_audit_events` (`0086`) has a single studio-scoped SELECT policy and no
insert, update or delete policy for application users. Rows are written only by `SECURITY DEFINER`
trigger functions, which diff the row that fired them and resolve the actor from `auth.uid()`
([`0086` L10-L30](../../supabase/migrations/0086_record_keeping_audit_events.sql#L10-L30)).

**Reads.** `/records/print` is a read-only print view over the same query module, and disinfectant
discard status is computed at read time ([`disinfectant-status.ts`](../../lib/record-keeping/disinfectant-status.ts)).

## 6. Contradictions and open questions

1. **The "dormant" legacy lot id is still writable through a live action.**
   - `0155` and `0156` call `electrolysis_entries.probe_lot_id` and `probe_lots` dormant and untouched
     ([`0156` L24](../../supabase/migrations/0156_conditional_numbing_notes.sql#L24-L24)).
   - `addElectrolysisEntryAction` still reads a `probe_lot_id` form field, validates it against the legacy
     `probe_lots` table, and passes it to `add_electrolysis_pass`
     ([`sessions/[sessionId]/actions.ts` L305-L330](../../app/(app)/clients/[id]/sessions/[sessionId]/actions.ts#L305-L330)).
   - The mounted entry form never sends that field, and the only component that renders a legacy lot selector is
     imported nowhere. In practice the column stays NULL, but a direct POST could still set it to an own-studio
     legacy lot.
2. **Two logbooks record discard differently in practice.** Disinfectants had `date_discarded` from `0085`;
   sterile items gained it only in `0182`. Rows discarded before `0182` carry the fact only in notes, which nothing
   reads. That is a deliberate no-backfill decision, but historical sterile-item discards stay invisible to the
   current-stock gates until someone records them.
