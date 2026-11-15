import { beforeEach, describe, expect, it, vi } from "vitest";

// Owner-only manual-fee settings (0351): one server action per setting, each a compare-and-set against the value the page loaded.

type Upd = { column: string; value: unknown; filters: Array<[string, string, unknown]> };
const h = vi.hoisted(() => ({
  role: "owner" as string,
  row: {} as Record<string, unknown>,
  updates: [] as Array<{ column: string; value: unknown; filters: Array<[string, string, unknown]> }>,
  matchRows: 1,
  updateError: false,
  readError: false,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "p1", role: h.role }, studio: { id: "s1" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => (h.readError ? { data: null, error: { code: "x" } } : { data: h.row, error: null }) }) }),
      update: (patch: Record<string, unknown>) => {
        const [column, value] = Object.entries(patch)[0];
        const u: Upd = { column, value, filters: [] };
        const q: Record<string, unknown> = {};
        q.eq = (c: string, v: unknown) => { u.filters.push(["eq", c, v]); return q; };
        q.is = (c: string, v: unknown) => { u.filters.push(["is", c, v]); return q; };
        q.select = async () => { h.updates.push(u); return h.updateError ? { data: null, error: { code: "x" } } : { data: Array.from({ length: h.matchRows }, () => ({ id: "s1" })), error: null }; };
        return q;
      },
    }),
  }),
}));
vi.mock("@/lib/logging/error-class", () => ({ dbErrorCode: () => "x" }));

const { setManualFeeEnabledAction, setManualFeeModeAction, setManualFeePercentAction } = await import("@/app/(app)/settings/payments/fee-settings-actions");

const FIXED_OK = {
  late_cancel_fee_cents: 5000, no_show_fee_cents: 5000, late_cancel_fee_enabled: false, no_show_fee_enabled: false,
  late_cancel_fee_mode: "fixed", no_show_fee_mode: "fixed", late_cancel_fee_percent_bp: null, no_show_fee_percent_bp: null,
};
beforeEach(() => { h.role = "owner"; h.row = { ...FIXED_OK }; h.updates = []; h.matchRows = 1; h.updateError = false; h.readError = false; });

describe("owner only", () => {
  it("a practitioner who is not the owner changes nothing, through every action", async () => {
    h.role = "practitioner";
    expect((await setManualFeeEnabledAction({ feeType: "late_cancel", enabled: true, expectedEnabled: false })).ok).toBe(false);
    expect((await setManualFeeModeAction({ feeType: "late_cancel", mode: "percent", expectedMode: "fixed" })).ok).toBe(false);
    expect((await setManualFeePercentAction({ feeType: "late_cancel", percentText: "75", expectedBp: null })).ok).toBe(false);
    expect(h.updates).toEqual([]);
  });
});

describe("compare-and-set: a stale tab cannot overwrite a newer choice", () => {
  it("the UPDATE carries the value the page loaded as its condition; zero rows matched is 'changed elsewhere' and writes nothing else", async () => {
    h.matchRows = 0;
    const r = await setManualFeeEnabledAction({ feeType: "late_cancel", enabled: true, expectedEnabled: false });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/changed somewhere else/i) });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ column: "late_cancel_fee_enabled", value: true });
    expect(h.updates[0].filters).toEqual(expect.arrayContaining([["eq", "late_cancel_fee_enabled", false]]));
  });
  it("the stale tab scenario: the owner turned the fee OFF in another tab; this tab's stale 'turn ON from false' ... is applied only if the row is still false", async () => {
    // The page showed enabled=false and asks to set true; if another tab already changed it, the condition matches no row.
    h.matchRows = 0;
    expect((await setManualFeeEnabledAction({ feeType: "no_show", enabled: true, expectedEnabled: false })).ok).toBe(false);
    // and the same for mode and percent
    expect((await setManualFeeModeAction({ feeType: "no_show", mode: "percent", expectedMode: "fixed" })).ok).toBe(false);
    expect((await setManualFeePercentAction({ feeType: "no_show", percentText: "50", expectedBp: null })).ok).toBe(false);
  });
  it("a null expected percentage is matched with IS NULL, a value with EQ", async () => {
    await setManualFeePercentAction({ feeType: "late_cancel", percentText: "75", expectedBp: null });
    expect(h.updates[0].filters).toEqual(expect.arrayContaining([["is", "late_cancel_fee_percent_bp", null]]));
    await setManualFeePercentAction({ feeType: "late_cancel", percentText: "50", expectedBp: 7500 });
    expect(h.updates[1].filters).toEqual(expect.arrayContaining([["eq", "late_cancel_fee_percent_bp", 7500]]));
    expect(h.updates[1].value).toBe(5000);
  });
  it("each action writes exactly ONE column of exactly the type asked for", async () => {
    await setManualFeeEnabledAction({ feeType: "no_show", enabled: true, expectedEnabled: false });
    await setManualFeeModeAction({ feeType: "late_cancel", mode: "percent", expectedMode: "fixed" });
    await setManualFeePercentAction({ feeType: "late_cancel", percentText: "75", expectedBp: null });
    expect(h.updates.map((u) => u.column)).toEqual(["no_show_fee_enabled", "late_cancel_fee_mode", "late_cancel_fee_percent_bp"]);
  });
});

