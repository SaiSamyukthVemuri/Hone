import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  POSITIONING,
  WALKTHROUGH,
  PRICING_PLANS,
} from "@/lib/marketing/content";

// Flagship marketing homepage (rebuild). Category: electrolysis practice
// software; differentiator: treatment memory; one conversion: the founder-led
// walkthrough (a lead-capture *request*, never a "book"). Copy-critical
// constants live in lib/marketing/content.ts (pinned by content.test.ts); these
// pins guard the homepage's structure, its inline copy, the demo-data-only
// discipline, and the absence of overclaims / fake proof / stale pilot pricing.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE = read("app/page.tsx");
const VISUAL = read("app/_components/marketing/visuals/TreatmentMemoryPanel.tsx");
const HEADER = read("app/_components/marketing/SiteHeader.tsx");
const FOOTER = read("app/_components/marketing/SiteFooter.tsx");
const MOBILE = read("app/_components/marketing/MobileNav.tsx");
const LAYOUT = read("app/layout.tsx");
const CSS = read("app/globals.css");

// Strip source comments so language scans check RENDERED copy, not the
// explanatory comments (which legitimately name excluded things like Google
// Calendar). Removes /* … */ (incl. JSX {/* … */}) and whole-line // comments.
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

// The homepage-specific rendered surface (whitespace-collapsed) for scans.
const SURFACE = [PAGE, VISUAL, HEADER, FOOTER, MOBILE]
  .map(stripComments)
  .join("\n")
  .replace(/\s+/g, " ");

describe("positioning: category + treatment-memory differentiator", () => {
  it("hero is not the eyebrow==H1 duplication of the old site", () => {
    expect(POSITIONING.heroEyebrow).toBe("Electrolysis practice software");
    expect(POSITIONING.heroH1).toBe(
      "Electrolysis practice software that remembers every treatment.",
    );
    expect(POSITIONING.heroEyebrow).not.toBe(POSITIONING.heroH1);
  });

  it("the homepage consumes the shared positioning + CTA constants", () => {
    expect(PAGE).toMatch(/POSITIONING\.heroEyebrow/);
    expect(PAGE).toMatch(/POSITIONING\.heroH1/);
    expect(PAGE).toMatch(/POSITIONING\.differentiationLine/);
    expect(PAGE).toMatch(/WALKTHROUGH\.primaryLabel/);
    // "Request", never "Book", as the walkthrough verb.
    expect(WALKTHROUGH.primaryLabel).toMatch(/^Request /);
  });

  it("keeps the category phrase in supporting copy + footer", () => {
    expect(PAGE).toMatch(/POSITIONING\.keepPhrase/);
    expect(FOOTER).toMatch(/POSITIONING\.keepPhrase/);
    expect(POSITIONING.keepPhrase).toBe("Treatment memory for electrologists");
  });

  it("metadata is wired through the shared per-page helper", () => {
    expect(PAGE).toMatch(/marketingMetadata\("\/"\)/);
    expect(PAGE).toMatch(/export const metadata/);
  });
});

describe("required homepage sections", () => {
  it("has the dark calendar-vs-Hone narrative band", () => {
    expect(PAGE).toMatch(/Calendar vs Hone/);
    expect(PAGE).toMatch(/Most tools stop at the appointment\./);
    expect(PAGE).toMatch(/A calendar shows/);
    expect(PAGE).toMatch(/Hone also carries/);
  });

  it("has the full six-step workflow progression", () => {
    for (const step of [
      "Get booked",
      "Collect intake and consent",
      "Prepare before the visit",
      "Chart the treatment",
      "Follow up professionally",
      "Remember it next time",
    ]) {
      expect(PAGE).toMatch(new RegExp(step));
    }
  });

  it("has the treatment-memory differentiator section linking to the feature page", () => {
    expect(PAGE).toMatch(/The part other tools forget\./);
    expect(PAGE).toMatch(/href="\/features\/treatment-memory"/);
  });

  it("has a CAD pricing teaser driven by the shared plans (no $19 pilot)", () => {
    expect(PAGE).toMatch(/PRICING_PLANS/);
    expect(PAGE).toMatch(/href="\/pricing"/);
    // The shared plans are CAD; the old $19 pilot is gone from the page.
    expect(PRICING_PLANS.every((p) => p.priceLabel === null || /^CAD /.test(p.priceLabel))).toBe(true);
    expect(SURFACE).not.toMatch(/\$19\b/);
  });

  it("has an evidence-backed trust section with the payment qualifier + policy link", () => {
    expect(PAGE).toMatch(/Studio data stays isolated/);
    expect(PAGE).toMatch(/No advertising use of health records/);
    expect(PAGE).toMatch(/No AI training on your records/);
    expect(PAGE).toMatch(/Payments are enabled during guided onboarding\./);
    expect(PAGE).toMatch(/href="\/privacy"/);
  });

  it("closes on the walkthrough conversion", () => {
    expect(PAGE).toMatch(/See if Hone fits your studio\./);
    expect(PAGE).toMatch(/reply within\s+one business day/);
  });
});

