import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #244 rewrote the marketing copy in a plainer, human, practitioner-
// first voice (pilot feedback: the site read like an AI-generated SaaS
// homepage). The public category phrase is "Treatment memory for
// electrologists." AI / agentic language is out of the main pitch and
// the hero; treatment memory and records are the lead story. These pins
// keep that positioning, the required sections, the demo-data-only
// discipline, the absence of medical / compliance / AI overclaims, and
// the human-copy cleanup (no SaaS / startup filler words) from eroding.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE_RAW = read("app/page.tsx");
// JSX wraps text across source lines; collapse whitespace so
// multi-word phrase pins match the way the text actually renders.
const PAGE = PAGE_RAW.replace(/\s+/g, " ");
// Hero text only (excludes the file-level comment and later sections),
// so "no AI in the hero" pins check the rendered hero, not source notes.
const HERO = PAGE_RAW
  .slice(PAGE_RAW.indexOf("function Hero("), PAGE_RAW.indexOf("function HeroVisual("))
  .replace(/\s+/g, " ");
const LAYOUT = read("app/layout.tsx");
const NAV_RAW = read("app/_components/marketingNav.ts");
const NAV = NAV_RAW.replace(/\s+/g, " ");
const HEADER = read("app/_components/MarketingHeader.tsx");
const FOOTER = read("app/_components/MarketingFooter.tsx");

describe("category positioning", () => {
  it("leads with the treatment-memory-for-electrologists category phrase", () => {
    expect(PAGE).toMatch(/Treatment memory for electrologists\./);
    expect(PAGE).toMatch(
      /Hone helps electrologists prepare for returning clients, chart treatment details, and keep cleaner procedure records\./,
    );
    expect(PAGE).toMatch(
      /Your calendar knows who is coming\. Hone helps you remember what matters\./,
    );
    expect(PAGE).toMatch(/Book a walkthrough/);
    expect(PAGE).toMatch(/See how it works/);
    // The category phrase also anchors the footer.
    expect(FOOTER).toMatch(/Treatment memory for electrologists\./);
  });

  it("SEO metadata is the treatment-memory positioning, no AI overclaim", () => {
    expect(LAYOUT).toMatch(/Hone \| Treatment Memory for Electrologists/);
    expect(LAYOUT).toMatch(
      /Hone helps electrologists prepare for returning clients, chart treatment details, and keep cleaner procedure records\./,
    );
    expect(LAYOUT).not.toMatch(/AI.powered|autonomous|diagnos/i);
  });
});

describe("required homepage sections (human rewrite)", () => {
  it("calendar-vs-Hone comparison", () => {
    expect(PAGE).toMatch(
      /Your calendar shows the appointment\. Hone shows what to remember\./,
    );
    expect(PAGE).toMatch(/Most tools stop at the appointment\./);
    expect(PAGE).toMatch(/Calendar-only/);
    expect(PAGE).toMatch(/probe and lot/);
    expect(PAGE).toMatch(/record reminders/);
  });

  it("before / during / after the appointment", () => {
    expect(PAGE).toMatch(/Before, during, and after the appointment\./);
    expect(PAGE).toMatch(
      /Open the client before they sit down\. Hone shows the last treatment, what to watch, and what you wrote for next time\./,
    );
    expect(PAGE).toMatch(
      /Chart the treatment area, probe, lot, tolerance, reaction, and aftercare while it is fresh\./,
    );
    expect(PAGE).toMatch(
      /Keep the procedure record, lot history, and follow-up notes in one place\./,
    );
  });

  it("what Hone remembers (compact proof cards, charting included)", () => {
    expect(PAGE).toMatch(/What Hone remembers\./);
    expect(PAGE).toMatch(
      /Before the client sits down, Hone shows the last treatment, caution notes, and what to record today\./,
    );
    expect(PAGE).toMatch(/Charting/);
    expect(PAGE).toMatch(
      /Pull one client&apos;s procedure record without digging through notebooks\./,
    );
    // Daily Prep Brief described in plain words (no "no AI model call").
    expect(PAGE).toMatch(/Daily Prep Brief is simple on purpose\./);
  });

  it("records and lot traceability, with the responsibility caveat + a record visual", () => {
    expect(PAGE).toMatch(/Pull the record when you need it\./);
    expect(PAGE).toMatch(
      /Choose the client, review the record, and print it\./,
    );
    expect(PAGE).toMatch(/lot traceability/i);
    expect(PAGE).toMatch(
      /studios remain responsible for meeting local public-health requirements\./,
    );
    // Visual proof: the printable procedure-record mockup with demo data.
    expect(PAGE).toMatch(/Procedure record/);
    expect(PAGE).toMatch(/Print this client&apos;s procedure record/);
    expect(PAGE).toMatch(/Aftercare/);
    expect(PAGE).toMatch(/Marked/);
    expect(PAGE).toMatch(/Sterex · L-204/);
  });

  it("smarter prep without autopilot (plain copy + a daily-prep visual)", () => {
    expect(PAGE).toMatch(/Smarter prep, without autopilot\./);
    expect(PAGE).toMatch(
      /Better records come first\. Once the treatment history is there, Hone can help pull together the day: who needs review, what is missing, and what you wrote for next time\./,
    );
    // The single, plain safety line (docs/22 boundary in human words).
    expect(PAGE).toMatch(
      /Future smart features should help with prep and drafts\. They should not diagnose, recommend treatment settings, send messages, charge cards, or change records without you\./,
    );
    // Visual proof: the live, rules-based Daily Prep "tomorrow morning" brief.
    expect(PAGE).toMatch(/Tomorrow morning/);
    expect(PAGE).toMatch(/Based on recorded Hone data\./);
    expect(PAGE).toMatch(/Intake not reviewed/);
    // The old internal-policy section is gone from the public site.
    expect(PAGE).not.toMatch(/Agentic support, but practitioner-controlled\./);
    expect(PAGE).not.toMatch(/Assistant, not decider/);
    expect(PAGE).not.toMatch(/safe agentic workflows possible/);
    expect(PAGE).not.toMatch(/No autonomous clinical decisions/);
  });

  it("privacy / trust section with true claims only", () => {
    expect(PAGE).toMatch(/Your client records should stay yours\./);
    expect(PAGE).toMatch(/Studio data stays isolated\./);
    expect(PAGE).toMatch(/No AI training on practitioner or client records\./);
  });

  it("pricing + walkthrough CTA section", () => {
    expect(PAGE).toMatch(/Founding pilot\./);
    expect(PAGE).toMatch(/\$19/);
    expect(PAGE).toMatch(/\/month/);
    expect(PAGE).toMatch(/Cancel anytime/);
    expect(PAGE).toMatch(/Export your data/);
    expect(PAGE).toMatch(/See if Hone fits your studio\./);
    expect(PAGE).toMatch(/Book a 15-minute walkthrough/);
    expect(PAGE).toMatch(
      /Bring one real treatment workflow\. We will walk through how Hone handles the appointment, charting, treatment memory, and records\./,
    );
  });
});

