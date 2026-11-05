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
});
