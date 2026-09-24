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
const FILM_PLAYER = read("app/_components/marketing/ProductFilm.tsx");
const HEADER = read("app/_components/marketing/SiteHeader.tsx");
const FOOTER = read("app/_components/marketing/SiteFooter.tsx");
const MOBILE = read("app/_components/marketing/MobileNav.tsx");
const LAYOUT = read("app/layout.tsx");
const CSS = read("app/globals.css");

// Strip source comments so language scans check RENDERED copy, not the
// explanatory comments (which legitimately name excluded things like Google
// Calendar). Removes /* … */ (incl. JSX {/* … */}) and whole-line // comments.
//
// ORDER MATTERS, AND IT IS LINE-COMMENTS FIRST. A line comment may legitimately
// contain the two characters that open a block comment — "// see next/*" is the
// obvious one — and stripping blocks first treats that as a real opener and
// eats everything up to the next */, silently removing live code from the scan.
// A scan that has quietly lost its subject passes for the wrong reason. Taking
// whole-line comments out first means no such fake opener survives to be found.
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

// The homepage-specific rendered surface (whitespace-collapsed) for scans.
const SURFACE = [PAGE, VISUAL, FILM_PLAYER, HEADER, FOOTER, MOBILE]
  .map(stripComments)
  .join("\n")
  .replace(/\s+/g, " ");