describe("validity: a fee can be turned ON only when it could produce a charge", () => {
  it("fixed mode with no amount cannot be turned on", async () => {
    h.row = { ...FIXED_OK, late_cancel_fee_cents: null };
    const r = await setManualFeeEnabledAction({ feeType: "late_cancel", enabled: true, expectedEnabled: false });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/amount above \$0\.00/i) });
    expect(h.updates).toEqual([]);
  });
  it("percent mode with no percentage cannot be turned on", async () => {
    h.row = { ...FIXED_OK, late_cancel_fee_mode: "percent" };
    const r = await setManualFeeEnabledAction({ feeType: "late_cancel", enabled: true, expectedEnabled: false });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/percentage/i) });
    expect(h.updates).toEqual([]);
  });
  it("turning OFF is always allowed, whatever the configuration", async () => {
    h.row = { ...FIXED_OK, late_cancel_fee_cents: null, late_cancel_fee_enabled: true };
    expect((await setManualFeeEnabledAction({ feeType: "late_cancel", enabled: false, expectedEnabled: true })).ok).toBe(true);
  });
  it("a fee that is ON cannot be switched to a mode with no value, nor have its percentage cleared", async () => {
    h.row = { ...FIXED_OK, late_cancel_fee_enabled: true };
    expect((await setManualFeeModeAction({ feeType: "late_cancel", mode: "percent", expectedMode: "fixed" })).ok).toBe(false);
    h.row = { ...FIXED_OK, late_cancel_fee_enabled: true, late_cancel_fee_mode: "percent", late_cancel_fee_percent_bp: 7500 };
    expect((await setManualFeePercentAction({ feeType: "late_cancel", percentText: "", expectedBp: 7500 })).ok).toBe(false);
    expect(h.updates).toEqual([]);
  });
  it("a percentage outside 0.01%-100% or with more than two decimals is refused before any write", async () => {
    for (const text of ["0", "100.5", "-1", "12.345", "abc"]) {
      expect((await setManualFeePercentAction({ feeType: "late_cancel", percentText: text, expectedBp: null })).ok).toBe(false);
    }
    expect(h.updates).toEqual([]);
  });
  it("garbage input never reaches a write", async () => {
    expect((await setManualFeeEnabledAction({ feeType: "evil" as never, enabled: true, expectedEnabled: false })).ok).toBe(false);
    expect((await setManualFeeModeAction({ feeType: "late_cancel", mode: "x" as never, expectedMode: "fixed" })).ok).toBe(false);
    expect(h.updates).toEqual([]);
  });
  it("a failed read of the current row fails closed", async () => {
    h.readError = true;
    expect((await setManualFeeEnabledAction({ feeType: "late_cancel", enabled: true, expectedEnabled: false })).ok).toBe(false);
    expect(h.updates).toEqual([]);
  });
});
