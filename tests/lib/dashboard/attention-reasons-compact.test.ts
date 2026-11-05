import { describe, expect, it } from "vitest";
import { ISSUE_ACTION, ISSUE_REASON } from "@/lib/dashboard/needs-attention-model";
import { groupItemsByKind, visitDateLabel, visitsLabel } from "@/lib/dashboard/attention-compact";

// Synthetic fixtures only. HON-65 item 2/3: every reason and action is specific; repeated kinds fold into one row.

describe("reasons and actions are specific", () => {
  it("every issue kind has its own reason and its own action, and none is generic", () => {
    const kinds = Object.keys(ISSUE_REASON);
    expect(Object.keys(ISSUE_ACTION).sort()).toEqual(kinds.sort());
    expect(new Set(Object.values(ISSUE_REASON)).size).toBe(kinds.length);
    expect(new Set(Object.values(ISSUE_ACTION)).size).toBe(kinds.length);
    for (const text of [...Object.values(ISSUE_REASON), ...Object.values(ISSUE_ACTION)]) {
      expect(text).not.toMatch(/^(follow-?up|review session|open client)$/i);
    }
  });
});

describe("groupItemsByKind", () => {
  const it_ = (kind: string, id: string) => ({ kind, id }) as never;
  it("folds repeats of a kind into one group in first-appearance order and keeps distinct kinds apart", () => {
    const groups = groupItemsByKind([it_("aftercare", "a"), it_("charting", "c"), it_("aftercare", "b")]);
    expect(groups.map((g) => g.kind)).toEqual(["aftercare", "charting"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("visit dates", () => {
  it("renders the day in the studio timezone, not UTC", () => {
    // 02:00Z on 29 Oct is still the evening of the 28th in Toronto.
    expect(visitDateLabel("2026-10-29T02:00:00Z", "America/Toronto")).toMatch(/Oct\.? 28/);
    expect(visitDateLabel("2026-10-29T02:00:00Z", "UTC")).toMatch(/Oct\.? 29/);
  });
  it("is empty for a missing or bad date and survives a bad zone", () => {
    expect(visitDateLabel(null, "UTC")).toBe("");
    expect(visitDateLabel("not a date", "UTC")).toBe("");
    expect(visitDateLabel("2026-10-29T12:00:00Z", "Not/AZone")).toMatch(/Oct\.? 29/);
  });
  it("counts visits", () => {
    expect(visitsLabel(3)).toBe("3 visits");
  });
});
