---
type: integration
title: Google Calendar integration
description: Hone's one-way (Hone → Google) calendar integration — its lifecycle state as recorded in the canonical documents (deployed, production-exercised, dormant), the gates an event must pass, owner OAuth with PKCE and least-privilege destination scopes, encrypted refresh tokens, the trigger-fed outbox, the lease-based worker behind a global switch, the stale fence, the reconciliation sweep and the fail-closed E2E fake.
tags: [google-calendar, oauth, outbox, worker, reconciliation, integrations]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-59a4101c8233cafbae5f4713
    resource: repo://app/api/cron/calendar-sync/route.ts
  - id: openwiki-source-e8dbe634448c27d54260ed52
    resource: repo://app/api/google-calendar/oauth/callback/route.ts
  - id: openwiki-source-723c675bbe2438236148b868
    resource: repo://docs/production/current-state.md
  - id: openwiki-source-0a7f1727d82c9ac5dce569e4
    resource: repo://docs/production/known-limitations.md
  - id: openwiki-source-455372086964b57969c8f3ec
    resource: repo://lib/google-calendar/config.ts
  - id: openwiki-source-ed69249f11682ffeb149722b
    resource: repo://lib/google-calendar/e2e/fake-google-guard.ts
  - id: openwiki-source-d7d95743363223d4a8ba4000
    resource: repo://lib/google-calendar/oauth.ts
  - id: openwiki-source-da70255f690f091091466ea5
    resource: repo://lib/google-calendar/sync/pg-refresh-coordinator.ts
  - id: openwiki-source-907500d4193fbbf16489b7be
    resource: repo://lib/google-calendar/sync/reconcile-lock.ts
  - id: openwiki-source-ac054d35bb0065143f00b884
    resource: repo://lib/google-calendar/sync/reconcile.ts
  - id: openwiki-source-788143696ea896b9e8f3be1c
    resource: repo://lib/google-calendar/sync/stale-fence.ts
  - id: openwiki-source-445db77f6133bc90eff72f60
    resource: repo://lib/google-calendar/sync/token-manager.ts
  - id: openwiki-source-f2954752193b3b0e4e5ca0ef
    resource: repo://lib/google-calendar/sync/worker-runtime.ts
  - id: openwiki-source-1a3393d5b86b0fccb573ab62
    resource: repo://lib/google-calendar/token-crypto.ts
  - id: openwiki-source-4b6691fe4ac2a597e5d3fd50
    resource: repo://supabase/migrations/0121_google_calendar_connection_foundation.sql
  - id: openwiki-source-a3599a64b0c47e7918008920
    resource: repo://supabase/migrations/0125_google_calendar_outbound_enqueue_activation_boundary.sql
  - id: openwiki-source-8f1ef21890526c67aee90fd7
    resource: repo://supabase/migrations/0131_google_calendar_dual_destination.sql
  - id: openwiki-source-339e9809c330eba4d8b121fe
    resource: repo://supabase/migrations/0132_google_calendar_event_link_transitions.sql
  - id: openwiki-source-55831e92f29f8b3e9d43f58b
    resource: repo://vercel.json
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Google Calendar integration

The integration pushes Hone appointments **out** to a Google calendar owned by the studio. Inbound busy-time
import and two-way edits are designed but **not built**. Everything outbound is built and deployed, and it is
gated by several independent switches.

## 1. Lifecycle state