describe("CTA truthfulness: request, never book", () => {
  it("uses no 'Book … walkthrough' CTA anywhere on the surface", () => {
    expect(SURFACE).not.toMatch(/Book (a|the|your|a 15-minute)[^.]*walkthrough/i);
    expect(SURFACE).not.toMatch(/Book a 15-minute/i);
  });
});

describe("motion is reduced-motion safe + no horizontal overflow", () => {
  it("main clips horizontal overflow", () => {
    expect(PAGE).toMatch(/overflow-x-hidden/);
  });
  it("the reveal + signature animation collapse under prefers-reduced-motion", () => {
    expect(CSS).toMatch(/prefers-reduced-motion: reduce/);
    expect(CSS).toMatch(/\[data-mreveal="0"\]/);
    expect(CSS).toMatch(/\[data-assemble\]/);
    expect(CSS).toMatch(/\[data-thread\]/);
  });
});

describe("demo-data discipline", () => {
  it("uses only anonymized demo data in the product visual", () => {
    expect(VISUAL).toMatch(/Maya R\./);
    expect(VISUAL).toMatch(/L-204/);
  });
  it("never uses real pilot names, emails, or phone numbers", () => {
    expect(SURFACE).not.toMatch(/chloe|laura|willow/i);
    expect(SURFACE).not.toMatch(/@gmail|@hone\.care/i);
    expect(SURFACE).not.toMatch(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/);
  });
  it("renders no images (no fake screenshots or customer logos)", () => {
    expect(SURFACE).not.toMatch(/<img\b/i);
    expect(SURFACE).not.toMatch(/logo wall|as seen (in|on)|customer logos?/i);
  });
});

describe("no forbidden language / overclaims", () => {
  it("drops SaaS / startup filler (prompt §4)", () => {
    for (const banned of [
      /all.in.one/i,
      /AI.powered/i,
      /\bseamless\b/i,
      /next.generation/i,
      /\bempower/i,
      /\bleverage\b/i,
      /\bsupercharge\b/i,
      /revolutionary/i,
      /world.class/i,
      /best.in.class/i,
      /\bunlock\b/i,
      /cutting.edge/i,
    ]) {
      expect(SURFACE).not.toMatch(banned);
    }
  });

  it("makes no autonomous / AI-treatment / diagnosis claim", () => {
    for (const banned of [
      /agentic/i,
      /autonomous/i,
      /self.driving/i,
      /diagnos/i,
      /recommend treatment/i,
      /never forget/i,
      /AI.powered treatment/i,
    ]) {
      expect(SURFACE).not.toMatch(banned);
    }
  });

  it("makes no compliance / medical-grade claim", () => {
    for (const banned of [
      /HIPAA/i,
      /medical.?grade/i,
      /medical advice/i,
      /guaranteed compliance|compliance guaranteed/i,
      /\bSOC ?2\b/i,
      /PIPEDA.certified/i,
    ]) {
      expect(SURFACE).not.toMatch(banned);
    }
  });

  it("makes no live-payment-active or self-service-activation claim", () => {
    expect(SURFACE).not.toMatch(/payments are (live|active)/i);
    expect(SURFACE).not.toMatch(/turn on (live )?payments yourself/i);
  });

  it("never markets Google Calendar (DORMANT)", () => {
    expect(SURFACE).not.toMatch(/google calendar/i);
    expect(SURFACE).not.toMatch(/calendar sync/i);
  });

  it("makes no fake social proof or fabricated counts", () => {
    expect(SURFACE).not.toMatch(/trusted by (thousands|hundreds|millions|\d)/i);
    expect(SURFACE).not.toMatch(/\btestimonial/i);
    expect(SURFACE).not.toMatch(/customers? love/i);
    expect(SURFACE).not.toMatch(/\d+\s?(\+|k)?\s?(studios|users|customers|practitioners) (use|trust|love)/i);
  });

  it("layout metadata carries no AI overclaim", () => {
    expect(LAYOUT).not.toMatch(/AI.powered|autonomous|diagnos/i);
  });
});
