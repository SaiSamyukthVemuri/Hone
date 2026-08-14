import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR B: the flag-OFF Willow compatibility + rollback contract for the
// Availability page. When practitioner_capacity_enabled !== true the page must
// render the existing studio-wide experience, load ONLY studio-wide rows (so a
// rolled-back studio's retained practitioner rows never leak into the studio
// editor), and never call the ON-only per-practitioner loaders / scope UI.

const root = path.resolve(__dirname, "../../../");
const PAGE = readFileSync(
  path.join(root, "app/(app)/settings/availability/page.tsx"),
  "utf8",
);
const off = PAGE.slice(
  PAGE.indexOf("if (!capacityOn)"),
  PAGE.indexOf("// ---- Flag ON"),
);
// Comment-stripped OFF slice: the code path must not QUERY practitioner_id
// (it delegates to the safe studio-wide loader); a doc-comment may mention it.
const offCode = off.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("Availability page: flag-OFF contract", () => {
  it("returns the studio-wide render BEFORE any ON-only per-practitioner call", () => {
    const offReturn = PAGE.indexOf("if (!capacityOn)");
    const firstOnCall = Math.min(
      ...["getActivePractitioners(", "loadScopedAvailability("]
        .map((s) => PAGE.indexOf(s))
        .filter((i) => i >= 0),
    );
    expect(offReturn).toBeGreaterThan(0);
    expect(offReturn).toBeLessThan(firstOnCall);
  });

  it("the OFF branch loads studio-wide-only rows (rollback-safe), not the legacy unscoped loaders", () => {
    expect(off).toMatch(/studioWideDefaults\(supabase, studio\.id\)/);
    expect(off).toMatch(/studioWideOverrides\(supabase, studio\.id/);
    // The legacy unscoped loaders (which would surface retained practitioner
    // rows on a rolled-back studio) are gone from the OFF path.
    expect(off).not.toMatch(/getAvailabilityDefaults\(/);
    expect(off).not.toMatch(/getOverridesForRange\(/);
  });

  it("the OFF branch calls no ON-only loader and renders no scope UI", () => {
    expect(off).not.toMatch(/getActivePractitioners|loadScopedAvailability/);
    expect(off).not.toMatch(/ScopeSelector|PractitionerWeekEditor/);
    // No practitioner_id QUERY in the OFF page code (comments may mention it).
    expect(offCode).not.toMatch(/practitioner_id/);
  });

  it("the scope selector + practitioner editor are gated behind the ON branch only", () => {
    const onIdx = PAGE.indexOf("// ---- Flag ON");
    expect(PAGE.indexOf("<ScopeSelector")).toBeGreaterThan(onIdx);
    expect(PAGE.indexOf("<PractitionerWeekEditor")).toBeGreaterThan(onIdx);
  });
});
