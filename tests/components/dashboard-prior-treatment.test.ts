import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardPriorTreatment } from "@/components/dashboard-prior-treatment";
import { buildAppointmentPrepMemory, type AppointmentPrepArea, type AppointmentPrepMemory } from "@/lib/sessions/appointment-prep-memory";

const area: AppointmentPrepArea = {
  key: "chin", areaLabel: "Midline chin", areaParts: ["Midline chin"], passCount: 2,
  setup: { frequency: "27.12 MHz", probeLine: "Ballet F3 · Lot 123", modeLabel: "Thermolysis", modalityLabel: "MeloFlash",
    energyLevel: 555, readings: [{ field: "energyLevel", label: "Energy level", value: "EL 555" }] },
  outcome: { minutes: 30, hairs: 157, numbing: null, toleranceLine: "4/5", responseLine: null, responseNote: null,
    cautionNote: null, cautionFlag: false, notes: [] },
  setupRecorded: true, settingsChangedDuringSession: false, changedPasses: [], outcomeRecorded: true,
};
const memory: AppointmentPrepMemory = {
  sessionId: "previous", startedAt: "2026-11-05T12:00:00Z", modality: "electrolysis", areaHeadline: area.areaLabel,
  totalMinutes: 30, totalHairs: 157, areas: [area], blocklessNote: null, supersededByEmptySession: false,
  notes: { general: [], forNextVisit: { key: "next", source: "next_session_note", label: "For next visit", text: "Old reminder" },
    additional: [{ areaKey: area.key, areaLabel: area.areaLabel, key: "local", source: "entry_comments", label: "Note", text: "Full practitioner note." }],
    responses: [], cautions: [], hasAny: true },
};
const html = (value: AppointmentPrepMemory) => renderToStaticMarkup(createElement(DashboardPriorTreatment, { memory: value }));

describe("dashboard last visit details", () => {
  it("shows each area's settings, result and complete note together on first opening", () => {
    const out = html(memory);
    for (const text of ["Midline chin", "27.12 MHz", "Ballet F3 · Lot 123", "Thermolysis", "MeloFlash", "EL 555", "157 hairs", "30 min", "Full practitioner note."]) {
      expect(out.split(text)).toHaveLength(2);
    }
    expect(out).not.toContain("Settings by pass");
    expect(out).not.toContain("<details");
    expect(out).not.toContain("Old reminder");
  });
  it("shows every changed, live pass in order on first opening, with the area and hardware listed once", () => {
    const session = { id: "session", started_at: "2026-11-05T12:00:00Z", modality: "electrolysis" };
    const first = { id: "pass-a", mode: "thermo", created_at: "2026-11-05T12:00:00.000001Z", deleted_at: null,
      thermolysis_intensity_percent: 40, thermolysis_duration_seconds: 0.35, pulse_count: 1, pulse_delay_seconds: 0.75 };
    const second = { ...first, id: "pass-b", created_at: "2026-11-05T07:00:00.000002-05:00",
      thermolysis_intensity_percent: 55, pulse_count: 3, pulse_delay_seconds: 0.24, comments: "Adjusted during treatment." };
    const result = buildAppointmentPrepMemory({ session, blocks: [{
      id: "block", block_name: "Midline chin", mode: "thermo", machine_frequency: "27.12 MHz", energy_level: 555,
      entries: [second, { ...first, id: "deleted", thermolysis_intensity_percent: 97, deleted_at: session.started_at }, first],
    }] });
    expect(result.areas[0].changedPasses.map(pass => pass.recordedAt)).toEqual([first.created_at, second.created_at]);
    const out = html(result);
    expect(out).toMatch(/Pass 1[\s\S]*?40%[\s\S]*?Pass 2[\s\S]*?55%/);
    for (const once of ["Midline chin", "27.12 MHz", "EL 555", "0.24s delay", "Adjusted during treatment."]) {
      expect(out.split(once)).toHaveLength(2);
    }
    expect(out).not.toMatch(/0\.75s delay|97%|Open the full chart|<details/);
  });
  it("retains blockless historical information and distinguishes zero values from absent values", () => {
    const out = html({ ...memory, areas: [], totalHairs: 0, totalMinutes: null, blocklessNote: "Laser readings on original record" });
    expect(out).toContain("Laser readings on original record");
    expect(out).toContain("0 hairs");
    expect(out).not.toContain("0 min");
    expect(out).toContain("Full practitioner note.");
  });
});
