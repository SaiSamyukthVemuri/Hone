import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRICING_PLANS,
  PRICING_ASSURANCES,
  PAYMENT_QUALIFIER,
} from "@/lib/marketing/content";

// ===========================================================================
// MKT-02D — PRICING, DECK v2.2
// ===========================================================================
//
// The deck is the source for WHAT is said; the truth register is the source for
// WHETHER it may be said. Where they disagreed, the register won and the gap is
// recorded in the page rather than quietly closed — see the comment above the
// lede about the two caps sentences.
//
// These guards are written against the RENDERED SOURCE with comments stripped,
// because a rule that a comment can satisfy is not a rule. The existing
// marketing-pricing suite already covers CAD, the three plan ids, the stale
// $19/$149 framing, Google Calendar and self-service activation; this file adds
// only what v2.2 changed.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
/**
 * Remove comments WITHOUT corrupting string literals.
 *
 * The previous version stripped only whole-line comments (`/^\\s*\\/\\//`), so a
 * TRAILING one survived — and `a: "No setup fee.", // contract` would have made
 * the FAQ guard see the topic as answered, recreating the exact
 * comment-satisfies-the-rule defect that guard exists to prevent.
 *
 * Stripping `//` naively is not the fix either: these files contain URLs, and
 * `https://…` would lose its tail. So this tracks string state and only treats
 * `//` as a comment when it is not inside one.
 */
function strip(src: string): string {
  let out = "";
  let quote: string | null = null;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote !== null) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const PRICING = strip(read("app/pricing/page.tsx")).replace(/\s+/g, " ");
const HOME = strip(read("app/page.tsx")).replace(/\s+/g, " ");
const CONTENT = strip(read("lib/marketing/content.ts")).replace(/\s+/g, " ");

describe("v2.2 headline and seat lines", () => {
  it("leads with the plans headline, not the old pricing one", () => {
    expect(PRICING).toContain("Simple plans, in Canadian dollars.");
    expect(PRICING).not.toContain("Straightforward pricing, in Canadian dollars.");
  });

  it("states the workflow-parity sub", () => {
    expect(PRICING).toContain("Every plan includes the full treatment workflow.");
  });

  it("gives every tier a seat line, and Studio's is the packaged boundary", () => {
    // "Up to three practitioners" is publishable as PACKAGING — the register is
    // explicit that no code enforces the count and that the boundary is honoured
    // during guided onboarding. The solo tiers say one for the same reason.
    const byId = Object.fromEntries(PRICING_PLANS.map((p) => [p.id, p]));
    expect(byId["founding-solo"].seats).toBe("1 practitioner");
    expect(byId["solo"].seats).toBe("1 practitioner");
    expect(byId["studio"].seats).toBe("up to 3 practitioners");
  });

  it("keeps the founding transition exact, both halves", () => {
    // $29 without the $39 successor would be the deal without its condition.
    const t = PRICING_PLANS.find((p) => p.id === "founding-solo")?.transition ?? "";
    expect(t).toContain("CAD $29/month for the first 12 months");
    expect(t).toContain("CAD $39/month while continuously subscribed");
  });
});

describe("no tier is recommended, by word or by styling", () => {
  it("no plan can carry a badge — the field does not exist", () => {
    // Unsayable, not unset. `badge: null` on every plan would leave a one-word
    // data edit between here and a recommendation nobody has evidence for.
    for (const plan of PRICING_PLANS) {
      expect(plan, plan.id).not.toHaveProperty("badge");
    }
    expect(CONTENT).not.toMatch(/badge\s*:\s*string/);
  });

  it("neither surface renders a badge or most-popular marker", () => {
    for (const [name, src] of [
      ["pricing", PRICING],
      ["home", HOME],
    ] as const) {
      expect(src, name).not.toMatch(/most popular/i);
      expect(src, name).not.toMatch(/recommended/i);
      expect(src, name).not.toMatch(/plan\.badge/);
    }
  });

  it("no card is visually emphasised over the others", () => {
    // The badge also drove a mineral border, a frame shadow and a primary CTA
    // variant. Removing the words while keeping the emphasis would still
    // recommend a tier — just without saying so.
    expect(PRICING).not.toMatch(/featured/);
    expect(PRICING).not.toMatch(/mk-shadow-frame/);
    expect(HOME).not.toMatch(/featured/);
  });
});

describe("the assurance line under the cards", () => {
  it("carries exactly the four v2.2 assurances", () => {
    expect([...PRICING_ASSURANCES]).toEqual([
      "Founder-led setup",
      "Free standard client import",
      "No setup fee",
      "Cancel anytime",
    ]);
  });

  it("no marketing surface publishes the unsourced contract claim", () => {
    // WIDENED, and the earlier narrow version was wrong. I first scoped this to
    // the assurance constant on the reasoning that the FAQ's "no contract" was
    // pre-existing copy the deck had not touched. That left `/` and the FAQ
    // still publishing the exact claim this change drops as unsourced, which
    // review caught on the homepage — and the same argument applied to the FAQ
    // one section below. Dropping a claim in one place and keeping it in two is
    // not a narrower change, it is an inconsistent one.
    //
    // Whitespace-normalised because the homepage instance was split across a
    // source line break ("no setup fee, no\ncontract") and survived an exact
    // phrase search.
    const flat = (s: string) => s.replace(/\s+/g, " ");
    expect(PRICING_ASSURANCES.join(" | ")).not.toMatch(/no contract/i);
    expect(flat(PRICING)).not.toMatch(/no contract/i);
    expect(flat(HOME)).not.toMatch(/no contract/i);
    expect(flat(CONTENT)).not.toMatch(/no contract/i);
  });
});

