import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { copyPatchForMachine, copySourceMatchesMachine } from "@/lib/machines/pending-setup";

// Codex, #1369 4478497428 (P1) and 4478497436 (P2).
const native = { studio_machine_id: "m1" };
const legacy = { studio_machine_id: null };

describe("copy settings never crosses machine kinds", () => {
  it("native selected: a native source copies, a legacy source is refused", () => {
    expect(copySourceMatchesMachine("native", native)).toBe(true);
    expect(copySourceMatchesMachine("native", legacy)).toBe(false);
  });
  it("legacy selected: a legacy source copies, a native source is refused", () => {
    expect(copySourceMatchesMachine("legacy", legacy)).toBe(true);
    expect(copySourceMatchesMachine("legacy", native)).toBe(false);
  });
  it("no machine chosen yet takes either", () => {
    expect(copySourceMatchesMachine("none", native)).toBe(true);
    expect(copySourceMatchesMachine("none", legacy)).toBe(true);
  });
});

describe("copyPatchForMachine (behavioural: what the form would submit)", () => {
  const patch = { mode: "thermo", apilusModality: "blend", energyLevel: "5", machineFrequency: "13", probeKey: "p1", probeLotNumber: "L1", thermolysisIntensityPercent: "40", unitsOfLye: "2", pulseCount: "3", pulseDelay: "1", galvanicMa: "1", galvanicDurationSeconds: "9", thermolysisDurationSeconds: "2" };
  it("native: every legacy field is blank, the shared probe and lot survive", () => {
    const out = copyPatchForMachine("native", patch);
    expect(out).toMatchObject({ mode: "", apilusModality: "", energyLevel: "", machineFrequency: "", thermolysisIntensityPercent: "", unitsOfLye: "", galvanicMa: "", pulseCount: "1", probeKey: "p1", probeLotNumber: "L1" });
  });
  it("NEGATIVE CONTROL: legacy and none copy the whole patch", () => {
    expect(copyPatchForMachine("legacy", patch)).toEqual(patch);
    expect(copyPatchForMachine("none", patch)).toEqual(patch);
  });
});

const form = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx", "utf8");
const copyBody = form.slice(form.indexOf("function copySettings()"), form.indexOf("EVERY GATE THAT HOLDS THE SAVE"));
describe("the form's copy path", () => {
  it("refuses before touching the draft, and blanks hidden legacy fields under a native machine", () => {
    expect(copyBody).toContain("copySourceMatchesMachine(machineKind, b)");
    expect(copyBody.indexOf("copySourceMatchesMachine")).toBeLessThan(copyBody.indexOf("setDraft("));
    expect(copyBody).toContain("copyPatchForMachine(machineKind, patch)");
  });
  it("NEGATIVE CONTROL: the slice really is the copy function", () => {
    expect(copyBody).toContain("buildTreatmentSetupDraftPatch(source");
  });
});

describe("a valid client-last machine wins over an unavailable remembered preference", () => {
  const conn = readFileSync("components/machines/machine-first-setup-connected.tsx", "utf8");
  it("the unavailable-selection notice is dropped when client-last was applied", () => {
    expect(conn).toContain("unavailableSelection={newAreaLast ? null : ctx.rememberedUnavailable}");
  });
  // Codex 4478497436: the client-last machine is only applied on a NEW area with no hold, and it comes from the server-validated
  // `clientLastMachine`; with the notice rule above, an unavailable remembered preference cannot override it. Source pin, not a mounted proof.
  it("client-last applies only on a new area, from the validated clientLastMachine, and the first-pick order puts it ahead of the remembered one", () => {
    expect(conn).toContain("const newAreaLast = !hasSaved && !blockId && !hold ? (ctx.clientLastMachine ?? null) : null;");
  });
});
