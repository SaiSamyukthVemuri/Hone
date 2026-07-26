import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Chloe charting-usability polish (no-migration UI PR). Source-guard the three
// narrow behaviours; the live browser behaviour (collapse → open → save,
// independent chip persistence, multiline notes round-trip, 390px no-overflow)
// is proven in e2e/charting-usability-polish.spec.ts.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const BASE = "app/(app)/clients/[id]/sessions/[sessionId]";
const VIEW = read(`${BASE}/session-blocks-view.tsx`);
const FORM = read(`${BASE}/block-setup-form.tsx`);
const SIMPLE = read(`${BASE}/simplified-entry-form.tsx`);
const LABELS = read("lib/sessions/charting-labels.ts");

describe("A. collapse the Add settings block by default (no auto-open, no writes to open/cancel)", () => {
  it("(#1) a zero-block session no longer auto-renders the form; it starts on the compact CTA", () => {
    // The old auto-open (useState(blocks.length === 0)) is gone.
    expect(VIEW).not.toMatch(/useState\(blocks\.length === 0\)/);
    expect(VIEW).toMatch(/const \[adding, setAdding\] = useState\(false\)/);
    // The compact CTA is the initial surface and has a stable testid.
    expect(VIEW).toMatch(/data-testid="add-settings-block-cta"/);
    // The full form renders ONLY when `adding` is true.
    expect(VIEW).toMatch(/\{adding \? \(\s*\n?\s*<BlockSetupForm/);
  });

  it("(#2/#3) opening and cancelling are pure state toggles — neither calls a server action", () => {
    // Open = setAdding(true); Cancel = setAdding(false). No DB row on either.
    expect(VIEW).toMatch(/onClick=\{\(\) => setAdding\(true\)\}/);
    expect(VIEW).toMatch(/onCancel=\{\(\) => setAdding\(false\)\}/);
    // The view itself never imports/calls a block-writing action to open/cancel.
    expect(VIEW).not.toMatch(/createSessionBlockAction|createTreatmentAreaWithEntryAction/);
  });

  it("(#4) saving still flows through the existing trusted create action (one block)", () => {
    // The form owns the write; it calls the create action exactly once on submit.
    expect(FORM).toMatch(/createTreatmentAreaWithEntryAction|createSessionBlockAction/);
    const creates =
      FORM.match(/createTreatmentAreaWithEntryAction\(/g)?.length ?? 0;
    const createsAlt = FORM.match(/createSessionBlockAction\(/g)?.length ?? 0;
    expect(creates + createsAlt).toBeGreaterThanOrEqual(1);
  });

  it("(#5) existing blocks stay summarized + editable (unchanged)", () => {
    expect(VIEW).toMatch(/blocks\.map\(\(block\) => \(/);
    expect(VIEW).toMatch(/const \[editing, setEditing\] = useState\(false\)/);
  });
});

describe("B. distinguish the two chip groups (no data-model change)", () => {
  it("(#6) observations and response are SEPARATE headed groups, distinct draft fields", () => {
    // Two distinct headings from the shared module.
    expect(FORM).toMatch(/\{TREATMENT_OBSERVATIONS_HEADING\}/);
    expect(FORM).toMatch(/\{CLIENT_RESPONSE_HEADING\}/);
    // Distinct helpers.
    expect(FORM).toMatch(/\{TREATMENT_OBSERVATIONS_HELPER\}/);
    expect(FORM).toMatch(/\{CLIENT_RESPONSE_HELPER\}/);
    // Observations = MULTI-select on observationChips; response = SINGLE-select
    // on reactionType. Separate draft keys, separate writes.
    expect(FORM).toMatch(/toggleChip\(draft\.observationChips, c\)/);
    expect(FORM).toMatch(/update\("reactionType", draft\.reactionType === r \? "" : r\)/);
    // The Selected observations summary is retained.
    expect(FORM).toMatch(/<SelectedObservations chips=\{draft\.observationChips\}/);
  });

  it("(#7) reaction chips live in the response group; observation chips do not overlap it", () => {
    const obsGroup = FORM.slice(
      FORM.indexOf("{TREATMENT_OBSERVATIONS_HEADING}"),
      FORM.indexOf("{CLIENT_RESPONSE_HEADING}"),
    );
    const responseGroup = FORM.slice(FORM.indexOf("{CLIENT_RESPONSE_HEADING}"));
    // reaction chips only in the response group.
    expect(responseGroup).toMatch(/REACTION_TYPES\.map/);
    expect(obsGroup).not.toMatch(/REACTION_TYPES\.map/);
    // observation chips only in the observations group.
    expect(obsGroup).toMatch(/COMMON_COMMENTS\.map/);
    expect(responseGroup).not.toMatch(/COMMON_COMMENTS\.map/);
    // The observation toggle references ONLY observationChips; the reaction
    // toggle references ONLY reactionType (no field infers the other).
    expect(FORM).toMatch(/update\("observationChips", toggleChip\(draft\.observationChips, c\)\)/);
    expect(FORM).not.toMatch(/toggleChip\([^)]*reactionType/);
  });

  it("(#8) legacy reaction notes are preserved (render-if-present + round-trip)", () => {
    expect(FORM).toMatch(/\{draft\.reactionNotes\.trim\(\) !== "" && \(/);
    expect(FORM).toMatch(/reactionNotes: draft\.reactionNotes\.trim\(\) \|\| null/);
  });

  it("the payload keeps the two fields independent (no merge, no inference)", () => {
    // Both fields are sent as their own keys; neither is derived from the other.
    expect(FORM).toMatch(/observationChips: draft\.observationChips/);
    expect(FORM).toMatch(/reactionType: draft\.reactionType \|\| null/);
  });
});

describe("C. larger, resizable Additional notes (multiline, no restrictive cap, no overflow)", () => {
  for (const [name, src] of [
    ["BlockSetupForm", FORM],
    ["SimplifiedEntryForm", SIMPLE],
  ] as const) {
    it(`(#9/#10) ${name} Additional notes is taller, vertically resizable, full-width, uncapped`, () => {
      // Order-independent: inspect a window around the notes textarea.
      const idx = src.indexOf('data-testid="additional-notes"');
      expect(idx).toBeGreaterThan(-1);
      const region = src.slice(Math.max(0, idx - 300), idx + 400);
      // Bigger useful default height + min height.
      expect(region).toMatch(/rows=\{5\}/);
      expect(region).toMatch(/min-h-\[7rem\]/);
      // Safe vertical resize.
      expect(region).toMatch(/resize-y/);
      // Full-width so it can't overflow the 390px viewport.
      expect(region).toMatch(/w-full/);
      // Bound to the free-text comments field; NO restrictive maxLength.
      expect(region).toMatch(/value=\{draft\.comments\}/);
      expect(region).not.toMatch(/maxLength/);
    });
  }
});

describe("D. consistency + single-source terminology (BlockSetupForm ≡ SimplifiedEntryForm ≡ saved display)", () => {
  it("(#11) both active charting forms use the shared label module", () => {
    for (const src of [FORM, SIMPLE]) {
      expect(src).toMatch(/from "@\/lib\/sessions\/charting-labels"/);
      expect(src).toMatch(/\{TREATMENT_OBSERVATIONS_HEADING\}/);
      expect(src).toMatch(/\{ADDITIONAL_NOTES_HEADING\}/);
    }
    // The saved-record display uses the same response terminology.
    expect(VIEW).toMatch(/\{CLIENT_RESPONSE_HEADING\}/);
    expect(VIEW).toMatch(/from "@\/lib\/sessions\/charting-labels"/);
  });

  it("the shared module keeps observations multi-select vs response single-select factual", () => {
    expect(LABELS).toMatch(/Tap all that apply/); // observations = multi
    expect(LABELS).toMatch(/Choose one/); // response = single
  });
});

describe("E. scope containment (#12) — no payment/scheduling/notifications/inventory/provider changes", () => {
  it("the charting UI files touch none of those surfaces", () => {
    for (const src of [VIEW, FORM, SIMPLE]) {
      expect(src).not.toMatch(/stripe|payment_charge|manual_fee/i);
      expect(src).not.toMatch(/appointment_id|mark_appointment|reschedule/i);
      expect(src).not.toMatch(/practitioner_notifications|dedupe_key/i);
      expect(src).not.toMatch(/probe_lots\b|electrolysis_entries\.probe_lot_id/);
    }
  });
});
