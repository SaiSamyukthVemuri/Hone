import { describe, expect, it } from "vitest";
import {
  cancellationFeeState,
  isCancellationFeeRules,
  selectCancellationFeeTier,
  type CancellationFeeRules,
} from "@/lib/billing/cancellation-fee-rules";

const rules: CancellationFeeRules = {
  revision: 2,
  enabled: true,
  notice_hours: 48,
  notice_mode: "percent",
  notice_value: 5000,
  same_day_mode: "percent",
  same_day_value: 10000,
  policy_snapshot_hash: "a".repeat(64),
};
const choose = (
  cancelledAt: string | null,
  startsAt = "2026-11-20T15:00:00Z",
  timezone: string | null = "America/Toronto",
  r = rules,
) => selectCancellationFeeTier({ rules: r, startsAt, cancelledAt, timezone });
describe("cancellation fee tiers", () => {
  it("chooses 50% inside 48 hours and 100% on the same local date", () => {
    expect(choose("2026-11-19T14:00:00Z")).toMatchObject({
      ok: true,
      tier: "within_notice",
      rate: { mode: "percent", value: 5000 },
    });
    expect(choose("2026-11-20T08:00:00Z")).toMatchObject({
      ok: true,
      tier: "same_day",
      rate: { mode: "percent", value: 10000 },
    });
  });
  it("exactly 48 hours is free; one millisecond inside is charged", () => {
    expect(choose("2026-11-18T15:00:00Z")).toMatchObject({ ok: false });
    expect(choose("2026-11-18T15:00:00.001Z")).toMatchObject({
      ok: true,
      tier: "within_notice",
    });
  });
  it("same day means the studio's date, even across UTC midnight", () => {
    expect(
      choose("2026-11-20T23:00:00Z", "2026-11-21T02:00:00Z"),
    ).toMatchObject({ ok: true, tier: "same_day" });
    expect(
      choose("2026-11-20T04:59:59Z", "2026-11-20T15:00:00Z"),
    ).toMatchObject({ ok: true, tier: "within_notice" });
  });
  it("uses elapsed hours across both daylight-saving edges", () => {
    expect(
      choose("2026-03-06T14:00:00Z", "2026-03-08T14:00:00Z"),
    ).toMatchObject({ ok: false });
    expect(
      choose("2026-10-30T15:00:00.001Z", "2026-11-01T15:00:00Z"),
    ).toMatchObject({ ok: true, tier: "within_notice" });
  });
  it("supports independently fixed and percentage tiers and a different notice window", () => {
    const r = {
      ...rules,
      notice_hours: 24,
      same_day_mode: "fixed" as const,
      same_day_value: 4500,
    };
    expect(
      choose("2026-11-19T14:00:00Z", undefined, undefined, r),
    ).toMatchObject({ ok: false });
    expect(
      choose("2026-11-20T08:00:00Z", undefined, undefined, r),
    ).toMatchObject({ ok: true, rate: { mode: "fixed", value: 4500 } });
  });
  it.each([null, "garbage", "2026-11-20T16:00:00Z"])(
    "refuses unverifiable or after-start cancellation %s",
    (cancelled) => {
      expect(choose(cancelled).ok).toBe(false);
    },
  );
  it("refuses an invalid timezone and never defaults to UTC", () => {
    expect(choose("2026-11-20T08:00:00Z", undefined, null).ok).toBe(false);
    expect(choose("2026-11-20T08:00:00Z", undefined, "Not/a_zone").ok).toBe(
      false,
    );
  });
  it("refuses malformed configurations, zero, fractional and oversized rates", () => {
    for (const over of [
      { notice_value: 0 },
      { same_day_value: 10001 },
      { notice_mode: "other" },
      { notice_hours: 0 },
      { notice_hours: 1.5 },
      { revision: -1 },
      { policy_snapshot_hash: "bad" },
    ])
      expect(isCancellationFeeRules({ ...rules, ...over })).toBe(false);
    expect(
      isCancellationFeeRules({
        ...rules,
        notice_mode: "fixed",
        notice_value: 20000,
      }),
    ).toBe(true);
    expect(
      isCancellationFeeRules({
        ...rules,
        notice_mode: "fixed",
        notice_value: 20001,
      }),
    ).toBe(false);
  });
  it("only says Active for an enabled current-policy configuration with ready payments", () => {
    expect(
      cancellationFeeState(null, rules.policy_snapshot_hash, true),
    ).not.toBe("Active");
    expect(
      cancellationFeeState(
        { ...rules, enabled: false },
        rules.policy_snapshot_hash,
        true,
      ),
    ).not.toBe("Active");
    expect(cancellationFeeState(rules, "b".repeat(64), true)).not.toBe(
      "Active",
    );
    expect(
      cancellationFeeState(rules, rules.policy_snapshot_hash, false),
    ).not.toBe("Active");
    expect(cancellationFeeState(rules, rules.policy_snapshot_hash, true)).toBe(
      "Active",
    );
  });
});
