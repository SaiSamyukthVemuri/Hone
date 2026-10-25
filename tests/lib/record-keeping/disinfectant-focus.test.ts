import { describe, expect, it } from "vitest";
import {
  disinfectantNoticeHref,
  disinfectantRecordAnchor,
  placeFocusedRecord,
  resolveFocusedDisinfectantId,
} from "@/lib/record-keeping/disinfectant-focus";

describe("disinfectant notice target (HON-12)", () => {
  it("the link carries the record and the anchor the page renders", () => {
    expect(disinfectantNoticeHref("abc")).toBe(
      `/records?section=disinfectants&record=abc#${disinfectantRecordAnchor("abc")}`,
    );
  });
  it("encodes an unusual id", () => {
    expect(disinfectantNoticeHref("a b&c")).toContain("record=a%20b%26c");
  });
  it("focuses only a record that is in the studio's listed rows", () => {
    expect(resolveFocusedDisinfectantId("r2", ["r1", "r2"])).toBe("r2");
    expect(resolveFocusedDisinfectantId("other-studio", ["r1", "r2"])).toBeNull();
    expect(resolveFocusedDisinfectantId(undefined, ["r1"])).toBeNull();
    expect(resolveFocusedDisinfectantId("", ["r1"])).toBeNull();
  });

  describe("a record older than the newest 200 (Codex P2 on #1172)", () => {
    const listed = Array.from({ length: 200 }, (_, i) => ({ id: `new-${i}` }));
    it("is placed first with the listed rows after it, and then focuses", () => {
      const rows = placeFocusedRecord(listed, "old-1", { id: "old-1" });
      expect(rows).toHaveLength(201);
      expect(rows[0]).toEqual({ id: "old-1" });
      expect(resolveFocusedDisinfectantId("old-1", rows.map((r) => r.id))).toBe("old-1");
    });
    it("an other-studio or unknown id (nothing fetched) leaves the list exactly as before", () => {
      expect(placeFocusedRecord(listed, "other-studio", null)).toBe(listed);
    });
    it("a fetched row whose id is not the requested one is ignored", () => {
      expect(placeFocusedRecord(listed, "old-1", { id: "someone-else" })).toBe(listed);
    });
    it("a record already listed is not duplicated", () => {
      expect(placeFocusedRecord(listed, "new-3", { id: "new-3" })).toBe(listed);
    });
    it("no requested id leaves the list as before", () => {
      expect(placeFocusedRecord(listed, undefined, { id: "old-1" })).toBe(listed);
    });
  });
});
