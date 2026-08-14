import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeSites,
  supabaseWriteSites,
  writesToColumn,
} from "../../security/helpers/supabase-write-census";

// ===========================================================================
// Chloe Session 1A, `clients.skin_notes` is RETIRED as a practitioner editor.
// ===========================================================================
//
// THE DEFECT. Hone already had the correct skin/hair clinical record:
// client_clinical_notes with kind='skin_hair_analysis', append-only,
// attributed to a practitioner, carrying an event date and a supersession
// lineage. But the older `clients.skin_notes` column remained a plain editable
// textarea with quick-tap condition chips, and it OUTRANKED the real record:
// it rendered on the default profile Overview tab and on appointment detail,
// while the clinical record sat behind a separate Consultation tab.
//
// Production reflected exactly that hierarchy: several clients carried legacy
// skin_notes text and ZERO skin/hair-analysis notes existed. Every edit to that
// column destroyed the prior clinical text with no author, no date and no
// revision history.
//
// THE PRODUCT DECISION. Stop writing it; keep every byte of it. The column is
// not dropped, not nulled, not backfilled, and never copied into the
// append-only record (which would fabricate authorship and a date). It is
// displayed read-only, explicitly labelled legacy, and the canonical action is
// made the obvious one.

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Source with comments stripped: prose about a pattern is not the pattern. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

const FORM = read("components/client-form.tsx");
const NEW_ACTION = read("app/(app)/clients/new/actions.ts");
const EDIT_ACTION = read("app/(app)/clients/[id]/actions.ts");
const EDIT_PAGE = read("app/(app)/clients/[id]/edit/page.tsx");
const PROFILE = read("app/(app)/clients/[id]/page.tsx");
const APPT = read("app/(app)/calendar/[id]/page.tsx");
const EXPORT = read("app/(app)/settings/data/actions.ts");

