import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ElectrolysisEntryRow } from "@/components/entry-row";
import { pulseReadingsShown } from "@/lib/sessions/structured-readings";
import type { ElectrolysisEntry } from "@/lib/types/database";

// PARITY (Codex P1 4305560955): the HON-46 printout gates pulse count / pulse
// delay through pulseReadingsShown(). This renders the REAL saved-record view
// across a matrix of entries and asserts it shows pulses and delay EXACTLY when
// that shared rule says so, in both of its variants, so screen and paper
// cannot diverge.

const base = {
  id: "e",
  session_id: "s",
  block_id: null,
  area: "chin",
  areas_list: null,
  probe_type: null,
  probe_size: null,
  mode: null,
  apilus_modality: null,
  energy_level: null,
  intensity: null,
  duration_seconds: null,
  pulse_count: null,
  pulse_delay_seconds: null,
  machine_frequency: null,
  minutes_performed: null,
  hairs_treated: null,
  thermolysis_intensity_percent: null,
  thermolysis_duration_seconds: null,
  galvanic_ma: null,
  galvanic_duration_seconds: null,
  galvanic_intensity_percent: null,
  units_of_lye: null,
  observation_chips: [],
  comments: null,
  created_at: "2026-10-01T15:00:00Z",
};

const MATRIX: Array<[string, Record<string, unknown>]> = [
  ["galvanic structured, default 1 pulse", { mode: "galvanic", galvanic_ma: 0.3, pulse_count: 1 }],
  ["galvanic structured, 3 pulses + delay", { mode: "galvanic", galvanic_ma: 0.3, pulse_count: 3, pulse_delay_seconds: 0.5 }],
  ["thermo, 3 pulses + delay", { mode: "thermo", thermolysis_intensity_percent: 20, pulse_count: 3, pulse_delay_seconds: 0.5 }],
  ["thermo, 1 pulse + delay", { mode: "thermo", thermolysis_intensity_percent: 20, pulse_count: 1, pulse_delay_seconds: 0.5 }],
  ["blend, 2 pulses, no delay", { mode: "blend", galvanic_ma: 0.3, pulse_count: 2 }],
  ["legacy (no structured), 2 pulses + delay", { mode: null, intensity: 40, pulse_count: 2, pulse_delay_seconds: 0.4 }],
  ["legacy galvanic mode, no structured readings, 2 pulses", { mode: "galvanic", intensity: 40, pulse_count: 2 }],
  // The STORED galvanic mode is "galv" (0001's CHECK). A galv pass saved with NO
  // readings keeps the writer's default count 1 and must show no pulses
  // (Codex P1 4307447121), on screen and on paper.
  ["galv pass, no readings, stored default 1 pulse", { mode: "galv", pulse_count: 1 }],
  ["galv pass, legacy pair, 2 pulses", { mode: "galv", intensity: 40, pulse_count: 2, pulse_delay_seconds: 0.5 }],
  ["no pulse count at all", { mode: "thermo", thermolysis_intensity_percent: 20 }],
];

describe("pulse display: the saved view and the shared rule agree", () => {
  for (const [name, over] of MATRIX) {
    for (const variant of ["full", "readings"] as const) {
      it(`${name} (${variant})`, () => {
        const entry = { ...base, ...over } as unknown as ElectrolysisEntry;
        const html = renderToStaticMarkup(createElement(ElectrolysisEntryRow, { entry, variant }));
        const expected = pulseReadingsShown(entry as never);
        expect(/\b\d+ pulses?\b/.test(html), "pulses shown").toBe(expected.pulses);
        expect(/\ds delay\b/.test(html), "delay shown").toBe(expected.delay);
      });
    }
  }
});
