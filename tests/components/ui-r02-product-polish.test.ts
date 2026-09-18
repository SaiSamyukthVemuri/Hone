import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

// UI-R02 — the product-polish primitives, proved structurally.
//
// Scope note: these assert the CONTRACTS the primitives ship, not that arbitrary
// future markup is correct. That distinction is the lesson UI-R01 paid for over
// seven review rounds — a guard that overclaims is worse than a narrow one.

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("UI-R02: the polish layer does not widen the client boundary", () => {
  it("every components/ui primitive is still server-compatible", () => {
    // The #609 rule, re-asserted because UI-R02 adds three files to that
    // directory. A visual primitive must never be why a clinical page hydrates.
    for (const file of readdirSync("components/ui")) {
      const src = code(`components/ui/${file}`);
      expect(src, `${file} must stay server-compatible`).not.toMatch(/^\s*["']use client["']/m);
      for (const hook of ["useState", "useEffect", "useRef", "useTransition", "useFormStatus"]) {
        expect(src, `${file} must not use ${hook}`).not.toContain(hook);
      }
    }
  });

  it("adds no dependency — the polish is Hone's own", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    for (const banned of [
      "@astryxdesign/core",
      "@astryxdesign/theme-neutral",
      "@stylexjs/stylex",
      "lucide-react",
      "framer-motion",
      "clsx",
      "tailwind-merge",
    ]) {
      expect(Object.keys(pkg.dependencies), `${banned} must not be a dependency`).not.toContain(banned);
    }
  });
});

describe("UI-R02 PageHeader: one heading spelling", () => {
  it("renders an h1 and uses the fg token, not a raw neutral", () => {
    const html = render(createElement(PageHeader, { title: "Notifications" }));
    expect(html).toMatch(/<h1[^>]*>Notifications<\/h1>/);
    expect(html).toContain("text-fg");
    expect(html).not.toMatch(/text-neutral-\d/);
  });

  it("the description is optional and the action slot is singular", () => {
    const bare = render(createElement(PageHeader, { title: "X" }));
    expect(bare).not.toContain("<p");
    const full = render(
      createElement(PageHeader, { title: "X", description: "Why", action: createElement("button", {}, "Go") }),
    );
    expect(full).toContain("Why");
    expect(full).toContain("Go");
  });

  it("carries no hand-written dark: pair — the token does that", () => {
    const src = code("components/ui/page-header.tsx");
    expect(src).not.toContain("dark:");
  });
});

describe("UI-R02 Card: one surface", () => {
  it("uses semantic surface/line tokens rather than raw neutrals", () => {
    const html = render(createElement(Card, { children: "body" }));
    expect(html).toContain("bg-surface");
    expect(html).toContain("border-line");
    expect(html).not.toMatch(/(bg|border)-neutral-\d/);
  });

  it("padded is opt-out, so a divided list keeps its own geometry", () => {
    expect(render(createElement(Card, { children: "x" }))).toMatch(/px-5 py-4/);
    expect(render(createElement(Card, { padded: false, children: "x" }))).not.toMatch(/px-5 py-4/);
  });

  it("the sunken tone shares SURFACE_PRESS's ground, so they cannot drift", () => {
    expect(render(createElement(Card, { tone: "sunken", children: "x" }))).toContain("bg-surface-sunken");
  });

  it("renders a semantic element when asked", () => {
    expect(render(createElement(Card, { as: "ul", children: "x" }))).toMatch(/^<ul/);
  });
});

describe("UI-R02 PageHeader: heading DEPTH is a property of the page, not the primitive", () => {
  // THE REGRESSION THIS ENCODES. PageHeader hard-coded an h1. settings/layout.tsx
  // renders <h1>Settings</h1> for EVERY settings route, so /settings/data shipped
  // with two top-level headings and "Your data" became a peer of "Settings" in
  // heading navigation — and its section cards were demoted h3 -> h2 on the same
  // wrong premise. Raised by exact-head review; these keep it from returning.

  it("defaults to h1 — /notifications has no ancestor heading and relies on it", () => {
    const html = render(createElement(PageHeader, { title: "Notifications" }));
    expect(html).toMatch(/<h1[^>]*>Notifications<\/h1>/);
  });

  it("renders the level it is given", () => {
    const html = render(createElement(PageHeader, { title: "Your data", headingLevel: 2 }));
    expect(html).toMatch(/<h2[^>]*>Your data<\/h2>/);
    expect(html).not.toMatch(/<h1/);
  });

  it("the level changes the OUTLINE and not the typography", () => {
    const asH1 = render(createElement(PageHeader, { title: "T" }));
    const asH2 = render(createElement(PageHeader, { title: "T", headingLevel: 2 }));
    const cls = (html: string) => /class="([^"]*)"[^>]*>T</.exec(html)?.[1];
    expect(cls(asH2)).toBe(cls(asH1));
    expect(cls(asH1)).toContain("text-3xl");
  });

  it("the settings layout supplies the h1 — the premise the page depends on", () => {
    // Pinned so that if the layout's h1 ever moves, the guard below is revisited
    // rather than silently becoming wrong in the other direction.
    expect(code("app/(app)/settings/layout.tsx")).toMatch(/<h1[^>]*>\s*Settings\s*<\/h1>/);
  });

  it("/settings/data declares its real depth, and its sections sit below it", () => {
    const src = code("app/(app)/settings/data/page.tsx");
    expect(src).toContain("headingLevel={2}");
    // h1 Settings (layout) -> h2 Your data -> h3 sections.
    expect(src).toMatch(/<h3[^>]*>\{title\}<\/h3>/);
    expect(src).not.toMatch(/<h2[^>]*>\{title\}<\/h2>/);
  });

  it("/notifications PageHeader takes the default h1 — nothing above it supplies one", () => {
    const src = code("app/(app)/notifications/page.tsx");
    expect(src).toMatch(/<PageHeader\s+title="Notifications"/);
    expect(code("app/(app)/layout.tsx")).not.toMatch(/<h1/);
  });

  it("the notifications EMPTY STATE actually adopts the heading API", () => {
    // An opt-in API that no call site opts into leaves the gap it was added
    // for wide open. This is the only production EmptyState, so if it renders
    // a <p> then heading navigation still cannot reach the empty-state title
    // and the primitive change bought nothing. Raised at exact-head review.
    //
    // h2 is the right depth here, not a guess: PageHeader supplies the h1, and
    // when this branch renders `overdueAlerts` is empty so the "Operational
    // alerts" h2 is absent — matching the depth SectionLabel as="h2" already
    // establishes on this page.
    const src = code("app/(app)/notifications/page.tsx");
    expect(src).toMatch(/headingLevel=\{2\}/);
    const html = render(
      createElement(EmptyState, {
        title: "No notifications yet.",
        description: "d",
        headingLevel: 2,
      }),
    );
    expect(html).toMatch(/<h2[^>]*>No notifications yet\.<\/h2>/);
  });
});

