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
    const s = suggestions({ byKey: { [probe.key]: { lot: "KEYLOT", confirmed: true, inventoryItemId: null, lastConfirmedInventoryItemId: null, lastCharted: "" } } });
    expect(resolveProbeLotSuggestion(probe.key, s)).toEqual({ lot: "KEYLOT", confirmed: true, inventoryItemId: null, lastConfirmedInventoryItemId: null, lastCharted: "" });
  });

  it("keyed match BEATS a label fallback", () => {
    const s = suggestions({
      byKey: { [probe.key]: { lot: "KEYLOT", confirmed: false, inventoryItemId: null, lastConfirmedInventoryItemId: null, lastCharted: "" } },
      byLabel: { [normalizeProbeLabel(probe.displayLabel)]: { lot: "LABELLOT", confirmed: true, inventoryItemId: null, lastConfirmedInventoryItemId: null, lastCharted: "" } },
    });
    expect(resolveProbeLotSuggestion(probe.key, s)?.lot).toBe("KEYLOT");
  });

  it("falls back to the normalized-label match when there is no keyed match", () => {
    const s = suggestions({
      byLabel: { [normalizeProbeLabel(probe.displayLabel)]: { lot: "LABELLOT", confirmed: false, inventoryItemId: null, lastConfirmedInventoryItemId: null, lastCharted: "" } },
    });
    expect(resolveProbeLotSuggestion(probe.key, s)).toEqual({ lot: "LABELLOT", confirmed: false, inventoryItemId: null, lastConfirmedInventoryItemId: null, lastCharted: "" });
  });

  it("returns null for an empty probe key or when nothing matches", () => {
    expect(resolveProbeLotSuggestion("", suggestions({ byKey: { x: { lot: "L", confirmed: true, inventoryItemId: null, lastConfirmedInventoryItemId: null, lastCharted: "" } } }))).toBeNull();
    expect(resolveProbeLotSuggestion(probe.key, suggestions())).toBeNull();
  });

  it("preserves the confirmed flag through both paths (drives the helper copy)", () => {
    expect(
      resolveProbeLotSuggestion(probe.key, suggestions({ byKey: { [probe.key]: { lot: "L", confirmed: true, inventoryItemId: null, lastConfirmedInventoryItemId: null, lastCharted: "" } } }))?.confirmed,
    ).toBe(true);
    expect(
      resolveProbeLotSuggestion(
        probe.key,
        suggestions({ byLabel: { [normalizeProbeLabel(probe.displayLabel)]: { lot: "L", confirmed: false, inventoryItemId: null, lastConfirmedInventoryItemId: null, lastCharted: "" } } }),
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

  it("auto-fill goes through the ONE composed resolver, gated by lotEditedManually, never auto-confirms", () => {
    // The form no longer calls resolveInventoryAutofill directly: inventory AND
    // recorded-history precedence now live together in
    // lib/record-keeping/probe-lot-autofill.ts, so the rule is stated once.
    expect(FORM).toMatch(/resolveProbeLotAutofill\(\{/);
    expect(FORM).toMatch(/probeKey: draft\.probeKey,/);
    expect(FORM).toMatch(/inventory: probeLotInventory,/);
    expect(FORM).toMatch(/suggestions: probeLotSuggestions,/);
    expect(FORM).not.toMatch(/resolveInventoryAutofill\(/);
    expect(FORM).toMatch(/if \(lotEditedManually\) return;/);
    // The patch (and therefore "never auto-confirm") is owned by the resolver.
    expect(FORM).toMatch(/const patch = probeLotDraftPatch\(result\);/);
    const AUTOFILL = read("lib/record-keeping/probe-lot-autofill.ts");
    expect(AUTOFILL).toMatch(/probeLotConfirmed: false;/);
    expect(AUTOFILL).not.toMatch(/probeLotConfirmed: true/);
  });

  it("typed values are protected (manual edit sets lotEditedManually and clears the link)", () => {
    expect(FORM).toMatch(/setLotEditedManually\(value\.trim\(\) !== ""\)/);
    // onManualChange clears the inventory link.
    expect(FORM).toMatch(/probeInventoryItemId: null,\s*\n\s*probeLotNumber: value,/);
  });

  it("shows truthful provenance copy for every resolved source", () => {
    // Copy moved into the resolver so the string and the branch that produces
    // it cannot drift apart.
    const AUTOFILL = read("lib/record-keeping/probe-lot-autofill.ts");
    expect(AUTOFILL).toMatch(/Auto-filled from your last confirmed inventory lot/);
    expect(AUTOFILL).toMatch(/Only active inventory lot for this probe/);
    expect(AUTOFILL).toMatch(/Choose the lot\/batch from inventory/);
    // THE new one: a history-derived lot must say so, and must not imply a link.
    expect(AUTOFILL).toMatch(/Auto-filled from your last charted lot for this probe — not linked to inventory/);
    expect(FORM).toMatch(/probeLotSourceMessage\(lotStatus\)/);
  });
});

describe("confirm control persists probe_lot_confirmed (source pins)", () => {
  const ACTIONS = read("app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts");
  it("create + update actions persist probe_lot_confirmed (only when a lot is present)", () => {
    // 0155: the snapshot is now inv.probeLotNumber (DB-derived for linked,
    // trimmed text for manual); confirmation still only counts with a lot.
    const matches = ACTIONS.match(
      /probe_lot_confirmed:\s*\n?\s*Boolean\(input\.probeLotConfirmed\) &&\s*\n?\s*\(inv\.probeLotNumber \?\? ""\)\.trim\(\) !== ""/g,
    );
    expect(matches?.length).toBeGreaterThanOrEqual(2); // create + update
  });
  it("copyPreviousSessionAreasAction is contained: it copies no probe_key or lot (zero writes)", () => {
    // The whole-session copy is temporarily paused, so it can never carry a
    // stale probe or lot forward — it writes nothing at all.
    const copyBlock = ACTIONS.slice(
      ACTIONS.indexOf("copyPreviousSessionAreasAction"),
      ACTIONS.indexOf("softDeleteSessionBlockAction"),
    );
    expect(copyBlock).toMatch(/temporarily unavailable/);
    expect(copyBlock).not.toMatch(/probe_key:/);
    expect(copyBlock).not.toMatch(/probe_lot_number/);
    expect(copyBlock).not.toMatch(/probe_lot_confirmed/);
    // 0155: a copy must never carry the durable inventory link forward either.
    expect(copyBlock).not.toMatch(/probe_inventory_item_id/);
  });
});

// Hardening pins from the adversarial verification pass (0155).
describe("0155 hardening: no bypass of the validated resolver; frozen snapshot", () => {
  const ACTIONS = read("app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts");
  const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");

  it("updateSessionBlockAction allowlists its patch columns — the inventory link / snapshot / confirmation can NOT be mass-assigned", () => {
    // The allowlist Set literal, isolated.
    const setStart = ACTIONS.indexOf("PATCHABLE_BLOCK_COLUMNS = new Set");
    expect(setStart).toBeGreaterThan(-1);
    const allowlist = ACTIONS.slice(setStart, ACTIONS.indexOf("]);", setStart));
    // The server-managed 0155 columns are NOT allowlisted.
    expect(allowlist).not.toMatch(/probe_inventory_item_id/);
    expect(allowlist).not.toMatch(/probe_lot_number/);
    expect(allowlist).not.toMatch(/probe_lot_confirmed/);
    // The mass-assignment iterates input.patch through the allowlist (not raw).
    expect(ACTIONS).toMatch(/for \(const \[k, v\] of Object\.entries\(input\.patch\)\)/);
    expect(ACTIONS).toMatch(/if \(PATCHABLE_BLOCK_COLUMNS\.has\(k\)\)/);
  });

  it("the EDIT action reads the STORED probe + link + snapshot server-side and passes all three to the resolver (frozen snapshot; reclassification-safe)", () => {
    // Reads the block's own stored columns (not client-supplied) before resolving.
    expect(ACTIONS).toMatch(
      /\.select\("probe_key, probe_inventory_item_id, probe_lot_number"\)/,
    );
    expect(ACTIONS).toMatch(/existingProbeKey: \(storedBlock\?\.probe_key/);
    expect(ACTIONS).toMatch(/existingInventoryItemId:\s*\n?\s*\(storedBlock\?\.probe_inventory_item_id/);
    expect(ACTIONS).toMatch(/existingSnapshot: \(storedBlock\?\.probe_lot_number/);
  });

  it("INVENTORY choice is still driven ONLY by lastConfirmedInventoryItemId, never the display winner's id", () => {
    // The invariant is unchanged; it just moved into the composed resolver.
    const AUTOFILL = read("lib/record-keeping/probe-lot-autofill.ts");
    expect(AUTOFILL).toMatch(
      /suggestion\?\.lastConfirmedInventoryItemId\s*\?\?\s*null,/,
    );
    // The display winner's id must never bias the inventory pick.
    expect(AUTOFILL).not.toMatch(/suggestion\?\.inventoryItemId/);
    expect(FORM).not.toMatch(/lastSuggestion\?\.confirmed \? \(lastSuggestion\.inventoryItemId/);
  });
});
