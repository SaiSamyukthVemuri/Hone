import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
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
const CONTENT_SRC = readFileSync(path.join(ROOT, "lib/marketing/content.ts"), "utf8");

/**
 * The retired strings, by the shape a revival would take.
 *
 * DELIBERATELY NOT the full sentences. Writing a retired line out in full here
 * would put it back in the repository as searchable current text, which is the
 * failure this repo has hit before: a correction that quotes the claim it
 * retires reintroduces the claim, and no stale-copy scan can tell an assertion
 * from its denial. Each needle is the distinctive FRAGMENT instead.
 */
const RETIRED_FRAGMENTS = [
  "remembers every treatment",
  "part other tools forget",
  "operating system for a modern",
  "Built around real electrolysis workflows",
] as const;

describe("v2.2 retires strings from the module ENTIRELY, comments included", () => {
  it("no retired fragment survives anywhere in the source", () => {
    // SOURCE, NOT THE EXPORTS. A retired line parked in a comment is a line a
    // future edit can paste back with no test failing, and a stale-copy guard
    // that strips comments would not see it either. So this reads raw bytes.
    for (const fragment of RETIRED_FRAGMENTS) {
      expect(
        CONTENT_SRC.toLowerCase(),
        `the retired line "${fragment}" is still present in lib/marketing/content.ts`,
      ).not.toContain(fragment.toLowerCase());
    }
  });

  it("ANTI-VACUITY — every needle above can actually match something", () => {
    // If a fragment were mistyped, the check above would pass forever. Each one
    // is matched against the line it was taken from.
    const samples = [
      "Electrolysis practice software that remembers every treatment.",
      "The part other tools forget.",
      "The operating system for a modern electrolysis practice.",
      "Built around real electrolysis workflows · Founder-led setup",
    ];
    expect(samples.length).toBe(RETIRED_FRAGMENTS.length);
    RETIRED_FRAGMENTS.forEach((fragment, i) => {
      expect(samples[i].toLowerCase(), `needle ${i} matches nothing`).toContain(
        fragment.toLowerCase(),
      );
    });
  });

  it("the retired category ambition is gone as a KEY, not merely as a value", () => {
    // The deck conditions deleting it on nothing internal reading it. A key left
    // in place with a softened value is the "cut, not softened" rule broken.
    expect("categoryAmbition" in POSITIONING).toBe(false);
    expect("heroSupporting" in POSITIONING).toBe(false);
    expect(CONTENT_SRC).not.toMatch(/^\s*categoryAmbition:/m);
  });

  it("no retired copy reaches any route's title or description", () => {
    for (const page of MARKETING_PAGES) {
      for (const fragment of RETIRED_FRAGMENTS) {
        expect(`${page.title ?? ""} ${page.description ?? ""}`.toLowerCase()).not.toContain(
          fragment.toLowerCase(),
        );
      }
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
