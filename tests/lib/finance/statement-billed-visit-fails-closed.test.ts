import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { readMoneyForAppointments } from "@/lib/finance/statement-money-read";

// HON-123, interim rule: a visit with a split-payments BILL carries cash/transfer rows and partial refunds the statement model does not itemise yet.
// A scope containing one must read as UNAVAILABLE, never as a total that silently leaves them out. A scope with none is unchanged.

const STUDIO = "11111111-1111-4111-8111-111111111111";
const A1 = "22222222-2222-4222-8222-222222222222";
const A2 = "33333333-3333-4333-8333-333333333333";

function fake(opts: { billed: string[]; card?: { appointment_id: string; amount_cents: number } | null; billsError?: boolean }) {
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      const rows: Record<string, unknown[]> = {
        sessions: [],
        visit_bills: opts.billed.map((appointment_id) => ({ appointment_id })),
        payment_charge_attempts: opts.card ? [{ ...opts.card, charge_reason: "session_payment", status: "succeeded", currency: "cad" }] : [],
        appointment_settlements: [],
        manual_fee_charge_attempts: [],
      };
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, { select: chain, eq: chain, is: chain, in: chain, then: (res: (v: unknown) => unknown) => res({ data: rows[table] ?? [], error: table === "visit_bills" && opts.billsError ? { message: "x" } : null }) });
      return q;
    },
  };
  return { client: client as never, tables };
}

describe("statement read and billed visits", () => {
  it("a scope containing a billed visit is NOT ok: no partial total can be built", async () => {
    const { client } = fake({ billed: [A2], card: { appointment_id: A1, amount_cents: 10000 } });
    expect(await readMoneyForAppointments(client, STUDIO, [A1, A2])).toEqual({ ok: false });
  });
  it("an unreadable bill lookup is also unavailable, never 'no bills'", async () => {
    const { client } = fake({ billed: [], billsError: true });
    expect(await readMoneyForAppointments(client, STUDIO, [A1])).toEqual({ ok: false });
  });
  it("a scope with no billed visit is read as before", async () => {
    const { client, tables } = fake({ billed: [] });
    const out = await readMoneyForAppointments(client, STUDIO, [A1]);
    expect(out.ok).toBe(true);
    expect(tables).toContain("visit_bills");
  });
});
