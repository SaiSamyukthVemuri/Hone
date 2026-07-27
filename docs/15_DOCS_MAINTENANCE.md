# 15 Docs maintenance

The rule, restated:

> A PR is not complete if it changes behavior but leaves docs stale. Reviewers should block it.

## When docs must be updated

Docs must be updated in the same PR if the change touches any of:

- Product behavior (a user can do something new, or differently, or not at all).
- Data model (a new table, column, or constraint).
- Security posture (RLS, RPC grants, public route, token route, analytics surface, fingerprint salt behavior).
- Payment behavior (anything in `lib/stripe/*` or `lib/billing/*`, any new `paymentIntents.create`, any `STRIPE_ALLOW_LIVE_MODE` change, any change to the manual-fee evidence gates).
- Env config (a new env var, a different fail-closed shape, a domain change).
- Routes (a new route, a route group change, an auth gate change).
- Cron (a new route, a new schedule, a disabled route).
- Email / SMS (a new template, a new send path, a consent / opt-out change).
- Legal copy or forms (consent template body changes, policy text shape changes).
- Operational behavior (a runbook step changes, the deploy / migration order changes, the rollback path changes).

## Which doc to update for which change

| Change | Update at minimum |
|---|---|
| Payment / Stripe | `docs/06`, `docs/12`, `docs/14` |
| Database / RLS / migration | `docs/09`, `docs/14` |
| Public route or token route | `docs/03`, `docs/11`, `docs/12` |
| Env or config | `docs/10`, `README.md`, `.env.local.example` |
| Email / SMS / cron | `docs/08`, `docs/11`, `docs/12` |
| Product workflow | `docs/00` plus the feature doc, `docs/12` |
| Legal copy or forms | `docs/05`, `docs/13` |
| Calendar / availability | `docs/07`, `docs/12` |
| Portal / booking flow | `docs/04`, `docs/12` |
| Domain model | `docs/02`, `docs/09` |
| Architecture (folder structure, runtime, route groups) | `docs/01` |
| AI handoff updates (grep gates, non-negotiables) | `docs/14` |
| Documentation maintenance policy itself | `docs/15` (this file) |
| **Anything that changes what is actually running in production** (deploy, migration applied, flag flipped, capability enabled/exercised, a human acceptance recorded) | **`docs/production/current-state.md` + `docs/production/capability-register.md`** — and `docs/production/known-limitations.md` if a limitation opens or closes, `docs/production/migration-ledger.md` if a migration was applied, `docs/production/release-changelog.md` for the PR row. These are the canonical set; when they and any other doc disagree, they win. |
| Agentic / AI capability work | `docs/22_AGENTIC_READINESS_AND_SAFETY.md` (the safety boundaries are pinned by `tests/docs/agentic-readiness.test.ts`) |
| A rollout that applies a migration or flips a flag | the matching `docs/runbooks/*` file — add a dated **CLOSEOUT** section rather than editing the original procedure |
| Browser security headers / CSP changes | `docs/03` (Global browser security headers), `docs/10` (Browser security headers), `docs/11` (post-deploy header check), `docs/12` (§11 smoke), `docs/14` (CSP discipline non-negotiable) |
| Observability / ops alerts changes | `docs/03` (Ops alert observability), `docs/08` (give-up alerts), `docs/10` (`OPS_ALERT_EMAILS` row), `docs/11` (alert workflow + SQL), `docs/12` (§12 smoke), `docs/13` (decision log), `docs/14` (Ops alert hygiene non-negotiable) |
| CI / Stripe grep-gate changes | `.github/workflows/ci.yml`, `scripts/check-stripe-gates.mjs` (allowlist + rationale comment), `CONTRIBUTING.md`, `docs/14_AI_HANDOFF.md`, the PR template if the gate list changes. A PR that intentionally adds a new `paymentIntents.create` / `charges.create` / `refunds.create` call site MUST update the gate's allowlist with a comment explaining why, in the same PR as the code change. |

If a PR fits more than one row, update all of them.

## PR template reinforcement

