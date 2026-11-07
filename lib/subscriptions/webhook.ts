// Billing webhook handling (HON-70): signature, refetch, idempotency, decision.
//
// This module decides; it does not persist. The caller supplies `lookup`
// (what is already recorded) and applies the returned decision inside one
// database command. Until the migration lands there is no store, so nothing
// here can write.
//
// Rules:
//   * A missing or invalid signature is refused before anything is read.
//   * The event body is never trusted. For every supported event the
//     subscription is REFETCHED from Stripe and the decision is made from that.
//   * Entitlement comes from the refetched subscription, never from a success
//     redirect.
//   * Duplicate event ids are a no-op; an older event never overwrites newer
//     recorded state; replays cannot unlock studio creation twice.
//   * Live-mode events are refused (test-mode only for now).

import type {
  BillingEvent,
  BillingStripeClient,
  BillingSubscription,
} from "./billing-client";
import {
  PLANS,
  planForPriceId,
  type PlanKey,
  type SubscriptionEnv,
} from "./plans";

export const SUPPORTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

/**
 * Statuses that count as paid access. past_due / unpaid / canceled / incomplete
 * are NOT entitled. The past-due and recovery policy is still an open decision
 * (HON-70) and must be settled before live release; this is the conservative
 * placeholder and it only gates creating a NEW studio.
 */
const ENTITLED_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);

export interface KnownState {
  /** This Stripe event id was already fully processed. */
  eventProcessed: boolean;
  /** What is recorded for this Stripe subscription, if anything. */
  subscription: {
    /** `created` of the newest event already applied. */
    lastEventCreated: number;
  } | null;
  /**
   * An unlock was already issued to THIS USER, by any of their subscriptions.
   * The unlock is user-scoped, never subscription-scoped: a subscription Hone
   * has not seen yet must not read as "this user was never unlocked", or two
   * Checkout Sessions by one user would each unlock a studio (Codex P2
   * 4499972609). The caller resolves it from the user binding of the REFETCHED
   * subscription.
   */
  userStudioCreationUnlocked: boolean;
}

export interface EntitlementWrite {
  userId: string;
  plan: PlanKey;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: string;
  entitled: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: number | null;
  lastEventId: string;
  lastEventCreated: number;
}

const USER_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Hone user ids are uuids; anything else in Stripe-side metadata is not ours. */
export function isUserId(value: string): boolean {
  return USER_ID_SHAPE.test(value);
}

export type RefusalReason =
  | "livemode_event"
  | "subscription_livemode"
  | "no_single_item"
  | "price_not_allowlisted"
  | "currency"
  | "interval"
  | "amount"
  | "quantity"
  | "missing_user_binding"
  | "plan_metadata_mismatch"
  | "user_binding_mismatch"
  | "not_subscription_checkout";

export type WebhookDecision =
  | { kind: "ignored"; reason: "unsupported_event" | "no_subscription" }
  | { kind: "duplicate" }
  | { kind: "stale" }
  | { kind: "refused"; reason: RefusalReason }
  | {
      kind: "apply";
      entitlement: EntitlementWrite;
      /** True at most once per user: the first time an entitled state is seen. */
      unlockStudioCreation: boolean;
    };

export type WebhookOutcome =
  | { http: 200; decision: WebhookDecision }
  | { http: 400; error: "missing_signature" | "invalid_signature" }
  /** Refetch failed: 5xx makes Stripe retry, which is what we want. */
  | { http: 502; error: "subscription_unavailable" };

/** The subscription id an event refers to, or null. */
export function subscriptionIdOf(event: BillingEvent): string | null {
  if (event.type.startsWith("customer.subscription.")) return event.object.id;
  return event.object.subscription;
}

/**
 * Pure decision over an already-refetched subscription. No I/O, no clock.
 */
