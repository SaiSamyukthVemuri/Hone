import { beforeEach, describe, expect, it, vi } from "vitest";

// PAY-CCY-07, option B (operator decision 2026-10-12, #871). The server
// actions refuse `paid_e_transfer` for a studio whose payment COUNTRY is US,
// on both write paths that name a method (record, and the owner's
// correction). Canada and every other method reach the 0187 command
// unchanged. Drives the REAL actions; the command is a spy.

const h = vi.hoisted(() => ({
  jurisdiction: { ok: true, jurisdiction: { country: "CA", currency: "cad" } } as unknown,
  jurisdictionReads: 0,
  rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
  role: "owner" as "owner" | "practitioner",
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "p1", role: h.role },
    studio: { id: "11111111-1111-4111-8111-111111111111" },
  }),
}));
vi.mock("@/lib/billing/payment-jurisdiction-server", () => ({
  getStudioPaymentJurisdiction: async () => {
    h.jurisdictionReads += 1;
    return h.jurisdiction;
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpc.push({ name, args });
      return {
        data: [{ result: name === "supersede_appointment_settlement" ? "corrected" : "recorded", settlement_id: "s1" }],
        error: null,
      };
    },
  }),
}));

const { recordAppointmentSettlementAction, supersedeAppointmentSettlementAction } = await import(
  "@/app/(app)/appointment-settlement-actions"
);

const US = { ok: true, jurisdiction: { country: "US", currency: "usd" } };
const CA = { ok: true, jurisdiction: { country: "CA", currency: "cad" } };

function recordForm(method: string) {
  const fd = new FormData();
  fd.set("appointment_id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  fd.set("method", method);
  fd.set("amount_cents", "4500");
  return fd;
}
function correctForm(method: string) {
  const fd = recordForm(method);
  fd.set("settlement_id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  fd.set("reason", "Client paid a different way");
  return fd;
}

beforeEach(() => {
  h.jurisdiction = CA;
  h.jurisdictionReads = 0;
  h.rpc = [];
  h.role = "owner";
});

describe("record: a US studio cannot record e-transfer", () => {
  it("refuses paid_e_transfer for US, says what to use instead, and never reaches the command", async () => {
    h.jurisdiction = US;
    const r = await recordAppointmentSettlementAction(recordForm("paid_e_transfer"));
    expect(r).toMatchObject({ ok: false, code: "method_unavailable" });
    expect(r.ok ? "" : r.message).toMatch(/Paid another way \(Zelle, Venmo, check\)/);
    expect(h.rpc).toEqual([]);
  });

  it("records the US Zelle/Venmo/check case as paid_other_external", async () => {
    h.jurisdiction = US;
    const r = await recordAppointmentSettlementAction(recordForm("paid_other_external"));
    expect(r.ok).toBe(true);
    expect(h.rpc).toHaveLength(1);
    expect(h.rpc[0]).toMatchObject({
      name: "record_appointment_settlement",
      args: { p_method: "paid_other_external" },
    });
  });

  it("CANADIAN REGRESSION: a CA studio still records paid_e_transfer exactly as before", async () => {
    const r = await recordAppointmentSettlementAction(recordForm("paid_e_transfer"));
    expect(r.ok).toBe(true);
    expect(h.rpc[0]).toMatchObject({
      name: "record_appointment_settlement",
      args: { p_method: "paid_e_transfer", p_amount_cents: 4500 },
    });
  });

  it("other methods never read the country at all (no new dependency for them)", async () => {
    h.jurisdiction = { ok: false, reason: "read_failed" };
    for (const m of ["paid_cash", "paid_other_external", "still_owes"]) {
      const r = await recordAppointmentSettlementAction(recordForm(m));
      expect(r.ok).toBe(true);
    }
    expect(h.jurisdictionReads).toBe(0);
    expect(h.rpc).toHaveLength(3);
  });

  it("an unread country refuses only e-transfer, as a retry — never allowed blind, never assumed Canadian", async () => {
    h.jurisdiction = { ok: false, reason: "read_failed" };
    const r = await recordAppointmentSettlementAction(recordForm("paid_e_transfer"));
    expect(r).toMatchObject({ ok: false, code: "unavailable" });
    expect(r.ok ? "" : r.message).toMatch(/try again/i);
    expect(h.rpc).toEqual([]);
  });
});

describe("owner correction: the same rule", () => {
  it("refuses correcting a US settlement TO paid_e_transfer", async () => {
    h.jurisdiction = US;
    const r = await supersedeAppointmentSettlementAction(correctForm("paid_e_transfer"));
    expect(r).toMatchObject({ ok: false, code: "method_unavailable" });
    expect(h.rpc).toEqual([]);
  });

  it("allows correcting a US settlement to paid_other_external", async () => {
    h.jurisdiction = US;
    const r = await supersedeAppointmentSettlementAction(correctForm("paid_other_external"));
    expect(r.ok).toBe(true);
    expect(h.rpc[0]).toMatchObject({
      name: "supersede_appointment_settlement",
      args: { p_method: "paid_other_external" },
    });
  });

  it("CANADIAN REGRESSION: a CA owner may still correct to paid_e_transfer", async () => {
    const r = await supersedeAppointmentSettlementAction(correctForm("paid_e_transfer"));
    expect(r.ok).toBe(true);
    expect(h.rpc[0]).toMatchObject({ args: { p_method: "paid_e_transfer" } });
  });
});
