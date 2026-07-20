import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR B Part 2 — the flag-OFF Willow compatibility contract for the Availability
// page. When practitioner_capacity_enabled !== true the page must render the
// existing studio-wide experience and must NOT issue any per-practitioner
// (0135) query or show the scope selector.

const root = path.resolve(__dirname, "../../../");
const PAGE = readFileSync(
  path.join(root, "app/(app)/settings/availability/page.tsx"),
  "utf8",
);

describe("Availability page: flag-OFF contract", () => {
  it("returns the studio-wide render BEFORE any per-practitioner query runs", () => {
    const offReturn = PAGE.indexOf("if (!capacityOn)");
    const firstScopedCall = Math.min(
      ...["getActivePractitioners(", "loadScopedAvailability(", "studioWideDefaults("]
        .map((s) => PAGE.indexOf(s))
        .filter((i) => i >= 0),
    );
    expect(offReturn).toBeGreaterThan(0);
    // The OFF branch's early return precedes every per-practitioner call site.
    expect(offReturn).toBeLessThan(firstScopedCall);
  });

  it("the OFF branch uses the existing studio-wide loaders (select *, no practitioner_id)", () => {
    const off = PAGE.slice(
      PAGE.indexOf("if (!capacityOn)"),
      PAGE.indexOf("// ---- Flag ON"),
    );
    expect(off).toMatch(/getAvailabilityDefaults\(studio\.id\)/);
    expect(off).toMatch(/getOverridesForRange\(studio\.id/);
    expect(off).not.toMatch(/practitioner_id/);
    expect(off).not.toMatch(/ScopeSelector|PractitionerWeekEditor|getActivePractitioners/);
  });

  it("the scope selector + practitioner editor are gated behind the ON branch only", () => {
    const onIdx = PAGE.indexOf("// ---- Flag ON");
    expect(PAGE.indexOf("<ScopeSelector")).toBeGreaterThan(onIdx);
    expect(PAGE.indexOf("<PractitionerWeekEditor")).toBeGreaterThan(onIdx);
  });
});
