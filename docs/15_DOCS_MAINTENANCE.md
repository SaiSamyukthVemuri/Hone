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

The docs MUST NOT say any of:

- "Live payments are enabled." (Currently false. Live mode is structurally blocked.)
- "Auto-charge exists." (Currently false. Manual click only.)
- "Refunds are built." (Currently false. The 0032 schema has the tables; no code path uses them.)
- "Receipts are sent." (Currently false. No receipt email exists.)
- "Signatures are legally binding." (Unknown. Enforceability depends on lawyer-reviewed wording under Ontario law.)
- "Google Calendar sync exists." (Currently false. Read-only ICS feed only.)
- "Comprehensive automated coverage exists." (Currently false. Minimal Vitest guard/regression tests and GitHub Actions CI exist as of PR #154; full Supabase-local DB integration, RLS policy coverage, and browser E2E remain manual.)
- "Hone is at hone.studio." (Stale. The production domain is `hone.care`.)

Use the cautious forms instead:

- "Test-mode manual fee charge exists. Live charging requires legal review and a deliberate live-mode PR."
- "Refunds and receipts are deferred."
- "Electronic signatures are evidence-friendly; enforceability depends on lawyer-reviewed wording."
- "Calendar feed is a read-only ICS subscription. Two-way Google Calendar sync is backlog."
- "Minimal automated guard/regression tests and GitHub Actions CI exist (PR #154). Full DB integration, RLS policy, and browser E2E coverage are deferred."

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
