## Summary

What changed?

## Type of change

- [ ] Product behavior
- [ ] UI only
- [ ] Database/migration
- [ ] Security/privacy
- [ ] Payment/Stripe
- [ ] Email/SMS/cron
- [ ] Docs only
- [ ] Refactor only

## Risk level

- [ ] Low
- [ ] Medium
- [ ] High
- [ ] Money-moving
- [ ] Public/token route
- [ ] RLS/security-definer function

## Documentation

- [ ] No documentation update needed because this PR does not change product behavior, data model, security, payments, env config, routes, cron, email/SMS, legal copy, or operations.
- [ ] README/docs updated.
- [ ] Runbook/smoke tests updated.
- [ ] Env docs updated.
- [ ] Migration/RLS docs updated.
- [ ] Payment docs updated.
- [ ] AI handoff updated.

## Security checklist

- [ ] No client-supplied studio_id/client_id trusted.
- [ ] Server resolves studio/client/appointment where relevant.
- [ ] RLS impact reviewed.
- [ ] SECURITY DEFINER functions reviewed if changed.
- [ ] Grants reviewed if RPCs changed.
- [ ] Service-role usage justified.
- [ ] Public/token routes reviewed.
- [ ] No analytics added to token routes.
- [ ] No raw secrets, tokens, card numbers, CVC, or client_secret stored.

## Payment checklist, if applicable

- [ ] No live mode unless this is an explicit live-mode PR.
- [ ] No automatic charging.
- [ ] No batch charging.
- [ ] Idempotency reviewed.
- [ ] Duplicate-charge protection reviewed.
- [ ] Evidence gates reviewed.
- [ ] Stripe connected account context reviewed.
- [ ] client_secret not stored.
- [ ] No raw card/CVC stored.
- [ ] Refund/receipt/dispute impact considered.

## Stripe grep gates

Current expected rules:

- `charges.create` must be zero.
- `checkout.sessions` must be zero unless an explicit Checkout PR.
- `refunds.create` must be zero unless an explicit refund PR.
- `set_studio_require_card_on_file` must be zero unless an explicit card-required booking PR.
- `STRIPE_ALLOW_LIVE_MODE=true` must be zero unless an explicit live-mode PR.
- `paymentIntents.create`: **Exactly one existing occurrence is allowed in `lib/billing/manual-fee-charge.ts`** (the test-mode manual fee charge path, behind practitioner auth, evidence recheck, the `claim_manual_fee_charge_attempt` RPC, the deterministic idempotency key `hone:manual-fee:<attempt_id>:v1`, connected-account context via `{ stripeAccount }`, and the `inferStripeLivemode()` test-mode gate plus the `manual_fee_charge_attempts_livemode_false_check` CHECK on the DB row). **Any new `paymentIntents.create` occurrence anywhere else must be treated as high-risk and explicitly reviewed.**

## Chloe / Pilot Control Sheet

The repo-owned pilot tracker lives in `pilot-control/*.yml`. Pick the boxes that apply:

- [ ] This PR does not affect Chloe / client testing.
- [ ] This PR affects Chloe / client testing and updates `pilot-control/chloe-testing-queue.yml`.
- [ ] This PR captures new feedback and updates `pilot-control/product-feedback.yml`.
- [ ] This PR changes launch readiness and updates `pilot-control/launch-blockers.yml`.
- [ ] This PR is itself a new merged-and-shipped PR and adds an entry to `pilot-control/pr-build-log.yml`.
- [ ] After editing the YAML I ran `npm run pilot:export` and committed the regenerated `pilot-control/generated/*.csv`.

GitHub Actions runs `npm run pilot:check` and fails the PR if the YAML and CSVs disagree.

## Validation

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run check:stripe-gates`
- [ ] `npm run pilot:check`
- [ ] `git diff --check`

## Smoke tests

What was tested?

List:
- routes checked
- authenticated flows checked
- SQL checks run
- Stripe/Twilio/Resend checks run, if applicable
- what could not be verified

## What was intentionally not changed?

List explicit non-goals.

## Deployment notes

- [ ] Migration applied before code merge if app reads new columns/tables.
- [ ] Production deploy watched to READY.
- [ ] Post-deploy smoke listed.
