# 13 Backlog and decisions

## Decision log

Decisions are listed roughly in the order they were made. Each entry says **what was decided**, **why**, and **what the alternative was**.

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
| Hashed `practitioners.calendar_feed_token` | Currently stored raw. DB compromise yields usable tokens. |
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
