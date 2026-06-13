import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #242: marketing site repositioned around treatment memory. These
// pins keep the category positioning, the required sections, the
// agentic safety language (aligned with docs/22), the demo-data-only
// discipline, and the absence of medical / compliance / AI overclaims
// from eroding. Source pins on the homepage + shared header/nav +
// SEO metadata.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE_RAW = read("app/page.tsx");
// JSX wraps text across source lines; collapse whitespace so
// multi-word phrase pins match the way the text actually renders.
const PAGE = PAGE_RAW.replace(/\s+/g, " ");
const LAYOUT = read("app/layout.tsx");
const NAV_RAW = read("app/_components/marketingNav.ts");
const NAV = NAV_RAW.replace(/\s+/g, " ");
const HEADER = read("app/_components/MarketingHeader.tsx");

describe("category positioning", () => {
  it("leads with treatment memory for permanent hair removal studios", () => {
    expect(PAGE).toMatch(/Treatment memory for permanent hair removal studios\./);
    expect(PAGE).toMatch(/operating memory layer/);
    expect(PAGE).toMatch(/Book a walkthrough/);
    expect(PAGE).toMatch(/See how treatment memory works/);
    expect(PAGE).toMatch(/No autonomous treatment decisions\./);
  });

  it("SEO metadata is the treatment-memory positioning, no AI overclaim", () => {
    expect(LAYOUT).toMatch(/Hone \| Treatment Memory for Electrologists/);
    expect(LAYOUT).toMatch(
      /Hone helps permanent hair removal studios prepare for appointments, chart treatment details, and keep procedure records clean\./,
    );
    expect(LAYOUT).not.toMatch(/AI.powered|autonomous|diagnos/i);
  });
});

describe("required homepage sections", () => {
  it("calendar-vs-Hone comparison", () => {
    expect(PAGE).toMatch(/Your calendar does not remember what happened last time\./);
    expect(PAGE).toMatch(/Calendar-only/);
    expect(PAGE).toMatch(/Calendar-only gives you the appointment\. Hone gives you the memory\./);
  });

  it("Before Today section", () => {
    expect(PAGE).toMatch(/Start every returning appointment with context\./);
    expect(PAGE).toMatch(/Remember today/);
    expect(PAGE).toMatch(/Client response \(last recorded\)/);
  });

  it("Daily Prep Brief section (live, rules-based)", () => {
    expect(PAGE).toMatch(/Know what needs attention before the day starts\./);
    expect(PAGE).toMatch(/Daily Prep Brief uses recorded Hone data/);
    expect(PAGE).toMatch(/Rules-based today: no AI model call required for V1\./);
    expect(PAGE).toMatch(/Action: Review Before Today/);
  });

  it("charting section", () => {
    expect(PAGE).toMatch(/Chart once\. Reuse the memory next time\./);
    expect(PAGE).toMatch(/risks explained and aftercare provided stamp/);
  });

  it("Record Keeping section with the responsibility caveat", () => {
    expect(PAGE).toMatch(/Procedure records without scrambling before inspection\./);
    expect(PAGE).toMatch(/lot traceability/);
    expect(PAGE).toMatch(
      /studios remain responsible for meeting local public-health requirements\./,
    );
  });

  it("mobile / iPad section", () => {
    expect(PAGE).toMatch(/Built for the device in your hand\./);
    expect(PAGE).toMatch(/phone, iPad, and desktop/);
  });

  it("agentic practice support section", () => {
    expect(PAGE).toMatch(/Built for agentic practice support\./);
    expect(PAGE).toMatch(/not adding a chatbot on top of a calendar/);
    expect(PAGE).toMatch(/Draft-only client communication, reviewed before sending/);
  });

  it("agentic safety language aligned with docs/22", () => {
    expect(PAGE).toMatch(/Agentic, but controlled\./);
    expect(PAGE).toMatch(/Assistant, not decider/);
    expect(PAGE).toMatch(/Draft, not send/);
    expect(PAGE).toMatch(/Flag, not diagnose/);
    expect(PAGE).toMatch(/Summarize recorded history, do not invent/);
    expect(PAGE).toMatch(/No autonomous clinical decisions/);
  });

  it("privacy / trust section with true claims only", () => {
    expect(PAGE).toMatch(/Built carefully for sensitive client records\./);
    expect(PAGE).toMatch(/Your client records stay yours\./);
    expect(PAGE).toMatch(/No AI training on your records\./);
    expect(PAGE).toMatch(/Studio data is isolated\./);
  });

  it("pricing section", () => {
    expect(PAGE).toMatch(/Founding pilot/);
    expect(PAGE).toMatch(/\$19/);
    expect(PAGE).toMatch(/\/month/);
    expect(PAGE).toMatch(/Cancel anytime/);
  });

  it("final CTA", () => {
    expect(PAGE).toMatch(/See if Hone fits your studio\./);
    expect(PAGE).toMatch(/Book a 15-minute walkthrough/);
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

  it("the story-section anchors are homepage-relative", () => {
    for (const id of ["product", "how-it-works", "records", "agentic"]) {
      expect(NAV).toMatch(new RegExp(`href: "/#${id}"`));
      expect(PAGE).toMatch(new RegExp(`id="${id}"`));
    }
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
    // No real email or phone-number patterns in the homepage copy.
    expect(PAGE_RAW).not.toMatch(/@gmail|@hone\.care/i);
    expect(PAGE_RAW).not.toMatch(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/);
  });
});

describe("no forbidden medical / compliance / AI overclaims", () => {
  it("makes no compliance or medical-grade claim", () => {
    expect(PAGE).not.toMatch(/HIPAA/i);
    expect(PAGE).not.toMatch(/public.?health certified/i);
    expect(PAGE).not.toMatch(/medical.?grade/i);
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
    // The product claim is explicitly the memory layer, not payments.
    expect(PAGE).toMatch(/not payment processing\./);
  });
});
