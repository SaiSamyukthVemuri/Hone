import { beforeEach, describe, expect, it, vi } from "vitest";

// PAY-READ-01 PR B - MONEY-SAFETY CALLER PROOF.
//
// tests/lib/consent/card-authorization-read-fail-closed.test.ts proves the
// HELPER now answers `authorization_unverified` when a read fails. That is only
// half the finding. The other half is what the CALLERS do with a status they
// have never seen before, and the failure mode there is silent: a `switch` with
// no `default`, or an `if` chain whose last branch is the permissive one, will
// accept a brand-new union member without a word.
//
// So this file does not inspect source and does not trust a type. It DRIVES the
// two money paths with the new status and asserts that nothing chargeable
// happens - with every provider and write surface replaced by a TRIPWIRE that
// throws. A tripwire that is never armed proves nothing, so each one is also
// shown to fire on a control run.
//
// What is proved here, behaviourally:
//   PREPARE  - getSessionPaymentEligibility -> eligible:false, so the caller
//              returns before createAdminClient() and before the
//              payment_charge_attempts INSERT.
//   EXECUTE  - runSessionPaymentCharge -> ok:false BEFORE the claim RPC, before
//              any idempotency key is built, and before paymentIntents.create.
//   COPY     - neither surface tells the client to re-sign, and neither leaks
//              database text.

class Tripwire extends Error {}

const h = vi.hoisted(() => ({
  cardAuthKind: "authorization_unverified" as string,
  // Every DB statement the code under test issues, in order.
  stmts: [] as Array<{ table: string; op: string }>,
  rpcs: [] as string[],
  stripeCalls: [] as string[],
  // Rows a read should resolve to, by table.
  rows: {} as Record<string, unknown>,
}));

// --- the status under test -------------------------------------------------
// `signatureId` is supplied on the healthy statuses so the CONTROL below gets
// all the way past the lineage check (it must equal the attempt row's
// card_authorization_signature_id) and actually reaches money. Without it the
// control would be stopped by a DIFFERENT guard and would prove nothing about
// the tripwires. It is ignored on `authorization_unverified`, which carries no
// payload by design.
vi.mock("@/lib/consent/current-card-authorization", () => ({
  getChargeReadyCardAuthorizationStatus: async () => ({
    kind: h.cardAuthKind,
    signatureId: "sig-1",
    templateId: "tpl-1",
    templateVersion: 3,
    signedAt: "2026-08-01T00:00:00.000Z",
  }),
  getCardAuthorizationStatus: async () => ({
    kind: h.cardAuthKind,
    signatureId: "sig-1",
    templateId: "tpl-1",
    templateVersion: 3,
    signedAt: "2026-08-01T00:00:00.000Z",
  }),
}));

// --- provider tripwires ----------------------------------------------------
// Reaching Stripe AT ALL on an unverifiable authorization is the failure. We do
// not assert on arguments, because there is no argument list that would make
// the call acceptable.
function stripeTripwire(): never {
  throw new Tripwire("Stripe was contacted on an unverifiable authorization");
}
const fakeStripe = {
  paymentIntents: {
    create: (...a: unknown[]) => {
      h.stripeCalls.push("paymentIntents.create");
      void a;
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
  },
  setupIntents: {
    create: () => {
      h.stripeCalls.push("setupIntents.create");
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
  getSessionPaymentStripe: async () => ({
    ok: true,
    stripe: fakeStripe,
    stripeAccountId: "acct_test",
  }),
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => {} }));
vi.mock("@/lib/billing/charge-description", () => ({
  buildChargeDescription: () => "desc",
}));

// --- write tripwire --------------------------------------------------------
// Reads resolve normally. Any WRITE - insert, update, upsert, delete, or an
// RPC - throws. The money-safety claim is precisely that none of these run.
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
        throw new Tripwire(
          `WRITE ${op} on ${table} during an unverifiable authorization`,
        );
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
    rpc: (name: string) => {
      h.rpcs.push(name);
      throw new Tripwire(`RPC ${name} during an unverifiable authorization`);
    },
  }),
}));

const { runSessionPaymentCharge } = await import(
  "@/lib/billing/session-payment-charge"
);
const { getSessionPaymentEligibility } = await import(
  "@/lib/billing/session-payment-eligibility"
);

const STUDIO = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const PRACTITIONER = "44444444-4444-4444-8444-444444444444";

