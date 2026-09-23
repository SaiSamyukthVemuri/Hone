import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { FOOTER_GROUPS } from "@/lib/marketing/content";

// MARKETING-UI: the skip-link and landmark contract, pinned.
//
// WHY THIS FILE IS SMALL AND LITERAL. The predecessors this successor replaces
// failed by growing an engine: #717's scanner, #744's parser/evaluator. This is
// deliberately neither. It reads a known list of files and extracts two
// strings, and every assertion names one artefact and one property. There is no
// HTML parsing, no DOM construction, no semantic interpretation, and nothing
// here tries to decide in general whether markup is accessible.
//
// WHAT IT PROTECTS. A skip link and its target are a PAIR that lives in two
// files, and the failure mode is silent: rename either side and the link still
// renders, still takes focus, and quietly does nothing. Nothing else in the
// suite notices, because each file is individually valid.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const SKIP_LINK = "app/_components/marketing/SkipLink.tsx";
const POLICY_LAYOUT = "app/_components/PolicyLayout.tsx";
const SITE_FOOTER = "app/_components/marketing/SiteFooter.tsx";
const BOOK_ROUTE = "app/book/[slug]/page.tsx";

// Prose in these files names `#main-content`, `MarketingHeader` and the
// rejected placements when explaining what they refuse to do, so comments must
// not satisfy or trip an assertion. LINE comments are stripped BEFORE block
// comments: a `//` line containing `/*` would otherwise leave the block
// stripper eating real code to the next `*/`, making every "does not contain"
// assertion vacuously true.
const codeOnly = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every public page that renders the marketing shell.
 *
 * DERIVED, not listed. A hand-maintained list would let a new marketing page
 * ship with no skip link and no failure — the whole class of defect this guard
 * exists for.
 */
function shellPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      // Route groups are the authenticated app; not this file's business.
      if (entry.isDirectory() && !entry.name.startsWith("(")) walk(rel);
      else if (entry.name === "page.tsx" && read(rel).includes("<SiteHeader")) {
        out.push(rel);
      }
    }
  };
  walk("app");
  return out.sort();
}

/** The one id the link points at, read from the link itself. */
function skipLinkTargetId(): string {
  const code = codeOnly(read(SKIP_LINK));
  const m = code.match(/href="#([A-Za-z0-9_-]+)"/);
  expect(m, `${SKIP_LINK}: no href="#..." found`).not.toBeNull();
  return m![1];
}

