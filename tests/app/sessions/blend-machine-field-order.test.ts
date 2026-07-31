import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MACHINE_READING_ORDER,
  READING_FIELD_LABELS,
  readingFieldOrder,
  type ReadingField,
} from "@/lib/sessions/reading-field-order";

// Chloe reads values off the Apilus screen top-to-bottom. Every charting
// surface had drifted into its own order, forcing her to hunt for the next
// field instead of reading straight down. These pins assert every ACTIVE
// surface against the one canonical contract.
//
// The DOM/tab-order proof is in e2e/blend-machine-order-mobile.spec.ts — these
// are source pins (vitest runs in "node": no DOM here).

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");
const SIMPLE = read("app/(app)/clients/[id]/sessions/[sessionId]/simplified-entry-form.tsx");
const CARD = read("components/copy-draft-card.tsx");
const ROW = read("components/entry-row.tsx");

// Index of each field's rendered label within a source file, in source order.
function positions(src: string, fields: readonly ReadingField[], labels: Record<string, string>) {
  return fields.map((f) => {
    const needle = labels[f];
    const at = src.indexOf(needle);
    expect(at, `"${needle}" not found`).toBeGreaterThan(-1);
    return { field: f, at };
  });
}

function expectAscending(found: Array<{ field: string; at: number }>) {
  const order = found.map((f) => f.field);
  const sorted = [...found].sort((a, b) => a.at - b.at).map((f) => f.field);
  expect(sorted).toEqual(order);
}

describe("the canonical contract itself", () => {
  it("is the machine order Chloe asked for", () => {
    expect([...MACHINE_READING_ORDER]).toEqual([
      "energyLevel",
      "unitsOfLye",
      "galvanicDurationSeconds",
      "galvanicMa",
      "thermolysisDurationSeconds",
      "thermolysisIntensityPercent",
      "pulseCount",
      "pulseDelay",
    ]);
  });

  it("EL and UL are adjacent at the top, and the whole galvanic group precedes thermolysis", () => {
    const o = MACHINE_READING_ORDER;
    expect(o.indexOf("unitsOfLye")).toBe(o.indexOf("energyLevel") + 1);
    // Galvanic group = UL, duration, mA — contiguous, and all before thermolysis.
    expect(o.indexOf("galvanicMa")).toBeLessThan(o.indexOf("thermolysisDurationSeconds"));
    expect(o.indexOf("galvanicDurationSeconds")).toBeLessThan(o.indexOf("galvanicMa"));
    expect(o.indexOf("thermolysisDurationSeconds")).toBeLessThan(
      o.indexOf("thermolysisIntensityPercent"),
    );
    expect(o.indexOf("thermolysisIntensityPercent")).toBeLessThan(o.indexOf("pulseCount"));
    expect(o.indexOf("pulseCount")).toBeLessThan(o.indexOf("pulseDelay"));
  });

  it("pure galvanic: units of lye → duration → mA, and NO thermolysis or energy level", () => {
    expect(readingFieldOrder("galv")).toEqual([
      "unitsOfLye",
      "galvanicDurationSeconds",
      "galvanicMa",
    ]);
  });

  it("pure thermolysis: EL → duration → intensity → pulse controls, and NO units of lye or galvanic", () => {
    expect(readingFieldOrder("thermo")).toEqual([
      "energyLevel",
      "thermolysisDurationSeconds",
      "thermolysisIntensityPercent",
      "pulseCount",
      "pulseDelay",
    ]);
  });

  it("blend shows everything, in machine order", () => {
    expect(readingFieldOrder("blend")).toEqual([...MACHINE_READING_ORDER]);
  });

  it("OmniBlend drops only thermolysis duration (that machine has none)", () => {
    const o = readingFieldOrder("blend", { omniblend: true });
    expect(o).not.toContain("thermolysisDurationSeconds");
    expect(o).toEqual([
      "energyLevel",
      "unitsOfLye",
      "galvanicDurationSeconds",
      "galvanicMa",
      "thermolysisIntensityPercent",
      "pulseCount",
      "pulseDelay",
    ]);
  });

  it("owns ordering ONLY — no validation, ranges, storage or mode mutation", () => {
    const SRC = read("lib/sessions/reading-field-order.ts");
    for (const forbidden of ["min=", "max=", "parseFloat", "Number(", "supabase", "insert", "update"]) {
      expect(SRC).not.toContain(forbidden);
    }
  });
});

describe("ACTIVE surface: the one-page charting form (new chart + edit chart)", () => {
  // The two sections are built as consts and rendered later, so RENDER order is
  // what the practitioner sees — assert the render site, not the definitions.
  it("renders energy level, then the galvanic group, then thermolysis", () => {
    const energyAt = FORM.indexOf(READING_FIELD_LABELS.energyLevel);
    const renderAt = FORM.indexOf("{galvSection}\n        {thermoSection}");
    expect(energyAt).toBeGreaterThan(-1);
    expect(renderAt).toBeGreaterThan(energyAt);
    // No surviving branch that puts thermolysis first.
    expect(FORM).not.toMatch(/\{thermoSection\}\s*\n\s*\{galvSection\}/);
  });

  it("galvanic group is units of lye → duration → mA", () => {
    const start = FORM.indexOf("const galvSection =");
    const block = FORM.slice(start, FORM.indexOf(") : null;", start));
    expectAscending(
      positions(block, ["unitsOfLye", "galvanicDurationSeconds", "galvanicMa"], READING_FIELD_LABELS),
    );
  });

  it("thermolysis group is duration → intensity → pulse count → pulse delay", () => {
    const start = FORM.indexOf("const thermoSection =");
    const block = FORM.slice(start, FORM.indexOf("const galvSection ="));
    expectAscending(
      positions(
        block,
        ["thermolysisDurationSeconds", "thermolysisIntensityPercent", "pulseCount", "pulseDelay"],
        READING_FIELD_LABELS,
      ),
    );
  });

  it("keeps the retired galvanic intensity input absent and the precisions unchanged", () => {
    expect(FORM).not.toMatch(/<span[^>]*>Galvanic intensity %<\/span>/);
    expect(FORM).not.toMatch(/galvanicIntensityPercent/);
    // PicoBlend 3-decimal thermolysis duration and 2-decimal galvanic mA.
    expect(FORM).toMatch(/step="0\.001"[\s\S]{0,200}draft\.thermolysisDurationSeconds/);
    expect(FORM).toMatch(/step="0\.01"[\s\S]{0,200}draft\.galvanicMa/);
    expect(FORM).toMatch(/step="0\.1"[\s\S]{0,200}draft\.unitsOfLye/);
  });
});

