// The fake must refuse a declined card the way real Stripe does: a thrown card error that CARRIES the PaymentIntent,
// followed by a signed payment_intent.payment_failed event. Both reach the application's real code (the executor's thrown
// branch, and the webhook route's signature check), so a decline on the E2E lane ends the way it would in production:
// the attempt waits as pending_stripe until the webhook reconciles it to failed. Nothing here changes money handling.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

vi.mock("server-only", () => ({}));

const RUN = "decline-fidelity-run-1";
const ACCOUNT = "acct_test_decline";
const SECRET = "whsec_test_decline_fidelity";
const KEY = "hone:no_show_fee:decline-fidelity:v1";

const ledger = await import("@/lib/stripe/e2e-fake-ledger");
const fakeMod = await import("@/lib/stripe/e2e-fake-stripe");

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["HONE_E2E_FAKE_STRIPE", "HONE_E2E_RUN_ID", "VERCEL", "VERCEL_ENV", "PORT", "HONE_E2E_APP_ORIGIN"]) saved[k] = process.env[k];
  process.env.HONE_E2E_FAKE_STRIPE = "1";
  process.env.HONE_E2E_RUN_ID = RUN;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.PORT;
  delete process.env.HONE_E2E_APP_ORIGIN;
});
afterAll(() => {
  ledger.cleanupFakeStripeFiles(RUN);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  fakeMod.resetFakeStripeState(RUN);
  ledger.clearFakeStripeBehavior(RUN);
  ledger.resetFakeStripeLedger(RUN);
  ledger.setFakeStripeBehavior(RUN, KEY, "decline");
});

const client = () =>
  fakeMod.createFakeStripe() as unknown as { paymentIntents: { create: (p: unknown, o: unknown) => Promise<unknown> } };
const declinedCreate = () =>
  client().paymentIntents.create(
    { amount: 5000, currency: "cad", customer: "cus_test_decline", metadata: { hone_session_payment_charge_attempt_id: "att-1" } },
    { stripeAccount: ACCOUNT, idempotencyKey: KEY },
  );
const caught = async (): Promise<InstanceType<typeof Stripe.errors.StripeCardError>> => {
  try {
    await declinedCreate();
  } catch (e) {
    return e as InstanceType<typeof Stripe.errors.StripeCardError>;
  }
  throw new Error("a decline must throw");
};

describe("a declined create throws a card error carrying the PaymentIntent", () => {
  it("is a StripeCardError (what the executor's isDefinitiveChargeRefusal branch tests) with code, 402 and the intent", async () => {
    const err = await caught();
    expect(err).toBeInstanceOf(Stripe.errors.StripeCardError);
    expect(err.code).toBe("card_declined");
    expect(err.statusCode).toBe(402);
    const pi = (err as unknown as { payment_intent: Record<string, unknown> }).payment_intent;
    expect(pi).toMatchObject({
      status: "requires_payment_method", amount: 5000, currency: "cad", amount_received: 0, latest_charge: null, customer: "cus_test_decline",
      metadata: { hone_session_payment_charge_attempt_id: "att-1" },
      last_payment_error: { type: "card_error", code: "card_declined" },
    });
  });
  it("a replay of the same key throws the same intent again and creates no second effect", async () => {
    const a = (await caught()) as unknown as { payment_intent: { id: string } };
    const b = (await caught()) as unknown as { payment_intent: { id: string } };
    expect(b.payment_intent.id).toBe(a.payment_intent.id);
    const effects = fakeMod.getFakeStripeCalls(RUN).filter((c) => c.method === "pi_create" && !c.replay);
    expect(effects).toHaveLength(1);
  });
  it("a success is untouched: it resolves and states succeeded", async () => {
    ledger.clearFakeStripeBehavior(RUN);
    expect(await declinedCreate()).toMatchObject({ status: "succeeded", amount: 5000 });
  });
});