describe("UI-R02 EmptyState: an empty state must say what fills it", () => {
  it("renders both halves", () => {
    const html = render(
      createElement(EmptyState, { title: "No notifications yet", description: "They appear here." }),
    );
    expect(html).toContain("No notifications yet");
    expect(html).toContain("They appear here.");
  });

  it("description is a REQUIRED prop, not an optional one", () => {
    // The census found several empty states that said only "nothing here",
    // which tells a practitioner nothing actionable. The type is the guard;
    // this pins that it stays required rather than drifting to optional.
    const src = read("components/ui/empty-state.tsx");
    expect(src).toMatch(/description: ReactNode;/);
    expect(src).not.toMatch(/description\?: ReactNode;/);
  });

  // ── headingLevel: the title can join the document outline ──────────────
  //
  // The gap this closes was INTERNAL to UI-R02, not imported from Astryx:
  // PageHeader already renders a real <h1>, while EmptyState rendered its
  // title as a <p>, so an empty state was invisible to heading navigation on a
  // page whose sibling primitive was not.

  it("headingLevel=2 renders a real h2", () => {
    const html = render(
      createElement(EmptyState, { title: "Nothing here", description: "d", headingLevel: 2 }),
    );
    expect(html).toMatch(/<h2[^>]*>Nothing here<\/h2>/);
  });

  it("headingLevel=3 renders a real h3", () => {
    const html = render(
      createElement(EmptyState, { title: "Nothing here", description: "d", headingLevel: 3 }),
    );
    expect(html).toMatch(/<h3[^>]*>Nothing here<\/h3>/);
  });

  it("OMITTING headingLevel preserves the non-heading <p> exactly", () => {
    // The compatibility half: adding the prop must not restructure the outline
    // of a call site that never opted in.
    const html = render(createElement(EmptyState, { title: "Nothing here", description: "d" }));
    expect(html).toMatch(/<p[^>]*>Nothing here<\/p>/);
    expect(html).not.toMatch(/<h[1-6]/);
  });

  it("the level changes the OUTLINE and not the typography", () => {
    // A caller opting into semantics must not be handed a visual change. Both
    // forms carry the identical class string.
    const asP = render(createElement(EmptyState, { title: "T", description: "d" }));
    const asH2 = render(createElement(EmptyState, { title: "T", description: "d", headingLevel: 2 }));
    const cls = (html: string) => /class="([^"]*)"[^>]*>T</.exec(html)?.[1];
    expect(cls(asH2)).toBe(cls(asP));
    expect(cls(asP)).toContain("text-sm font-medium text-fg");
  });

  it("h1 and malformed levels are unrepresentable — the TYPE is the guard", () => {
    // Not a runtime check: PageHeader owns the page's single h1, so an empty
    // state must not be able to claim one. Pinning the union keeps that true.
    const src = read("components/ui/empty-state.tsx");
    expect(src).toMatch(/headingLevel\?: 2 \| 3 \| 4 \| 5 \| 6;/);
    expect(src).not.toMatch(/headingLevel\?: number/);
  });

  it("does NOT announce itself — no default live region", () => {
    // An empty state is usually a resting state, not a mid-session change.
    // role="status" would give every caller announcement semantics none opted
    // into; a surface that needs one must prove that requirement itself.
    const html = render(
      createElement(EmptyState, { title: "a", description: "b", headingLevel: 2 }),
    );
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("aria-live");
  });

  it("stays server-safe and dependency-free after the change", () => {
    const src = code("components/ui/empty-state.tsx");
    expect(src).not.toMatch(/^\s*["']use client["']/m);
    for (const hook of ["useState", "useEffect", "useRef", "useTransition"]) {
      expect(src).not.toContain(hook);
    }
    expect(src).not.toMatch(/window\.|document\.|navigator\./);
    // Only React types and Hone's own cx.
    const imports = src.match(/^import .*$/gm) ?? [];
    expect(imports).toHaveLength(2);
    expect(imports.join(" ")).toContain('from "react"');
    expect(imports.join(" ")).toContain('from "./control-base"');
  });

  it("reads as an absence, and carries no hand-written dark: pair", () => {
    const html = render(createElement(EmptyState, { title: "a", description: "b" }));
    expect(html).toContain("border-dashed");
    expect(html).toContain("bg-surface-sunken");
    expect(html).not.toContain("dark:");
  });
});

