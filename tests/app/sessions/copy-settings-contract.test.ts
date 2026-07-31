import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-guard: the in-form "Copy settings" control now uses the SHARED
// treatment-setup snapshot contract (so it carries the primary-entry machine
// readings, not just block fields), preserves destination areas + a manually
// entered probe lot, and never copies outcomes. It is a CLIENT-SIDE draft
// prefill — nothing is persisted until the practitioner saves the area — so it
// cannot fabricate performed treatment.

const ROOT = process.cwd();
const FORM = readFileSync(
  join(ROOT, "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx"),
  "utf8",
);
const CONTRACT = readFileSync(
  join(ROOT, "lib/sessions/treatment-setup-snapshot.ts"),
  "utf8",
);

describe("in-form Copy settings uses the shared canonical contract", () => {
  it("imports and applies buildTreatmentSetupDraftPatch + firstLiveEntry", () => {
    expect(FORM).toMatch(
      /import \{[\s\S]*buildTreatmentSetupDraftPatch[\s\S]*firstLiveEntry[\s\S]*\} from "@\/lib\/sessions\/treatment-setup-snapshot"/,
    );
    // copySettings builds the patch from the source block's first live entry.
    expect(FORM).toMatch(/firstLiveEntry\(source\.electrolysis_entries\)/);
    // The third argument is the set of inventory ids still LINKABLE for the
    // copied probe, so a copy never resurrects an expired/reclassified link.
    expect(FORM).toMatch(
      /buildTreatmentSetupDraftPatch\(source, firstEntry, linkable\)/,
    );
    // It spreads the patch onto the existing draft (preserving all other keys).
    expect(FORM).toMatch(/setDraft\(\(d\) => \(\{ \.\.\.d, \.\.\.patch \}\)\)/);
  });

  it("copySettings does NOT assign destination area identity or a probe lot or any outcome", () => {
    // Isolate the copySettings function body.
    const start = FORM.indexOf("function copySettings()");
    const body = FORM.slice(start, FORM.indexOf("\n  }", start));
    // No destination-area / probe-lot / outcome assignments inside copySettings.
    for (const forbidden of [
      "primaryArea:",
      "side:",
      "customAreaDetail:",
      "areas:",
      "probeLotNumber:",
      "probeLotConfirmed:",
      "hairsTreated:",
      "comments:",
      "observationChips:",
      "toleranceRating:",
      "reactionType:",
      "numbingStatus:",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });
});

describe("the shared contract itself excludes outcomes + gates by mode", () => {
  it("names only reusable setup fields (block + entry), no outcome columns", () => {
    // Strip comments — the header intentionally NAMES the never-copy fields as
    // documentation; the guarantee is that no outcome column appears in code.
    const code = CONTRACT.split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    for (const forbidden of [
      "hairs_treated",
      "observation_chips",
      "tolerance_rating",
      "reaction_type",
      "caution_note",
      "numbing_status",
      // probe_lot_confirmed stays forbidden — a copy is never confirmed. But
      // probe_lot_number + probe_inventory_item_id are now DELIBERATELY part of
      // the contract: the lot travels with the probe.
      "probe_lot_confirmed",
      "probe_lot_id",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
  it("gates readings on the resulting mode and clears pulse delay for single pulse", () => {
    expect(CONTRACT).toMatch(/wantThermo = mode === "thermo" \|\| mode === "blend"/);
    expect(CONTRACT).toMatch(/wantGalv = mode === "galv" \|\| mode === "blend"/);
    expect(CONTRACT).toMatch(/pulseCount != null && pulseCount <= 1 \? "" :/);
    // Galvanic carries no apilus modality / energy level.
    expect(CONTRACT).toMatch(/isGalv \? "" : \(block\.apilus_modality \?\? ""\)/);
  });
});
