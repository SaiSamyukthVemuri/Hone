import { describe, expect, it } from "vitest";
import { isNativeMachineBlock } from "@/lib/machines/legacy-machine";

// The ONE rule for "this area was charted with a machine's own readings". The existing xCell workflow also saves a machine_profile_id on the block,
// but keeps every reading in the legacy columns, so the id alone must never decide it.
describe("isNativeMachineBlock", () => {
  it("is false with no machine, and for the existing xCell workflow", () => {
    expect(isNativeMachineBlock(null)).toBe(false);
    expect(isNativeMachineBlock(undefined)).toBe(false);
    expect(isNativeMachineBlock({ machine_profile_id: null })).toBe(false);
    expect(isNativeMachineBlock({ machine_profile_id: "" })).toBe(false);
    expect(isNativeMachineBlock({ machine_profile_id: "dectro-apilus:xcell" })).toBe(false);
    expect(isNativeMachineBlock({ machine_profile_id: "dectro-apilus:xcell", machine_mode_key: null, studio_machine_id: null })).toBe(false);
  });
  it("is true for a native profile saved with a mode or a registered unit", () => {
    expect(isNativeMachineBlock({ machine_profile_id: "dectro-apilus:xcell-pur", machine_mode_key: "multiplex" })).toBe(true);
    expect(isNativeMachineBlock({ machine_profile_id: "dectro-apilus:xcell-pur", studio_machine_id: "u1" })).toBe(true);
  });
  it("is false for a bare profile id that is not the legacy one but carries neither a mode nor a unit", () => {
    expect(isNativeMachineBlock({ machine_profile_id: "dectro-apilus:xcell-pur" })).toBe(false);
  });
});
