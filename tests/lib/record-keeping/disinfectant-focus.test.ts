import { describe, expect, it } from "vitest";
import {
  disinfectantNoticeHref,
  disinfectantRecordAnchor,
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
});
