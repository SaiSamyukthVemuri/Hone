# 0300: upper bound for pre-0245 card history (PAY-006)

**Status: AUTHORED, NOT APPLIED (held).** `supabase/migrations/0300_card_setup_legacy_event_order_bound.sql`.
The hosted apply needs Sam's approval in his own words. This file is the proof that the
migration relies on. It is evidence and argument, not apply authority.

## The defect

0245 (applied 2026-10-27) made `save_client_card_on_file_ordered` refuse any
`setup_intent.succeeded` whose client already had, in the same mode, a
`client_payment_methods` row with `stripe_setup_success_event_created IS NULL`. It returned
`unknown_event_order` for that row whether it was active or removed. Every card saved
before 0245 has NULL there, because 0245 backfilled nothing. The webhook turns
`unknown_event_order` into a throw (`card_setup_active_event_order_unverified`), which gives
an HTTP 500. Stripe retries, and every retry gets the same answer. So no client with a
pre-0245 card in a given mode can ever save or replace a card in that mode again.

Live incident: a `setup_intent.succeeded` created about 2026-11-04 15:53Z failed twice with
exactly this error. No card was written and no notice was sent.

## The bound

**Claim.** Take any NULL-evidence row `L` with `added_via = 'portal'`. Let `E_L` be the
success event of the SetupIntent that `L` stores. Then
`E_L.created <= ceil(epoch(L.created_at)) + margin`.

**Proof.**
1. `L` was written by one of the two webhook writers, W1 or W2 (see the table below). Each
   ran *inside the handler for `L`'s own `setup_intent.succeeded`*.
2. Stripe stamps `event.created` before it delivers the event. The handler received the
   event before it opened the insert transaction. `created_at` defaults to `now()`, which is
   the start time of that transaction, and neither writer sets the column. So
   `E_L.created <= L.created_at` in true time.
3. The two times come from different clocks: Stripe's for `event.created`, the DB host's
   for `created_at`. Both are NTP-disciplined. `event.created` is truncated to whole
   seconds, and `ceil` covers that. The margin covers the skew between the two clocks.
4. No path changes `created_at` after insert (table below), and retiring a card preserves
   it. So the bound still holds today for removed rows.

**Use.** Take every NULL row of the (studio, client, mode). A success event with
`p_success_event_created` **strictly greater** than the largest bound among them is provably
newer than every legacy card. It then goes through 0245's known-evidence logic unchanged:
stale, ambiguous, idempotent, and then the 0180 insert.

Everything else that 0245 refused is still refused with `unknown_event_order`:

- events at the bound, inside the margin, or older than a legacy row. The legacy event's
  time is only bounded *above*, so these cannot be ordered against it, and they are not
  called `stale_event` (terminal) either;
- a redelivery for the legacy row's own SetupIntent;
- any NULL row whose `added_via` is not `'portal'`, because no audited writer produced
  such a row.

Legacy rows are never rewritten. Nothing is backfilled, and no evidence is fabricated.

## The margin: 900 s

- **What it absorbs.** Stripe-vs-DB clock skew between two NTP-disciplined fleets, which is
  sub-second in normal operation. 900 s is about three orders of magnitude above that.
  Whole-second truncation is handled separately by `ceil`.
- **What it costs.** Nothing in practice. 0245 closed the last NULL writer at apply on
  2026-10-27, so every legacy row is at least 8 days older than any live event today. A
  larger margin, even a day, would also cost nothing. A smaller one gains nothing.
- **Inside the margin.** The event is refused exactly as under 0245 (`unknown_event_order`,
  so the webhook returns 500 and Stripe retries). That outcome is a refusal, never a write.
  An event at exactly `bound` is refused. `bound + 1` is the first second admitted.

## Writer enumeration: every path that ever wrote `client_payment_methods`

Searched: every migration from 0058 onward, the current tree, and full git history
(`git log --all -S'client_payment_methods' --name-only`, plus `-p -G` over app, lib,
scripts, components, supabase/functions and middleware).