/** The ids declared as skip targets in a file. */
function mainTargetIds(rel: string): string[] {
  const code = codeOnly(read(rel));
  return [...code.matchAll(/<main[^>]*\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
}

describe("the comment stripper itself", () => {
  it("keeps code and drops prose", () => {
    const raw = read(SKIP_LINK);
    const code = codeOnly(raw);
    expect(code).toContain('href="#');
    // This sentence exists only in a comment.
    expect(raw).toContain("would look");
    expect(code).not.toContain("would look");
  });
});

describe("1 + 2: the skip link exists once, and names the canonical target", () => {
  it("the component renders exactly ONE bypass anchor", () => {
    // COUNTS ANCHORS, NOT THE DECLARATION. An earlier revision asserted that
    // `export function SkipLink` appeared once, which is a statement about the
    // module rather than about what renders: adding a SECOND
    // `<a href="#...">` inside the component puts two skip links on every page
    // while leaving exactly one exported function, and every later assertion
    // here reads only the FIRST matching href. A rendered-once contract has to
    // be asserted on the rendered thing.
    const code = codeOnly(read(SKIP_LINK));
    expect(code.match(/export function SkipLink/g) ?? []).toHaveLength(1);
    const anchors = code.match(/<a\s[^>]*href="#/g) ?? [];
    expect(anchors, `SkipLink renders ${anchors.length} bypass anchors`).toHaveLength(1);
  });

  it("it points at a fragment, via a plain anchor", () => {
    const code = codeOnly(read(SKIP_LINK));
    expect(skipLinkTargetId().length).toBeGreaterThan(0);
    // next/link would be a router navigation, which does not move focus to a
    // target already on the page.
    expect(code).not.toContain('from "next/link"');
    expect(code).toMatch(/<a\s/);
  });

  it("it stays reachable: sr-only but never removed from the tab order", () => {
    const code = codeOnly(read(SKIP_LINK));
    expect(code).toContain("sr-only");
    expect(code).toContain("focus:not-sr-only");
    // Either of these would take it out of the tab order entirely and make it
    // exactly as useless as not having one.
    expect(code).not.toMatch(/\bhidden\b/);
    expect(code).not.toContain("display:none");
    expect(code).not.toContain("visibility:hidden");
  });

  it("every shell page renders it exactly once", () => {
    const pages = shellPages();
    expect(pages.length, "no shell pages found — vacuous").toBeGreaterThanOrEqual(10);
    for (const rel of pages) {
      const uses = codeOnly(read(rel)).match(/<SkipLink\s*\/>/g) ?? [];
      expect(uses, `${rel} renders ${uses.length} SkipLink(s)`).toHaveLength(1);
    }
  });

  it("the policy shell renders it exactly once", () => {
    const uses = codeOnly(read(POLICY_LAYOUT)).match(/<SkipLink\s*\/>/g) ?? [];
    expect(uses).toHaveLength(1);
  });
});

describe("3 + 6: the pair is bound — renaming either side is RED", () => {
  // THE POINT OF THIS BLOCK. The link's href and the page's id live in
  // different files and are both plain strings. Comparing them is what makes a
  // rename on ONE side a failure; asserting each against a literal in this file
  // would instead make a coordinated rename fail for the wrong reason and a
  // one-sided rename pass on both.
  const target = skipLinkTargetId();

  it("every shell page declares exactly one main with the link's own id", () => {
    for (const rel of shellPages()) {
      const ids = mainTargetIds(rel);
      expect(ids, `${rel} declares ${ids.length} <main id=...>`).toHaveLength(1);
      expect(
        ids[0],
        `${rel} targets "${ids[0]}" but the skip link points at "${target}"`,
      ).toBe(target);
    }
  });

  it("the policy shell declares exactly one, and it matches too", () => {
    const ids = mainTargetIds(POLICY_LAYOUT);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(target);
  });

  it("no shell page declares a SECOND main", () => {
    // A second <main> makes "the" main ambiguous and can leave the link
    // pointing at whichever one happens to be first in the document.
    for (const rel of shellPages()) {
      const mains = codeOnly(read(rel)).match(/<main[\s>]/g) ?? [];
      expect(mains, `${rel} has ${mains.length} <main> elements`).toHaveLength(1);
    }
  });
});

describe("1 (boundary): 'where required' is a real boundary, not everywhere", () => {
  // SkipLink.tsx documents why it is NOT added to the shared headers: the book
  // route renders MarketingHeader too and defines no such target, so a link
  // there would point at nothing. That rationale is only true while the book
  // route stays without a target — pin the premise, not just the conclusion.
  it("the book route has no skip link and no canonical target", () => {
    const code = codeOnly(read(BOOK_ROUTE));
    expect(code).not.toContain("<SkipLink");
    expect(mainTargetIds(BOOK_ROUTE)).toHaveLength(0);
  });

  it("neither shared header smuggles the link back in", () => {
    for (const rel of [
      "app/_components/marketing/SiteHeader.tsx",
      "app/_components/MarketingHeader.tsx",
    ]) {
      expect(codeOnly(read(rel)), `${rel} renders SkipLink`).not.toContain(
        "<SkipLink",
      );
    }
  });
});

describe("4: the policy shell's landmark hierarchy", () => {
  const code = codeOnly(read(POLICY_LAYOUT));

    it("main holds the content, not the whole page", () => {
      // The defect this replaces: one <main> wrapping header, article AND footer,
      // which makes the site chrome part of the main content and leaves the skip
      // link with nothing to skip TO.
      expect(code.match(/<main[\s>]/g) ?? []).toHaveLength(1);
    });

    it("the policy article is BETWEEN the mains, not merely nearby", () => {
      // COUNTING <main> DOES NOT PROVE CONTAINMENT, which is what the skip link
      // actually needs. `<main id="main-content" />` followed by the article
      // satisfies "exactly one main", "header before main" and "footer after
      // </main>" simultaneously — and lands the reader on an EMPTY landmark.
      // Only the open < article < close ordering proves the target holds the
      // content it claims to.
      const openAt = code.indexOf("<main");
      const closeAt = code.indexOf("</main>");
      const articleAt = code.indexOf("<article");
      expect(openAt, "no <main>").toBeGreaterThan(-1);
      expect(closeAt, "no </main>").toBeGreaterThan(-1);
      expect(articleAt, "no <article> to contain").toBeGreaterThan(-1);
      expect(openAt, "<main> must open before </main>").toBeLessThan(closeAt);
      expect(articleAt, "the article must open AFTER <main>").toBeGreaterThan(openAt);
      expect(articleAt, "the article must open BEFORE </main>").toBeLessThan(closeAt);
    });

  it("the site header is OUTSIDE main", () => {
    const mainAt = code.indexOf("<main");
    const headerAt = code.indexOf("<MarketingHeader");
    expect(headerAt).toBeGreaterThan(-1);
    expect(headerAt, "header must precede <main>").toBeLessThan(mainAt);
  });

  it("the site footer is OUTSIDE main", () => {
    const closeAt = code.indexOf("</main>");
    const footerAt = code.indexOf("<MarketingFooter");
    expect(closeAt).toBeGreaterThan(-1);
    expect(footerAt, "footer must follow </main>").toBeGreaterThan(closeAt);
  });

    it("the skip link precedes the header it exists to bypass", () => {
      const skipAt = code.indexOf("<SkipLink");
      const headerAt = code.indexOf("<MarketingHeader");
      expect(skipAt).toBeGreaterThan(-1);
      expect(skipAt).toBeLessThan(headerAt);
    });

    it("EVERY shell page puts the skip link before its header, not merely on the page", () => {
      // CO-PRESENCE IS NOT ORDER. A page rendering <SiteHeader /> and then
      // <SkipLink /> contains both components and bypasses nothing: the first
      // Tab still lands in the navigation the link exists to skip. Only the
      // relative position proves the bypass, and it has to hold on every shell
      // page rather than on the one the policy layout happens to own.
      const pages = shellPages();
      expect(pages.length, "no shell pages found — vacuous").toBeGreaterThanOrEqual(10);
      const wrong: string[] = [];
      for (const rel of pages) {
        const src = codeOnly(read(rel));
        const skipAt = src.indexOf("<SkipLink");
        const headerAt = src.search(/<(SiteHeader|MarketingHeader)\b/);
        if (skipAt < 0) {
          wrong.push(`${rel}: renders no SkipLink`);
          continue;
        }
        // A page with no header has nothing to bypass; that is not a failure.
        if (headerAt < 0) continue;
        if (skipAt > headerAt) {
          wrong.push(`${rel}: SkipLink at ${skipAt} comes AFTER the header at ${headerAt}`);
        }
      }
      expect(
        wrong,
        "a shell page renders the skip link after its header, so the first Tab " +
          "still enters the navigation it exists to skip",
      ).toEqual([]);
    });
});

describe("5: footer navigation groups keep accessible names", () => {
  const code = codeOnly(read(SITE_FOOTER));

  it("each group is a nav that carries an accessible name", () => {
    // TECHNIQUE-AGNOSTIC, DELIBERATELY. A first draft asserted
    // `aria-label={group.title}` and failed against correct markup: this
    // footer uses `aria-labelledby` pointing at the visible heading, which is
    // the stronger of the two — the accessible name cannot drift from the text
    // on screen, because it IS the text on screen. Pinning one spelling would
    // have demanded the weaker technique.
    const navOpen = code.match(/<nav\b[\s\S]*?>/);
    expect(navOpen, "no <nav> in the footer").not.toBeNull();
    expect(
      /aria-label=|aria-labelledby=/.test(navOpen![0]),
      "footer group nav has no accessible name",
    ).toBe(true);
  });

  it("an aria-labelledby reference actually resolves, in EITHER syntax", () => {
    // A dangling reference names NOTHING and looks identical to a working one
    // to any assertion that merely sees the attribute present.
    //
    // BOTH SPELLINGS, because an earlier revision extracted only the
    // template-literal form and RETURNED EARLY when it found none. Refactoring
    // the footer to a static `aria-labelledby="footer-links"` with a missing id
    // would then have matched zero references, taken that early return, and
    // reported green on precisely the defect this test exists for. An early
    // return on "no matches" is indistinguishable from a pass.
    const tpl = [...code.matchAll(/aria-labelledby=\{`([^`]+)`\}/g)].map((m) => m[1]);
    const stat = [...code.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]);

    if (tpl.length === 0 && stat.length === 0) {
      // Genuinely nothing to resolve is a valid state — but it must be PROVED
      // from the aria-label technique being present, never assumed from an
      // empty match set.
      expect(
        code,
        "no aria-labelledby found, so aria-label must be the technique in use",
      ).toMatch(/aria-label=/);
      return;
    }

    for (const expr of tpl) {
      // The id is built by the same expression on both sides; compare the
      // expressions rather than evaluating them.
      expect(
        code,
        `aria-labelledby=\`${expr}\` has no element declaring that id`,
      ).toContain(`id={\`${expr}\`}`);
    }
    for (const id of stat) {
      const declared = code.includes(`id="${id}"`) || code.includes(`id={"${id}"}`);
      expect(
        declared,
        `aria-labelledby="${id}" has no element declaring that id`,
      ).toBe(true);
    }
  });

  it("the groups are not bare divs", () => {
    expect(code).not.toMatch(/<div key=\{group\.title\}>/);
  });

  it("there are groups to label — otherwise this is vacuous", () => {
    // READS THE EXPORTED VALUE, NOT THE FILE. An earlier revision grepped
    // `title:` across the whole content module, which carries FOURTEEN such
    // properties — marketing metadata, section copy, unrelated structures.
    // Emptying FOOTER_GROUPS entirely would have left eleven of them behind
    // and the count still passing, so the anti-vacuity check was itself
    // vacuous: the footer could render no navigation at all and this stayed
    // green.
    //
    // Importing the value makes the assertion about the thing the footer
    // actually maps over, and nothing else in the module can prop it up.
    expect(FOOTER_GROUPS.length).toBeGreaterThanOrEqual(3);
    for (const group of FOOTER_GROUPS) {
      expect(group.title.trim().length, "a group with no title cannot be named")
        .toBeGreaterThan(0);
      expect(group.links.length, `group "${group.title}" has no links`)
        .toBeGreaterThan(0);
    }
  });
});
