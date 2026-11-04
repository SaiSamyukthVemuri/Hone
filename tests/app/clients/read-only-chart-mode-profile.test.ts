import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Read-only chart mode on the client profile (Roles): clin.view_records without clin.edit_records shows notes, plans and the goal and offers no
// control that changes them. The actions refuse on their own; these pins keep the page from offering what would be refused.
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const PAGE = strip(read("app/(app)/clients/[id]/page.tsx"));
const NOTES = strip(read("components/clinical-notes-section.tsx"));
const PLANS = strip(read("components/treatment-plans-card.tsx"));
const TIME = strip(read("components/treatment-time-card.tsx"));
const GOAL_ACTION = strip(read("app/(app)/clients/[id]/treatment-time-actions.ts"));

describe("profile page", () => {
  it("asks the edit key only with the view key, contained, started before render and awaited once", () => {
    expect(PAGE).toMatch(/const canEditRecordsPromise = canViewRecords\s*\?\s*contained\("clin\.edit_records"/);
    expect(PAGE).toContain(': Promise.resolve(false);');
    expect(PAGE).toMatch(/canEditRecordsPromise,\n  \]\);/); // awaited inside the one parallel wave, never as its own serial stage
    expect(PAGE).not.toMatch(/await canEditRecordsPromise/);
    expect(PAGE).not.toMatch(/canEditRecords[^\n]*notFound\(\)/);
  });
  it.each([
    ["goal card", /<TreatmentTimeCard[\s\S]*?readOnly=\{!canEditRecords\}/],
    ["clinical notes", /<ClinicalNotesSection[\s\S]*?readOnly=\{!canEditRecords\}/],
    ["treatment plans", /<TreatmentPlansCard[\s\S]*?readOnly=\{!canEditRecords\}/],
  ])("hands read-only to the %s", (_n, re) => expect(PAGE).toMatch(re));
  it("explains the lock in the edit copy, only when the chart is viewable", () => {
    expect(PAGE).toMatch(/canViewRecords && !canEditRecords && \(\s*<p\s+data-testid="chart-read-only-note"/);
    expect(PAGE).toContain("{EDIT_RECORDS_REFUSAL}");
  });
});

describe("components honour readOnly", () => {
  it("clinical notes: no Add note, Revise current or form", () => {
    expect(NOTES).toMatch(/openForm === null && !readOnly && \(/);
    expect(NOTES).toMatch(/openForm !== null && !readOnly && \(/);
  });
  it("plans: no New plan, Edit plan, Close plan, stage or notes editors", () => {
    expect(PLANS).toMatch(/readOnly \? null : adding \?/);
    expect(PLANS).toMatch(/onClose=\{readOnly \? null : \(\) => submitClose\(p\.id\)\}/);
    expect(PLANS).toContain("const frozen = isClosed || readOnly;");
    expect(PLANS).toMatch(/\{!frozen && !editing && \(/);
    expect(PLANS.match(/isClosed=\{frozen\}/g)).toHaveLength(2);
  });
  it("goal: progress stays, Edit/Reassess goes, and a read-only chart never opens the form", () => {
    expect(TIME).toContain("if (readOnly && !goal) return null;");
    expect(TIME).toMatch(/if \(!readOnly && \(editing \|\| \(!goal && !hasAny\)\)\)/);
    expect(TIME).toMatch(/\{!readOnly && \(\s*<button[\s\S]*?Reassess goal/);
  });
});

describe("goal action", () => {
  it("asks clin.edit_records after the client has resolved for this studio, and answers in the edit copy", () => {
    const resolved = GOAL_ACTION.indexOf('if (!client) return { ok: false, error: "Client not found." };');
    const gate = GOAL_ACTION.indexOf('"clin.edit_records"');
    const write = GOAL_ACTION.indexOf(".upsert(");
    expect(resolved).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(resolved);
    expect(write === -1 || gate < write).toBe(true);
    expect(GOAL_ACTION).toContain("error: EDIT_RECORDS_REFUSAL");
  });
});
