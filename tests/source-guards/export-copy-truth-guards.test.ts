import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { pendingResources } from "@/lib/export/resource-registry";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// Strip line comments so an explanatory comment quoting the old wording does
// not itself trip the guard. Comments are how the correction records what it
// corrected; the guard is about what the SCREEN says.
function copyOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

// ===========================================================================
// R0 — THE COPY MAY NOT OUT-CLAIM THE EXPORT
// ===========================================================================
//
// The export carries fifteen files. The registry declares dozens of studio-owned
// record types it does not carry, treatment photos among them. Three live
// surfaces described that as a FULL export - the marketing home page, the
// pricing feature list and the charting feature page - and the Data settings
// page named exactly two omissions, which reads as "everything else is in
// there" to an owner deciding whether this is their backup.
//
// THE GUARD IS CONDITIONAL, NOT ABSOLUTE. It bans the absolute words only while
// something studio-owned is still PENDING. When TRUTH-01B and TRUTH-01C land
// and the pending list empties, the claim becomes true and this guard stops
// objecting to it on its own. That is deliberate: a guard that forbids the word
// forever would have to be deleted by the very change that earns it.

const EXPORT_COPY_SURFACES = [
  "app/page.tsx",
  "app/pricing/page.tsx",
  "app/features/charting-records/page.tsx",
  "app/(app)/settings/data/page.tsx",
];

/**
 * Absolute completeness claims. Each is only a problem NEAR the word "export":
 * "everything" in an unrelated sentence is not a claim about the archive.
 */
const ABSOLUTE_CLAIMS = [
  /full\s+(?:data\s+)?export/i,
  /full\s+studio\s+(?:history|data|records?)/i,
  /export\s+everything/i,
  /export[^.]{0,60}\ball\s+(?:your\s+)?records?\b/i,
  /\ball\s+(?:your\s+)?records?\b[^.]{0,60}export/i,
  /export[^.]{0,40}\beverything\b/i,
];

describe("no surface claims a complete export while resources are pending", () => {
  it("something IS still pending, so this guard is live rather than vacuous", () => {
    expect(pendingResources().length).toBeGreaterThan(0);
  });

  for (const surface of EXPORT_COPY_SURFACES) {
    it(`${surface} makes no unqualified completeness claim`, () => {
      const copy = copyOnly(read(surface));
      for (const claim of ABSOLUTE_CLAIMS) {
        expect(copy, `${surface} matches ${claim}`).not.toMatch(claim);
      }
    });
  }

  it("the exporter's own README makes none either", () => {
    const copy = copyOnly(read("app/(app)/settings/data/actions.ts"));
    expect(copy).not.toMatch(/your records leave with you/i);
    for (const claim of ABSOLUTE_CLAIMS) {
      expect(copy, `the README matches ${claim}`).not.toMatch(claim);
    }
  });
});

describe("the settings page states the scope instead of implying it", () => {
  const page = read("app/(app)/settings/data/page.tsx");

  it("renders the included, pending and withheld lists FROM the registry", () => {
    expect(page).toMatch(/from "@\/lib\/export\/resource-registry"/);
    expect(page).toMatch(/exportedResources\(\)/);
    expect(page).toMatch(/pendingResources\(\)/);
    expect(page).toMatch(/excludedResources\(\)/);
  });

  it("keeps no hand-written file list that could drift from the registry", () => {
    // The old page listed files as literal <li> bullets. Any bare ".csv"
    // literal in the JSX would be a second inventory forming again.
    const jsx = page.slice(page.indexOf("export default async function"));
    expect(jsx).not.toMatch(/"[a-z_]+\.csv"/);
  });

  it("says in words that the export is a subset, not the whole studio", () => {
    expect(page).toMatch(/NAMED SUBSET, not everything Hone holds/);
    expect(page).toMatch(/Not included yet/);
  });

  it("names the biggest omissions on the surface, not only behind a disclosure", () => {
    const summary = page.slice(0, page.indexOf("See all {pending.length}"));
    for (const phrase of ["treatment photos", "intake forms", "signed consents", "service\n                menu", "payment records"]) {
      expect(summary, `${phrase} should be named without expanding a details element`).toContain(phrase);
    }
  });

  it("no longer offers the export as a substitute for a backup", () => {
    expect(page).not.toMatch(/keep\s+your own copy of it somewhere safe/i);
    expect(page).toMatch(/It is not a full\s*\n?\s*backup of your studio/);
    expect(page).toMatch(/does not include sessions you have deleted/);
  });
});

// ---------------------------------------------------------------------------
// TERMS — deliberately NOT edited by this slice, and that is recorded here
// ---------------------------------------------------------------------------
//
// app/terms/page.tsx section 6 defines "Your Data" to INCLUDE photos, and
// section 16 promises a copy of Your Data on termination while telling the
// studio to "Export Your Data before you terminate if you need your own copy" -
// pointing at a self-serve export that carries no photos.
//
// That is not a wording slip this slice may quietly patch. The page carries a
// published effective date, and the question underneath - whether the section
// 16 obligation is satisfied by the self-serve subset or by an operator-assisted
// request, and what Hone therefore commits to deliver - is a legal-policy
// decision with a notice process attached, not a scope clarification. TRUTH-01A
// STOPS on this surface and reports it rather than rewriting a legal document.
//
// This test exists so the stop is visible in the suite rather than only in a PR
// description, and so the day somebody does change section 16 they are told
// that a deliberate decision is being made.
describe("terms section 16 is an open legal-policy decision, not a copy fix", () => {
  const terms = read("app/terms/page.tsx");

  it("still defines Your Data to include photos", () => {
    expect(terms).toMatch(/treatment notes, and photos/);
  });

  it("still points a departing studio at the self-serve export", () => {
    expect(terms).toMatch(/Export Your Data\s*\n?\s*before you terminate/);
  });

  it("the effective date is unchanged by TRUTH-01A", () => {
    expect(terms).toMatch(/effectiveDate="May 22, 2026"/);
    expect(terms).toMatch(/lastUpdated="May 22, 2026"/);
  });
});
