import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveAppointmentPaymentState,
  getAppointmentPaymentStates,
} from "@/lib/billing/appointment-payment-state";

// Batch payment-state loader for the dashboard/calendar checkout cell.

describe("deriveAppointmentPaymentState — strongest terminal state wins", () => {
  it("no session → no_session", () => {
    expect(deriveAppointmentPaymentState(false, [])).toBe("no_session");
  });
  it("session, no attempt → chargeable", () => {
    expect(deriveAppointmentPaymentState(true, [])).toBe("chargeable");
  });
  it("succeeded → paid; succeeded + refunded → refunded", () => {
    expect(
      deriveAppointmentPaymentState(true, [
        { status: "succeeded", refund_status: null },
      ]),
    ).toBe("paid");
    expect(
      deriveAppointmentPaymentState(true, [
        { status: "succeeded", refund_status: "succeeded" },
      ]),
    ).toBe("refunded");
  });
  it("pending_stripe → processing", () => {
    expect(
      deriveAppointmentPaymentState(true, [
        { status: "pending_stripe", refund_status: null },
      ]),
    ).toBe("processing");
  });
  it("only a failed/ready attempt → still chargeable", () => {
    expect(
      deriveAppointmentPaymentState(true, [
        { status: "failed", refund_status: null },
        { status: "ready", refund_status: null },
      ]),
    ).toBe("chargeable");
  });
  it("paid wins over a coexisting processing/failed row", () => {
    expect(
      deriveAppointmentPaymentState(true, [
        { status: "failed", refund_status: null },
        { status: "pending_stripe", refund_status: null },
        { status: "succeeded", refund_status: null },
      ]),
    ).toBe("paid");
  });
});

