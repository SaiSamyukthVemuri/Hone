import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Review 3778160194: the same read-failure class as 3777890267, in the
// batched DISPLAY loader.
//
// FREENESS IS A POSITIVE CLAIM. It must never be inferred from a read we
// cannot vouch for. The failure Codex named is an INVERSION: a $0 menu service
// overridden by a POSITIVE custom price is chargeable, but if the
// client_pricing read fails, `pricingRows ?? []` becomes an empty pricing set,
// the resolver returns `free`, and the Dashboard/appointment detail render
// "No payment required" and suppress Checkout for a visit that should be paid.
//
// The safe direction on failure is to assert nothing is free: the appointment
// falls back to its ordinary state, Checkout stays visible, and no money moves,
// preparation and execution re-resolve authoritatively and fail closed on
// their own.

type Rows = { data: unknown; error: unknown };

const responses: Record<string, Rows> = {
  appointments: { data: [], error: null },
  services: { data: [], error: null },
  client_pricing: { data: [], error: null },
  // The outer function also reads these; no session and no attempt means the
  // free/no_session determination is driven purely by the pricing path above.
  sessions: { data: [], error: null },
  payment_charge_attempts: { data: [], error: null },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      q.select = chain;
      q.eq = chain;
      q.in = chain;
      q.is = chain;
      q.order = chain;
      q.then = (resolve: (v: Rows) => unknown) => resolve(responses[table]);
      return q;
    },
  }),
}));

import { getAppointmentPaymentStates } from "@/lib/billing/appointment-payment-state";

const APPT = "appt-1";
const TZ = "America/Toronto";

// A $0 menu service: free ONLY if no positive custom price overrides it.
function baseRows(servicePriceCents: number | null) {
  responses.appointments = {
    data: [
      {
        id: APPT,
        client_id: "client-1",
        service_id: "svc-1",
        duration_minutes: 30,
      },
    ],
    error: null,
  };
  responses.services = {
    data: [{ id: "svc-1", name: "Consultation", price_cents: servicePriceCents }],
    error: null,
  };
  responses.client_pricing = { data: [], error: null };
  // Reset the transaction-state reads too, so a case that scripts them cannot
  // leak into the next test.
  responses.sessions = { data: [], error: null };
  responses.payment_charge_attempts = { data: [], error: null };
}

beforeEach(() => {
  baseRows(0);
});
afterEach(() => vi.clearAllMocks());

async function stateFor(): Promise<string> {
  const states = await getAppointmentPaymentStates("studio-1", [APPT], TZ);
  return states.get(APPT) ?? "no_session";
}