export function decideBillingEvent(input: {
  event: BillingEvent;
  subscription: BillingSubscription;
  known: KnownState;
  env: SubscriptionEnv;
}): WebhookDecision {
  const { event, subscription, known, env } = input;

  if (known.eventProcessed) return { kind: "duplicate" };
  if (event.livemode) return { kind: "refused", reason: "livemode_event" };
  if (subscription.livemode) {
    return { kind: "refused", reason: "subscription_livemode" };
  }
  if (event.type === "checkout.session.completed" && event.object.mode !== "subscription") {
    return { kind: "refused", reason: "not_subscription_checkout" };
  }

  // Exactly one line item, on an allow-listed price, quantity 1.
  if (subscription.items.length !== 1) {
    return { kind: "refused", reason: "no_single_item" };
  }
  const item = subscription.items[0];
  const planKey = planForPriceId(item.price.id, env);
  if (planKey === null) {
    return { kind: "refused", reason: "price_not_allowlisted" };
  }
  const plan = PLANS[planKey];
  if (item.price.currency !== plan.currency) {
    return { kind: "refused", reason: "currency" };
  }
  if (
    item.price.recurring === null ||
    item.price.recurring.interval !== plan.interval ||
    item.price.recurring.interval_count !== 1
  ) {
    return { kind: "refused", reason: "interval" };
  }
  if (item.price.unit_amount !== plan.unitAmount) {
    return { kind: "refused", reason: "amount" };
  }
  if (item.quantity !== 1) return { kind: "refused", reason: "quantity" };

  // The subscription must be bound to a Hone user, and every binding present
  // must agree: plan metadata with the price, session reference with the user.
  const userId = subscription.metadata.hone_user_id;
  if (!userId || !isUserId(userId)) {
    return { kind: "refused", reason: "missing_user_binding" };
  }
  const metaPlan = subscription.metadata.hone_plan;
  if (metaPlan !== undefined && metaPlan !== planKey) {
    return { kind: "refused", reason: "plan_metadata_mismatch" };
  }
  if (
    event.type === "checkout.session.completed" &&
    event.object.client_reference_id !== userId
  ) {
    return { kind: "refused", reason: "user_binding_mismatch" };
  }

  // Out of order: the refetched state is already current, so an older event
  // changes nothing. Do not overwrite newer recorded metadata with it.
  if (
    known.subscription !== null &&
    event.created < known.subscription.lastEventCreated
  ) {
    return { kind: "stale" };
  }

  const entitled = ENTITLED_STATUSES.has(subscription.status);
  const alreadyUnlocked = known.userStudioCreationUnlocked;
  return {
    kind: "apply",
    unlockStudioCreation: entitled && !alreadyUnlocked,
    entitlement: {
      userId,
      plan: planKey,
      stripeCustomerId: subscription.customer,
      stripeSubscriptionId: subscription.id,
      status: subscription.status,
      entitled,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodEnd: item.current_period_end,
      lastEventId: event.id,
      lastEventCreated: event.created,
    },
  };
}

export async function handleBillingWebhook(input: {
  rawBody: string;
  signature: string | null;
  client: BillingStripeClient;
  env: SubscriptionEnv;
  /** Has this Stripe event id been fully processed? Asked before any refetch. */
  lookupEvent: (eventId: string) => Promise<boolean>;
  /**
   * What is recorded for this subscription and this user. Asked after the
   * refetch, because the user comes from the refetched subscription's binding.
   */
  lookupState: (ids: {
    subscriptionId: string;
    userId: string;
  }) => Promise<Pick<KnownState, "subscription" | "userStudioCreationUnlocked">>;
}): Promise<WebhookOutcome> {
  if (!input.signature) return { http: 400, error: "missing_signature" };

  let event: BillingEvent;
  try {
    event = input.client.constructEvent(input.rawBody, input.signature);
  } catch {
    return { http: 400, error: "invalid_signature" };
  }

  if (!SUPPORTED_EVENT_TYPES.has(event.type)) {
    return { http: 200, decision: { kind: "ignored", reason: "unsupported_event" } };
  }
  // Refuse before any refetch: a live event cannot be read with a test key, so
  // refetching would only fail and make Stripe retry it forever.
  if (event.livemode) {
    return { http: 200, decision: { kind: "refused", reason: "livemode_event" } };
  }
  const subscriptionId = subscriptionIdOf(event);
  if (!subscriptionId) {
    return { http: 200, decision: { kind: "ignored", reason: "no_subscription" } };
  }

  // A replay needs no refetch.
  if (await input.lookupEvent(event.id)) {
    return { http: 200, decision: { kind: "duplicate" } };
  }

  let subscription: BillingSubscription;
  try {
    subscription = await input.client.retrieveSubscription(subscriptionId);
  } catch {
    return { http: 502, error: "subscription_unavailable" };
  }
  // The user is whoever the REFETCHED subscription is bound to. With no
  // binding there is nothing to look up (and the decision refuses it).
  // A missing OR malformed id is "no binding" (a 200 refusal, never a lookup that
  // could throw and make Stripe retry forever). Insurance R-4.
  const rawUserId = subscription.metadata.hone_user_id;
  const userId = rawUserId && isUserId(rawUserId) ? rawUserId : null;
  const state = userId
    ? await input.lookupState({ subscriptionId, userId })
    : { subscription: null, userStudioCreationUnlocked: false };
  const known: KnownState = { eventProcessed: false, ...state };
  return {
    http: 200,
    decision: decideBillingEvent({ event, subscription, known, env: input.env }),
  };
}
