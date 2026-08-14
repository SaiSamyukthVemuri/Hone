import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// 0156 conditional numbing notes: source guards for the charting form, server
// action, saved display, and copy-safety. Live behaviour is proven in
// e2e/conditional-numbing-notes.spec.ts and the DB/unit suites.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
const BASE = "app/(app)/clients/[id]/sessions/[sessionId]";
const FORM = read(`${BASE}/block-setup-form.tsx`);
const SIMPLE = read(`${BASE}/simplified-entry-form.tsx`);
const ACTIONS = read(`${BASE}/block-actions.ts`);
const VIEW = read(`${BASE}/session-blocks-view.tsx`);
const SNAPSHOT = read("lib/sessions/treatment-setup-snapshot.ts");

describe("charting UX: the notes field is conditional on 'used'", () => {
  it("the numbing-notes textarea renders ONLY when numbingStatus === 'used'", () => {
    expect(FORM).toMatch(
      /draft\.numbingStatus === "used" && \(\s*[\s\S]{0,400}data-testid="numbing-notes"/,
    );
  });
  it("has the required label + factual helper (no dosing/medical instruction)", () => {
    expect(FORM).toMatch(/Numbing notes \(optional\)/);
    expect(FORM).toMatch(/Record the product or any relevant details/);
    // No dosing/timing instruction copy.
    expect(FORM).not.toMatch(/\bdose|dosage|mg\b|apply for \d|minutes before/i);
  });
  it("is accessible: label wraps the field + helper connected via aria-describedby; multiline; resizable; full-width", () => {
    const region = FORM.slice(
      FORM.indexOf('data-testid="numbing-notes"') - 300,
      FORM.indexOf('data-testid="numbing-notes"') + 400,
    );
    expect(region).toMatch(/aria-describedby=\{numbingNotesHelpId\}/);
    expect(FORM).toMatch(/id=\{numbingNotesHelpId\}/);
    expect(region).toMatch(/rows=\{3\}/);
    expect(region).toMatch(/resize-y/);
    expect(region).toMatch(/w-full/);
    expect(region).not.toMatch(/maxLength/);
  });
  it("the draft holds numbingNotes across status toggles (only status changes on toggle)", () => {
    // The status toggle updates ONLY numbingStatus; numbingNotes is never cleared
    // by toggling, so toggling back to 'used' restores the typed draft.
    expect(FORM).toMatch(/onClick=\{\(\) => update\("numbingStatus", opt\.value\)\}/);
    expect(FORM).toMatch(/numbingNotes: string;/);
    expect(FORM).toMatch(/numbingNotes: block\.numbing_notes \?\? ""/); // edit seed
    expect(FORM).toMatch(/numbingNotes: draft\.numbingNotes/); // submit always sends it
  });
});

describe("server: notes kept only when used; status validated; no inference", () => {
  it("normalizeClinicalResponse uses the shared normalizeNumbingNotes helper", () => {
    expect(ACTIONS).toMatch(/normalizeNumbingNotes\(numbing, input\.numbingNotes\)/);
    expect(ACTIONS).toMatch(/numbing_notes: numbingNotes/);
  });
  it("invalid numbing status is still rejected server-side", () => {
    expect(ACTIONS).toMatch(/!isNumbingStatus\(numbing\)/);
    expect(ACTIONS).toMatch(/Pick a numbing option from the list\./);
  });
  it("numbing_notes flows through BOTH RPC write paths via responseCheck.columns", () => {
    // Both blockFields spread ...responseCheck.columns (which now carries
    // numbing_notes), so create + update both persist it. No separate write.
    expect((ACTIONS.match(/\.\.\.responseCheck\.columns,/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(ACTIONS).not.toMatch(/numbing_notes:\s*input\./); // never a raw client passthrough
  });
});

describe("read parity: shared presenter shows the note only when used + present", () => {
  it("session-blocks-view renders via numbingDisplay (label + optional note)", () => {
    expect(VIEW).toMatch(/numbingDisplay\(\s*block\.numbing_status,\s*block\.numbing_notes/);
    expect(VIEW).toMatch(/Numbing notes: \{numbing\.note\}/);
    expect(VIEW).toMatch(/whitespace-pre-wrap/); // multiline preserved on display
  });
});

describe("copy-safety + scope containment", () => {
  it("the treatment-setup snapshot (Copy settings source) excludes numbing entirely", () => {
    // numbing is not a reusable SETUP field; the snapshot must never carry
    // numbing_status or numbing_notes.
    expect(SNAPSHOT).not.toMatch(/numbing_notes/);
    expect(SNAPSHOT).not.toMatch(/numbingNotes/);
    // Draft-patch type carries no numbing field.
    const patchType = SNAPSHOT.slice(
      SNAPSHOT.indexOf("TreatmentSetupDraftPatch = {"),
      SNAPSHOT.indexOf("};", SNAPSHOT.indexOf("TreatmentSetupDraftPatch = {")),
    );
    expect(patchType).not.toMatch(/numbing/i);
  });
  it("SimplifiedEntryForm has NO numbing surface (numbing is block-level only)", () => {
    expect(SIMPLE).not.toMatch(/numbing/i);
  });
  it("numbing_notes is never referenced by any client-facing surface (public/portal/intake/cancel/reschedule/email/api)", () => {
    // Real containment: no booking/portal/intake/cancel/reschedule/email/api
    // file may read or write the field. (`|| true` so grep's no-match exit code
    // doesn't throw.)
    const out = execSync(
      'grep -rlE "numbing_notes|numbingNotes" app/book app/portal app/intake app/cancel app/reschedule lib/email app/api 2>/dev/null || true',
      { cwd: process.cwd() },
    )
      .toString()
      .trim();
    expect(out).toBe("");
  });
});
