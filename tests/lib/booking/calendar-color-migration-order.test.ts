import { describe, expect, it } from "vitest";
import { isMissingColumnError } from "@/lib/db/missing-column";

// Migration-order safety: the missing-column detector is column-scoped so the
// calendar read + settings write fall back ONLY when calendar_color is genuinely
// absent (app deployed before 0153), and NEVER swallow unrelated DB errors.
describe("isMissingColumnError — column-scoped, migration-order safe", () => {
  it("detects a missing SELECT column (42703) that names the column", () => {
    expect(isMissingColumnError({ code: "42703", message: 'column services.calendar_color does not exist' }, "calendar_color")).toBe(true);
  });
  it("detects a missing INSERT/UPDATE column (PGRST204 schema cache) that names the column", () => {
    expect(isMissingColumnError({ code: "PGRST204", message: "Could not find the 'calendar_color' column of 'services' in the schema cache" }, "calendar_color")).toBe(true);
  });
  it("does NOT match a different column's undefined-column error", () => {
    expect(isMissingColumnError({ code: "42703", message: 'column services.price_cents does not exist' }, "calendar_color")).toBe(false);
  });
  it("does NOT match unrelated DB errors (permission, connection, constraint)", () => {
    for (const e of [
      { code: "42501", message: "permission denied for table services" },
      { code: "23505", message: "duplicate key value violates unique constraint" },
      { code: "08006", message: "connection failure" },
      { code: "23514", message: "new row violates check constraint services_calendar_color_allowed" },
      null,
      undefined,
    ]) {
      expect(isMissingColumnError(e, "calendar_color")).toBe(false);
    }
  });
});
