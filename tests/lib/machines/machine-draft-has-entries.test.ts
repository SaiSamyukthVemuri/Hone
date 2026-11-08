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
  const read = (f: string) => readFileSync(f, "utf8");
  // Level, not edge (#1369): every unsaved-state term is a registry OWNER, and the host's dirty flag reads the derived `anyDraft`.
  it("counts the machine draft only through machineDraftHasEntries (in its registry owner), never on mere presence", () => {
    expect(dirty).toContain("draftRegistry.view.anyDraft");
    expect(dirty).not.toMatch(/machineDraft !== null/);
    const owner = read("components/machines/machine-setting-draft.tsx");
    expect(owner).toContain("setHasEntries(machineDraftHasEntries(payload))");
    expect(owner).toMatch(/useReportDraft\(\{ draft: hasEntries, unresolved: false \}\)/);
  });
  it("an EXPLICIT machine pick still counts (identityDirty is registered)", () => {
    expect(FORM).toMatch(/useReportDraft\(\{ draft: identityDirty, unresolved: false \}, draftRegistry\.api\)/);
  });
  // Codex 4476240831: an EXISTING area's reading draft must count as unsaved. Dropping the owner's registration would leave typed readings
  // unprotected by the leave guard; the mounted proof is tests/components/machine-draft-registry.test.ts.
  it("an existing area's reading draft counts (the reading entry registers hasDraft)", () => {
    expect(read("components/machines/machine-reading-entry.tsx")).toMatch(/useReportDraft\(\{ draft: hasDraft, unresolved: transportHold \}\)/);
    expect(FORM).not.toMatch(/\brevisionDraft\b/);
  });
  // Codex 4482278089: the automatic switch to a native machine clears prefilled legacy fields; the dirty BASELINE is rebased through the
  // same transform so an untouched form does not read "Unsaved". Source pin of the rebase.
  it("the dirty baseline is rebased through the same cleared() transform on the automatic kind switch", () => {
    expect(FORM).toMatch(/initialDraftJson\.current\s*=\s*JSON\.stringify\(cleared\(JSON\.parse\(initialDraftJson\.current\) as Draft\)\)/);
    expect(FORM).toMatch(/setDraftRef\.current\(cleared\);/);
  });
});
