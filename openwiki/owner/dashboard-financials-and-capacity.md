---
type: product surface
title: Dashboard, financials and owner capacity
description: The practitioner dashboard (today workflow, prep memory, next actions) and the two owner-only business surfaces (/dashboard/capacity and /financials) — what each reads, why their owner gates are application-layer rather than database boundaries, how failed reads are kept distinct from empty results, and their dated production status.
tags: [dashboard, owner-surfaces, financials, capacity, read-failure-semantics, notifications]
sources:
  - id: openwiki-source-511b7b2eafa46cc21ac26a71
    resource: repo://app/(app)/dashboard/capacity/page.tsx
  - id: openwiki-source-c9369bcb67f369529ea94cbc
    resource: repo://app/(app)/dashboard/page.tsx
  - id: openwiki-source-309a8602b4dd050c9d508d06
    resource: repo://app/(app)/financials/page.tsx
  - id: openwiki-source-723c675bbe2438236148b868
    resource: repo://docs/production/current-state.md
  - id: openwiki-source-b6c91ce4e719c09baa112e01
    resource: repo://lib/dashboard/owner-capacity.ts
  - id: openwiki-source-39ff1435f215b6459f6181c2
    resource: repo://lib/finance/financial-briefing.ts
  - id: openwiki-source-27be4c326c9664b4a0a3e12a
    resource: repo://lib/finance/financial-fact.ts
  - id: openwiki-source-ec4cb5f84e870ea32b221fee
    resource: repo://lib/notifications/practitioner-notifications.ts
  - id: openwiki-source-588d895653ec97ca3237bc90
    resource: repo://supabase/migrations/0154_practitioner_notifications_dedupe_key.sql
generated: { by: "claude-code", at: "2026-10-02T22:34:57.394Z" }
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T22:34:57.394Z
---

# Dashboard, financials and owner capacity

Three read surfaces sit on top of the scheduling and treatment-memory data. None of them writes
business data; their correctness questions are **who may see an aggregate** and **how a failed
read is presented**.

## 1. The practitioner dashboard (`/dashboard`)

`app/(app)/dashboard/page.tsx` (≈1,700 lines) composes the
day: roster and current appointment, before-today treatment previews and prep summary
(see [Treatment memory reads](../treatment-memory/memory-reads-and-point-of-care.md)), day next
action, clients needing attention, practice metrics, the missing-records assistant, payment state
per appointment, pinned notes for the selected day's clients (see
[Clinical, pinned and personal notes](../treatment-memory/clinical-notes-and-client-notes.md)), and
onboarding/getting-started signals
(`app/(app)/dashboard/page.tsx` L36-L111). Independent reads run in
`Promise.all` batches and part of the page streams behind a `Suspense` boundary
(`app/(app)/dashboard/page.tsx` L286, L908-L926).

**Three states, never two.** Card and prep reads distinguish *answered*, *nothing to ask* and
*unavailable*: a failed read renders a neutral "unavailable" state and never a "no history" or
"no payment" claim; a payment state defaults to `unavailable`, not to "unpaid"
(`app/(app)/dashboard/page.tsx` L136-L145, L996-L1035, L849). The clinical "unavailable" copy is shared
with the client profile so the two surfaces cannot drift
(`app/(app)/dashboard/page.tsx` L1220-L1240).

## 2. Owner capacity (`/dashboard/capacity`)

Answers one owner question — which active treatment clients have fallen off the calendar (the
re-book worklist) — from one snapshot read rooted on current non-archived clients.

- **Owner gate before any read.** The page refuses in place when `practitioner.role !== "owner"`,
  before `getOwnerCapacityBriefing` runs (`app/(app)/dashboard/capacity/page.tsx` L12-L46).
