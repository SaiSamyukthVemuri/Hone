import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-guard: the in-form "Copy settings" control uses the SHARED
// treatment-setup snapshot contract (so it carries the primary-entry machine
// readings, not just block fields), preserves destination areas, laterality and
// every OUTCOME field, and copies the probe SETUP — including the probe-lot
// number and, conditionally, its inventory link. It is a CLIENT-SIDE draft
// prefill — nothing is persisted until the practitioner saves the area — so it
// cannot fabricate performed treatment.
//
// An earlier version of this header claimed a "manually entered probe lot" is
// preserved. That was false: the patch owns the lot keys and replaces it. The
// safety is that a copied lot is NEVER marked confirmed.

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

  it("copySettings assigns no destination area identity and no outcome of its own", () => {
    // Isolate the copySettings function body.
    const start = FORM.indexOf("function copySettings()");
    const body = FORM.slice(start, FORM.indexOf("\n  }", start));
    // NOTE ON THE PROBE LOT. `probeLotNumber:` / `probeLotConfirmed:` are listed
    // here because copySettings must not hand-roll them — but that is NOT a
    // claim that the lot is never copied. The shared PATCH owns all three lot
    // keys and does copy the number and (conditionally) the inventory link; see
    // the dedicated truthfulness suite below. This assertion is only that the
    // form has no second, divergent copy path of its own.
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

  // -------------------------------------------------------------------------
  // Session 1C: minutes performed is an OUTCOME, not reusable setup.
  // -------------------------------------------------------------------------
  it("the form's Copy settings comment no longer claims minutes are copied", () => {
    const start = FORM.indexOf(
      '// "Copy settings from another area in this session"',
    );
    expect(start).toBeGreaterThan(-1);
    const comment = FORM.slice(start, FORM.indexOf("function copySettings()", start));
    // The old comment read "...machine frequency, probe, and minutes."
    expect(comment).not.toMatch(/probe,\s*(\/\/\s*)?and minutes/);
    // and it must positively say minutes are NOT copied, so the reason survives
    // the next person who reads it.
    expect(comment).toMatch(/never MINUTES PERFORMED/);
  });

  it("copySettings never reads a minutes key off the patch", () => {
    const start = FORM.indexOf("function copySettings()");
    const body = FORM.slice(start, FORM.indexOf("\n  }", start));
    expect(body).not.toContain("patch.minutes");
    expect(body).not.toContain("minutes:");
    expect(body).not.toContain("minutes_performed");
    // The application mechanism is still a spread — which is exactly why
    // omitting the key preserves the destination's own value.
    expect(body).toMatch(/setDraft\(\(d\) => \(\{ \.\.\.d, \.\.\.patch \}\)\)/);
  });

  // -------------------------------------------------------------------------
  // Session 1C integration: the probe-lot prose must match runtime behaviour.
  // The old wording claimed a manually typed destination lot was preserved. It
  // is not — the patch owns the lot keys and replaces it. Truthful docs matter
  // here because the practitioner is being asked to trust a traceability value.
  // -------------------------------------------------------------------------
  it("the form comment no longer claims a manual destination lot is preserved", () => {
    const start = FORM.indexOf("function copySettings()");
    const comment = FORM.slice(start, FORM.indexOf("\n  }", start));
    expect(comment).not.toMatch(/manually entered probe lot,? and every outcome/);
    expect(comment).not.toMatch(/a manually entered probe lot.*preserved/s);
    // ...and it states the real rule, including the safety that makes it OK.
    expect(comment).toMatch(/REPLACES a lot already typed here/);
    expect(comment).toMatch(/unconfirmed/);
  });

  it("the shared contract does not list the lot among the NEVER-copied fields", () => {
    // The header NEVER list used to include `probe_lot_number/confirmed/id`,
    // which contradicted the code directly beneath it.
    expect(CONTRACT).not.toMatch(/NEVER:[\s\S]{0,400}probe_lot_number\/confirmed\/id/);
    // It must instead distinguish the three rules.
    expect(CONTRACT).toMatch(/probe_lot_number\s+: COPIED verbatim/);
    expect(CONTRACT).toMatch(/probe_inventory_item_id\s*: copied ONLY while/);
    expect(CONTRACT).toMatch(/probe_lot_confirmed\s+: NEVER copied/);
  });

  it("the UI still tells the practitioner to confirm a copied lot", () => {
    // If the lot is replaced, the confirmation prompt is the safety net; losing
    // it would turn a helpful copy into a silent traceability claim.
    expect(FORM).toMatch(/lotStatus/);
    expect(FORM).toMatch(/"copied"/);
  });

  it("ORDINARY charting still reads, validates and saves draft.minutes", () => {
    // Removing minutes from the COPY contract must not remove the field from
    // charting. Without this, the copy fix could be "achieved" by deleting the
    // Minutes input altogether and every other assertion here would still pass.
    expect(FORM).toMatch(/value=\{draft\.minutes\}/);
    expect(FORM).toMatch(/update\("minutes", e\.target\.value\)/);
    expect(FORM).toMatch(/const min = draft\.minutes\.trim\(\)/);
    expect(FORM).toMatch(/minutesPerformed: minutesNum/);
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

  it("carries no minutes key and never reads the source minutes column", () => {
    const code = CONTRACT.split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    // No patch key, no source read, and gone from the field allow-list too —
    // all three, because removing any one alone leaves the defect reachable.
    expect(code).not.toMatch(/\bminutes:/);
    expect(code).not.toContain("block.minutes_performed");
    expect(code).not.toContain("minutes_performed");
    // The rest of the block-level allow-list is untouched, so this fails
    // because minutes left — not because the contract was gutted.
    expect(code).toContain('"machine_frequency"');
    expect(code).toContain('"probe_key"');
    expect(code).toContain('"probe_lot_number"');
  });
});
