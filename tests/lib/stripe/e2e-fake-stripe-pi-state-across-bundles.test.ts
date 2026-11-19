// Next compiles each route into its own bundle, so module-level state written while a server action created a
// PaymentIntent is invisible to the webhook route that later retrieves or cancels it. The fake keeps each intent in the
// guarded run ledger as well, so a SECOND module instance (another bundle) states the same intent and a cancel made
// there is seen by the first.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const RUN = "pi-across-bundles-run-1";
const KEY = "hone:session_payment:across-bundles:v1";
const ACCOUNT = "acct_test_across";

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
afterAll(async () => {
  const ledger = await import("@/lib/stripe/e2e-fake-ledger");
  ledger.cleanupFakeStripeFiles(RUN);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("PaymentIntent state is shared across route bundles", () => {
  it("an intent created in one module instance is retrieved with its money and metadata in another, and a cancel there is seen back", async () => {
    const ledgerA = await import("@/lib/stripe/e2e-fake-ledger");
    ledgerA.resetFakeStripeLedger(RUN);
    ledgerA.setFakeStripeBehavior(RUN, KEY, "decline");
    const a = await import("@/lib/stripe/e2e-fake-stripe");
    const stripeA = a.createFakeStripe() as never as {
      paymentIntents: { create: (p: unknown, o: unknown) => Promise<unknown>; retrieve: (id: string, p: unknown, o: unknown) => Promise<Record<string, unknown>>; cancel: (id: string, p: unknown, o: unknown) => Promise<Record<string, unknown>> };
    };
    const thrown = await stripeA.paymentIntents
      .create(
        { amount: 22500, currency: "cad", customer: "cus_x", metadata: { hone_session_payment_charge_attempt_id: "att-1" } },
        { idempotencyKey: KEY, stripeAccount: ACCOUNT },
      )
      .then(() => null, (e: unknown) => e as { payment_intent?: { id: string } });
    const id = thrown?.payment_intent?.id as string;
    expect(id).toMatch(/^pi_test_e2e_/);

    vi.resetModules(); // a second bundle: fresh module state, same process, same ledger files
    const b = await import("@/lib/stripe/e2e-fake-stripe");
    const stripeB = b.createFakeStripe() as never as typeof stripeA;
    const seen = await stripeB.paymentIntents.retrieve(id, undefined, { stripeAccount: ACCOUNT });
    expect(seen).toMatchObject({ id, status: "requires_payment_method", amount: 22500, currency: "cad", amount_received: 0, metadata: { hone_session_payment_charge_attempt_id: "att-1" } });
    const canceled = await stripeB.paymentIntents.cancel(id, undefined, { stripeAccount: ACCOUNT });
    expect(canceled).toMatchObject({ id, status: "canceled" });

    vi.resetModules(); // a third bundle sees the cancel
    const c = await import("@/lib/stripe/e2e-fake-stripe");
    const stripeC = c.createFakeStripe() as never as typeof stripeA;
    expect(await stripeC.paymentIntents.retrieve(id, undefined, { stripeAccount: ACCOUNT })).toMatchObject({ id, status: "canceled" });
  });
});
