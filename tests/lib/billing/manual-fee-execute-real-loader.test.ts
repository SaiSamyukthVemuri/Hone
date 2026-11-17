import { describe, expect, it } from "vitest";
import { MANUAL_FEE_PRICE_CHANGED_MESSAGE, loadManualFeeExecuteHold } from "@/lib/billing/manual-fee-studio-setting";

// Decision (platform operator, #1483). A percent fee was prepared at a POSITIVE price. The client's custom price then became
// an explicit $0, invalid or conflicting. EXECUTE must block. Unlike the mocked-loader tests beside it, this runs the REAL
// loadAppointmentSessionPrice and the real resolver against a fake database, so a regression in either shows up here.

const STUDIO = "studio-1";
const PCT_STUDIO = {
  late_cancel_fee_enabled: true, no_show_fee_enabled: false,
  late_cancel_fee_mode: "percent", no_show_fee_mode: "fixed",
  late_cancel_fee_percent_bp: 7500, no_show_fee_percent_bp: null,
  late_cancel_fee_cents: null, no_show_fee_cents: null, timezone: "America/Toronto",
};
const ATTEMPT = { id: "att-1", studio_id: STUDIO, charge_reason: "late_cancellation_fee", amount_cents: 9000 };
const FROZEN = { calc_mode: "percent", basis_cents: 12000, percent_bp: 7500, appointment_id: "appt-1" };
const pricing = (cents: number, from = "2020-01-01") => ({ service_name: "Service", price_cents: cents, notes: null, effective_from: from });

function fake(customRows: unknown[], menuCents: number | null = 12000) {
  const tables: Record<string, unknown> = {
    studios: PCT_STUDIO,
    payment_charge_attempts: FROZEN,
    appointments: { id: "appt-1", client_id: "c1", duration_minutes: 60, service: { name: "Service", price_cents: menuCents } },
  };
  return {
    from: (t: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: tables[t] ?? null, error: null });
      q.then = (resolve: (v: unknown) => unknown) => resolve({ data: t === "client_pricing" ? customRows : [], error: null });
      return q;
    },
  };
}

describe("EXECUTE hold through the REAL loader (percent fee prepared at a positive price)", () => {
  it("CONTROL: no custom row, positive menu price: not held", async () => {
    expect(await loadManualFeeExecuteHold(fake([]), ATTEMPT)).toBeNull();
  });
  it("CONTROL: a different POSITIVE custom price is not held (the frozen amount is what the owner confirmed)", async () => {
    expect(await loadManualFeeExecuteHold(fake([pricing(8000)]), ATTEMPT)).toBeNull();
  });
  it("the custom price became an explicit $0: HELD", async () => {
    expect(await loadManualFeeExecuteHold(fake([pricing(0)]), ATTEMPT)).toBe(MANUAL_FEE_PRICE_CHANGED_MESSAGE);
  });
  it("the custom price became invalid (negative or fractional): HELD, not a fall-through to the menu price", async () => {
    for (const bad of [-100, 12.5]) {
      expect(await loadManualFeeExecuteHold(fake([pricing(bad)]), ATTEMPT), `price ${bad}`).toBe(MANUAL_FEE_PRICE_CHANGED_MESSAGE);
    }
  });
  it("the custom rows now conflict ($0 and positive, equally current): HELD", async () => {
    expect(await loadManualFeeExecuteHold(fake([pricing(0), pricing(8000)]), ATTEMPT)).toBe(MANUAL_FEE_PRICE_CHANGED_MESSAGE);
  });
  it("the price went missing (no menu price, no custom row): HELD", async () => {
    expect(await loadManualFeeExecuteHold(fake([], null), ATTEMPT)).toBe(MANUAL_FEE_PRICE_CHANGED_MESSAGE);
  });
});
