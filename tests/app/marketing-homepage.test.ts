import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #242 repositioned the marketing site around treatment memory;
// PR #243 tightened it to a YC-style landing page (eight sections,
// less repetition, the two agentic sections merged into one). These
// pins keep the category positioning, the required sections, the
// agentic safety language (aligned with docs/22), the demo-data-only
// discipline, and the absence of medical / compliance / AI overclaims
// from eroding.

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
  it("leads with treatment memory and the calendar contrast", () => {
    expect(PAGE).toMatch(/Treatment memory for permanent hair removal studios\./);
    expect(PAGE).toMatch(
      /Hone helps electrologists see what happened last time, chart what matters today, and keep procedure records clean\./,
    );
    expect(PAGE).toMatch(
      /Your calendar tells you who is coming\. Hone tells you what to remember\./,
    );
    expect(PAGE).toMatch(/Book a walkthrough/);
    expect(PAGE).toMatch(/See how it works/);
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

describe("required homepage sections (YC-tightened)", () => {
  it("calendar-vs-Hone comparison", () => {
    expect(PAGE).toMatch(/Your calendar does not remember the treatment\./);
    expect(PAGE).toMatch(/Calendar-only/);
    expect(PAGE).toMatch(/probe and lot/);
    expect(PAGE).toMatch(/record reminders/);
  });

  it("how it works section (before / during / after)", () => {
    expect(PAGE).toMatch(/How Hone fits into the treatment day\./);
    expect(PAGE).toMatch(/Review the memory\./);
    expect(PAGE).toMatch(/Chart the details\./);
    expect(PAGE).toMatch(/Keep the record\./);
  });

  it("product proof section with compact cards", () => {
    expect(PAGE).toMatch(/Built around the details electrologists actually need\./);
    expect(PAGE).toMatch(
      /Before the client sits down, Hone shows the last treatment, caution notes, and what to record today\./,
    );
    expect(PAGE).toMatch(
      /Pull one client&apos;s procedure record without digging through notebooks\./,
    );
    // Daily Prep Brief described live + rules-based (matches PR #241).
    expect(PAGE).toMatch(/Daily Prep Brief · Live/);
    expect(PAGE).toMatch(/Rules-based today, no AI model call\./);
  });

  it("Record Keeping section with the responsibility caveat", () => {
    expect(PAGE).toMatch(/Procedure records without scrambling before inspection\./);
    expect(PAGE).toMatch(/lot traceability/);
    expect(PAGE).toMatch(
      /studios remain responsible for meeting local public-health requirements\./,
    );
  });

  it("agentic support section (support + safety merged into one)", () => {
    expect(PAGE).toMatch(/Agentic support, but practitioner-controlled\./);
    expect(PAGE).toMatch(/That makes safe agentic workflows possible/);
    expect(PAGE).toMatch(/draft-only follow-ups/);
    // No separate "Agentic, but controlled." or "Built for agentic
    // practice support." sections remain.
    expect(PAGE).not.toMatch(/Agentic, but controlled\./);
    expect(PAGE).not.toMatch(/Built for agentic practice support\./);
  });

  it("agentic safety language aligned with docs/22", () => {
    expect(PAGE).toMatch(/Assistant, not decider/);
    expect(PAGE).toMatch(/Draft, not send/);
    expect(PAGE).toMatch(/Flag, not diagnose/);
    expect(PAGE).toMatch(/Summarize recorded history, do not invent/);
    expect(PAGE).toMatch(/Human confirmation before external actions/);
    expect(PAGE).toMatch(/No autonomous clinical decisions/);
  });

  it("privacy / trust section with true claims only", () => {
    expect(PAGE).toMatch(/Built carefully for sensitive client records\./);
    expect(PAGE).toMatch(/Studio data stays isolated\./);
    expect(PAGE).toMatch(/No AI training on practitioner or client records\./);
  });

  it("pricing + CTA section", () => {
    expect(PAGE).toMatch(/Founding pilot\./);
    expect(PAGE).toMatch(/\$19/);
    expect(PAGE).toMatch(/\/month/);
    expect(PAGE).toMatch(/Cancel anytime/);
    expect(PAGE).toMatch(/Book a 15-minute walkthrough/);
    expect(PAGE).toMatch(
      /Bring one real treatment workflow\. We will show how Hone handles the appointment, charting, treatment memory, and records\./,
    );
  });
});

describe("YC tightening: fewer sections, less repetition", () => {
  it("dropped the standalone Daily Prep Brief, charting, and device sections", () => {
    expect(PAGE).not.toMatch(/Know what needs attention before the day starts\./);
    expect(PAGE).not.toMatch(/Chart once\. Reuse the memory next time\./);
    expect(PAGE).not.toMatch(/Built for the device in your hand\./);
  });

  it("the page renders eight content sections (Hero plus seven shells)", () => {
    const shells = (PAGE_RAW.match(/<SectionShell/g) ?? []).length;
    expect(shells).toBe(7);
    expect(PAGE_RAW).toMatch(/<Hero \/>/);
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

  it("the nav is short: Product, Records, Agentic support, Pricing, Sign in", () => {
    for (const id of ["product", "records", "agentic"]) {
      expect(NAV).toMatch(new RegExp(`href: "/#${id}"`));
      expect(PAGE).toMatch(new RegExp(`id="${id}"`));
    }
    // The how-it-works anchor was dropped (no matching section id).
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
