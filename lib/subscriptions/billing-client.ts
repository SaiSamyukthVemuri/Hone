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
import type { SubscriptionChange } from "./subscription-change";
import { parsePlanKey, PLANS, resolvePlanPriceId } from "./plans";
import { priceRefusal } from "./checkout-session";
import { readBillingInvoices, readBillingProfile } from "./billing-overview";

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
  account?: string;
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
  customer?: string;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  /** Unix seconds. Stripe requires at least 30 minutes from creation. */
  expiresAt: number;
  attemptId?: string;
  /** The generation claimed in the database before this call; the idempotency key is derived from it. */
  generation?: number;
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
) {
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
    billingProfile: (customer: string, subscription: string) => readBillingProfile(stripe, customer, subscription),
    billingInvoices: (customer: string, subscription: string, after?: string) => readBillingInvoices(stripe, customer, subscription, after),

    async applyOwnerChange(change: SubscriptionChange): Promise<"applied" | "canceled" | "refused"> {
      const sub = await stripe.subscriptions.retrieve(change.subscription);
      if (sub.id !== change.subscription || sub.livemode || idOf(sub.customer) !== change.customer ||
          sub.metadata.hone_attempt_id !== change.attempt || sub.metadata.hone_user_id !== change.user) {
        throw new Error("Unexpected billing subscription");
      }
      if (sub.status === "canceled") return "canceled";
      if (change.target === "cancel") {
        const canceled = await stripe.subscriptions.cancel(sub.id, { invoice_now: false, prorate: false });
        if (canceled.id !== sub.id || canceled.status !== "canceled") throw new Error("Cancellation unconfirmed");
        return "canceled";
      }
      const target = change.target;
      const priceId = resolvePlanPriceId(target, env);
      if (!priceId) throw new Error("Tier price unavailable");
      const item = sub.items.data[0];
      const current = parsePlanKey(sub.metadata.hone_plan);
      if (!current || sub.items.has_more || sub.items.data.length !== 1 || item.quantity !== 1 ||
          item.price.id !== resolvePlanPriceId(current, env) || item.price.livemode) return "refused";
      if (current === target) return "applied";
      if (sub.status !== "active" || sub.cancel_at || sub.cancel_at_period_end || sub.pending_update || sub.schedule ||
          current !== change.plan) return "refused";
      const price = await stripe.prices.retrieve(priceId);
      if (priceRefusal(price, priceId, PLANS[target])) throw new Error("Unexpected tier price");
      const updated = await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, price: priceId, quantity: 1 }],
        proration_behavior: "none", payment_behavior: "error_if_incomplete",
        metadata: { hone_plan: target },
      }, { idempotencyKey: "hone-tier-" + change.id });
      if (updated.id !== sub.id || updated.metadata.hone_plan !== target || updated.items.data[0]?.price.id !== priceId) {
        throw new Error("Tier change unconfirmed");
      }
      return "applied";
    },

    async canEditTaxId(configuration: string) {
      const config = await stripe.billingPortal.configurations.retrieve(configuration);
      const feature = config.features.customer_update;
      return config.active && !config.livemode && feature.enabled && feature.allowed_updates.includes("tax_id");
    },

    async readInvoice(id: string) {
      const inv = await stripe.invoices.retrieve(id, { expand: ["payments"] });
      return {
        id: inv.id,
        live: inv.livemode,
        subscription: idOf(inv.parent?.subscription_details?.subscription),
        customer: idOf(inv.customer),
        reason: inv.billing_reason,
        status: inv.status,
        currency: inv.currency,
        total: inv.total,
        amountPaid: inv.amount_paid,
        price:
          inv.lines.data.length === 1 && !inv.lines.has_more
            ? idOf(inv.lines.data[0].pricing?.price_details?.price)
            : null,
        collected: (inv.payments?.data ?? [])
          .filter(
            (p) =>
              p.status === "paid" &&
              p.currency === inv.currency &&
              p.payment.type === "payment_intent",
          )
          .reduce((sum, p) => sum + (p.amount_paid ?? 0), 0),
      };
    },

    async readNoticeInvoice(id: string) {
      const invoice = await stripe.invoices.retrieve(id);
      const line = invoice.lines.data[0];
      return {
        id: invoice.id,
        live: invoice.livemode,
        customer: idOf(invoice.customer),
        subscription: idOf(invoice.parent?.subscription_details?.subscription),
        status: invoice.status,
        number: invoice.number,
        currency: invoice.currency,
        amountPaid: invoice.amount_paid,
        amountRemaining: invoice.amount_remaining,
        total: invoice.total,
        subtotal: invoice.subtotal,
        tax: (invoice.total_taxes ?? []).reduce((sum, part) => sum + part.amount, 0),
        paidAt: invoice.status_transitions.paid_at,
        price: idOf(line?.pricing?.price_details?.price),
        period: line?.period,
        hostedUrl: invoice.hosted_invoice_url ?? null,
      };
    },

    async findAttemptSession(attempt: {
      id: string;
      created: number;
      session: string | null;
    }) {
      if (attempt.session)
        return stripe.checkout.sessions.retrieve(attempt.session);
      // A crash can occur after Stripe creates the session but before its ID is stored.
      for await (const session of stripe.checkout.sessions.list({
        created: { gte: attempt.created - 60, lte: attempt.created + 1860 },
        limit: 100,
      })) {
        if ((session.metadata?.hone_restart_id ?? session.metadata?.hone_attempt_id) === attempt.id) return session;
      }
      return null;
    },

    async ownerPortal(
      customer: string,
      returnUrl: string,
      configuration: string,
      cardUpdate?: { subscription: string },
    ) {
      let useCardFlow = false;
      if (cardUpdate) {
        const sub = await stripe.subscriptions.retrieve(cardUpdate.subscription);
        if (sub.livemode || sub.id !== cardUpdate.subscription || idOf(sub.customer) !== customer) {
          throw new Error("Unexpected billing subscription");
        }
        // The deep link changes the customer's default. When the subscription
        // overrides it, the full portal lets the owner manage that override too.
        useCardFlow = !sub.default_payment_method && !sub.default_source;
      }
      return (
        await stripe.billingPortal.sessions.create({
          customer,
          configuration,
          return_url: returnUrl,
          ...(useCardFlow && {
            flow_data: {
              type: "payment_method_update",
              after_completion: { type: "redirect", redirect: { return_url: returnUrl } },
            },
          }),
        })
      ).url;
    },

    async retrievePrice(priceId: string) {
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

    async retrieveSubscription(subscriptionId: string) {
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

    async createCheckoutSession(params: CreateCheckoutSessionParams) {
      const session = await stripe.checkout.sessions.create(
        {
          mode: "subscription",
          line_items: [{ price: params.priceId, quantity: 1 }],
          client_reference_id: params.clientReferenceId,
          ...(params.customer ? { customer: params.customer } : params.customerEmail
            ? { customer_email: params.customerEmail }
            : {}),
          metadata: params.metadata,
          subscription_data: { metadata: params.metadata },
          success_url: params.successUrl,
          cancel_url: params.cancelUrl,
          expires_at: params.expiresAt,
          automatic_tax: { enabled: false },
        },
        params.attemptId
          // Keyed by the generation the database handed out for THIS submission (never a clock value, which two
          // overlapping requests can share). A new generation is a new key, so Stripe never sees one key with different
          // parameters; a lost response is recovered by looking the session up first.
          ? { idempotencyKey: "hone-signup-" + params.attemptId + "-" + (params.generation ?? params.expiresAt) }
          : undefined,
      );
      return { id: session.id, url: session.url };
    },

    constructEvent(rawBody: string, signature: string): BillingEvent {
      if (!webhookSecret) {
        throw new Error("HONE_BILLING_WEBHOOK_SECRET is not set.");
      }
      const e = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
      const obj = e.data.object as unknown as Record<string, unknown>;
      return {
        id: e.id,
        type: e.type,
        account: e.account ?? e.context?.toString(),
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
