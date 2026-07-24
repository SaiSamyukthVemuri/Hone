import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  validateTreatmentArea,
  isCanonicalTreatmentArea,
} from "@/lib/sessions/area-validation";
import { AREAS } from "@/lib/constants";

// Charting Validation PR 2: server-side canonical-or-explicit-custom treatment
// area validation against the FLAT AREAS list (incl. "Full face" + "Other"),
// never AREA_REGIONS alone. Legacy rows are never validated on read.

describe("validateTreatmentArea — canonical / Full face / Other / custom", () => {
  it("accepts a canonical area", () => {
    const r = validateTreatmentArea("Chin", false);
    expect(r).toEqual({ ok: true, value: "Chin", custom: false });
  });
  it("accepts 'Full face' (in flat AREAS, decomposed out of AREA_REGIONS)", () => {
    expect(isCanonicalTreatmentArea("Full face")).toBe(true);
    const r = validateTreatmentArea("Full face", false);
    expect(r.ok && r.value).toBe("Full face");
  });
  it("normalizes canonical CASING (chin -> Chin); never mutates custom text", () => {
    const r = validateTreatmentArea("chin", false);
    expect(r).toEqual({ ok: true, value: "Chin", custom: false });
  });
  it("REJECTS arbitrary non-canonical text without explicit custom intent", () => {
    const r = validateTreatmentArea("Left brow arch", false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/isn.t recognized|Other/i);
  });
  it("ACCEPTS non-canonical text WITH explicit custom intent, stored verbatim", () => {
    const r = validateTreatmentArea("Left brow arch", true);
    expect(r).toEqual({ ok: true, value: "Left brow arch", custom: true });
  });
  it("empty -> null (allowed; empty area is soft-gated by the UI, not here)", () => {
    expect(validateTreatmentArea("", false)).toEqual({
      ok: true,
      value: null,
      custom: false,
    });
    expect(validateTreatmentArea(null, false)).toEqual({
      ok: true,
      value: null,
      custom: false,
    });
  });
  it("rejects over-length even with custom intent", () => {
    const r = validateTreatmentArea("x".repeat(61), true, 60);
    expect(r.ok).toBe(false);
  });
  it("every flat AREAS entry validates canonically (incl. Other)", () => {
    for (const a of AREAS) {
      expect(isCanonicalTreatmentArea(a)).toBe(true);
      const r = validateTreatmentArea(a, false);
      expect(r.ok).toBe(true);
    }
  });
});

describe("write paths use the shared validator (source pins)", () => {
  function read(rel: string): string {
    return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
  }
  const BLOCK = read("app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts");
  const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");
  const PICKER = read("components/area-picker.tsx");

  it("normalizeStructuredArea validates canonical-or-explicit-custom", () => {
    expect(BLOCK).toMatch(/validateTreatmentArea\(\s*input\.primaryArea,\s*input\.areaIsCustom/);
  });
  it("all four block write paths carry areaIsCustom into the normalizer", () => {
    // create block, create/update treatment-area (input.*), update block (patch.*)
    expect((BLOCK.match(/areaIsCustom: input\.areaIsCustom \?\? false/g) ?? []).length)
      .toBeGreaterThanOrEqual(4);
  });
  it("copyPreviousSessionAreasAction is contained: it validates/copies no area (zero writes)", () => {
    // The whole-session copy is temporarily paused; it no longer maps or
    // validates any source area — it returns a fixed unavailable result.
    const copyBlock = BLOCK.slice(
      BLOCK.indexOf("copyPreviousSessionAreasAction"),
      BLOCK.indexOf("softDeleteSessionBlockAction"),
    );
    expect(copyBlock).toMatch(/temporarily unavailable/);
    expect(copyBlock).not.toMatch(/copiedPrimaryArea/);
    expect(copyBlock).not.toMatch(/const areaCheck = validateTreatmentArea/);
  });
  it("the client form derives explicit custom intent from the canonical check", () => {
    expect(FORM).toMatch(/const areaIsCustom =\s*\n?\s*trimmedArea\.length > 0 && !isCanonicalTreatmentArea\(trimmedArea\)/);
    expect((FORM.match(/areaIsCustom,/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("the picker canonical check uses flat AREAS (fixes the Full face trap)", () => {
    expect(PICKER).toMatch(/isCanonicalTreatmentArea/);
    // no longer keys canonicality off AREA_REGIONS.areas alone
    expect(PICKER).not.toMatch(/for \(const group of AREA_REGIONS\)\s*\{\s*if \(group\.areas\.includes/);
  });
});
