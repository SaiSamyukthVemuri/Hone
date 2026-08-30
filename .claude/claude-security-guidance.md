# Hone — repository security rules

<!-- header:begin -->
Rules for a reviewer who already knows general security. They exist because a
general model cannot infer them from the code alone.

## Authority — read this first

Findings from this file are **leads**, not review completion. Review completion
in this repository is `scripts/eng/evidence.mjs`, which gates on the Codex
reviewer's numeric actor id `199175422` **and** a reviewed-commit SHA. A finding
raised here has neither, so it can never render as `COMPLETE_CLEAN` and can
never appear as a Codex finding. It also never sets a risk tier, never selects a
CI lane, and never overrides a repository guard.

Every rule below is **quoted from** a canonical document, not paraphrased from
one, and carries the source it was quoted from. The parity test requires each
rule to appear verbatim in its cited section, so this file cannot state a rule
its source does not — nor the opposite of one. The canonical documents are the
authority; this file is a view onto them.
<!-- header:end -->

## Identity

- Server resolves `studio_id`, `client_id`, `appointment_id`, `practitioner_id` from the session or from token resolution. **Never trust those ids from the form.** <!-- source: CONTRIBUTING.md#security-review-expectations | token: Never trust those ids from the form. -->
- RLS posture: studio-member SELECT only on every studio-scoped table unless explicitly justified. <!-- source: CONTRIBUTING.md#security-review-expectations | token: studio-member SELECT only -->

## Service role

- Service-role writes only from server actions or webhook routes. Never in a `"use client"` component. <!-- source: CONTRIBUTING.md#security-review-expectations | token: Never in a `"use client"` component. -->
- RPC invocations where the function is `SECURITY DEFINER` with a service-role-only grant. <!-- source: CONTRIBUTING.md#how-to-use-service-role-correctly | token: service-role-only grant -->
- Never in a route that any unauthenticated caller can reach without a token check. <!-- source: CONTRIBUTING.md#how-not-to-use-service-role | token: without a token check -->
- Never to bypass RLS as a convenience. If you find yourself reaching for the admin client because RLS is "in the way", revisit the RLS policy or the action's identity model. <!-- source: CONTRIBUTING.md#how-not-to-use-service-role | token: Never to bypass RLS as a convenience. -->

## Database privilege

- `SECURITY DEFINER` functions must explicitly set `search_path = pg_catalog, pg_temp`. Grants are `revoke from public, anon, authenticated; grant to service_role` unless deliberately wider. <!-- source: CONTRIBUTING.md#security-review-expectations | token: search_path = pg_catalog, pg_temp -->
- Supabase's `ALTER DEFAULT PRIVILEGES` grants EXECUTE to `anon`, `authenticated` **and** `service_role` at function-create time. An authenticated-only command must revoke from **all three** explicitly, by name. <!-- source: CLAUDE.md#5-production-safety | token: revoke from **all three** explicitly, by name -->

## Public and token routes

- The token is the credential. Anyone with the URL has the access it confers. <!-- source: CONTRIBUTING.md#how-to-treat-public--token-routes | token: The token is the credential. -->
- Use the `claim_stripe_event` / `claim_manual_fee_charge_attempt` / `public_cancel_appointment_with_token` pattern: single-use claim with `FOR UPDATE` + conditional UPDATE inside an RPC. <!-- source: CONTRIBUTING.md#how-to-treat-public--token-routes | token: single-use claim with `FOR UPDATE` -->
- Collapse error states: never tell the visitor "this token is expired" vs "this token is unknown". Both surface the same generic "this link can't be used right now" message. <!-- source: CONTRIBUTING.md#how-to-treat-public--token-routes | token: Collapse error states -->
- No analytics in the subtree. Add the new prefix to `next.config.ts headers()` for `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`. <!-- source: CONTRIBUTING.md#how-to-treat-public--token-routes | token: X-Robots-Tag: noindex, nofollow -->

## Payments

- `paymentIntents.create`: **exactly one runtime occurrence, in `lib/billing/session-payment-charge.ts`** <!-- source: CONTRIBUTING.md#payment-review-expectations | token: paymentIntents.create -->
- `refunds.create`: exactly one occurrence, in `lib/billing/payment-refund.ts` (full-amount, owner-only, test mode). <!-- source: CONTRIBUTING.md#payment-review-expectations | token: refunds.create -->
- `charges.create`: must be zero. <!-- source: CONTRIBUTING.md#payment-review-expectations | token: charges.create -->
- `checkout.sessions`: must be zero unless explicit Checkout PR. <!-- source: CONTRIBUTING.md#payment-review-expectations | token: checkout.sessions -->
- No raw card / CVC / `client_secret` in any new code. <!-- source: CONTRIBUTING.md#payment-review-expectations | token: No raw card / CVC -->
- No automatic, batch, background, or public-triggered charge. <!-- source: CONTRIBUTING.md#payment-review-expectations | token: public-triggered charge -->

## External side effects

- External provider truth is not the same as Hone persisted truth. Prefer **claim → external side effect → settle**. Do not automatically retry an uncertain provider-success state when the retry could duplicate the external action. <!-- source: ENGINEERING_STANDARDS.md#5-design-rules-for-risky-work | token: claim → external side effect → settle -->
