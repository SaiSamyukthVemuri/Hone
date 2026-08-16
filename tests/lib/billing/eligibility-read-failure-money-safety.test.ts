import { beforeEach, describe, expect, it, vi } from "vitest";

// PAY-READ-01 PR D - MONEY-SAFETY BOUNDARY.
//
// eligibility-read-fail-closed.test.ts proves the two HELPERS now answer a read
// failure with a truthful, blocking reason. That is not the same as proving no
// money moves. The prepare actions are the boundary that matters: they read
// `eligibility.eligible` and, if it holds, INSERT a payment_charge_attempts row
// and go on to claim and charge.
//
// So this drives the REAL prepare actions with an eligibility read failing, and
// replaces every write, RPC and Stripe surface with a TRIPWIRE that throws.
// Nothing may fire.
//
// A tripwire that is never armed proves nothing, so each case is paired with a
// POSITIVE CONTROL on the SAME fixture shape that removes only the read failure
// and shows the path reaching its first money operation. Without that, "zero
// writes" could simply mean the fixture was unsatisfiable.

class Tripwire extends Error {}

const DB_ERROR = {
  code: "57014",
  message: "canceling statement due to statement timeout",
};

const h = vi.hoisted(() => ({
  livemode: false,
  outcomes: {} as Record<string, { kind: string; data?: unknown }>,
  writes: [] as string[],
  rpcs: [] as string[],
  stripeCalls: [] as string[],
}));

vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => h.livemode,
  getStripe: () => {
    h.stripeCalls.push("getStripe");
    throw new Tripwire("Stripe reached during an unverifiable eligibility");
  },
  getAppOrigin: () => "https://example.test",
}));

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "p1", role: "owner" },
    studio: { id: "11111111-1111-4111-8111-111111111111", timezone: "America/Toronto" },
  }),
}));

// #585's helper. Held at signed_current so the ONLY variable in each case is
// the eligibility read under test; without this the session helper hits the
// real helper, finds no template in the outcome table and blocks for an
// unrelated reason - which would make every "zero money" assertion vacuous.
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

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: async () => {} }));

// Reads resolve from the outcome table. Every WRITE and RPC is a tripwire.
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {};
      const settle = () => {
        const o = h.outcomes[table] ?? { kind: "zero" };
        switch (o.kind) {
          case "error":
            return { data: null, error: DB_ERROR };
          case "empty":
            return { data: [], error: null };
          case "rows":
            return { data: o.data, error: null };
          default:
            return { data: null, error: null };
        }
      };
      const write = (op: string) => {
        h.writes.push(`${table}.${op}`);
        throw new Tripwire(`WRITE ${op} on ${table}`);
      };
      q.select = () => q;
      q.eq = () => q;
      q.is = () => q;
      q.in = () => q;
      q.order = () => q;
      q.limit = () => q;
      q.maybeSingle = async () => settle();
      q.single = async () => settle();
      q.then = (resolve: (v: unknown) => unknown) => resolve(settle());
      q.insert = () => write("insert");
      q.update = () => write("update");
      q.upsert = () => write("upsert");
      q.delete = () => write("delete");
      return q;
    },
    rpc: (name: string) => {
      h.rpcs.push(name);
      throw new Tripwire(`RPC ${name}`);
    },
  }),
}));

// Authoritative pricing is not what this test is about; keep it healthy so the
// positive control can reach the INSERT.
vi.mock("@/lib/billing/authoritative-session-payment", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getAuthoritativeSessionPaymentAmount: async () => ({
      ok: true,
      result: { kind: "resolved", amountCents: 12000, currency: "cad", serviceName: "S" },
    }),
  };
});

const { prepareSessionPaymentChargeAction } = await import(
  "@/app/(app)/clients/[id]/sessions/[sessionId]/payment-actions"
);
const { prepareManualFeeChargeAction } = await import(
  "@/app/(app)/calendar/[id]/manual-fee-actions"
);

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const APPT = "44444444-4444-4444-8444-444444444444";

function rows(t: string, data: unknown) {
  h.outcomes[t] = { kind: "rows", data };
}
function empty(t: string) {
  h.outcomes[t] = { kind: "empty" };
}
function err(t: string) {
  h.outcomes[t] = { kind: "error" };
}

function healthySession() {
  rows("sessions", {
    id: SESSION,
    studio_id: STUDIO,
    client_id: CLIENT,
    modality: "electrolysis",
    started_at: "2026-08-01T00:00:00.000Z",
    ended_at: "2026-08-01T01:00:00.000Z",
    price_paid_cents: null,
    appointment_id: APPT,
    appointments: { id: APPT, status: "completed", starts_at: "2026-08-01T00:00:00.000Z" },
  });
  rows("client_payment_methods", {
    id: "cpm-1",
    brand: "visa",
    last4: "4242",
    exp_month: 12,
    exp_year: 2030,
    status: "active",
    stripe_livemode: false,
    stripe_account_id: "acct_test",
    stripe_customer_id: "cus_test",
    stripe_payment_method_id: "pm_test",
    card_authorization_signature_id: "sig-1",
  });
  rows("studio_payment_settings", {
    stripe_account_id: "acct_test",
    stripe_account_status: "enabled",
    stripe_livemode: false,
  });
  empty("payment_charge_attempts");
}

