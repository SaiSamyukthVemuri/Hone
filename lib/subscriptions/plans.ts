// Hone software-subscription plans (HON-70). Hone Care Inc (US) billing,
// entirely separate from studios' Connect treatment payments.
//
// This module reads ONLY the HONE_* subscription variables. It must never
// read STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET (Hone Canada, Connect);
// tests/lib/subscriptions/stripe-separation.test.ts enforces that.
//
// Price ids are never taken from a request. They come from the environment
// (live ids for Production, test-mode ids elsewhere) and are looked up here
// by plan key. The expected amount/currency/interval are fixed in code and
// re-verified against Stripe at checkout creation and on every webhook.

export type PlanKey = "solo" | "studio";

export type SubscriptionEnv = Readonly<Record<string, string | undefined>>;

export interface PlanDefinition {
  readonly key: PlanKey;
  readonly label: string;
  /** Expected recurring amount in the currency's minor unit (USD cents). */
  readonly unitAmount: number;
  readonly currency: "usd";
  readonly interval: "month";
  /** Active practitioners the plan includes; the practising owner counts. */
  readonly practitionerLimit: number;
  readonly priceEnvName: "HONE_STRIPE_PRICE_SOLO" | "HONE_STRIPE_PRICE_STUDIO";
}

export const PLANS: Readonly<Record<PlanKey, PlanDefinition>> = {
  solo: {
    key: "solo",
    label: "Solo",
    unitAmount: 4900,
    currency: "usd",
    interval: "month",
    practitionerLimit: 1,
    priceEnvName: "HONE_STRIPE_PRICE_SOLO",
  },
  studio: {
    key: "studio",
    label: "Studio",
    unitAmount: 9900,
    currency: "usd",
    interval: "month",
    practitionerLimit: 3,
    priceEnvName: "HONE_STRIPE_PRICE_STUDIO",
  },
};

export const PLAN_KEYS: readonly PlanKey[] = ["solo", "studio"];

/** Stripe price ids are `price_` + alphanumerics. Anything else is not one. */
const PRICE_ID_SHAPE = /^price_[A-Za-z0-9]+$/;

/**
 * The flag defaults OFF. Only the exact string "true" turns it on; "1", "TRUE"
 * and " true" are all OFF so a typo can never open checkout.
 *
 * Turning it ON anywhere real is gated by docs/billing/HON-70-ACTIVATION-CONDITIONS.md.
 */
export function isSelfServeCheckoutEnabled(env: SubscriptionEnv): boolean {
  return env.HONE_SELF_SERVE_CHECKOUT_ENABLED === "true";
}

/** Parse untrusted input (a query string, a form field) into a plan key. */
export function parsePlanKey(value: unknown): PlanKey | null {
  return value === "solo" || value === "studio" ? value : null;
}

/** The configured price id for a plan, or null when unset or malformed. */
export function resolvePlanPriceId(
  plan: PlanKey,
  env: SubscriptionEnv,
): string | null {
  const raw = env[PLANS[plan].priceEnvName];
  return raw !== undefined && PRICE_ID_SHAPE.test(raw) ? raw : null;
}

/**
 * Reverse lookup used by the webhook: which plan does this price id belong
 * to? Null for any price that is not one of the two configured prices, which
 * is how a foreign or stale price is refused.
 */
export function planForPriceId(
  priceId: string,
  env: SubscriptionEnv,
): PlanKey | null {
  for (const key of PLAN_KEYS) {
    if (resolvePlanPriceId(key, env) === priceId) return key;
  }
  return null;
}