describe("structure: eight sections, no AI-policy bloat", () => {
  it("renders eight content sections (Hero plus seven shells)", () => {
    const shells = (PAGE_RAW.match(/<SectionShell/g) ?? []).length;
    expect(shells).toBe(7);
    expect(PAGE_RAW).toMatch(/<Hero \/>/);
  });
});

describe("human copy: no SaaS / startup / AI-led filler", () => {
  it("the hero does not lead with AI or agentic language", () => {
    expect(HERO).not.toMatch(/\bAI\b/);
    expect(HERO).not.toMatch(/agentic/i);
    expect(HERO).not.toMatch(/autonomous clinical decisions/i);
    expect(HERO).not.toMatch(/operating memory layer/i);
  });

  it("drops the SaaS / startup filler vocabulary", () => {
    expect(PAGE).not.toMatch(/operating memory layer/i);
    expect(PAGE).not.toMatch(/agentic practice support/i);
    expect(PAGE).not.toMatch(/AI.powered/i);
    expect(PAGE).not.toMatch(/intelligent assistant/i);
    expect(PAGE).not.toMatch(/seamless/i);
    expect(PAGE).not.toMatch(/\bempower/i);
    expect(PAGE).not.toMatch(/\boptimize/i);
    expect(PAGE).not.toMatch(/next.generation/i);
    expect(PAGE).not.toMatch(/all.in.one/i);
    expect(PAGE).not.toMatch(/\bunlock\b/i);
    expect(PAGE).not.toMatch(/transform your workflow/i);
    expect(PAGE).not.toMatch(/cutting.edge/i);
    expect(PAGE).not.toMatch(/leverage/i);
  });
});

describe("navigation and CTAs", () => {
  it("the Book walkthrough CTA links to /demo", () => {
    expect(NAV).toMatch(/href: "\/demo", label: "Book walkthrough"/);
    expect(HEADER).toMatch(/MARKETING_CTA\.href/);
  });

  it("Sign in is reachable in the nav", () => {
    expect(NAV).toMatch(/href: "\/login", label: "Sign in"/);
  });

  it("the nav is short and human: Product, Records, Pricing, Sign in", () => {
    for (const id of ["product", "records"]) {
      expect(NAV).toMatch(new RegExp(`href: "/#${id}"`));
      expect(PAGE).toMatch(new RegExp(`id="${id}"`));
    }
    // The Agentic support nav item was dropped.
    expect(NAV).not.toMatch(/label: "Agentic support"/);
    expect(NAV).not.toMatch(/href: "\/#agentic"/);
    expect(NAV).not.toMatch(/how-it-works/);
  });
});

describe("demo data discipline", () => {
  it("uses only anonymized demo data", () => {
    expect(PAGE).toMatch(/Maya R\./);
    expect(PAGE).toMatch(/Demo Studio/);
    expect(PAGE).toMatch(/L-204/);
  });

  it("never uses real pilot names or real client data", () => {
    expect(PAGE_RAW).not.toMatch(/chloe|laura|willow/i);
    expect(PAGE_RAW).not.toMatch(/@gmail|@hone\.care/i);
    expect(PAGE_RAW).not.toMatch(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/);
  });
});

describe("no forbidden medical / compliance / AI overclaims", () => {
  it("makes no compliance or medical-grade claim", () => {
    expect(PAGE).not.toMatch(/HIPAA/i);
    expect(PAGE).not.toMatch(/public.?health certified/i);
    expect(PAGE).not.toMatch(/medical.?grade/i);
    expect(PAGE).not.toMatch(/medical advice/i);
    expect(PAGE).not.toMatch(/guaranteed compliance|compliance guaranteed/i);
  });

  it("makes no autonomous / replacement / AI-treatment claim", () => {
    expect(PAGE).not.toMatch(/self.driving/i);
    expect(PAGE).not.toMatch(/fully autonomous/i);
    expect(PAGE).not.toMatch(/replaces? (the )?practitioner/i);
    expect(PAGE).not.toMatch(/AI.powered treatment|AI treatment recommendation/i);
    expect(PAGE).not.toMatch(/automatically decides/i);
    expect(PAGE).not.toMatch(/never forget/i);
  });

  it("does not claim live payments are active", () => {
    expect(PAGE).not.toMatch(/payments are (live|active)|live payments are|accept payments|process payments/i);
  });
});