describe("UI-R02 applied surfaces", () => {
  const notifications = code("app/(app)/notifications/page.tsx");
  const data = code("app/(app)/settings/data/page.tsx");

  it("notifications uses the primitives, and its raw button is gone", () => {
    expect(notifications).toContain("PageHeader");
    expect(notifications).toContain("EmptyState");
    expect(notifications).toContain("PendingButton");
    // The raw <button> with no :active and no focus-visible.
    expect(notifications).not.toContain("<button");
  });

  it("both surfaces now spell the page heading the SAME way", () => {
    expect(notifications).toContain("PageHeader");
    expect(data).toContain("PageHeader");
    // The two spellings the census found are both gone.
    expect(data).not.toContain("font-[var(--font-fraunces)] text-3xl font-bold");
    expect(notifications).not.toMatch(/<h1 className="text-3xl/);
  });

  it("settings/data no longer hand-rolls its section labels", () => {
    expect(data).toContain("SectionLabel");
    expect(data).not.toMatch(/text-xs font-medium uppercase tracking-wider text-neutral-500/);
  });
});

describe("UI-R02: the inline-hex border that no dark: variant could reach", () => {
  const data = code("app/(app)/settings/data/page.tsx");

  it("settings/data carries no live inline style, and no marketing hex", () => {
    // Before UI-R02 this page set `style={{ border: "1px solid #E5E2DA" }}` on
    // all three data cards and on the disabled delete control. An inline style
    // cannot carry a dark-mode variant, so every one of them drew a warm-beige
    // rule on a near-black ground. `code()` strips comments, so the surviving
    // prose references to the old hex do not satisfy this.
    expect(data).not.toContain("style={{");
    expect(data).not.toContain("E5E2DA");
  });

  it("the cards are the shared surface, and the disabled control is tokened", () => {
    expect(data).toContain("<Card");
    expect(data).toContain("border-line");
    expect(data).toContain("text-fg-muted");
  });

  it("the card heading sits BELOW the page title, which sits below the layout's h1", () => {
    // THIS TEST PREVIOUSLY ENFORCED THE DEFECT, which is how the defect shipped.
    // It asserted <h2> on the premise that "PageHeader is the page's only h1" —
    // but settings/layout.tsx renders <h1>Settings</h1> for every settings
    // route, so the page title is an h2 and these sections are h3. Asserting a
    // SPELLING ("h2 is present") could not tell a correct hierarchy from a
    // broken one; asserting the CHAIN can.
    expect(code("app/(app)/settings/layout.tsx")).toMatch(/<h1[^>]*>\s*Settings\s*<\/h1>/);
    expect(data).toContain("headingLevel={2}");
    expect(data).toMatch(/<h3 className="text-lg font-medium text-fg">/);
    expect(data).not.toMatch(/<h2[^>]*>\{title\}<\/h2>/);
  });

  it("Card accepts the anchor id Global Search resolves controls to", () => {
    // TWO DIFFERENT CLAIMS, deliberately. The render half proves NEW capability:
    // Card had no `id` prop before this change, so it could not have served as
    // an anchor target at all. The source half is a REGRESSION FENCE, not a
    // UI-R02 proof — `id={anchorId}` was already there at f3b95b02 and passes
    // against the base file too. It is here because moving the section into
    // Card is exactly the edit that would silently drop it, and
    // /settings/data#export-data must keep resolving to the export card rather
    // than the page top.
    const html = render(
      createElement(Card, { as: "section", id: "export-data", children: "x" }),
    );
    expect(html).toContain('id="export-data"');
    expect(data).toContain("id={anchorId}");
  });
});
