import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #279 (Chloe real-charting feedback). The charting UI is not DOM-rendered in
// this suite (node env), so these are source/wiring pins that prove each fix is
// in place and persisted. Behavioral DB proof for the new columns is in
// tests/db/charting-numbing-probe-lot.db.test.ts.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const FORM = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
);
const ACTIONS = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
);
const RK = read("lib/record-keeping/queries.ts");

describe("item 1: numbing persistence", () => {
  it("the action validates + writes numbing_status", () => {
    expect(ACTIONS).toMatch(/numbingStatus/);
    expect(ACTIONS).toMatch(/numbing_status: numbing/);
    expect(ACTIONS).toMatch(/isNumbingStatus/);
  });
});

describe("item 3: probe-lot auto-populate + explicit confirm (Feature A)", () => {
  it("typing the lot un-confirms it + binds the value to the CURRENT probe", () => {
    expect(FORM).toMatch(/probeLotConfirmed: false/);
    // A typed lot belongs to the probe selected when it was typed: it survives
    // re-renders for that probe, and a probe switch drops it (a lot is
    // probe-specific — it must never follow the practitioner to another probe).
    expect(FORM).toMatch(/setLotOwnerProbeKey\(draft\.probeKey\);/);
    expect(FORM).not.toMatch(/lotEditedManually/);
    expect(FORM).toMatch(/update\("probeLotConfirmed", !draft\.probeLotConfirmed\)/);
  });
  it("the query is studio-scoped, same-probe, and excludes null/blank/deleted", () => {
    expect(RK).toMatch(/\.eq\("studio_id", studioId\)/);
    expect(RK).toMatch(/\.not\("probe_key", "is", null\)/);
    expect(RK).toMatch(/\.not\("probe_lot_number", "is", null\)/);
    expect(RK).toMatch(/\.is\("deleted_at", null\)/);
    // Prefer confirmed, then newest.
    expect(RK).toMatch(/\.order\("probe_lot_confirmed", \{ ascending: false \}\)/);
    expect(RK).toMatch(/\.order\("created_at", \{ ascending: false \}\)/);
  });
  it("the action only stores confirmed=true when a lot is present", () => {
    expect(ACTIONS).toMatch(/probe_lot_confirmed:\s*\n?\s*Boolean\(input\.probeLotConfirmed\)/);
  });
});

describe("item 5: OmniBlend reading layout", () => {
  it("switching to OmniBlend clears any typed thermolysis-duration (no hidden persisted reading)", () => {
    // Galvanic intensity is retired everywhere, so only thermolysis duration is
    // cleared on the OmniBlend switch (no galvanicIntensityPercent key remains).
    expect(FORM).toMatch(
      /next === "Omniblend"\s*\?\s*\{ thermolysisDurationSeconds: "" \}/,
    );
    expect(FORM).not.toMatch(/galvanicIntensityPercent: ""/);
  });
});

describe("item 6: tolerance is label-based, storage unchanged", () => {
  it("still stores the numeric tolerance_rating", () => {
    expect(FORM).toMatch(/toleranceRating: draft\.toleranceRating/);
  });
});
