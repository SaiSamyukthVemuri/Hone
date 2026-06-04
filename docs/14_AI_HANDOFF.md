# 14 AI handoff

**If you are an AI agent continuing work on Hone, read this first.**

## Current production status (as of PR #148)

- Production domain: `https://hone.care`.
- Default branch: `claude/build-hone-saas-hOex7`. Every push to it triggers a production deploy. Vercel project: `prj_pJUjs6ImP01FBPqrZyiJRpbpJ2mk`, team `team_Pwj27KsmnBKe3ZUBfKLcFczf`.
- 65 migrations applied. Most recent: `0065_manual_fee_charge_test_mode_result.sql`. The next migration is `0066`.
- Card-on-file and test-mode manual fee charge are live in production **test mode**. Live mode is blocked by three independent guards.

## Branch / PR / deploy workflow

1. Branch off `claude/build-hone-saas-hOex7` with a short descriptive name.
2. Build, validate locally:
   ```bash
   npm run typecheck
   npm run lint
   npm run build
   git diff --check
   ```
3. Commit as `SaiSamyukthVemuri <samyukth.ssv@gmail.com>` (the Vercel author gate requires this).
4. Push. Open a PR with the `.github/pull_request_template.md` checklist filled honestly.
5. STOP. Do not merge until reviewed.
6. On review approval: `gh pr merge <N> --merge`.
7. Poll the Vercel commit status:
   ```bash
   gh api "repos/SaiSamyukthVemuri/Hone/commits/<sha>/status" --jq '.state'
   ```
8. When `state=success`, confirm `READY` via Vercel MCP `get_deployment`.
9. Report merge SHA, deployed SHA, production status, any check failures.
10. Run the post-deploy smoke that you CAN do from a non-authenticated harness. Clearly say what could not be verified.
11. Do not start another PR until the deploy is `READY`.

## What not to touch casually

The list of high-risk areas. Each has a doc you MUST read before changing anything in it.