This page restates no production counts or dates; the records hold them
([`current-state.md` § 9. Google Calendar](../../docs/production/current-state.md#9-google-calendar),
[`known-limitations.md` § L6](../../docs/production/known-limitations.md#l6--google-calendar-is-deployed-and-dormant-exercised-exactly-once)).

| Dimension | State |
|---|---|
| Migrations (`0121`–`0132`) | **DB applied** |
| Application | **deployed** |
| Production exercised | **yes**, only by a controlled validation on the controlled-test studio; the real-customer studio is **not connected** |
| Enabled | **no**: every outbound, inbound-busy and two-way studio flag is off and the worker switch is off |
| Cron | `calendar-reconcile` and `calendar-sync` are registered and run daily ([`vercel.json` L7-L14](../../vercel.json#L7-L14)), finding no eligible studio and no claimable job |

The record requires **separate authorization** for each of: connecting the real-customer studio, enabling any
outbound flag, enabling the worker, and starting inbound or two-way work.

## 2. Gates an event must pass to reach Google

1. **Studio flags** (`0121`): `google_calendar_connection_enabled`, `google_calendar_outbound_sync_enabled`,
   `google_calendar_inbound_busy_enabled` and `google_calendar_two_way_updates_enabled` on `studios`, all default
   false ([`0121` L55-L58](../../supabase/migrations/0121_google_calendar_connection_foundation.sql#L55-L58)).
2. **Connection readiness** (`calendar_connection_outbound_ready`, latest definition `0131`): the studio's
   outbound flag, a `connected` connection owned by the studio-calendar owner, a write calendar and destination
   mode, granted scopes that contain what the destination requires, and an encrypted refresh token
   ([`0131` L148-L170](../../supabase/migrations/0131_google_calendar_dual_destination.sql#L148-L170)).
3. **Global worker switch**: the single-row `calendar_sync_control.worker_enabled`, default **false**, readable and
   updatable only by `service_role` ([`0125` L108-L119](../../supabase/migrations/0125_google_calendar_outbound_enqueue_activation_boundary.sql#L108-L119)).
   While it is false or absent, `claim_calendar_sync_op` returns zero rows and mutates nothing
   ([`0125` L429-L452](../../supabase/migrations/0125_google_calendar_outbound_enqueue_activation_boundary.sql#L429-L452)).

## 3. Connecting a studio (OAuth)

- **No `googleapis` dependency**: OAuth and Calendar REST are hand-built `fetch` calls
  ([`config.ts` L7-L24](../../lib/google-calendar/config.ts#L7-L24)).
- **Scopes.** The initial connect requests only `openid`, `userinfo.email` and `calendar.calendarlist.readonly`.
  The event scope comes from the chosen destination: `calendar.app.created` for a Hone-created dedicated calendar,
  `calendar.events.owned` for an existing owned calendar. Broad `calendar.events` is requested nowhere
  ([`config.ts` L51-L83](../../lib/google-calendar/config.ts#L51-L83)).
- **Authorization URL**: `access_type=offline`, `include_granted_scopes=true`, PKCE `S256` and a server-minted
  `state` ([`oauth.ts` L27-L84](../../lib/google-calendar/oauth.ts#L27-L84)). The redirect URI is built server-side,
  never from request headers ([`config.ts` L85-L91](../../lib/google-calendar/config.ts#L85-L91)).
- **Callback** ([`oauth/callback/route.ts` L60-L140](../../app/api/google-calendar/oauth/callback/route.ts#L60-L140)):
  requires a signed-in user, consumes the single-use state bound to that user, re-checks that the practitioner is
  active in the studio, exchanges the code with the PKCE verifier, and refuses insufficient scope, a different
  Google account than the existing connection, or a changed destination.
- **Secrets at rest**: the refresh token and PKCE verifier are encrypted with AES-256-GCM under a dedicated
  `GOOGLE_TOKEN_ENCRYPTION_KEY`, in a versioned format that allows rotation; every failure returns `{ok:false}`
  without throwing or logging ([`token-crypto.ts` L1-L30](../../lib/google-calendar/token-crypto.ts#L1-L30)).

## 4. Outbound pipeline

```
appointments INSERT/UPDATE (starts_at, ends_at, status, sync_version) / DELETE
   └─ appointments_zzz_outbound_enqueue_trg → enqueue_calendar_outbound (0125, redefined 0132)
        └─ only if calendar_connection_outbound_ready(...) → calendar_sync_outbox row
              └─ /api/cron/calendar-sync → handleWorkerRoute → claim_calendar_sync_op
                   (worker_enabled gate, FOR UPDATE SKIP LOCKED, lease, claim token)
                   → stale fence → Google REST → record result → calendar_event_links
```

- **Enqueue** is a trigger on `appointments` after insert or update of `starts_at`, `ends_at`, `status` or
  `sync_version`, plus a delete trigger and a `sync_version` bump trigger
  ([`0125` L60-L95](../../supabase/migrations/0125_google_calendar_outbound_enqueue_activation_boundary.sql#L60-L95),
  [L323-L380](../../supabase/migrations/0125_google_calendar_outbound_enqueue_activation_boundary.sql#L323-L380)).
  `0132` added `calendar_event_link_transition` and redefined the enqueue functions
  ([`0132` L26-L430](../../supabase/migrations/0132_google_calendar_event_link_transitions.sql#L26-L430)).
- **Worker** (`lib/google-calendar/sync/worker-runtime.ts`): the route authenticates with the cron secret, refuses
  unexpected query parameters, and claims at most three batches of five jobs, admitting new jobs only within a
  50-second window under a 180-second function ceiling ([L51-L71](../../lib/google-calendar/sync/worker-runtime.ts#L51-L71),
  [L544-L603](../../lib/google-calendar/sync/worker-runtime.ts#L544-L603)). The claim RPC is the only work selector;
  the route never accepts a caller-chosen studio, connection or appointment.
- **Stale fence**: immediately before any Google call, a pure decision compares the claimed job's `sync_version`
  with the current appointment and link and yields `noop`, `conflict` or `proceed(create|update|delete)`; a
  placeholder link never counts as completion proof ([`stale-fence.ts` L1-L30](../../lib/google-calendar/sync/stale-fence.ts#L1-L30)).
- **Token refresh** is serialized per connection with a transaction-scoped Postgres advisory lock, and a rotated
  refresh token is encrypted and stored under that lock
  ([`pg-refresh-coordinator.ts` L1-L32](../../lib/google-calendar/sync/pg-refresh-coordinator.ts#L1-L32),
  [`token-manager.ts` L1-L30](../../lib/google-calendar/sync/token-manager.ts#L1-L30)).

## 5. Reconciliation sweep

`/api/cron/calendar-reconcile` is a bounded drift detector over existing database repair primitives: it never
calls Google and builds no enqueue path of its own, recovering changes made while intent was unavailable, within
intent-eligible studios only. Mutation safety is fail-closed (a per-studio lock, a global coordinator, a durable
cursor); observability is fail-open ([`reconcile.ts` L1-L35](../../lib/google-calendar/sync/reconcile.ts#L1-L35)).
The per-studio lock is an Upstash `SET NX EX` ownership-token lock, and a backend error is treated as "not free
to proceed" ([`reconcile-lock.ts` L1-L90](../../lib/google-calendar/sync/reconcile-lock.ts#L1-L90)).

Both calendar cron routes also run the reminder-scheduler health check (see
[Cron jobs, reminders and idempotency](../communications/cron-reminders-and-idempotency.md)).

## 6. Fake Google (E2E)

`HONE_E2E_FAKE_GOOGLE=1` plus a valid `HONE_E2E_RUN_ID` enables a fake provider and a local fake-authorize route;
the guard throws in any deployed runtime ([`fake-google-guard.ts` L27-L80](../../lib/google-calendar/e2e/fake-google-guard.ts#L27-L80)).
The suites live in `e2e-google/` with `playwright.google.config.ts`; see
[Browser E2E suites and provider fakes](../testing/browser-e2e-suites-and-fakes.md).

DB suites under `tests/db/` cover connection rules, OAuth state, outbound sync, the enqueue/claim activation
boundary, reconciliation, destination scopes, link transitions, the worker route, scope upgrade and token refresh;
unit suites under `tests/app/google-calendar/` and `tests/lib/google-calendar/` pin route dormancy and worker
behaviour.

## 7. Contradictions and open questions

1. **The `calendar-sync` route's own header is stale.** It says the route is "NOT cron-registered" and that the
   outbox is empty ([`calendar-sync/route.ts` L4-L23](../../app/api/cron/calendar-sync/route.ts#L4-L23)), while
   `vercel.json` registers the route and limitation L6 tells readers to correct documents that claim the outbox
   and links are empty.
2. **`docs/integrations/google-calendar-sync.md` carries a dated "VERIFIED RUNTIME STATUS" header**
   ([§ VERIFIED RUNTIME STATUS](../../docs/integrations/google-calendar-sync.md#verified-runtime-status--2026-07-27)) that
   is older than the canonical re-verification in `current-state.md`; treat it as design intent and history.
3. **Who may flip `worker_enabled`** has no product surface: the table grants `select, update` to `service_role`
   only, so enabling the worker is an out-of-band operator action, which the record says needs separate
   authorization.
