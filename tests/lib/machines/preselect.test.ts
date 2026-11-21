import { describe, expect, it } from "vitest";
import { preselectOnlyChoice } from "@/lib/machines/preselect";
import { XCELL_PUR_PROFILE_ID } from "@/lib/machines/xcell-pur";

const u = (deviceId: string, profileId = "fixture:other") => ({ device: { deviceId, profileId }, profile: { profileId } });

describe("preselectOnlyChoice", () => {
  it("zero entries preselects nothing", () => {
    expect(preselectOnlyChoice([], false)).toBeNull();
  });
  it("exactly one live unit and no existing-xCell offer preselects that unit", () => {
    expect(preselectOnlyChoice([u("a")], false)).toEqual({ kind: "native", deviceId: "a" });
  });
  it("two units preselect nothing", () => {
    expect(preselectOnlyChoice([u("a"), u("b")], false)).toBeNull();
  });
  it("the existing xCell offered alone is the one entry", () => {
    expect(preselectOnlyChoice([], true)).toEqual({ kind: "legacy" });
  });
  it("the existing xCell plus one other unit is two entries: nothing preselected", () => {
    expect(preselectOnlyChoice([u("a")], true)).toBeNull();
  });
  it("a registered xCell Pur unit beside the existing xCell offer counts ONCE (one xCell choice): preselects the existing entry", () => {
    expect(preselectOnlyChoice([u("x", XCELL_PUR_PROFILE_ID)], true)).toEqual({ kind: "legacy" });
  });
  it("two xCell Pur units beside the offer still count once", () => {
    expect(preselectOnlyChoice([u("x", XCELL_PUR_PROFILE_ID), u("y", XCELL_PUR_PROFILE_ID)], true)).toEqual({ kind: "legacy" });
  });
  it("the xCell Pur unit with no existing-xCell offer is the one entry, as a unit", () => {
    expect(preselectOnlyChoice([u("x", XCELL_PUR_PROFILE_ID)], false)).toEqual({ kind: "native", deviceId: "x" });
  });
  it("an xCell Pur unit plus another unit beside the offer is two entries", () => {
    expect(preselectOnlyChoice([u("x", XCELL_PUR_PROFILE_ID), u("a")], true)).toBeNull();
  });
});
