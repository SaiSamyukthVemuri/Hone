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
  it("Area -> Frequency -> Probe -> Mode -> Modality -> Readings -> Pulse -> Hairs -> Minutes", () => {
    const anchors = [
      '>Treatment area</span>',
      '>Machine frequency</span>',
      '>Probe</span>',
      '>Mode</span>',
      '>Modality</span>',
      '>Treatment readings</span>',
      '>Pulse count</span>',
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

  it("sticky machine frequency from PR #203 still seeds the draft", () => {
    expect(FORM).toMatch(
      /machineFrequency: defaultMachineFrequency\?\.trim\(\) \|\| ""/,
    );
  });

  it("save payload and copy-settings are unchanged (layout-only move)", () => {
    expect(FORM).toMatch(/machineFrequency: \(draft\.machineFrequency \|\| null\) as/);
    expect(FORM).toMatch(/minutesPerformed:/);
    expect(FORM).toMatch(/machineFrequency: source\.machine_frequency \?\? ""/);
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
