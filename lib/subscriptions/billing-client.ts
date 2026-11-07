// The narrow surface of the Hone Care Inc (US) billing Stripe account that the
// subscription code is allowed to use (HON-70).
//
// Everything in lib/subscriptions depends on THIS interface, never on the
// Stripe SDK, so unit tests inject a fake and no test can reach the network.
// The real adapter below is the only place the SDK is touched.
//
// Separation rules (spec CREDENTIALS: CORRECTED):
//   * Reads HONE_BILLING_STRIPE_SECRET_KEY / HONE_BILLING_WEBHOOK_SECRET only.
//     It never reads STRIPE_SECRET_KEY (Hone Canada, Connect).
//   * No `stripeAccount` option anywhere: every call is made on the platform
//     account the key belongs to, never on a connected account.
//   * Test-mode key required. A live key is refused until Sam approves live
//     checkout separately; there is deliberately no env switch for that here.
//   * Secret values are never logged or placed in an error message.

import Stripe from "stripe";

export interface BillingPrice {
  id: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  type: string;
  livemode: boolean;
  recurring: { interval: string; interval_count: number } | null;
}

export interface BillingSubscriptionItem {
  price: {
    id: string;
    currency: string;
    unit_amount: number | null;
    livemode: boolean;
    recurring: { interval: string; interval_count: number } | null;
  };
  quantity: number | null;
  current_period_end: number | null;
}

export interface BillingSubscription {
  id: string;
  status: string;
  customer: string;
  livemode: boolean;
  cancel_at_period_end: boolean;
  metadata: Record<string, string>;
  items: BillingSubscriptionItem[];
}

export interface BillingEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  /** The event's `data.object`, already narrowed to the fields we read. */
  object: BillingEventObject;
}

export interface BillingEventObject {
  id: string | null;
  mode: string | null;
  client_reference_id: string | null;
  /** Subscription id on checkout.session / invoice objects. */
  subscription: string | null;
  metadata: Record<string, string>;
}

export interface CreateCheckoutSessionParams {
  priceId: string;
  clientReferenceId: string;
  customerEmail: string | null;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  /** Unix seconds. Stripe requires at least 30 minutes from creation. */
  expiresAt: number;
}

export interface BillingStripeClient {
  retrievePrice(priceId: string): Promise<BillingPrice>;
  retrieveSubscription(subscriptionId: string): Promise<BillingSubscription>;
  createCheckoutSession(
    params: CreateCheckoutSessionParams,
  ): Promise<{ id: string; url: string | null }>;
  /** Verifies the signature over the RAW body. Throws when it does not match. */
  constructEvent(rawBody: string, signature: string): BillingEvent;
}

export const BILLING_STRIPE_API_VERSION = "2026-04-22.dahlia" as const;

/**
 * Throws unless the key is a Stripe TEST secret key. The message never
 * includes the value.
 */
export function assertBillingKeyIsTestMode(raw: string): void {
  if (!raw.startsWith("sk_test_")) {
    throw new Error(
      "HONE_BILLING_STRIPE_SECRET_KEY must be a Stripe test-mode key (sk_test_). " +
        "Live subscription billing is not approved.",
    );
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    return str((value as { id: unknown }).id);
  }
  return null;
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

/** `invoice.subscription` moved under `parent.subscription_details` in newer API versions. */
function subscriptionRefOf(obj: Record<string, unknown>): string | null {
  const direct = idOf(obj.subscription);
  if (direct) return direct;
  const parent = obj.parent as
    | { subscription_details?: { subscription?: unknown } }
    | null
    | undefined;
  return idOf(parent?.subscription_details?.subscription);
}

/**
 * Builds the real adapter. Reads only the HONE_BILLING_* variables from the
 * env it is given. It makes no network call until a method is invoked.
 */
export function createBillingStripeClient(
  env: Readonly<Record<string, string | undefined>>,
): BillingStripeClient {
  const secret = env.HONE_BILLING_STRIPE_SECRET_KEY;
  if (!secret) {
    throw new Error("HONE_BILLING_STRIPE_SECRET_KEY is not set.");
  }
  assertBillingKeyIsTestMode(secret);
  const webhookSecret = env.HONE_BILLING_WEBHOOK_SECRET;
  const stripe = new Stripe(secret, {
    apiVersion: BILLING_STRIPE_API_VERSION,
    typescript: true,
    appInfo: { name: "Hone billing" },
  });

  return {
    async retrievePrice(priceId) {
      const p = await stripe.prices.retrieve(priceId);
      return {
        id: p.id,
        active: p.active,
        currency: p.currency,
        unit_amount: p.unit_amount,
        type: p.type,
        livemode: p.livemode,
        recurring: p.recurring
          ? {
              interval: p.recurring.interval,
              interval_count: p.recurring.interval_count,
            }
          : null,
      };
    },

    async retrieveSubscription(subscriptionId) {
      const s = await stripe.subscriptions.retrieve(subscriptionId);
      return {
        id: s.id,
        status: s.status,
        customer: idOf(s.customer) ?? "",
        livemode: s.livemode,
        cancel_at_period_end: s.cancel_at_period_end,
        metadata: stringMap(s.metadata),
        items: s.items.data.map((item) => ({
          price: {
            id: item.price.id,
            currency: item.price.currency,
            unit_amount: item.price.unit_amount,
            livemode: item.price.livemode,
            recurring: item.price.recurring
              ? {
                  interval: item.price.recurring.interval,
                  interval_count: item.price.recurring.interval_count,
                }
              : null,
          },
          quantity: item.quantity ?? null,
          current_period_end: item.current_period_end ?? null,
        })),
      };
    },

    async createCheckoutSession(params) {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: params.priceId, quantity: 1 }],
        client_reference_id: params.clientReferenceId,
        ...(params.customerEmail ? { customer_email: params.customerEmail } : {}),
        metadata: params.metadata,
        subscription_data: { metadata: params.metadata },
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        expires_at: params.expiresAt,
      });
      return { id: session.id, url: session.url };
    },

    constructEvent(rawBody, signature) {
      if (!webhookSecret) {
        throw new Error("HONE_BILLING_WEBHOOK_SECRET is not set.");
      }
      const e = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
      const obj = e.data.object as unknown as Record<string, unknown>;
      return {
        id: e.id,
        type: e.type,
        created: e.created,
        livemode: e.livemode,
        object: {
          id: str(obj.id),
          mode: str(obj.mode),
          client_reference_id: str(obj.client_reference_id),
          subscription: subscriptionRefOf(obj),
          metadata: stringMap(obj.metadata),
        },
      };
    },
  };
}
