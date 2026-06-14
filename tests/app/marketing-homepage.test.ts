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
  it("calendar-vs-Hone comparison (appointment card vs treatment-memory card)", () => {
    expect(PAGE).toMatch(
      /Your calendar shows the appointment\. Hone shows what to remember\./,
    );
    expect(PAGE).toMatch(
      /Most tools stop at the appointment\. Hone shows the details that matter when a client comes back\./,
    );
    // Micro-context labels make the contrast immediately readable.
    expect(PAGE).toMatch(/Calendar-only/);
    expect(PAGE).toMatch(/Appointment data/);
    expect(PAGE).toMatch(/Treatment memory/);
    // Left card: a plain appointment (time / client / service / status).
    expect(PAGE).toMatch(/10:00 AM/);
    expect(PAGE).toMatch(/Electrolysis/);
    expect(PAGE).toMatch(/Confirmed/);
    // Right (Hone) card echoes Before Today: band + recorded chips + reminder.
    expect(PAGE).toMatch(/Remember today/);
    expect(PAGE).toMatch(/Last recorded/);
    expect(PAGE).toMatch(/Tolerance 4\/5/);
    expect(PAGE).toMatch(/Lot L-204/);
    expect(PAGE).toMatch(/Aftercare not marked last session/);
  });

  it("the calendar-only card stays limited to appointment basics", () => {
    // Scope to the ProblemSection so the assertion is about the calendar
    // card, not the rest of the page.
    const start = PAGE_RAW.indexOf("function ProblemSection(");
    const section = PAGE_RAW
      .slice(start, PAGE_RAW.indexOf("\nfunction ", start + 1))
      .replace(/\s+/g, " ");
    const calendarCard = section.slice(
      section.indexOf('AppWindow title="Calendar-only"'),
      section.indexOf('AppWindow title="Hone"'),
    );
    // No treatment-memory fields leak into the calendar card.
    expect(calendarCard).not.toMatch(/Remember today/);
    expect(calendarCard).not.toMatch(/Tolerance/);
    expect(calendarCard).not.toMatch(/Lot L-204/);
    expect(calendarCard).not.toMatch(/Aftercare/);
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

  it("privacy / trust section: compact checklist + all five claims + policy link", () => {
    expect(PAGE).toMatch(/Your client records should stay yours\./);
    // All five claims remain present.
    expect(PAGE).toMatch(/Studio data stays isolated\./);
    expect(PAGE).toMatch(/Records stay exportable\./);
    expect(PAGE).toMatch(/No advertising use of health records\./);
    expect(PAGE).toMatch(/No AI training on practitioner or client records\./);
    expect(PAGE).toMatch(/Secure sign-in\./);
    // The privacy policy link is still there.
    expect(PAGE).toMatch(/href="\/privacy"/);
    expect(PAGE).toMatch(/privacy policy/);
    // PR #248: the claims live in ONE compact checklist card, not the old
    // five-card 3+2 grid. The five TRUST_POINTS render inside a single
    // MockCard (the claims are mapped once), so there is exactly one
    // MockCard in the section and no lg:grid-cols-3 card grid.
    const start = PAGE_RAW.indexOf("function TrustSection(");
    const fn = PAGE_RAW.slice(start, PAGE_RAW.indexOf("\nfunction ", start + 1));
    expect((fn.match(/<MockCard/g) ?? []).length).toBe(1);
    expect(fn).not.toMatch(/lg:grid-cols-3/);
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

describe("structure: sections, no AI-policy bloat", () => {
  it("renders the hero, the proof strip, and the content shells", () => {
    // PR #250 added the "Built from real treatment rooms" origin-story
    // section (8 SectionShells now).
    const shells = (PAGE_RAW.match(/<SectionShell/g) ?? []).length;
    expect(shells).toBe(8);
    expect(PAGE_RAW).toMatch(/<Hero \/>/);
    expect(PAGE_RAW).toMatch(/<ProofStrip \/>/);
    expect(PAGE_RAW).toMatch(/<BuiltFromTreatmentRooms \/>/);
  });

  it("the origin-story section is a balanced two-column story with a visual card", () => {
    expect(PAGE).toMatch(/Why Hone exists/);
    expect(PAGE).toMatch(/Built from real treatment rooms\./);
    expect(PAGE).toMatch(
      /Hone started with a simple problem: after enough appointments, the important details get hard to keep in your head\./,
    );
    expect(PAGE).toMatch(/Hone keeps that memory close to the next visit\./);
    // Right-side product card (not a bare text block in an empty band).
    expect(PAGE).toMatch(/What gets hard to remember/);
    expect(PAGE).toMatch(/What was used last time\?/);
    expect(PAGE).toMatch(/Hone keeps those details close to the next appointment\./);
    expect(PAGE).toMatch(/Record gap/);
    // No broadening into generic salon / practice-management positioning,
    // and no fake proof in the new visual.
    expect(PAGE).not.toMatch(/salon|spa software|practice management|all-in-one/i);
    expect(PAGE).not.toMatch(/\btestimonial|trusted by (thousands|\d)/i);
  });
});

describe("PR #246 visual system: product proof + polish", () => {
  it("the hero is a product proof visual (app-window preview)", () => {
    // The hero visual is wrapped in the AppWindow chrome with a demo
    // title bar, so it reads as a real app screen, not a floating card.
    expect(PAGE).toMatch(/<AppWindow title="Demo Studio · Today">/);
  });

  it("Before Today is a centerpiece visual with recorded-history wording", () => {
    expect(PAGE).toMatch(/<AppWindow title="Before Today · Maya R\.">/);
    expect(PAGE).toMatch(/Remember today/);
    expect(PAGE).toMatch(/Last recorded/);
    expect(PAGE).toMatch(/Caution noted/);
    // Safe wording only inside the Before Today mockup — no clinical
    // advice / diagnosis / causation (scoped to the component slice;
    // the page-wide safety line legitimately says "should not diagnose").
    const start = PAGE_RAW.indexOf("function BeforeTodayMockup(");
    const slice = PAGE_RAW.slice(start, PAGE_RAW.indexOf("\nfunction ", start + 1));
    expect(slice.length).toBeGreaterThan(0);
    expect(slice).not.toMatch(/recommend/i);
    expect(slice).not.toMatch(/diagnos/i);
    expect(slice).not.toMatch(/\bcaused\b/i);
    expect(slice).not.toMatch(/\bsafe\b|\bunsafe\b/i);
  });

  it("Record Keeping visual shows the demo lot and aftercare", () => {
    expect(PAGE).toMatch(/Procedure record/);
    expect(PAGE).toMatch(/L-204/);
    expect(PAGE).toMatch(/Aftercare/);
    expect(PAGE).toMatch(/Marked/);
    expect(PAGE).toMatch(/Print this client&apos;s procedure record/);
  });

  it("Daily prep visual is present with the recorded-data footer + action", () => {
    expect(PAGE).toMatch(/Tomorrow morning/);
    expect(PAGE).toMatch(/Review Before Today/);
    expect(PAGE).toMatch(/Based on recorded Hone data\./);
  });

  it("has a credible proof strip and no fake proof", () => {
    // All five approved proof items are present.
    expect(PAGE).toMatch(/Built with working electrologists/);
    expect(PAGE).toMatch(/Mobile-tested treatment workflows/);
    expect(PAGE).toMatch(/Browser-tested treatment-memory loop/);
    expect(PAGE).toMatch(/Lot traceability built in/);
    expect(PAGE).toMatch(/Founder-led setup/);
    // No invented social proof.
    expect(PAGE).not.toMatch(/trusted by (thousands|hundreds|millions|\d)/i);
    expect(PAGE).not.toMatch(/\btestimonial/i);
    expect(PAGE).not.toMatch(/customers? love/i);
    expect(PAGE).not.toMatch(/\d+ ?(\+|k) (studios|users|customers|practitioners)/i);
    // No fake customer logos (the page renders no images at all).
    expect(PAGE_RAW).not.toMatch(/<img\b/i);
    expect(PAGE_RAW).not.toMatch(/customer logos?|logo wall|as seen (in|on)/i);
  });

  it("the proof strip is a contained marquee that cannot widen the page", () => {
    // The ticker is implemented as an overflow-hidden marquee, so the
    // wide (duplicated) track is clipped and never adds page width.
    const start = PAGE_RAW.indexOf("function ProofStrip(");
    const fn = PAGE_RAW.slice(start, PAGE_RAW.indexOf("\nfunction ", start + 1));
    expect(fn).toMatch(/overflow-hidden/);
    expect(fn).toMatch(/hone-marquee/);
    // The marquee CSS respects reduced motion (defined in globals.css).
    const css = read("app/globals.css");
    expect(css).toMatch(/\.hone-marquee/);
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*hone-marquee__track[\s\S]*animation: none/);
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
