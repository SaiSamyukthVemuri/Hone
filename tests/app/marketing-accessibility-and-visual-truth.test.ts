import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MACHINE_FREQUENCIES } from "@/lib/constants";

// MARKETING-01b. Two things this file guards, both of which had already
// shipped wrong once:
//
//   1. VISUAL TRUTH. The coded product previews are the only "screenshots" the
//      marketing site has, so a value inside one is a product claim. Two of
//      them carried values the product cannot hold.
//   2. LANDMARKS. Every marketing page must be reachable past the sticky nav
//      by keyboard, and the policy shell must not put nav + footer inside its
//      own main landmark.
//
// Source-level assertions, like the rest of tests/app/marketing-*: these files
// are server components with no data dependency, so reading the source is a
// faithful check and costs no browser.

const ROOT = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Every marketing page that renders the shared SiteHeader/SiteFooter shell. */
const SHELL_PAGES = [
  "app/page.tsx",
  "app/pricing/page.tsx",
  "app/demo/page.tsx",
  "app/electrolysis-software/page.tsx",
  "app/features/treatment-memory/page.tsx",
  "app/features/charting-records/page.tsx",
  "app/features/booking-calendar/page.tsx",
  "app/resources/page.tsx",
  "app/resources/electrolysis-treatment-record-checklist/page.tsx",
  "app/resources/moving-an-electrolysis-practice-from-paper-records/page.tsx",
] as const;

/** The coded product previews. These stand in for screenshots. */
const VISUALS = [
  "app/_components/marketing/visuals/TreatmentMemoryPanel.tsx",
  "app/_components/marketing/visuals/SessionRecordPreview.tsx",
  "app/_components/marketing/visuals/CalendarPreview.tsx",
] as const;

function stripComments(s: string): string {
  // Line comments first: content.ts-style files carry `next/*` inside a line
  // comment, which a block-first strip reads as a comment opener and then eats
  // real code up to the next `*/`. See tests/docs/marketing-truth-register.test.ts.
  return s.replace(/^\s*\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

describe("visual truth: a value inside a product preview is a product claim", () => {
  it("every machine frequency shown is one the product actually accepts", () => {
    // Authority: lib/constants.ts MACHINE_FREQUENCIES. The charting field is a
    // two-value list; "27 MHz" (shipped in two previews until MARKETING-01b) is
    // not one of them, so it depicted a record that could not exist.
    const allowed = MACHINE_FREQUENCIES.map((f) => f.replace(/\s*MHz$/, ""));
    for (const file of VISUALS) {
      const src = stripComments(read(file));
      for (const m of src.matchAll(/([\d.]+)\s*MHz/g)) {
        expect(
          allowed,
          `${file}: "${m[1]} MHz" is not in MACHINE_FREQUENCIES (${MACHINE_FREQUENCIES.join(", ")})`,
        ).toContain(m[1]);
      }
    }
  });

  it("no preview names a calendar view the product does not offer", () => {
    // app/(app)/calendar/ViewToggle.tsx offers exactly Week and Month. The
    // single-day column is md:hidden (CalendarMobileDayView), so a desktop
    // browser frame must not label itself a day view.
    for (const file of VISUALS) {
      expect(stripComments(read(file)), `${file}: names a view state that is not selectable`)
        .not.toMatch(/\bDay view\b/i);
    }
  });
});

describe("landmarks: the content is reachable past the nav", () => {
  const HEADER = stripComments(read("app/_components/marketing/SiteHeader.tsx"));

  it("the shared header opens with a skip link to #main-content", () => {
    expect(HEADER).toMatch(/href="#main-content"/);
    expect(HEADER).toMatch(/Skip to main content/);
  });

  it("the skip link is hidden until focused, not hidden outright", () => {
    // `sr-only` alone would make it permanently invisible to sighted keyboard
    // users, who are most of the people it helps.
    expect(HEADER).toMatch(/sr-only\s+focus:not-sr-only/);
  });

  it("the skip link is the first focusable element in the header", () => {
    const skip = HEADER.indexOf('href="#main-content"');
    const firstLink = HEADER.indexOf("<Link");
    expect(skip).toBeGreaterThan(-1);
    expect(
      skip,
      "a nav link precedes the skip link, so tabbing reaches the nav first",
    ).toBeLessThan(firstLink);
  });

  it("every shell page gives the skip link somewhere to land", () => {
    for (const page of SHELL_PAGES) {
      expect(stripComments(read(page)), `${page}: <main> has no id="main-content"`).toMatch(
        /<main id="main-content"/,
      );
    }
  });
});

describe("landmarks: the policy shell nests them correctly", () => {
  // Comments stripped: this file's own header comment DESCRIBES the landmark
  // structure using the same tags, and an unstripped scan reads the prose as
  // markup — the first draft of this test failed exactly that way.
  const POLICY = stripComments(read("app/_components/PolicyLayout.tsx"));

  it("wraps only the article in main, not the whole page", () => {
    expect(POLICY).toMatch(/<main id="main-content">/);
  });

  it("does not put the header or the footer inside main", () => {
    const openMain = POLICY.indexOf('<main id="main-content">');
    const closeMain = POLICY.indexOf("</main>");
    expect(openMain).toBeGreaterThan(-1);
    expect(closeMain).toBeGreaterThan(openMain);
    const inside = POLICY.slice(openMain, closeMain);
    expect(inside, "MarketingHeader is inside the main landmark").not.toMatch(
      /<MarketingHeader/,
    );
    expect(inside, "MarketingFooter is inside the main landmark").not.toMatch(
      /<MarketingFooter/,
    );
  });

  it("renders exactly one main element", () => {
    expect((POLICY.match(/<main\b/g) ?? []).length).toBe(1);
  });
});

describe("landmarks: footer link groups are navigable", () => {
  // Stripped for the same reason: the group block carries a comment that
  // explains why an <h2> is NOT used, and the literal tag in that sentence
  // would trip the assertion that forbids it.
  const FOOTER = stripComments(read("app/_components/marketing/SiteFooter.tsx"));

  it("each group is a nav landmark", () => {
    expect(FOOTER).toMatch(/<nav\b/);
  });

  it("each nav is named by its own visible group title", () => {
    expect(FOOTER).toMatch(/aria-labelledby=\{`footer-group-\$\{slugify\(group\.title\)\}`\}/);
    expect(FOOTER).toMatch(/id=\{`footer-group-\$\{slugify\(group\.title\)\}`\}/);
  });

  it("does not promote a footer group into the page heading outline", () => {
    // The group titles are subordinate to the page's own sections; an <h2>
    // here would sit at the same level as them.
    const groupBlock = FOOTER.slice(
      FOOTER.indexOf("FOOTER_GROUPS.map"),
      FOOTER.indexOf("</nav>"),
    );
    expect(groupBlock).not.toMatch(/<h[1-3]\b/);
  });
});
