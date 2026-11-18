import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  role: "owner",
  rpc: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { role: h.role },
    studio: { id: "session-studio" },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: h.rpc }),
}));
const {
  saveCancellationFeeRulesAction: save,
  setCancellationFeeRulesEnabledAction: enable,
} = await import("@/app/(app)/settings/payments/cancellation-fee-actions");
const input = {
  expectedRevision: 0,
  noticeHours: 48,
  noticeMode: "percent" as const,
  noticeValue: 5000,
  sameDayMode: "percent" as const,
  sameDayValue: 10000,
  policyHash: "a".repeat(64),
  policyReviewed: true,
};
const rules = {
  revision: 1,
  enabled: false,
  notice_hours: 48,
  notice_mode: "percent",
  notice_value: 5000,
  same_day_mode: "percent",
  same_day_value: 10000,
  policy_snapshot_hash: input.policyHash,
};
beforeEach(() => {
  h.role = "owner";
  h.rpc.mockReset().mockResolvedValue({ data: rules, error: null });
  h.revalidate.mockReset();
});
describe("cancellation rule owner commands", () => {
  it("writes the session's studio through the governed RPC; saving never requests activation", async () => {
    expect(await save(input)).toMatchObject({
      ok: true,
      rules: { enabled: false },
    });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(
      "save_cancellation_fee_rules",
      {
        p_studio_id: "session-studio",
        p_expected_revision: 0,
        p_notice_hours: 48,
        p_notice_mode: "percent",
        p_notice_value: 5000,
        p_same_day_mode: "percent",
        p_same_day_value: 10000,
        p_presented_policy_hash: input.policyHash,
      },
    );
  });
  it.each(["practitioner", "receptionist", "junior"])(
    "%s cannot save or enable",
    async (role) => {
      h.role = role;
      expect((await save(input)).ok).toBe(false);
      expect((await enable({ expectedRevision: 1, enabled: true })).ok).toBe(
        false,
      );
      expect(h.rpc).not.toHaveBeenCalled();
    },
  );
  it.each([
    { noticeHours: 0 },
    { noticeHours: 1.5 },
    { noticeHours: 169 },
    { noticeValue: 0 },
    { noticeValue: 10001 },
    { sameDayValue: 10001 },
    { expectedRevision: -1 },
    { policyHash: "bad" },
    { policyReviewed: false },
  ])("refuses invalid draft %j before RPC", async (change) => {
    expect((await save({ ...input, ...change })).ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("enables only the exact saved revision through a separate command", async () => {
    h.rpc.mockResolvedValue({
      data: { ...rules, revision: 2, enabled: true },
      error: null,
    });
    expect((await enable({ expectedRevision: 1, enabled: true })).ok).toBe(
      true,
    );
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(
      "set_cancellation_fee_rules_enabled",
      {
        p_studio_id: "session-studio",
        p_expected_revision: 1,
        p_enabled: true,
      },
    );
  });
  it("stale, malformed and failed results never report success", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "40001" } });
    expect(await save(input)).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed elsewhere"),
    });
    h.rpc.mockResolvedValue({ data: {}, error: null });
    expect((await save(input)).ok).toBe(false);
    expect(h.revalidate).not.toHaveBeenCalled();
  });
});
