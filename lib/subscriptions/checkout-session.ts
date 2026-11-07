// Server-side creation of the hosted Stripe Checkout Session (HON-70).
//
// The caller supplies a plan KEY and the authenticated user. The price id is
// looked up here from the environment allow-list and then verified against
// Stripe before any session is created. A client-supplied price id has no way
// in: this function does not accept one.

import type { BillingPrice, BillingStripeClient } from "./billing-client";
import {
  PLANS,
  isSelfServeCheckoutEnabled,
  parsePlanKey,
  resolvePlanPriceId,
  type PlanDefinition,
  type SubscriptionEnv,
} from "./plans";

export type CheckoutRefusal =
  | "checkout_disabled"
  | "unauthenticated"
  | "unknown_plan"
  | "price_not_configured"
  | "invalid_origin"
  | "price_unavailable"
  | "price_mismatch"
  | "price_inactive"
  | "price_not_recurring"
  | "price_currency"
  | "price_interval"
  | "price_amount"
  | "price_livemode";

export type CheckoutResult =
  | { ok: true; sessionId: string; url: string }
  | { ok: false; reason: CheckoutRefusal };

export interface CheckoutRequest {
  client: BillingStripeClient;
  env: SubscriptionEnv;
  /** Untrusted: parsed against the two plan keys. */
  plan: unknown;
  /** The authenticated user. No user, no checkout. */
  user: { id: string; email?: string | null } | null;
  /** This deployment's own origin (server-resolved, never from the request). */
  origin: string;
}

/**
 * Why a Stripe price does not match the plan, or null when it does. Exported
 * so the webhook applies the identical rule to what it refetches.
 */
export function priceRefusal(
  price: BillingPrice,
  expectedId: string,
  plan: PlanDefinition,
): CheckoutRefusal | null {
  if (price.id !== expectedId) return "price_mismatch";
  if (!price.active) return "price_inactive";
  if (price.type !== "recurring" || price.recurring === null) {
    return "price_not_recurring";
  }
  if (price.currency !== plan.currency) return "price_currency";
  if (
    price.recurring.interval !== plan.interval ||
    price.recurring.interval_count !== 1
  ) {
    return "price_interval";
  }
  if (price.unit_amount !== plan.unitAmount) return "price_amount";
  // Test-mode only until Sam approves live checkout.
  if (price.livemode) return "price_livemode";
  return null;
}

function cleanOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function createSubscriptionCheckout(
  req: CheckoutRequest,
): Promise<CheckoutResult> {
  if (!isSelfServeCheckoutEnabled(req.env)) {
    return { ok: false, reason: "checkout_disabled" };
  }
  if (!req.user || req.user.id.length === 0) {
    return { ok: false, reason: "unauthenticated" };
  }
  const planKey = parsePlanKey(req.plan);
  if (planKey === null) return { ok: false, reason: "unknown_plan" };
  const plan = PLANS[planKey];

  const priceId = resolvePlanPriceId(planKey, req.env);
  if (priceId === null) return { ok: false, reason: "price_not_configured" };

  const origin = cleanOrigin(req.origin);
  if (origin === null) return { ok: false, reason: "invalid_origin" };

  let price: BillingPrice;
  try {
    price = await req.client.retrievePrice(priceId);
  } catch {
    return { ok: false, reason: "price_unavailable" };
  }
  const refusal = priceRefusal(price, priceId, plan);
  if (refusal) return { ok: false, reason: refusal };

  const metadata = { hone_user_id: req.user.id, hone_plan: planKey };
  const session = await req.client.createCheckoutSession({
    priceId,
    clientReferenceId: req.user.id,
    customerEmail: req.user.email ?? null,
    metadata,
    successUrl: `${origin}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/pricing`,
  });
  // Hosted Checkout always returns a url; without one there is nothing to
  // redirect to, so treat it as unavailable rather than inventing one.
  if (!session.url) return { ok: false, reason: "price_unavailable" };
  return { ok: true, sessionId: session.id, url: session.url };
}
