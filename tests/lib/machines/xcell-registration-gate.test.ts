import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { xcellRegistrationAllowed } from "@/lib/machines/xcell-registration-gate";
import { CHARTING_VIEW_STUDIOS_ENV, chartingViewToggleVisible, parseChartingViewGate } from "@/lib/charting/view-preference";

// Sam's rollout decision: only allowlisted studios see or register "Dectro xCell". SYNTHETIC ids only.
const LISTED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("the xCell registration gate reuses the charting allowlist rule", () => {
  it("unset, empty and unreadable values mean nobody (fail closed)", () => {
    for (const raw of [undefined, null, "", "   ", "not-an-id", "garbage,also-garbage"]) expect(xcellRegistrationAllowed(LISTED, raw), String(raw)).toBe(false);
  });
  it("'all' means every studio, and a list means exactly those studios", () => {
    expect(xcellRegistrationAllowed(OTHER, "all")).toBe(true);
    expect(xcellRegistrationAllowed(LISTED, `${LISTED}, ${OTHER.toUpperCase()}`)).toBe(true);
    expect(xcellRegistrationAllowed(OTHER, `${LISTED}`)).toBe(false);
    expect(xcellRegistrationAllowed(null, `${LISTED}`)).toBe(false);
    expect(xcellRegistrationAllowed(undefined, "all")).toBe(true);
  });
  it("answers exactly as the charting toggle does for the same input (no second parser)", () => {
    for (const raw of [undefined, "", "all", LISTED, `${LISTED},${OTHER}`, "x,y"]) {
      for (const id of [LISTED, OTHER, null]) expect(xcellRegistrationAllowed(id, raw)).toBe(chartingViewToggleVisible(parseChartingViewGate(raw), id));
    }
    const src = readFileSync("lib/machines/xcell-registration-gate.ts", "utf8");
    expect(src).toContain("parseChartingViewGate");
    expect(src).toContain(CHARTING_VIEW_STUDIOS_ENV);
    expect(src).not.toMatch(/split\(/);
  });
  it("by default it reads the environment variable named by the charting module", () => {
    const prev = process.env[CHARTING_VIEW_STUDIOS_ENV];
    try {
      process.env[CHARTING_VIEW_STUDIOS_ENV] = LISTED;
      expect(xcellRegistrationAllowed(LISTED)).toBe(true);
      expect(xcellRegistrationAllowed(OTHER)).toBe(false);
      delete process.env[CHARTING_VIEW_STUDIOS_ENV];
      expect(xcellRegistrationAllowed(LISTED)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env[CHARTING_VIEW_STUDIOS_ENV]; else process.env[CHARTING_VIEW_STUDIOS_ENV] = prev;
    }
  });
});