| # | Writer | Era | Writes | `created_at` | After its own success event? | Evidence |
|---|---|---|---|---|---|---|
| W1 | Webhook `setup_intent.succeeded`, direct PostgREST `.insert({...})` (service role), `app/api/stripe/webhook/route.ts` | 0058 (PR #135) until 0180 | INSERT: no `created_at`/`added_at` key, `added_via: "portal"` | default `now()` | **Yes.** Inside the handler for that event | NULL (column did not exist) |
| W1r | Same handler, pre-flip `.update({ status: "removed", removed_at })` | 0058 until 0180 | UPDATE: status, removed_at | preserved | n/a | unchanged |
| W2 | `save_client_card_on_file` (0180), called only by the same webhook handler | 0180 until 0245 | INSERT: explicit column list has no `created_at`, `added_via` hard-coded `'portal'`; retire UPDATE sets `status`, `removed_at` | default `now()` | **Yes.** Same handler | NULL |
| W3 | `save_client_card_on_file_ordered` (0245, and 0300) | 0245 onward | calls W2 privately, then sets the evidence pair on the new row **in the same transaction** | default `now()` | yes | **never NULL at commit** |
| U1 | 0077 migration backfill | apply of 0077 | UPDATE `card_authorization_signature_id` on active rows only | preserved | n/a | unchanged |
| U2 | `lib/payment-methods/refresh-card-authorization-pointer.ts` | current | UPDATE `card_authorization_signature_id` only | preserved | n/a | unchanged |
| T1 | `tg_client_payment_methods_set_updated_at` (0058) BEFORE UPDATE trigger | always | sets `updated_at` only | preserved | n/a | unchanged |
| D1 | `on delete cascade` from studios and clients | always | deletes the row, which leaves no row to order against | n/a | n/a | n/a |
| X | `e2e/helpers/seed.ts`, `tests/**`, `rehearsal/**` seeds (`REHEARSAL - NEVER MERGE`) | local and rehearsal only | INSERT, sometimes with explicit timestamps | n/a: never against production (`e2e/helpers/local-env.ts` refuses non-loopback targets) | n/a | n/a |

Not writers, checked and excluded: 0059, 0064, 0073, 0103 and 0104 (indexes, FKs and
comments); 0214, 0257 and 0270 (read-only `exists` and a pinned table-name list); 0254
(policy comment); 0255 (`alter function ... set search_path` on the trigger function);
0288 (held, not on production; no write); `scripts/verify-production.mjs` (a read-only
`select`); every other app read (`.select`).

**Answers to the specific questions.**
- **Is `created_at` ever written explicitly?** No production writer does. W1's object
  literal and W2's column list both omit it. The only explicit `created_at` writes are the
  local and rehearsal seeds (row X).
- **Is a removed row's `created_at` preserved?** Yes. W1r and W2's retire set only `status`
  and `removed_at`, and T1 sets only `updated_at`. This is pinned by
  `tests/db/card-legacy-event-order-bound.db.test.ts`, which checks the exact set of columns
  the retire changes: `removed_at`, `status`, `updated_at`.
- **Does anything re-activate a removed row?** No path sets `status = 'active'` on an
  existing row. Reactivation would not break the bound anyway, because the bound depends
  only on `created_at`.
- **Can a NULL row have been written after 0245?** No: 0245 revokes EXECUTE on
  `save_client_card_on_file` (W2) from `public, anon, authenticated, service_role` by name,
  so only the definer-owned ordered command can reach it, and that command stamps evidence
  in the same transaction. The table's own grants are a separate gap: **0245 did not revoke
  table INSERT from `service_role`**, which can still insert through PostgREST, bypassing
  RLS. No code path does so, and none has since 0180 (W1 was the last direct insert), but
  that rests on code history, not on privilege. Rows not attested by the writers (any
  `added_via` other than `'portal'`) therefore keep 0245's refusal. A manual, operator-SQL
  insert that set `added_via = 'portal'` and backdated `created_at` would defeat the bound.
  None is recorded in `docs/production`, but no technical control excludes one. Closing
  the table INSERT grant is a separate follow-up and is not in this change.

## What is preserved

Same signature, grants re-stated by name (revoke from `public, anon, authenticated,
service_role`, then grant `service_role`), the same advisory and row locks, and the same
lineage refusals. The unique success-event index is untouched. The `idempotent`,
`stale_event` and `ambiguous_event_order` paths and exactly-once insertion are unchanged,
and the deployed app needs no change. Outside the legacy block, the function body is 0245's
bytes. `tests/migrations/0300-card-setup-legacy-event-order-bound.test.ts` pins this.

## Rollback

Held file `supabase/rollbacks/0300_card_setup_legacy_event_order_bound.down.sql`. It is a
forward migration whose function body is 0245's, byte for byte (pinned by the same test).
It re-arms the 0245 refusal. Like any migration, applying it needs its own approval.

## Follow-up, deliberately not in this change

The webhook throws on `unknown_event_order`, so a refusal that is permanent keeps returning
500 until Stripe stops retrying, about 3 days after the event. Two cases are permanent: an
event older than a legacy row, and any untrusted NULL row. Making those terminal, with an
operator-visible notice, is an app change for a separate ticket.
