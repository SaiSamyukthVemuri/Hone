import { beforeEach, describe, expect, it, vi } from "vitest";

// PAY-SETTLE / 0187 — THE CALLER MUST RESPECT THE DATABASE'S REFUSAL.
//
// THE DEFECT THIS FILE EXISTS TO PIN. 0187 taught
// claim_session_payment_charge_attempt to refuse a visit already recorded as
// paid in cash / by e-transfer / another way / waived: it takes the shared
// appointment advisory key, returns `settled_externally`, and leaves the
// attempt in `ready`. tests/db/appointment-settlement.db.test.ts proves that
// half against the real database.
//
// It proves NOTHING about the layer above. runSessionPaymentCharge recognised a
// FIXED SET of claim results and let everything else fall through to
// stripe.paymentIntents.create — so the database refused, the application
// charged the client's card anyway, and the success write then matched zero
// rows and reported manual review. A guarantee the caller routes around is not
// a guarantee.
//
// So this file does not read source and does not trust a type. It drives the
// real executor with the real result code and asserts, behaviourally, that
// Stripe is never contacted — and then arms a CONTROL proving the same harness
// DOES reach Stripe when the claim succeeds. Without the control, "zero Stripe
// calls" could simply mean the fixture never got that far.

class Tripwire extends Error {}

const h = vi.hoisted(() => ({
  claimResult: "settled_externally" as string,
  // Set true by the negative control to simulate the pre-repair caller.
  bypassRepair: false,
  stmts: [] as Array<{ table: string; op: string }>,
  rpcs: [] as string[],
  stripeCalls: [] as string[],
  rows: {} as Record<string, unknown>,
}));

// --- provider spy ----------------------------------------------------------
// Every Stripe surface is recorded AND throws. Recording answers "how many
// times"; throwing makes an accidental reach impossible to miss.
function stripeTripwire(): never {
  throw new Tripwire("Stripe was contacted on an externally-settled visit");
}
const fakeStripe = {
  paymentIntents: {
    create: () => {
      h.stripeCalls.push("paymentIntents.create");
      return stripeTripwire();
    },
    retrieve: () => {
      h.stripeCalls.push("paymentIntents.retrieve");
      return stripeTripwire();
    },
    cancel: () => {
      h.stripeCalls.push("paymentIntents.cancel");
      return stripeTripwire();
    },
    confirm: () => {
      h.stripeCalls.push("paymentIntents.confirm");
      return stripeTripwire();
    },
  },
  refunds: {
    create: () => {
      h.stripeCalls.push("refunds.create");
      return stripeTripwire();
    },
  },
};

vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => false,
  getStripe: () => fakeStripe,
}));
vi.mock("@/lib/stripe/session-payment-stripe", () => ({
  getSessionPaymentStripe: () => fakeStripe,
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => {} }));
vi.mock("@/lib/billing/charge-description", () => ({
  buildChargeDescription: () => "desc",
}));
vi.mock("@/lib/consent/current-card-authorization", () => ({
  getChargeReadyCardAuthorizationStatus: async () => ({
    kind: "signed_current",
    signatureId: "sig-1",
    templateId: "tpl-1",
    templateVersion: 3,
    signedAt: "2026-08-01T00:00:00.000Z",
  }),
  getCardAuthorizationStatus: async () => ({
    kind: "signed_current",
    signatureId: "sig-1",
    templateId: "tpl-1",
    templateVersion: 3,
    signedAt: "2026-08-01T00:00:00.000Z",
  }),
}));

