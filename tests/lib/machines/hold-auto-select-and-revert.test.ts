import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { legacySettingsEntered } from "@/lib/machines/pending-setup";

// Codex, #1369 4479490063 (auto-resolution must not erase entered legacy values) and 4479490071 (a refused clear must not stick).
const blank = { mode: "", apilusModality: "", energyLevel: "", machineFrequency: "", thermolysisIntensityPercent: "", thermolysisDurationSeconds: "", galvanicMa: "", galvanicDurationSeconds: "", unitsOfLye: "" };

describe("legacySettingsEntered", () => {
  it("an untouched draft holds nothing, so the machine may be auto-selected", () => {
    expect(legacySettingsEntered(blank)).toBe(false);
    expect(legacySettingsEntered({ ...blank, energyLevel: "  " })).toBe(false);
  });
  it("every legacy field the native pick would clear counts when typed", () => {
    for (const k of Object.keys(blank)) {
      expect(legacySettingsEntered({ ...blank, [k]: "3" }), k).toBe(true);
    }
  });
});

const conn = readFileSync("components/machines/machine-first-setup-connected.tsx", "utf8");
const panel = readFileSync("components/machines/machine-first-setup-panel.tsx", "utf8");
const form = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx", "utf8");

describe("auto-resolution is held while legacy values are entered", () => {
  it("the host passes the flag through autoSelectHeld, which counts a PERSISTED frequency but not a prefilled default", () => {
    expect(form).toContain("holdAutoSelect={autoSelectHeld(draft, defaultMachineFrequency, block?.machine_frequency)}");
    expect(form).not.toContain("holdAutoSelect={legacySettingsEntered(");
  });
  it("the connected panel drops client-last, remembered and restored selections and the retired note while held, on EVERY area", () => {
    expect(conn).toContain("const hold = holdAutoSelect;");
    expect(conn).not.toContain("holdAutoSelect && !blockId");
    expect(conn).toContain("!hasSaved && !blockId && !hold");
    expect(conn).toContain("const autoRemembered = hold ? null : (ctx.remembered ?? null);");
    expect(conn).toMatch(/: hasSaved \|\| hold\s+\? null\s+: ctx\.restoredSelection/);
    expect(conn).toContain("unavailableSelection={newAreaLast || hold ||");
  });
  it("TRIPWIRE: the ctx fields that carry a device id are a CLOSED list, and each automatic one is read once, through the predicate", async () => {
    const { readFileSync } = await import("node:fs");
    const type = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts", "utf8");
    const body = type.slice(type.indexOf("export type MachineSetupContext = {"));
    const decl = body.slice(0, body.indexOf("\n};"));
    // The context is a CLOSED list. Named types hide which fields carry a device id, so every field is classified here by hand:
    // AUTOMATIC sources are gated by the predicate, SUGGESTED is a button, the rest carry no unit choice.
    const fields = [...decl.matchAll(/^  (\w+)\??:/gm)].map((m) => m[1]).sort();
    expect(fields, "a new ctx field must be classified (automatic / button-only / no unit) before it is added").toEqual(
      [
        // automatic: gated by `hold`
        "clientLastMachine", "remembered", "rememberedUnavailable", "restoredSelection",
        // button-only
        "suggestedMachine",
        // no unit choice
        "canManageMachines", "catalogue", "devices", "inventoryReason", "legacyMachine", "persistence", "priorSetup",
        "priorSetupUnavailable", "recordedSetup", "recordedSetupUnavailable", "scope", "unitNames",
      ].sort(),
    );
    for (const f of ["clientLastMachine", "remembered", "rememberedUnavailable", "restoredSelection"]) {
      expect((conn.match(new RegExp(`ctx\\.${f}\\b`, "g")) ?? []).length, `ctx.${f} is read exactly once`).toBe(1);
    }
    expect(conn.match(/ctx\.suggestedMachine\b/g)?.length, "suggested is offered, never selected: the panel renders a button").toBe(1);
  });
  it("autoSelectHeld: entered work holds; a prefilled default does not; a PERSISTED frequency always does", async () => {
    const { autoSelectHeld } = await import("@/lib/machines/pending-setup");
    const empty = { mode: "", apilusModality: "", energyLevel: "", machineFrequency: "", thermolysisIntensityPercent: "", thermolysisDurationSeconds: "", galvanicMa: "", galvanicDurationSeconds: "", unitsOfLye: "" };
    expect(autoSelectHeld(empty, "13.56 MHz", null)).toBe(false);
    expect(autoSelectHeld({ ...empty, machineFrequency: "13.56 MHz" }, "13.56 MHz", null), "prefilled default, not persisted").toBe(false);
    expect(autoSelectHeld({ ...empty, machineFrequency: "13.56 MHz" }, "13.56 MHz", "13.56 MHz"), "persisted, equal to the default").toBe(true);
    expect(autoSelectHeld({ ...empty, machineFrequency: "27.12 MHz" }, "13.56 MHz", null), "typed, different from the default").toBe(true);
    expect(autoSelectHeld({ ...empty, galvanicMa: "5" }, null, null)).toBe(true);
  });
  it("NEGATIVE CONTROL: an explicit pick is not held (the panel's own chooseDevice path is unchanged)", () => {
    expect(panel).toContain("const chooseDevice = async");
    expect(panel).not.toContain("holdAutoSelect");
  });
});

