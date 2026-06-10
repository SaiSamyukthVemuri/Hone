# 13 Backlog and decisions

## Decision log

Decisions are listed roughly in the order they were made. Each entry says **what was decided**, **why**, and **what the alternative was**.

### Explicit server-only dependency (PR #186, no migration)

**Decision (2026-06-10):** Declare `server-only@0.0.1` in `dependencies`. Twenty-three runtime server modules (billing, portal, consent, supabase admin client, calendar feed token helper, ops alerts, notifications, stripe setup-intent) use `import "server-only"` as a client-bundle boundary, but the package was absent from package.json and the lockfile; it resolved only through Next's internal vendored alias (`next/dist/compiled/server-only`). Relying on a Next internal for a security boundary is brittle: a Next upgrade that drops or renames the alias would weaken the boundary silently. `npm install server-only` added exactly one package.json line and one lockfile entry. The Vitest stub alias (`tests/stubs/server-only.ts`, PR #153) takes precedence over node_modules, so test resolution is unchanged. `tests/dependencies/server-only-explicit.test.ts` pins the declaration and spot-checks the boundary imports so dependency drift is caught by CI.

**Honest non-claims:** no runtime behavior change intended (the import resolved before and resolves now; the enforcement semantics are identical), no payment change, no Stripe change (gates unchanged from PR #185), no migration, no portal logic change, no calendar feed phase 2.

### localTimeString hour-24 normalization across ICU builds (PR #185, no migration)

**Decision (2026-06-10):** Normalize `lib/booking/tz.ts:localTimeString` so it never returns `24:xx`. Some ICU builds resolve Intl's `hour12: false` to the h24 hour cycle and render hour 0 as "24" ("24:30" for half past midnight); others resolve to h23 and render "00:30". Surfaced by the PR #184 CI run, whose runner ICU emitted 24:xx where dev machines emitted 00:xx (that failure was test-only and was normalized in the test helper at the time; this PR moves the normalization into the production helper where it belongs). A private `normalizeHour24` helper rewrites a leading `24:` to `00:` after formatting; `tzOffsetMinutes` already guarded the same quirk numerically (`if (hour === 24) hour = 0`). `localTimeString12h` (h12 cycle, midnight renders "12:30 AM") and `localDateString` (date-only) are unaffected, verified and pinned by test. `utcInstantFromLocal` untouched.

**Why it matters:** `localTimeString` feeds the calendar grid labels in `DayColumn.tsx` (where the string also flows into wall-time math, so "24:30" would parse as minute 1470 and misplace a midnight-adjacent block on an h24-cycle runtime), the dashboard roster, SMS templates, and practitioner-facing 24h surfaces. Production runs on whatever ICU Vercel's Node ships, not what dev machines ship.

**Honest non-claims:** no conversion logic change, no payment change, no Stripe change (gates unchanged from PR #184), no migration, no new dependency, no behavior change on h23-cycle runtimes for any time outside the midnight hour.

**Alternative considered:** forcing `hourCycle: "h23"` in the Intl options instead of post-formatting normalization. Rejected in favor of the string rewrite: the rewrite is unconditionally correct on every ICU regardless of how it interprets the option, and keeps the change shape identical to the numeric guard tzOffsetMinutes already uses.

### DST two-pass offset correction in utcInstantFromLocal (PR #184, no migration)

**Decision (2026-06-10):** Fix the one-hour DST conversion error in `lib/booking/tz.ts:utcInstantFromLocal`. The previous code sampled the timezone offset once, at the naive instant (the local string read as if it were UTC), and applied a single correction. When the naive and corrected instants straddle a DST transition, that sample is the pre-transition offset and the corrected instant lands an hour late. Empirical reproduction on Toronto spring-forward day 2026-03-08: `03:30` local stored as `08:30Z` and rendered back as `04:30`; `05:30` stored as `10:30Z` and rendered back as `06:30`. The fix re-samples the offset at the corrected instant and re-applies the correction when the two samples differ (two-pass). Normal days, already-correct DST-day times, and the fall-back ambiguous hour (resolves to the first, pre-transition occurrence) are byte-identical before and after the fix; all are pinned by `tests/lib/booking/tz-dst-two-pass.test.ts` (15 tests, real round-trip unit tests, not source-grep).

**Why it matters despite low pilot impact:** Willow's business hours never touch the broken window today, but `utcInstantFromLocal` underpins booking slots, blockouts, day-window queries (dashboard, calendar week/month), recurring break materialization, and QuickBook. Fixed before a second studio makes the window reachable.

**Documented edge convention (changed for nonexistent inputs only):** spring-forward gap times (the skipped `02:xx` hour, which never occurs on the wall clock) now map to the instant one hour BEFORE the wall-clock string (`02:30` -> `06:30Z`, renders `01:30`); the pre-fix code mapped them forward (`07:30Z`, renders `03:30`). Neither convention can round-trip an input that does not exist; the new behavior is pinned by test so any future change is a conscious decision.

**Honest non-claims:** no payment change, no Stripe change (gates unchanged from PR #183), no migration, no new dependency (tz.ts stays zero-dependency on Intl), no portal change, no calendar feed phase 2, no behavior change for any wall-clock time that actually exists.

**Alternative considered:** adopting a date library (luxon / date-fns-tz) for zone math. Rejected: the repo's zero-dependency Intl-based helpers are correct with the two-pass loop, the dependency would touch every booking surface for a one-function fix, and bundle cost is nonzero.

### Client portal session last_seen_at lazy-builder fix (PR #183, no migration)

**Decision (2026-06-09):** Fix the `last_seen_at` touch in `lib/portal/session.ts:getCurrentPortalSession`. The previous code was `void admin.from("client_portal_sessions").update({ last_seen_at: nowIso }).eq("id", data.id);` with a comment calling it fire-and-forget. Supabase/PostgREST builders are lazy thenables: without `await` or `.then(...)` no HTTP request is ever sent, so the actual behavior was never-fire and `last_seen_at` was never written. The fix appends `.then(onFulfilled, onRejected)` to the chain, which executes the request while keeping it un-awaited so a slow update never blocks the portal page render. The fulfilled arm inspects the PostgREST `{ error }` result (Supabase builders resolve with an error field rather than rejecting); the rejected arm covers transport-level throws. Both arms log a sanitized structured event `portal_session_last_seen_update_failed` carrying only the session id, error code/message, and a timestamp.

**Why `.then` instead of `await`:** the portal session resolver runs on every portal page render and gates the whole portal surface. `last_seen_at` is a best-effort metric; trading render latency for metric freshness is the wrong direction. The `.then` form keeps the original fire-and-forget intent while actually firing.

**What did NOT change:** session validity rules (hash lookup via `session_token_hash`, revoked/expired checks), token hashing (`lib/portal/tokens.ts`), login timing padding (`app/portal/login/actions.ts`), cookie attributes, RLS posture (the touch already ran through the admin client), schema (`last_seen_at timestamptz` from migration 0052 is unchanged; no migration). No payment, Stripe, SMS, or calendar-feed change; Stripe gates unchanged from PR #182.

**Honest non-claims:** no auth behavior change, no portal redesign, no new index on `last_seen_at` (diagnostic column, not a query path), no retry loop for failed touches (a missed touch self-heals on the next page view).

**Alternative considered:** a shared safe fire-and-forget helper for Supabase builders. Rejected for this PR: there is exactly one bare-void-builder call site in the repo (verified by grep across `lib/` and `app/`), so a helper would be speculative; the source-grep test pinning "no bare void builder in session.ts" guards the regression instead.

### Calendar feed token hash-at-rest, phase 1 (PR #182, migration 0079)

**Decision (2026-06-09):** Move the calendar feed route's credential check from raw-token equality to SHA-256 hash equality. Migration 0079 adds a nullable `practitioners.calendar_feed_token_hash` column, backfills it from existing raw tokens via `extensions.digest(...)`, adds a 64-hex-char CHECK + a partial unique index on it. The runtime feed route now hashes the URL token and looks up by `calendar_feed_token_hash`. Rotation writes BOTH the raw column and the hash for phase 1; phase 2 will null the raw column once the settings UI is refactored to stop rendering the URL from a refreshed page.

**Why:** `docs/13` security backlog flagged `Hashed practitioners.calendar_feed_token | Currently stored raw. DB compromise yields usable tokens.` PR #182 closes that gap for the runtime route + future rotations without breaking existing in-the-wild feed URLs. Expand-contract phasing keeps the rollout zero-downtime: migration applied first, backfilled hashes guarantee existing URLs resolve through the deploy boundary, raw column remains until phase 2.

**Migration 0079 (applied to prod 2026-06-09 BEFORE code merge):**

```sql
alter table public.practitioners
  add column if not exists calendar_feed_token_hash text;

update public.practitioners
   set calendar_feed_token_hash = encode(extensions.digest(calendar_feed_token, 'sha256'), 'hex')
 where calendar_feed_token is not null
   and calendar_feed_token_hash is null;

-- + practitioners_calendar_feed_token_hash_check (null OR ^[a-f0-9]{64}$)
-- + partial unique practitioners_calendar_feed_token_hash_uniq on (hash) WHERE hash IS NOT NULL
```

Verified in prod: 2 practitioners had raw tokens; both now have well-formed 64-hex hashes. Zero raw-without-hash rows, zero hash-without-raw rows. Live-mode CHECKs on payment tables (`manual_fee_charge_attempts_livemode_false_check`, `payment_charge_attempts_livemode_false_check`) intact.

**Architecture:**

- `lib/calendar-feed/token.ts` (new). Two exported functions: `generateCalendarFeedToken()` (32 bytes via `crypto.randomBytes` base64url-encoded, 256 bits entropy, 43 chars) and `hashCalendarFeedToken(token)` (SHA-256 hex, 64 lowercase chars). `import "server-only"`. The pgcrypto-compat tests pin the empty-string + `'abc'` NIST vectors so a future encoding drift is caught.

- `app/calendar-feed/[token]/route.ts` (extended). Imports `hashCalendarFeedToken`. The URL token is hashed BEFORE the practitioner SELECT. Lookup is now `.eq("calendar_feed_token_hash", tokenHash)`. The raw `calendar_feed_token` is no longer in the SELECT list, so a database read that leaks a row to logs does not include the raw bearer token. The hash is never echoed back to the client; the response is still ICS or a generic `Not found`. All other privacy / cache-control / window behaviour is unchanged (30-day backward window, `private, no-store, max-age=0, must-revalidate`, generic 404 on every lookup failure including malformed tokens shorter than 16 chars).

- `app/(app)/settings/profile/actions.ts` (extended). Imports the shared helpers. `rotateCalendarFeedTokenAction` writes BOTH `calendar_feed_token: token` AND `calendar_feed_token_hash: tokenHash` on the same UPDATE. The success return shape still carries only `{ ok: true, token }`; the hash is never returned to the browser. `clearCalendarFeedTokenAction` nulls BOTH columns.

**Phase 1 raw-column retention (deliberate):**

The settings UI (`app/(app)/settings/profile/CalendarFeedCard.tsx`) renders the existing feed URL by reading `practitioner.calendar_feed_token` on page render. Nulling the raw column in this PR would silently break that surface on the deploy boundary. Phase 1 keeps both columns populated; the migration documents this explicitly; the action's docblock and `tests/app/settings/profile/calendar-feed-rotation.test.ts:"the rotation action STILL writes calendar_feed_token (phase 1 transitional)"` test pin it so a future refactor cannot silently strip the raw write without also moving the UI off it.

**Phase 2 plan (separate PR, NOT in #182):**

1. Refactor `CalendarFeedCard.tsx` to display the URL only at rotation time. Page render shows "Calendar feed is enabled" without the URL.
2. The launch-page readiness check (`hasFeedToken`) switches to `calendar_feed_token_hash is not null` instead of reading the raw column.
3. New migration nulls every `calendar_feed_token` row in one UPDATE.
4. Subsequent migration drops the raw column + its partial unique entirely.

**Safety properties (phase 1):**

- Raw tokens are NEVER logged. Existing structured error logs carry only the Postgres error code.
- Hashes are NEVER returned to the browser. The route's response is ICS or a generic `Not found`. The rotation action's response carries only the raw token (which the caller already knows because they just minted it).
- The feed route's lookup column changed; the failure mode (generic 404) is unchanged whether the token is malformed, missing, has the wrong shape, or is well-formed but does not match any row. No timing-or-content side channel revealing partial matches.
- The DB CHECK on the hash column structurally refuses any non-`^[a-f0-9]{64}$` value, so a programmer error writing the wrong digest is caught.
- Existing in-the-wild feed URLs continue working because the backfill computed the same SHA-256 hex the runtime route now computes.

**What this PR does NOT do:**

- Does NOT enable live payments. No live-mode CHECK relaxed (verified post-migration via `pg_constraint`).
- Does NOT add any new Stripe SDK call site (`paymentIntents.create` stays at 2 allowlisted, `refunds.create` stays at 1 allowlisted, `charges.create`/`checkout.sessions` stay at 0, `STRIPE_ALLOW_LIVE_MODE=true` allowlist unchanged).
- Does NOT change payment behaviour. Receipt / refund / webhook reconciliation paths are unchanged.
- Does NOT touch `payment_charge_attempts` / `manual_fee_charge_attempts` runtime.
- Does NOT change RLS or add any new policy.
- Does NOT drop or null the raw `calendar_feed_token` column (phase 1 retention; see above).
- Does NOT change appointment / session workflows.
- Does NOT add SMS, email, or client-portal mutation.

**Alternative considered:** Drop the raw column in the same PR via a UI refactor that hides the URL on page render. Rejected: the UI refactor is non-trivial (`CalendarFeedCard.tsx` has 203 lines of state machine around Generate / Copy / Regenerate / Disable). Splitting it into phase 2 keeps PR #182 small + makes the security migration land first; the row-level hash + lookup change is the load-bearing security work, and the raw column remaining in phase 1 is operationally honest.

**Honest non-claims:** raw column still populated for existing + new rotations until phase 2; the in-DB token is therefore still a bearer credential until phase 2 nulls it. The runtime route no longer reads the raw column, which is the load-bearing change for the SQL-injection / read-leak threat model. No payment behaviour change. No Stripe gate change. No live mode.

### Session completion to billing workflow + payment UI cleanup (PR #181, no migration)

**Decision (2026-06-09):** Two surfaces touched. (a) Calendar appointment detail gets a new `NextStepCard` that replaces the bare `Completed` placeholder with an "Appointment completed" + "Next step: chart the session and bill the client." CTA card whose primary action label depends on linked-session state. (b) Session payment card cleans up the stale `prepareJustSucceeded` banner, calls `router.refresh()` after a successful Prepare, and promotes `refund_status='succeeded'` to the top heading ("Test payment refunded") so the practitioner sees ONE current state instead of conflicting independent banners. The receipt email template's stale "Refund handling is not enabled in Hone yet" disclaimer is replaced with refund-aware copy (PR #178 made refunds available).

**Why:** Chloe successfully reached the payment flow after PR #180 and the payment mechanics worked (charge, receipt, refund all succeeded in test mode), but the UI flow felt disjointed: (1) after marking an appointment completed there was no clear next step toward billing; (2) the session payment card showed a stale green "Session payment prepared / No charge has been run" banner alongside a green "Test charge succeeded" panel AND a refund-succeeded sub-section -- three states stacked simultaneously; (3) the receipt copy still said refund handling was not enabled even though PR #178 added it. PR #181 is a UI/copy/workflow PR with no payment behavior change.

**Architecture:**

- `app/(app)/calendar/[id]/page.tsx` (extended). New `NextStepCard` component appended below `ChartSessionCard` in the source file; mounted from the completed-status branch. Three sub-states (`Start session` / `Open session` / `Go to billing`) chosen off `linkedSession.id` + `linkedSession.started_at`. `Go to billing` deep-links to `/clients/<id>/sessions/<sessionId>#session-payment`. ChartSessionCard mount is gated on `typedStatus !== "completed"` so the two surfaces do not duplicate; ChartSessionCard continues to render for confirmed / no_show.

- `components/session-payment-prepare-card.tsx` (extended). (1) `useRouter` is imported from `next/navigation`. (2) The local `prepareJustSucceeded` banner is gated on `!activeAttempt` so it disappears the moment the persisted row catches up; the verbose "Attempt id: ... No charge has been run. Refresh to see the persisted state..." copy is replaced with a single line "You can now run the test charge." (3) The successful-prepare branch in the form's submit handler calls `router.refresh()` so the persisted ready row replaces the local banner immediately. (4) `SucceededPanel` introduces a `refunded = attempt.refundStatus === "succeeded"` discriminator. When refunded the panel switches the border + background palette from green to amber, the top heading becomes "Test payment refunded.", and a `Refund details` block (Amount refunded / Refunded / Refund id) renders directly under the charge details. The existing `ReceiptSubPanel` + `RefundSubPanel` continue to mount below as per-section detail; the Refund sub-panel already hides its action button when `refund_status='succeeded'`. (5) The Amount line in the succeeded panel is renamed to "Amount charged:" so it reads as a charge total.

- `app/(app)/clients/[id]/sessions/[sessionId]/page.tsx` (extended). `SessionPaymentPrepareCard` is wrapped in `<div id="session-payment">` so the calendar `Go to billing` deep link lands precisely on the payment surface. The wrapper is a noop visually.

- `lib/email/templates/payment-receipt.ts` (extended). `NO_REFUND_BODY_DISCLAIMER` constant renamed to `REFUND_AVAILABLE_BODY_DISCLAIMER` with new copy `"If this test payment needs to be refunded, the practitioner can issue a test-mode refund in Hone."` Both text and html bodies stamp the new disclaimer in the same position the old one occupied. Tests updated to pin the new copy and explicitly assert the old wording is gone.

**State model (after PR #181):**

| Persisted row | Top heading | Palette | Receipt sub-panel | Refund sub-panel | Stale prepare banner |
| --- | --- | --- | --- | --- | --- |
| `refund_status='succeeded'` | "Test payment refunded." | amber | sent state visible | refunded state, no button | hidden (gated by `!activeAttempt`) |
| `refund_status='pending_stripe'` | "Test charge succeeded." | green | sent state | "Refund pending." | hidden |
| `refund_status='failed'` | "Test charge succeeded." | green | sent state | failed state, retry available | hidden |
| `status='succeeded'`, no refund | "Test charge succeeded." | green | active (button if not sent) | active (button) | hidden |
| `status='pending_stripe'` | "Test charge pending." | amber | hidden | hidden | hidden |
| `status='ready'` | "Session payment prepared" | neutral | hidden | hidden | hidden once persisted catches up |
| no attempt + eligible | (prepare form) | n/a | hidden | hidden | shown briefly between submit and refresh |
| not eligible + no attempt | "Billing not ready" + reasons (existing BlockedPanel + eligibility helper reasons) | red | hidden | hidden | hidden |

**Payment gate untouched.** `lib/billing/session-payment-eligibility.ts` continues to require `appointment.status='completed'` AND `sessions.appointment_id IS NOT NULL` AND `sessions.started_at IS NOT NULL` AND active card on file AND signed_current card authorization AND studio Stripe test mode. The eligibility helper's blocking reasons (already specific: "Mark the appointment complete before preparing a session payment.", "Session has not started yet...", "No card on file...", "Card authorization is not signed...") continue to drive the BlockedPanel surface; PR #181 did not need to invent new copy.

**What this PR does NOT do:**

- No payment behavior change. The prepare / execute / receipt / refund actions are unchanged.
- No new Stripe SDK call site (`paymentIntents.create` stays at 2 allowlisted, `refunds.create` stays at 1 allowlisted, `charges.create` / `checkout.sessions` stay at 0).
- No live mode.
- No SMS / email behavior change beyond the receipt copy update.
- No client-portal mutation.
- No `payment_charge_attempts` / `manual_fee_charge_attempts` runtime change.
- No DB migration.
- No new payment eligibility logic. The card's BlockedPanel continues to display the helper's blocking reasons unchanged.
- No scroll/focus behavior added beyond the basic `#session-payment` fragment anchor. Browsers natively scroll on hash navigation; explicit `scrollIntoView` is deferred.

**Alternative considered:** Remove the local `prepareJustSucceeded` banner entirely (no local feedback, rely on `router.refresh()` alone). Rejected: a brief 1-render-window confirmation gives the practitioner an immediate "the click worked" signal before the persisted row catches up; the gate on `!activeAttempt` cleanly removes the conflict without removing the feedback.

**Honest non-claims:** no payment gate weakening, no new Stripe call, no live mode, no migration, no SMS, no client portal, no fee charging, no payment_charge_attempts schema change, no automatic refunds, no automatic dispute response. Stripe gates unchanged from PR #180.

### Appointment completion + session-start workflow unblock for payment smoke (PR #180, no migration)

**Decision (2026-06-09):** Re-expose the "Mark completed" button on the appointment lifecycle surface AND auto-mark linked appointments completed when a practitioner starts a session against a confirmed, past appointment. The payment prepare gate from PR #172 (`appointment.status='completed'`) is unchanged; the fix is restoring the practitioner-side workflow that reaches that state from the UI.

**Why:** Chloe attempted the full payment smoke after PR #179 and could not reach the payment prepare step. The test script asked her to "set the appointment time so it can be completed now", but the public booking UI does not allow past booking. She opened an existing past appointment and found the Mark no-show button, but no Mark completed button. She tried from the calendar and the client profile; neither surface offered the action. The `markAppointmentCompleteAction` server action + the `mark_appointment_complete` RPC (migration 0032) were intact the entire time; the UI button was deliberately removed during an earlier UX simplification ("Chloe did not want to mark each appointment complete by hand") that predated the payment gate. Once PR #172 made the completed state load-bearing for charging, the missing button became a hard workflow blocker.

**No migration needed.** The `mark_appointment_complete` RPC has been in production since migration 0032; it enforces practitioner-active-in-studio, source-status='confirmed', ends_at-in-the-past, and writes an `appointment_audit` row atomically. PR #180 is pure UI re-exposure + a tiny server-side auto-call. Migration ledger stays at 0078.

**Architecture:**

- `app/(app)/calendar/AppointmentLifecycleActions.tsx` (extended). New `Mark completed` button alongside the existing `Mark no-show`. Both share the same gating (`status === "confirmed"` AND `hasEnded`), the same two-click `window.confirm` pattern, and the same disabled-title copy when the appointment is in the future. New `COMPLETE_CONFIRM_MESSAGE` constant carries the exact copy: "Mark this appointment completed? This marks the appointment completed and allows the session to be charged after charting." Success hint: "Appointment marked completed." The button uses the primary (filled) style so the workflow's happy path is the obvious affordance; Mark no-show keeps the outline style as the exception path. The component-level doc block records the removal/re-introduction history so a future reviewer sees the reasoning.

- `app/(app)/clients/[id]/sessions/new/actions.ts` (extended). New private helper `maybeMarkAppointmentCompletedOnSessionStart` at module scope. After the session insert + appointment-link resolution, if `appointment.status === "confirmed"` AND `appointment.ends_at <= now()`, the helper calls `admin.rpc("mark_appointment_complete", {...})` via a dynamically-imported admin client (cold path; the module's other DB calls stay on the authenticated RLS client per PR #156's lineage discipline). Cancelled and no-show appointments are explicitly skipped per the prompt's safety rules ("Starting/charting a session does not mark cancelled/no-show appointments completed"). The helper is fail-soft: an RPC error or any throw is logged via `session_start_auto_mark_complete_rpc_error` / `session_start_auto_mark_complete_threw` structured stderr lines but NEVER rethrown, so a failed auto-complete cannot break session start. The practitioner can still mark completed by hand via the calendar button. The appointment SELECT was widened from `id, studio_id, client_id, practitioner_id` to `id, studio_id, client_id, practitioner_id, status, ends_at` so the auto-complete decision is made off the same roundtrip as the lineage check.

- `tests/app/clients/sessions/new-action-appointment-link.test.ts` (extended). The pre-existing "no admin client for the lineage check" test was tightened: it now pins that (1) the appointment lineage SELECT still runs on the RLS client (unchanged); (2) the only admin-server import is inside `maybeMarkAppointmentCompletedOnSessionStart` and is the dynamic-import shape. The SELECT-column test now expects the widened `id, studio_id, client_id, practitioner_id, status, ends_at` shape.

**Auto-mark-completed contract (load-bearing safety):**

| Pre-state | After session start |
| --- | --- |
| `appointment.status='confirmed'`, `ends_at <= now()` | Auto-marked `completed`. Calendar revalidated. |
| `appointment.status='confirmed'`, `ends_at > now()` | NOT auto-marked. RPC would refuse anyway. |
| `appointment.status='cancelled'` | NOT auto-marked. Skipped before RPC call. |
| `appointment.status='no_show'` | NOT auto-marked. Skipped before RPC call. |
| `appointment.status='completed'` | NOT auto-marked. Skipped before RPC call. |
| Session has no linked appointment (`appointment_id IS NULL`) | Auto-mark helper not invoked. |
| RPC throws / returns error | Logged via structured stderr; session start UX is NOT blocked. Practitioner can complete by hand. |

**Payment gate untouched.** `lib/billing/session-payment-eligibility.ts:142-146` continues to require `appointment.status='completed'`. The blocking reason copy ("Mark the appointment complete before preparing a session payment.") is already actionable; no copy change. The gate refuses future appointments, cancelled appointments, no-show appointments, unstarted sessions, sessions without an appointment, and appointments without a session.

**What this PR does NOT do:**

- Does NOT weaken the payment prepare gate.
- Does NOT add any new Stripe SDK call (`paymentIntents.create` stays at 2 allowlisted, `refunds.create` stays at 1 allowlisted, `charges.create` / `checkout.sessions` stay at 0).
- Does NOT enable live payments.
- Does NOT add SMS, email, or client-portal mutation.
- Does NOT touch `payment_charge_attempts` / `manual_fee_charge_attempts` runtime.
- Does NOT add any DB migration.
- Does NOT add a "restore" or "reopen" affordance for terminal-status appointments. The existing no_show / cancelled / completed states remain terminal from the UI.
- Does NOT change the no-show button, the cancel flow, or the reschedule flow.
- Does NOT auto-cancel or auto-no-show. Only the confirmed -> completed transition is automated, and only on the explicit session-start signal.

**Alternative considered:** Add a separate Mark completed action surface (e.g. on the client profile's appointment timeline) without re-exposing it on the calendar. Rejected: the calendar appointment detail is the canonical place for lifecycle actions; splitting completion to a different surface would create the same discoverability gap Chloe hit (only Mark no-show on the calendar).

**Honest non-claims:** no payment gate weakening, no new Stripe call, no live mode, no SMS, no client portal, no fee charging, no migration. Stripe gates unchanged from PR #179. Payment smoke can resume after deploy.

### Stripe webhook reconciliation for payment_charge_attempts (PR #179, no migration)

**Decision (2026-06-09):** Add webhook reconciliation in the existing `app/api/stripe/webhook/route.ts` for four payment-related event types so Stripe-side state changes can safely flow onto `payment_charge_attempts` rows. Reason-agnostic by construction (handlers read `row.charge_reason` and never branch on it). Test mode only: `event.livemode === true` is a hard dormancy guard that records a warning ops_alert and returns without mutation. The existing `stripe_events` ledger from migration 0032 already provides Stripe-event idempotency; no new ledger table needed.

**Why:** docs/16 §5.5 noted that out-of-band Stripe-Dashboard refunds were NOT reconciled into Hone, and that `charge.dispute.created` had no operator alert. Both gaps were operational risks once test charges began producing rows. PR #179 closes those gaps without introducing money movement: the webhook is a one-way mirror that reflects Stripe state onto Hone rows when safe, and fires critical ops_alerts when a mismatch would corrupt the local audit trail.

**No migration needed.** The existing `stripe_events` table + the `claim_stripe_event` / `mark_stripe_event_processed` / `release_stripe_event_claim_with_error` RPC chain provide signature verification, idempotency via `(stripe_account_id, stripe_livemode, stripe_event_id)` partial unique, and ops_alert on handler failure. PR #179 adds new switch branches in `handleStripeEvent` that delegate to a new helper module. Migration ledger stays at 0078.

**Architecture:**

- `lib/billing/payment-webhook-reconciliation.ts` (new). Exports four handlers: `handlePaymentIntentSucceeded`, `handlePaymentIntentPaymentFailed`, `handleChargeRefunded`, `handleChargeDisputeCreated`. Imports `server-only`. Imports `recordOpsAlert` from `lib/ops/alerts`. Does NOT import `getStripe` (no Stripe SDK call needed; handlers only read the event payload).

- Shared row-lookup helper `resolveAttemptByMetadataOrId`. Lookup order: (1) metadata canonical key `hone_payment_charge_attempt_id` (PR #178 refund-stamped); (2) metadata legacy key `hone_session_payment_charge_attempt_id` (PR #173 charge-stamped); (3) fallback to `stripe_payment_intent_id` (for PI events) or `stripe_charge_id` (for Charge events). The two-key lookup accommodates the metadata-key inconsistency between PR #173 and PR #178 without changing the Stripe metadata schema (which would invalidate in-flight PaymentIntents).

- Shared metadata consistency guard `verifyMetadataAgainstRow`. If `metadata.hone_studio_id`, `metadata.hone_client_id`, or `metadata.hone_charge_reason` differ from the resolved row, records a critical `stripe_webhook_metadata_mismatch` ops_alert and returns false; the calling handler then short-circuits with `metadataMismatch:true` and NO row mutation. Better to leave a row out of sync (visible via the dashboard) than to overwrite it with ids that don't match the row's lineage.

- `app/api/stripe/webhook/route.ts` (extended). Top-of-file doc block updated with the PR #179 allowed mutations + reconciliation discipline. New imports from the reconciliation module. New `case` branches in the `handleStripeEvent` switch dispatch to the four handlers. The signature verification, `claim_stripe_event` idempotency, and `mark_stripe_event_processed` chain are unchanged.

**Event handling matrix:**

| Event | Mutation when row in {ready, pending_stripe} | Mutation when row already in target terminal state | Mismatch handling |
| --- | --- | --- | --- |
| `payment_intent.succeeded` | flip to `succeeded` + stamp PI id, latest_charge id, `charged_at = now()`, clear failure fields. Conditional UPDATE `WHERE status IN ('ready','pending_stripe')`. | `succeeded`: idempotent, may stamp missing charge id only. | `failed/cancelled/blocked` row: critical `payment_intent_succeeded_local_terminal_mismatch`, no flip. No row found: warning `payment_intent_succeeded_no_match`. |
| `payment_intent.payment_failed` | flip to `failed` with sanitised `failure_code` + `failure_message_safe` + `failed_at = now()`. | `failed`: idempotent no-op. | `succeeded`: critical `payment_intent_failed_after_local_succeeded`, no flip. `cancelled/blocked`: critical `payment_intent_failed_local_terminal_mismatch`. |
| `charge.refunded` (FULL: `amount_refunded === amount AND charge.refunded`) | `pending_stripe`: flip to `succeeded` with refund id + `refunded_at`. Out-of-band (null OR `failed` refund_status): flip to `succeeded` + warning `charge_refunded_out_of_band_reconciled` so the operator knows the refund did not originate in Hone. | `succeeded`: idempotent, may stamp missing refund id only. | Partial refund (`amount_refunded < amount` OR `charge.refunded === false`): critical `charge_refunded_partial_out_of_band`, no row mutation (v1 schema can't represent partial). |
| `charge.dispute.created` | None. Alert-only. | (n/a) | Critical `payment_charge_dispute_created` ops_alert with `attempt_id`, `stripe_charge_id`, `stripe_dispute_id`, `amount`, `currency`, `reason`, `status`. No automated dispute response. |

**Live-mode dormancy guard.** `shouldIgnoreLiveModeEvent` is called first in every handler. When `event.livemode === true` OR `ctx.livemode === true`, the handler returns `livemodeEventIgnored:true` without any DB write and records a warning `stripe_webhook_livemode_event_ignored` ops_alert. Test-mode events flow through normally.

**Idempotency.** Two layers:
1. Stripe-event level: existing `claim_stripe_event` RPC + `stripe_events` partial unique on `(stripe_account_id, stripe_livemode, stripe_event_id)`. Duplicate event id → `already_processed=true` → 200 ack.
2. Row level: each handler's UPDATE uses conditional WHERE clauses (`status IN (...)` or `refund_status = 'pending_stripe'` or `or("refund_status.is.null,refund_status.eq.failed")`). A row already in the target state is a no-op or an idempotent stamp of a missing id.

**Reason-agnostic by construction.** The handlers read `row.charge_reason` (for the metadata consistency check) and pass it through as part of payload_summary. They never branch on the value. Source-grep tests pin the absence of `charge_reason === 'session_payment'` / `'late_cancellation_fee'` / `'no_show_fee'` literals.

**What this PR does NOT do:**

- Does NOT add any new Stripe API call. The new helper module does not import `getStripe`; the gate script confirms `paymentIntents.create` stays at 2 allowlisted, `refunds.create` stays at 1 allowlisted (`lib/billing/payment-refund.ts`), `charges.create` and `checkout.sessions` stay at 0.
- Does NOT enable live payments. The dormancy guard returns before any mutation when `event.livemode=true`.
- Does NOT add automatic dispute response. Disputes record an ops_alert; operators handle via Stripe Dashboard.
- Does NOT add automatic refund triggers. Refunds are still practitioner-initiated via PR #178; webhook only reconciles existing Stripe refunds onto the row.
- Does NOT add a refund receipt email. A future PR may add a reason-agnostic mirror of PR #175.
- Does NOT touch `manual_fee_charge_attempts`. The legacy fee runtime still has no webhook reconciliation; that ships when fee charging moves onto `payment_charge_attempts` (see docs/13 + docs/16 §12.5b).
- Does NOT add SMS, client-portal UI, or any new mutation surface beyond `payment_charge_attempts` updates and `ops_alerts` inserts.
- Does NOT add a migration. The `stripe_events` ledger + existing `payment_charge_attempts` columns from migrations 0073-0078 cover every state PR #179 writes.
- Does NOT add columns for dispute state (`dispute_status`, `stripe_dispute_id`, `disputed_at`). Per prompt: "ops alert alone is acceptable for this PR if documented." Future PR if needed.

**Alternative considered:** Add a new `stripe_webhook_events` table dedicated to PR #179 events. Rejected: the existing `stripe_events` ledger already provides every required guarantee (signature verification, idempotency, claim/release/mark-processed). A second table would split the webhook audit trail without operational benefit.

**Honest non-claims:** no new Stripe call site, no new `paymentIntents.create` (still 2 allowlisted), no new `refunds.create` (still 1 allowlisted at `lib/billing/payment-refund.ts`), no `charges.create` / `checkout.sessions`, no live mode, no money movement, no automatic dispute response, no SMS, no client portal, no `manual_fee_charge_attempts` touch, no live-mode CHECK relaxed.

### Reason-agnostic test-mode refunds on payment_charge_attempts (PR #178, migration 0078)

**Decision (2026-06-09):** Add a manual, practitioner-triggered, test-mode-only refund path on the canonical `payment_charge_attempts` ledger. Reason-agnostic by construction: the helper passes the row's `charge_reason` through as Stripe-refund metadata (`hone_charge_reason`) and never branches on the reason value, so the same helper covers `session_payment` today and `late_cancellation_fee` / `no_show_fee` when those reasons start writing rows. v1 is **full-refund only**, one refund per attempt, no automatic triggers, no webhook reconciliation of `charge.refunded`, no refund receipt email, no live mode, no client-portal refund UI, no `manual_fee_charge_attempts` runtime touch.

**Why:** docs/16 §5.5 was the last critical gap before the PR #175 receipt smoke could prove the full charge-and-undo loop end-to-end in test mode. PR #178 is the smallest fix that closes it: a single allowlisted `refunds.create` site behind a triple dormancy guard (env check + row-level CHECK + claim predicate), one new migration that's purely additive, and a sub-panel under the existing succeeded panel that mirrors the PR #175 receipt sub-panel pattern.

**Migration 0078 (applied to prod 2026-06-09 BEFORE code merge):**

```sql
alter table public.payment_charge_attempts
  add column if not exists refund_status text,
  add column if not exists refund_amount_cents integer,
  add column if not exists refunded_at timestamptz,
  add column if not exists stripe_refund_id text,
  add column if not exists refund_failure_code text,
  add column if not exists refund_failure_message_safe text,
  add column if not exists refund_internal_note text,
  add column if not exists refund_idempotency_key text,
  add column if not exists refund_initiated_by_practitioner_id uuid;
-- + 5 CHECK constraints (refund_status enum; amount > 0 AND <= amount_cents;
--   failure_code <= 100; failure_message_safe <= 1000; internal_note <= 500)
-- + 1 FK (refund_initiated_by_practitioner_id + studio_id -> practitioners)
-- + 2 partial uniques (stripe_refund_id; refund_idempotency_key)
-- + 1 partial index for the "stuck pending refund" operator dashboard
```

Every column nullable. All CHECK constraints use DROP+ADD so the migration is re-runnable. Production verified: 9 columns + 6 CHECK/FK constraints + 3 indexes. No CHECK relaxed; `payment_charge_attempts_livemode_false_check` and `manual_fee_charge_attempts_livemode_false_check` both intact.

**Architecture:**

- `lib/billing/payment-refund.ts` (new). Exports `refundPaymentChargeAttempt({attemptId, studioId, practitionerId, internalNote?})`. Imports `server-only`. Triple dormancy guard: (1) `inferStripeLivemode()` short-circuit at entry, (2) row-level CHECK, (3) conditional UPDATE claim. Deterministic idempotency key `hone:payment_refund:<attemptId>:v1`. Stripe-refund metadata records the Hone identity tuple + `hone_charge_reason` + `hone_environment:"test"`. Unknown Stripe outcome leaves the row `pending_stripe` and records a critical `payment_refund_stripe_unknown_outcome` ops_alert with the idempotency key so an operator can reconcile.

- `app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts` (extended). New `refundPaymentChargeAttemptAction`: auth-gated; accepts attempt_id + optional internal_note + session/client for revalidate; never accepts a browser-supplied amount; revalidates the session detail page on every outcome.

- `components/session-payment-prepare-card.tsx` (extended). New `RefundSubPanel` renders inside `SucceededPanel` ONLY. Reads `refund_status` from the persisted row so the already-refunded / pending / failed states survive refresh. Two-click confirm with the amount in the second button. Copy strictly avoids "Live refund" / "Refund complete" / "Money returned" / "Official refund receipt".

- `scripts/check-stripe-gates.mjs` (extended). `refunds.create` now `exactly: 1` with allowlist `["lib/billing/payment-refund.ts"]`. A second site is a deliberate review event.

- `lib/billing/session-payment-types.ts` + `lib/billing/session-payment-eligibility.ts` (extended). Summary type carries six new refund fields; eligibility SELECT reads them.

**Idempotency + duplicate safety:** claim conditional UPDATE matches on `(status='succeeded' AND stripe_livemode=false AND (refund_status IS NULL OR refund_status='failed'))`. Two concurrent clicks both pass the pre-claim SELECT; only one wins the UPDATE; the loser returns `outcome:"claim_lost"`. Partial-unique `payment_charge_attempts_refund_idempotency_uniq` is the DB-level backstop. The deterministic key shape `hone:payment_refund:<attemptId>:v1` means a Stripe SDK retry produces the same key + Stripe's 24-hour replay returns the same Refund object.

**Unknown-outcome handling:** if `stripe.refunds.create` throws a non-`StripeError` (network / timeout), the row stays `pending_stripe`, a critical ops_alert fires with the idempotency key in `safeDetails`, and the helper returns `outcome:"needs_manual_review"`. The operator decides whether to re-query Stripe.

**What this PR does NOT do:**

- Does NOT enable live payments. Three structural dormancy guards intact + row CHECK + claim predicate.
- Does NOT add or remove any `paymentIntents.create` call site (still 2, both allowlisted).
- Does NOT add `charges.create` / `checkout.sessions` (still zero).
- Does NOT add automatic refund triggers. Manual click only.
- Does NOT add `charge.refunded` webhook handling. Out-of-band Stripe-dashboard refunds are NOT reconciled into Hone today.
- Does NOT add dispute handling.
- Does NOT add a refund receipt email. May land later as a reason-agnostic mirror of PR #175.
- Does NOT add SMS.
- Does NOT add a client-portal refund surface.
- Does NOT touch `manual_fee_charge_attempts` runtime. The dormant 0032 `stripe_refunds` / `stripe_refund_attempts` tables remain dormant; PR #178 ships refund state ON `payment_charge_attempts` directly.
- Does NOT support partial refunds in v1 (`refund_amount_cents = amount_cents`). Schema CHECK `refund_amount_cents <= amount_cents` leaves room.
- Does NOT support multiple refunds per attempt (partial-unique on `stripe_refund_id`).

**Alternative considered:** Use Stripe's `payment_intent` parameter on `refunds.create` instead of `charge`. Rejected: `stripe_charge_id` is the most specific identifier; the charge id eliminates variance over PaymentIntent lifetimes; the Stripe docs describe `charge` as the canonical refund target.

**Honest non-claims:** no new Stripe call beyond the single allowlisted refund site, no live mode, no automatic refund, no dispute automation, no webhook reconciliation, no SMS, no client-portal UI, no `manual_fee_charge_attempts` touch, no live-mode CHECK relaxed. Migration ledger advanced to 0078.

### Card authorization pointer refresh on re-sign + backfill + charge-gate invariant (PR #177, migration 0077)

**Decision (2026-06-08):** Close the audit-trail gap recorded as `docs/16` §5.11 (PR #176 finding) with three interdependent pieces shipped together: (1) refresh active `client_payment_methods` rows when a fresh `card_authorization` signature lands; (2) one-shot backfill of existing prod rows via migration 0077; (3) tighten the session payment charge gate so a stale `client_payment_methods.card_authorization_signature_id` pointer blocks PREPARE and EXECUTE with a clear "Client must re-sign the current card authorization for the card on file." remedy. Portal re-sign + Add Card + Replace Card paths continue to use the base PR #170 `getCardAuthorizationStatus` so a stale pointer can never deadlock the remedy.

**Why:** PR #176 documented that the only card-on-file client in prod had a current signed `card_authorization` signature but the active card row's `card_authorization_signature_id` still pointed to an older signature. The code-level gate (the base helper) read the latest signature against the live template and returned `signed_current`, so prepare passed; the audit pointer on the card row referenced an older signed body. Acceptable in test mode; not acceptable in live mode where a dispute or chargeback would surface the older signature as the legal artefact. Three pieces ship together because (a) refresh without backfill leaves existing rows blocked by the new gate; (b) gate without refresh blocks every new charge until a manual repair; (c) refresh without the gate lets a future refresh failure silently recreate the bug.

**Architecture:**

- `lib/payment-methods/refresh-card-authorization-pointer.ts` (new). Exports `refreshActiveCardAuthorizationPointersForSignature({studioId, clientId, signatureId})`. Imports `server-only`. Reads candidate active + non-removed `client_payment_methods` rows scoped to `(studio_id, client_id, stripe_livemode=inferStripeLivemode())`, filters to stale ones (`pointer !== signatureId`, NULL-as-stale), and updates them to `card_authorization_signature_id = signatureId`. Schema's partial unique `client_payment_methods_one_active_per_pair` caps the set at one row today; the iteration shape keeps a future multi-card UX safe. Fail-soft on either DB phase: records a critical `card_authorization_pointer_refresh_failed` ops_alert with `safeDetails={signature_id, db_phase, db_code}` and returns `{ok:false, reason:"database_error", message}`. The signature insert is NEVER rolled back. The helper deliberately does NOT import `getCardAuthorizationStatus` or `getChargeReadyCardAuthorizationStatus` so a future refactor cannot accidentally introduce a re-sign deadlock.

- `lib/consent/current-card-authorization.ts` (extended). New `getChargeReadyCardAuthorizationStatus` wraps the base helper unchanged and adds a card-row pointer-equality check. Discriminated union extends the base four variants with `signed_current_but_card_pointer_stale` (carrying `cardId` + `cardPointerSignatureId` for debugging). When there is no active card row at all, the helper returns the base result unchanged so the eligibility helper's existing "no card on file" branch keeps owning that surface. CRITICAL: docs in the file-top block + the helper-block doc list the allowed callers (session payment prepare / session payment execute / future canonical charge gates) and the forbidden callers (portal sign, Add Card, Replace Card, read-only display) for deadlock prevention.

- `app/portal/consent-actions.ts` (extended). After the `client_consent_signatures` insert succeeds and `template.form_type === "card_authorization"`, the action calls the refresh helper with `{studioId: session.studioId, clientId: session.clientId, signatureId: created.id}`. On `!refresh.ok` it logs a structured stderr line and continues (the visitor still sees their signature saved; the operator-side ops_alert already names the reconciliation owner). NO charge-gate helper is called here.

- `lib/billing/session-payment-eligibility.ts` (extended). Switches `getCardAuthorizationStatus` → `getChargeReadyCardAuthorizationStatus`. New `signed_current_but_card_pointer_stale` case pushes the practitioner-facing remedy reason without setting `cardAuthSummary`, so the existing eligible:true guard (which requires `cardAuthSummary` truthy) cannot pass.

- `lib/billing/session-payment-charge.ts` (extended). Step 3 recheck switches to `getChargeReadyCardAuthorizationStatus`. New explicit branch on `kind === "signed_current_but_card_pointer_stale"` returns `outcome: "authorization_not_current"` with the same remedy copy. The existing `cardAuth.signatureId !== attemptRow.card_authorization_signature_id` check remains; the existing `loadCardAndVerifyLineage` step 4 check (`card.card_authorization_signature_id !== expectedSignatureId`) also remains. The execute invariant is now the AND of all three: `cardAuth.signatureId == active_card.card_authorization_signature_id == attemptRow.card_authorization_signature_id`.

- `supabase/migrations/0077_refresh_card_authorization_signature_pointers.sql` (new). `DO $migration$ ... $migration$` block; single CTE-based UPDATE; idempotent via `IS DISTINCT FROM` (re-running produces zero updates); only updates active + non-removed rows whose latest signature against the live `card_authorization` template is current. NOTICE emits the row count for the operator audit. No CHECK constraint relaxed; no DML against `manual_fee_charge_attempts` or `payment_charge_attempts`; no Stripe call.

**Add Card / Replace Card unaffected:** Add Card (`app/portal/payment-method-actions.ts:createCardSetupIntentAction`) still uses the base `getCardAuthorizationStatus` and passes the LATEST signed_current signature id via SetupIntent metadata, which the webhook arm stamps onto the new card row. A new card therefore always lands with a current pointer. Replace Card uses the same code path; the webhook flips any existing active card to `status='removed'` then inserts the new active row with the current signature id. A stale pointer on an OLDER active card cannot block this remedy because the new card flow does not invoke the tightened gate.

**Manual fee path intentionally untouched in PR #177:** `lib/billing/manual-fee-eligibility.ts` already reads the card row's pointer and verifies its signature's `template_version` against the live template, so it would have surfaced the stale pointer with "Card authorization on file is out of date." anyway. Switching it to `getChargeReadyCardAuthorizationStatus` would change behavior; PR #177 keeps that surface unchanged to minimise scope.

**Production migration verification (verified 2026-06-08 in prod, before code merge):**

- `supabase migration list --linked` confirms 0076 + 0077 both applied to remote.
- Stale pointer count BEFORE: 1 (the known Sai @ My Studio row).
- Rows updated by NOTICE: `refreshed 1 active client_payment_methods card_authorization_signature_id pointer(s)`.
- Stale pointer count AFTER: 0.
- Known row repair: card `2cb98ea1-…83b9` pointer changed from `a6b1fdbe-5738-4a42-bfef-22703edb0dd4` to `cd3af5cb-33b1-4c6b-8ebf-6170b8dfa278` (matches the latest signed_current signature).
- `pg_constraint` lookup confirms `manual_fee_charge_attempts_livemode_false_check` and `payment_charge_attempts_livemode_false_check` both unchanged.

**Tests pinned (source-grep dominant):** `tests/lib/payment-methods/refresh-card-authorization-pointer.test.ts` (29 tests: server boundary, deadlock prevention, scoping, idempotency, write shape, fail-soft + ops_alert, forbidden ops, result type contract). `tests/lib/consent/charge-ready-card-authorization.test.ts` (21 tests: helper declaration, discriminated union shape, comparison + return, caller classification across all four call sites, practitioner message contract). `tests/migrations/0077-refresh-card-authorization-signature-pointers.test.ts` (18 tests: scoping invariants, idempotency, forbidden operations, audit trail). `tests/app/portal/consent-actions-refresh.test.ts` (8 tests: wiring + fail-soft + deadlock prevention + form_type gate). `tests/lib/billing/session-payment-stale-pointer.test.ts` (17 tests: prepare-gate stale-pointer branch, execute-gate stale-pointer branch, NO Stripe call on stale pointer, existing recheck assertions preserved, safety gates). Updated `tests/lib/billing/session-payment-charge-source.test.ts` + `tests/lib/billing/session-payment-eligibility-source.test.ts` (helper-name pin updated from base to charge-ready).

**Alternative considered:** Tightening the base `getCardAuthorizationStatus` globally so every caller becomes strict. Rejected because the portal sign action and Add Card flow need the remedy path to STAY OPEN; a globally-strict helper would deadlock the remedy and lock clients out forever. The charge-only wrapper is the minimum-surface fix.

**Honest non-claims:** no new Stripe call site, no `paymentIntents.create` count change (still 2 allowlisted), no `charges.create`, no `refunds.create`, no `checkout.sessions`, no `STRIPE_ALLOW_LIVE_MODE=true` change, no receipt behavior change beyond unblocking the PR #175 smoke, no SMS, no client-portal payment UI expansion, no `manual_fee_charge_attempts` touch, no RLS relaxation, no live-mode flag flipped. Migration ledger advanced to 0077.

### Email-only practitioner notifications for portal replies (PR #129)

**Decision:** When a client replies to a studio's portal message, the owner gets an email notification that contains a deep-link to the client profile and **no message content**.

**Why:** Email is the easiest surface for the practitioner to notice on the move. Sending the content in the email would mean the message body lives in the practitioner's inbox in clear text outside Hone's RLS / auth layer.

**Alternative considered:** Push notification, or content-in-email. Push needs mobile infra (not built). Content-in-email leaks the message body. The current notify-and-deep-link is the calm path.

### True message threading deferred

**Decision:** The portal-messages model is one-way studio-to-client with client replies (PR #129). Real threading (subject linking, reply-to references, parent ids) is deferred.

**Why:** The pilot only needs Q&A-style exchanges. Threading adds modeling complexity that does not pay off for one studio.

### Card-on-file before charging (PR #135)

**Decision:** Card-on-file Phase 1 ships before any charging code. The DB has the result schema for SetupIntent (`client_payment_methods`) and the customer mapping but no charge action.

**Why:** Charging without a saved card on file is impossible. Building card-on-file separately let the SetupIntent webhook handler, the lineage FKs, and the consent linkage be exercised end-to-end before any money-moving code existed.

### Manual-only fees before auto-charge (PR #145, PR #146)

**Decision:** Fees are charged only by a manual practitioner click on a `ready` attempt. No automatic, batch, background, or public-triggered charge path exists.

**Why:** Auto-charge is hard to undo. Manual click is easy to reason about. The practitioner is the human-in-the-loop for "yes, this client should be charged for this cancellation."

**Alternative considered:** Late-cancel auto-charge cron + threshold settings. Deferred indefinitely. A future PR could add structured threshold settings; the current code allows that path (`timing_classification` allows `system_derived`).

### Test-mode charge before live (PR #146)

**Decision:** PaymentIntent code exists in `lib/billing/manual-fee-charge.ts` behind three independent live-mode guards (key gate, code gate, DB CHECK). Live-mode requires a deliberate live-mode PR with the [docs/06 §9](./06_PAYMENTS_AND_STRIPE.md#9-live-charging-requirements) checklist.

**Why:** Building the charge path against the real Stripe Connect surface in test mode is the only honest way to find off-session SCA edges, the connected-account context requirements, and the pending-reconciliation pitfalls. Going straight to live would be reckless.

### Analytics removed from token routes structurally (PR #142)

**Decision:** Vercel Analytics + Speed Insights are NOT mounted in the root layout. Safe trees opt in via `SafeAnalytics`. Token subtrees never opt in.

**Why:** A runtime pathname denylist cannot prevent the script from observing a token URL after it has already loaded on a prior page in the same SPA navigation. The only safe fix is structural absence. See [docs/03 §6](./03_SECURITY_AND_PRIVACY.md#6-analytics-privacy-pr-142).

### Cancellation/no-show timing practitioner-asserted for v1 (PR #145)

**Decision:** `timing_classification = 'practitioner_asserted'` on every manual fee attempt. The system does not mechanically decide whether a cancellation crossed the late window.

**Why:** `studios.cancellation_policy_text` is free-form text; no structured `cancellation_window_hours` column exists. A future PR can add structured thresholds and flip the value to `'system_derived'`. The column CHECK already allows that value.

### Photo consent requires explicit deny option (PR #137)

**Decision:** Photo consent has two buttons (Accept / Deny). A deny is a signed record with `response='denied'`, not an absence.

**Why:** "No photo" is a real client choice that the studio needs to know about. An unsigned absence is ambiguous (forgot? denied? haven't reached it yet?). A signed deny is unambiguous.

### Stripe direct charge on the connected account (PR #146)

**Decision:** Every Stripe call carries `{ stripeAccount }`. No platform customers, no platform PaymentMethods. The connected account is the system of record for cards and charges.

**Why:** The studio owns the customer relationship. PCI burden stays on Stripe + connected account. Multi-tenant fee handling is simpler.

### No live charging until legal review

**Decision:** Live mode is structurally blocked. Live charging requires lawyer review of consent + cancellation + card-authorization wording under Ontario law, a receipt/charge-notice email, a refund path, a live webhook handler, and a stronger pending-reconciliation path (Stripe metadata search before retry).

**Why:** Charging a real card before the wording is reviewed is a regulatory and reputational risk. The pilot studio's relationship with their clients is also at stake.

### Documentation discipline (PR #147 + this PR #148)

**Decision:** Every PR that changes product behavior, data model, security posture, payment behavior, env config, routes, cron, email/SMS, legal copy, or operational behavior MUST update the relevant docs in the same PR. The `.github/pull_request_template.md` (PR #147) enforces this at review time; this doc set (PR #148) is the source of truth being updated.

**Why:** Docs went stale faster than the app could grow. The current pilot is sensitive enough that "the code is the documentation" is no longer safe.

### Exactly one `paymentIntents.create` is allowed today (PR #146)

**Decision:** `paymentIntents.create` is permitted exactly once, in `lib/billing/manual-fee-charge.ts`, behind every protection in [docs/06 §7](./06_PAYMENTS_AND_STRIPE.md#7-test-mode-manual-fee-charge-pr-146).

**Why:** Anyone adding a second occurrence is taking on the full charge-safety budget (claim RPC, idempotency, evidence recheck, lineage recheck, test-mode gate). Treating it as zero would invite the legitimate test-mode call to be deleted by mistake.

### Public reschedule future-instant safety (PR #149)

**Decision:** Public reschedule now matches public booking on past-slot handling and never returns raw DB/RPC error text. Concretely: every read + submit path refuses the token unless the original appointment is `status='confirmed'` AND `starts_at > now()`. The slot list hides same-day past slots via a new shared `filterFutureSlots` helper. The submit action rejects `newStartsAt <= now()` before any DB lookup or RPC call. The `reschedule_appointment` RPC (migration 0066) independently rejects past originals and past `p_new_starts_at` as defence in depth. Every public action collapses DB / RPC failure into the generic `PUBLIC_RESCHEDULE_GENERIC_ERROR` copy while a structured `logInternal` line records the detail server-side.

**Why:** A deeper review found that public booking already filtered same-day past slots and rejected submitted past starts, but public reschedule was inconsistent. Raw `error.message`, `lookupErr.message`, and `rpcErr.message` were returned from the action layer to a token-bearing public route, revealing Postgres / function-name internals to a probing caller. The fix is the smallest set of guards needed to make reschedule as safe as booking, plus a parallel guard in the RPC so a future caller that bypasses the action layer also cannot reschedule into the past or rebuild a non-confirmed row.

**Alternative considered:** Inline the future-instant check in each of the four reschedule actions. Rejected because that path is exactly how the surfaces drift apart again. The shared `assertReschedulableOriginal` helper and the shared `filterFutureSlots` helper are the only places future PRs need to look at when changing the contract.

### Reason-agnostic test-mode receipt path (PR #175, migration 0076)

**Decision (2026-06-08):** Add a reason-agnostic Stripe test-mode receipt path on the canonical `payment_charge_attempts` ledger. A practitioner viewing a `succeeded` charge attempt can click "Send test receipt" to deliver one receipt email to the client; the persisted receipt state survives page refresh (mirroring the PR #174 pattern), and the truthful test-mode disclaimer + the no-tax / no-refund posture are pinned in the email template. The path is reason-agnostic: today only `session_payment` rows exist, but when the future `late_cancellation_fee` and `no_show_fee` writers land on the canonical ledger, no code change is needed to send their receipts. Migration 0076 adds five nullable receipt-state columns to the table; the `sendPaymentChargeReceipt` helper claims the row via an atomic `receipt_status IS NULL OR receipt_status = 'failed'` → `'sending'` UPDATE before calling `sendEmailSafely`. No new Stripe call. No live mode. No refund. No webhook business logic. No SMS. No client-portal change. `manual_fee_charge_attempts` runtime untouched.

**Why now:** PR #173 shipped Stripe test-mode execution; PR #174 made the post-refresh succeeded state clearly readable. Receipts are the next blocker per docs/16 §5.4 -- without them, even a test-mode charge leaves the client with no record of what was charged. Shipping receipts test-mode-only on the canonical ledger now lets the operator exercise the end-to-end charge-and-receipt loop in test mode while live-mode receipts remain structurally disabled until the live-enablement PR sequence.

**Migration 0076 (applied to prod before this commit):**

```sql
alter table public.payment_charge_attempts
  add column if not exists receipt_status text,
  add column if not exists receipt_sent_at timestamptz,
  add column if not exists receipt_email_to text,
  add column if not exists receipt_failure_code text,
  add column if not exists receipt_failure_message_safe text;
-- + receipt_status CHECK (null OR in 'sending'/'sent'/'failed')
-- + failure-code length CHECK <= 100
-- + failure-message length CHECK <= 1000
-- + partial index for stuck-sending dashboards
```

Every column nullable. All CHECK constraints use DROP+ADD so the migration is re-runnable. Production verified: 5 columns + 3 CHECKs + 1 partial index installed; 0 rows in the table (no smoke yet); no live-mode CHECK relaxed.

**Architecture:**

- `lib/email/templates/payment-receipt.ts` (new). Exports `buildPaymentReceiptEmail({ studioName, studioContactEmail, clientName, chargeReasonLabel, amountCents, currencyCode, chargedAt, stripePaymentIntentId, stripeChargeId }): { subject, html, text }` plus the `chargeReasonLabel(reason)` helper. Both are pure functions; no side effects. The template uses the same branded shell as `portal-magic-link.ts`. Subject prefixed with "TEST MODE". Body carries three disclaimers: "This is a Stripe test-mode receipt. No live card was charged.", "No tax calculation is included on this receipt.", "Refund handling is not enabled in Hone yet." Studio name + reason + amount + charged time + PaymentIntent id + (optional) Charge id are rendered as a key/value block.

- `lib/billing/payment-receipt.ts` (new). Exports `sendPaymentChargeReceipt({attemptId, studioId, practitionerId}): Promise<SendPaymentChargeReceiptResult>`. Imports `server-only`. The helper: (1) loads the attempt row scoped by studio; (2) refuses with typed reasons on `not_succeeded` / `not_authorized` (live-mode row) / `missing_payment_intent` / `already_sent` / `in_flight` / `client_email_missing` / `studio_missing`; (3) atomically claims via a conditional UPDATE matching `status='succeeded' AND (receipt_status IS NULL OR receipt_status='failed')`; (4) builds the email + calls `sendEmailSafely`; (5) persists the outcome -- `'sent'` on success (stamping `receipt_sent_at`, `receipt_email_to`, clearing failure fields), `null` on retryable failure (releases the claim so a manual retry can run), `'failed'` on terminal failure with sanitised `receipt_failure_code` + `receipt_failure_message_safe`. Ops alerts at `warning` severity on retryable failures and `critical` on terminal failures (mirrors the manual-fee charge precedent).

- `app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts` (extended). New `sendPaymentChargeReceiptAction` server action: auth-gated via `getCurrentPractitionerWithStudio`; forwards only `attemptId` + `studioId` + `practitionerId` to the helper; revalidates the session detail path on terminal result. The action accepts NO browser-supplied amount, card id, studio id, or practitioner id.

- `lib/billing/session-payment-types.ts` + `lib/billing/session-payment-eligibility.ts` (extended). `SessionPaymentExistingAttemptSummary` carries the five receipt columns; the eligibility helper's SELECT reads them. No new query path -- the existing eligibility resolver covers it.

- `components/session-payment-prepare-card.tsx` (extended). New `ReceiptSubPanel` renders inside `SucceededPanel` ONLY (negative-tested for ready / pending / failed / cancelled / blocked). Drives off `attempt.receiptStatus`: shows "Receipt already sent to <email> on <date>" when `'sent'`; surfaces failure detail when `'failed'`; shows a calm in-flight notice when `'sending'`; renders the Send test receipt button when `null` or `'failed'`. Button copy: "Sends a Stripe test-mode receipt to the client. No live card was charged." No "Pay now" / "Send invoice" / "Tax receipt" / "Official invoice" / "Payment complete" / "Live payment" anywhere.

**Atomic claim safety:**

The claim UPDATE matches on `status='succeeded' AND (receipt_status IS NULL OR receipt_status = 'failed')`. Two concurrent clicks both pass the pre-INSERT SELECT, but only one wins the UPDATE; the loser sees an empty `claimedRows` array and re-reads the row to surface the correct state (already_sent or in_flight). A failed terminal state can be retried because the claim accepts `receipt_status = 'failed'` as a starting state; the operator clicks Send test receipt again, the helper clears the failure detail and tries again. A retryable failure releases the claim back to `null` so the next click can retry without the operator needing to clear the row by hand.

**What this PR does NOT do:**

- Does NOT enable live payments. The three structural dormancy guards from PR #168 + PR #171's `payment_charge_attempts_livemode_false_check` are intact. Migration 0076 does not relax any live-mode CHECK.
- Does NOT add or remove any `paymentIntents.create` call site (still 2, both allowlisted).
- Does NOT add `charges.create`, `refunds.create`, or `checkout.sessions` (still zero).
- Does NOT add webhook handler changes.
- Does NOT send receipts automatically from `runSessionPaymentCharge`. The receipt action is a SEPARATE practitioner click. The spec is explicit: "Do not send automatically from PR #173 execution yet."
- Does NOT add refund or chargeback handling. The receipt body says refunds are not enabled yet.
- Does NOT calculate tax. The receipt body says no tax calculation is included.
- Does NOT add SMS or any phone-based receipt.
- Does NOT touch `manual_fee_charge_attempts` or the legacy receipt-less fee runtime.
- Does NOT add a client-portal receipt surface. Receipts are sent only to `clients.email`.

**Reason labels (the reason-agnostic map):**

```text
session_payment        -> "Session payment"
late_cancellation_fee  -> "Late cancellation fee"
no_show_fee            -> "No-show fee"
<anything else / null> -> "Payment"      (calm fallback; never renders "undefined")
```

The fallback is the future-proofing piece: when a future PR adds a fourth canonical reason, the receipt renders "Payment" until the label map is updated, never crashing the email send.

**Alternative considered:** auto-send the receipt from `runSessionPaymentCharge` on the `succeeded` outcome. Rejected per the spec: "Do not send automatically from PR #173 execution yet unless you explicitly justify it and it remains test-mode only." The deliberate practitioner click keeps the loop simple, testable, and easy to reason about; an auto-send path can be a future PR once the receipt copy and dedup mechanism have proved themselves in production.

**Honest non-claims:** no new Stripe call, no live mode, no refund, no SMS, no client-portal receipt UI, no manual_fee touch, no automatic send. Stripe gates intact (2 allowlisted `paymentIntents.create`; 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string). Migration ledger advanced to 0076 because receipt state must persist for refresh-survival and atomic dedup; no other migration in this PR.

**PR #175 patch (2026-06-08, before merge): silent-success bug on DB-update failure after successful email send.**

Code review caught that `sendPaymentChargeReceipt` was returning `{ ok: true, status: "sent" }` when `sendEmailSafely` succeeded but the follow-up UPDATE stamping `receipt_status='sent'` then failed. The email was in the client's inbox, the ledger row stayed pinned at `'sending'`, and no ops_alert fired. A practitioner reading the UI would see the calm in-flight notice while believing the system was self-healing. A second click on a future render would silently re-send.

The patch:

1. Adds `sent_but_record_update_failed` as a new literal in `SendPaymentChargeReceiptResult` and in the action's `SendPaymentReceiptActionResult` discriminated union. The reason is distinct from `database_error` (which is reserved for pre-claim load failures) so the UI can render the correct warning.
2. Replaces the post-send-write-failure branch in `sendPaymentChargeReceipt` with a `recordOpsAlert({ severity: "critical", event: "payment_receipt_sent_record_update_failed", ... })` call followed by `return { ok: false, reason: "sent_but_record_update_failed", message: "The receipt email may have been sent, but Hone could not record it. Do not send again until this is checked.", emailTo: clientEmail }`. The `safeDetails` carries `attempt_id`, `charge_reason`, `receipt_email_to`, and `db_code` for operator reconciliation.
3. In `ReceiptSubPanel` the form submit handler is now `if (r.ok) { setLocalSent(...); return; } setError(r.error)` -- explicitly gated. The warning copy from the action surfaces in the error slot; it does NOT flip the local "already sent" success state. A future refactor that loses this gate is now a deliberate decision documented by an inline comment ("setLocalSent fires ONLY when r.ok === true").
4. `receipt_sent_at` is only stamped when the DB UPDATE succeeds. The new branch never claims a sent timestamp it cannot persist.

Source-grep tests added in `tests/lib/billing/payment-receipt-source.test.ts` (5 tests) pinning the new literal, the new return shape, the warning message, the critical ops_alert event name + severity, and the safeDetails payload. UI tests added in `tests/app/sessions/receipt-ui.test.ts` (3 tests) pinning the `if (r.ok)` guard and the explanatory comment. Validators rerun green: 961 → 969 tests pass; `tsc --noEmit` clean; `npm run lint` clean (the two pre-existing unrelated warnings unchanged); `npm run build` clean; `node scripts/check-stripe-gates.mjs` unchanged (still 2 allowlisted `paymentIntents.create` + 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string + zero `charges.create`/`refunds.create`/`checkout.sessions`); `git diff --check` clean. No new migration, no new Stripe call, no live-mode change, no refund, no webhook, no SMS, no client-portal UI.

**Post-merge receipt smoke status (2026-06-08, deferred).** The smoke is documented but not yet exercised end-to-end in prod. During gate-setup I found a stale `client_payment_methods.card_authorization_signature_id` pointer on the only card-on-file client (`My Studio`, client `910b9fb2-...25a1`): the latest signed-current signature against the live `card_authorization` template is `cd3af5cb-...a278` (signed 2026-06-08 19:37:18 against template version 1), but the card row was added 2026-06-04 and still carries `card_authorization_signature_id = a6b1fdbe-...0dd4` against an older template body. The code-level gate (`getCardAuthorizationStatus`) reads the latest signature and would let Prepare proceed; the operator-level rule of "the card row's authorization pointer is the signature being authorized" does not pass. The smoke is paused; the full finding is recorded as `docs/16` §5.11 ("Stale `client_payment_methods.card_authorization_signature_id` pointer (audit-trail blocker)") with two proposed fixes (pointer refresh on re-sign + backfill, or gate-time tightening). The PR #175 code itself is provably correct against the test suite and against the structural Stripe gates; the smoke gap is a pre-existing prod-data condition that the receipt path surfaced, not a PR #175 regression.

### Session payment UX hardening, no schema change (PR #174)

**Decision (2026-06-08):** Refactor `SessionPaymentPrepareCard` so every post-refresh state (succeeded, failed, pending_stripe, ready, cancelled, blocked) renders rich detail driven by the persisted `payment_charge_attempts` row. Widen the eligibility helper's SELECT + the `SessionPaymentExistingAttemptSummary` type to carry the post-execute fields (`stripe_payment_intent_id`, `stripe_charge_id`, `charged_at`, `failed_at`, `failure_code`, `failure_message_safe`). Add dedicated per-status subcomponents (`ReadyPanel`, `PendingPanel`, `SucceededPanel`, `FailedPanel`, `CancelledPanel`, `BlockedAttemptPanel`) so the dispatch logic is one switch on `attempt.status`. No new Stripe call. No live-mode change. No webhook. No SMS/email. No client-portal change. No migration; ledger stays at 0075.

**Why:** PR #173 shipped Stripe test-mode execution but the post-refresh rendering of `succeeded` rows fell through to a bare existing-attempt panel showing only `status` label + amount + created_at. The PaymentIntent id, Charge id, charged-at timestamp, failure message, and "Stripe test mode" disclaimer were only visible during the in-session React local state (the `executeSuccess` panel) and were lost on reload. Chloe needs to be able to refresh the session detail page and immediately see what state the test charge is in and what Stripe ids the attempt produced -- that is the load-bearing readability gap PR #174 closes before receipts, refunds, or live mode are touched.

**Architecture:**

- `AttemptStatusPanel` is the single dispatcher; switches on `attempt.status` and returns one of the six per-status subcomponents (plus `UnknownStatusPanel` as a render-anything safety net for a future status enum value).
- React local state (`executeSuccess`, `prepareJustSucceeded`) is now used ONLY for in-session feedback during the same render cycle as the action submit. The persisted row drives every other render path. A refresh always shows the persisted state.
- The latest active attempt (`status in ('ready', 'pending_stripe', 'succeeded')`) takes the active-row slot; older terminal attempts surface in the `AttemptHistory` `<details>` panel.

**Per-status copy contracts (each pinned by source-grep tests):**

- **Ready** ("Session payment prepared" heading + amount + status + prepared timestamp + the "Stripe test mode" amber sub-panel carrying the Run test charge button with its two-click confirm).
- **Pending Stripe** ("Test charge pending" + may-need-manual-review copy + PaymentIntent id if present; never renders the Run button).
- **Succeeded** ("Test charge succeeded" + amount + charged_at + PaymentIntent id + Charge id + explicit "This was a Stripe test-mode charge. No live card was charged. No receipt was sent in this PR.").
- **Failed** ("Test charge failed" + failure_message_safe + failure_code + failed_at + PaymentIntent id if present + "Prepare a new session payment attempt if you need to try again." -- failed is terminal in PR #173).
- **Cancelled / Blocked** calm name-only panels with "prepare a new attempt" guidance; no charge actions.

**Forbidden copy (pinned by negative source-grep tests):** "Pay now", "Charge card", "Collect payment", "Payment complete", "Live payment", "Receipt sent". The succeeded heading says "Test charge succeeded" specifically because live mode is not enabled.

**What this PR does NOT do:**

- Does NOT enable live payments. Three structural dormancy guards from PR #168 intact + PR #171's `payment_charge_attempts_livemode_false_check`.
- Does NOT add or remove any `paymentIntents.create` call site (still 2, both allowlisted).
- Does NOT add `charges.create`, `refunds.create`, or `checkout.sessions` (still zero).
- Does NOT add webhook handler changes. Manual reconciliation for stuck `pending_stripe` rows still works via the existing PR #173 reconciliation branch on the next click of an action.
- Does NOT add receipt email. The `SucceededPanel` explicitly notes the receipt path is deferred.
- Does NOT add refund or cancellation actions. The `CancelledPanel` exists for future-cancel rows; the action is not in this PR.
- Does NOT change UI copy on the 7 "Test mode only" strings tracked by PR #168.
- Does NOT add a client-portal payment UI.
- Does NOT add SMS or email behavior.
- Does NOT touch `manual_fee_charge_attempts` or any shared payments code path outside the session payment surface.
- Does NOT modify any DB table, RLS policy, RPC, or index. No new migration; latest in tree remains `0075_claim_session_payment_charge_attempt.sql`.

**Alternative considered:** keep React local state as the source of truth and just enrich the in-session panels. Rejected because the entire UX problem is that local state evaporates on refresh; the cleanest fix is to make the persisted row drive every render.

**PR #174 patch (2026-06-08, before merge):** the initial PR #174 logic computed `latestAttempt` as `existingAttempts.find(ACTIVE) ?? existingAttempts[0] ?? null` and gated the Prepare form on `!latestAttempt`. A `failed` / `cancelled` / `blocked` latest row therefore took over the active slot AND hid the Prepare form, leaving the practitioner with no Run button and no way to prepare a new attempt -- a dead end. The patch separates `activeAttempt` (drives the main `AttemptStatusPanel` + blocks new prepare, scoped to the same `ready / pending_stripe / succeeded` set the PR #172 partial-unique index `payment_charge_attempts_active_session_payment_uniq` already pins) from `latestHistoricalAttempt` (context only). When the latest historical row is `failed / cancelled / blocked` and there is no active attempt, a new `PreviousTerminalCallout` renders the per-status detail panel above the Prepare form so the practitioner sees what went wrong AND can prepare a new attempt. The `BlockedPanel` (no-eligibility) branch's gating also moved from `!latestAttempt` to `!activeAttempt`. Twelve new patch-specific tests pin the `activeAttempt` / `latestHistoricalAttempt` separation, the absence of `failed / cancelled / blocked` from `ACTIVE_STATUSES`, the new `TERMINAL_RETRY_STATUSES` set, and the `PreviousTerminalCallout` shape.

**Honest non-claims:** no schema change, no Stripe call added, no new ops_alert event, no live-mode flag change, no Stripe key rotation, no RLS / RPC / index work, no SMS / email behavior, no webhook handler change, no portal change. Stripe gates intact (2 allowlisted `paymentIntents.create` sites; 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string).

### Session payment EXECUTE flow, test mode only (PR #173, migration 0075)

**Decision (2026-06-08):** Add the test-mode execution helper that takes a prepared `session_payment` row (PR #172) and creates ONE Stripe PaymentIntent on the connected account against the saved test card. The helper mirrors `runManualFeeCharge` (PR #146) almost line-for-line, adapted for `payment_charge_attempts`. Migration 0075 adds the atomic claim RPC `claim_session_payment_charge_attempt` (mirror of the manual fee `claim_manual_fee_charge_attempt` from migration 0065). The Stripe gate script + the live-mode blocker test are updated to allow exactly 2 allowlisted `paymentIntents.create` call sites (`lib/billing/manual-fee-charge.ts` and the new `lib/billing/session-payment-charge.ts`). No live mode. No receipt. No refund. No webhook business logic. No SMS or email. `manual_fee_charge_attempts` runtime untouched.

**Why now:** PR #172 shipped the prepare half; this PR ships the execute half. Sequencing prepare-first / execute-second is the same pattern manual_fee used (PR #145 prepare → PR #146 execute) and lets each PR's audit focus on a smaller surface. With execution behind a (now-fourth) named CHECK constraint + the same three structural dormancy guards from PR #168, the test-mode charge path is fully end-to-end exercisable in the studio detail page without any move toward live mode.

**Migration 0075 (applied to prod before this PR commits):**

- `claim_session_payment_charge_attempt(p_attempt_id uuid, p_practitioner_id uuid, p_idempotency_key text) returns table(...)` with the row-level FOR UPDATE lock, conditional UPDATE on status='ready', deterministic idempotency key stamping, reason guard (`charge_reason='session_payment'`), live-mode guard (`stripe_livemode = false`), practitioner-active-in-studio gate, and the six-result vocabulary (`claimed / already_succeeded / already_pending / not_found / not_authorized / not_ready`).
- `SECURITY DEFINER` + `search_path = pg_catalog, pg_temp`.
- `REVOKE EXECUTE FROM public, anon, authenticated; GRANT EXECUTE TO service_role`.
- Production verification: `proname = 'claim_session_payment_charge_attempt'`; service_role EXECUTE granted; `payment_charge_attempts` row count still 0 (table behavior unchanged by the migration; the RPC is purely a code-path addition).

**Execution flow:**

1. `inferStripeLivemode() === true` -> early return `live_mode_blocked`.
2. Load the attempt row by id + studio_id. Reason guard (`charge_reason='session_payment'`), live-mode row guard, status short-circuits (`succeeded` no-op; `failed / cancelled / blocked` refused).
3. **PR #170 current-card-authorization recheck.** `getCardAuthorizationStatus({studioId, clientId})` must return `signed_current` AND `signatureId === attemptRow.card_authorization_signature_id`. A signature that became `signed_out_of_date` between prepare and execute (because the studio edited the template) blocks the charge.
4. Lineage recheck via `loadCardAndVerifyLineage`: card row still active + livemode=false + studio matches + signature matches + Stripe ids match the prepared attempt + studio's connected account unchanged + customer mapping intact.
5. **Atomic claim** via `claim_session_payment_charge_attempt` RPC. The RPC takes the row lock, transitions `status='ready' -> 'pending_stripe'`, and stamps `stripe_idempotency_key = 'hone:session_payment:<attemptId>:v1'` in one transaction. Stripe is NOT called before the claim returns `claimed`.
6. `stripe.paymentIntents.create({amount, currency: 'cad', customer, payment_method, confirm: true, off_session: true, description, metadata}, {stripeAccount, idempotencyKey})`. No `application_fee_amount`, no `receipt_email`, no `statement_descriptor_suffix`.
7. On `succeeded`: write status='succeeded', PI id, latest_charge id, stripe_status, `charged_at=now()`. On Stripe error: write status='failed', failure_code, failure_message_safe (sanitised), `failed_at=now()`; record an `ops_alert` with severity `critical` for `authentication_required` / warning otherwise. On unknown error after claim: leave row `pending_stripe`, record a `severity=critical` ops_alert (`session_payment_needs_manual_review`), surface `needs_manual_review` to the UI.

**Stripe PaymentIntent metadata (verified by source-grep tests):**

```text
hone_studio_id
hone_client_id
hone_session_id
hone_appointment_id  (may be empty string if session is not appointment-linked)
hone_session_payment_charge_attempt_id
hone_charge_reason  (= 'session_payment')
hone_card_authorization_signature_id
hone_environment  (= 'test')
```

**UI changes:** `SessionPaymentPrepareCard` gains the `Run test charge` button on the existing-attempt branch when the active attempt status is `ready`. Two-click confirm pattern (first click changes the button label to `Confirm: run test charge ($X)`; second click submits with `confirm_charge='true'`) to guard against accidental double-taps. The button copy explicitly names Stripe test mode and notes "No live card is charged." On success, the panel shows the PaymentIntent + Charge ids with a note that "No receipt was sent in this PR." On failure, a clear practitioner-facing error message; raw Stripe errors are sanitised before display. The UI deliberately does NOT include any "Pay now" or "Charge card" or "Collect payment" label.

**Stripe gate update (deliberate; documented):**

- `scripts/check-stripe-gates.mjs`: `paymentIntents.create` allowlist expanded from 1 to 2 files (`lib/billing/manual-fee-charge.ts` + `lib/billing/session-payment-charge.ts`); `exactly: 2`. The other negative gates (`charges.create / refunds.create / checkout.sessions / set_studio_require_card_on_file`) remain at 0. `STRIPE_ALLOW_LIVE_MODE=true` remains allowlisted to `lib/stripe/server.ts` only.
- `tests/lib/billing/live-mode-blockers.test.ts`: the per-file count assertion is now mirrored for the new file so a future PR that adds a second call site to either file is caught. The idempotency-key shape assertions cover both `hone:manual-fee:<attemptId>:v1` and `hone:session_payment:<attemptId>:v1`.

**What this PR does NOT do:**

- Does NOT enable live payments. The three structural dormancy guards from PR #168 are intact + PR #171's `payment_charge_attempts_livemode_false_check`.
- Does NOT add or remove `STRIPE_ALLOW_LIVE_MODE` references (still 1 allowlisted in `lib/stripe/server.ts`).
- Does NOT add `charges.create`, `refunds.create`, or `checkout.sessions` (still zero).
- Does NOT add webhook business logic beyond the existing `setup_intent.*` arm.
- Does NOT send a receipt email. Receipt path is deferred.
- Does NOT support failed-row retry. A `failed / cancelled / blocked` row stays terminal; the practitioner prepares a new attempt if needed.
- Does NOT add refund or chargeback handling.
- Does NOT add tax calculation.
- Does NOT change UI copy on the 7 "Test mode only" strings tracked by PR #168.
- Does NOT add a client-portal payment UI.
- Does NOT add an SMS or email side effect.
- Does NOT touch `manual_fee_charge_attempts`.

**Alternative considered:** ship execute + receipt + refund + webhook reconciliation in one PR. Rejected because each of those introduces its own surface area for live-mode risk; bundling them would force the audit to cover all four at once. The PR #172 / PR #173 split keeps each PR's audit focused, with the execute helper being the first PR that actually moves money in test mode.

**Honest non-claims:** no live charge, no receipt, no refund, no SMS, no email, no webhook business logic, no UI copy refresh on the existing test-mode strings. Stripe gates updated deliberately to allow 2 allowlisted `paymentIntents.create` call sites. PR #181 (the next session-payment-track PR per the docs/16 §12.13 sequence) covers receipts + refunds + webhook reconciliation.

### Session payment PREPARE flow, test mode only (PR #172)

**Decision (2026-06-08):** Ship the first runtime writer of `public.payment_charge_attempts`. A practitioner viewing a session detail page can now Prepare a `session_payment` charge attempt by submitting an amount + internal note. The action inserts one row with `charge_reason='session_payment'`, `status='ready'`, `stripe_livemode=false`. **No Stripe call. No PaymentIntent. No charge. No refund. No webhook. No SMS or email.** This PR ships the audit-row part of the runtime; the execution helper (the `runManualFeeCharge` counterpart that calls `paymentIntents.create`) is deliberately deferred. No new migration: PR #171's table is the destination; the prepare path is pure application code.

**Why now:** PR #169 settled the product model. PR #170 shipped the current-version card-authorization gate. PR #171 shipped the dormant canonical ledger. PR #172 is the first surface where a practitioner can actually mark "this session should be charged" without coupling to the future Stripe execution path. Shipping prepare first means (a) the audit trail starts accumulating real attempt rows under test mode so an operator can verify the lineage end-to-end without money moving, and (b) the execution helper PR can focus narrowly on the Stripe code path without also having to design the practitioner UI.

**Chargeability proxy (the load-bearing eligibility rule):**

PR #172 audit found there is no `sessions.completed_at` or `sessions.status` column in the schema today. The safest existing proxy is the three-clause rule:

```text
sessions.appointment_id IS NOT NULL
AND appointments.status = 'completed'
AND sessions.started_at IS NOT NULL
```

The proxy is documented in the eligibility helper header and in docs/02. Freeform (unlinked) sessions are deferred to a future product decision -- migration 0073's `reason_shape_check` deliberately left `appointment_id` OPTIONAL for `session_payment` so a later relaxation of the proxy does not need a schema change.

**Inserted row shape (mirrors PR #171 invariants exactly):**

```text
studio_id                          server-resolved from practitioner session
charge_reason                      'session_payment'
client_id                          eligibility.client.id (NOT from form)
appointment_id                     stamped when session is appointment-linked
session_id                         from URL path; required by reason_shape_check
created_by_practitioner_id         server-resolved
amount_cents                       practitioner-confirmed via amount_dollars
                                   form field; parsed Math.round(n * 100);
                                   bounded > 0 AND <= 200000 by the same
                                   CHECK + a pre-DB guard in the action
currency                           'cad'
status                             'ready'
client_payment_method_id           from active card row (livemode-scoped)
card_authorization_signature_id    from PR #170 signed_current branch
stripe_account_id                  from active card row
stripe_customer_id                 from active card row
stripe_payment_method_id           from active card row
stripe_livemode                    false (explicit; CHECK guarantees it)
internal_note                      required form field; bounded 1..1000 chars
```

Fields the prepare action deliberately leaves null (populated by the future execution PR): `stripe_payment_intent_id`, `stripe_charge_id`, `charged_at`, `failed_at`, `cancelled_at`. The row's nullability shape makes "prepared" structurally distinguishable from "charged" without a separate status enum value.

**Eligibility gates (each blocks with a practitioner-facing message):**

1. Session exists in this studio (studio_id + session_id).
2. Session is appointment-linked AND appointment is `status='completed'`.
3. Session has `started_at` (not just scheduled but never opened).
4. Active `client_payment_methods` row for (studio, client, livemode).
5. `getCardAuthorizationStatus` returns `signed_current` (PR #170 gate).
6. `studio_payment_settings` row exists with `stripe_account_status='enabled'` and `stripe_livemode=false`.
7. No existing active `payment_charge_attempts` row for (studio, session, reason) where status in (ready, pending_stripe, succeeded).

The duplicate check has the partial-unique index `payment_charge_attempts_active_session_payment_uniq` (from migration 0073) as a structural backstop. The action catches Postgres code 23505 and returns the same calm duplicate-message that the pre-INSERT eligibility check would have returned.

**UI location:** Session detail page (`app/(app)/clients/[id]/sessions/[sessionId]/page.tsx`), immediately after `SessionInfoCard`. The PR #172 audit confirmed this is the natural slot: the session is the canonical treatment record, the price is already entered here via `SessionInfoCard`, and the appointment detail page is reserved for appointment-level state (cancellation, no-show fees). A new `SessionPaymentPrepareCard` client component renders the eligibility state + the form. The card explicitly tells the practitioner this is a test-mode audit record only, and does NOT render any "Pay now" or "Charge card" affordance.

**Card_authorization template state (PR #170 carry-over):** still at `version=1` for both pilot studios. Existing client signatures match `version=1` and therefore satisfy `signed_current`, so the prepare flow is functional today against the placeholder body. Once Chloe edits the body via Settings (which bumps `version` to 2), client signatures will become `signed_out_of_date` and the prepare card will surface the re-sign block; this is the PR #170 contract holding correctly under the new prepare path.

**What this PR does NOT do:**

- Does NOT enable live payments. The three dormancy guards remain.
- Does NOT add or remove any `paymentIntents.create` call site. Still exactly 1 in `lib/billing/manual-fee-charge.ts`.
- Does NOT add `refunds.create`, `charges.create`, or `checkout.sessions` (still zero).
- Does NOT add any webhook handler change. The `setup_intent.*` arm and the `payment_intent.*` dormancy posture are byte-for-byte identical.
- Does NOT touch `manual_fee_charge_attempts`. The proven test-mode runtime stays untouched; cancellation + no-show fees keep using the legacy table until a separate unification PR.
- Does NOT modify any database table, RLS policy, RPC, or index. No new migration; latest in tree remains `0074`.
- Does NOT add a client-portal payment UI. Sessions are practitioner-only.
- Does NOT add a "Pay now" or "Charge card" button. The prepare card explicitly omits both.
- Does NOT change UI copy on the 7 "Test mode only" strings tracked by PR #168 / PR #171 (those remain until the live-mode-enablement PR removes them).
- Does NOT add SMS or email behavior.

**Alternative considered:** Build the execution helper (`runChargeAttempt`) and the prepare flow in the same PR. Rejected because (a) bundling them means the Stripe code path lands without separate review, and (b) the prepare row gives the operator a real audit surface that can be exercised end-to-end in test mode before any Stripe call exists -- a deliberate "audit-first" sequencing that mirrors how manual_fee shipped (PR #145 prepare, then PR #146 charge).

**Honest non-claims:** no schema change, no Stripe call, no live-mode flag change, no Stripe key rotation, no RLS / RPC / index work, no SMS / email behavior, no webhook handler change, no portal change. Stripe gates intact (1 allowlisted `paymentIntents.create`, 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string). The `payment_charge_attempts` table is no longer "dormant" in the strictest sense -- the prepare flow can now write `status='ready'` rows -- but no money has moved through Hone and `stripe_livemode=false` rows are the only ones the CHECK constraint permits.

### Canonical payment_charge_attempts ledger, dormant (PR #171, migration 0073)

**Decision (2026-06-08):** Create the new dormant canonical `payment_charge_attempts` table in production via migration 0073. Leave `manual_fee_charge_attempts` runtime fully untouched. Schema only -- zero rows, no PaymentIntent code, no charge UI, no live-mode change. The future `runChargeAttempt` helper (PR #181) writes the first rows in test mode for `session_payment`; until the legacy `manual_fee_charge_attempts` is unified into or formally deprecated against this ledger, runtime fee charging stays on the legacy table.

**Why now:** PR #169 settled the product model (charge after session, three canonical reasons, one charge primitive). PR #170 shipped the current-version card-authorization gate. The next dependency in the live-payments track is the schema destination for the charge primitive's result rows. Building the helper before the table forces a parallel placeholder; building the table dormant first lets PR #181 write the helper against a stable schema with no further migration coupling.

**Schema highlights (full detail in `supabase/migrations/0073_payment_charge_attempts.sql` and docs/09):**

- **charge_reason enum** carries exactly three values (`session_payment`, `late_cancellation_fee`, `no_show_fee`). A fourth requires a product decision recorded here first.
- **payment_charge_attempts_reason_shape_check** is the load-bearing per-reason CHECK from the patched PR #171 prompt: `session_payment` requires `session_id` (and `appointment_id` is OPTIONAL so a future chargeable freeform session does not need a migration to relax the FK); `late_cancellation_fee` and `no_show_fee` require `appointment_id` AND forbid `session_id`.
- **Status enum** mirrors `manual_fee_charge_attempts` exactly (`ready / blocked / cancelled / pending_stripe / succeeded / failed`). No parallel state machine; the future `runChargeAttempt` reuses the proven transitions.
- **amount_cents** bounded `> 0 AND <= 200000` (the $2,000 CAD ceiling is intentionally larger than manual_fee's $200 cap because session payments represent the full treatment amount; documented in the migration header).
- **payment_charge_attempts_livemode_false_check** is the NAMED dormancy guard the future live-enablement PR drops deliberately. The constraint name is the search anchor for the live PR's audit.
- **card_authorization_signature_id** is **nullable** in this dormant PR. Execution PR (PR #181) must refuse to charge unless `lib/consent/current-card-authorization:getCardAuthorizationStatus` returns `signed_current` AND stamps the matching signature id on the row at prepare time.
- **FK ON DELETE rules**: `studio_id` CASCADE (matches manual_fee + studio_payment_settings + client_payment_methods); composite client + appointment + created_by_practitioner RESTRICT (matches manual_fee); `session_id` RESTRICT (initial 0073 declared SET NULL; corrected via migration 0074 because SET NULL contradicted the reason_shape_check requiring session_payment rows to have non-null session_id -- see PR #171 patch note below). All financial-audit FK pointers preserve their target rows; no charge attempt is ever orphaned.
- **12 secondary indexes + 4 partial uniques** support eligibility, dashboard, idempotency, and duplicate-prevention. Partial indexes save space on the nullable columns. The active-fee-per-appointment + active-session_payment-per-session uniques are the structural backstop for the application-layer duplicate guard.
- **RLS** enabled with studio-member SELECT only; no INSERT / UPDATE / DELETE policy. Service-role admin client owns mutations.

**Temporary two-table state (REQUIRED ACKNOWLEDGEMENT):**

- `manual_fee_charge_attempts` remains the existing test-mode runtime ledger for `late_cancel` and `no_show` fee preparations.
- `payment_charge_attempts` is the future canonical charge ledger for all three reasons.
- **The two-table state is TEMPORARY.** It exists to keep PR #171 schema-only without coupling to the manual_fee migration.
- **Runtime fee charging must be migrated or unified onto `payment_charge_attempts` before live `late_cancellation_fee` or `no_show_fee` charging ships.** A separate future PR (TBD; estimated PR #178 in the docs/16 sequence) is responsible for that unification (or formal deprecation of `manual_fee_charge_attempts` if there are no live rows to migrate). The unification PR must land BEFORE the live-mode CHECK relax for fees.

**Gate (do not bypass):**

```text
Before live late_cancellation_fee or no_show_fee charging,
manual_fee_charge_attempts must either be migrated into
payment_charge_attempts or formally deprecated with no
live-money rows.
```

**What this PR does NOT do:**

- Does NOT enable live payments. Three structural dormancy guards from PR #168 unchanged; PR #171 adds a fourth (the named CHECK on the new table) that the future live PR must drop deliberately.
- Does NOT add any `paymentIntents.create`, `refunds.create`, `charges.create`, or `checkout.sessions` call site. Still exactly 1 `paymentIntents.create` in `lib/billing/manual-fee-charge.ts`.
- Does NOT add or modify any code that reads or writes the new table. The table is schema-only; the runtime is blind to it.
- Does NOT touch `manual_fee_charge_attempts`. No ALTER, no UPDATE, no DROP, no RENAME. Runtime fee path is byte-for-byte identical.
- Does NOT modify any Stripe key, env var, webhook secret, or Vercel config.
- Does NOT change SMS / email / webhook / RLS-on-other-tables behavior.

**Alternative considered:** rename `manual_fee_charge_attempts` to `payment_charge_attempts` in this PR (the Option B sketch from docs/16 §12.12). Rejected for PR #171 because the patched prompt is explicit: "Leave existing manual_fee_charge_attempts runtime untouched." A rename would require backfilling `charge_reason`, relaxing the manual_fee CHECK on `charge_type`, updating every read/write site, and re-running every test that pins the legacy table shape. Option A (separate table) keeps the proven test-mode runtime stable while the canonical schema lands; the unification can be a deliberate follow-up PR with its own data-migration audit.

**PR #171 patch (2026-06-08, before merge):** the initial 0073 declared `session_id uuid references public.sessions(id) on delete set null`. PR review caught the contradiction with `payment_charge_attempts_reason_shape_check`: for a `session_payment` row, an ON DELETE SET NULL would try to null `session_id` and then fail the CHECK -- functionally a confusing hidden RESTRICT. Migration 0074 (`0074_payment_charge_attempts_session_fk_restrict.sql`) is the corrective ALTER that drops and re-adds the FK with `ON DELETE RESTRICT`. 0073's literal source text is preserved as the historical record (it represents what was actually applied on 2026-06-08); 0074 is the layered correction. The combined effective state after 0073 + 0074 has `session_id` FK with `ON DELETE RESTRICT`. No row-data change (table dormant; 0 rows in production both before and after the patch). The migration discipline lesson recorded here: when a migration is already applied to production and a fix is needed, ship a corrective migration rather than retroactively rewriting the original (matches the [[feedback_apply_additive_migration_before_merge]] discipline; layered corrections are auditable, retroactive rewrites are not).

**Honest non-claims:** no charge-execution code, no eligibility helper for session_payment, no UI, no webhook handlers, no live-mode flag change, no Stripe key rotation, no SMS / email behavior. Stripe gates intact (1 allowlisted `paymentIntents.create`, 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string). The new table is dormant in production (0 rows confirmed post-migration).

### Card authorization wording + current-version re-sign gate (PR #170)

**Decision:** Ship the product-ready DRAFT card_authorization body as a TS constant + add a current-version signature gate so old signatures against the production placeholder body (`"test"`, 4 characters) stop counting once the live template is updated. Do NOT mutate production rows in this PR; the operator step (Chloe pasting the body via Settings -> Consent forms) is documented and is what bumps the template version. No live payments enabled. No migration: `client_consent_signatures.template_version` has existed since migration 0057, so the gate is pure application code.

**Why:** PR #168 readiness review found Willow's `card_authorization` template body is literally `"test"`. PR #170 audit confirmed both studios (Willow Electrolysis and Sam's "My Studio") carry the same placeholder, both with one client signature each against it. PR #169 added a third charge reason (`session_payment`) that an existing draft only covering cancellation + no-show fees would not authorize. Without a current-version gate, simply updating the body would still let those historical "test" signatures satisfy the authorization clause for live charges, which is the exact scenario the readiness review flagged as a P0 blocker.

**Key design choices:**

- **DRAFT in code, not in DB.** The product-ready body lives at `lib/consent/card-authorization-draft.ts:CARD_AUTHORIZATION_DRAFT_V1_BODY` (around 2.5 kB). It covers all 7 spec topics: card on file (Stripe stores card; Hone/studio do not store full PAN or CVC; card can be replaced or removed); completed-session off-session charges (practitioner-confirmed amount; off-session after appointment ends; receipt to client); late cancellation fees (per studio's cancellation policy); no-show fees (per studio's no-show policy); receipts / refunds / disputes (high level; explicit "does not waive my dispute rights" line so no chargeback waiver); payment processing and privacy (Stripe is the processor; record retention; studio privacy policy); scope and revocation (saved card; until replaced / removed / revoked in writing). The constant is the audit reference; once Chloe edits the row via Settings, the DB row is the runtime source of truth.

- **No claim of legal approval.** The constant's header comment is explicit: this is a DRAFT for legal review, not approved wording. The docs do not say "legally approved." A separate legal-review track (Chloe + counsel) decides whether to accept the draft as-is or edit it via Settings; either path bumps the version.

- **Operator step, not auto-update.** The PR does NOT run a SQL `UPDATE` on production rows. The auto-mode safety classifier refused the direct UPDATE, and the user's preferred path is the same versioned update path that Settings uses. The operator step (paste body, change title from "test" to "Card on file authorization", save) is documented in docs/05 and verifiable post-deploy via the existing supabase verification SQL.

- **Current-version gate.** New helper `lib/consent/current-card-authorization.ts:getCardAuthorizationStatus` returns one of four discriminated kinds: `no_live_template`, `unsigned`, `signed_out_of_date`, `signed_current`. The helper is used by `createCardSetupIntentAction` (refuses SetupIntent unless `signed_current`). The same comparison (signature.template_version vs live template.version) is inlined in `lib/billing/manual-fee-eligibility.ts` so manual fee preparation also requires current-version authorization. Pre-PR the action accepted any prior version, with a comment promising "A future PR can opt into 'require latest version' once the UX of re-sign-on-edit is settled" -- this is that PR.

- **Card-authorization-only re-sign rule.** The portal `unsignedConsentTemplates` filter special-cases `card_authorization`: an out-of-date signature surfaces the template back into the Review and sign list so the existing PortalConsentForms UI handles the re-sign. Other consent types (treatment_consent, photo_consent, policy_acknowledgement) do NOT force re-sign on every edit; only card_authorization gates downstream money-related actions and gets the strict gate.

- **Historical signatures preserved.** The snapshot model from migration 0057 keeps every signature immutable (title, body, version, SHA-256 hash). The FK `client_payment_methods.card_authorization_signature_id` is unchanged. PR #170 only changes which signatures count for NEW live work; old ones remain as audit evidence.

- **Practitioner UI surfaces the state.** `components/payment-method-card.tsx` gains two new branches: `AuthorizationOutOfDateBlock` (no active card; client must re-sign) and `AuthorizationOutOfDateWarning` (active card present; warns the existing card is preserved but new live work is gated until re-sign). The client profile page (`app/(app)/clients/[id]/page.tsx`) computes the `cardAuthorizationOutOfDate` boolean from already-loaded data and also tightens the template lookup to require `is_live=true` (matching PR #167's portal-side rule).

- **Portal UI dedicated re-sign block.** `showCardAuthorizationOutOfDate` is a new gate (alongside the existing PR #158 `showCardAuthorizationNeeded`). When true, the portal renders a calm "Card authorization was updated" block in Needs you with explicit re-sign copy and a `Review updated authorization` deep-link to the unsigned-forms section. The block mirrors the visual shape of PR #158 so the client sees a consistent affordance.

**What this PR does NOT do:**

- Does NOT mutate the production `consent_form_templates` rows. The operator step is documented; the actual content update happens via Settings UI after deploy.
- Does NOT enable live payments. The three dormancy guards from PR #168 are unchanged.
- Does NOT add or remove any `paymentIntents.create` call site. Still exactly 1 in `lib/billing/manual-fee-charge.ts`.
- Does NOT add or remove any `refunds.create` call site. Still 0.
- Does NOT modify any database table, RLS policy, RPC, or index. No new migration; latest in tree remains `0072_consent_templates_is_live.sql`.
- Does NOT modify any Stripe key, env var, webhook secret, or Vercel configuration.
- Does NOT change webhook handler behavior, manual fee charge logic, or SetupIntent creation logic (the `usage: "off_session"` parameter in `lib/stripe/setup-intent.ts:202` is unchanged).
- Does NOT change UI copy on the existing 7 "Test mode only" strings (PR #171 covers).
- Does NOT add any SMS or email behavior.
- Does NOT claim legal approval. The draft body explicitly does not claim legal review; the docs explicitly say legal approval is still required before live payments.

**Alternative considered:** Ship a migration that adds a computed `template_hash` comparison at the DB level via a trigger. Rejected because the snapshot model already records the hash, the comparison is pure business logic (not structural integrity), and the JS-side gate is easier to audit + test. A DB-level hash trigger would be belt-and-suspenders, not a load-bearing safety.

**Honest non-claims:** no schema change, no charge-execution code, no eligibility-helper restructure beyond the version comparison, no UI for session payment (that is PR #181), no webhook handlers, no live-mode flag change, no Stripe key rotation, no RLS / RPC / index work, no SMS / email behavior, no payment-policy change. The Stripe gates are intact (1 allowlisted `paymentIntents.create`, 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string).

### Session payment product model (PR #169, docs + guardrails only)

**Decision:** Define the product / payment architecture for live session payments before any money-moving code is written. Document the v1 model in a new §12 of `docs/16_LIVE_PAYMENTS_READINESS.md`, add the payment domain model to `docs/02`, and add guardrail tests that pin the doc contract. No code, no migration, no live-mode change.

**Why:** Chloe clarified that "no more cash" means she wants Hone to actually charge cards, not just collect cards on file. The three reasons she wants to charge are completed treatment sessions, late cancellations, and no-shows. The `late_cancellation_fee` + `no_show_fee` paths exist in test mode today (PR #145, PR #146); the `session_payment` path does not exist at all. Before building the session payment code, the product model has to be settled or the implementation drifts: charge after vs at booking, practitioner-confirmed amount vs auto-derived, one charge primitive vs parallel implementations, off-session card requirement, application fee posture, tax handling, paid-status derivation, merchant of record.

**Key v1 decisions:**

- **Charge after the session, not at booking.** Electrolysis final pricing varies by actual treatment time, area, judgement, discounts, and corrections; the booking price is a quote. Upfront-checkout is a different product (deposits, prepayments, refund-on-cancel rules, different Stripe flow) and is out of v1 scope.
- **Practitioner-confirmed amount.** Auto-charge from `services.price_cents`, appointment duration, session duration, treatment area, hair count, or machine settings is forbidden. The amount is entered or confirmed by the practitioner before any Stripe call.
- **One charge primitive, three reasons.** The `runManualFeeCharge` pattern (claim/lock + deterministic idempotency key + Stripe PaymentIntent + persisted attempt row + webhook reconciliation + ops_alert) is the contract every future charge path follows. The reason (`session_payment` / `late_cancellation_fee` / `no_show_fee`) is a parameter on the attempt row, NOT a separate money-moving implementation.
- **Off-session card requirement: already satisfied.** Audit confirmed `lib/stripe/setup-intent.ts:202` already creates SetupIntents with `usage: "off_session"`. Every card on file today can be charged later without the client present. No SetupIntent rework needed.
- **Card authorization wording: blocker.** Production query confirmed Willow's two `card_authorization` templates have `body = "test"` (4 chars). Before live charging, the body must explicitly authorize off-session charging for completed sessions, late cancellation fees, no-show fees, and the dispute / chargeback posture. CASL + PIPEDA + Ontario consumer-contract review required. This is PR #170 in the renumbered sequence (was PR #169 before this PR consumed the slot).
- **0% Hone platform fee in v1.** `studio_payment_settings.stripe_application_fee_bps` stays null. Studio is merchant of record; 100% of the captured amount (less Stripe processing) flows to the studio's connected account. Hone bills its subscription out of band, not through Stripe `application_fee_amount`.
- **No tax calculation in v1.** Practitioner enters the all-in gross amount; studio is responsible for tax. Stripe Tax integration deferred.
- **Paid status derived from charge rows.** No `appointments.paid` or `sessions.paid` boolean. Avoid dual-write drift between an in-app boolean and the actual evidence (the charge attempt row + Stripe PaymentIntent state).
- **Studio is merchant of record.** Receipt + statement descriptor identify the studio, not Hone. Disputes are filed against the studio's connected account.
- **Risk-ordered enablement: session_payment first, then late_cancellation_fee, then no_show_fee.** Lower dispute risk first; the client received a service, defended by chair-time evidence. No-show is highest risk (client did not receive treatment + reachable-evidence dependency) so it goes last. The DB CHECK constraint that blocks live writes is per-reason, not all-or-nothing.

**Schema sketch (informational, defers to future schema PR):** the audit recommended a separate `session_payment_charge_attempts` table; the spec preference (one charge primitive) argues for a unified `payment_charge_attempts` table with a `charge_reason` enum + nullable reason-specific fields. Both shapes are sketched in docs/16 §12.12; the schema PR (estimated #180, confirmed against the actual migration count at build time) picks the winner after its own audit. PR #169 does not commit to either shape.

**Renumbered PR sequence** (docs/16 §11 and §12.13 carry the canonical list):

```text
PR #169 (this PR)  -- product model + sequence reorganization
PR #170            -- legal review of card_authorization wording (was original PR #169)
PR #171            -- remove "Test mode only" UI copy + conditional dormancy disclaimer (was original PR #170)
PR #172            -- receipt email path (was original PR #171)
PR #173            -- refund code path + UI (was original PR #172)
PR #174            -- cancellation / no-show policy alignment if window-based (was original PR #173)
PR #175            -- charge-path test coverage (was original PR #174)
PR #176            -- operator runbook + rollback plan (was original PR #175)
PR #177            -- payment_intent.* + charge.refunded + charge.dispute.* webhook handlers (was original PR #176)
PR #178            -- cancel + no-show DB CHECK relax (was original PR #177)
PR #179            -- session_payment track: new service_charge_authorization consent form_type
PR #180            -- session_payment track: schema migration (table or rename; schema-PR audit decides)
PR #181            -- session_payment track: eligibility + runSessionPaymentCharge + UI
PR #182            -- session_payment track: re-add "Mark complete" appointment-detail button
PR #183            -- session_payment track: DB CHECK relax for session_payment
Operator track     -- stripe_payouts_enabled=true via Stripe dashboard; application_fee_bps decision; live key rotation
```

**Why renumber instead of keeping the original sequence:** the existing docs/16 §11 listed PR #169 = "legal review of card_authorization wording." That PR has not happened. PR #169 is now used for the product model (this PR). Renumbering everything by +1 keeps the numbers monotonic with the actual sequence on GitHub. The docs tests from PR #168 (`tests/docs/live-payments-readiness.test.ts`) only assert that PR numbers #169 through #177 appear somewhere in docs/16; the renumber preserves that contract because the new sequence still contains every number in that range plus the new ones.

**Alternative considered:** ship the session payment code in PR #169 directly (skip the product-model doc PR). Rejected because (a) the architectural decisions above are load-bearing for the next 5+ PRs and need a written contract a reviewer can challenge before code lands, (b) Chloe's three charge reasons have different risk profiles and need explicit risk-ordering before any go-live, and (c) the existing manual fee infrastructure has subtle invariants (deterministic idempotency key shape, three-layer duplicate protection, ops_alert payload shape) that the session payment helper must reuse; a doc that names them explicitly reduces the risk of a parallel implementation that quietly drifts.

**What this PR does NOT do:**

- Does NOT enable live payments. The three dormancy guards remain.
- Does NOT modify any Stripe key, env var, webhook secret, or Vercel configuration.
- Does NOT add or remove any `paymentIntents.create` call site. Still exactly 1 in `lib/billing/manual-fee-charge.ts`.
- Does NOT add or remove any `refunds.create` call site. Still 0.
- Does NOT change webhook handler behavior, manual fee charge logic, or SetupIntent logic.
- Does NOT change UI copy. The 7 "Test mode only" strings remain (PR #171 covers).
- Does NOT change the card_authorization consent template (body still says "test"; PR #170 covers).
- Does NOT modify any database table, RLS policy, RPC, or index. No new migration. Latest in tree remains `0072_consent_templates_is_live.sql`.
- Does NOT add any SMS or email behavior.

**Honest non-claims:** no schema change, no charge-execution code, no eligibility helper, no UI for session payment, no webhook handlers, no live-mode flag change, no Stripe key rotation, no RLS / RPC / index work, no SMS / email behavior. The Stripe gates are intact (1 allowlisted `paymentIntents.create`, 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string). The product model is a written contract for the next PRs; PR #169 ships nothing executable.

### Live payments readiness review (PR #168, docs + guardrails only)

**Decision:** Conclude **NOT READY FOR LIVE PAYMENTS** after a thorough audit of every payment surface (Stripe Connect, card-on-file SetupIntent flow, card_authorization consent template, manual fee charge path, cancellation / no-show policy, receipts, refunds, webhook handlers, environment + config, existing tests). Publish the full audit + go/no-go checklist + 9-PR unblock sequence as `docs/16_LIVE_PAYMENTS_READINESS.md`. Add machine-enforcement tests that pin the three structural dormancy guards (key gate, code gate, DB CHECK) so a future refactor cannot quietly weaken any of them without explicit acknowledgement. **No code behavior changed.** No payment behavior changed. No live-mode behavior changed. No SMS change. No env change. No Stripe key rotation. No webhook secret change.

**Why:** Chloe asked verbatim: "We need a way to start taking live cards now, not just test. No more cash. We have 3 clients signed up already. We need to get everything live." That's real business pressure, but live payments are a different risk category. Before flipping the live-mode flag, the team has to know exactly what is and is not ready, what blocks live money today, and what the operator can fall back to when something goes wrong. PR #168 is the audit; it does not enable anything.

**Blocker summary (full detail in docs/16 §5):**

- **Card authorization template wording** -- Willow's `card_authorization` consent template is titled `"test"`; no evidence in the codebase that it was reviewed by Chloe or legal counsel for Ontario law (CASL, PIPEDA, PCI obligations). Live charging on an unreviewed authorization is a dispute risk. (PR #169.)
- **"Test mode only" UI copy in 7 locations** -- portal Replace card intro, portal card-on-file disclaimer, three strings in Settings -> Payments, two strings in the practitioner ManualFeeChargeCard. Every one of them would be factually wrong in live mode and could mislead clients into thinking a real charge is a test. (PR #170.)
- **Stripe payouts not enabled** -- both production studios have `stripe_payouts_enabled=false`. Money would land in the Stripe balance but could not flow to a bank account. (Stripe dashboard, no Hone PR.)
- **No receipt path** -- `paymentIntents.create` does not set `receipt_email` and Stripe Customer email is not pre-populated, so successful live charges send no automatic receipt. (PR #171.)
- **No refund path** -- the `refunds.create` call is forbidden by `check-stripe-gates.mjs`; the dormant `stripe_refund_attempts` + `stripe_refunds` tables from migration 0032 have no code path. Operator must use the Stripe dashboard manually. (PR #172.)
- **Cancellation / no-show policy alignment** -- the fee model today is fixed-amount in `studios.late_cancel_fee_cents` and `studios.no_show_fee_cents`, with `timing_classification = 'practitioner_asserted'`. If Chloe's real policy is window-based (e.g. "50% within 24h, 100% no-show") the structured threshold columns do not exist yet. (PR #173, only if window-based.)
- **No test coverage on the charge path** -- `runManualFeeCharge`, the webhook handler, and the eligibility helper have no unit tests. A refactor could silently break the charge path. (PR #174.)
- **No live-charge operator runbook** -- `docs/11` does not yet cover stuck-pending recovery, duplicate-charge proof, or interpretation of common Stripe error codes. (PR #175.)
- **`payment_intent.*` and `charge.refunded` webhook handlers missing** -- these events are recorded with `ignoredInPhase1: true` and no business logic. Required before live charges. (PR #176.)
- **DB CHECK blocks live writes** -- `manual_fee_charge_attempts_livemode_false_check` is the third dormancy guard. The live-mode-enablement PR must drop or replace this constraint LAST, paired with the matching code changes. (PR #177.)

**Why machine-enforcement instead of just docs:** Docs go stale. The tests in `tests/lib/billing/live-mode-blockers.test.ts` pin the exact predicate of every guard (the live-mode early return, the key-gate throw message, the CHECK constraint shape, the deterministic idempotency key, the single allowlisted `paymentIntents.create` call site). A future PR that weakens any guard fails CI until docs/16 is updated in lockstep. The tests in `tests/docs/live-payments-readiness.test.ts` pin that docs/16 exists, declares the strict conclusion, names every blocker keyword, and references the 9-PR unblock sequence; docs/10, /11, /14 link back to docs/16; and docs/13 records this decision.

**What this PR does NOT do:**

- Does NOT enable live payments.
- Does NOT change `STRIPE_ALLOW_LIVE_MODE` default (still unset / false).
- Does NOT modify any Stripe key, webhook secret, or env var.
- Does NOT add or remove `paymentIntents.create` call sites (still exactly 1, in `lib/billing/manual-fee-charge.ts`).
- Does NOT add or remove `refunds.create` call sites (still 0).
- Does NOT change webhook handler behavior.
- Does NOT change manual fee charge logic.
- Does NOT change UI copy (the 7 "Test mode only" strings remain; PR #170 will remove them).
- Does NOT change the `card_authorization` consent template (still titled "test"; PR #169 covers legal review).
- Does NOT modify any database table, RLS policy, RPC, or index.
- Does NOT add any SMS or email behavior.

**Alternative considered:** Skip the audit and enable live mode behind a feature flag with monitoring. Rejected because (a) live payments have an irreversible failure mode (real money moves) and (b) the operator runbook + receipt + refund gaps would leave Chloe without recovery paths the first time something went wrong. A formal audit + sequential PR plan is slower but safer; live payments do not benefit from speed.

**Honest non-claims:** no migration. No schema change. No payment / live-mode / SMS / webhook / RLS change. No new index. No new env var. The Stripe gates are unchanged (1 allowlisted `paymentIntents.create` in `lib/billing/manual-fee-charge.ts`, 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string in `lib/stripe/server.ts`).

### Consent template Live / Draft client visibility (PR #167, migration 0072)

**Decision:** Add `consent_form_templates.is_live boolean NOT NULL DEFAULT false` to gate client-portal visibility separately from the practitioner-facing `status` enum (`draft / active / archived`). Backfill `is_live = (status = 'active')` so every pre-migration row keeps its current portal visibility. Add a CHECK constraint `(NOT is_live OR status = 'active')` so a draft or archived row can never be live. The portal query (`lib/consent/queries.ts:getActiveConsentTemplatesForPortal`) filters `is_live=true AND status='active'` (defense-in-depth on the CHECK); the practitioner's Settings UI sees every row regardless of `is_live` so drafts stay editable. `createConsentTemplateAction` forces `status='draft'` and `is_live=false` on insert; `setConsentTemplateStatusAction` auto-sets `is_live=false` when moving to draft or archived. A new `setConsentTemplateLiveAction` is the only path to `is_live=true` and pre-flights the requirement that the row be active first. The Settings UI gains a `Live` / `Draft` badge per row and a `Make live in client portal` / `Hide from client portal` button.

**Why:** Chloe reported, verbatim: "I need a way to make consent forms live or not live, just like booking/services. I don't want test forms going out into clients' portal and having them sign random stuff I'm doing." The audit found that the practitioner's `Activate` button immediately flipped `status='active'` and the portal query read `status='active'` directly, so a newly created template (or one being tested) was instantly visible to every active client. The bug was in the lack of separation between "this template exists in my workflow" and "this template is in front of real clients."

**Why a separate column instead of repurposing status:** A new boolean named with the consequence ("Live in client portal") makes the practitioner's intent unambiguous. The status enum keeps its three-state lifecycle for the practitioner (draft / active / archived) so existing patterns (Archive a template, return to Draft) keep working. The new column lets a template sit at `(status='active', is_live=false)` -- ready to use, not yet client-visible -- which the prior single-column model could not express.

**Why DEFAULT false:** The whole safety property is that a freshly created template cannot reach the client portal by accident. A DEFAULT true backfill would have preserved current behavior but inverted the safety property for the future. The migration backfills existing active rows explicitly so pre-PR studios lose no visibility; the column default applies only to new inserts and is intentionally restrictive.

**Why the CHECK constraint:** The portal query keeps defense-in-depth on status, but the CHECK is the structural guarantee that a row with `is_live=true` MUST have `status='active'`. The companion application code (`setConsentTemplateStatusAction`, `setConsentTemplateLiveAction`) never writes a violating combination; the CHECK is the backstop if a future PR forgets that invariant.

**Why audience targeting was deferred:** The portal form-selection query has no appointment, service, or new-vs-existing-client context today. Adding targeting requires a new column on templates (modality / service / client-type), a portal-side context resolver, and a fail-open rule (show the live form if context is unknown, because a client seeing one extra consent is safer than a required consent silently disappearing). That is a separate PR; this PR ships only the Live / Draft gate.

**Effect on card_authorization (PR #135, PR #158):** `card_authorization` is a `consent_form_templates` row with `form_type='card_authorization'`. Willow's currently-active card_authorization row was backfilled to `is_live=true` so the PR #158 Add card guidance keeps working with no operator intervention. The portal Add card flow (`app/portal/payment-method-actions.ts`) gained the same `is_live=true` filter; a draft card_authorization template no longer accidentally unlocks the SetupIntent surface.

**Effect on photo_consent (PR #137):** Same as card_authorization. photo_consent rows live in the same table; the backfill covers them; the portal continues to surface signed ones with their accepted / denied response from migration 0060.

**Effect on historical signatures:** None. `client_consent_signatures` is immutable + snapshot-based. The portal's "Completed forms" surface (PR #159) reads signatures directly and never joins the templates table, so flipping a template to draft or archived cannot delete or hide a signed record.

**Alternative considered:** Rename the existing `Activate` button to `Make live in client portal` and ship a copy-only change with no migration. Rejected because the underlying single-column model still made it impossible to express "this template is ready for studio use but not yet exposed to clients." A practitioner who wanted to draft a treatment_consent v2 while keeping v1 live had no way to do it; the new two-axis model unblocks that.

**Honest non-claims:** no full consent builder, no rich-text editor, no legal review workflow, no template version diff viewer, no signed-form PDF viewer, no audience targeting, no intake builder, no portal redesign, no SMS change, no live payments, no payment policy change, no live-mode change. The Stripe gates are intact (one allowlisted `paymentIntents.create` in `lib/billing/manual-fee-charge.ts`, one allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string in `lib/stripe/server.ts`). No new RLS policy and no new index.

### Secure-link expiry raised to 1 hour (PR #166)

**Decision:** Raise the portal magic-link TTL from 30 minutes to 60 minutes. The constant `MAGIC_LINK_TTL_MS` in `app/portal/login/actions.ts` is the single source of truth; the email body copy in `lib/email/templates/portal-magic-link.ts` ("This link expires in 1 hour.") is pinned by a test so the two cannot drift. The split GET/POST consumption model (PR #142) is unchanged: GET on `/portal/verify/<token>` still validates without consuming; POST still consumes via the atomic conditional UPDATE on `consumed_at IS NULL`. The portal session cookie TTL (7 days) is unchanged. No migration: existing rows naturally expire under the old 30-minute value; new rows pick up the new value on the first request after deploy.

**Why:** Chloe reported "Secure link stopped working under 30 mins." The audit (read-only sweep across every token surface) found:
- portal magic link: 30 minutes (application constant) <- the only short-TTL surface
- portal session cookie: 7 days
- cancel / reschedule / manage tokens: valid while the appointment is valid (no separate TTL)
- intake token: 14 days

Only the portal magic link could plausibly produce a "stopped working under 30 mins" experience. Real-world email delivery on the Resend free tier plus Gmail's spam-aware queueing routinely adds several minutes between issue and inbox arrival; on top of that, a client who steps away from their phone or whose inbox notifies late can easily cross 25 to 30 minutes from request to first click. The link is technically valid but feels broken. 60 minutes absorbs the typical worst-case delivery + read window without weakening the security contract: the token is still single-use, still hashed at rest, still consumed by the atomic POST.

**Why not a sliding TTL or auto-resend:** A sliding window per click would require the GET to write, which defeats the email-scanner protection (PR #142). An auto-resend on expiry would let an attacker who learned a victim's email induce repeated outbound emails. A simple longer fixed window is the smallest change with no new attack surface.

**Why also the portal-header layout flip:** PR #159's right-cluster was `flex flex-col items-end`, so Sign out stacked below Email Willow. Chloe's smoke test flagged this as reading like a secondary affordance of Email rather than a peer control. PR #166 flips the cluster to `flex flex-row items-center` so Sign out sits visibly at top-right next to Email Willow. The outer header still carries flex-wrap, so the cluster wraps below the heading on narrow viewports.

**Alternative considered:** Raise to 24 hours. Rejected because magic links are bearer credentials; the longer the window, the larger the blast radius if the link is forwarded or leaks via screenshot. 60 minutes is short enough to bound exposure but long enough to absorb realistic delivery latency. If Chloe reports the link still expires before she can use it after this change, we revisit with concrete timestamps and consider 2-hour.

**Honest non-claims:** no migration. No schema change. No session-cookie TTL change. No GET/POST consumption-model change. No new RPC. No new RLS policy. No new env var. No change to cancel / reschedule / manage / intake token TTLs. No payment / live-mode / webhook / SMS / email-delivery behavior change. The Email + Sign out controls themselves are unchanged; only the flex direction of their container.

### Fractional thermolysis duration (PR #165, migration 0071)

**Decision:** Widen `electrolysis_entries.thermolysis_duration_seconds` from `integer` to `numeric` (migration 0071). Drop `int: true` from the form parser. Switch the input to `step="0.01"` + `inputMode="decimal"`. Add `lib/sessions/format-seconds.ts:formatSeconds` and route the entry-row display through it.

**Why widen only thermolysis_duration_seconds:** Chloe's bug was specifically about thermolysis flash duration (`0.15s`, `0.2s` are clinically meaningful). Galvanic duration is measured in whole seconds in the studio workflow today; intensity percent fields are 0-100 percentages and never need decimals. The spec was explicit: "do not broaden unless clinically necessary." Pinned by a test that confirms the migration only references the thermolysis column in its DDL.

**Why a 2-decimal-place format with trailing-zero trim:** `0.15` should render as `"0.15 seconds"`, `0.2` as `"0.2 seconds"` (not `"0.20"`), `1` as `"1 second"`, `2` as `"2 seconds"`. The `Math.round(value * 100) / 100` trick cleans float-precision noise (e.g. `0.15 * 100 = 14.999999999999998` in JS), and `String(rounded)` naturally drops trailing zeros. Pinned by `tests/lib/sessions/format-seconds.test.ts`.

**Why singular only when value === 1 exactly:** `"1 second"` reads naturally; `"1.0 seconds"` does not exist in the formatter's output (the round-and-trim strips the `.0`). Fractional and `0` always read as `"seconds"`.

**Why not touch the legacy generic `duration_seconds` display path:** the legacy column dates to migration 0001 and is only present on entries that pre-date the structured-readings work of migration 0042. Legacy entries still render via the bare `${value}s` template; touching that path would broaden scope without fixing a reported bug.

**Honest non-claims:** no broad charting redesign. No new treatment model. No analytics. No notifications. No payment / live-mode / SMS / email / portal change. PR #162 thermolysis Duration -> Intensity -> Pulse count input order is preserved (pinned by a test in this PR's test file).

### Practitioner notification center foundation (PR #164, migration 0070)

**Decision:** Add `practitioner_notifications` table with studio-wide RLS visibility. Wire three v1 event sources (public booking, client cancel, client reschedule) to a server-only fire-and-forget helper that writes via the admin/service-role client. Add a `/notifications` page + "Mark all read" server action that read/update via the authenticated RLS client. Header nav gains a Notifications link with an unread count badge.

**Critical write contract.** The helper is never-throws from the caller's perspective. Pattern mirrors PR #155's `logSmsFailure`: the entire admin-client write runs inside a `void (async () => { try { ... } catch { ... } })()` IIFE. The caller does NOT await; the booking / cancel / reschedule never blocks on a notification insert. A failure inside the helper logs to `ops_alerts` via `recordOpsAlert` (PR #153) so the operator sees the silent failure trail; no error path leaks back to the visitor. Pinned by `tests/lib/notifications/practitioner-notifications.test.ts`.

**Why separate from `ops_alerts`:** `ops_alerts` is the operator surface (Sam) for system / silent-failure states (SMS give-ups, Stripe webhook signature mismatches, manual fee retries). `practitioner_notifications` is the practitioner surface (Chloe) for business events. Different audience, different severity model, different read pattern. Reusing `ops_alerts` would have meant overloading a critical-failure table with non-failure events; the smoke for "is the system OK" would be polluted by routine bookings.

**Why server-only helper with admin client for the WRITE path:** the three event sources are anonymous visitor / token-bearing flows. They cannot satisfy `is_studio_member(studio_id)` for an INSERT policy. The helper bypasses RLS deliberately because every field is derived server-side from already-committed rows; no visitor input reaches the notification body. `import "server-only";` plus the PR #155 admin-server boundary test guarantee no client component imports the helper.

**Why authenticated RLS for the READ + mark-read path:** the `/notifications` page is a practitioner surface and the studio-membership policy is exactly the right gate. The mark-all-read UPDATE policy carries WITH CHECK so a member cannot move a row to a different studio.

**Why studio-wide visibility in v1:** Willow runs one main practitioner workflow today (Chloe). `practitioner_id` is stored but not yet used for filtering; a future PR can switch to per-practitioner when a multi-practitioner studio (Laura) onboards, without another migration. Documented as a known future consideration in the migration header.

**Why no DB CHECK on `event_type`:** the canonical event set lives in `lib/notifications/practitioner-notifications.ts:ALLOWED_EVENT_TYPES`. Pinning it at the DB layer would force a migration every time the event list grows. The action-layer allowlist is sufficient because the only writer is the server-only helper with a fixed typed union.

**Why a Date label helper in each action site instead of a shared one:** each event's notification body has a slightly different shape (booking: "for <Day> at <Time>"; reschedule: "from <Day at Time> to <Day at Time>"; cancel: no time). Co-locating a one-line `formatDayLabel` / `formatDayTime` helper at the bottom of each action keeps the helper and the call site easy to read. The 12h clock comes from `localTimeString12h` (PR #157) so the practitioner notification reads consistently with the client emails Chloe also receives.

**Honest non-claims.** No SMS sending added; the spec deferred SMS as a future channel on top of this event model. No email notification. No push. No realtime. No filtering / preferences UI. No client-facing notifications. No notifications for intake, consent, card added, portal reply, manual fee charge, or any other deferred event. No payment behavior change. No live-mode change. No portal redesign. No consent change.

### Booking referral attribution (PR #163, migration 0069)

**Decision:** Capture an optional "How did you hear about us?" answer on the public booking form. Store the canonical lowercase value on the new nullable `appointments.referral_source` column (migration 0069). Surface the label-mapped value on the practitioner-facing calendar appointment detail page and in the practitioner new-booking notification email body. Do NOT surface it on any client-facing surface (confirmation email, reminder emails, portal, public booking confirmation page).

**Why appointment-level and not client-level for v1:** the smallest useful version that gives Chloe the signal. A future PR can promote to client-level first-touch / latest-touch attribution after Chloe has used the appointment-level data and decided what she wants. Designing the client-level model before the data is in is the wrong order.

**Why a closed option set and no free-text "Other details":** avoids the PII / spam concerns of an arbitrary text box, makes future analytics simple (every value belongs to one of seven buckets), and keeps validation cheap. The seven options (Google, Instagram, Friend or referral, Existing client, Studio website, Other, Prefer not to say) cover Chloe's stated use cases. Free-text is a future PR if the operator asks.

**Why no DB CHECK constraint on the column:** the option set lives in `lib/booking/referral-source.ts` and is enforced at the action layer via `parseReferralSource`. Pinning the same list at the DB layer would force a migration every time the option list grows; the action-layer check is sufficient because the only writers are server actions, and a tampered form value surfaces the visitor-facing generic booking error before reaching the insert.

**Why no index:** low cardinality (seven values), no hot read path. The only readers today are the calendar appointment detail page (one row by id) and a future analytics query that can run a sequential scan happily.

**Why "Studio website" instead of "Willow Electrolysis website":** the public booking form is shared by every studio that uses Hone. Hardcoding "Willow" in the option label would have leaked Willow-specific branding into a generic surface and would have been wrong as soon as a second studio (Laura) onboarded. The label stays studio-agnostic.

**Honest non-claims:** not a full intake builder. Not an editable booking form builder. Not a marketing analytics dashboard. Not a client-level first-touch attribution model. Not a notification center. Not a CRM export. No payment behavior change. No live-mode change. No SMS change. No portal redesign. No consent change. No public route auth change.

### Charting terminology and electrolysis field-order cleanup (PR #162)

**Decision:** Change the `session_blocks.side` display label `"Bilateral"` to `"Both sides"` on every charting surface, and reorder the thermolysis input fields so the rendered JSX shows `Duration -> Intensity -> Pulse count` (matching Chloe's machine and the order she enters values during a real session). The stored enum value `bilateral` is unchanged; the database CHECK constraint from migration 0039, the `SessionBlockSide` TS union, and the server validation array are all untouched. Persisted column names (`thermolysis_duration_seconds`, `thermolysis_intensity_percent`, `pulse_count`) are unchanged. No data migration.

**Why a shared label helper:** `app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx` carried a local `SIDE_OPTIONS` array (`{ value: "bilateral", label: "Bilateral" }`); `app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx` pushed `block.side` raw into the area-title suffix. Two surfaces, two different presentations of the same underlying value, both wrong. PR #162 moved the canonical `SESSION_BLOCK_SIDE_OPTIONS` array + a `sessionBlockSideLabel(side)` helper into `lib/sessions/side-labels.ts`. Both consumers now read from one place, so a future label tweak (e.g. when Laura asks for different wording) is one edit, not two.

**Why galvanic is unchanged:** Chloe asked specifically about thermolysis. Galvanic already renders Duration before Intensity in source order (lines 736 vs 750 of the form). The Galvanic mA + Units of lye (UL) controls are galvanic-specific concepts, not symmetrical with thermolysis's pulse count. PR #162 pins the existing galvanic order with a test so a casual reorder cannot silently regress it.

**Why a presentation-only fix rather than renaming the enum:** renaming `bilateral` to `both_sides` would invalidate every existing session_blocks row, require a CHECK-constraint migration with a backfill, and break server validation. The display-vs-storage split is the right shape: practitioners read English; the DB stores a stable canonical value.

**Honest non-claims:** no migration. No schema change. No payment / live-mode / webhook / SMS / email behavior change. No public route change. No new RPC. No new RLS policy. No new env var. No new appointment / session data model. Pure UX/copy.

### Editable pre-appointment instructions (PR #160)

**Decision:** Remove the hardcoded "Please arrive 5 minutes early. Wear comfortable clothing. Avoid caffeine before your appointment." paragraph from the booking confirmation email template. The per-service `services.pre_care_instructions` field (migration 0025) is now the single source of truth for prep wording; it is edited from `Settings → Services` per service, and the same value feeds the confirmation email, both reminder emails, and the portal Care instructions section (PR #159). When a service has no prep text set, the block is omitted entirely from every surface.

**Why:** Chloe's smoke-test feedback was verbatim: "I want to be able to customize that in settings." / "This should not be hardwired." / "I should be able to edit that as I see fit." Before this PR the confirmation email rendered BOTH the hardcoded paragraph AND the per-service text, which felt like two prep sections fighting each other. A future Laura would have inherited Chloe's Willow-specific wording. The smallest fix is to delete the constant; the editable field, the settings UI, and the email threading were already in place from migration 0025 and the original email work.

**Why no migration:** the `services.pre_care_instructions` column already exists (migration 0025) and is already wired into `lib/email/send-appointment.ts` and the templates. The Settings → Services textarea already exists. The bug was purely the redundant hardcoded paragraph in `lib/email/templates/appointment.ts`. Adding a studio-level field on top would have duplicated the existing per-service field for no product reason; Chloe's prep wording can differ by service (electrolysis vs laser vs consultation).

**Why update the settings copy:** the prior label "Pre-care instructions" + hint "Optional. Included in confirmation and reminder emails." did not mention the portal Care instructions surface or that this was the single source of truth after PR #160. The new label "Pre-appointment instructions" and longer hint make explicit that the field reaches both emails and the portal and walk through example use cases (arrival time, clothing, caffeine, shaving, medication reminders). Textarea grew from `rows={2}` to `rows={4}` so a multi-line prep blurb does not feel cramped.

**Honest non-claims:** no migration. No new RPC. No new RLS policy. No payment behavior change. No live-mode change. No SMS behavior change (SMS templates do not render prep instructions). No public route change. No new env var. Not a full email template builder. Not a consent / policy editor.

### Portal layout cleanup (PR #159)

**Decision:** Retire the "Your info" wrapper on `/portal`. The five passive surfaces that used to live inside it are now four top-level sections (`Appointments`, `Care instructions`, `Forms and records`, `Payment method`) with their own h2 headings. Header gains an `Email <studio>` button next to Sign out, gated on `studio.postcare_contact_email`. Care instructions render `<details open>`. "Signed forms" is renamed to "Completed forms" with a soft border-top divider list (no per-row card border) so the surface reads as a record, not a button. The bottom "Need help?" section is removed; its `mailto:` is now the header button. The PR #158 card-authorization guidance (placeholder, deep-link, signed supporting line, four-state Payment method gating) is preserved and verified by both the existing PR #158 tests and the new PR #159 layout tests.

**Why:** Chloe's smoke test surfaced this verbatim: "The portal's just a little cluttered looking." / "It doesn't really make sense to show them the signed forms if they can't click on it and see what they signed." / "I think the care instructions should be toggled open automatically." / "The email me button should be at the top." / "Change 'Your info' to your appointments / upcoming appointments." Each ask maps to a specific edit in this PR.

**Why no signed-form viewer in this PR:** building a viewable copy of a signed form requires a render path that fetches the template snapshot + the signature row and produces a printable HTML view. That is a larger PR with its own RLS posture (the rendered HTML must not bleed across studios) and its own PDF export consideration. PR #159 honestly sets the expectation in copy ("A viewable copy of signed forms is coming soon.") and defers the viewer.

**Why no new appointments query:** the page already loads upcoming appointments via the existing `nextAppointment` / `laterAppointments` pair. Past appointments live on the practitioner-side `getAppointmentsForClientProfile` (PR #157) but the portal does not call that helper today. Adding a portal-side past-appointment read is scope creep for a layout-only PR; deferred with a docs note.

**Honest non-claims:** no payment behavior change, no Stripe Connect change, no webhook change, no schema change, no migration, no new RPC, no new RLS policy, no new public route, no new env var, no SMS/email behavior change, no live-mode change. The card-authorization placeholder and gating from PR #158 are unchanged.

### Card authorization guidance for portal + practitioner (PR #158)

**Decision:** When the client has not signed `card_authorization`, the portal now renders a calm placeholder in the card section ("Card authorization needed before adding a card") with a deep-link button (`#forms-to-sign`) to the existing "Review and sign forms" block. When the client has signed it but no active card exists, the existing Add card surface now carries supporting copy ("You have signed card authorization. You can now add a card on file. No charge will be made when you add a card."). Matching practitioner-side card on the client profile renders one of four explanatory branches (`Card authorization template not configured` / `Card authorization not signed` / `Card authorization signed, but no card is on file yet` / active card summary) so the practitioner knows exactly what to ask the client to do next. Manual fee eligibility blocked reasons updated to use the same actionable wording.

**Why:** Chloe's smoke test feedback was verbatim: "I don't know how to add a card. It should give you instructions." The pre-PR portal silently hid the Add card surface when authorization was unsigned; the only on-page mention of the gating was the unsigned form entry in a separate list. A real client who scans for "Add card" and sees no obvious affordance gives up. The new placeholder + deep-link makes the implication visible without changing the underlying gating logic.

**Why no schema or action change:** the gate already exists at the page-render layer (`showAddCardInNeedsYou` requires `cardAuthSigned`) and at the server-action layer (`createCardSetupIntentAction` returns `ERR_UNSIGNED_AUTHORIZATION`). PR #158 only adds copy and a single id/anchor pair; the existing two-layer enforcement is unchanged. No new RLS, no new RPC, no new env var, no Stripe behavior change.

**Why not auto-scroll instead of an anchor:** the anchor (`<a href="#forms-to-sign">`) requires only a server-rendered link and no client JavaScript. It works in any browser, including with JavaScript disabled. A `useEffect`-based scroll would have shipped client-side code that adds zero functional value over the anchor.

**Honest non-claims:** no live charging is enabled. No automatic charging. No Stripe Connect onboarding change. No payment policy change. No cancellation-fee redesign. The portal still cannot add a card until both the studio template and the client signature are in place; this PR only makes that state legible.

### Client profile appointment timeline (PR #157)

**Decision:** Add an Appointments timeline at the top of the client profile's Sessions tab. The timeline groups every appointment (Upcoming, Needs charting, Charted, Cancelled, No-show) and exposes per-row affordances using the PR #156 `sessions.appointment_id` FK: Chart session (carries `?appointment_id`), View session (links to the existing session detail), Open appointment (links to the calendar detail). The legacy "Visits awaiting charting" section that lived further down the same tab is removed; the new "Needs charting" group inside the timeline subsumes it without losing data.

**Why now:** Chloe's smoke test surfaced this as the next real product issue. She had no way to see a client's appointment history (past + upcoming + cancelled + no-show) from the client profile and had to context-switch into the calendar to find anything that was not the most recent session. "All appointments are a session" is her mental model; the timeline makes that mental model legible in one place.

**Why a single read instead of a chained query:** the helper `getAppointmentsForClientProfile` does two roundtrips (appointments, then linked sessions IN the appointment-id set), maps the latest linked session per appointment in memory, and returns the merged shape. A PostgREST embed would have been one roundtrip but would not let us cap the linked session per appointment id; the two-roundtrip path keeps the dedup deterministic (latest session wins per appointment) and stays under one second on the studio's row counts.

**Why no service role:** the existing `sessions: members all` and `appointments_member_all` policies already gate visibility through `is_studio_member(studio_id)`. The helper runs through the authenticated practitioner's RLS client. The PR #155 admin-server boundary still holds.

**What's deferred:** structured cancellation insight (reason label, client note, follow-up permission) was only inlined when the appointment row already carries `cancellation_reason`. The richer audit-row read used on the calendar appointment detail page is intentionally NOT replicated on the client profile to keep the timeline a single bounded read. A future PR can promote the audit row read into the helper if the operator asks for it; today's row carries enough for the practitioner to spot the cancelled visit and open it for more.

**Honest non-claims:** new sessions are NOT all linked (client-scoped + Log session still inserts null on purpose); historical sessions are NOT linked (no backfill ran); analytics are NOT solved; billing is NOT yet tied to completed appointments; this is NOT a practitioner notification feed; this is NOT a portal redesign.

### Sessions ↔ appointments foundation link (PR #156, migration 0068)

**Decision:** Add a nullable `sessions.appointment_id` FK to `appointments(id) ON DELETE SET NULL`, no unique constraint, no historical backfill. Two partial indexes keyed on `appointment_id IS NOT NULL`. Two surfaces stamp the FK today (calendar appointment detail page "+ Chart session"; client profile "Chart session" on an uncharted past visit). Client-scoped "+ Log session" continues to insert null. The dedup helper `getPastConfirmedAppointmentsForClient` prefers the explicit link and falls back to the `+/- 2 hour` proximity window only for sessions where `appointment_id IS NULL`, so no row is counted twice.

**Why a nullable FK and not a NOT NULL column with backfill:** historical clinical records cannot be safely re-attributed without supervised review. A wrong link silently corrupts the treatment memory the column exists to protect. The nullable column lets new appointment-context flows write the FK incrementally; a separate supervised PR (preview matches, human review, UPDATE only after sign-off) can backfill later if the operator wants. Even then, ambiguous cases stay null.

**Why no unique constraint on `appointment_id`:** treatment blocks/areas may legitimately produce multiple session rows for one appointment. The runtime invariant is one-to-many in that direction, not one-to-one.

**Why no cross-table consistency trigger:** server actions already validate `(studio_id, client_id)` lineage before writing the FK. A SECURITY DEFINER trigger would duplicate that logic at the DB layer and be harder to reason about than the existing action-layer pattern. The migration deliberately ships no RLS change either: the studio-membership policy from migration 0001 already covers the new column.

**Write-forward partiality is documented honestly.** The product overview, the AI handoff, and the domain-model doc all carry the rule that new appointment-scoped session creation writes `appointment_id`; client-scoped creation remains nullable until a future appointment-selection flow exists. Do not claim "all new sessions are linked"; do not claim analytics are solved; do not claim billing is tied to completed appointments yet.

**Alternative considered:** require the FK on every new insert (NOT NULL). Rejected because the client profile "+ Log session" flow has no appointment in scope and is the primary practitioner-facing surface. Forcing it to require a picker would either ship a new picker UI in this PR (out of scope) or break the existing flow. Nullable + partial write-forward is the additive minimum that lets future flows mature without rewriting today's surfaces.

### GitHub Actions CI for validation, tests, and safety grep gates (PR #154)

**Decision:** Add a single GitHub Actions workflow (`.github/workflows/ci.yml`) that runs `npm ci`, `typecheck`, `lint`, `build`, `npm test`, `git diff --check`, and `npm run check:stripe-gates` on every PR and on every push to the default branch. The Stripe grep gates live in `scripts/check-stripe-gates.mjs` with a typed allowlist + a strict scan scope (only `app/`, `lib/`, `middleware.ts`, `next.config.ts`; only `.ts/.tsx/.js/.jsx`; tests, docs, migrations, scripts, and the gate script itself are excluded).

**Why a dedicated gate script, not `grep -R`:** the forbidden strings (`paymentIntents.create`, `charges.create`, `refunds.create`, `checkout.sessions`, `set_studio_require_card_on_file`, `STRIPE_ALLOW_LIVE_MODE=true`) legitimately appear in docs (operator copy, runbook), tests (assertion strings), migrations (column definitions), and the gate script itself (rule list). A naive grep would flag all of them. The script enforces "no new money-moving CALL SITE in runtime code" with a per-rule allowlist where dormant references must remain.

**Allowlist:** `paymentIntents.create` pinned to exactly one occurrence in `lib/billing/manual-fee-charge.ts` (PR #146). `STRIPE_ALLOW_LIVE_MODE=true` allowlisted in `lib/stripe/server.ts` because the string appears in an operator-facing error message there, NOT as a code path that flips the flag.

**Why no real secrets in CI:** the build + test surface do not need them. Dummy `sk_test_`, `pk_test_`, `whsec_*` values pass the shape validators in `lib/stripe/server.ts:assertStripeKeyAllowed` and the rest of the env shape gates. Real-credential paths (Stripe Elements canary, real Resend / Twilio sends, real Supabase prod query) are documented in `docs/12_SMOKE_TESTS.md` as manual smoke. CI does NOT replace manual smoke.

**Alternative considered:** Run CI only on the default branch, not on PRs. Rejected because PRs are exactly when the gates need to run; landing a regression on main and learning about it on the next push wastes the operator's time.

### Error tracking and alerting for silent-failure states (PR #153)

**Decision:** A single `recordOpsAlert` helper writes a durable row to `public.ops_alerts` (migration 0067) and emits a structured stderr log on every call. No Sentry. No Slack. No operator email in this PR (see "Why email deferred" below). The wiring covers manual fee `needs_manual_review` / `manual_fee_charge_failed`, Stripe webhook `card_on_file_setup_failed` / `stripe_webhook_processing_failed`, cron `cron_route_failed` / `recurring_break_materialization_failures`, and email/SMS `email_send_gave_up` / `sms_send_failed` (final-attempt only).

**Why a table not a service:** Sentry / Datadog / Honeycomb would solve the same problem with much more surface area. The pilot studio doesn't need fan-out; it needs a single durable record the operator can SQL. Service-role insert + studio-member-only RLS keep the alert visibility consistent with the rest of the application.

**Why email deferred:** an earlier draft imported `sendEmailSafely` from `lib/email/send-appointment.ts` so the alerts helper could dispatch critical alerts via Resend. That coupled ops alerting back into the appointment email subsystem the helper is meant to OBSERVE: ops alerts module imports → appointment email helper, which on give-up imports → ops alerts module. Even with an `email_*` event-name loop guard, the dependency cycle is avoidable. v1 ships durable-row + structured-log only. `OPS_ALERT_EMAILS` is reserved in `.env.local.example` for a future PR that adds a standalone `lib/ops/alert-email.ts` calling Resend directly with no path back into `lib/email/send-appointment.ts`.

**Alternative considered:** Per-call-site `console.error` only (status quo). Rejected because the existing `logInternal` lines are findable only in Vercel logs and disappear after Vercel's log retention. A durable table makes after-the-fact triage possible and gives a single SQL surface for `SELECT … WHERE resolved_at IS NULL`.

**What this PR did NOT do:**
- No Sentry / Slack / Datadog integration.
- No `/admin/ops-alerts` UI (runbook SQL only).
- No alert spike detection / batching.
- No new product, payment, SMS, email send, or live-mode behavior.

### Portal Replace card uses the existing SetupIntent flow (PR #151)

**Decision:** The portal Replace card affordance reuses the same `createCardSetupIntentAction` server action as Add card. The `mode` prop on `PortalPaymentMethodForm` drives copy only; the server action and webhook are unchanged. The webhook's `setup_intent.succeeded` handler pre-flips any existing active row to `status='removed'` and inserts the new active row in the same transaction (PR #135). The PR #135 idempotency SELECT on `(studio, client, account, mode, setup_intent_id)` makes the handler safe against Stripe re-deliveries even during a replace.

**Why:** The webhook ALREADY handled replacement correctly. Splitting Replace into a separate action or a separate webhook arm would have duplicated the lineage checks, the customer get-or-create, and the metadata validation without adding any safety. One server action + one webhook arm + one DB constraint = one place to reason about.

**Alternative considered:** A dedicated `replaceCardOnFileAction` that read the prior card's id from the form. Rejected because: (1) the server already derives current card state from the DB so the prior card id is not needed as input, and (2) trusting any form-supplied identity would weaken the security contract.

**What this PR did NOT do:**
- No card delete. Prior row stays as `status='removed'` for audit.
- No live mode. Same `STRIPE_ALLOW_LIVE_MODE=false` posture.
- No PaymentIntent / charge / refund / invoice / receipt.
- No practitioner-side card replace UI (still backlog).
- No multiple-card wallet, no default-card picker (still backlog).

### Global browser security headers (PR #150)

**Decision:** Ship a first enforced baseline of global browser security headers in `next.config.ts`. Token-route privacy headers (PR #142) preserved by layering AFTER the global block. Header builder lives in `lib/security/headers.ts` and is unit-tested.

Headers on every route: `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (tight baseline), and an enforced `Content-Security-Policy` with `frame-ancestors 'none'`, Stripe Elements sources, Supabase project host (from build-time env, not a wildcard), Vercel Analytics/Speed Insights, `font-src 'self' data:` (next/font self-hosts).

**Why:** Hone has strong DB/application security (RLS, hashed portal tokens, token-route privacy, Stripe test-mode gates, claim-then-charge idempotency), but no browser-layer baseline. Without `X-Frame-Options: DENY` + `frame-ancestors 'none'`, the portal consent signing surfaces, photo-consent allow/deny, card-on-file Stripe Elements, and manual fee test-charge button were all theoretically iframe-able by a third-party site (clickjacking risk).

**Alternative considered:** Nonce-based CSP with `'unsafe-inline'` removed. Rejected for this baseline because it requires plumbing per-request nonces through every inline script Next emits (RSC hydration, navigation state) and would substantially expand the PR. Deferred to a future deliberate PR that may also add `Content-Security-Policy-Report-Only` first to collect violations before tightening.

**Sentry domains intentionally omitted:** Sentry is not installed. CSP sources for Sentry will be added in the same PR that installs Sentry, not pre-emptively.

### Minimum automated test harness (PR #149)

**Decision:** Introduced a minimal Vitest harness (`vitest.config.ts`, `tests/`, `npm test` script). Three test files cover: `filterFutureSlots` strict-`>`-now semantics, the submitted-start guard predicate, and the "no raw `.message` leak" invariant on `app/reschedule/[token]/actions.ts` (textual grep over the source).

**Why:** The previous review pattern relied entirely on manual smoke. PR #149's safety fix is the kind of thing that historically regresses (a future copy-paste re-introduces `return { ok: false, error: rpcErr.message }`). Pinning the invariant as a `npm test` assertion catches the regression in CI-like fashion at PR time, even without a full automated end-to-end suite.

**Alternative considered:** Bigger Playwright / Cypress setup. Rejected because the goal is the floor of a test harness, not the comprehensive suite. A future PR can grow it; this PR adds it without dependency churn (only `vitest` + `@vitest/coverage-v8` as devDeps).

## Backlog

### P0 (block live mode or pilot expansion)

| Item | Notes |
|---|---|
| Legal review of consent + cancellation + card-authorization wording under Ontario law | Required before any live charging. |
| Receipts / charge-notice email | Required before any live charging. |
| Refund code path | Required before any live charging. The 0032 schema has the tables; the action does not exist. |
| Live webhook handler (`payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.*`) | Required before any live charging. Must match on `hone_manual_fee_charge_attempt_id` metadata. |
| Stripe metadata search before pending retry | Required before any live charging. The current 60-minute reconciliation window trusts Stripe idempotency replay; live mode must not. |
| Hashed `practitioners.calendar_feed_token` | **PARTIALLY RESOLVED by PR #182 (phase 1).** Migration 0079 added `calendar_feed_token_hash` + backfilled existing rows; the runtime feed route now looks up by SHA-256 hash. The raw column is kept for rollout compatibility because the settings UI still renders the URL from it on page render. Phase 2 (a later PR) refactors the UI to show the URL only at rotation time and then nulls the raw column. |
| Email reminder outbox/claim discipline | Eliminate the rare double-send race. |
| Automated test suite + CI | Replace manual smoke. |

### P1 (would meaningfully improve operability)

| Item | Notes |
|---|---|
| Practitioner-recovery card-add path | `client_payment_methods.added_via='practitioner'` allowed but no UI. |
| Signed-consent full viewer | Today the surface shows title + version + snippet; a full audit-friendly viewer would be better. |
| Treatment plan "complete" / "archive" status | Plans currently only flip `in_progress` ↔ `paused`. |
| Settings forms IA pass | The settings tabs have grown organically; a fresh information-architecture pass would help Chloe. |
| Admin / support dashboard | The current `/admin` is allowlist-gated read-only metadata. A real support console (impersonate-with-audit, manual reconciliation) would be useful. |

### P2 (nice to have)

| Item | Notes |
|---|---|
| Google Calendar two-way sync | Currently read-only ICS feed. |
| Intake builder | Chloe authors intake fields from the UI. |
| Two-pilot studios | Exercise multi-studio service-role boundaries with a second pilot. |
| Self-serve onboarding | Studio + owner creation via UI rather than SQL. |
| Public booking card-required flow | Schema dormant (0032). Wire when live charging exists. |

### Later

| Item | Notes |
|---|---|
| Mobile app | Out of scope for the pilot. |
| Inventory / consumables tracking | Out of scope. |
| Multi-currency | Currency pinned to CAD via column CHECK. |
| Subscriptions / packages | Out of scope. |
