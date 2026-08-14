import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe/server";
import {
  assertFakeStripeNotRequestedInDeployment,
  isE2eFakeStripeEnabled,
} from "@/lib/stripe/e2e-fake-guard";
import { createFakeStripe } from "@/lib/stripe/e2e-fake-stripe";

// The Stripe seam for the session-payment charge/refund execution path. This is
// the ONLY place the fake processor can be substituted, and only for that path
// (the webhook / account / setup-intent callers keep using getStripe() directly).
//
// In PRODUCTION this is behaviourally IDENTICAL to getStripe(): the fake
// activation guard is fail-closed and rejects every deployed environment, so
// isE2eFakeStripeEnabled() is always false in production and this returns the
// exact same real Stripe client. No browser input, request header/cookie/query/
// form, or NEXT_PUBLIC_* variable can select the fake: the only inputs are the
// server-only HONE_E2E_* env markers, which cannot exist in a deployed runtime.
//
// Business rules, call signatures, idempotency, and connected-account handling
// are unchanged; callers use this exactly like getStripe().
export function getSessionPaymentStripe(): Stripe {
  // Fail-LOUD on misconfiguration: if the fake flag is set in a deployed
  // environment, throw here rather than silently falling back to real Stripe.
  assertFakeStripeNotRequestedInDeployment();
  if (isE2eFakeStripeEnabled()) {
    return createFakeStripe();
  }
  // Bound as `const stripe = getStripe()` (the enforced convention) so the money-
  // movement grep inventory can never be evaded by a renamed client.
  const stripe = getStripe();
  return stripe;
}
