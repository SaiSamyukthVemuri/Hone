import { describe, expect, it, vi } from "vitest";

// Insurance PEER-0254-CALLERS-DELTA C1. Since migration 0254 the three money
// tables are owner-readable only, so for a non-owner an RLS-filtered SELECT
// returns ZERO ROWS AND NO ERROR. The loaders' query-error guard cannot see
// that, and "RLS hid the rows" reads exactly like "there is no payment": a paid
// visit would render chargeable. Both loaders therefore take the caller's
// explicit owner context and answer a non-owner with an explicit "not visible"
// state, without issuing a query.

const h = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  // What the 0254 policy does: a non-owner session sees none of the money rows.
  rlsHidesMoney: false,
  reads: [] as string[],
}));

vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => true }));

const MONEY = new Set(["payment_charge_attempts", "manual_fee_charge_attempts", "appointment_settlements"]);

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      h.reads.push(table);
      const eqs: Array<[string, unknown]> = [];
      const ins: Array<[string, readonly unknown[]]> = [];
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.order = () => q;
      q.is = () => q;
      q.eq = (col: string, val: unknown) => {
        eqs.push([col, val]);
        return q;
      };
      q.in = (col: string, vals: readonly unknown[]) => {
        ins.push([col, vals]);
        return q;
      };
      q.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
        const hidden = h.rlsHidesMoney && MONEY.has(table);
        const rows = hidden ? [] : (h.rows[table] ?? []);
        return resolve({
          data: rows.filter(
            (r) => eqs.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c])),
          ),
          error: null,
        });
      };
      return q;
    },
  }),
}));

const { getAppointmentPaymentStates } = await import("@/lib/billing/appointment-payment-state");
const { getAppointmentSettlements } = await import("@/lib/billing/appointment-settlement");

const STUDIO = "studio-1";
const APPT = "appt-1";
const SESSION = "sess-1";
const TZ = "America/Toronto";

function paidVisit() {
  h.reads = [];
  h.rows = {
    sessions: [{ id: SESSION, appointment_id: APPT, studio_id: STUDIO, deleted_at: null }],
    payment_charge_attempts: [
      {
        id: "att-1",
        session_id: SESSION,
        studio_id: STUDIO,
        charge_reason: "session_payment",
        stripe_livemode: true,
        status: "succeeded",
        refund_status: null,
        amount_cents: 12000,
        refund_amount_cents: null,
      },
    ],
    appointment_settlements: [
      {
        id: "set-1",
        appointment_id: APPT,
        studio_id: STUDIO,
        method: "paid_cash",
        amount_cents: 12000,
        quoted_amount_cents: 12000,
        recorded_at: "2026-10-16T18:00:00.000Z",
        supersedes_id: null,
        superseded_at: null,
      },
    ],
    appointments: [
      { id: APPT, studio_id: STUDIO, client_id: "client-1", service_id: "svc-1", duration_minutes: 60 },
    ],
    services: [{ id: "svc-1", studio_id: STUDIO, name: "60 minute session", price_cents: 12000 }],
    client_pricing: [],
  };
}

describe("getAppointmentPaymentStates: explicit owner context", () => {
  it("OWNER control: the paid visit reads as paid", async () => {
    paidVisit();
    h.rlsHidesMoney = false;
    const out = await getAppointmentPaymentStates(STUDIO, [APPT], TZ, true);
    expect(out.get(APPT)).toBe("paid");
  });

  it("a NON-OWNER call cannot render 'no payment' or 'chargeable' for a paid visit", async () => {
    paidVisit();
    h.rlsHidesMoney = true; // the 0254 policy, as the database would apply it
    const out = await getAppointmentPaymentStates(STUDIO, [APPT], TZ, false);
    expect(out.get(APPT)).toBe("unavailable");
    expect(out.get(APPT)).not.toBe("no_session");
    expect(out.get(APPT)).not.toBe("free");
    expect(out.get(APPT)).not.toBe("chargeable");
  });

  it("a non-owner call issues no read at all", async () => {
    paidVisit();
    h.rlsHidesMoney = true;
    await getAppointmentPaymentStates(STUDIO, [APPT, "appt-2"], TZ, false);
    expect(h.reads).toEqual([]);
  });

  it("names every requested id, so no id falls through to a default", async () => {
    paidVisit();
    const out = await getAppointmentPaymentStates(STUDIO, [APPT, "appt-2"], TZ, false);
    expect([...out.entries()]).toEqual([
      [APPT, "unavailable"],
      ["appt-2", "unavailable"],
    ]);
  });

  it("PREMISE: with RLS hiding the rows and no error, the owner path cannot tell the difference", async () => {
    // This is why the owner context must be explicit: the rows vanish silently.
    paidVisit();
    h.rlsHidesMoney = true;
    const out = await getAppointmentPaymentStates(STUDIO, [APPT], TZ, true);
    expect(out.get(APPT)).not.toBe("paid");
    expect(out.get(APPT)).not.toBe("unavailable");
  });
});

describe("getAppointmentSettlements: explicit owner context", () => {
  it("OWNER control: the recorded settlement is returned", async () => {
    paidVisit();
    h.rlsHidesMoney = false;
    const out = await getAppointmentSettlements(STUDIO, [APPT], true);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.byAppointmentId.get(APPT)?.method).toBe("paid_cash");
  });

  it("a NON-OWNER gets the explicit not-visible answer, never an empty 'nothing settled' map", async () => {
    paidVisit();
    h.rlsHidesMoney = true;
    const out = await getAppointmentSettlements(STUDIO, [APPT], false);
    expect(out).toEqual({ ok: false });
    expect(h.reads).toEqual([]);
  });

  it("PREMISE: for an owner context under hidden rows the loader would say ok with nothing settled", async () => {
    paidVisit();
    h.rlsHidesMoney = true;
    const out = await getAppointmentSettlements(STUDIO, [APPT], true);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.byAppointmentId.size).toBe(0);
  });
});
