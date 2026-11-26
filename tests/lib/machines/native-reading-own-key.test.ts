import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A native reading is shown by ITS OWN capture key (the unit, model and mode stored on the reading row), never by the block's current identity,
// and a new block's draft starts with no mode, modality or energy level (only the practitioner's sticky frequency and the area are seeded).

const queries = readFileSync("lib/machines/machine-queries.ts", "utf8");
const form = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx", "utf8");

describe("D1: a reading carries its own identity", () => {
  it("the reading mapper takes unit, model, version and mode from the reading row", () => {
    const m = queries.slice(queries.indexOf("function toReading(r: ReadingRow)"), queries.indexOf("nativeUnit: r.native_unit"));
    expect(m).toMatch(/deviceId: r\.studio_machine_id/);
    expect(m).toMatch(/profileId: r\.machine_profile_id/);
    expect(m).toMatch(/profileVersion: r\.machine_profile_version/);
    expect(m).toMatch(/modeKey: r\.mode_key/);
    expect(m).not.toMatch(/machine_mode_key|block\.machine_profile_id|block\.studio_machine_id/);
  });
});

describe("D2: mode, modality and energy level are NOT pre-filled", () => {
  it("the empty draft has blank mode, modality and energy level", () => {
    const empty = form.slice(form.indexOf("const EMPTY: Draft = {"), form.indexOf("function initialDraft("));
    expect(empty).toMatch(/mode: "",/);
    expect(empty).toMatch(/apilusModality: "",/);
    expect(empty).toMatch(/energyLevel: "",/);
  });
  it("a new block's draft overrides only the area and the sticky frequency", () => {
    const start = form.indexOf("function initialDraft(");
    const create = form.slice(form.indexOf("if (!block) {", start), form.indexOf("// Migration 0108", start));
    const overrides = [...create.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).sort();
    expect(overrides).toEqual(["areas", "machineFrequency", "primaryArea"]);
  });
});
