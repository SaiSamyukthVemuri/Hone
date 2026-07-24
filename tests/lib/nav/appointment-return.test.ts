import { describe, expect, it } from "vitest";
import { sanitizeAppointmentReturnTo } from "@/lib/nav/appointment-return";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("sanitizeAppointmentReturnTo — only internal /calendar/<uuid>", () => {
  it("accepts a valid appointment route", () => {
    expect(sanitizeAppointmentReturnTo(`/calendar/${UUID}`)).toBe(`/calendar/${UUID}`);
  });
  it("rejects external / malformed / cross-route / multi-segment / query / fragment values", () => {
    for (const bad of [
      "https://evil.com",
      "//evil.com",
      "/calendar",
      `/calendar/${UUID}?x=1`,
      `/calendar/${UUID}/extra`,
      `/calendar/${UUID}#f`,
      `/clients/${UUID}`,
      "/settings/services",
      `/calendar/${UUID} `,
      "javascript:alert(1)",
      "/calendar/not-a-uuid",
      `/CALENDAR/${UUID}`,
      "",
      null,
      undefined,
    ]) {
      expect(sanitizeAppointmentReturnTo(bad as never), `${bad}`).toBeNull();
    }
  });
  it("takes the first array value then validates", () => {
    expect(sanitizeAppointmentReturnTo([`/calendar/${UUID}`, "x"])).toBe(`/calendar/${UUID}`);
    expect(sanitizeAppointmentReturnTo(["https://evil.com"])).toBeNull();
  });
});
