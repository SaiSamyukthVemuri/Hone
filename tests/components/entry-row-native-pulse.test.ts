import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ElectrolysisEntryRow } from "@/components/entry-row";

// a native (MultiPlex) block's legacy entry holds only the database default pulse_count 1 (migration 0166). The row must never print it.
const entry = { id: "e1", session_id: "s1", area: "Chin", areas: ["Chin"], mode: null, apilus_modality: null, probe_size: null, intensity: null, duration_seconds: null, pulse_count: 1, pulse_delay_seconds: null, energy_level: null, thermolysis_intensity_percent: null, thermolysis_duration_seconds: null, galvanic_ma: null, galvanic_duration_seconds: null, units_of_lye: null, comments: null, observation_chips: [], block_id: "b1", created_at: "2026-11-25T00:00:00Z" };
const text = (block: unknown, variant: "full" | "readings") =>
  renderToString(createElement(ElectrolysisEntryRow as never, { entry, block, variant } as never)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("entry row under a native block", () => {
  for (const variant of ["full", "readings"] as const) {
    it(`${variant}: prints no legacy pulse and no 'No readings recorded'`, () => {
      const t = text({ id: "b1", machine_profile_id: "dectro-apilus:xcell-pur" }, variant);
      expect(t).not.toMatch(/pulse/i);
      expect(t).not.toContain("No readings recorded");
    });
    it(`${variant}: a legacy block still prints its pulse count (unchanged)`, () => {
      expect(text({ id: "b1", machine_profile_id: null }, variant)).toContain("1 pulse");
    });
  }
});
