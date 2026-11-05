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
  it("the host passes the flag, and a studio-default frequency does not count", () => {
    expect(form).toContain("holdAutoSelect={legacySettingsEntered(");
    expect(form).toMatch(/draft\.machineFrequency\.trim\(\) === \(defaultMachineFrequency\?\.trim\(\) \?\? ""\)/);
  });
  it("the connected panel drops client-last, remembered and restored selections while held (new area only)", () => {
    expect(conn).toContain("const hold = holdAutoSelect && !blockId;");
    expect(conn).toContain("!hasSaved && !blockId && !hold");
    expect(conn).toContain("const autoRemembered = hold ? null : (ctx.remembered ?? null);");
    expect(conn).toMatch(/: hold\s+\? null\s+: ctx\.restoredSelection/);
  });
  it("NEGATIVE CONTROL: an explicit pick is not held (the panel's own chooseDevice path is unchanged)", () => {
    expect(panel).toContain("const chooseDevice = async");
    expect(panel).not.toContain("holdAutoSelect");
  });
});

describe("a refused identity write puts the panel back on the stored machine", () => {
  it("every refusal of the area's own identity write is marked reverted", () => {
    expect(conn.match(/reverted: true/g)?.length).toBe(3);
  });
  it("the panel restores device, legacy flag and mode, keeps the reason, and does not settle the optimistic pick", () => {
    const i = panel.indexOf("write.reverted");
    const body = panel.slice(i, i + 500);
    expect(body).toContain("setLegacyChosen(before.legacy)");
    expect(body).toContain("setModeKey(before.modeKey)");
    expect(body).toContain("selected: before.deviceId");
    expect(body).toContain("return;");
  });
});
