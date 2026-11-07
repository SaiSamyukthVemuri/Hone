import { describe, expect, it } from "vitest";
import {
  decideBillingEvent,
  handleBillingWebhook,
  subscriptionIdOf,
  type KnownState,
} from "@/lib/subscriptions/webhook";
import {
  ENV_ON,
  STUDIO_PRICE,
  event,
  fakeBilling,
  subscription,
} from "./helpers/fake-billing-client";

const FRESH: KnownState = { eventProcessed: false, subscription: null, userStudioCreationUnlocked: false };

function decide(over: {
  event?: ReturnType<typeof event>;
  subscription?: ReturnType<typeof subscription>;
  known?: KnownState;
} = {}) {
  return decideBillingEvent({
    event: over.event ?? event(),
    subscription: over.subscription ?? subscription(),
    known: over.known ?? FRESH,
    env: ENV_ON,
  });
}

describe("decideBillingEvent", () => {
  it("applies an active subscription and unlocks studio creation once", () => {
    const d = decide();
    expect(d).toMatchObject({
      kind: "apply",
      unlockStudioCreation: true,
      entitlement: {
        userId: "11111111-1111-4111-8111-111111111111",
        plan: "solo",
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
        status: "active",
        entitled: true,
        lastEventId: "evt_1",
        lastEventCreated: 1000,
      },
    });
  });

  it("derives the plan from the PRICE, so Studio is Studio", () => {
    const d = decide({
      subscription: subscription(
        { metadata: { hone_user_id: "11111111-1111-4111-8111-111111111111", hone_plan: "studio" } },
        { id: STUDIO_PRICE, unit_amount: 9900 },
      ),
    });
    expect(d).toMatchObject({ kind: "apply", entitlement: { plan: "studio" } });
  });

  it("does not unlock a second time once an unlock was issued", () => {
    const d = decide({
      known: {
        eventProcessed: false,
        subscription: { lastEventCreated: 500 },
        userStudioCreationUnlocked: true,
      },
    });
    expect(d).toMatchObject({ kind: "apply", unlockStudioCreation: false });
  });

  it("treats a duplicate event id as a no-op", () => {
    expect(decide({ known: { eventProcessed: true, subscription: null, userStudioCreationUnlocked: false } })).toEqual({
      kind: "duplicate",
    });
  });

  it("ignores an older event than recorded state (out of order)", () => {
    const d = decide({
      event: event({ created: 900 }),
      known: {
        eventProcessed: false,
        subscription: { lastEventCreated: 1000 },
        userStudioCreationUnlocked: true,
      },
    });
    expect(d).toEqual({ kind: "stale" });
  });

  it("does not re-unlock when a later event replays the same entitled state", () => {
    const first = decide();
    expect(first).toMatchObject({ unlockStudioCreation: true });
    const second = decide({
      event: event({ id: "evt_2", created: 1100 }),
      known: {
        eventProcessed: false,
        subscription: { lastEventCreated: 1000 },
        userStudioCreationUnlocked: true,
      },
    });
    expect(second).toMatchObject({ kind: "apply", unlockStudioCreation: false });
  });

  it.each(["past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"])(
    "does not entitle or unlock a %s subscription",
    (status) => {
      expect(decide({ subscription: subscription({ status }) })).toMatchObject({
        kind: "apply",
        unlockStudioCreation: false,
        entitlement: { status, entitled: false },
      });
    },
  );

  it("entitles a trialing subscription", () => {
    expect(decide({ subscription: subscription({ status: "trialing" }) })).toMatchObject({
      entitlement: { entitled: true },
    });
  });

  it("records cancellation at period end without revoking early", () => {
    expect(
      decide({ subscription: subscription({ cancel_at_period_end: true }) }),
    ).toMatchObject({ entitlement: { cancelAtPeriodEnd: true, entitled: true } });
  });

  const refusals: Array<[string, Parameters<typeof decide>[0], string]> = [
    ["a live-mode event", { event: event({ livemode: true }) }, "livemode_event"],
    ["a live-mode subscription", { subscription: subscription({ livemode: true }) }, "subscription_livemode"],
    ["a foreign price", { subscription: subscription({}, { id: "price_other" }) }, "price_not_allowlisted"],
    ["the wrong currency", { subscription: subscription({}, { currency: "cad" }) }, "currency"],
    ["a yearly interval", { subscription: subscription({}, { recurring: { interval: "year", interval_count: 1 } }) }, "interval"],
    ["a one-time price", { subscription: subscription({}, { recurring: null }) }, "interval"],
    ["the wrong amount", { subscription: subscription({}, { unit_amount: 100 }) }, "amount"],
    ["quantity 2", { subscription: subscription({}, {}, { quantity: 2 }) }, "quantity"],
    ["two line items", { subscription: { ...subscription(), items: [...subscription().items, ...subscription().items] } }, "no_single_item"],
    ["no line items", { subscription: { ...subscription(), items: [] } }, "no_single_item"],
    ["no user binding", { subscription: subscription({ metadata: {} }) }, "missing_user_binding"],
    ["a malformed user binding", { subscription: subscription({ metadata: { hone_user_id: "not-a-uuid", hone_plan: "solo" } }) }, "missing_user_binding"],
    ["plan metadata that disagrees with the price", { subscription: subscription({ metadata: { hone_user_id: "11111111-1111-4111-8111-111111111111", hone_plan: "studio" } }) }, "plan_metadata_mismatch"],
    [
      "a session whose client_reference_id is a different user",
      {
        event: event({
          type: "checkout.session.completed",
          object: { id: "cs_1", mode: "subscription", client_reference_id: "22222222-2222-4222-8222-222222222222", subscription: "sub_1", metadata: {} },
        }),
      },
      "user_binding_mismatch",
    ],
    [
      "a non-subscription checkout session",
      {
        event: event({
          type: "checkout.session.completed",
          object: { id: "cs_1", mode: "payment", client_reference_id: "11111111-1111-4111-8111-111111111111", subscription: "sub_1", metadata: {} },
        }),
      },
      "not_subscription_checkout",
    ],
  ];
  it.each(refusals)("refuses %s", (_name, over, reason) => {
    expect(decide(over)).toEqual({ kind: "refused", reason });
  });

  it("accepts a matching checkout.session.completed", () => {
    const d = decide({
      event: event({
        type: "checkout.session.completed",
        object: { id: "cs_1", mode: "subscription", client_reference_id: "11111111-1111-4111-8111-111111111111", subscription: "sub_1", metadata: {} },
      }),
    });
    expect(d).toMatchObject({ kind: "apply", unlockStudioCreation: true });
  });
});

