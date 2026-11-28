import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A second run on the same stack reuses HONE_E2E_RUN_ID, and the in-process
// counter restarts with the server. Ids must still differ between processes, or
// the new run's pi_..._1 collides (23505) with the previous run's stored rows.

const RUN = "run-nonce1234";
const saved = { ...process.env };

type Stripe = {
  paymentIntents: { create: (p: unknown, o: unknown) => Promise<{ id: string; latest_charge?: unknown }> };
};

async function freshProcessMint(key: string): Promise<{ id: string }> {
  vi.resetModules();
  const mod = await import("@/lib/stripe/e2e-fake-stripe");
  const stripe = mod.createFakeStripe() as unknown as Stripe;
  return stripe.paymentIntents.create(
    { amount: 1000, currency: "cad" },
    { stripeAccount: "acct_test_1", idempotencyKey: key },
  );
}

describe("fake Stripe ids are unique per process", () => {
  beforeEach(() => {
    process.env.HONE_E2E_FAKE_STRIPE = "1";
    process.env.HONE_E2E_RUN_ID = RUN;
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.resetModules();
  });

  it("two processes with the same run id and the same sequence number mint different ids", async () => {
    const a = await freshProcessMint("hone:k:a");
    const b = await freshProcessMint("hone:k:a");
    expect(a.id).not.toBe(b.id);
  });

  it("ids keep the run id and a trailing _<digits> sequence", async () => {
    const a = await freshProcessMint("hone:k:b");
    expect(a.id).toMatch(new RegExp(`^pi_test_e2e_${RUN}_[0-9a-f]{8}_1$`));
  });

  it("within one process the sequence still increments", async () => {
    vi.resetModules();
    const mod = await import("@/lib/stripe/e2e-fake-stripe");
    const s = mod.createFakeStripe() as unknown as Stripe;
    const one = await s.paymentIntents.create({ amount: 1, currency: "cad" }, { stripeAccount: "a", idempotencyKey: "k1" });
    const two = await s.paymentIntents.create({ amount: 1, currency: "cad" }, { stripeAccount: "a", idempotencyKey: "k2" });
    expect(one.id).not.toBe(two.id);
    expect(one.id.replace(/_\d+$/, "")).toBe(two.id.replace(/_\d+$/, ""));
  });
});
