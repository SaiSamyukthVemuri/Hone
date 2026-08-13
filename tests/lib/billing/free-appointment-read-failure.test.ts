import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Review 3778160194 — the same read-failure class as 3777890267, in the
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
// falls back to its ordinary state, Checkout stays visible, and no money moves
// — preparation and execution re-resolve authoritatively and fail closed on
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

// A $0 menu service — free ONLY if no positive custom price overrides it.
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

describe("the batched free loader never infers freeness from a failed read", () => {
  it("a $0 menu service with no custom pricing is genuinely free (control)", async () => {
    // Proves the harness can actually produce `free`; without this the
    // not-free assertions below would pass vacuously.
    baseRows(0);
    expect(await stateFor()).toBe("free");
  });

  it("a $0 menu service overridden by a POSITIVE custom price is NOT free", async () => {
    baseRows(0);
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
    expect(await stateFor()).not.toBe("free");
  });

  it("THE FINDING: a client_pricing read ERROR must not turn that into free", async () => {
    // Identical setup to the test above — the positive custom price exists —
    // except the read fails. Before the fix this returned `free` and hid a
    // chargeable visit behind "No payment required".
    baseRows(0);
    responses.client_pricing = { data: null, error: { message: "boom" } };
    expect(await stateFor()).not.toBe("free");
  });

  // For these two, `data: null` is NOT a valid probe: the loader bails on an
  // empty row set anyway, so a missing error check would still look correct.
  // Only an error alongside USABLE rows proves the error itself is honoured —
  // the same lesson as the attempt-row reads.
  it("an appointments read error asserts nothing is free, even with rows present", async () => {
    baseRows(0);
    responses.appointments = {
      data: [
        {
          id: APPT,
          client_id: "client-1",
          service_id: "svc-1",
          duration_minutes: 30,
        },
      ],
      error: { message: "boom" },
    };
    expect(await stateFor()).not.toBe("free");
  });

  it("a services read error asserts nothing is free, even with rows present", async () => {
    baseRows(0);
    responses.services = {
      data: [{ id: "svc-1", name: "Consultation", price_cents: 0 }],
      error: { message: "boom" },
    };
    expect(await stateFor()).not.toBe("free");
  });

  it("a client_pricing read error blocks freeness even with rows present", async () => {
    baseRows(0);
    responses.client_pricing = {
      data: [],
      error: { message: "boom" },
    };
    expect(await stateFor()).not.toBe("free");
  });

  // ---- Review 3778292139: freeness must not outrank UNSEEN transaction state.

  it("a sessions read error must not render a free visit over a real charge", async () => {
    // The harmful shape here is an error whose rows COLLAPSE TO EMPTY — that
    // is what makes hasSession false, and the reducer then returns
    // `isFree ? "free" : "no_session"`, painting "No payment required" over a
    // charge it cannot see. (Note this is the OPPOSITE probe from the
    // attempt-row guards, where a null row blocked anyway and only rows-present
    // could distinguish. The right probe is whichever shape produces the bad
    // state.)
    baseRows(0);
    responses.sessions = { data: null, error: { message: "boom" } };
    responses.payment_charge_attempts = { data: [], error: null };
    expect(await stateFor()).not.toBe("free");
  });

  it("an attempts read error must not render a free visit over a real charge", async () => {
    // Session visible, so hasSession is true; the ATTEMPTS read fails and
    // collapses, hiding a pending/succeeded row. Without the guard the reducer
    // sees no attempts plus isFree and returns "free".
    baseRows(0);
    responses.sessions = {
      data: [{ id: "sess-1", appointment_id: APPT }],
      error: null,
    };
    responses.payment_charge_attempts = { data: null, error: { message: "boom" } };
    expect(await stateFor()).not.toBe("free");
  });

  it("control: with BOTH transaction reads healthy, paid still outranks free", async () => {
    // Proves the precedence itself is intact, so the two tests above are not
    // passing merely because the harness cannot produce a terminal state.
    baseRows(0);
    responses.sessions = {
      data: [{ id: "sess-1", appointment_id: APPT }],
      error: null,
    };
    responses.payment_charge_attempts = {
      data: [
        { session_id: "sess-1", status: "succeeded", refund_status: null },
      ],
      error: null,
    };
    expect(await stateFor()).toBe("paid");
  });

  it("control: a healthy free appointment with a visible session is still free", async () => {
    baseRows(0);
    responses.sessions = {
      data: [{ id: "sess-1", appointment_id: APPT }],
      error: null,
    };
    responses.payment_charge_attempts = { data: [], error: null };
    expect(await stateFor()).toBe("free");
  });

  it("ZERO client_pricing rows is still a valid empty set, not a failure", async () => {
    // The distinction that matters: empty is an answer, an error is not.
    baseRows(0);
    responses.client_pricing = { data: [], error: null };
    expect(await stateFor()).toBe("free");
  });
});