describe("subscriptionIdOf", () => {
  it("uses the object id for customer.subscription.* and the reference otherwise", () => {
    expect(subscriptionIdOf(event({ type: "customer.subscription.deleted" }))).toBe("sub_1");
    expect(
      subscriptionIdOf(
        event({
          type: "invoice.paid",
          object: { id: "in_1", mode: null, client_reference_id: null, subscription: "sub_9", metadata: {} },
        }),
      ),
    ).toBe("sub_9");
    expect(
      subscriptionIdOf(
        event({
          type: "invoice.paid",
          object: { id: "in_1", mode: null, client_reference_id: null, subscription: null, metadata: {} },
        }),
      ),
    ).toBeNull();
  });
});

describe("handleBillingWebhook", () => {
  const RAW = '{"id":"evt_1"}';
  const SIG = "t=1,v1=ok";
  const lookups = {
    lookupEvent: async () => false,
    lookupState: async () => ({ subscription: null, userStudioCreationUnlocked: false }),
  };

  function signed(e = event()) {
    return { rawBody: RAW, signature: SIG, event: e };
  }

  it("refuses a missing signature before touching the client", async () => {
    const client = fakeBilling({ signed: signed() });
    for (const signature of [null, ""]) {
      const out = await handleBillingWebhook({ rawBody: RAW, signature, client, env: ENV_ON, ...lookups });
      expect(out).toEqual({ http: 400, error: "missing_signature" });
    }
    expect(client.calls.constructEvent).toBe(0);
    expect(client.calls.retrieveSubscription).toEqual([]);
  });

  it("refuses an invalid signature or a tampered body without refetching", async () => {
    const client = fakeBilling({ signed: signed(), subscription: subscription() });
    const bad = await handleBillingWebhook({ rawBody: RAW, signature: "forged", client, env: ENV_ON, ...lookups });
    const tampered = await handleBillingWebhook({ rawBody: RAW + " ", signature: SIG, client, env: ENV_ON, ...lookups });
    expect(bad).toEqual({ http: 400, error: "invalid_signature" });
    expect(tampered).toEqual({ http: 400, error: "invalid_signature" });
    expect(client.calls.retrieveSubscription).toEqual([]);
  });

  it("a malformed hone_user_id is a 200 refusal and the store is never asked (Insurance R-4)", async () => {
    const client = fakeBilling({
      signed: signed(),
      subscription: subscription({ metadata: { hone_user_id: "'; drop table x; --", hone_plan: "solo" } }),
    });
    const out = await handleBillingWebhook({
      rawBody: RAW, signature: SIG, client, env: ENV_ON,
      lookupEvent: async () => false,
      lookupState: async () => { throw new Error("must not be asked with an unvalidated id"); },
    });
    expect(out).toMatchObject({ http: 200, decision: { kind: "refused", reason: "missing_user_binding" } });
  });

  it("refetches the subscription and decides from it, not from the event", async () => {
    // The event claims nothing about status; the refetched subscription is canceled.
    const client = fakeBilling({
      signed: signed(),
      subscription: subscription({ status: "canceled" }),
    });
    const out = await handleBillingWebhook({ rawBody: RAW, signature: SIG, client, env: ENV_ON, ...lookups });
    expect(client.calls.retrieveSubscription).toEqual(["sub_1"]);
    expect(out).toMatchObject({
      http: 200,
      decision: { kind: "apply", unlockStudioCreation: false, entitlement: { entitled: false } },
    });
  });

  it("unlocks from a verified paid subscription", async () => {
    const client = fakeBilling({ signed: signed(), subscription: subscription() });
    const out = await handleBillingWebhook({ rawBody: RAW, signature: SIG, client, env: ENV_ON, ...lookups });
    expect(out).toMatchObject({ http: 200, decision: { kind: "apply", unlockStudioCreation: true } });
  });

  it("short-circuits a duplicate without a refetch", async () => {
    const client = fakeBilling({ signed: signed(), subscription: subscription() });
    const out = await handleBillingWebhook({
      rawBody: RAW, signature: SIG, client, env: ENV_ON,
      lookupEvent: async () => true,
      lookupState: async () => { throw new Error("must not be asked for a replay"); },
    });
    expect(out).toEqual({ http: 200, decision: { kind: "duplicate" } });
    expect(client.calls.retrieveSubscription).toEqual([]);
  });

  it("acknowledges unsupported events without a refetch", async () => {
    const client = fakeBilling({ signed: signed(event({ type: "charge.refunded" })) });
    const out = await handleBillingWebhook({ rawBody: RAW, signature: SIG, client, env: ENV_ON, ...lookups });
    expect(out).toEqual({ http: 200, decision: { kind: "ignored", reason: "unsupported_event" } });
    expect(client.calls.retrieveSubscription).toEqual([]);
  });

  it("acknowledges an event with no subscription reference", async () => {
    const e = event({ type: "invoice.paid", object: { id: "in_1", mode: null, client_reference_id: null, subscription: null, metadata: {} } });
    const client = fakeBilling({ signed: signed(e) });
    const out = await handleBillingWebhook({ rawBody: RAW, signature: SIG, client, env: ENV_ON, ...lookups });
    expect(out).toEqual({ http: 200, decision: { kind: "ignored", reason: "no_subscription" } });
  });

  it("refuses a live-mode event before refetching (no endless retry)", async () => {
    const client = fakeBilling({ signed: signed(event({ livemode: true })), subscription: subscription() });
    const out = await handleBillingWebhook({ rawBody: RAW, signature: SIG, client, env: ENV_ON, ...lookups });
    expect(out).toEqual({ http: 200, decision: { kind: "refused", reason: "livemode_event" } });
    expect(client.calls.retrieveSubscription).toEqual([]);
  });

  it("asks Stripe to retry when the refetch fails", async () => {
    const client = fakeBilling({ signed: signed(), subscription: new Error("stripe down") });
    const out = await handleBillingWebhook({ rawBody: RAW, signature: SIG, client, env: ENV_ON, ...lookups });
    expect(out).toEqual({ http: 502, error: "subscription_unavailable" });
  });

  it("is idempotent end to end: replaying the same event yields one unlock", async () => {
    // A tiny in-memory store standing in for the future DB command. The unlock is USER-scoped.
    const store = { processed: new Set<string>(), unlockedUsers: new Set<string>(), last: new Map<string, number>(), unlocks: 0 };
    const client = fakeBilling({ signed: signed(), subscription: subscription() });
    const run = async () => {
      const out = await handleBillingWebhook({
        rawBody: RAW, signature: SIG, client, env: ENV_ON,
        lookupEvent: async (id) => store.processed.has(id),
        lookupState: async ({ subscriptionId, userId }) => ({
          subscription: store.last.has(subscriptionId) ? { lastEventCreated: store.last.get(subscriptionId)! } : null,
          userStudioCreationUnlocked: store.unlockedUsers.has(userId),
        }),
      });
      if (out.http === 200 && out.decision.kind === "apply") {
        store.processed.add(out.decision.entitlement.lastEventId);
        store.last.set(out.decision.entitlement.stripeSubscriptionId, out.decision.entitlement.lastEventCreated);
        if (out.decision.unlockStudioCreation) { store.unlockedUsers.add(out.decision.entitlement.userId); store.unlocks += 1; }
      }
      return out;
    };
    await run();
    await run();
    await run();
    expect(store.unlocks).toBe(1);
  });

  it("Codex P2 4499972609: TWO subscriptions by the SAME user unlock a studio once, not twice", async () => {
    const store = { processed: new Set<string>(), unlockedUsers: new Set<string>(), last: new Map<string, number>(), unlocks: 0 };
    const play = async (eventId: string, subId: string, userId: string, created: number) => {
      const sub = subscription({ id: subId, metadata: { hone_user_id: userId, hone_plan: "solo" } });
      const e = event({ id: eventId, created, object: { id: subId, mode: null, client_reference_id: null, subscription: null, metadata: {} } });
      const client = fakeBilling({ signed: { rawBody: RAW, signature: SIG, event: e }, subscription: sub });
      const out = await handleBillingWebhook({
        rawBody: RAW, signature: SIG, client, env: ENV_ON,
        lookupEvent: async (id) => store.processed.has(id),
        lookupState: async ({ subscriptionId, userId: u }) => ({
          subscription: store.last.has(subscriptionId) ? { lastEventCreated: store.last.get(subscriptionId)! } : null,
          userStudioCreationUnlocked: store.unlockedUsers.has(u),
        }),
      });
      if (out.http === 200 && out.decision.kind === "apply") {
        store.processed.add(eventId);
        store.last.set(subId, created);
        if (out.decision.unlockStudioCreation) { store.unlockedUsers.add(userId); store.unlocks += 1; }
      }
      return out;
    };
    await play("evt_a", "sub_A", "11111111-1111-4111-8111-111111111111", 1000); // first Checkout Session
    await play("evt_b", "sub_B", "11111111-1111-4111-8111-111111111111", 1001); // second, same user, a subscription Hone has never seen
    expect(store.unlocks).toBe(1);
    // A DIFFERENT user still gets their own unlock (the marker is per user, not global).
    await play("evt_c", "sub_C", "22222222-2222-4222-8222-222222222222", 1002);
    expect(store.unlocks).toBe(2);
  });

  it("an unseen subscription does not make the user look un-unlocked (decision level)", () => {
    const unseenButUserUnlocked: KnownState = { eventProcessed: false, subscription: null, userStudioCreationUnlocked: true };
    expect(decide({ known: unseenButUserUnlocked })).toMatchObject({ kind: "apply", unlockStudioCreation: false });
    // ...and the same unseen subscription for a user who was never unlocked does unlock.
    expect(decide({ known: FRESH })).toMatchObject({ kind: "apply", unlockStudioCreation: true });
  });
});