// --- write spy -------------------------------------------------------------
// Reads resolve. Any WRITE is recorded and throws: the claim of this repair is
// that the attempt is left EXACTLY as the database left it — no transition to
// pending_stripe, no success row, no failure row, no manual-review record.
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {};
      const read = () => {
        h.stmts.push({ table, op: "select" });
        return { data: h.rows[table] ?? null, error: null };
      };
      const write = (op: string) => {
        h.stmts.push({ table, op });
        throw new Tripwire(`WRITE ${op} on ${table} after settled_externally`);
      };
      q.select = () => q;
      q.eq = () => q;
      q.is = () => q;
      q.in = () => q;
      q.order = () => q;
      q.limit = () => q;
      q.maybeSingle = async () => read();
      q.single = async () => read();
      q.then = (resolve: (v: unknown) => unknown) => resolve(read());
      q.insert = () => write("insert");
      q.update = () => write("update");
      q.upsert = () => write("upsert");
      q.delete = () => write("delete");
      return q;
    },
    // THE REAL CLAIM CONTRACT, mirrored. The shape matches what 0187's
    // `returns table (...)` sends back through PostgREST.
    rpc: async (name: string) => {
      h.rpcs.push(name);
      if (name !== "claim_session_payment_charge_attempt") {
        return { data: null, error: null };
      }
      // THE NEGATIVE CONTROL. When armed, the RPC reports the pre-0187 shape
      // for the same situation — an unrecognised result — which is exactly what
      // the caller used to receive and fall through on.
      const result = h.bypassRepair ? "some_unhandled_result" : h.claimResult;
      if (result === "claimed") {
        return {
          data: [
            {
              result: "claimed",
              attempt_id: ATTEMPT,
              studio_id: STUDIO,
              client_id: HEALTHY_ATTEMPT.client_id,
              session_id: HEALTHY_ATTEMPT.session_id,
              appointment_id: APPOINTMENT,
              charge_reason: "session_payment",
              amount_cents: 12000,
              currency: "cad",
              client_payment_method_id: "cpm-1",
              card_authorization_signature_id: "sig-1",
              stripe_account_id: "acct_test",
              stripe_customer_id: "cus_test",
              stripe_payment_method_id: "pm_test",
              stripe_payment_intent_id: null,
              stripe_idempotency_key: "idem-1",
              status_before_claim: "ready",
              updated_at: "2026-08-01T00:00:00.000Z",
            },
          ],
          error: null,
        };
      }
      // The refusal shape: the identifying columns only. Every money column is
      // null, exactly as 0187 returns them, so a caller that fell through would
      // be charging against nulls — which is what made the bug survivable
      // enough to reach review rather than crashing loudly.
      return {
        data: [
          {
            result,
            attempt_id: ATTEMPT,
            studio_id: null,
            client_id: null,
            session_id: null,
            appointment_id: APPOINTMENT,
            charge_reason: null,
            amount_cents: null,
            currency: null,
            client_payment_method_id: null,
            card_authorization_signature_id: null,
            stripe_account_id: null,
            stripe_customer_id: null,
            stripe_payment_method_id: null,
            stripe_payment_intent_id: null,
            stripe_idempotency_key: null,
            status_before_claim: null,
            updated_at: null,
          },
        ],
        error: null,
      };
    },
  }),
}));

const { runSessionPaymentCharge } = await import(
  "@/lib/billing/session-payment-charge"
);

const STUDIO = "11111111-1111-4111-8111-111111111111";
const APPOINTMENT = "66666666-6666-4666-8666-666666666666";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const PRACTITIONER = "44444444-4444-4444-8444-444444444444";

// A completely healthy prepared attempt: every guard BEFORE the claim passes,
// so the claim result is the ONLY thing that can stop this charge. If the row
// were malformed the test would pass for the wrong reason.
const HEALTHY_ATTEMPT = {
  id: ATTEMPT,
  studio_id: STUDIO,
  charge_reason: "session_payment",
  client_id: "22222222-2222-4222-8222-222222222222",
  session_id: "55555555-5555-4555-8555-555555555555",
  appointment_id: APPOINTMENT,
  amount_cents: 12000,
  currency: "cad",
  status: "ready",
  stripe_livemode: false,
  client_payment_method_id: "cpm-1",
  card_authorization_signature_id: "sig-1",
  stripe_account_id: "acct_test",
  stripe_customer_id: "cus_test",
  stripe_payment_method_id: "pm_test",
  stripe_payment_intent_id: null,
  stripe_idempotency_key: null,
  updated_at: "2026-08-01T00:00:00.000Z",
};

beforeEach(() => {
  h.claimResult = "settled_externally";
  h.bypassRepair = false;
  h.stmts = [];
  h.rpcs = [];
  h.stripeCalls = [];
  h.rows = {
    payment_charge_attempts: HEALTHY_ATTEMPT,
    client_payment_methods: {
      id: HEALTHY_ATTEMPT.client_payment_method_id,
      studio_id: HEALTHY_ATTEMPT.studio_id,
      client_id: HEALTHY_ATTEMPT.client_id,
      status: "active",
      stripe_livemode: false,
      stripe_account_id: HEALTHY_ATTEMPT.stripe_account_id,
      stripe_customer_id: HEALTHY_ATTEMPT.stripe_customer_id,
      stripe_payment_method_id: HEALTHY_ATTEMPT.stripe_payment_method_id,
      card_authorization_signature_id:
        HEALTHY_ATTEMPT.card_authorization_signature_id,
    },
    studio_payment_settings: {
      stripe_account_id: HEALTHY_ATTEMPT.stripe_account_id,
      stripe_livemode: false,
    },
    client_stripe_customers: {
      stripe_customer_id: HEALTHY_ATTEMPT.stripe_customer_id,
    },
  };
});