describe("the FAQ answers what it asks", () => {
  // THE GENERAL SHAPE OF FOUR DEFECTS IN THIS PR. Each time, a string changed
  // and something that REFERRED to it did not: the badge and its browser spec,
  // the H1 and a second spec, the assurance constant and two hardcoded copies,
  // and then this — an answer edited without reading its own question.
  //
  // This asserts the one pair that is mechanically checkable: the page must not
  // RAISE a topic it has stopped answering. It is narrow on purpose; a general
  // "every answer addresses its question" rule is not decidable here.
  const FAQ_BLOCK = (() => {
    // COMMENTS STRIPPED FIRST. Written without this, the guard read raw source
    // and the explanatory comment above the question — which necessarily says
    // the word "contract" — satisfied the very check it was documenting. A
    // mutation control caught it: restoring the over-broad question still
    // passed. This file's own header says a rule a comment can satisfy is not
    // a rule, and the first draft was exactly that.
    const raw = strip(read("app/pricing/page.tsx"));
    const start = raw.indexOf("const FAQ:");
    expect(start, "the FAQ array exists").toBeGreaterThan(-1);
    return raw.slice(start, raw.indexOf("\n];", start));
  })();

  const questions = [...FAQ_BLOCK.matchAll(/^\s*q:\s*"([^"]+)"/gm)].map((m) => m[1]);
  // NOT a symmetric parse: one answer is a shared constant (`a: REPLACES_STATEMENT`)
  // rather than a literal, so counting quoted answers would under-count and an
  // equal-length assertion would fail on correct code. The answer SIDE is
  // therefore everything in the block that is not a question line, which covers
  // literals and leaves constants visible by name.
  const answerSide = FAQ_BLOCK.replace(/^\s*q:\s*"[^"]*",?$/gm, " ");

  it("parses the questions, so the comparison below means something", () => {
    expect(questions.length).toBeGreaterThan(0);
    expect(answerSide.length).toBeGreaterThan(0);
  });

  it("asks about no topic the answers have stopped covering", () => {
    // `contract` is the live instance. The list is the set of claims this PR
    // withdrew, so withdrawing another one later fails here until its question
    // is narrowed with it.
    for (const topic of ["contract", "most popular", "annual"]) {
      const asked = questions.some((q) => new RegExp(topic, "i").test(q));
      const answered = new RegExp(topic, "i").test(answerSide);
      expect(
        asked && !answered,
        `the FAQ asks about "${topic}" and no answer addresses it`,
      ).toBe(false);
    }
  });
});

describe("payments may be named ONLY with its qualifier", () => {
  it("the qualifier travels in the bullet, not just the paragraph", () => {
    // Standing rule §4 permits the payments claim exclusively WITH "Payments are
    // enabled during guided onboarding". A bullet is the unit that gets
    // screenshotted and excerpted, so adjacency is not compliance.
    const page = read("app/pricing/page.tsx");
    const bullet = page
      .split("\n")
      .find((l) => /Owner-run card payments/.test(l));
    expect(bullet, "the payments bullet exists").toBeTruthy();
    expect(bullet).toContain("PAYMENT_QUALIFIER");
  });

  it("the qualifier itself is unchanged", () => {
    expect(PAYMENT_QUALIFIER).toBe("Payments are enabled during guided onboarding.");
  });
});

describe("v2.2 prohibitions, enforced rather than merely absent today", () => {
  const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
    ["annual pricing", /\bannual(ly)?\b|per year|\/\s*year|yearly/i],
    ["proration", /prorat/i],
    ["automatic renewal mechanics", /auto[- ]?renew|renews automatically|renewal date/i],
    ["billing portal", /billing portal|manage (your )?(subscription|billing)/i],
    ["self-serve subscription", /sign up and pay|subscribe now|start (your )?(free )?trial|self[- ]serve/i],
    ["a two-practitioner tier", /\b(two|2) practitioners?\b/i],
  ];

  for (const [label, re] of FORBIDDEN) {
    it(`the pricing page states no ${label}`, () => {
      expect(PRICING, label).not.toMatch(re);
    });
    it(`the shared content states no ${label}`, () => {
      expect(CONTENT, label).not.toMatch(re);
    });
  }

  it("the plan set is exactly the three v2.2 tiers", () => {
    // A fourth tier appearing is the same defect as a two-practitioner tier
    // appearing, and this catches it whatever it is called.
    expect(PRICING_PLANS.map((p) => p.id)).toEqual([
      "founding-solo",
      "solo",
      "studio",
    ]);
  });
});
