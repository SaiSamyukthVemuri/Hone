---
type: integration subsystem
title: Google Calendar integration
description: Hone's one-way (Hone → Google) calendar integration — owner OAuth with PKCE and least-privilege destination scopes, encrypted refresh tokens, the appointment-triggered outbox, the lease-based worker gated by a global switch, the reconciliation sweep, and its dated production status (deployed, exercised once, dormant).
tags: [google-calendar, oauth, outbox, worker, reconciliation, token-encryption, dormant]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
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
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# Google Calendar integration

The integration pushes Hone appointments **out** to a Google calendar owned by the studio. Inbound
busy-time import and two-way edits are designed but **not built**. Everything outbound is built,
deployed and gated by several independent switches, all of which are off for every real studio.

## 1. Status first (dated, with authority)

| Dimension | State | Authority |
|---|---|---|
| Migrations (`0121`–`0132`) | **DB applied** | ledger / current-state |
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L878-L906] heading anchor "L878-L906" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
| Application | **Deployed** | [`current-state.md` L878-L906](../../docs/production/current-state.md#L878-L906) |
| Connections | one, on the **controlled test studio only** (connected 2026-07-12); the real-customer studio is **not connected** | same |
<!-- openwiki: broken internal link [../../docs/production/known-limitations.md#L156-L166] heading anchor "L156-L166" does not exist in "../../docs/production/known-limitations.md". Fix the href or restore the target, then delete this comment. -->
| Production exercised | **exactly once**: one outbound event created 2026-07-18 on the test studio (one `calendar_sync_outbox` row `done`, one `calendar_event_links` row `synced`) | same; [`known-limitations.md` L156-L166](../../docs/production/known-limitations.md#L156-L166) (L6) |
| Enabled | **No** — every outbound / inbound-busy / two-way studio flag false everywhere (re-verified 2026-08-23); worker switch off | same |
| Cron | `calendar-reconcile` (`0 9 * * *`) and `calendar-sync` (`30 9 * * *`) **registered and running daily**, finding no eligible studio and no claimable job | same; [`vercel.json` L7-L14](../../vercel.json#L7-L14) |

Each of the following needs **separate authorization**: connecting the real-customer studio,
enabling any outbound flag, enabling the worker, and starting inbound/two-way work.

## 2. Gates that must all be open for an event to reach Google

1. **Studio flags** (`0121`): `google_calendar_connection_enabled`,
   `google_calendar_outbound_sync_enabled`, `google_calendar_inbound_busy_enabled`,
   `google_calendar_two_way_updates_enabled` on `studios`
   ([`0121` L55-L58](../../supabase/migrations/0121_google_calendar_connection_foundation.sql#L55-L58)).
2. **Connection readiness** (`calendar_connection_outbound_ready`, latest definition `0131`): the
   studio's outbound flag, a `connected` connection owned by the studio-calendar owner, a write
   calendar and destination mode, the granted scopes containing the scopes that destination
   requires, and an encrypted refresh token
   ([`0131` L148-L170](../../supabase/migrations/0131_google_calendar_dual_destination.sql#L148-L170)).
3. **Global worker switch**: the single-row `calendar_sync_control.worker_enabled`, default
   **false**, readable/updatable only by `service_role`
   ([`0125` L108-L119](../../supabase/migrations/0125_google_calendar_outbound_enqueue_activation_boundary.sql#L108-L119)).
   While it is false or absent, `claim_calendar_sync_op` returns zero rows and mutates nothing
   ([`0125` L429-L452](../../supabase/migrations/0125_google_calendar_outbound_enqueue_activation_boundary.sql#L429-L452)).

## 3. Connecting a studio (OAuth)

- **No `googleapis` dependency**: OAuth and Calendar REST are hand-built `fetch` calls
  ([`config.ts` L7-L24](../../lib/google-calendar/config.ts#L7-L24)).
- **Scopes:** the initial connect requests only `openid`, `userinfo.email` and
  `calendar.calendarlist.readonly`; the event scope is derived from the chosen destination —
  `calendar.app.created` for a Hone-created dedicated calendar, `calendar.events.owned` for an
  existing owned calendar — and broad `calendar.events` is requested nowhere
  ([`config.ts` L51-L83](../../lib/google-calendar/config.ts#L51-L83);
  [`destination-scopes.ts`](../../lib/google-calendar/destination-scopes.ts)).
- **Authorization URL:** `access_type=offline`, `include_granted_scopes=true`, PKCE `S256`, a
  server-minted `state`, `prompt=consent` only when forced
  ([`oauth.ts` L27-L84](../../lib/google-calendar/oauth.ts#L27-L84)). The redirect URI is fixed
  server-side, never derived from request headers ([`config.ts` L85-L91](../../lib/google-calendar/config.ts#L85-L91)).
- **Callback** ([`oauth/callback/route.ts`](../../app/api/google-calendar/oauth/callback/route.ts#L60-L140)):
  requires a signed-in user, consumes the single-use state (hash, expiry, nonce cookie, same user),
  re-checks that the practitioner is active in that studio, exchanges the code with the PKCE
  verifier, refuses insufficient scope, a different Google account than the existing connection, or
  a changed destination.
- **Secrets at rest:** refresh token and PKCE verifier are encrypted with AES-256-GCM under a
  dedicated `GOOGLE_TOKEN_ENCRYPTION_KEY`, in a versioned `v1:<keyVersion>:<iv>:<tag>:<ct>` format
  to allow rotation; every failure returns `{ok:false}` without throwing or logging
  ([`token-crypto.ts` L1-L30](../../lib/google-calendar/token-crypto.ts#L1-L30)). Secrets live in a
  separate `calendar_connection_secrets` table ([`0121` L148](../../supabase/migrations/0121_google_calendar_connection_foundation.sql#L148-L148)).

## 4. Outbound pipeline

```
appointments INSERT/UPDATE (starts_at, ends_at, status, sync_version) / DELETE
   └─ trigger appointments_zzz_outbound_enqueue_trg → enqueue_calendar_outbound (0125, redefined 0132)
        └─ only if calendar_connection_outbound_ready(...)  → calendar_sync_outbox row
              └─ /api/cron/calendar-sync → handleWorkerRoute → claim_calendar_sync_op (worker_enabled gate,
                   FOR UPDATE SKIP LOCKED, 5-min lease, claim token) → stale fence → Google REST
                   → record_calendar_sync_result → calendar_event_links
```

- **Enqueue** is a trigger on `appointments` after insert or update of `starts_at`, `ends_at`,
  `status`, `sync_version`, plus a delete trigger, and a `sync_version` bump trigger
  ([`0125` L60-L95](../../supabase/migrations/0125_google_calendar_outbound_enqueue_activation_boundary.sql#L60-L95),
  [L323-L380](../../supabase/migrations/0125_google_calendar_outbound_enqueue_activation_boundary.sql#L323-L380)).
  `0132` added `calendar_event_link_transition` and redefined both enqueue functions
  ([`0132` L26-L430](../../supabase/migrations/0132_google_calendar_event_link_transitions.sql#L26-L430)).
- **Worker** (`lib/google-calendar/sync/worker-runtime.ts`): the route authenticates with the cron
  secret, refuses unexpected query parameters, then claims at most 3 batches of 5 jobs, admitting new
  jobs only during a 50 s window under a 180 s function ceiling
  ([L51-L71](../../lib/google-calendar/sync/worker-runtime.ts#L51-L71),
  [L544-L603](../../lib/google-calendar/sync/worker-runtime.ts#L544-L603)). The claim RPC is the only
  work selector; the route never accepts a caller-chosen studio, connection or appointment.
- **Stale fence:** immediately before any Google call a pure decision compares the claimed job's
  `sync_version` with the current appointment and link and yields `noop`, `conflict` or
  `proceed(create|update|delete)`; a placeholder link never counts as completion proof
  ([`stale-fence.ts` L1-L30](../../lib/google-calendar/sync/stale-fence.ts#L1-L30)).
- **Token refresh** is serialized per connection with a transaction-scoped Postgres advisory lock
  (`pg_advisory_xact_lock(hashtextextended('gcal_refresh:'||id))`); a rotated refresh token is
  encrypted and stored under the lock, and encryption failure fails closed
  ([`pg-refresh-coordinator.ts` L1-L32](../../lib/google-calendar/sync/pg-refresh-coordinator.ts#L1-L32),
  [`token-manager.ts` L1-L30](../../lib/google-calendar/sync/token-manager.ts#L1-L30)).

## 5. Reconciliation sweep (`/api/cron/calendar-reconcile`)

A bounded drift detector over existing DB repair primitives — it never calls Google and builds no
enqueue path of its own. It recovers changes made while intent was unavailable and first
activation, within intent-eligible studios only. Mutation safety is fail-closed (per-studio lock,
global coordinator, durable continuation cursor); observability is fail-open
([`reconcile.ts` L1-L35](../../lib/google-calendar/sync/reconcile.ts#L1-L35)). The per-studio lock
is an Upstash `SET NX EX` ownership-token lock
([`reconcile-lock.ts` L1-L90](../../lib/google-calendar/sync/reconcile-lock.ts#L1-L90)).

Both calendar cron routes also run the reminder-scheduler health check (see
[Cron jobs, reminders and idempotency](../communications/cron-reminders-and-idempotency.md)).

## 6. Fake Google (E2E)

`HONE_E2E_FAKE_GOOGLE=1` plus a valid `HONE_E2E_RUN_ID` enables a fake provider and a local
fake-authorize route; the guard throws in any deployed runtime
([`fake-google-guard.ts` L27-L80](../../lib/google-calendar/e2e/fake-google-guard.ts#L27-L80)), and
`getAuthorizeEndpoint()` returns the real Google endpoint unless the guard passes. Suites:
`e2e-google/` with `playwright.google.config.ts`; see
[Browser E2E suites and provider fakes](../testing/browser-e2e-suites-and-fakes.md).

## 7. Tests that pin the behaviour

DB suites under `tests/db/` cover connection rules, OAuth state, outbound sync, the enqueue/claim
activation boundary (`google-calendar-b2-3a-enqueue-claim`), reconciliation (`…-b2-3b-reconcile`),
destination scopes and provisioning (`…-b2-4-*`), link transitions (`…-c1-link-transition`), the
worker route (`…-c2-worker-route`), scope upgrade and token refresh. Unit suites under
`tests/app/google-calendar/` and `tests/lib/google-calendar/` pin route dormancy and worker
behaviour.

## 8. Contradictions and open questions

1. **The `calendar-sync` route's own header is stale.** It says the route is "NOT cron-registered
   (c3 owns scheduling)" and the outbox is empty
   ([`calendar-sync/route.ts` L4-L23](../../app/api/cron/calendar-sync/route.ts#L4-L23)); `vercel.json`
   registers it and the canonical record reports one outbox row.
2. **`docs/integrations/google-calendar-sync.md` carries a "VERIFIED RUNTIME STATUS — 2026-07-27"
<!-- openwiki: broken internal link [../../docs/integrations/google-calendar-sync.md#L10-L10] heading anchor "L10-L10" does not exist in "../../docs/integrations/google-calendar-sync.md". Fix the href or restore the target, then delete this comment. -->
   header** ([L10](../../docs/integrations/google-calendar-sync.md#L10-L10)) that is older than the
   canonical 2026-08-23 re-verification in `current-state.md`; treat it as design intent and history.
3. **Who may flip `worker_enabled`** is not represented by any product surface; the table grants
   `select, update` to `service_role` only, so enabling the worker is an out-of-band operator
   action, which the canonical record says requires separate authorization.