describe("settled_externally is terminal, and lands BEFORE Stripe", () => {
  it("PROOF 1 — the claim really did return settled_externally", async () => {
    await runSessionPaymentCharge({
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
    });
    // The path reached the claim (so the refusal is not an earlier guard
    // passing for an unrelated reason) and stopped there.
    expect(h.rpcs).toContain("claim_session_payment_charge_attempt");
  });

  it("PROOF 2 — Stripe was called ZERO times", async () => {
    await runSessionPaymentCharge({
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
    });
    expect(h.stripeCalls).toEqual([]);
    expect(h.stripeCalls).toHaveLength(0);
  });

  it("PROOF 3 — no success / failure / manual-review path ran", async () => {
    await runSessionPaymentCharge({
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
    });
    // The attempt is left EXACTLY as the database left it. No transition to
    // pending_stripe, no charged_at, no failure row, no receipt.
    expect(h.stmts.filter((s) => s.op !== "select")).toEqual([]);
  });

  it("PROOF 4 — the caller is told safely, deterministically, and specifically", async () => {
    const res = await runSessionPaymentCharge({
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    // Not "succeeded", not "failed", not "needs_manual_review" — nothing that
    // would imply Stripe ran.
    expect(res.outcome).toBe("blocked");
    expect(["succeeded", "failed", "needs_manual_review"]).not.toContain(
      res.outcome,
    );
    // Specific enough to act on: a generic "not chargeable" would send the
    // practitioner hunting for a card problem that does not exist.
    expect(res.message).toMatch(/already has a recorded outcome/i);
    expect(res.message).toMatch(/no card charge was made/i);
    // And no database text or raw code reaches a practitioner.
    expect(res.message).not.toMatch(/settled_externally|PGRST|supabase|57014/i);
  });

  it("NEGATIVE CONTROL — bypassing the new branch turns the Stripe spy red", async () => {
    // The same harness, the same fixture, the same refusal SITUATION — but the
    // RPC reports a result the caller does not recognise, which is precisely
    // the pre-repair behaviour. If this did NOT reach Stripe, every assertion
    // above would be passing for some unrelated reason.
    h.bypassRepair = true;
    const res = await runSessionPaymentCharge({
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
    });

    // THE SPY WENT RED. The card was charged for a visit already settled.
    expect(h.stripeCalls).toContain("paymentIntents.create");

    // AND THIS IS THE REPORTED SYMPTOM, REPRODUCED EXACTLY. The Stripe reach
    // throws inside the executor, which cannot classify it, so the practitioner
    // is told the charge needs manual review — for a visit that was never
    // chargeable, after a card call that should never have happened. That is
    // the shape of the defect this repair removes.
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.outcome).toBe("needs_manual_review");
  });

  it("CONTROL — a successful claim still reaches Stripe, so nothing was over-blocked", async () => {
    h.claimResult = "claimed";
    await runSessionPaymentCharge({
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
    });
    // A legitimate charge is NOT blocked by this repair: the same harness that
    // records zero Stripe calls above records one here. Without this, the
    // refusal could be over-broad and every charge could be silently dead.
    expect(h.stripeCalls).toContain("paymentIntents.create");
  });
});

describe("no other consumer of the claim result can fall through", () => {
  it("runSessionPaymentCharge is the ONLY runtime caller of the claim RPC", async () => {
    // A second caller with its own result switch would need its own branch, and
    // this repair would be half-applied. Source-level, deliberately: the point
    // is that no OTHER call site exists to drive.
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const root = resolve(__dirname, "../../..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        const src = readFileSync(p, "utf8");
        if (/\.rpc\(\s*["'`]claim_session_payment_charge_attempt/.test(src)) {
          hits.push(p.slice(root.length + 1));
        }
      }
    };
    for (const dir of ["lib", "app", "components", "scripts"]) {
      walk(join(root, dir));
    }
    expect(hits).toEqual(["lib/billing/session-payment-charge.ts"]);
  });
});