| Area | Doc | Why high-risk |
|---|---|---|
| Stripe / payment / live mode | [docs/06](./06_PAYMENTS_AND_STRIPE.md) | Money. Live charging is blocked by three independent guards; do not weaken any of them. |
| Token routes (`/cancel`, `/reschedule`, `/manage`, `/intake`, `/portal/verify`, `/calendar-feed`) | [docs/03](./03_SECURITY_AND_PRIVACY.md) | Token IS the credential. No analytics. noindex + no-referrer headers. |
| Portal session / magic link / `client_portal_magic_links` | [docs/03 §3](./03_SECURITY_AND_PRIVACY.md#3-portal-session-model) | The GET on `/portal/verify/<token>` is deliberately non-consuming. POST consumes. Do not flip this. |
| Manual fee `paymentIntents.create` | [docs/06](./06_PAYMENTS_AND_STRIPE.md), [docs/13](./13_BACKLOG_AND_DECISIONS.md) | The single allowed occurrence. Do not delete. Do not add a second. |
| RLS policies + `SECURITY DEFINER` RPCs | [docs/09](./09_DATABASE_AND_RLS.md) | Trust boundary. |
| Service-role client usage | [CONTRIBUTING.md](../CONTRIBUTING.md) | Never in `"use client"`. Never to bypass RLS as a convenience. |
| Analytics mount points | [docs/03 §6](./03_SECURITY_AND_PRIVACY.md#6-analytics-privacy-pr-142) | Root layout MUST NOT mount Analytics. Safe trees opt in. |
| `ADMIN_EMAILS`, `NEXT_PUBLIC_APP_ORIGIN`, `PORTAL_FINGERPRINT_SALT` fail-closed behavior | [docs/03 §7](./03_SECURITY_AND_PRIVACY.md#7-production-config-fail-closed-pr-143) | Production with missing values fails closed deliberately. |

## Payment safety rules (non-negotiable)

- **No live charges** unless `STRIPE_ALLOW_LIVE_MODE=true` AND a deliberate live-mode PR is open AND the `manual_fee_charge_attempts_livemode_false_check` constraint has been deliberately replaced AND the [docs/06 §9 checklist](./06_PAYMENTS_AND_STRIPE.md#9-live-charging-requirements) is complete.
- **No automatic / batch / background / public-triggered charge.** Charging is one manual practitioner click on a `ready` attempt.
- **No platform customer / platform PaymentMethod.** Every Stripe call must carry `{ stripeAccount }`.
- **No raw card / CVC / `client_secret` storage.**
- **No blind retry past the 60-minute reconciliation window.** Stripe idempotency is a 24-hour belt; the action's 60-minute window is the suspenders. Past that window, return `needs_manual_review`.

## PR review pattern

When reviewing a PR:

1. Read the PR template. Refuse to review further if the checklist is empty or dishonest.
2. Read the migrations (if any). Confirm RLS posture, grants, `search_path`, additive shape.
3. Read the diff for the search gates:
   ```bash
   git diff | grep -E '^\+' | \
     grep -E 'paymentIntents\.create|charges\.create|refunds\.create|checkout\.sessions|set_studio_require_card_on_file|STRIPE_ALLOW_LIVE_MODE=true'
   ```
4. Confirm no new Stripe SDK imports outside the existing helper.
5. Confirm the migration was applied to prod BEFORE the code references it.
6. Confirm docs are updated per [docs/15](./15_DOCS_MAINTENANCE.md).
7. Confirm the PR body lists what could not be verified.
8. Stripe-touching PRs: confirm idempotency, claim-then-act, evidence recheck, lineage recheck, test-mode gate.

## Standard validation commands

```bash
npm run typecheck
npm run lint
npm run build
npm test
git diff --check
npm run check:stripe-gates
```

Or `npm run ci` to run all six in sequence. All must pass before pushing. The Vercel preview deploy must reach `READY` before merge.

GitHub Actions runs the same six steps automatically on every PR and on every push to the default branch (`claude/build-hone-saas-hOex7`). See `.github/workflows/ci.yml`. A red CI check is a hard merge block. CI does NOT replace manual smoke; browser / Stripe Elements / real-send paths still need a human against the live deploy.

## Grep gates (current)

```
charges.create:                       zero
checkout.sessions:                    zero unless explicit Checkout PR
refunds.create:                       zero unless explicit refund PR
set_studio_require_card_on_file:      zero unless explicit card-required booking PR
STRIPE_ALLOW_LIVE_MODE=true:          zero unless explicit live-mode PR

paymentIntents.create:                exactly one occurrence allowed today:
                                      lib/billing/manual-fee-charge.ts

                                      Any new paymentIntents.create
                                      occurrence is high-risk and must be
                                      explicitly reviewed.
```

The current `paymentIntents.create` path is **test-mode-only manual fee charging**. It is behind:

- practitioner auth
- `getManualFeeChargeEligibility` evidence recheck
- `loadCardAndVerifyLineage` lineage recheck
- `claim_manual_fee_charge_attempt` RPC (`FOR UPDATE`, conditional UPDATE, idempotency key stamp in one transaction)
- deterministic idempotency key `hone:manual-fee:<attempt_id>:v1`
- connected-account context `{ stripeAccount }`
- `inferStripeLivemode()` test-mode gate
- `manual_fee_charge_attempts_livemode_false_check` DB CHECK

**Never live without an explicit live-mode PR.** A live-mode PR must add stronger stale-pending reconciliation (Stripe `paymentIntents.search` by metadata before retry) and must deliberately alter or drop the `livemode_false_check` constraint after review.

## Merge discipline

- One PR per logical change. Do not mix schema + product behavior + security in one PR.
- Migrations apply to prod BEFORE the code PR merges.
- The PR description is the contract; if it does not match the diff, the reviewer rejects it.
- Em-dashes in added lines: zero. Use plain hyphens or colons.
- Commits authored as `SaiSamyukthVemuri <samyukth.ssv@gmail.com>`.

## How to write prompts for future PRs

Useful patterns:

- State the goal first. Then state non-goals. Then the acceptance criteria.
- Always include the validation list (typecheck / lint / build / diff-check) and the grep gates.
- Always include "Do not merge until reviewed."
- Include the SQL the reviewer can run to verify state after merge.
- Include the explicit "what could not be verified" list.

## How to review PRs

- Read the diff before the description.
- Match every claim in the description to a line in the diff.
- If the description says "no schema change" and the diff shows a migration: stop.
- If the description says "no Stripe behavior change" and the diff adds a Stripe SDK import: stop.
- If docs are not updated for a behavior-changing PR: stop.
- Re-run the smoke against a preview deploy where possible.

## Current non-negotiables

Repeat the list in the PR you open, every time:

- Author commits as SaiSamyukthVemuri <samyukth.ssv@gmail.com>
- Zero em-dashes in added lines.
- Apply additive migration to prod BEFORE merging code that references new columns.
- "Do not merge until reviewed."
- "Do not start the next PR until deploy is READY."
- Stripe dormancy: no charges, no `require_card_on_file=true`, no live-mode enable, exactly one `paymentIntents.create`.
- Grep gates: `paymentIntents.create` (allowed only in `lib/billing/manual-fee-charge.ts`), `charges.create`, `refunds.create`, `checkout.sessions`, `set_studio_require_card_on_file`, `STRIPE_ALLOW_LIVE_MODE=true`. Enforced by `scripts/check-stripe-gates.mjs` + the `npm run check:stripe-gates` script in CI (PR #154). The `STRIPE_ALLOW_LIVE_MODE=true` rule allowlists `lib/stripe/server.ts` because the string appears in an operator-facing error message there, NOT as a code path that flips the flag.
- **CSP discipline (PR #150).** The global CSP in `next.config.ts` (via `lib/security/headers.ts`) is the single source of truth. Any new third-party browser integration MUST extend the CSP source lists in the same PR. Never weaken `frame-ancestors 'none'` or `X-Frame-Options: DENY`. Never add wildcard `*`. Never add Sentry domains unless that PR actually installs Sentry. Token routes keep `Referrer-Policy: no-referrer`.
- **Ops alert hygiene (PR #153).** `lib/ops/alerts.ts:recordOpsAlert` is the single entry point for silent-failure alerts. NEVER throw from the helper to the caller; DB failures are swallowed and surface only as additional structured logs. NEVER put raw tokens / `client_secret` / Stripe secret keys / card data / CVC / API keys in `safe_details`; the helper has a defensive redactor but the contract is "the caller already redacted". **The helper MUST NOT import `lib/email/send-appointment.ts` or any module that imports it.** Operator email is intentionally deferred; the same module observes the email subsystem and cycling back through it (even with a loop guard) is avoidable. A future PR may add a standalone `lib/ops/alert-email.ts` that uses Resend directly. New silent-failure surfaces should reuse the helper and a stable event name (`<surface>_<state>`).

## If you find yourself wanting to…

- **Add a new `paymentIntents.create`:** stop. Read [docs/06](./06_PAYMENTS_AND_STRIPE.md). The only legitimate new call site is a live-mode PR that satisfies the [docs/06 §9](./06_PAYMENTS_AND_STRIPE.md#9-live-charging-requirements) checklist.
- **Use `createAdminClient` in a client component:** stop. Move the logic to a server action.
- **Mount Analytics on `app/layout.tsx`:** stop. See [docs/03 §6](./03_SECURITY_AND_PRIVACY.md#6-analytics-privacy-pr-142). Mount on the safe-tree layout instead.
- **Add a wildcard `*` to the CSP, weaken `frame-ancestors`, or add Sentry domains "just in case":** stop. Read [docs/03 § Global browser security headers](./03_SECURITY_AND_PRIVACY.md). The CSP is the single source of truth and additions require explicit review.
- **Trust a `studio_id` / `client_id` / `appointment_id` from formData:** stop. Resolve from the session or from the token.
- **Add `process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care"`:** stop. Use `getRequiredAppOrigin()` from `lib/app-origin.ts`. PR #143 removed every silent fallback.
- **Skip a doc update because "the PR is small":** stop. The doc update is part of the PR.

## What was not verified by the agent in PR #148

This documentation overhaul is itself a docs-only PR. I did NOT:

- Run any new code paths.
- Apply any new migrations (no schema change in this PR).
- Send any email or SMS.
- Trigger any Stripe call.

The validation gates that DID run: `typecheck`, `lint`, `build`, `git diff --check`, em-dash count, and a grep for stale `hone.studio` references. Each doc was cross-referenced against the actual code, migrations, and PR template at the moment of writing (PR #147 just merged; the deployed SHA was `3ab714f`).

Where a doc references a behavior, the citation is the PR number and the migration number so a future reviewer can spot-check by reading the migration or the action file directly.
