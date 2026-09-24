import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { softwareApplicationLd } from "@/lib/marketing/jsonld";
import {
  MARKETING_PAGES,
  PAYMENT_QUALIFIER,
  POSITIONING,
  WALKTHROUGH,
} from "@/lib/marketing/content";

// ===========================================================================
// COPY DECK v2.2 — THE CONSTANTS SAY WHAT THE DECK SAYS, AND NOTHING RETIRED
// ===========================================================================
//
// The deck's lines are "written to be pasted". This file exists because a
// paraphrase is indistinguishable from a paste once it is in the file: both
// compile, both render, and only one was reviewed against the truth register.
//
// TWO CLASSES OF ASSERTION, AND THE SECOND IS THE ONE THAT ROTS.
// Positive pins catch a well-meaning edit. NEGATIVE pins — "this retired line
// appears nowhere" — catch a REVIVAL, and they are the ones that can silently
// stop working, because a mistyped needle passes forever. So each negative pin
// below is paired with an anti-vacuity check that the needle really can match.
// ===========================================================================

const ROOT = path.resolve(__dirname, "../../..");

/**
 * EVERY MARKETING SOURCE, not just the constants module.
 *
 * THE FIRST VERSION OF THIS GUARD READ ONE FILE AND PASSED WHILE RETIRED COPY
 * SHIPPED. `app/page.tsx` still rendered a retired heading and
 * `lib/marketing/jsonld.ts` still emitted a retired description into structured
 * data the homepage embeds. Both were invisible to a check scoped to
 * `lib/marketing/content.ts`, which is exactly the shape of failure the deck
 * warns about: it requires retirement "from every rendered surface, title, meta,
 * OG and JSON-LD", and a constants module is none of those.
 *
 * So the census walks the marketing surface. `app/(app)/**` is deliberately
 * excluded — that is the authenticated product, which this deck does not govern.
 */
const MARKETING_ROOTS = [
  "lib/marketing",
  "app/page.tsx",
  "app/electrolysis-software",
  "app/features",
  "app/pricing",
  "app/demo",
  "app/resources",
  "app/_components/marketing",
  // ROOT AND OG SURFACES, added because the first version of this list omitted
  // them and the omission was invisible. `app/layout.tsx` supplies the DEFAULT
  // metadata every marketing route inherits, and `app/opengraph-image.tsx`
  // GENERATES the site-wide OG image. Both are rendered output the deck governs
  // — it requires retirement from "every rendered surface, title, meta, OG and
  // JSON-LD" — so retired wording restored in either would have shipped with
  // every absence check still green.
  "app/layout.tsx",
  "app/opengraph-image.tsx",
] as const;

/**
 * Entry points the census MUST reach, pinned by name.
 *
 * WITHOUT THIS PIN THE LIST CAN SILENTLY SHRINK. A refactor that renames or
 * relocates one of these leaves `walk()` finding nothing for that root and every
 * absence check still passing — the same failure shape as omitting it in the
 * first place, which is how these two came to be missing. Naming them makes the
 * loss an error rather than a smaller census.
 */
const REQUIRED_IN_CENSUS = [
  "lib/marketing/content.ts",
  "lib/marketing/jsonld.ts",
  "app/page.tsx",
  "app/layout.tsx",
  "app/opengraph-image.tsx",
] as const;

function walk(rel: string, out: string[]): void {
  const full = path.join(ROOT, rel);
  let stat;
  try {
    stat = statSync(full);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(rel);
    return;
  }
  for (const entry of readdirSync(full)) walk(path.join(rel, entry), out);
}

const MARKETING_SOURCES: ReadonlyArray<{ file: string; src: string }> = (() => {
  const files: string[] = [];
  for (const root of MARKETING_ROOTS) walk(root, files);
  return files.map((file) => ({ file, src: readFileSync(path.join(ROOT, file), "utf8") }));
})();

/**
 * Retired needles, ASSEMBLED FROM PARTS so this file never contains one.
 *
 * WRITING THEM OUT WOULD BE THE DEFECT THE TEST EXISTS TO CATCH. A retired
 * sentence spelled in full here is a retired sentence back in the repository as
 * searchable current text — and the first draft of this file did exactly that in
 * its own anti-vacuity samples while asserting elsewhere that no such text
 * survives. Joining fragments at runtime gives the matcher the real string while
 * leaving no contiguous copy on disk.
 */
