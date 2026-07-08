import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR: booking-drawer behavior (Chloe calendar friction). The outside-
// availability override must reset OFF for each new booking attempt, the
// practitioner's clicked time must be preserved (never snapped to a different
// suggested slot), and booking outside availability must require an explicit
// confirmation. vitest env is "node" (no DOM) → verified by source pins.
const DRAWER = readFileSync(
  path.resolve(__dirname, "../../../app/(app)/calendar/QuickBookDrawer.tsx"),
  "utf8",
);

describe("override resets OFF for each booking attempt (not sticky)", () => {
  it("resets on drawer close (fresh draft) — override + confirm both off", () => {
    const closeBlock = DRAWER.slice(DRAWER.indexOf("if (!open) {"), DRAWER.indexOf("}, [open, firstServiceId]"));
    expect(closeBlock).toMatch(/setOverrideEnabled\(false\)/);
    expect(closeBlock).toMatch(/setOverrideConfirmed\(false\)/);
  });
  it("resets on a NEW bare-click slot (the else branch no longer leaks the prior override)", () => {
    // the draft-change effect's else branch (bare click) now resets override off
    expect(DRAWER).toMatch(/Bare click on a NEW slot[\s\S]*setOverrideEnabled\(false\)[\s\S]*setOverrideConfirmed\(false\)/);
  });
  it("resets after a FAILED submit so it is not stuck on for the next attempt", () => {
    expect(DRAWER).toMatch(
      /A failed attempt must NOT leave[\s\S]*?setOverrideEnabled\(false\);[\s\S]*?setOverrideConfirmed\(false\);/,
    );
  });
  it("successful submit closes the drawer → the close reset clears override", () => {
    expect(DRAWER).toMatch(/router\.refresh\(\);\s*\n\s*onClose\(\);/);
  });
  it("a drag still SOFT-enables override (that hint is per-attempt, resets on new draft)", () => {
    // the only literal true-enable is the drag branch; the checkbox uses e.target.checked
    expect(DRAWER.match(/setOverrideEnabled\(true\)/g)?.length).toBe(1);
    expect(DRAWER).toMatch(/if \(dragMinutes && dragMinutes > 0\) \{[\s\S]*?setOverrideEnabled\(true\)/);
  });
});

describe("practitioner clicked time is preserved (never snapped to a different slot)", () => {
  it("the override time is seeded from the clicked draft time and submitted exactly", () => {
    expect(DRAWER).toMatch(/setOverrideLocalTime\(draft\.localTime\)/);
    expect(DRAWER).toMatch(/utcInstantFromLocal\(\s*draft!\.localDate,\s*overrideLocalTime,\s*studioTimezone,?\s*\)/);
  });
  it("smart scheduling only preselects an EXACT-match slot, never a different suggestion", () => {
    // exact match on the clicked time, else null — no nearest-slot substitution
    expect(DRAWER).toMatch(/futureSlots\.find\(\(s\) => s\.startLabel === targetHint\)/);
    expect(DRAWER).toMatch(/setPickedSlot\(exact \?\? null\)/);
  });
});

describe("booking outside availability requires an explicit override", () => {
  it("submit is blocked unless the override is confirmed", () => {
    expect(DRAWER).toMatch(/if \(!overrideTimeValid \|\| !overrideConfirmed\) return;/);
  });
  it("Save stays disabled until override time is valid AND confirmed", () => {
    expect(DRAWER).toMatch(/overrideTimeValid && overrideConfirmed/);
  });
});