describe("positioning: category + treatment-memory differentiator", () => {
  it("hero is not the eyebrow==H1 duplication of the old site", () => {
    expect(POSITIONING.heroEyebrow).toBe("Electrolysis practice software");
    expect(POSITIONING.heroH1).toBe(
      "Start the next treatment where the last one ended.",
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

describe("required homepage sections (copy deck v2.2 §3)", () => {
  // The nine blocks, in the deck's order. Each is pinned by ONE stable anchor —
  // a heading, a constant it consumes, or a route it links to — never by a
  // paragraph, so ordinary copy editing does not turn this file red.
  const BLOCKS: { name: string; anchor: RegExp }[] = [
    { name: "1 film", anchor: /Before the client sits down/ },
    { name: "2 trust strip", anchor: /POSITIONING\.trustStrip/ },
    { name: "3 per-area history", anchor: /Every area keeps its own history/ },
    { name: "4 more than a note", anchor: /More than a note/ },
    { name: "5 connected workflow", anchor: /<WorkflowGrid steps=/ },
    { name: "6 what was used", anchor: /Know what was used, and when/ },
    { name: "7 records stay yours", anchor: /POSITIONING\.recordsHeading/ },
    { name: "8 pricing", anchor: /PRICING_PLANS\.map/ },
    { name: "9 walkthrough CTA", anchor: /POSITIONING\.walkthroughHeading/ },
  ];

  it("renders all nine blocks", () => {
    for (const b of BLOCKS) {
      expect(PAGE, `missing block: ${b.name}`).toMatch(b.anchor);
    }
  });

  it("renders them in the deck's order", () => {
    // Editorial pacing is an ORDER, not a set. The film has to land before the
    // trust strip can trade on it, and the CTA has to close. A reshuffle that
    // left every block present would otherwise pass the test above.
    const positions = BLOCKS.map((b) => ({ name: b.name, at: PAGE.search(b.anchor) }));
    for (const p of positions) expect(p.at, `${p.name} not found`).toBeGreaterThan(-1);
    const order = positions.map((p) => p.at);
    const sorted = [...order].sort((a, b) => a - b);
    expect(
      positions.map((p) => p.name),
      `blocks are out of order: ${positions
        .slice()
        .sort((a, b) => a.at - b.at)
        .map((p) => p.name)
        .join(" → ")}`,
    ).toEqual(
      sorted.map((at) => positions.find((p) => p.at === at)!.name),
    );
  });

  it("the film is the homepage's primary section-1 asset, not an illustration", () => {
    expect(PAGE).toMatch(/<ProductFilm\b/);
    // Section 1 opens the page's product argument: the film must precede every
    // coded preview, or the page is leading with a drawing again.
    const film = PAGE.search(/<ProductFilm\b/);
    for (const preview of [
      /<TreatmentMemoryPanel\b/,
      /<SessionRecordPreview\b/,
      /<CalendarPreview\b/,
    ]) {
      const at = PAGE.search(preview);
      if (at === -1) continue;
      expect(film, `${preview} renders before the film`).toBeLessThan(at);
    }
  });

  it("the trust strip renders four lines, not one", () => {
    // MKT-02A ships trustStrip as ONE string joined with " · " and the homepage
    // splits it into a four-column ruled row. That split is a runtime read of a
    // display string: change the separator upstream and the strip does not
    // break loudly, it silently becomes a single long line that still renders.
    // So the separator contract is pinned on both sides.
    expect(PAGE).toMatch(/POSITIONING\.trustStrip\.split\(" · "\)/);
    const lines = POSITIONING.trustStrip.split(" · ");
    expect(lines, `trustStrip split into ${lines.length} lines`).toHaveLength(4);
    for (const line of lines) expect(line.trim()).toBe(line);
    for (const line of lines) expect(line.length).toBeGreaterThan(0);
  });

  it("keeps the editorial pacing: three tones, and the band used as a spine", () => {
    // "Do not make all sections equal cards" is a pacing requirement. What is
    // checkable without freezing the layout is that the page still alternates:
    // all three surface tones present, and the dark band used more than once.
    const tones = [...PAGE.matchAll(/tone="(paper|warm|band)"/g)].map((m) => m[1]);
    expect(new Set(tones)).toEqual(new Set(["paper", "warm", "band"]));
    expect(
      tones.filter((t) => t === "band").length,
      "the dark band is the pacing spine — at least the film, the records band and the close",
    ).toBeGreaterThanOrEqual(3);
  });

  it("has a CAD pricing block driven by the shared plans (no $19 pilot)", () => {
    expect(PAGE).toMatch(/PRICING_PLANS/);
    expect(PAGE).toMatch(/href="\/pricing"/);
    expect(PRICING_PLANS.some((p) => p.priceLabel?.includes("$"))).toBe(true);
    expect(SURFACE).not.toMatch(/\$19\b/);
  });

  it("no exit claim exceeds what the export actually carries", () => {
    // The self-service export omits treatment photos, intake forms, signed
    // consents, the service menu and payment records (/settings/data names them
    // "Not included yet", and there is no documented route for the rest). So
    // the page may describe the NAMED subset and must not promise a complete
    // exit on top of it — a cancellation line reading "your records leave with
    // you" shipped here once and contradicted the export item directly above.
    // SCANNED ON THE STRIPPED SOURCE, not the raw file. This guard is about
    // RENDERED copy, and the page's comments legitimately discuss the claims it
    // retired — a raw scan makes the file fail for explaining itself, which it
    // did twice while this assertion was being written.
    const rendered = stripComments(PAGE);
    for (const overclaim of [
      /your records leave with you/i,
      /all (of )?your (records|data) (leave|come|go) with you/i,
      /take (all|everything|your full)[^.]{0,40}with you/i,
      /full studio history/i,
      /complete (export|record set)/i,
    ]) {
      expect(rendered, `homepage promises more than the export carries: ${overclaim}`)
        .not.toMatch(overclaim);
    }
    // And the qualified description is still the one that ships.
    expect(PAGE).toMatch(/does and does not yet include/);
  });

  it("keeps the payment qualifier and the policy link", () => {
    expect(PAGE).toMatch(/PAYMENT_QUALIFIER/);
    expect(PAGE).toMatch(/href="\/privacy"/);
  });

  it("closes on the walkthrough conversion, in the film's own words", () => {
    // The film's end card, reused as the CTA eyebrow. The STRING is MKT-02A's
    // (it is copy); this lane only pins that the close actually renders it.
    expect(PAGE).toMatch(/POSITIONING\.filmClosingLine/);
    expect(POSITIONING.filmClosingLine).toBe("Pick up where you left off.");
    expect(PAGE).toMatch(/POSITIONING\.walkthroughHeading/);
  });
});

describe("CTA truthfulness: request, never book", () => {
  it("uses no 'Book … walkthrough' CTA anywhere on the surface", () => {
    expect(SURFACE).not.toMatch(/Book (a|the|your|a 15-minute)[^.]*walkthrough/i);
    expect(SURFACE).not.toMatch(/Book a 15-minute/i);
  });
});

describe("static rendering + no horizontal overflow", () => {
  it("main clips horizontal overflow", () => {
    expect(PAGE).toMatch(/overflow-x-hidden/);
  });
  it("renders content statically visible (no opacity-gated reveal that can stick)", () => {
    // The fragile intersection-observer reveal + SVG-thread assembly were removed
    // (they could leave sections stuck invisible / the line distorted). No content
    // is hidden behind opacity:0 waiting on JS.
    expect(CSS).not.toMatch(/\[data-mreveal="0"\][^{]*\{[^}]*opacity:\s*0/);
    expect(CSS).not.toMatch(/\[data-assemble\]/);
    expect(CSS).not.toMatch(/\[data-thread\]/);
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
  // This rule used to read "renders no images". That was the right rule while
  // the homepage had no real captures: the only image it could have rendered
  // was a mockup. It is the wrong rule now that the page ships an actual
  // recording of the product, and deleting it would have traded a guard for
  // nothing. So it is re-expressed as what it always meant — every pixel of
  // product on this page is a REAL capture of the real application, from the
  // sanctioned synthetic-twin tenant, and nothing else is an image at all.
  it("renders product imagery only from the sanctioned capture directory", () => {
    // Raw <img> bypasses next/image's optimisation AND the static-import path
    // that makes the source of every asset auditable in the diff.
    expect(SURFACE, "use next/image, never a raw <img>").not.toMatch(/<img\b/i);

    // Every image and media reference resolves inside the sanctioned set.
    const refs = [
      ...SURFACE.matchAll(/from\s+"(@\/app\/_media\/[^"]+|[^"]*\.(?:png|jpe?g|webp|avif|gif|svg))"/g),
    ].map((m) => m[1]);
    for (const ref of refs) {
      expect(ref, `image imported from outside app/_media: ${ref}`).toMatch(
        /^@\/app\/_media\//,
      );
    }

    // No stock photography, no logo wall, no borrowed credibility.
    expect(SURFACE).not.toMatch(/logo wall|as seen (in|on)|customer logos?/i);
    expect(SURFACE).not.toMatch(/unsplash|pexels|shutterstock|getty/i);
  });

  it("every product asset carries the film's own demo-data label, verbatim", () => {
    // One wording across the film, the poster and every still, so nothing needs
    // recutting to agree with the page. The film already burns these exact
    // words into its own corner.
    expect(POSITIONING.demoDataLabel).toBe("Demo data. Actual Hone application.");
    expect(FILM_PLAYER).toMatch(/POSITIONING\.demoDataLabel/);
    // On the poster AND under the player: a visitor who never presses play
    // still sees it.
    expect(
      (FILM_PLAYER.match(/POSITIONING\.demoDataLabel/g) ?? []).length,
      "the label must appear on the poster and under the player",
    ).toBeGreaterThanOrEqual(2);
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
