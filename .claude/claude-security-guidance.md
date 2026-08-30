# Hone — repository security rules

These are Hone's own rules, for a reviewer who already knows general security.
They exist because a general model cannot infer them from the code alone.

## Authority — read this first

Findings from this file are **leads**, not review completion. Review completion
in this repository is `scripts/eng/evidence.mjs`, which gates on the Codex
reviewer's numeric actor id `199175422` **and** a reviewed-commit SHA. A finding
raised here has neither, so it can never render as `COMPLETE_CLEAN` and can
never appear as a Codex finding. It also never sets a risk tier, never selects a
CI lane, and never overrides a repository guard.

Every rule below is **derived** from a canonical document and carries the source
it was derived from. If a rule and its source disagree, the source wins and this
file is wrong. Change the canonical document first, in its own change.

## Identity

- Resolve `studio_id`, `client_id`, `appointment_id` and `practitioner_id` on the server, from the session or from token resolution. Never read them from `formData`, a query string, or any other caller-supplied value. <!-- source: CONTRIBUTING.md#security-review-expectations | token: Never trust those ids from the form. -->
- Studio-scoped tables get studio-member SELECT only under RLS unless a wider posture is explicitly justified in the PR. <!-- source: CONTRIBUTING.md#security-review-expectations | token: studio-member SELECT only -->

## Service role

- `createAdminClient()` is transport privilege, never business truth. It bypasses RLS, so the authorization decision must already have been made and proved above it. <!-- source: CONTRIBUTING.md#how-to-use-service-role-correctly | token: createAdminClient -->
- Never call it from a `"use client"` component, and never from a public route that has not resolved a token. Service-role writes come from server actions or webhook routes only. <!-- source: CONTRIBUTING.md#how-not-to-use-service-role | token: "use client" -->

## Database privilege

- A `SECURITY DEFINER` function must explicitly set `search_path = pg_catalog, pg_temp`, and its grants are `revoke from public, anon, authenticated; grant to service_role` unless deliberately wider. <!-- source: CONTRIBUTING.md#security-review-expectations | token: search_path = pg_catalog, pg_temp -->
- Supabase's `ALTER DEFAULT PRIVILEGES` grants EXECUTE to `anon`, `authenticated` **and** `service_role` at function-create time. An authenticated-only command must revoke from all three explicitly, by name — missed in 0129 for `anon` and again in 0164 for `service_role`. <!-- source: CLAUDE.md#5-production-safety | token: ALTER DEFAULT PRIVILEGES -->

## Public and token routes

- The token is the credential: anyone holding the URL has the access it confers. Use the single-use claim pattern — `FOR UPDATE` plus a conditional UPDATE inside an RPC. <!-- source: CONTRIBUTING.md#how-to-treat-public--token-routes | token: The token is the credential. -->
- Collapse error states. Never distinguish "expired" from "unknown" to the visitor; both surface one generic message. <!-- source: CONTRIBUTING.md#how-to-treat-public--token-routes | token: Collapse error states -->
- No analytics anywhere in a token subtree, and every new public prefix is added to `next.config.ts` `headers()` for `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`. <!-- source: CONTRIBUTING.md#how-to-treat-public--token-routes | token: X-Robots-Tag: noindex, nofollow -->

## Payments

- Exactly one runtime `paymentIntents.create`, in `lib/billing/session-payment-charge.ts`. Any new occurrence is high-risk and needs an explicit docs/13 decision. <!-- source: CONTRIBUTING.md#payment-review-expectations | token: paymentIntents.create -->
- Exactly one `refunds.create`, in `lib/billing/payment-refund.ts`. Zero `charges.create`. Zero `checkout.sessions` unless the PR is explicitly a Checkout PR. <!-- source: CONTRIBUTING.md#payment-review-expectations | token: refunds.create -->
- No raw card number, CVC or `client_secret` in new code, and no automatic, batch, background or public-triggered charge. <!-- source: CONTRIBUTING.md#payment-review-expectations | token: No raw card / CVC -->
- `STRIPE_ALLOW_LIVE_MODE=true` appears exactly once, inside an error message in `lib/stripe/server.ts`. It must never appear as a code path that flips the flag. <!-- source: CONTRIBUTING.md#payment-review-expectations | token: STRIPE_ALLOW_LIVE_MODE=true -->

## External side effects

- Provider truth is not Hone truth. Prefer claim → external side effect → settle, and never automatically retry an uncertain provider-success state when the retry could duplicate the external action. <!-- source: ENGINEERING_STANDARDS.md#5-design-rules-for-risky-work | token: claim → external side effect → settle -->
