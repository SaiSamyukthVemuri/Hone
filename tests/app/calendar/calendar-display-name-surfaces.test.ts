import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// HON-58 G1 (Privacy C2): the appointment page computes the display name on the server and passes ONE string on, and the
// client components that draw the calendar never see a second name field.

const read = (p: string) => readFileSync(p, "utf8");

describe("appointment page", () => {
  const src = read("app/(app)/calendar/[id]/page.tsx");
  it("reads preferred_name through the shared fallback and names its columns", () => {
    expect(src).toContain("readWithPreferredName");
    expect(src).toContain("${preferredNameColumn(includePreferred)}");
    expect(src).not.toMatch(/client:clients\(\*/);
  });
  it("replaces the client's name with the display name and drops preferred_name before anything else uses it", () => {
    expect(src).toMatch(/const \{ preferred_name: preferredName, \.\.\.rest \} = data\.client/);
    expect(src).toMatch(/name: clientDisplayName\(\{ name: rest\.name, preferred_name: preferredName \}\)/);
    const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    const uses = code.split("preferred_name").length - 1;
    expect(uses, "preferred_name appears in code only in the destructure, its type and the display-name call").toBeLessThanOrEqual(3);
  });
});

describe("components that draw the calendar", () => {
  for (const f of [
    "DayColumn.tsx",
    "MobileDayTimeline.tsx",
    "AppointmentPreviewDrawer.tsx",
    "AppointmentOverlapChooser.tsx",
    "MonthView.tsx",
    "CalendarMobileDayView.tsx",
  ]) {
    it(`${f} reads one name, the one the loader provides`, () => {
      const src = read(`app/(app)/calendar/${f}`);
      expect(src).not.toMatch(/preferred_name|preferredName/);
      expect(src).not.toMatch(/legal/i);
      expect(src).not.toMatch(/client(?:s)?\??\.(?:legal|stored)/);
    });
  }
});
