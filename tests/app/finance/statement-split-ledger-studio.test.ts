import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

// HON-123 / HON-122, Codex P1 + P2 on #1827 (operator's rule, 27 Nov 2026): the STUDIO statement and analytics read the split-payments ledger through the same shared reader as the
// client statement. A Stripe TEST payment and its refund add ZERO to real totals; real cash and transfers on a split visit appear in them. Synthetic records only.
type Result = { data: unknown[] | null; error: unknown };
const okr = (data: unknown[]): Result => ({ data, error: null });
const client = (results: Record<string, Result>) =>
  ({ from: (table: string) => { const chain: unknown = new Proxy(() => undefined, { get: (_x, prop) => (prop === "then" ? (res: (v: unknown) => void) => res(results[table]) : () => chain) }); return chain; } }) as unknown as SupabaseClient;

const A = "a1";
const appt = { id: A, status: "completed", starts_at: "2026-11-03T15:00:00Z", ends_at: "2026-11-03T16:00:00Z", client_id: "c1", practitioner_id: "p1", service_id: null, clients: null };
const card = (live: boolean | null) => ({
  id: "att1", charge_reason: "session_payment", status: "succeeded", amount_cents: 10000, currency: "cad", refund_status: null, refund_amount_cents: null,
  stripe_refund_status: null, stripe_refund_id: null, stripe_charge_refund_event_id: null, stripe_livemode: live, appointment_id: A, session_id: null,
});
const split = (live: boolean | null): Record<string, Result> => ({
  appointments: okr([appt]),
  sessions: okr([]),
  visit_bills: okr([{ appointment_id: A, total_cents: 22500, currency: "cad" }]),
  visit_external_payments: okr([
    { appointment_id: A, method: "paid_cash", amount_cents: 5000, currency: "cad", state: "confirmed" },
    { appointment_id: A, method: "paid_e_transfer", amount_cents: 7500, currency: "cad", state: "confirmed" },
  ]),
  payment_refunds: okr([{ appointment_id: A, attempt_id: "att1", amount_cents: 4000, currency: "cad", status: "succeeded", legacy: false, kind: "payment_reversal" }]),
  payment_refund_reviews: okr([]),
  payment_charge_attempts: okr([card(live)]),
  appointment_settlements: okr([]),
  manual_fee_charge_attempts: okr([]),
  services: okr([]),
  practitioners: okr([]),
});
const studio = { id: "s1", timezone: "America/Toronto" };
const load = async (t: Record<string, Result>) => {
  const { loadStatementView } = await import("@/lib/finance/statement-read");
  const v = await loadStatementView({ role: "owner" }, studio, "2026-11", "cad", client(t));
  if (v.access !== "granted" || !v.ok) throw new Error("expected a granted view");
  return v.statement;
};

describe("the studio statement reads the split-payments ledger (it used to omit it)", () => {
  it("a split visit's cash $50 and transfer $75 appear in the studio statement; a TEST-mode $100 card and its $40 refund add nothing", async () => {
    const st = await load(split(false));
    expect(st.all.kinds.collected_cash).toEqual({ count: 1, cents: 5000 });
    expect(st.all.kinds.collected_e_transfer).toEqual({ count: 1, cents: 7500 });
    expect(st.all.kinds.collected_card_session.cents).toBe(0);
    expect(st.all.kinds.refunded_partial).toEqual({ count: 0, cents: 0 });
    expect(st.all.collectedCents).toBe(12500);
  });
  it("an UNKNOWN-mode card is treated like a test card", async () => {
    const st = await load(split(null));
    expect(st.all.collectedCents).toBe(12500);
    expect(st.all.kinds.refunded_partial.cents).toBe(0);
  });
  it("control: the same visit with a LIVE card reads $225.00 collected and the $40 refund as its own line", async () => {
    const st = await load(split(true));
    expect(st.all.collectedCents).toBe(22500);
    expect(st.all.kinds.refunded_partial).toEqual({ count: 1, cents: 4000 });
  });
  it("the studio statement and analytics are fed by the same reader, so they agree on a split visit", async () => {
    const { readMoneyForAppointments } = await import("@/lib/finance/statement-money-read");
    const { buildStatement } = await import("@/lib/finance/statement");
    for (const live of [false, true]) {
      const money = await readMoneyForAppointments(client(split(live)), "s1", [A]);
      if (!money.ok) throw new Error("read failed");
      const analytics = buildStatement({ studioCurrency: "cad", appointments: [{ id: A, practitionerId: "p1", startsAt: "2026-11-03T15:00:00Z" }], cardRows: money.cardRows, settlementRows: money.settlementRows, legacyFeeRows: money.legacyFeeRows });
      const studioStatement = await load(split(live));
      expect(analytics.all.collectedCents, String(live)).toBe(studioStatement.all.collectedCents);
      expect(analytics.all.kinds.refunded_partial.cents, String(live)).toBe(studioStatement.all.kinds.refunded_partial.cents);
    }
  });
});
