import { describe, expect, it } from "vitest";
import { AUTO_POSTCARE_NOTE, autoPostcareNote } from "@/lib/sessions/finish-appointment";

// HON-45: an opted-in studio's automatic postcare is honoured AND announced beforehand. Everyone else sees nothing.
describe("autoPostcareNote", () => {
  it("opted-in studio: says so while the appointment can still be completed", () => {
    expect(autoPostcareNote("auto_on_complete", "ready")).toBe(AUTO_POSTCARE_NOTE);
    expect(autoPostcareNote("auto_on_complete", "before_start")).toBe(AUTO_POSTCARE_NOTE);
  });

  it("the line names postcare, calls it a studio setting, and says charging is separate", () => {
    expect(AUTO_POSTCARE_NOTE).toMatch(/Postcare will be sent automatically/);
    expect(AUTO_POSTCARE_NOTE).toMatch(/studio setting/);
    expect(AUTO_POSTCARE_NOTE).toMatch(/Charging is separate/);
  });

  it("manual, unset or unknown mode: never shown", () => {
    for (const mode of ["manual", null, undefined, "", "AUTO_ON_COMPLETE", "auto"]) {
      expect(autoPostcareNote(mode, "ready"), String(mode)).toBeNull();
    }
  });

  it("not shown once there is nothing left to complete", () => {
    for (const kind of ["completed", "cancelled", "no_show", "unlinked"] as const) {
      expect(autoPostcareNote("auto_on_complete", kind), kind).toBeNull();
    }
  });
});