The `.github/pull_request_template.md` (PR #147) contains a "Documentation" section with explicit checkboxes. The template's rule, copied here:

> No documentation update needed because this PR does not change product behavior, data model, security, payments, env config, routes, cron, email/SMS, legal copy, or operations.

If a reviewer checks the "no docs update needed" box, the PR description MUST explain why none was needed. "Refactor only" PRs and pure-CI PRs are the common cases.

## Docs ownership

There is no per-doc owner today. Every contributor updates the docs they touch. The default reviewer (Sam) blocks PRs that leave docs stale.

If a contributor cannot figure out which doc to update, default to:

- README for the top-level audience.
- `docs/14_AI_HANDOFF.md` for "I changed a rule a future AI must know."
- `docs/13_BACKLOG_AND_DECISIONS.md` for "I made a non-obvious decision."

## How to mark a doc deprecated

Hone keeps four historical docs at the repo root:

- `CRON_SETUP.md`; pre-Stripe-hardening cron notes. Still useful for setting up the external scheduler, but the `no-show` route described there is now non-mutating and must NOT be externally scheduled.
- `TESTING_EMAIL_SYSTEM.md`; Session-19.2 end-to-end email walk-through. The test recipe is still valid even though the surrounding email types have grown.
- `PRE_STRIPE_HARDENING_NOTES.md`; review + deployment notes for the operational-hardening migration 0033.

To mark a doc deprecated:

1. Add a banner at the top:
   ```markdown
   > **Status: DEPRECATED.** This document was written for Hone at <state>.
   > The authoritative source today is [docs/NN_…](./docs/NN_….md).
   > Kept as historical reference; do not use as a primary guide.
   ```
2. If the deprecated doc still contains useful operational steps not covered elsewhere, port them into the relevant `docs/` file and reference back to the deprecated doc by file name (so a `git log` reader can find the origin).
3. Do NOT delete useful historical docs.

## How to keep docs readable for non-technical readers

- Open with what the surface does and who uses it. Save the technical detail for later sections.
- Use tables for state machines, environment matrices, and per-row behavior.
- Concrete examples over abstract descriptions. Real PR numbers and migration numbers anchor the text.
- Section headings are imperative or descriptive, not cute.
- Avoid jargon when a plain word will do. "Cookie", "URL", "token" are fine. "Idempotency", "RLS", "SECURITY DEFINER" appear because the surface they describe is named that way; introduce them with a one-sentence gloss when first used.

## How to avoid false claims

> **This list was written pre-live and three of its five entries have since inverted.**
> Updated 2026-07-27 against verified production evidence. **Re-check this list whenever the
> product posture changes — a "never say X" rule that has gone stale is worse than no rule,
> because it makes accurate documentation look like a violation.**

The docs MUST NOT say any of:

- **"Any capability is live because a table, migration, component, route or flag exists."**
  Existence is not deployment, deployment is not enablement, enablement is not exercise, and
  exercise is not human acceptance. Use the status vocabulary in
  [capability-register.md](./production/capability-register.md).
- **"Chloe has accepted / validated / signed off"** anything she has not tested on-device.
  Her acceptance of the Phase A charting correction and whole-session copy is **pending**.
- **"Whole-session copy is production-exercised."** It is not — the provenance ledger holds
  **0 rows**. Deployment succeeding is not exercise.
- **"Google Calendar is syncing / enabled / active."** It is **dormant**: Willow is not
  connected and every sync flag is off. Note the cron routes **are** scheduled and do run —
  they simply find no work. "Not cron-registered" is also false.
- **"Broad multi-practitioner or self-serve launch is ready."** Capacity is enabled only on the
  controlled test studio and the public-assignment flag is off everywhere.
- **"The direct new-client consultation booking route is next / imminent / a blocker."**
  It is **deferred by product decision** (2026-07-27).
- **"Zero incidents", "fully compliant", "fully tested", "proven secure", or "security is
  verified because tests pass."** The honest statement is "0 unresolved `ops_alerts` rows at
  reconciliation". No compliance assessment exists, and the deep security audit has **not**
  been performed against the current baseline.
- **"Signatures are legally binding."** (Unknown. Enforceability depends on lawyer-reviewed
  wording under Ontario law, which has not happened.)
- **A hardcoded production migration max.** It goes stale on every migration — derive it from
  `supabase/migrations/` and `supabase migration list --linked`. (It is **0157** today.)
- **"Auto-charge exists."** (Still false. Manual practitioner click only — no automatic,
  background, batch or public-triggered charge path.)

**Claims that USED to be banned here and are now TRUE — do not "correct" them back:**

- **"Live payments are enabled."** ✅ True for two approved studios. Willow Electrolysis has
  **6 succeeded live-mode charges**, most recent 2026-07-26. *(The old note "live mode is
  structurally blocked" is obsolete: migration 0101 dropped the `stripe_livemode = false` CHECK
  from the canonical ledger.)* Still qualify it: **broad self-serve live payments are not
  ready.**
- **"Refunds are built."** ✅ Built and deployed. Qualify it: **0 production refunds exist on
  the current baseline.**
- **"Receipts are sent."** ✅ The session-payment receipt email exists and is live.
- "Google Calendar sync exists." (Currently false. Read-only ICS feed only.)
- **[SUPERSEDED 2026-07-27]** ~~"Comprehensive automated coverage exists."~~ — coverage is now substantial and this ban no longer applies as written: the Vitest unit suite, the Supabase-local DB/RLS integration lane, the generated-types drift check, and **browser E2E** (`playwright.config.ts` plus 45 specs under `e2e/`, run as the `browser-e2e` CI job alongside `payment-browser-e2e`, `mobile-completion-e2e` and `google-browser-e2e`) all exist. **What is still true and worth saying:** coverage is not exhaustive — the E2E lanes are Chromium-only and deliberately exclude real provider sends (Resend/Twilio), real Stripe Elements and real webhook delivery, so manual smoke (docs/12) remains complementary. Say that, rather than claiming either "comprehensive" or "minimal".
- "Hone is at hone.studio." (Stale. The production domain is `hone.care`.)

Use the cautious forms instead:

- "Test-mode manual fee charge exists. Live charging requires legal review and a deliberate live-mode PR."
- "Refunds and receipts are deferred."
- "Electronic signatures are evidence-friendly; enforceability depends on lawyer-reviewed wording."
- "Calendar feed is a read-only ICS subscription. Two-way Google Calendar sync is backlog."
- **[SUPERSEDED 2026-07-27 — do not copy this form.]** "Minimal automated guard/regression tests and GitHub Actions CI exist (PR #154). Full DB integration, RLS policy, and browser E2E coverage are deferred."

## How to document deferred work

When a PR explicitly defers something:

1. Add the deferral to `docs/13_BACKLOG_AND_DECISIONS.md` (P0 / P1 / P2 / Later as appropriate).
2. Mention the deferral in the PR body's "What was intentionally not changed" section.
3. If the deferral has security implications (e.g. unhashed calendar feed tokens), reflect it in `docs/03_SECURITY_AND_PRIVACY.md` §8 "Known risks and deferred hardening."

## How to keep the AI handoff accurate

Every PR that changes a non-negotiable rule (grep gate value, what the `paymentIntents.create` call must be behind, fail-closed env behavior, RLS posture, analytics mount points) MUST update `docs/14_AI_HANDOFF.md`.

The check at review time:

- If you read `docs/14` from top to bottom, does every rule still match the code as of this PR's diff?
- If a rule no longer matches, update it in this PR.

## How to keep `.github/pull_request_template.md` accurate

The template (PR #147) reproduces the Stripe grep gates verbatim. If the grep gates change; e.g. a future PR removes the test-mode `paymentIntents.create` and replaces it with a live-mode equivalent in a different file; the template MUST be updated in the same PR.

The PR template is not docs in spirit; it is a checklist. But it carries authoritative wording for the grep gates and the documentation rule, so it shares the same maintenance discipline as `docs/`.
