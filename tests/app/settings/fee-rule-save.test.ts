import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  role: "owner", row: {} as Record<string, unknown>, patches: [] as Record<string, unknown>[],
  beforeWrite: null as (() => void) | null, dbError: false, revalidate: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { role: h.role }, studio: { id: "own-studio" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ...h.row }, error: null }) }) }),
    update: (patch: Record<string, unknown>) => {
      const filters: Array<[string, unknown]> = [];
      const q = {
        eq: (column: string, value: unknown) => { filters.push([column, value]); return q; },
        is: (column: string, value: unknown) => { filters.push([column, value]); return q; },
        select: async () => {
          h.beforeWrite?.();
          h.patches.push(patch);
          if (h.dbError) return { data: null, error: { code: "XX000" } };
          const matches = filters.every(([column, value]) => h.row[column] === value);
          if (matches) Object.assign(h.row, patch);
          return { data: matches ? [{ id: "own-studio" }] : [], error: null };
        },
      }; return q;
    },
  }) }),
}));
const { saveManualFeeRuleAction, setManualFeeEnabledAction } = await import("@/app/(app)/settings/payments/fee-settings-actions");
const { parseManualFeeRuleValue } = await import("@/lib/billing/manual-fee-rule");
const expected = { enabled: false, mode: "fixed" as const, cents: 5000, percentBp: null };
const input = () => ({ feeType: "late_cancel" as const, mode: "percent" as const, valueText: "75", expected: { ...expected } });
beforeEach(() => {
  h.role = "owner"; h.patches = []; h.beforeWrite = null; h.dbError = false; h.revalidate.mockReset();
  h.row = { id: "own-studio", late_cancel_fee_enabled: false, late_cancel_fee_mode: "fixed", late_cancel_fee_cents: 5000, late_cancel_fee_percent_bp: null,
    no_show_fee_enabled: true, no_show_fee_mode: "fixed", no_show_fee_cents: 2500, no_show_fee_percent_bp: null };
});

