import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #204: charting field order follows Chloe's actual treatment
// flow, and "From last visit, for today" is BLUE treatment-memory
// context (not amber warning styling). Layout/color only: no schema,
// save-action, copy-settings, or sticky-frequency change.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);
const SUMMARY = read("components/last-session-summary.tsx");
const CLIENT_PAGE = read("app/(app)/clients/[id]/page.tsx");

describe("charting field order (Chloe's exact flow)", () => {
  it("Area -> Frequency -> Probe -> Mode -> Modality -> Readings -> Hairs -> Minutes", () => {
    const anchors = [
      // Migration 0128: the single-area section is now the multi-area editor,
      // still first (areas treated with these settings), before machine settings.
      "<MultiAreaEditor",
      '>Machine frequency</span>',
      '>Probe</span>',
      '>Mode</span>',
      '>Modality</span>',
      '>Treatment readings</span>',
      '>Hairs treated</span>',
      '>Minutes performed (optional)</span>',
    ];
    let prev = -1;
    for (const anchor of anchors) {
      const idx = FORM.indexOf(anchor);
      expect(idx, anchor).toBeGreaterThan(prev);
      prev = idx;
    }
  });

  it("Thermolysis pulse count renders within Treatment readings, after intensity and before Hairs treated", () => {
    // Charting correction: the pulse control moved INTO the thermolysis section
    // (the `thermoSection` const, defined above the return), labeled "Thermolysis
    // pulse count", and is placed via {thermoSection} inside Treatment readings —
    // so at RENDER it sits after the readings heading and before Hairs treated.
    const readingsIdx = FORM.indexOf(">Treatment readings</span>");
    const hairsIdx = FORM.indexOf(">Hairs treated</span>");
    expect(readingsIdx).toBeGreaterThan(-1);
    expect(hairsIdx).toBeGreaterThan(readingsIdx);
    // thermoSection is placed (rendered) between the readings heading and hairs.
    const thermoPlacementIdx = FORM.indexOf("{thermoSection}", readingsIdx);
    expect(thermoPlacementIdx).toBeGreaterThan(readingsIdx);
    expect(thermoPlacementIdx).toBeLessThan(hairsIdx);
    // Within the thermolysis section, pulse count follows the intensity reading and
    // carries the thermolysis label.
    const thermoBlock = FORM.slice(
      FORM.indexOf("const thermoSection ="),
      FORM.indexOf("const galvSection ="),
    );
    expect(thermoBlock).toMatch(/>Thermolysis pulse count<\/span>/);
    expect(thermoBlock.indexOf("Thermolysis intensity %")).toBeLessThan(
      thermoBlock.indexOf(">Thermolysis pulse count</span>"),
    );
  });

  it("sticky machine frequency from PR #203 still seeds the draft", () => {
    expect(FORM).toMatch(
      /machineFrequency: defaultMachineFrequency\?\.trim\(\) \|\| ""/,
    );
  });

  it("save payload and copy-settings are unchanged (layout-only move)", () => {
    expect(FORM).toMatch(/machineFrequency: \(draft\.machineFrequency \|\| null\) as/);
    expect(FORM).toMatch(/minutesPerformed:/);
    // copy-settings still carries the full setup — now via the shared contract.
    expect(FORM).toMatch(/buildTreatmentSetupDraftPatch\(source, firstEntry\)/);
    // No field was removed.
    expect(FORM).toMatch(/<ProbePicker/);
    expect(FORM).toMatch(/>Energy level \(EL\)<\/span>/);
  });
});

describe("From last visit, for today is blue treatment-memory context", () => {
  it("both variants use blue styling", () => {
    expect(SUMMARY).toMatch(
      /attached\s*\n?\s*\? "rounded-b-lg border-t border-blue-200 bg-blue-50/,
    );
    expect(SUMMARY).toMatch(
      /: "rounded-md border border-blue-200 bg-blue-50/,
    );
    expect(SUMMARY).toMatch(/text-blue-800 dark:text-blue-300/);
  });

  it("no amber/yellow warning styling remains in the band", () => {
    expect(SUMMARY).not.toMatch(/amber-/);
    expect(SUMMARY).not.toMatch(/yellow-/);
  });

  it("content logic from PR #203 is unchanged: pre-client source, attached, once, omit-empty", () => {
    const tab = CLIENT_PAGE.slice(
      CLIENT_PAGE.indexOf('{activeTab === "sessions"'),
      CLIENT_PAGE.indexOf('{activeTab === "treatment"'),
    );
    expect(tab).toMatch(
      /<FromLastVisitForToday[\s\S]{0,60}summary=\{preClientWatchPlan\}[\s\S]{0,40}attached/,
    );
    expect(tab.match(/<FromLastVisitForToday/g)?.length).toBe(1);
    expect(tab).toMatch(/hasFromLastVisitContent\(preClientWatchPlan\)/);
    expect(SUMMARY).toMatch(/Watch:<\/span>/);
    expect(SUMMARY).toMatch(/Plan:<\/span>/);
  });
});
