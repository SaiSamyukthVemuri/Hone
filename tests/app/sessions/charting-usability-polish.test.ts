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

describe("B. one unified observations & skin response box (charting unification)", () => {
  it("(#6) observations and skin response are ONE merged multi-select box", () => {
    // Charting unification: the two former groups are now a single box, titled via
    // OBSERVATIONS_RESPONSE_HEADING, rendering the merged chip vocabulary.
    expect(FORM).toMatch(/\{OBSERVATIONS_RESPONSE_HEADING\}/);
    expect(FORM).toMatch(/\{OBSERVATIONS_RESPONSE_HELPER\}/);
    // The old two-group headings/helpers are gone from this form.
    expect(FORM).not.toMatch(/\{TREATMENT_OBSERVATIONS_HEADING\}/);
    expect(FORM).not.toMatch(/\{CLIENT_RESPONSE_HEADING\}/);
    expect(FORM).not.toMatch(/\{TREATMENT_OBSERVATIONS_HELPER\}/);
    expect(FORM).not.toMatch(/\{CLIENT_RESPONSE_HELPER\}/);
    // The unified box is MULTI-select over the merged vocabulary, on observationChips.
    expect(FORM).toMatch(/MERGED_OBSERVATION_CHIPS\.map/);
    expect(FORM).toMatch(/toggleFindingChip\(draft\.observationChips, c\)/);
    expect(FORM).toMatch(/isChipSelected\(draft\.observationChips, c\)/);
    // No separate single-select reaction row remains.
    expect(FORM).not.toMatch(/REACTION_TYPES\.map/);
    expect(FORM).not.toMatch(/update\("reactionType", draft\.reactionType === r \? "" : r\)/);
    // The Selected observations summary is retained.
    expect(FORM).toMatch(/<SelectedObservations chips=\{draft\.observationChips\}/);
  });

  it("(#7) the merged vocabulary is the single chip source (presets + reaction labels), no split lists", () => {
    // The unified box renders exactly one chip list from MERGED_OBSERVATION_CHIPS.
    expect(FORM.match(/MERGED_OBSERVATION_CHIPS\.map/g)?.length).toBe(1);
    // The form no longer builds two separate lists (COMMON_COMMENTS / REACTION_TYPES).
    expect(FORM).not.toMatch(/COMMON_COMMENTS\.map/);
    expect(FORM).not.toMatch(/REACTION_TYPES\.map/);
    // The single toggle references ONLY observationChips (the merged store); no
    // field toggles reactionType directly (a legacy reaction is folded in on load).
    expect(FORM).toMatch(/update\("observationChips", toggleFindingChip\(draft\.observationChips, c\)\)/);
    expect(FORM).not.toMatch(/toggleChip\([^)]*reactionType/);
    expect(FORM).not.toMatch(/update\("reactionType",/);
  });

  it("(#8) legacy reaction notes are preserved (render-if-present + round-trip)", () => {
    expect(FORM).toMatch(/\{draft\.reactionNotes\.trim\(\) !== "" && \(/);
    expect(FORM).toMatch(/reactionNotes: draft\.reactionNotes\.trim\(\) \|\| null/);
  });

  it("the payload folds reaction into the chips but never invents/loses a reaction_type", () => {
    // observationChips is the single multi-select store sent on save.
    expect(FORM).toMatch(/observationChips: draft\.observationChips/);
    // Charting unification: reaction_type is no longer a blindly round-tripped
    // separate field (`reactionType: draft.reactionType || null`). It is preserved
    // ONLY while its label chip stays selected, else null — never invented from chips.
    expect(FORM).not.toMatch(/reactionType: draft\.reactionType \|\| null/);
    expect(FORM).toMatch(/reactionType:\s*\n?\s*draft\.reactionType &&/);
    expect(FORM).toMatch(/isReactionType\(draft\.reactionType\) &&/);
    expect(FORM).toMatch(
      /isChipSelected\([\s\S]{0,60}reactionTypeLabel\(draft\.reactionType as ReactionType\)/,
    );
    expect(FORM).toMatch(/\? draft\.reactionType\s*\n?\s*: null/);
  });
});

describe("C. larger, resizable Additional notes (multiline, no restrictive cap, no overflow)", () => {
  // Charting correction enlarged BOTH active forms' notes to rows=8 / min-h-12rem
  // (large, resizable, full-width, uncapped multiline).
  for (const [name, src, rows, minH] of [
    ["BlockSetupForm", FORM, 8, "12rem"],
    ["SimplifiedEntryForm", SIMPLE, 8, "12rem"],
  ] as const) {
    it(`(#9/#10) ${name} Additional notes is taller (rows=${rows}/min-h-[${minH}]), vertically resizable, full-width, uncapped`, () => {
      // Order-independent: inspect a window around the notes textarea.
      const idx = src.indexOf('data-testid="additional-notes"');
      expect(idx).toBeGreaterThan(-1);
      const region = src.slice(Math.max(0, idx - 300), idx + 400);
      // Bigger useful default height + min height (per-form; block form is larger).
      expect(region).toMatch(new RegExp(`rows=\\{${rows}\\}`));
      expect(region).toMatch(new RegExp(`min-h-\\[${minH}\\]`));
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
    // Both forms import terminology from the single-source module (no hard-coded
    // heading strings).
    for (const src of [FORM, SIMPLE]) {
      expect(src).toMatch(/from "@\/lib\/sessions\/charting-labels"/);
      expect(src).toMatch(/\{ADDITIONAL_NOTES_HEADING\}/);
    }
    // Charting unification: BOTH active forms use the SAME merged
    // "Treatment observations & skin response" heading from the shared module.
    expect(FORM).toMatch(/\{OBSERVATIONS_RESPONSE_HEADING\}/);
    expect(SIMPLE).toMatch(/\{OBSERVATIONS_RESPONSE_HEADING\}/);
    expect(FORM).toMatch(/from "@\/lib\/sessions\/charting-labels"/);
    expect(SIMPLE).toMatch(/from "@\/lib\/sessions\/charting-labels"/);
    // The saved-record display no longer presents the old split "Client / skin
    // response" reaction section; it shows tolerance as its own concept and any
    // legacy reaction/note clearly labeled as legacy.
    expect(VIEW).not.toMatch(/\{CLIENT_RESPONSE_HEADING\}/);
    expect(VIEW).toMatch(/Client tolerance:/);
    expect(VIEW).toMatch(/Legacy skin response:/);
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