// A completely healthy prepared attempt. Every guard BEFORE the authorization
// recheck passes, so the only thing that can stop this charge is the recheck
// itself. If the attempt row were malformed the test would pass for the wrong
// reason.
const HEALTHY_ATTEMPT = {
  id: ATTEMPT,
  studio_id: STUDIO,
  charge_reason: "session_payment",
  client_id: "22222222-2222-4222-8222-222222222222",
  session_id: "55555555-5555-4555-8555-555555555555",
  appointment_id: null,
  amount_cents: 12000,
  currency: "cad",
  status: "pending",
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
  h.cardAuthKind = "authorization_unverified";
  h.stmts = [];
  h.rpcs = [];
  h.stripeCalls = [];
  h.rows = {
    payment_charge_attempts: HEALTHY_ATTEMPT,
    // Lineage-clean active card, consistent with the attempt row above, so the
    // CONTROL clears step 4 as well and the ONLY thing that ever stops this
    // charge is the authorization recheck under test.
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

describe("EXECUTE: an unverifiable authorization cannot reach money", () => {
  it("refuses, and never writes, never calls an RPC, never touches Stripe", async () => {
    const res = await runSessionPaymentCharge({
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
    });

    expect(res.ok).toBe(false);

    // The three money surfaces, each proved absent rather than assumed.
    expect(h.stripeCalls).toEqual([]);
    expect(h.rpcs).toEqual([]);
    expect(h.stmts.filter((s) => s.op !== "select")).toEqual([]);
  });

  it("the refusal does not accuse the client or the studio", async () => {
    const res = await runSessionPaymentCharge({
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
    });
    const message = res.ok ? "" : res.message;

    // The whole point of the new status: state is UNKNOWN, so no business
    // claim about the client or the studio may be made, and nobody may be sent
    // into a re-sign they might not need.
    expect(message).not.toMatch(/re-?sign/i);
    expect(message).not.toMatch(/no longer current/i);
    expect(message).not.toMatch(/unsigned|has not signed/i);
    // And no database text reaches a practitioner.
    expect(message).not.toMatch(/57014|statement timeout|PGRST|supabase/i);
    // It must be actionable and retryable instead.
    expect(message).toMatch(/could not be verified/i);
    expect(message).toMatch(/try again/i);
  });

  it("CONTROL: the tripwires really do fire when authorization IS current", async () => {
    // Without this, every assertion above could be passing because the charge
    // path never reaches Stripe under this harness for some unrelated reason.
    h.cardAuthKind = "signed_current";
    await expect(
      runSessionPaymentCharge({
        attemptId: ATTEMPT,
        studioId: STUDIO,
        practitionerId: PRACTITIONER,
      }),
    ).rejects.toBeInstanceOf(Tripwire);
    // Name the surface it reached rather than counting. The claim RPC is the
    // FIRST money operation on this path, so proving the control gets that far
    // proves the refusal above stops strictly earlier than any state change.
    expect(h.rpcs).toContain("claim_session_payment_charge_attempt");
  });
});

describe("PREPARE: an unverifiable authorization is never eligible", () => {
  const SESSION = HEALTHY_ATTEMPT.session_id;
  const CLIENT = HEALTHY_ATTEMPT.client_id;

  function prepareRows() {
    return {
      sessions: {
        id: SESSION,
        studio_id: STUDIO,
        client_id: CLIENT,
        modality: "electrolysis",
        started_at: "2026-08-01T00:00:00.000Z",
        ended_at: "2026-08-01T01:00:00.000Z",
        price_paid_cents: null,
        appointment_id: "66666666-6666-4666-8666-666666666666",
        appointments: {
          id: "66666666-6666-4666-8666-666666666666",
          status: "completed",
          starts_at: "2026-08-01T00:00:00.000Z",
        },
      },
      client_payment_methods: {
        id: HEALTHY_ATTEMPT.client_payment_method_id,
        brand: "visa",
        last4: "4242",
        exp_month: 12,
        exp_year: 2030,
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
        stripe_account_status: "enabled",
      },
      // No prior attempt for this session.
      payment_charge_attempts: [],
    };
  }

  beforeEach(() => {
    h.rows = prepareRows();
  });

  it("is NOT eligible, so the caller returns before the attempt INSERT", async () => {
    const e = await getSessionPaymentEligibility({
      studioId: STUDIO,
      sessionId: SESSION,
    });
    expect(e.eligible).toBe(false);
    // The prepare action reads `eligible` and returns immediately; the INSERT
    // is downstream of that check, so no write may have been attempted here.
    expect(h.stmts.filter((s) => s.op !== "select")).toEqual([]);
    expect(h.rpcs).toEqual([]);
    expect(h.stripeCalls).toEqual([]);
  });

  it("blocks EXPLICITLY, with retryable copy - not via the generic fallback", async () => {
    const e = await getSessionPaymentEligibility({
      studioId: STUDIO,
      sessionId: SESSION,
    });
    const reasons = e.eligible ? [] : e.blockingReasons;
    const joined = reasons.join(" | ");

    // Before this PR the new status matched no `case` and pushed no reason:
    // prepare still failed, but only incidentally (via the `cardAuthSummary &&`
    // conjunct) and with copy that explained nothing. A named reason is the
    // difference between failing closed and failing closed ON PURPOSE.
    expect(reasons.length).toBeGreaterThan(0);
    expect(joined).toMatch(/could not be verified/i);
    expect(joined).toMatch(/try again/i);
    // And it must not invent a business condition.
    expect(joined).not.toMatch(/re-?sign/i);
    expect(joined).not.toMatch(/must add a card/i);
    expect(joined).not.toMatch(/57014|statement timeout|PGRST/i);
  });

  it("CONTROL: the same fixtures ARE eligible when authorization is current", async () => {
    // Proves the refusal above is caused by the authorization status and not by
    // an incidentally unsatisfiable fixture.
    h.cardAuthKind = "signed_current";
    const e = await getSessionPaymentEligibility({
      studioId: STUDIO,
      sessionId: SESSION,
    });
    expect(e.eligible).toBe(true);
  });
});