function healthyFee() {
  rows("appointments", {
    id: APPT,
    studio_id: STUDIO,
    client_id: CLIENT,
    status: "no_show",
    starts_at: "2026-08-01T00:00:00.000Z",
    cancelled_at: null,
    created_at: "2026-07-30T00:00:00.000Z",
    service: { name: "Service" },
    client: { id: CLIENT, name: "A B" },
  });
  rows("client_payment_methods", {
    id: "cpm-1",
    brand: "visa",
    last4: "4242",
    exp_month: 12,
    exp_year: 2030,
    status: "active",
    stripe_livemode: false,
    card_authorization_signature_id: "sig-1",
  });
  rows("client_consent_signatures", {
    id: "sig-1",
    client_id: CLIENT,
    template_id: "tpl-1",
    template_version: 3,
    signed_at: "2026-08-01T00:00:00.000Z",
    signature_name: "A B",
    template_title_snapshot: "Card authorization",
  });
  rows("consent_form_templates", { id: "tpl-1", version: 3 });
  rows("appointment_policy_acknowledgements", {
    id: "ack-1",
    acknowledged_at: "2026-08-01T00:00:00.000Z",
    policy_snapshot_hash: "hash-1",
  });
  rows("studios", { id: STUDIO, no_show_fee_cents: 5000, late_cancel_fee_cents: 5000 });
  empty("payment_charge_attempts");
  empty("manual_fee_charge_attempts");
}

// A tripwire may ESCAPE the action or be swallowed by the action's own
// try/catch, depending on where in the flow it fires. Assertions must not
// depend on which, so every call goes through this and every assertion then
// inspects the RECORDED arrays.
async function run(fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Tripwire) return { ok: false as const, tripped: true };
    throw e;
  }
}

function moneyTouched() {
  return h.writes.length + h.rpcs.length + h.stripeCalls.length;
}

beforeEach(() => {
  h.livemode = false;
  h.outcomes = {};
  h.writes = [];
  h.rpcs = [];
  h.stripeCalls = [];
});

function sessionForm() {
  const fd = new FormData();
  // The action reads SNAKE_CASE keys. camelCase keys silently produce an empty
  // sessionId and an early generic refusal - which would have made every
  // "zero money" assertion in this file pass without ever reaching eligibility.
  fd.set("session_id", SESSION);
  fd.set("expected_amount_cents", "12000");
  fd.set("internal_note", "note");
  return fd;
}

function feeForm() {
  const fd = new FormData();
  fd.set("appointment_id", APPT);
  fd.set("charge_type", "no_show");
  fd.set("internal_note", "note");
  return fd;
}

describe("SESSION PAYMENT prepare: an unverifiable eligibility reaches no money", () => {
  // One case per authoritative read, so a regression names the read.
  for (const table of [
    "sessions",
    "client_payment_methods",
    "studio_payment_settings",
    "payment_charge_attempts",
  ]) {
    it(`${table} read error -> no INSERT, no RPC, no Stripe`, async () => {
      healthySession();
      err(table);
      const res = (await run(() =>
        prepareSessionPaymentChargeAction(sessionForm()),
      )) as { ok: boolean };
      expect(res.ok).toBe(false);
      expect(h.writes).toEqual([]);
      expect(h.rpcs).toEqual([]);
      expect(h.stripeCalls).toEqual([]);
    });
  }

  it("POSITIVE CONTROL: healthy reads reach the attempt INSERT", async () => {
    // NOTE: both prepare actions wrap their body in a top-level try/catch and
    // convert ANY throw into generic copy, so the tripwire never surfaces as a
    // rejection. That is exactly why every assertion in this file - including
    // the error cases above - inspects the RECORDED arrays rather than relying
    // on a thrown error. A test built on `.rejects` here would be measuring the
    // action's catch block, not its behaviour.
    healthySession();
    await run(() => prepareSessionPaymentChargeAction(sessionForm()));
    expect(h.writes).toContain("payment_charge_attempts.insert");
  });
});

describe("MANUAL FEE prepare: an unverifiable eligibility reaches no money", () => {
  for (const table of [
    "appointments",
    "client_payment_methods",
    "client_consent_signatures",
    "consent_form_templates",
    "appointment_policy_acknowledgements",
    "studios",
    "payment_charge_attempts",
    "manual_fee_charge_attempts",
  ]) {
    it(`${table} read error -> no INSERT, no claim, no Stripe`, async () => {
      healthyFee();
      err(table);
      const res = (await run(() =>
        prepareManualFeeChargeAction(feeForm()),
      )) as { ok: boolean };
      expect(res.ok).toBe(false);
      expect(moneyTouched()).toBe(0);
    });
  }

  it("POSITIVE CONTROL: healthy reads reach the first money operation", async () => {
    // Test mode, so the LIVE hard hold is absent and this path is genuinely
    // reachable. If this ran in live mode the hold alone would block and every
    // assertion above would pass for the wrong reason.
    healthyFee();
    await run(() => prepareManualFeeChargeAction(feeForm()));
    expect(moneyTouched()).toBeGreaterThan(0);
    // Name the surface rather than counting, so a regression is legible.
    expect(h.writes.join(",")).toMatch(/payment_charge_attempts\.insert/);
  });
});
