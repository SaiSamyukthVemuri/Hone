import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  normalizeProbeLabel,
  resolveProbeLotSuggestion,
  type ProbeLotSuggestions,
} from "@/lib/record-keeping/probe-lot-suggestion";
import { PROBE_OPTIONS } from "@/lib/probes";

// Pure behavioral tests for the charting auto-fill resolution (no DB / no DOM).
// The DB query semantics (byKey/byLabel, confirmed-preferred, studio isolation)
// are proven in tests/db/probe-lot-suggestion.db.test.ts; these prove the
// keyed-then-label RESOLUTION the form uses.

// A real catalog probe so the label fallback exercises a real displayLabel.
const probe = PROBE_OPTIONS[0];

function suggestions(over: Partial<ProbeLotSuggestions> = {}): ProbeLotSuggestions {
  return { byKey: {}, byLabel: {}, ...over };
}

describe("normalizeProbeLabel", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    expect(normalizeProbeLabel("  Sterex ·  Gold ·  F2  Short ")).toBe(
      "sterex · gold · f2 short",
    );
    expect(normalizeProbeLabel(null)).toBe("");
    expect(normalizeProbeLabel(undefined)).toBe("");
  });
});

describe("resolveProbeLotSuggestion", () => {
  it("keyed match wins", () => {
    const s = suggestions({ byKey: { [probe.key]: { lot: "KEYLOT", confirmed: true } } });
    expect(resolveProbeLotSuggestion(probe.key, s)).toEqual({ lot: "KEYLOT", confirmed: true });
  });

  it("keyed match BEATS a label fallback", () => {
    const s = suggestions({
      byKey: { [probe.key]: { lot: "KEYLOT", confirmed: false } },
      byLabel: { [normalizeProbeLabel(probe.displayLabel)]: { lot: "LABELLOT", confirmed: true } },
    });
    expect(resolveProbeLotSuggestion(probe.key, s)?.lot).toBe("KEYLOT");
  });

  it("falls back to the normalized-label match when there is no keyed match", () => {
    const s = suggestions({
      byLabel: { [normalizeProbeLabel(probe.displayLabel)]: { lot: "LABELLOT", confirmed: false } },
    });
    expect(resolveProbeLotSuggestion(probe.key, s)).toEqual({ lot: "LABELLOT", confirmed: false });
  });

  it("returns null for an empty probe key or when nothing matches", () => {
    expect(resolveProbeLotSuggestion("", suggestions({ byKey: { x: { lot: "L", confirmed: true } } }))).toBeNull();
    expect(resolveProbeLotSuggestion(probe.key, suggestions())).toBeNull();
  });

  it("preserves the confirmed flag through both paths (drives the helper copy)", () => {
    expect(
      resolveProbeLotSuggestion(probe.key, suggestions({ byKey: { [probe.key]: { lot: "L", confirmed: true } } }))?.confirmed,
    ).toBe(true);
    expect(
      resolveProbeLotSuggestion(
        probe.key,
        suggestions({ byLabel: { [normalizeProbeLabel(probe.displayLabel)]: { lot: "L", confirmed: false } } }),
      )?.confirmed,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source pins for the pieces that CANNOT be DOM-tested in this repo (vitest
// environment is "node" — no jsdom/RTL). Reported explicitly as a limitation:
// these pin the wiring, NOT the rendered React behavior.
// ---------------------------------------------------------------------------
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

describe("form wiring (source pins — NOT a DOM behavior test)", () => {
  const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");

  it("auto-fill effect uses the resolved keyed-then-label suggestion, gated by lotEditedManually", () => {
    expect(FORM).toMatch(/resolveProbeLotSuggestion\(draft\.probeKey, probeLotSuggestions\)/);
    expect(FORM).toMatch(/if \(lotEditedManually\) return;/);
    expect(FORM).toMatch(/const suggestion = activeSuggestion\?\.lot \?\? "";/);
    // Never auto-confirms.
    expect(FORM).toMatch(/probeLotConfirmed: false/);
  });

  it("typed values are protected (manual edit sets lotEditedManually)", () => {
    expect(FORM).toMatch(/setLotEditedManually\(value\.trim\(\) !== ""\)/);
  });

  it("helper copy reflects confirmed vs unconfirmed source", () => {
    expect(FORM).toMatch(/Auto-filled from last confirmed probe lot/);
    expect(FORM).toMatch(/Suggested from last probe lot/);
  });
});

describe("confirm control persists probe_lot_confirmed (source pins)", () => {
  const ACTIONS = read("app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts");
  it("create + update actions persist probe_lot_confirmed (only when a lot is present)", () => {
    const matches = ACTIONS.match(
      /probe_lot_confirmed:\s*\n?\s*Boolean\(input\.probeLotConfirmed\) &&\s*\n?\s*\(input\.probeLotNumber \?\? ""\)\.trim\(\) !== ""/g,
    );
    expect(matches?.length).toBeGreaterThanOrEqual(2); // create + update
  });
  it("copyPreviousSessionAreasAction carries probe_key forward but NOT the lot (auto-fill owns the lot)", () => {
    expect(ACTIONS).toMatch(/probe_key: b\.probe_key/);
    // The copied-rows insert never copies probe_lot_number / probe_lot_confirmed.
    const copyBlock = ACTIONS.slice(
      ACTIONS.indexOf("copyPreviousSessionAreasAction"),
      ACTIONS.indexOf("softDeleteSessionBlockAction"),
    );
    expect(copyBlock).not.toMatch(/probe_lot_number/);
    expect(copyBlock).not.toMatch(/probe_lot_confirmed/);
  });
});
