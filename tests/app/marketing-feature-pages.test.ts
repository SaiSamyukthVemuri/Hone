import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards the pillar + three feature pages: one H1 each, shared metadata helper,
// a truthful walkthrough CTA, internal links, distinct H1s (no cannibalization),
// and no unreleased-capability / Google Calendar / overclaim language.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}
function h1Inner(raw: string): string {
  const m = raw.match(/<Display[^>]*>([\s\S]*?)<\/Display>/);
  return (m?.[1] ?? "").replace(/\s+/g, " ").trim();
}

const PAGES = [
  { path: "/electrolysis-software", file: "app/electrolysis-software/page.tsx" },
  { path: "/features/treatment-memory", file: "app/features/treatment-memory/page.tsx" },
  { path: "/features/booking-calendar", file: "app/features/booking-calendar/page.tsx" },
  { path: "/features/charting-records", file: "app/features/charting-records/page.tsx" },
];

const FORBIDDEN: RegExp[] = [
  /google calendar/i,
  /calendar sync/i,
  /two-way sync/i,
  /form builder/i, // intake builder is NOT_BUILT
  /choose (their|a|your) (own )?practitioner|pick a practitioner|select a practitioner/i, // per-practitioner booking NOT_BUILT
  /legally binding/i,
  /\bHIPAA\b/i,
  /medical.?grade/i,
  /\bSOC ?2\b/i,
  /\bdeposits?\b/i,
  /prepaid|packages?\b/i,
  /multi.?location/i,
  /all.in.one/i,
  /AI.powered/i,
  /\bseamless\b/i,
  /revolutionary/i,
  /trusted by (thousands|hundreds|\d)/i,
  /\btestimonial/i,
];

describe("pillar + feature pages", () => {
  for (const p of PAGES) {
    describe(p.path, () => {
      const raw = read(p.file);
      const scan = stripComments(raw).replace(/\s+/g, " ");

      it("has exactly one H1 (Display)", () => {
        expect((raw.match(/<Display\b/g) ?? []).length).toBe(1);
      });

      it("uses the shared metadata helper for its own path", () => {
        expect(scan).toMatch(new RegExp(`marketingMetadata\\("${p.path.replace(/\//g, "\\/")}"\\)`));
      });

      it("has the truthful walkthrough CTA and internal links", () => {
        expect(scan).toMatch(/WALKTHROUGH/);
        expect(scan).toMatch(/RelatedLinks/);
      });

      it("has no unreleased-capability / Calendar / overclaim language", () => {
        for (const rx of FORBIDDEN) {
          expect(scan, `matched ${rx}`).not.toMatch(rx);
        }
      });
    });
  }

  // APPEND-ONLY IS A CLAIM ABOUT ONE TABLE, NOT ABOUT THE CHART.
  //
  // Three kinds of note live on a treatment record and only one of them retains
  // anything, so the qualifier in the copy is load-bearing:
  //
  //   client_clinical_notes  (0126)      append-only. In-place UPDATE is blocked
  //                                      by trigger; a correction inserts a new
  //                                      row via supersedes_note_id.
  //   sessions.next_session_note         MUTABLE IN PLACE. set_next_session_note
  //                                      (0167:315-334) is a bare UPDATE, and
  //                                      "Next-treatment note" is one of the
  //                                      fields this page lists by name.
  //   session_blocks.block_notes (0019)  replaced by the block update.
  //
  // The page once said "Notes are append-only" over that field list, which read
  // as a promise about all three. This pins the narrowing so it cannot be
  // dropped by a later copy edit: every append-only / never-overwritten claim on
  // the page must be qualified as CLINICAL in the same breath.
  // Both pages that make the claim, not just the one a review happened to land
  // on: /electrolysis-software carried a bare "Edit history kept." in a list about
  // probe lots and sterile items, which reads as chart-wide however it was meant.
  for (const file of [
    "app/features/charting-records/page.tsx",
    "app/electrolysis-software/page.tsx",
  ]) {
  describe(`${file}: append-only is scoped, never chart-wide`, () => {
    const flat = stripComments(read(file)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

    it("never promises append-only or no-overwrite without saying what KIND", () => {
      const claims = [/append-only/gi, /never (?:be )?overwritten/gi, /not overwritten/gi];
      let found = 0;
      for (const rx of claims) {
        for (const m of flat.matchAll(rx)) {
          found += 1;
          // The qualifier must sit in the same sentence as the claim, not merely
          // somewhere on the page: a reader takes the heading at face value.
          const from = flat.lastIndexOf(".", m.index ?? 0) + 1;
          const to = flat.indexOf(".", (m.index ?? 0) + m[0].length);
          const sentence = flat.slice(from, to === -1 ? undefined : to + 1);
          expect(
            sentence,
            `an unqualified append-only claim: "${sentence.trim()}" — it must name clinical notes, or the sterile-item / disinfectant log that also has one`,
          ).toMatch(/clinical|sterile-item|disinfectant/i);
        }
      }
      // Anti-vacuity: the assertions above are worthless if the page stopped
      // making the claim at all. It is the page's whole edit-history section.
      expect(found, "the page makes no append-only claim, so nothing was checked").toBeGreaterThan(0);
    });
  });
  }

  describe("charting-records states what is NOT retained", () => {
    // The counterweight. Narrowing the promise is only honest if the page also
    // states what is not kept, and the next-treatment note is the specific field
    // that made the old wording false: it is in the page's own field list AND it
    // is a bare in-place UPDATE (set_next_session_note, 0167:315-334).
    const flat = stripComments(read("app/features/charting-records/page.tsx"))
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ");

    it("names the next-treatment note and says the record stays editable", () => {
      expect(flat).toMatch(/next-treatment note/i);
      expect(flat).toMatch(/stay editable|stays editable|remain editable/i);
    });
  });

  it("every H1 is distinct (no cannibalization) and none equals the homepage H1", () => {
    const h1s = PAGES.map((p) => h1Inner(read(p.file)));
    for (const h of h1s) expect(h.length).toBeGreaterThan(0);
    expect(new Set(h1s).size).toBe(h1s.length);
    // Homepage H1 renders a constant reference; feature H1s are literal — never equal.
    for (const h of h1s) expect(h).not.toMatch(/POSITIONING\.heroH1/);
  });
});