const RETIRED = [
  {
    label: "former heroH1",
    parts: ["remembers", "every treatment"],
    sha256: "74c277654360668f59b27cbb51fcfcaa34c2258b9f7dc3bc59f8ccc50682b890",
  },
  {
    label: "rival-tools claim",
    parts: ["part other", "tools forget"],
    sha256: "40c22797cfed9531f158bc9d75b4f35fb9a766e21e4ea4f21f2250d594c188da",
  },
  {
    label: "former categoryAmbition",
    parts: ["operating system", "for a modern"],
    sha256: "4062ee43720afbb614363f1db9a25540fb4f411e1725fe80fb3bec2355fe65ab",
  },
  {
    label: "former proofLine",
    parts: ["Built around", "real electrolysis workflows"],
    sha256: "f138dca97bc8f0be6c2544946bf55fe3ef399cace8c85bdc2a834ff407b01422",
  },
] as const;

const needle = (parts: ReadonlyArray<string>): string => parts.join(" ").toLowerCase();

describe("v2.2 retires strings from THE WHOLE MARKETING SURFACE", () => {
  it("reads a non-trivial set of marketing sources", () => {
    // Without this, a bad root list would make every absence check below pass by
    // scanning nothing at all.
    expect(MARKETING_SOURCES.length).toBeGreaterThan(10);
    const files = MARKETING_SOURCES.map((s) => s.file);
    for (const required of REQUIRED_IN_CENSUS) {
      expect(files, `${required} is not being censused`).toContain(required);
    }
  });

  it("no retired line survives in any marketing source, comments included", () => {
    // RAW BYTES, so a retired line parked in a comment counts. A comment is a
    // line an edit can paste back, and a stale-copy scan that strips comments
    // cannot see it either.
    const offenders: string[] = [];
    for (const { file, src } of MARKETING_SOURCES) {
      const hay = src.toLowerCase();
      for (const { label, parts } of RETIRED) {
        if (hay.includes(needle(parts))) offenders.push(`${file} (${label})`);
      }
    }
    expect(offenders, `retired copy still present: ${offenders.join(", ")}`).toEqual([]);
  });

  it("ANTI-VACUITY — each needle matches an INDEPENDENTLY pinned digest", () => {
    // THE PREVIOUS CONTROL PROVED NOTHING, and the flaw is worth stating because
    // it is the exact failure this test exists to prevent. It built the haystack
    // from `parts.join(" ")` and then searched it for `needle(parts)` — the same
    // value on both sides. A mistyped fragment therefore matched its own typo
    // and passed, so the guard could go silently blind to a retired line while
    // reporting that it was watching for it.
    //
    // The reference is now independent of the value under test: a sha256 pinned
    // when the retired line was read from the deck. A typo in `parts` changes the
    // joined string, changes its digest, and fails HERE — before the absence
    // check has a chance to pass vacuously.
    //
    // A digest rather than the sentence, deliberately: it is a one-way
    // encoding, so pinning it does NOT put the retired copy back into the
    // repository as searchable text. That is the whole reason this file uses
    // fragments at all.
    for (const { label, parts, sha256 } of RETIRED) {
      const joined = parts.join(" ");
      expect(
        createHash("sha256").update(joined).digest("hex"),
        `the ${label} needle does not match its pinned digest — a fragment was ` +
          `edited, so the absence check above is no longer watching that line`,
      ).toBe(sha256);
    }
    // And the pins are distinct, so a copy-paste of one digest across two
    // entries cannot hide a wrong fragment behind a right one.
    expect(new Set(RETIRED.map((r) => r.sha256)).size).toBe(RETIRED.length);
    expect(RETIRED.length).toBe(4);
  });

  it("the retired keys are gone as KEYS, not merely as values", () => {
    expect("categoryAmbition" in POSITIONING).toBe(false);
    expect("heroSupporting" in POSITIONING).toBe(false);
  });

  it("no retired copy reaches any route's title or description", () => {
    for (const page of MARKETING_PAGES) {
      const meta = `${page.title ?? ""} ${page.description ?? ""}`.toLowerCase();
      for (const { label, parts } of RETIRED) {
        expect(meta, `${page.path} metadata carries the ${label}`).not.toContain(needle(parts));
      }
    }
  });

  it("STRUCTURED DATA derives its description from the route, not a second copy", () => {
    // The specific defect: jsonld.ts held its own homepage description, so
    // updating the route metadata left structured data emitting retired copy.
    // Asserted on the built object, not the source, so a reintroduced literal
    // fails even if it is spelled differently.
    const ld = softwareApplicationLd() as { description?: string };
    const home = MARKETING_PAGES.find((p) => p.path === "/");
    expect(ld.description).toBe(home?.description);
    for (const { parts } of RETIRED) {
      expect((ld.description ?? "").toLowerCase()).not.toContain(needle(parts));
    }
  });
});

