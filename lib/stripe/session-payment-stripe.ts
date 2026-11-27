import "server-only";
import type Stripe from "stripe";
import { requireStripeForStudio, resolveStudioPlatform, StripePlatformUnavailableError } from "@/lib/stripe/studio-platform";
import {
  assertFakeStripeNotRequestedInDeployment,
  isE2eFakeStripeEnabled,
} from "@/lib/stripe/e2e-fake-guard";
import { createFakeStripe } from "@/lib/stripe/e2e-fake-stripe";

// The Stripe seam for the session-payment charge/refund execution path. This is
// the ONLY place the fake processor can be substituted, and only for that path
// (the webhook / account / setup-intent callers resolve their own client; see lib/stripe/studio-platform.ts).
//
// HON-90: the platform account is the STUDIO's, resolved from its verified jurisdiction row (never the request): a Canadian studio gets
// exactly the client it always did, a US studio its own, and a studio with no verified or configured platform is REFUSED (throws), even
// under the fake. In PRODUCTION this is behaviourally IDENTICAL to getStripe() for a CA studio: the fake
// activation guard is fail-closed and rejects every deployed environment, so
// isE2eFakeStripeEnabled() is always false in production and this returns the
// exact same real Stripe client. No browser input, request header/cookie/query/
// form, or NEXT_PUBLIC_* variable can select the fake: the only inputs are the
// server-only HONE_E2E_* env markers, which cannot exist in a deployed runtime.
//
// Business rules, call signatures, idempotency, and connected-account handling
// are unchanged; callers use this exactly like getStripe().
export async function getSessionPaymentStripe(studioId: string): Promise<Stripe> {
  // Fail-LOUD on misconfiguration: if the fake flag is set in a deployed
  // environment, throw here rather than silently falling back to real Stripe.
  assertFakeStripeNotRequestedInDeployment();
  if (isE2eFakeStripeEnabled()) {
    const route = await resolveStudioPlatform(studioId);
    if (!route.ok) throw new StripePlatformUnavailableError(route.reason);
    return createFakeStripe();
  }
  // Bound as `const stripe = ...` (the enforced convention) so the money-
  // movement grep inventory can never be evaded by a renamed client.
  const stripe = await requireStripeForStudio(studioId);
  return stripe;
}
