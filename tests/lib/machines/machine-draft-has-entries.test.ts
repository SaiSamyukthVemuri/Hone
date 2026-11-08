import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { machineDraftHasEntries } from "@/lib/machines/pending-setup";

// Codex #1369 4477716790: opening the panel on an auto-suggested machine reports an empty draft. That is not
// something the practitioner entered, so it must not arm "Unsaved" or the leave prompt.
describe("machineDraftHasEntries", () => {
  it("no report at all is no draft", () => {
    expect(machineDraftHasEntries(null)).toBe(false);
  });
  it("THE OPEN-PANEL REPORT ({ groups: [], blocking: null }) is NOT a draft", () => {
    expect(machineDraftHasEntries({ groups: [], blocking: null })).toBe(false);
  });
  it("entered values are a draft", () => {
    expect(machineDraftHasEntries({ groups: [{}], blocking: null })).toBe(true);
  });
  it("a half-finished entry (a blocking reason) is a draft", () => {
    expect(machineDraftHasEntries({ groups: [], blocking: "Enter a value for Current." })).toBe(true);
  });
});

describe("the host form's dirty flag", () => {
  const FORM = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx", "utf8");
  const dirty = FORM.slice(FORM.indexOf("  const dirty ="), FORM.indexOf("  // THE LEAVE PROMPT"));
  it("counts the machine draft only through machineDraftHasEntries, never on mere presence", () => {
    expect(dirty).toContain("machineDraftHasEntries(machineDraft)");
    expect(dirty).not.toMatch(/machineDraft !== null/);
  });
  it("an EXPLICIT machine pick still counts (identityDirty is kept)", () => {
    expect(dirty).toContain("identityDirty");
  });
  // Codex 4476240831: an EXISTING area's reading draft must count as unsaved. Source pin (the form has no component harness): dropping
  // the `revisionDraft` term would leave typed readings unprotected by the leave guard with nothing else going red.
  it("an existing area's reading draft counts (revisionDraft is kept in the dirty flag)", () => {
    expect(dirty).toMatch(/\|\|\s*revisionDraft\s*\|\|/);
  });
  // Codex 4482278089: the automatic switch to a native machine clears prefilled legacy fields; the dirty BASELINE is rebased through the
  // same transform so an untouched form does not read "Unsaved". Source pin of the rebase.
  it("the dirty baseline is rebased through the same cleared() transform on the automatic kind switch", () => {
    expect(FORM).toMatch(/initialDraftJson\.current\s*=\s*JSON\.stringify\(cleared\(JSON\.parse\(initialDraftJson\.current\) as Draft\)\)/);
    expect(FORM).toMatch(/setDraftRef\.current\(cleared\);/);
  });
});
