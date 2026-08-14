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

  it("every H1 is distinct (no cannibalization) and none equals the homepage H1", () => {
    const h1s = PAGES.map((p) => h1Inner(read(p.file)));
    for (const h of h1s) expect(h.length).toBeGreaterThan(0);
    expect(new Set(h1s).size).toBe(h1s.length);
    // Homepage H1 renders a constant reference; feature H1s are literal, never equal.
    for (const h of h1s) expect(h).not.toMatch(/POSITIONING\.heroH1/);
  });
});
