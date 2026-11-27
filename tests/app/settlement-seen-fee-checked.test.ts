import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// Codex P2 (checkout-fee-fields): the fee the owner SAW is always sent and always checked. An UNCHANGED Final fee used
// to send nothing, so the legacy command snapshotted the LATEST price without comparing it with what the owner saw.
// Now the reference fee travels either way, and an unchanged fee is refused with fee_changed when the price moved.
// All deps mocked; NO db, NO network. Ids are synthetic.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));
vi.mock("@/lib/billing/appointment-settlement", () => ({ resolveAppointmentQuotedAmountCents: vi.fn() }));

import { recordAppointmentSettlementAction, waiveAppointmentFeeAction } from "@/app/(app)/appointment-settlement-actions";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { resolveAppointmentQuotedAmountCents } from "@/lib/billing/appointment-settlement";
import { createCheckoutFeeDraft, writeFeeAdjustment } from "@/components/checkout-fee-fields";

const whoami = getCurrentPractitionerWithStudio as unknown as Mock;
const client = createClient as unknown as Mock;
const quote = resolveAppointmentQuotedAmountCents as unknown as Mock;
const STUDIO = "0b5f3c1e-7a2d-4c8e-9f10-2a3b4c5d6e7f";
const APPT = "1c6e4d2f-8b3e-4d9f-a021-3b4c5d6e7f80";
let rpc: Mock;

beforeEach(() => {
  whoami.mockResolvedValue({ practitioner: { id: "p1", role: "owner" }, studio: { id: STUDIO, timezone: "UTC" } });
  rpc = vi.fn().mockResolvedValue({ data: [{ result: "recorded", settlement_id: "s1" }], error: null });
  client.mockResolvedValue({ rpc });
  quote.mockReset();
});

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const unchanged = { appointment_id: APPT, method: "paid_cash", amount_cents: "9000", reference_fee_cents: "9000", final_fee_cents: "9000" };

describe("the form always carries the fee the owner saw", () => {
  it("sends reference and final fee even when they are equal, and no reason", () => {
    const fd = new FormData();
    writeFeeAdjustment(fd, createCheckoutFeeDraft(9000), 9000);
    expect(fd.get("reference_fee_cents")).toBe("9000");
    expect(fd.get("final_fee_cents")).toBe("9000");
    expect(fd.has("fee_adjustment_reason")).toBe(false);
  });
  it("an adjustment still carries its reason", () => {
    const fd = new FormData();
    writeFeeAdjustment(fd, { ...createCheckoutFeeDraft(9000), reason: " Friend " }, 5000);
    expect(fd.get("fee_adjustment_reason")).toBe("Friend");
  });
});

describe("an unchanged Final fee is validated against the current price", () => {
  it("refuses with fee_changed and records nothing when the price moved while checkout was open", async () => {
    quote.mockResolvedValue(10000);
    const r = await recordAppointmentSettlementAction(form(unchanged));
    expect(r).toMatchObject({ ok: false, code: "fee_changed" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("refuses when the price can no longer be resolved", async () => {
    quote.mockResolvedValue(null);
    expect(await recordAppointmentSettlementAction(form(unchanged))).toMatchObject({ ok: false, code: "fee_changed" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("records through the legacy command when the price is still the fee the owner saw", async () => {
    quote.mockResolvedValue(9000);
    const r = await recordAppointmentSettlementAction(form(unchanged));
    expect(r.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("record_appointment_settlement");
  });
  it("the waive action checks an unchanged fee the same way", async () => {
    quote.mockResolvedValue(10000);
    const r = await waiveAppointmentFeeAction(form({ appointment_id: APPT, amount_cents: "9000", reference_fee_cents: "9000", final_fee_cents: "9000" }));
    expect(r).toMatchObject({ ok: false, code: "fee_changed" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("an unchanged fee that carries a reason is malformed", async () => {
    quote.mockResolvedValue(9000);
    expect(await recordAppointmentSettlementAction(form({ ...unchanged, fee_adjustment_reason: "x" }))).toMatchObject({ ok: false, code: "invalid_input" });
  });
  it("an adjusted fee still goes to the adjusted command, which refuses a moved price itself", async () => {
    await recordAppointmentSettlementAction(form({ ...unchanged, final_fee_cents: "5000", amount_cents: "5000", fee_adjustment_reason: "Friend" }));
    expect(quote).not.toHaveBeenCalled();
    expect(rpc.mock.calls[0][0]).toBe("record_adjusted_appointment_settlement");
  });
});