describe("v2.2 hero and CTA constants are the deck's, verbatim", () => {
  it("pins the hero triple", () => {
    expect(POSITIONING.heroEyebrow).toBe("Electrolysis practice software");
    expect(POSITIONING.heroH1).toBe("Start the next treatment where the last one ended.");
    expect(POSITIONING.heroSub).toBe(
      "Each treated area keeps its own history. Before a returning client sits down, " +
        "Hone brings forward last time's settings, response and notes.",
    );
  });

  it("pins both CTAs, and the secondary's destination with its label", () => {
    expect(WALKTHROUGH.primaryLabel).toBe("Request a walkthrough");
    expect(WALKTHROUGH.secondaryLabel).toBe("See how treatment memory works");
    // A control may only promise what its destination delivers: this label names
    // treatment memory, so it must land on the treatment-memory page and not on
    // a homepage anchor.
    expect(WALKTHROUGH.secondaryHref).toBe("/features/treatment-memory");
    const target = MARKETING_PAGES.find((p) => p.path === WALKTHROUGH.secondaryHref);
    expect(target, "the secondary CTA points at a route that is not declared").toBeTruthy();
  });

  it("STATES NO DURATION, on any surface v2.2 governs", () => {
    // v2.2 states no walkthrough length anywhere, so no constant this lane owns
    // may promise one. `demoHeading` is /demo page copy (deck §9) and is NOT in
    // this lane — it still carries a duration and is reported as an open item
    // rather than silently rewritten here.
    for (const key of ["primaryLabel", "primaryLabelShort", "secondaryLabel"] as const) {
      expect(WALKTHROUGH[key], `${key} promises a duration`).not.toMatch(/\d+\s*-?\s*minute/i);
    }
    for (const page of MARKETING_PAGES) {
      expect(
        `${page.title ?? ""} ${page.description ?? ""}`,
        `${page.path} metadata promises a duration`,
      ).not.toMatch(/\d+\s*-?\s*minute/i);
    }
  });
});

describe("v2.2 claim constants carry their register obligations", () => {
  it("naming payments obliges the qualifier to exist and be renderable", () => {
    // THE ONE OBLIGATION A CONSTANT CANNOT ENFORCE ALONE. The truth register
    // permits describing payments only WITH "Payments are enabled during guided
    // onboarding", because card on file is LIVE_WITH_GUIDED_SETUP. This asserts
    // the pairing is available; the surface that renders the list must render
    // the qualifier with it.
    expect(POSITIONING.everyPlanIncludes).toContain("payments");
    expect(PAYMENT_QUALIFIER).toBe("Payments are enabled during guided onboarding.");
  });

  it("the no-caps line claims only the absence that was verified", () => {
    // Verified as an absence across application code, the migration set and the
    // truth register. It must claim no MORE than that — in particular it must
    // not promise unlimited anything, which would be a different claim about
    // capacity rather than about plan gating.
    expect(POSITIONING.noCapsLine).toBe(
      "Every plan includes the full treatment workflow. No client caps. No appointment caps.",
    );
    expect(POSITIONING.noCapsLine).not.toMatch(/unlimited/i);
  });

  it("the film label is carried verbatim, because it is burned into the video", () => {
    // A restyled label would no longer match the frames, and the deck
    // standardises on this exact wording so no recut is needed.
    expect(POSITIONING.demoDataLabel).toBe("Demo data. Actual Hone application.");
    expect(POSITIONING.demoDataLabel).not.toContain("·");
  });

  it("every new line obeys the deck's house style", () => {
    const authored = [
      POSITIONING.heroH1,
      POSITIONING.heroSub,
      POSITIONING.proofLine,
      POSITIONING.trustStrip,
      POSITIONING.assuranceLine,
      POSITIONING.noCapsLine,
      POSITIONING.everyPlanIncludes,
      POSITIONING.walkthroughHeading,
      POSITIONING.filmClosingLine,
      POSITIONING.demoDataLabel,
    ];
    for (const line of authored) {
      // "No em dashes anywhere on the site."
      expect(line, `"${line}" contains an em dash`).not.toContain("—");
      // Banned vocabulary: never patient, clinic, platform, operating system.
      expect(line.toLowerCase()).not.toMatch(/\bpatients?\b|\bclinics?\b|\bplatform\b/);
      expect(line.toLowerCase()).not.toContain("operating system");
    }
  });
});