describe("ACTIVE surface: Add another pass (SimplifiedEntryForm)", () => {
  it("renders the galvanic group before thermolysis", () => {
    const galv = SIMPLE.indexOf('block.mode === "galv" || block.mode === "blend"');
    const thermo = SIMPLE.indexOf('block.mode === "thermo" || block.mode === "blend"');
    expect(galv).toBeGreaterThan(-1);
    expect(galv).toBeLessThan(thermo);
  });

  it("matches the canonical order end to end", () => {
    // This form has no energy level (it inherits the block's), so drop it.
    const expected = readingFieldOrder("blend").filter((f) => f !== "energyLevel");
    expectAscending(positions(SIMPLE, expected, READING_FIELD_LABELS));
  });

  it("keeps its precisions", () => {
    expect(SIMPLE).toMatch(/step="0\.001"[\s\S]{0,200}draft\.thermolysisDurationSeconds/);
    expect(SIMPLE).toMatch(/step="0\.01"[\s\S]{0,200}draft\.galvanicMa/);
    expect(SIMPLE).not.toMatch(/galvanicIntensityPercent/);
  });
});

describe("ACTIVE surface: whole-session copy preview/editor (CopyDraftCard)", () => {
  it("matches the canonical order end to end, by testid", () => {
    const ids: Array<[ReadingField, string]> = [
      ["energyLevel", "-energy`"],
      ["unitsOfLye", "-units-lye`"],
      ["galvanicDurationSeconds", "-galv-duration`"],
      ["galvanicMa", "-galv-ma`"],
      ["thermolysisDurationSeconds", "-therm-duration`"],
      ["thermolysisIntensityPercent", "-therm-intensity`"],
      ["pulseCount", "-pulse-count`"],
      ["pulseDelay", "-pulse-delay`"],
    ];
    const found = ids.map(([field, id]) => {
      const at = CARD.indexOf(id);
      expect(at, `${id} not found`).toBeGreaterThan(-1);
      return { field, at };
    });
    expectAscending(found);
  });

  it("still hides thermolysis duration for OmniBlend and never shows galvanic intensity", () => {
    expect(CARD).toMatch(/const isOmniblend = s\.apilusModality === "Omniblend"/);
    expect(CARD).toMatch(/\{!isOmniblend && \(/);
    expect(CARD).not.toMatch(/galvanicIntensityPercent/);
    expect(CARD).toMatch(/step="0\.001"[\s\S]{0,200}thermolysisDurationSeconds/);
  });
});

describe("ACTIVE surface: saved record display (ElectrolysisEntryRow)", () => {
  it("reads back in the order it was entered", () => {
    const galvStart = ROW.indexOf("const galvanicParts");
    const galvBlock = ROW.slice(galvStart, ROW.indexOf("const isThermoish"));
    expectAscending([
      { field: "unitsOfLye", at: galvBlock.indexOf("units_of_lye") },
      { field: "galvanicDurationSeconds", at: galvBlock.indexOf("galvanic_duration_seconds") },
      { field: "galvanicMa", at: galvBlock.indexOf("galvanic_ma") },
    ]);
    const thermoStart = ROW.indexOf("const thermoParts");
    const thermoBlock = ROW.slice(thermoStart, ROW.indexOf("const hasStructured"));
    expectAscending([
      { field: "duration", at: thermoBlock.indexOf("thermolysis_duration_seconds") },
      { field: "intensity", at: thermoBlock.indexOf("thermolysis_intensity_percent") },
      { field: "pulse", at: thermoBlock.indexOf("pulse_count") },
    ]);
  });

  it("still routes duration through formatSeconds (exact 3dp display preserved)", () => {
    expect(ROW).toMatch(/formatSeconds\(entry\.thermolysis_duration_seconds\)/);
    expect(ROW).not.toMatch(/galvanic_intensity_percent.*push/);
  });
});

describe("LEGACY, UNREACHABLE: LogElectrolysisEntryForm is not updated", () => {
  it("has no importer anywhere in app/, components/ or lib/ — it is dead code", () => {
    // Deliberately NOT reordered. Editing an unreachable form to satisfy a grep
    // would imply it ships; it does not. This test IS the proof of that claim,
    // and will fail the moment someone mounts it, forcing the order question.
    const roots = ["app", "components", "lib"];
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync(
      `grep -rl "log-electrolysis-entry-form\\|LogElectrolysisEntryForm" ${roots.join(" ")} || true`,
      { cwd: process.cwd(), encoding: "utf8" },
    )
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      // The file defining the component is not an importer of it.
      .filter((f) => f !== "components/log-electrolysis-entry-form.tsx");
    expect(out).toEqual([]);
  });
});
