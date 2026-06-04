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
