import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// HON-11 #2 and #6, two checkout surfaces that disagreed with the payment card.
//
// #2 (dashboard/calendar row). getAppointmentPaymentStates returned
//   `refunded_full` BEFORE it read settlements. A fully refunded visit later
//   recorded as "Paid · cash" therefore showed "✓ Refunded" + "Record outcome"
//   forever, opening onto an outcome already recorded. The payment card treats a
//   full refund as no card money held (`cardMoneyHeld`) and shows the
//   settlement; the row now agrees. A PARTIAL refund is still money held and is
//   unchanged.
//
// #6 (session page). The card's cash/e-transfer amount prefills from
//   `settlementQuotedAmountCents` when the prepare form is hidden (the typical
//   no-card client). Quick checkout passed it; the session page did not, so the
//   same visit showed "120.00" on the dashboard and a blank box on the chart.

const h = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  errors: {} as Record<string, unknown>,
}));

vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => true }));

// Honours .eq()/.in() like PostgREST (same harness as appointment-payment-state).
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
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
        const err = h.errors[table];
        if (err) return resolve({ data: null, error: err });
        const rows = h.rows[table] ?? [];
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

const STUDIO = "studio-1";
const APPT = "appt-1";
const SESSION = "sess-1";
const TZ = "America/Toronto";
const CHARGED = 12000;

function scenario(opts: {
  refundCents: number | null;
  settlement?: string | null;
  settlementReadFails?: boolean;
}) {
  h.errors = opts.settlementReadFails ? { appointment_settlements: { code: "57014" } } : {};
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
        refund_status: opts.refundCents == null ? null : "succeeded",
        amount_cents: CHARGED,
        refund_amount_cents: opts.refundCents,
      },
    ],
    appointment_settlements: opts.settlement
      ? [
          {
            id: "set-1",
            appointment_id: APPT,
            studio_id: STUDIO,
            method: opts.settlement,
            amount_cents: CHARGED,
            quoted_amount_cents: CHARGED,
            recorded_at: "2026-10-16T18:00:00.000Z",
            supersedes_id: null,
          },
        ]
      : [],
    appointments: [
      { id: APPT, studio_id: STUDIO, client_id: "client-1", service_id: "svc-1", duration_minutes: 60 },
    ],
    services: [{ id: "svc-1", studio_id: STUDIO, name: "60 minute session", price_cents: CHARGED }],
    client_pricing: [],
  };
}

const state = async () => (await getAppointmentPaymentStates(STUDIO, [APPT], TZ)).get(APPT);

describe("HON-11 #2: after a FULL refund, a recorded outcome is the row's current state", () => {
  it("full refund + paid_cash → settled_cash (was: refunded_full forever)", async () => {
    scenario({ refundCents: CHARGED, settlement: "paid_cash" });
    expect(await state()).toBe("settled_cash");
  });

  it("full refund + waived → settled_waived", async () => {
    scenario({ refundCents: CHARGED, settlement: "waived" });
    expect(await state()).toBe("settled_waived");
  });

  it("full refund + still_owes → refunded_full, NOT settled_owing: its Checkout would promise a card charge the succeeded attempt still blocks (Codex P1 4301816524)", async () => {
    scenario({ refundCents: CHARGED, settlement: "still_owes" });
    expect(await state()).toBe("refunded_full");
  });

  it("full refund + paid_e_transfer → settled_e_transfer", async () => {
    scenario({ refundCents: CHARGED, settlement: "paid_e_transfer" });
    expect(await state()).toBe("settled_e_transfer");
  });

  it("full refund, nothing recorded yet → refunded_full (the route back, unchanged)", async () => {
    scenario({ refundCents: CHARGED });
    expect(await state()).toBe("refunded_full");
  });

  it("full refund, settlement read FAILED → refunded_full (the refund is known; never guessed settled)", async () => {
    scenario({ refundCents: CHARGED, settlement: "paid_cash", settlementReadFails: true });
    expect(await state()).toBe("refunded_full");
  });

  it("control: a PARTIAL refund is still money held, so a settlement does not replace it", async () => {
    scenario({ refundCents: 2000, settlement: "paid_cash" });
    expect(await state()).toBe("refunded");
  });

  it("control: a paid charge still outranks any attestation", async () => {
    scenario({ refundCents: null, settlement: "still_owes" });
    expect(await state()).toBe("paid");
  });
});

describe("HON-11 #6: the session page prefills the outcome amount like quick checkout", () => {
  const page = readFileSync(
    join(__dirname, "../../../app/(app)/clients/[id]/sessions/[sessionId]/page.tsx"),
    "utf8",
  );

  it("derives the quote from the price the page already loaded (resolved → cents, free → 0, else null), with no new read", () => {
    expect(page).toMatch(
      /const settlementQuotedAmountCents =\s*sessionPaymentAmount\?\.kind === "resolved"\s*\?\s*sessionPaymentAmount\.amountCents\s*:\s*sessionPaymentAmount\?\.kind === "free"\s*\?\s*0\s*:\s*null;/,
    );
    expect(page).not.toMatch(/resolveAppointmentQuotedAmountCents/);
  });

  it("passes it to the card", () => {
    expect(page).toMatch(/settlementQuotedAmountCents=\{settlementQuotedAmountCents\}/);
  });

  it("the card still prefers the prepare form's amount, falling back to the quote", () => {
    const card = readFileSync(join(__dirname, "../../../components/session-payment-prepare-card.tsx"), "utf8");
    expect(card).toMatch(
      /defaultAmountCents=\{\s*presentation\.prepareFormAmount\?\.amountCents \?\?\s*settlementQuotedAmountCents\s*\}/,
    );
  });
});