describe("the signed payment_intent.payment_failed event", () => {
  it("verifies with the real constructEvent, names the connected account, and carries the declined intent", async () => {
    const err = (await caught()) as unknown as { payment_intent: { id: string } };
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const out = await fakeMod.deliverFakePaymentFailedWebhook(RUN, err.payment_intent.id, ACCOUNT, {
      fetchImpl: fetchImpl as unknown as typeof fetch, origin: "http://127.0.0.1:9", secret: SECRET,
    });
    expect(out).toEqual({ delivered: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("http://127.0.0.1:9/api/stripe/webhook");
    const event = Stripe.webhooks.constructEvent(init.body as string, init.headers["stripe-signature"], SECRET);
    expect(event.type).toBe("payment_intent.payment_failed");
    expect(event.account).toBe(ACCOUNT);
    expect(event.livemode).toBe(false);
    expect((event.data.object as unknown as { customer: string }).customer).toBe("cus_test_decline");
    const obj = event.data.object as unknown as { id: string; status: string; last_payment_error: { type: string } };
    expect(obj).toMatchObject({ id: err.payment_intent.id, status: "requires_payment_method", last_payment_error: { type: "card_error" } });
  });
  it("a signature made with another secret does not verify", async () => {
    const err = (await caught()) as unknown as { payment_intent: { id: string } };
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    await fakeMod.deliverFakePaymentFailedWebhook(RUN, err.payment_intent.id, ACCOUNT, {
      fetchImpl: fetchImpl as unknown as typeof fetch, origin: "http://127.0.0.1:9", secret: SECRET,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(() => Stripe.webhooks.constructEvent(init.body as string, init.headers["stripe-signature"], "whsec_other")).toThrow();
  });
  it("sends nothing to a non-local origin, whatever way it is spelled", async () => {
    const err = (await caught()) as unknown as { payment_intent: { id: string } };
    for (const origin of [
      "https://example.com", "http://example.com:3000", "http://127.0.0.1.evil.test", "http://localhost.evil.test",
      "http://user:pw@127.0.0.1:3000", "https://127.0.0.1:3000", "http://10.0.0.5:3000", "http://[::1]:3000", "not a url",
    ]) {
      const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
      const out = await fakeMod.deliverFakePaymentFailedWebhook(RUN, err.payment_intent.id, ACCOUNT, {
        fetchImpl: fetchImpl as unknown as typeof fetch, origin, secret: SECRET,
      });
      expect(out, origin).toEqual({ delivered: false, status: null });
      expect(fetchImpl, origin).not.toHaveBeenCalled();
    }
    // and the same holds when the origin comes from the environment
    process.env.HONE_E2E_APP_ORIGIN = "https://example.com";
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    expect(await fakeMod.deliverFakePaymentFailedWebhook(RUN, err.payment_intent.id, ACCOUNT, { fetchImpl: fetchImpl as unknown as typeof fetch, secret: SECRET }))
      .toEqual({ delivered: false, status: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    delete process.env.HONE_E2E_APP_ORIGIN;
  });
  it("sends to 127.0.0.1 and localhost", async () => {
    const err = (await caught()) as unknown as { payment_intent: { id: string } };
    for (const origin of ["http://127.0.0.1:3000", "http://localhost:3000"]) {
      const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
      expect(await fakeMod.deliverFakePaymentFailedWebhook(RUN, err.payment_intent.id, ACCOUNT, {
        fetchImpl: fetchImpl as unknown as typeof fetch, origin, secret: SECRET,
      })).toEqual({ delivered: true, status: 200 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
  it("a REPLAY of a declined create sends no second event (before_return timing makes the send observable)", async () => {
    process.env.PORT = "3999";
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    ledger.setFakeStripeWebhookTiming(RUN, "before_return");
    const fetchStub = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    try {
      await caught();
      expect(fetchStub).toHaveBeenCalledTimes(1);
      await caught();
      await caught();
      expect(fetchStub).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.PORT;
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
  });
  it("a refused event (non-2xx) is REDELIVERED, as Stripe does, and stops at the first 2xx; an accepted one is sent once", async () => {
    process.env.PORT = "3999";
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    vi.useFakeTimers();
    const statuses = [500, 500, 200];
    const fetchStub = vi.fn(async () => new Response("x", { status: statuses.shift() ?? 200 }));
    vi.stubGlobal("fetch", fetchStub);
    try {
      await caught();
      expect(fetchStub).toHaveBeenCalledTimes(0); // first send is deferred
      await vi.advanceTimersByTimeAsync(800);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchStub).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchStub).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fetchStub).toHaveBeenCalledTimes(3); // stopped at the 200
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      delete process.env.PORT;
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
  });
  it("redelivery is bounded: an endpoint that never accepts is tried a fixed number of times, not forever", async () => {
    process.env.PORT = "3999";
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    vi.useFakeTimers();
    const fetchStub = vi.fn(async () => new Response("x", { status: 500 }));
    vi.stubGlobal("fetch", fetchStub);
    try {
      await caught();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchStub.mock.calls.length).toBeGreaterThan(1);
      expect(fetchStub.mock.calls.length).toBeLessThanOrEqual(10);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      delete process.env.PORT;
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
  });
  it("the DEFAULT secret is the environment's STRIPE_WEBHOOK_SECRET: the event verifies with it and with nothing else", async () => {
    const err = (await caught()) as unknown as { payment_intent: { id: string } };
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_from_environment";
    try {
      const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
      await fakeMod.deliverFakePaymentFailedWebhook(RUN, err.payment_intent.id, ACCOUNT, {
        fetchImpl: fetchImpl as unknown as typeof fetch, origin: "http://127.0.0.1:9",
      });
      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
      expect(Stripe.webhooks.constructEvent(init.body as string, init.headers["stripe-signature"], "whsec_from_environment").type)
        .toBe("payment_intent.payment_failed");
      expect(() => Stripe.webhooks.constructEvent(init.body as string, init.headers["stripe-signature"], SECRET)).toThrow();
    } finally {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
  });
  it("with no secret at all nothing is sent (and that is not what the no-origin case relies on)", async () => {
    const err = (await caught()) as unknown as { payment_intent: { id: string } };
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(await fakeMod.deliverFakePaymentFailedWebhook(RUN, err.payment_intent.id, ACCOUNT, {
      fetchImpl: fetchImpl as unknown as typeof fetch, origin: "http://127.0.0.1:9",
    })).toEqual({ delivered: false, status: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("sends nothing without an origin (ordinary unit tests have no PORT) and records no money effect of its own", async () => {
    const err = (await caught()) as unknown as { payment_intent: { id: string } };
    const before = fakeMod.getFakeStripeCalls(RUN).length;
    const fetchStub = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    try {
      // the secret IS given, so only the missing origin can be what stops the send
      expect(await fakeMod.deliverFakePaymentFailedWebhook(RUN, err.payment_intent.id, ACCOUNT, { secret: SECRET }))
        .toEqual({ delivered: false, status: null });
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
    // delivery is not a Stripe call: it adds no create, cancel or refund, and a decline is never retried by the fake
    expect(fakeMod.getFakeStripeCalls(RUN)).toHaveLength(before);
    expect(fakeMod.getFakeStripeCalls(RUN).filter((c) => c.method === "pi_create" && !c.replay)).toHaveLength(1);
    expect(fakeMod.getFakeStripeCalls(RUN).filter((c) => c.method === "refund_create")).toHaveLength(0);
  });
});