describe("a refused identity write puts the panel back on the stored machine", () => {
  it("every refusal of the area's own identity write is marked reverted", () => {
    // The clear refusal (twice), the legacy-readings refusal (#1369 4471593271), the record's own refusal, and a pick whose EARLIER
    // unconfirmed write could not be settled first (0301 receipts, Codex 4488743493). Three call sites now share `revertedTo`, which also
    // hands the panel a machine this call already adopted (Codex 4493827101), so there is ONE place that builds a refusal after a write.
    expect(conn.match(/reverted: true/g)?.length).toBe(4);
    expect(conn.match(/revertedTo\(/g)?.length).toBe(3);
  });
  it("the panel keeps the reason, restores what an optimistic (new-area) pick moved, and never settles a refused pick", () => {
    const i = panel.indexOf("write.reverted");
    const body = panel.slice(i, i + 1100);
    expect(body).toContain("if (!writeFirst)");
    expect(body).toContain("setLegacyChosen(before.legacy)");
    expect(body).toContain("setModeKey(before.modeKey)");
    expect(body).toContain("write.fallback ? write.fallback.deviceId : before.deviceId");
    expect(body).toContain("return;");
  });
  it("Codex 4480035425: a saved area's pick is written first and applied after, so nothing a refusal could undo is unmounted", () => {
    const at = panel.indexOf("const chooseDevice = async");
    const fn = panel.slice(at, panel.indexOf("const chooseMode = async"));
    expect(fn).toContain("const writeFirst = Boolean(blockId && onSelectMachine);");
    expect(fn.indexOf("if (!writeFirst) {")).toBeLessThan(fn.indexOf("await onSelectMachine"));
    // The optimistic moves sit only inside the new-area branch, before the await.
    const pre = fn.slice(0, fn.indexOf("await onSelectMachine"));
    expect(pre.match(/setLegacyChosen\(legacy\)/g)?.length).toBe(1);
    expect(pre.match(/setModeKey\(nextMode\)/g)?.length).toBe(1);
  });
});

describe("Insurance K-1: a refusal on a saved area clears nothing and restores nothing", () => {
  it("there is no restore path left: no kept snapshot, no revert callback, no write outcome plumbing", () => {
    for (const src of [form, conn, panel]) {
      expect(src).not.toContain("clearedLegacyRef");
      expect(src).not.toContain("onPickReverted");
      expect(src).not.toContain("takeLegacyFields");
    }
    expect(conn).not.toMatch(/outcome: "ok" \| "refused"/);
  });
  it("NEGATIVE CONTROL: the clearing branch is still the explicit-pick path (a native pick on a NEW area clears)", () => {
    expect(form).toContain("Switching never mixes settings: the overlapping legacy fields are");
  });
});