describe("one atomic rule save under the existing owner session/RLS/audit", () => {
  it("writes just the chosen mode and value in one UPDATE, never either switch or the other fee", async () => {
    expect(await saveManualFeeRuleAction(input())).toEqual({ ok: true });
    expect(h.patches).toEqual([{ late_cancel_fee_mode: "percent", late_cancel_fee_percent_bp: 7500 }]);
    expect(h.row.late_cancel_fee_enabled).toBe(false);
    expect(h.row.no_show_fee_enabled).toBe(true);
    expect(h.row.no_show_fee_cents).toBe(2500);
    expect(h.row.late_cancel_fee_cents).toBe(5000);
    expect(h.revalidate).toHaveBeenCalledOnce();
  });
  it.each(["practitioner", "receptionist", "junior", ""])("role %s cannot write", async (role) => {
    h.role = role;
    expect(await saveManualFeeRuleAction(input())).toMatchObject({ ok: false, error: expect.stringContaining("owner") });
    expect(h.patches).toEqual([]);
  });
  it("no-show edits affect only no-show, with blank represented as IS NULL in the CAS", async () => {
    h.row.no_show_fee_enabled = false;
    const result = await saveManualFeeRuleAction({ feeType: "no_show", mode: "fixed", valueText: "12.34", expected: { ...expected, cents: 2500 } });
    expect(result).toEqual({ ok: true });
    expect(h.patches).toEqual([{ no_show_fee_mode: "fixed", no_show_fee_cents: 1234 }]);
    expect(h.row.late_cancel_fee_cents).toBe(5000);
  });
  it.each([
    ["late_cancel_fee_enabled", true], ["late_cancel_fee_mode", "percent"],
    ["late_cancel_fee_cents", 2500], ["late_cancel_fee_percent_bp", 5000],
  ])("a concurrent change to %s refuses the entire patch", async (column, value) => {
    h.beforeWrite = () => { h.row[column] = value; };
    expect(await saveManualFeeRuleAction(input())).toMatchObject({ ok: false, error: expect.stringContaining("changed somewhere else") });
    expect(h.row.late_cancel_fee_percent_bp).toBe(column === "late_cancel_fee_percent_bp" ? 5000 : null);
    expect(h.row.late_cancel_fee_mode).toBe(column === "late_cancel_fee_mode" ? "percent" : "fixed");
    expect(h.revalidate).not.toHaveBeenCalled();
  });
  it("switching an ON rule saves a usable mode/value atomically without an intermediate invalid rule", async () => {
    h.row.late_cancel_fee_enabled = true;
    expect(await saveManualFeeRuleAction({ ...input(), expected: { ...expected, enabled: true } })).toEqual({ ok: true });
    expect(h.row.late_cancel_fee_enabled).toBe(true);
    expect(h.row.late_cancel_fee_mode).toBe("percent");
    expect(h.row.late_cancel_fee_percent_bp).toBe(7500);
  });
  it.each(["", "0"])("an enabled fixed rule cannot be cleared or zeroed (%s)", async (valueText) => {
    h.row.late_cancel_fee_enabled = true;
    expect(await saveManualFeeRuleAction({ ...input(), mode: "fixed", valueText, expected: { ...expected, enabled: true } })).toMatchObject({ ok: false });
    expect(h.patches).toEqual([]);
  });
  it("OFF rules may be cleared without switching off/on or changing the unused value", async () => {
    expect(await saveManualFeeRuleAction({ ...input(), mode: "fixed", valueText: "" })).toEqual({ ok: true });
    expect(h.patches).toEqual([{ late_cancel_fee_mode: "fixed", late_cancel_fee_cents: null }]);
  });
  it("malformed client inputs never reach UPDATE", async () => {
    for (const bad of [{ ...input(), feeType: "other" }, { ...input(), mode: "other" }, { ...input(), expected: null }, { ...input(), valueText: 75 }]) {
      expect(await saveManualFeeRuleAction(bad as never)).toMatchObject({ ok: false });
    }
    expect(h.patches).toEqual([]);
  });
  it("database failure returns curated copy and never claims success", async () => {
    h.dbError = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await saveManualFeeRuleAction(input())).toMatchObject({ ok: false, error: expect.stringMatching(/couldn't save/) });
      expect(h.row.late_cancel_fee_mode).toBe("fixed");
      expect(h.revalidate).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it("confirmation cannot enable a different rule changed in another tab", async () => {
    h.row.late_cancel_fee_cents = 10000;
    expect(await setManualFeeEnabledAction({ feeType: "late_cancel", enabled: true, expectedEnabled: false, expectedRule: expected })).toMatchObject({ ok: false, error: expect.stringContaining("changed somewhere else") });
    expect(h.row.late_cancel_fee_enabled).toBe(false);
  });
});

describe("decimal parsing keeps existing amount/percentage bounds", () => {
  it.each([["12.34", 1234], ["0", 0], ["200", 20000], ["", null]])("fixed %s becomes %s cents", (text, value) => {
    expect(parseManualFeeRuleValue("fixed", text as string)).toEqual({ ok: true, value });
  });
  it.each(["200.01", "-1", "1.234", "NaN", "Infinity", "1e2", "9007199254740991"])("rejects fixed %s", (text) => {
    expect(parseManualFeeRuleValue("fixed", text).ok).toBe(false);
  });
  it.each([["0.01", 1], ["75", 7500], ["12.34%", 1234], ["100", 10000]])("percent %s becomes %s basis points", (text, value) => {
    expect(parseManualFeeRuleValue("percent", text as string)).toEqual({ ok: true, value });
  });
  it.each(["0", "100.01", "-1", "1.234", "garbage"])("rejects percent %s", (text) => {
    expect(parseManualFeeRuleValue("percent", text).ok).toBe(false);
  });
});
