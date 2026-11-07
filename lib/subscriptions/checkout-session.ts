// Server-side creation of the hosted Stripe Checkout Session (HON-70).
//
// The caller supplies a plan KEY and the authenticated user. The price id is
// looked up here from the environment allow-list and then verified against
// Stripe before any session is created. A client-supplied price id has no way
// in: this function does not accept one.

import type { BillingPrice, BillingStripeClient } from "./billing-client";
import {
  PLANS,
  type PlanKey,
  isSelfServeCheckoutEnabled,
  parsePlanKey,
  resolvePlanPriceId,
  type PlanDefinition,
  type SubscriptionEnv,
} from "./plans";

export type CheckoutRefusal =
  | "checkout_disabled"
  | "unauthenticated"
  | "already_subscribed"
  | "checkout_in_progress"
  | "unknown_plan"
  | "price_not_configured"
  | "invalid_origin"
  | "price_unavailable"
  | "checkout_unavailable"
  | "price_mismatch"
  | "price_inactive"
  | "price_not_recurring"
  | "price_currency"
  | "price_interval"
  | "price_amount"
  | "price_livemode";

export type CheckoutResult =
  | { ok: true; sessionId: string; url: string; reused: boolean }
  | { ok: false; reason: CheckoutRefusal };

/**
 * What Hone already knows about this user's billing, read by the caller from its
 * own store. The builder is stateless; it decides from this.
 *
 * DECISION (HON-70, Codex P2 4499972609; DB-DESIGN.md section 3.6): a user has at
 * most ONE live purchase path.
 *   * An open subscription  -> REFUSE (`already_subscribed`). They must not buy a
 *     second one; the DB also refuses a second open subscription, but by then
 *     they would already have been charged.
 *   * An unexpired session for the SAME plan -> REUSE it (no second session).
 *   * An unexpired session for a DIFFERENT plan -> REFUSE (`checkout_in_progress`)
 *     until it expires. No expire call is made: a second Stripe write type is not
 *     worth a payment-gate change, and sessions are created with the shortest
 *     lifetime Stripe allows (30 minutes) so the wait is short.
 *   * Otherwise create a new one.
 */
export interface ExistingCheckoutState {
  hasOpenSubscription: boolean;
  openSession: {
    id: string;
    url: string;
    plan: PlanKey;
    /** Unix seconds. */
    expiresAt: number;
  } | null;
}

/** Stripe's minimum Checkout Session lifetime is 30 minutes; one minute of slack. */
export const CHECKOUT_SESSION_TTL_SECONDS = 31 * 60;

export interface CheckoutRequest {
  client: BillingStripeClient;
  env: SubscriptionEnv;
  /** Untrusted: parsed against the two plan keys. */
  plan: unknown;
  /** The authenticated user. No user, no checkout. */
  user: { id: string; email?: string | null } | null;
  /** This deployment's own origin (server-resolved, never from the request). */
  origin: string;
  /** The user's existing billing state from Hone's store. Absent = nothing known. */
  existing?: ExistingCheckoutState;
  /** Unix seconds. Injected so tests are deterministic. */
  nowSeconds?: number;
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

  // One live purchase path per user, decided before any Stripe call.
  const now = req.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (req.existing?.hasOpenSubscription) {
    return { ok: false, reason: "already_subscribed" };
  }
  const open = req.existing?.openSession ?? null;
  if (open && open.expiresAt > now) {
    if (open.plan === planKey) {
      return { ok: true, sessionId: open.id, url: open.url, reused: true };
    }
    return { ok: false, reason: "checkout_in_progress" };
  }

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
  // A raw Stripe error can quote the offending parameter (e.g. an invalid
  // customer_email) and carries a request id; it must never reach the caller,
  // the route's error path or Sentry. Only this fixed code leaves. (Privacy S-1.)
  let session: { id: string; url: string | null };
  try {
    session = await req.client.createCheckoutSession({
      priceId,
      clientReferenceId: req.user.id,
      customerEmail: req.user.email ?? null,
      metadata,
      successUrl: `${origin}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/pricing`,
      expiresAt: now + CHECKOUT_SESSION_TTL_SECONDS,
    });
  } catch {
    return { ok: false, reason: "checkout_unavailable" };
  }
  // Hosted Checkout always returns a url; without one there is nothing to
  // redirect to, so treat it as unavailable rather than inventing one.
  if (!session.url) return { ok: false, reason: "price_unavailable" };
  return { ok: true, sessionId: session.id, url: session.url, reused: false };
}