describe("client form no longer edits legacy skin notes", () => {
  const src = code(FORM);

  it("renders no editable skin_notes control", () => {
    expect(src).not.toMatch(/update\(\s*"skin_notes"/);
    expect(src).not.toMatch(/values\.skin_notes/);
  });

  it("drops skin_notes from the form value contract entirely", () => {
    // handleSubmit serialises EVERY key of `values` into FormData, so a
    // lingering key would still be submitted, and on the edit screen it would
    // round-trip (or, if seeded empty, WIPE) the historical text. Removing it
    // from the type is what makes "the form cannot submit it" structural.
    expect(src).not.toMatch(/skin_notes:\s*string/);
    expect(src).not.toMatch(/skin_notes:\s*""/);
  });

  it("no longer offers the skin-condition quick chips", () => {
    expect(src).not.toContain("COMMON_SKIN_CONDITIONS");
  });

  it("still edits the OTHER profile fields (this is a targeted retirement)", () => {
    for (const field of ["allergies", "fitzpatrick_type", "pronouns", "email"]) {
      expect(src, `${field} must remain editable`).toContain(field);
    }
  });

  it("the edit page no longer seeds a skin_notes value into the form", () => {
    expect(code(EDIT_PAGE)).not.toContain("skin_notes");
  });
});

describe("no runtime writer persists clients.skin_notes", () => {
  it.each([
    ["new-client action", NEW_ACTION],
    ["edit-client action", EDIT_ACTION],
  ])("%s does not write the column", (_label, src) => {
    const c = code(src);
    expect(c).not.toMatch(/skin_notes:\s*nullableString/);
    expect(c).not.toMatch(/skin_notes:\s*formData\.get/);
    expect(c).not.toMatch(/skin_notes\s*:/);
  });

  // =========================================================================
  // GENUINE RUNTIME-TREE CENSUS (amendment)
  // =========================================================================
  //
  // The previous version of this test was named "the whole app tree has ZERO
  // skin_notes write expressions" and looped over FIVE hand-listed files. The
  // name was false. A writer added to any other server action, an onboarding
  // helper, an import path, a script, middleware, or behind a variable table
  // expression would have survived while this stayed green, the exact failure
  // mode a static guard in this repo has already been believed on twice.
  //
  // It now walks app/ lib/ components/ scripts/ + middleware.ts with the
  // TypeScript compiler API, resolves the table AND the payload through
  // same-scope bindings, and FAILS CLOSED on anything it cannot follow.
  it("the runtime tree contains ZERO writers of clients.skin_notes", () => {
    const { definite } = writesToColumn("clients", "skin_notes");
    expect(
      definite,
      `clients.skin_notes is written at:\n${describeSites(definite)}`,
    ).toEqual([]);
  });

  it("no UNRESOLVABLE write could be hiding one", () => {
    // Silence is not absence. A computed table, an opaque spread, a chained
    // factory receiver, a conditional target or a helper-returned patch object
    // means the analyzer cannot prove the column is untouched, so it fails.
    const { unresolved } = writesToColumn("clients", "skin_notes");
    expect(
      unresolved,
      "the census could not analyse these write sites, so it cannot prove " +
        `clients.skin_notes is unwritten:\n${describeSites(unresolved)}`,
    ).toEqual([]);
  });

  it("ANTI-VACUITY: the census really does see writers in this tree", () => {
    // If the walker silently stopped matching, both assertions above would pass
    // on an empty set and prove nothing. The runtime tree contains plenty of
    // legitimate Supabase writes; at least one must be visible, and the
    // `clients` table specifically must still be reachable for OTHER columns.
    const all = supabaseWriteSites();
    expect(all.length).toBeGreaterThan(20);
    const clientWrites = all.filter((s) => s.table === "clients");
    expect(
      clientWrites.length,
      "no writes to `clients` were found at all, the analyzer has gone blind, " +
        "not the writers away",
    ).toBeGreaterThan(0);
    // ...and those surviving client writes carry OTHER columns, proving the
    // column filter is what excludes skin_notes rather than a broken payload
    // resolver.
    const columns = new Set(clientWrites.flatMap((s) => s.columns));
    expect(columns.size).toBeGreaterThan(3);
    expect(columns.has("skin_notes")).toBe(false);
  });
});

describe("legacy data is preserved and clearly labelled", () => {
  it("the profile still RENDERS historical legacy text", () => {
    const c = code(PROFILE);
    expect(c).toContain("client.skin_notes");
  });

  it("the profile labels it 'Legacy skin notes', not 'Skin notes'", () => {
    expect(PROFILE).toContain("Legacy skin notes");
  });

  it("the profile explains it is historical and has no author or date", () => {
    expect(PROFILE).toMatch(/Historical profile text/i);
    expect(PROFILE).toMatch(/no author\s*\n?\s*or date|no author or date/i);
  });

  it("does NOT imply the legacy text has append-only provenance", () => {
    const idx = PROFILE.indexOf("Legacy skin notes");
    const block = PROFILE.slice(idx, idx + 1200);
    // The block must state the legacy text has NO author or date...
    expect(block).toMatch(/no author\s*\n?\s*or date|no author or date/i);
    // ...and must never attribute revision/supersession lineage to it.
    expect(block).not.toMatch(/revision|superseded/i);
    // "append-only" may appear ONLY as a description of the CANONICAL record
    // the copy points at ("...the append-only clinical record"), never as a
    // property of the legacy text itself.
    for (const m of block.matchAll(/append-only([\s\S]{0,40})/gi)) {
      expect(
        m[1],
        `"append-only" must qualify the canonical record, not the legacy text: ${m[0]}`,
      ).toMatch(/clinical record/i);
    }
  });

  it("the helper copy points at where the canonical form ACTUALLY is", () => {
    // It used to say the append-only section was "below". It is not on this tab,
    // it is behind Consultation, so the sentence sent practitioners looking
    // for something that was not there, and the legacy textarea was the nearest
    // editable thing. The copy now names the action rendered directly above and
    // the tab, and "below" is banned outright inside the block.
    const idx = PROFILE.indexOf("Legacy skin notes");
    const block = PROFILE.slice(idx, idx + 1200);
    expect(block).toMatch(/Consultation tab/i);
    expect(block).toMatch(/Add skin &amp; hair analysis/);
    // The ban applies to what a practitioner READS. Scanning the raw source
    // instead would trip on the neighbouring code comments, which legitimately
    // use "below" to describe render ORDER ("rendered BEFORE the legacy block
    // below"), true of the layout, and not copy anyone sees.
    const rendered = code(PROFILE);
    const rIdx = rendered.indexOf("Legacy skin notes");
    expect(rIdx).toBeGreaterThan(-1);
    expect(
      rendered.slice(rIdx, rIdx + 1200),
      'the canonical form is not on this tab, so "below" is untrue',
    ).not.toMatch(/\bbelow\b/i);
  });

  it("the appointment-prep surface labels it legacy too", () => {
    expect(APPT).toContain("Legacy skin notes:");
    // ...and no longer presents it as the authoritative current analysis.
    expect(APPT).not.toMatch(/>Skin notes:</);
  });

  it("the data export still retains the historical column", () => {
    // Retention promise is unchanged: retiring the EDITOR must not remove the
    // value from what a studio can export.
    expect(EXPORT).toContain("skin_notes");
  });

  it("nothing copies legacy text into the append-only clinical record", () => {
    // A silent copy would fabricate an author and a date for text that has
    // neither. Explicitly banned.
    for (const src of [NEW_ACTION, EDIT_ACTION, PROFILE, FORM]) {
      const c = code(src);
      expect(/client_clinical_notes[\s\S]{0,200}skin_notes/.test(c)).toBe(false);
      expect(/skin_notes[\s\S]{0,200}client_clinical_notes/.test(c)).toBe(false);
    }
  });
});

describe("the canonical action outranks the legacy display", () => {
  it("offers 'Add skin & hair analysis' on the profile", () => {
    expect(PROFILE).toMatch(/Add skin &amp; hair analysis/);
  });

  it("that action points at the append-only clinical-notes surface", () => {
    const idx = PROFILE.indexOf("Add skin &amp; hair analysis");
    const block = PROFILE.slice(Math.max(0, idx - 400), idx);
    expect(block).toMatch(/tab=consultation/);
  });

  it("the canonical action renders BEFORE the legacy text", () => {
    const action = PROFILE.indexOf("Add skin &amp; hair analysis");
    const legacy = PROFILE.indexOf("Legacy skin notes");
    expect(action).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(-1);
    expect(
      action,
      "the canonical action must outrank the retired legacy block",
    ).toBeLessThan(legacy);
  });

  it("the canonical record is still the append-only clinical-notes flow", () => {
    // Unchanged by this PR: asserted so a future edit cannot quietly point the
    // canonical action at a new overwriteable field.
    expect(PROFILE).toContain("<ClinicalNotesSection");
    expect(PROFILE).toContain("addClinicalNoteAction");
    expect(PROFILE).toContain("reviseClinicalNoteAction");
  });
});