- **Not a database boundary.** RLS on `clients`, `treatment_plans` and `appointments` is
  `is_studio_member`, so any practitioner can already select the underlying rows; the module
  decides only who is *shown* the aggregate ([`owner-capacity.ts` L31-L37](../../lib/dashboard/owner-capacity.ts#L31-L37)).
- Missing figures carry a reason (`Fact<T>` with a string reason in `owner-capacity-model.ts`).
- DB proof of the snapshot semantics: [`tests/db/owner-capacity.db.test.ts`](../../tests/db/owner-capacity.db.test.ts).

## 3. Financials (`/financials`, FIN-01A slice 1)

Answers: what the calendar held in one studio-local period and how those appointments divided
(still to happen, completed, cancelled, no-show). **No money arithmetic yet.**

- `loadFinancialsView` refuses on role **before constructing a Supabase client**, so a practitioner
  who types the URL causes no studio-wide query; the route is unadvertised (no nav entry, excluded
  from search) and `force-dynamic` — financial truth is never cached
  (`app/(app)/financials/page.tsx` L10-L60).
- One read projecting `status, starts_at` for the period, bounded by the API page size, and again
  explicitly **not** a database boundary — RLS on `appointments`, `payment_charge_attempts` and
  `appointment_settlements` is `is_studio_member`
  ([`financial-briefing.ts` L15-L49](../../lib/finance/financial-briefing.ts#L15-L49)).
- **Unknown is a closed vocabulary**: `not_recorded`, `unavailable`, `unknowable`,
  `not_yet_supported`, `not_enumerable`; `known(0)` is the only path by which a zero can render, so a
  failed read shows its cause rather than a zero ([`financial-fact.ts` L35-L90](../../lib/finance/financial-fact.ts#L35-L90)).
- The next slices are **designed, not implemented**: the domain contract defines four money classes,
  eight payment states (UNKNOWN among them), separate time concepts and a versioned settlement store
  ([`docs/product/financials-domain-contract.md`](../../docs/product/financials-domain-contract.md));
  settlement storage itself exists from migration `0187` (see
  [Payments, Stripe and appointment settlement](../payments/stripe-payments-and-settlement.md)).

## 4. Practitioner notifications

[`lib/notifications/practitioner-notifications.ts`](../../lib/notifications/practitioner-notifications.ts#L1-L30)
is the single writer to `practitioner_notifications` (`0070`). Public booking, cancel, reschedule
and intake events cannot satisfy member RLS, so it writes through the service role with every field
derived from already-committed rows and an event-type allowlist; it is fire-and-forget and never
throws into the caller. Migration `0154` added a nullable `dedupe_key` with a partial unique index on
`(studio_id, dedupe_key)` so a repeated event inserts once
([`0154` L15-L36](../../supabase/migrations/0154_practitioner_notifications_dedupe_key.sql#L15-L36)).
Disinfectant/sterile-item alerts are computed at read time (see
[Probes, settings and record keeping](../treatment-memory/probes-settings-and-record-keeping.md)).

## 5. Production status (dated)

| Surface | Status | Authority |
|---|---|---|
| `/dashboard/capacity` (OWNER-CAP) | implemented · merged · deployed · enabled for owners of every studio; **not production-exercised as a measured fact**; slices 2 and 4 not started | [`current-state.md` § 10b. Owner business surfaces (OWNER-CAP)](../../docs/production/current-state.md#10b-owner-business-surfaces-owner-cap) |
| `/financials` (FIN-01A slice 1) | implemented · merged · deployed · owner-only; **not production-exercised as a measured fact**; no migration, no RPC | [`current-state.md` § Owner financial truth surface](../../docs/production/current-state.md#owner-financial-truth-surface--fin-01a-slice-1-pr-646) |

## 6. Contradictions and open questions

1. **Owner-only is a presentation boundary.** Both owner surfaces state that the database lets every
   studio practitioner read the underlying appointments, plans and payment rows; any feature that
   assumes "owner-only" data protection needs a database change first (the code says so explicitly;
   no document claims otherwise, but callers should not infer database enforcement from the route).
2. **The financials read is bounded by one API page.** `API_PAGE_SIZE = 1_000` is documented as the
   per-request cap from `supabase/config.toml`
   ([`financial-briefing.ts` L50-L51](../../lib/finance/financial-briefing.ts#L50-L51)); the hosted
   project's cap is not recorded in the repository, so how a period with more appointments than the
   cap is reported depends on `financial-briefing-model.ts`'s truncation handling rather than on a
   verified hosted setting.
