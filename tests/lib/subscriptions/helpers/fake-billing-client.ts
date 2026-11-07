// A FAKE billing-Stripe client. It never touches the network or the SDK, so a
// test using it cannot reach Stripe even by mistake.

import type {
  BillingEvent,
  BillingPrice,
  BillingStripeClient,
  BillingSubscription,
  CreateCheckoutSessionParams,
} from "@/lib/subscriptions/billing-client";
import type { SubscriptionEnv } from "@/lib/subscriptions/plans";

export const SOLO_PRICE = "price_testSolo123";
export const STUDIO_PRICE = "price_testStudio123";

export const ENV_ON: SubscriptionEnv = {
  HONE_SELF_SERVE_CHECKOUT_ENABLED: "true",
  HONE_STRIPE_PRICE_SOLO: SOLO_PRICE,
  HONE_STRIPE_PRICE_STUDIO: STUDIO_PRICE,
};

export function price(over: Partial<BillingPrice> = {}): BillingPrice {
  return {
    id: SOLO_PRICE,
    active: true,
    currency: "usd",
    unit_amount: 4900,
    type: "recurring",
    livemode: false,
    recurring: { interval: "month", interval_count: 1 },
    ...over,
  };
}

export function subscription(
  over: Partial<BillingSubscription> = {},
  itemPrice: Partial<BillingSubscription["items"][number]["price"]> = {},
  item: Partial<BillingSubscription["items"][number]> = {},
): BillingSubscription {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    livemode: false,
    cancel_at_period_end: false,
    metadata: { hone_user_id: "11111111-1111-4111-8111-111111111111", hone_plan: "solo" },
    items: [
      {
        price: {
          id: SOLO_PRICE,
          currency: "usd",
          unit_amount: 4900,
          livemode: false,
          recurring: { interval: "month", interval_count: 1 },
          ...itemPrice,
        },
        quantity: 1,
        current_period_end: 2_000_000_000,
        ...item,
      },
    ],
    ...over,
  };
}

export function event(over: Partial<BillingEvent> = {}): BillingEvent {
  return {
    id: "evt_1",
    type: "customer.subscription.updated",
    created: 1000,
    livemode: false,
    object: {
      id: "sub_1",
      mode: null,
      client_reference_id: null,
      subscription: null,
      metadata: {},
    },
    ...over,
  };
}

export interface FakeBilling extends BillingStripeClient {
  calls: {
    retrievePrice: string[];
    retrieveSubscription: string[];
    createCheckoutSession: CreateCheckoutSessionParams[];
    constructEvent: number;
  };
}

export function fakeBilling(opts: {
  prices?: Record<string, BillingPrice>;
  subscription?: BillingSubscription | Error;
  /** The only (rawBody, signature) pair the fake accepts, with its event. */
  signed?: { rawBody: string; signature: string; event: BillingEvent };
  checkoutUrl?: string | null;
  /** When set, createCheckoutSession throws this. */
  createError?: Error;
} = {}): FakeBilling {
  const calls: FakeBilling["calls"] = {
    retrievePrice: [],
    retrieveSubscription: [],
    createCheckoutSession: [],
    constructEvent: 0,
  };
  return {
    calls,
    async retrievePrice(id) {
      calls.retrievePrice.push(id);
      const p = opts.prices?.[id];
      if (!p) throw new Error("no such price");
      return p;
    },
    async retrieveSubscription(id) {
      calls.retrieveSubscription.push(id);
      const s = opts.subscription;
      if (!s || s instanceof Error) throw s ?? new Error("no such subscription");
      return s;
    },
    async createCheckoutSession(params) {
      calls.createCheckoutSession.push(params);
      if (opts.createError) throw opts.createError;
      return {
        id: "cs_test_1",
        url:
          opts.checkoutUrl === undefined
            ? "https://checkout.stripe.test/c/cs_test_1"
            : opts.checkoutUrl,
      };
    },
    constructEvent(rawBody, signature) {
      calls.constructEvent += 1;
      const s = opts.signed;
      if (!s || s.rawBody !== rawBody || s.signature !== signature) {
        throw new Error("signature mismatch");
      }
      return s.event;
    },
  };
}