describe("read failure is UNAVAILABLE, never an affirmative payment fact", () => {
  // ---- success cases must survive (an absence that was actually READ is a fact)

  it("P1 transaction reads OK + no session => no_session preserved", async () => {
    baseRows(0);
    responses.sessions = { data: [], error: null };
    // menu price 0 would be free, but with no session the reducer answers first
    responses.client_pricing = { data: [], error: null };
    expect(await stateFor()).toBe("free");
    // and with a payable service it is the ordinary no-session answer
    baseRows(10_000);
    expect(await stateFor()).toBe("no_session");
  });

  it("P2 session + no attempt + payable price => chargeable preserved", async () => {
    baseRows(10_000);
    responses.sessions = {
      data: [{ id: "sess-1", appointment_id: APPT }],
      error: null,
    };
    responses.payment_charge_attempts = { data: [], error: null };
    expect(await stateFor()).toBe("chargeable");
  });

  it("P3 explicit $0 => free", async () => {
    baseRows(0);
    responses.sessions = {
      data: [{ id: "sess-1", appointment_id: APPT }],
      error: null,
    };
    expect(await stateFor()).toBe("free");
  });

  it("P4/P5/P6 pending => processing, succeeded => paid, refunded => refunded", async () => {
    for (const [status, refund, expected] of [
      ["pending_stripe", null, "processing"],
      ["succeeded", null, "paid"],
      ["succeeded", "succeeded", "refunded"],
    ] as const) {
      baseRows(10_000);
      responses.sessions = {
        data: [{ id: "sess-1", appointment_id: APPT }],
        error: null,
      };
      responses.payment_charge_attempts = {
        data: [{ session_id: "sess-1", status, refund_status: refund }],
        error: null,
      };
      expect(await stateFor(), status + String(refund)).toBe(expected);
    }
  });

  // ---- U-matrix: failures

  it("U1 sessions read ERROR => unavailable, no Checkout", async () => {
    baseRows(10_000);
    responses.sessions = { data: null, error: { message: "boom" } };
    expect(await stateFor()).toBe("unavailable");
  });

  it("U2 sessions OK with zero rows => authoritative no-session behaviour", async () => {
    baseRows(10_000);
    responses.sessions = { data: [], error: null };
    expect(await stateFor()).toBe("no_session");
  });

  it("U3 attempts read ERROR => unavailable; an unknown pending/paid row cannot be hidden", async () => {
    baseRows(10_000);
    responses.sessions = {
      data: [{ id: "sess-1", appointment_id: APPT }],
      error: null,
    };
    responses.payment_charge_attempts = { data: null, error: { message: "boom" } };
    expect(await stateFor()).toBe("unavailable");
  });

  it("U4 attempts OK with zero rows => ordinary reducer behaviour", async () => {
    baseRows(10_000);
    responses.sessions = {
      data: [{ id: "sess-1", appointment_id: APPT }],
      error: null,
    };
    responses.payment_charge_attempts = { data: [], error: null };
    expect(await stateFor()).toBe("chargeable");
  });

  it("U5 pricing appointments read ERROR => unavailable", async () => {
    baseRows(0);
    responses.sessions = {
      data: [{ id: "sess-1", appointment_id: APPT }],
      error: null,
    };
    responses.appointments = { data: null, error: { message: "boom" } };
    expect(await stateFor()).toBe("unavailable");
  });

  it("U6 service read ERROR => unavailable", async () => {
    baseRows(0);
    responses.sessions = {
      data: [{ id: "sess-1", appointment_id: APPT }],
      error: null,
    };
    responses.services = { data: null, error: { message: "boom" } };
    expect(await stateFor()).toBe("unavailable");
  });

  it("U7 client_pricing read ERROR => unavailable", async () => {
    baseRows(0);
    responses.sessions = {
      data: [{ id: "sess-1", appointment_id: APPT }],
      error: null,
    };
    responses.client_pricing = { data: null, error: { message: "boom" } };
    expect(await stateFor()).toBe("unavailable");
  });

  it("U8 client_pricing OK with zero rows => authoritative empty custom-pricing set", async () => {
    baseRows(0);
    responses.sessions = {
      data: [{ id: "sess-1", appointment_id: APPT }],
      error: null,
    };
    responses.client_pricing = { data: [], error: null };
    expect(await stateFor()).toBe("free");
  });

  it("U9 known pending + pricing read ERROR => Processing preserved", async () => {
    // Transaction truth was established independently; the unavailable state is
    // only for facts that depend on the failed read.
    baseRows(0);
    responses.sessions = {
      data: [{ id: "sess-1", appointment_id: APPT }],
      error: null,
    };
    responses.payment_charge_attempts = {
      data: [{ session_id: "sess-1", status: "pending_stripe", refund_status: null }],
      error: null,
    };
    responses.client_pricing = { data: null, error: { message: "boom" } };
    expect(await stateFor()).toBe("processing");
  });

  it("U10 known succeeded / refunded + pricing read ERROR => Paid / Refunded preserved", async () => {
    for (const [refund, expected] of [
      [null, "paid"],
      ["succeeded", "refunded"],
    ] as const) {
      baseRows(0);
      responses.sessions = {
        data: [{ id: "sess-1", appointment_id: APPT }],
        error: null,
      };
      responses.payment_charge_attempts = {
        data: [{ session_id: "sess-1", status: "succeeded", refund_status: refund }],
        error: null,
      };
      responses.client_pricing = { data: null, error: { message: "boom" } };
      expect(await stateFor(), expected).toBe(expected);
    }
  });

  it("U11 transaction read ERROR + pricing says FREE => unavailable, NOT free", async () => {
    baseRows(0); // a $0 service: pricing would say free
    responses.sessions = { data: null, error: { message: "boom" } };
    const state = await stateFor();
    expect(state).toBe("unavailable");
    expect(state).not.toBe("free");
  });

  it("U12 transaction read ERROR + pricing says PAYABLE => unavailable, NOT chargeable", async () => {
    baseRows(10_000);
    responses.sessions = {
      data: [{ id: "sess-1", appointment_id: APPT }],
      error: null,
    };
    responses.payment_charge_attempts = { data: null, error: { message: "boom" } };
    const state = await stateFor();
    expect(state).toBe("unavailable");
    expect(state).not.toBe("chargeable");
  });

  it("a $0 menu service overridden by a POSITIVE custom price is NOT free", async () => {
    baseRows(0);
    responses.sessions = {
      data: [{ id: "sess-1", appointment_id: APPT }],
      error: null,
    };
    responses.client_pricing = {
      data: [
        {
          client_id: "client-1",
          service_name: "Consultation",
          price_cents: 5_000,
          notes: null,
          effective_from: "2026-01-01",
        },
      ],
      error: null,
    };
    expect(await stateFor()).toBe("chargeable");
  });

  it("the unavailable surface renders no Checkout and claims nothing", () => {
    const CELL = readFileSync(
      join(process.cwd(), "components/appointment-checkout-cell.tsx"),
      "utf8",
    );
    const idx = CELL.indexOf('paymentState === "unavailable"');
    expect(idx).toBeGreaterThan(-1);
    const branch = CELL.slice(idx, CELL.indexOf("// chargeable or no_session", idx));
    expect(branch.length).toBeGreaterThan(100);
    expect(branch).toMatch(/Payment status unavailable/);
    expect(branch).not.toMatch(/CheckoutButton/);
    expect(branch).not.toMatch(/No payment required|Paid|Processing|Refunded/);
    // and the branch precedes the Checkout fallback
    expect(CELL.indexOf("CheckoutButton", idx)).toBeGreaterThan(idx);
  });
});
