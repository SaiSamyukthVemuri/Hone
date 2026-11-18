import { describe, expect, it } from "vitest";
import { currentSettingCount } from "@/lib/machines/recorded-count";
import type { RecordedReading } from "@/lib/machines/machine-queries";

const r = (groupKey: string, fieldKey: string, revision: number, absent = false) =>
  ({ groupKey, fieldKey, revision, value: absent ? { kind: "absent", reason: "not-shown" } : { kind: "value", value: 1 } }) as unknown as RecordedReading;

describe("currentSettingCount", () => {
  it("is zero for no rows", () => expect(currentSettingCount([])).toBe(0));
  it("counts one per field at the highest revision of each group", () => {
    const rows = [r("g1", "a", 1), r("g1", "b", 1), r("g1", "c", 1), r("g1", "a", 2), r("g1", "b", 2), r("g1", "c", 2)];
    expect(currentSettingCount(rows)).toBe(3);
  });
  it("sums across groups, each at its own highest revision", () => {
    expect(currentSettingCount([r("g1", "a", 1), r("g1", "a", 2), r("g2", "a", 1), r("g2", "b", 1)])).toBe(3);
  });
  it("does not count an absence row, and a group whose latest revision is all absences contributes none", () => {
    expect(currentSettingCount([r("g1", "a", 1), r("g1", "a", 2, true)])).toBe(0);
    expect(currentSettingCount([r("g1", "a", 1), r("g1", "b", 1, true)])).toBe(1);
  });
  it("counts a field once even if its row is repeated at the same revision", () => {
    expect(currentSettingCount([r("g1", "a", 1), r("g1", "a", 1)])).toBe(1);
  });
});

import { recordedSummary } from "@/lib/machines/recorded-count";
describe("recordedSummary", () => {
  it("flags earlier versions only when a superseded revision exists", () => {
    expect(recordedSummary([r("g1", "a", 1)]).earlierVersions).toBe(false);
    expect(recordedSummary([r("g1", "a", 1), r("g1", "a", 2)]).earlierVersions).toBe(true);
  });
  it("is absence-only when rows exist and none is a value", () => {
    expect(recordedSummary([]).absenceOnly).toBe(false);
    expect(recordedSummary([r("g1", "a", 1, true)]).absenceOnly).toBe(true);
    expect(recordedSummary([r("g1", "a", 1, true), r("g1", "b", 1)]).absenceOnly).toBe(false);
  });
});