describe("loader is bounded + tenant-scoped (no N+1, no full history)", () => {
  const SRC = readFileSync(
    join(process.cwd(), "lib/billing/appointment-payment-state.ts"),
    "utf8",
  );
  it("reads sessions then attempts — two bounded .in() queries, keyed by id sets", () => {
    expect(SRC).toMatch(/from\("sessions"\)/);
    expect(SRC).toMatch(/from\("payment_charge_attempts"\)/);
    // FREE-01 adds a bounded free-price lookup (appointments -> services ->
    // client_pricing). Still batched and still constant in the number of
    // appointments — five reads total, never a per-appointment query.
    expect((SRC.match(/\.in\(/g) ?? []).length).toBe(5);
    expect((SRC.match(/from\("/g) ?? []).length).toBe(5);
    for (const t of ["appointments", "services", "client_pricing"]) {
      expect(SRC).toMatch(new RegExp(`from\\("${t}"\\)`));
    }
    // No query lives inside a per-appointment loop.
    // Bound the slice to the loop BODY. An unbounded slice runs to end-of-file
    // and would pick up the next function's queries — a false positive.
    // The free lookup now returns a discriminated result, so the old
    // `return free;` anchor no longer exists. Anchor on the current return.
    const loopStart = SRC.indexOf("for (const a of appts)");
    const loopEnd = SRC.indexOf(
      "return { ok: true, freeAppointmentIds: free };",
      loopStart,
    );
    expect(loopStart).toBeGreaterThan(-1);
    expect(loopEnd).toBeGreaterThan(loopStart);
    const loop = SRC.slice(loopStart, loopEnd);
    expect(loop.length).toBeGreaterThan(80); // slice is real, not empty
    expect(loop).not.toMatch(/await supabase|\.from\(/);

    // The per-appointment combine loop must not query either.
    // The braced form: the bare `for (const apptId of ids) out.set(...)`
    // one-liner is the unavailable early-return, not the combine loop.
    const combineStart = SRC.indexOf("for (const apptId of ids) {");
    const combineEnd = SRC.indexOf("return out;", combineStart);
    expect(combineStart).toBeGreaterThan(-1);
    expect(combineEnd).toBeGreaterThan(combineStart);
    const combine = SRC.slice(combineStart, combineEnd);
    expect(combine.length).toBeGreaterThan(80);
    expect(combine).not.toMatch(/await supabase|\.from\(/);
  });
  it("is studio-scoped and filtered to session_payment (tenant isolation)", () => {
    expect(SRC).toMatch(/\.eq\("studio_id", studioId\)/);
    expect(SRC).toMatch(/\.eq\("charge_reason", "session_payment"\)/);
  });
  it("reads only the coarse columns it needs (never the full payment history)", () => {
    expect(SRC).toMatch(/\.select\("session_id, status, refund_status"\)/);
    expect(SRC).not.toMatch(/stripe_payment_intent_id|receipt_email_to|failure_message/);
  });
  it("does not charge / write / call Stripe", () => {
    expect(SRC).not.toMatch(/\.insert\(|\.update\(|\.delete\(|@stripe\/|paymentIntents\./);
  });
});

describe("checkout cell + dashboard/calendar wiring (one shared flow)", () => {
  const CELL = readFileSync(
    join(process.cwd(), "components/appointment-checkout-cell.tsx"),
    "utf8",
  );
  const DASH = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/page.tsx"),
    "utf8",
  );
  const CAL = readFileSync(
    join(process.cwd(), "app/(app)/calendar/[id]/page.tsx"),
    "utf8",
  );
  it("cell shows Paid/Processing/Refunded badges or the shared CheckoutButton", () => {
    expect(CELL).toMatch(/<CheckoutButton/);
    expect(CELL).toMatch(/Paid/);
    expect(CELL).toMatch(/Processing/);
    expect(CELL).toMatch(/Refunded/);
    // Only completed appointments are checkout-relevant.
    expect(CELL).toMatch(/if \(status !== "completed"\) return null/);
    // Status conveyed by text, not colour alone.
    expect(CELL).toMatch(/appointment-payment-/);
  });
  it("dashboard uses the ONE bounded batch loader + the shared cell", () => {
    expect(DASH).toMatch(/getAppointmentPaymentStates\(studio\.id, apptIds, studio\.timezone\)/);
    expect(DASH).toMatch(/<AppointmentCheckoutCell/);
  });
  it("calendar reuses the SAME loader + cell (not a second flow)", () => {
    expect(CAL).toMatch(/getAppointmentPaymentStates\(studio\.id, \[id\], studio\.timezone\)/);
    expect(CAL).toMatch(/<AppointmentCheckoutCell/);
  });
});

// ---------------------------------------------------------------------------
// R-05 / REL-005. Behavioural mode isolation.
// ---------------------------------------------------------------------------
//
// Migration 0105 rescoped payment_charge_attempts_active_session_payment_uniq
// to (session_id, stripe_livemode), so one TEST and one LIVE attempt may
// legitimately coexist for the same session. The loader's attempts read had no
// mode predicate, and deriveAppointmentPaymentState returns on the FIRST
// succeeded row without ever looking at mode — so pre-launch TEST history
// decided a LIVE badge and suppressed Checkout on a chargeable appointment.
//
// THE MOCK BELOW HONOURS .eq()/.in() FILTERS ON PURPOSE. The harness in
// free-appointment-read-failure.test.ts treats every predicate as a no-op and
// replays one scripted array, which is right for testing error handling but
// would make every assertion here VACUOUS: dropping the stripe_livemode
// predicate would not change a single returned row. These tests filter the
// scripted rows the way PostgREST would, so removing the predicate genuinely
// flips the result — verified by the negative control recorded in the PR body.
//
// Invariant under test: THE CURRENT STRIPE MODE'S ATTEMPTS WIN.

const h = vi.hoisted(() => ({
  livemode: true,
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  errors: {} as Record<string, unknown>,
}));

vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => h.livemode,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      const ins: Array<[string, readonly unknown[]]> = [];
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.order = () => q;
      // .is("deleted_at", null): scripted rows are already the live ones.
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
        const err = h.errors[table];
        if (err) return resolve({ data: null, error: err });
        const rows = h.rows[table] ?? [];
        return resolve({
          data: rows.filter(
            (r) =>
              eqs.every(([c, v]) => r[c] === v) &&
              ins.every(([c, vs]) => vs.includes(r[c])),
          ),
          error: null,
        });
      };
      return q;
    },
  }),
}));

const STUDIO = "studio-1";
const APPT = "appt-1";
const SESSION = "sess-1";
const TZ = "America/Toronto";

type Attempt = {
  status: string;
  refund_status?: string | null;
  livemode: boolean;
};

// One completed, appointment-linked session on a payable ($60) menu service, so
// the appointment is genuinely chargeable and only the attempt rows can move it
// off "chargeable". Mirrors the production shape the preflight found.
function scenario(attempts: ReadonlyArray<Attempt>, deploymentLivemode = true) {
  h.livemode = deploymentLivemode;
  h.errors = {};
  h.rows = {
    sessions: [
      { id: SESSION, appointment_id: APPT, studio_id: STUDIO, deleted_at: null },
    ],
    payment_charge_attempts: attempts.map((a, i) => ({
      id: `att-${i}`,
      session_id: SESSION,
      studio_id: STUDIO,
      charge_reason: "session_payment",
      stripe_livemode: a.livemode,
      status: a.status,
      refund_status: a.refund_status ?? null,
    })),
    appointments: [
      {
        id: APPT,
        studio_id: STUDIO,
        client_id: "client-1",
        service_id: "svc-1",
        duration_minutes: 15,
      },
    ],
    services: [
      { id: "svc-1", studio_id: STUDIO, name: "15 minute session", price_cents: 6000 },
    ],
    client_pricing: [],
  };
}

async function state(): Promise<string | undefined> {
  const states = await getAppointmentPaymentStates(STUDIO, [APPT], TZ);
  return states.get(APPT);
}

const TEST_SUCCEEDED: Attempt = { status: "succeeded", livemode: false };
const TEST_REFUNDED: Attempt = {
  status: "succeeded",
  refund_status: "succeeded",
  livemode: false,
};
const TEST_PENDING: Attempt = { status: "pending_stripe", livemode: false };
const LIVE_SUCCEEDED: Attempt = { status: "succeeded", livemode: true };
const LIVE_REFUNDED: Attempt = {
  status: "succeeded",
  refund_status: "succeeded",
  livemode: true,
};
const LIVE_PENDING: Attempt = { status: "pending_stripe", livemode: true };

describe("R-05: test-mode attempts must not determine LIVE presentation", () => {
  it("M1 LIVE deployment + TEST succeeded only => NOT paid", async () => {
    scenario([TEST_SUCCEEDED]);
    const s = await state();
    expect(s).not.toBe("paid");
    expect(s).toBe("chargeable");
  });

  it("M2 LIVE deployment + TEST succeeded-then-refunded only => NOT refunded", async () => {
    // The exact production shape: both affected appointments carry a refunded
    // pre-launch test charge and no live attempt, so today they render
    // "✓ Refunded" and Checkout is suppressed.
    scenario([TEST_REFUNDED]);
    const s = await state();
    expect(s).not.toBe("refunded");
    expect(s).toBe("chargeable");
  });

  it("M3 LIVE deployment + TEST pending_stripe only => NOT processing", async () => {
    // Nothing in live would ever move a test row off pending_stripe, so this
    // badge would otherwise be permanent.
    scenario([TEST_PENDING]);
    const s = await state();
    expect(s).not.toBe("processing");
    expect(s).toBe("chargeable");
  });

  it("M4 LIVE deployment + TEST succeeded + LIVE succeeded => paid, from the LIVE row", async () => {
    scenario([TEST_SUCCEEDED, LIVE_SUCCEEDED]);
    expect(await state()).toBe("paid");
  });

  it("M5 LIVE deployment + TEST refunded + LIVE succeeded => paid, not refunded", async () => {
    // Mode-blind, the reducer returned on whichever succeeded row came first,
    // so this appointment's badge was decided by row order. Mode scoping makes
    // it deterministic.
    scenario([TEST_REFUNDED, LIVE_SUCCEEDED]);
    expect(await state()).toBe("paid");
  });

  it("M6 LIVE deployment + TEST succeeded + LIVE ready => follows LIVE, so chargeable", async () => {
    scenario([TEST_SUCCEEDED, { status: "ready", livemode: true }]);
    expect(await state()).toBe("chargeable");
  });

  it("M7 the inverse holds: TEST deployment + LIVE succeeded only => NOT paid", async () => {
    scenario([LIVE_SUCCEEDED], false);
    const s = await state();
    expect(s).not.toBe("paid");
    expect(s).toBe("chargeable");
  });

  it("M8 TEST deployment + TEST succeeded => paid (same-mode still resolves)", async () => {
    scenario([TEST_SUCCEEDED], false);
    expect(await state()).toBe("paid");
  });
});

describe("R-05: same-mode behaviour is unchanged", () => {
  it("M9 LIVE succeeded => paid", async () => {
    scenario([LIVE_SUCCEEDED]);
    expect(await state()).toBe("paid");
  });
  it("M10 LIVE succeeded + refunded => refunded", async () => {
    scenario([LIVE_REFUNDED]);
    expect(await state()).toBe("refunded");
  });
  it("M11 LIVE pending_stripe => processing", async () => {
    scenario([LIVE_PENDING]);
    expect(await state()).toBe("processing");
  });
  it("M12 no attempt in either mode => chargeable", async () => {
    scenario([]);
    expect(await state()).toBe("chargeable");
  });
});

describe("R-05: read-failure handling is untouched", () => {
  it("M13 attempts read error => unavailable, never a mode-scoped empty set", async () => {
    // The mode predicate must not turn a failed read into a confident
    // "chargeable": an error still means Hone cannot speak for this row.
    scenario([LIVE_SUCCEEDED]);
    h.errors = { payment_charge_attempts: { message: "boom" } };
    expect(await state()).toBe("unavailable");
  });
  it("M14 sessions read error => unavailable", async () => {
    scenario([LIVE_SUCCEEDED]);
    h.errors = { sessions: { message: "boom" } };
    expect(await state()).toBe("unavailable");
  });
});
