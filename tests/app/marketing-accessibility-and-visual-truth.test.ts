import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { MACHINE_FREQUENCIES } from "@/lib/constants";
import { MARKETING_PAGES } from "@/lib/marketing/content";
import { EXPORT_RESOURCE_REGISTRY } from "@/lib/export/resource-registry";

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
// WHY THIS RENDERS INSTEAD OF READING SOURCE
// ------------------------------------------
// The first version asserted both by matching tokens in the source files, and
// review broke it twice on the same principle: a source token is not the thing
// it names.
//
//   * The skip link was proved by three independent source-wide matches — the
//     `href`, the label, the `sr-only` classes. Changing the `<a>` to a `<div>`
//     while keeping all three, or parking the tokens in an unused string,
//     satisfied every assertion while the bypass no longer existed.
//   * The policy landmark count was taken from `PolicyLayout.tsx` alone. That
//     is the shell, not the route: `/privacy` and `/terms` compose it with 600
//     lines of their own `children`, and a `<main>` added there — or a page
//     that simply stopped using the shell — would have been invisible.
//
// So the routes are RENDERED, through react-dom/server, and the assertions run
// against the markup a visitor receives. `<main>` is counted in the composed
// document; "first focusable" is read from document order rather than from the
// order of two JSX tags in one file; and "the header is outside main" is a fact
// about the output, not about where a component was written.
//
// The mocks below stand in for build-time and browser-only Next plumbing that
// has no server render — the font loaders, the router, `next/link`, and the
// Vercel analytics scripts. None of them touches a landmark, a focus order or a
// rendered value under test.

vi.mock("next/font/local", () => ({
  default: () => ({ variable: "--font-stub", className: "font-stub", style: { fontFamily: "stub" } }),
}));

vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "--font-inter", className: "font-inter", style: { fontFamily: "stub" } }),
  Fraunces: () => ({ variable: "--font-fraunces", className: "font-fraunces", style: { fontFamily: "stub" } }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: (props: { href: string; className?: string; children?: ReactNode }) =>
      react.createElement(
        "a",
        { href: props.href, className: props.className },
        props.children,
      ),
  };
});

vi.mock("@vercel/analytics/next", () => ({ Analytics: () => null }));
vi.mock("@vercel/speed-insights/next", () => ({ SpeedInsights: () => null }));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

// ---------------------------------------------------------------------------
// Rendering the real routes
// ---------------------------------------------------------------------------

// `import.meta.glob` is a Vite transform, not a standard ImportMeta member, so
// it is typed locally rather than by pulling vite/client's globals into the
// repo's type graph for one test file.
type GlobbedModules = Record<string, () => Promise<unknown>>;
const PAGE_MODULES = (
  import.meta as unknown as { glob: (pattern: string) => GlobbedModules }
).glob("../../app/**/page.tsx");

const moduleKeyFor = (path: string) =>
  path === "/" ? "../../app/page.tsx" : `../../app${path}/page.tsx`;

/** Every indexable public path, taken from the registry that defines "public". */
const PUBLIC_PATHS = MARKETING_PAGES.filter((p) => p.indexable).map((p) => p.path);
const POLICY_PATHS = ["/privacy", "/terms"] as const;

const rendered = new Map<string, string>();

async function renderRoute(path: string): Promise<string> {
  const cached = rendered.get(path);
  if (cached) return cached;
  const loader = PAGE_MODULES[moduleKeyFor(path)];
  expect(
    loader,
    `${path} is an indexable marketing route with no page module at ${moduleKeyFor(path)}`,
  ).toBeTruthy();
  const Page = ((await loader!()) as { default: () => ReactNode }).default;
  const html = renderToStaticMarkup(createElement(Page));
  rendered.set(path, html);
  return html;
}

// ---------------------------------------------------------------------------
// Reading landmarks out of rendered markup
// ---------------------------------------------------------------------------

/** Tags that take keyboard focus by default. An <a> only counts with an href. */
const FOCUSABLE = /<(?:a\s[^>]*href=|button\b|select\b|textarea\b|input\b)[^>]*>/i;

type LandmarkReport = {
  mainCount: number;
  mainOpenTag: string;
  bypassTargetOnMain: boolean;
  firstFocusable: string;
  bypassIsFirstFocusable: boolean;
  bannerOutsideMain: boolean;
  contentInfoOutsideMain: boolean;
  declaredBannerInsideMain: boolean;
  footerPresent: boolean;
};

/**
 * WHICH header and WHICH footer this asks about.
 *
 * `<header>` is the banner landmark only when its nearest sectioning ancestor is
 * the document — inside an `<article>` it is that article's own header and is
 * generic. `/privacy` and `/terms` legitimately carry one: PolicyLayout puts the
 * policy title and its two dates in a `<header>` inside the `<article>`, which
 * is inside `<main>`. A guard that simply forbade `<header>` anywhere under
 * `<main>` would fail both policy routes for being correct, so it would have to
 * be deleted, and the real defect it was written for would go unguarded.
 *
 * The defect was specific: PolicyLayout's OUTER element was `<main>`, so the
 * site banner and the site footer sat inside the main landmark and "skip to
 * main content" skipped nothing. That is a question about the FIRST header
 * (which opens and closes before main begins) and the LAST footer (which opens
 * after main ends) — not about every header tag in the document.
 */
export function landmarkReport(html: string): LandmarkReport {
  const mains = html.match(/<main\b[^>]*>/gi) ?? [];
  // `role="main"` is the same landmark by another spelling, and would be an
  // equally real duplicate.
  const roleMains = html.match(/<(?!main\b)[a-z]+\b[^>]*\srole="main"[^>]*>/gi) ?? [];
  const mainOpenTag = mains[0] ?? "";
  const open = html.search(/<main\b/i);
  const close = html.indexOf("</main>");
  const inside = open >= 0 && close > open ? html.slice(open, close) : "";
  const first = FOCUSABLE.exec(html)?.[0] ?? "";

  const bannerOpen = html.search(/<header\b/i);
  const bannerClose = html.search(/<\/header>/i);
  const contentInfoOpen = html.toLowerCase().lastIndexOf("<footer");

  return {
    mainCount: mains.length + roleMains.length,
    mainOpenTag,
    bypassTargetOnMain: /\sid="main-content"/.test(mainOpenTag),
    firstFocusable: first,
    bypassIsFirstFocusable:
      /^<a\s/i.test(first) && /href="#main-content"/.test(first),
    // The banner opens AND closes before the main landmark begins.
    bannerOutsideMain:
      bannerOpen >= 0 && bannerClose > bannerOpen && open > bannerClose,
    // The content-info footer opens after the main landmark ends.
    contentInfoOutsideMain: close >= 0 && contentInfoOpen > close,
    // Belt and braces for anything that declares the role explicitly.
    declaredBannerInsideMain: /role="banner"|role="contentinfo"/i.test(inside),
    footerPresent: contentInfoOpen >= 0,
  };
}

/** Everything WCAG 2.4.1 needs, asserted against one rendered document. */
function expectSoundBypass(report: LandmarkReport, label: string) {
  expect(report.mainCount, `${label}: expected exactly one main landmark`).toBe(1);
  expect(
    report.bypassTargetOnMain,
    `${label}: the main landmark does not carry id="main-content", so the bypass target does not exist. Main opened as: ${report.mainOpenTag}`,
  ).toBe(true);
  expect(
    report.bypassIsFirstFocusable,
    `${label}: the first focusable element is not the skip link, so tabbing reaches the nav first. First focusable: ${report.firstFocusable.slice(0, 160)}`,
  ).toBe(true);
  expect(
    report.bannerOutsideMain,
    `${label}: the site banner is not closed before the main landmark opens, so "skip to main content" skips nothing`,
  ).toBe(true);
  expect(report.footerPresent, `${label}: no <footer> rendered`).toBe(true);
  expect(
    report.contentInfoOutsideMain,
    `${label}: the site footer is INSIDE the main landmark`,
  ).toBe(true);
  expect(
    report.declaredBannerInsideMain,
    `${label}: an element declaring role="banner" or role="contentinfo" sits inside the main landmark`,
  ).toBe(false);
}

/** Rendered text, with markup removed — what a visitor actually reads. */
const renderedText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------------------

describe("landmarks: proved on the composed route, not on the shell", () => {
  it("the registry's public paths all have a page module to render", () => {
    // Derived, not listed: a new indexable route is proved by the tests below
    // because it is in the registry, not because it was remembered here.
    expect(PUBLIC_PATHS.length).toBeGreaterThanOrEqual(12);
    for (const path of PUBLIC_PATHS) {
      expect(PAGE_MODULES[moduleKeyFor(path)], `${path} has no page module`).toBeTruthy();
    }
    for (const policy of POLICY_PATHS) expect(PUBLIC_PATHS).toContain(policy);
  });

  it.each(POLICY_PATHS)(
    "%s composes exactly one main landmark, with the bypass reaching it",
    async (path) => {
      // The route, not PolicyLayout. Both policy pages contribute ~600 lines of
      // `children`, and this is the only assertion that sees them.
      expectSoundBypass(landmarkReport(await renderRoute(path)), path);
    },
  );

  it.each(PUBLIC_PATHS)("%s is reachable past the nav", async (path) => {
    expectSoundBypass(landmarkReport(await renderRoute(path)), path);
  });

  it.each(POLICY_PATHS)("%s still renders through the policy shell", async (path) => {
    // If a policy page stopped using PolicyLayout it could satisfy every
    // landmark assertion above with its own markup while losing the shared
    // header, footer and analytics posture. These are PolicyLayout's own
    // rendered fingerprints.
    const html = await renderRoute(path);
    expect(html, `${path}: the policy body wrapper is missing`).toMatch(
      /class="policy-body/,
    );
    expect(html, `${path}: the policy article wrapper is missing`).toMatch(
      /<article\b/,
    );
    expect(renderedText(html)).toMatch(/Effective date:/);
    expect(renderedText(html)).toMatch(/Last updated:/);
  });

  it.each(POLICY_PATHS)("%s renders the skip link as a focusable anchor", async (path) => {
    const html = await renderRoute(path);
    const anchor = /<a\s[^>]*href="#main-content"[^>]*>([\s\S]*?)<\/a>/.exec(html);
    expect(anchor, `${path}: no <a href="#main-content"> in the rendered document`)
      .toBeTruthy();
    expect(anchor![1].trim(), `${path}: the skip link has no label`).toBe(
      "Skip to main content",
    );
    // Hidden until focused, not hidden outright: `sr-only` alone would make it
    // permanently invisible to sighted keyboard users, who are most of the
    // people it helps.
    expect(anchor![0]).toMatch(/\bsr-only\b/);
    expect(anchor![0]).toMatch(/\bfocus:not-sr-only\b/);
  });
});

describe("landmarks: the guards bite", () => {
  // Negative controls. Each feeds the SAME analyser the real routes go through,
  // so a future loosening fails here rather than reporting the site sound.

  it("catches the shipped defect: the shell wrapping everything in main", async () => {
    // The structure /privacy and /terms actually had. Rendered from a real
    // component tree, not a string, so this is the regression it looks like.
    const OldPolicyShell = () =>
      createElement(
        "main",
        null,
        createElement("header", null, createElement("a", { href: "/" }, "Hone")),
        createElement("article", null, "Policy text"),
        createElement("footer", null, "Footer"),
      );
    const report = landmarkReport(renderToStaticMarkup(createElement(OldPolicyShell)));
    expect(report.bannerOutsideMain).toBe(false);
    expect(report.contentInfoOutsideMain).toBe(false);
    expect(report.bypassTargetOnMain).toBe(false);
    expect(report.bypassIsFirstFocusable).toBe(false);
    expect(() => expectSoundBypass(report, "control")).toThrow();
  });

  it("accepts an article's own header inside main, which is not the banner", () => {
    // The shape /privacy and /terms actually have. A <header> nested in the
    // <article> is that article's header, not the site banner — forbidding it
    // would fail both policy routes for being correct.
    const Shell = () =>
      createElement(
        "div",
        null,
        createElement(
          "a",
          { href: "#main-content", className: "sr-only focus:not-sr-only" },
          "Skip to main content",
        ),
        createElement("header", null, createElement("a", { href: "/" }, "Hone")),
        createElement(
          "main",
          { id: "main-content" },
          createElement(
            "article",
            null,
            createElement("header", null, createElement("h1", null, "Policy")),
            createElement("p", null, "Body"),
          ),
        ),
        createElement("footer", null, "Footer"),
      );
    const report = landmarkReport(renderToStaticMarkup(createElement(Shell)));
    expect(() => expectSoundBypass(report, "control")).not.toThrow();
  });

  it("catches a skip link that is not the first focusable element", () => {
    const html =
      '<div><header><a href="/">Hone</a><a href="#main-content" class="sr-only focus:not-sr-only">Skip to main content</a></header><main id="main-content">x</main><footer>f</footer></div>';
    const report = landmarkReport(html);
    expect(report.bypassIsFirstFocusable).toBe(false);
    expect(() => expectSoundBypass(report, "control")).toThrow(/first focusable/);
  });

  it("catches a skip link that is not an anchor", () => {
    // Review's exact counter-example: the attributes and the label survive, the
    // element does not.
    const html =
      '<div><div href="#main-content" class="sr-only focus:not-sr-only">Skip to main content</div><header><a href="/">Hone</a></header><main id="main-content">x</main><footer>f</footer></div>';
    const report = landmarkReport(html);
    expect(report.bypassIsFirstFocusable).toBe(false);
    expect(() => expectSoundBypass(report, "control")).toThrow(/first focusable/);
  });

  it("catches a bypass target that does not exist", () => {
    const html =
      '<div><a href="#main-content" class="sr-only focus:not-sr-only">Skip to main content</a><header>h</header><main>x</main><footer>f</footer></div>';
    const report = landmarkReport(html);
    expect(report.bypassTargetOnMain).toBe(false);
    expect(() => expectSoundBypass(report, "control")).toThrow(/bypass target/);
  });

  it("catches a second main landmark, however it is spelled", () => {
    const two =
      '<div><a href="#main-content" class="sr-only focus:not-sr-only">Skip to main content</a><header>h</header><main id="main-content">x</main><main>y</main><footer>f</footer></div>';
    expect(landmarkReport(two).mainCount).toBe(2);
    const roled =
      '<div><a href="#main-content" class="sr-only focus:not-sr-only">Skip to main content</a><header>h</header><main id="main-content">x</main><div role="main">y</div><footer>f</footer></div>';
    expect(landmarkReport(roled).mainCount).toBe(2);
    expect(() => expectSoundBypass(landmarkReport(roled), "control")).toThrow(
      /exactly one main/,
    );
  });

  it("does not count a non-focusable anchor as focusable", () => {
    // An <a> without href is not in the tab order, so it must not be able to
    // satisfy "the skip link comes first" by sitting in front of it.
    const html =
      '<div><a name="top"></a><a href="#main-content" class="sr-only focus:not-sr-only">Skip to main content</a><header>h</header><main id="main-content">x</main><footer>f</footer></div>';
    expect(landmarkReport(html).bypassIsFirstFocusable).toBe(true);
  });
});

describe("landmarks: footer link groups are navigable", () => {
  it("each footer group is a nav landmark named by its own visible title", async () => {
    // Before this the four link lists sat loose in <footer> with the group name
    // in a plain <p>: navigating by landmark found no footer navigation at all,
    // and navigating by list found four unlabelled lists. Asserted on rendered
    // output, so the aria wiring is proved to RESOLVE — every aria-labelledby
    // must name an id that exists in the same document.
    const html = await renderRoute("/");
    const navs = [...html.matchAll(/<nav\b[^>]*aria-labelledby="([^"]+)"[^>]*>/gi)];
    expect(navs.length, "the footer renders no labelled nav groups").toBeGreaterThanOrEqual(4);
    for (const [, id] of navs) {
      expect(
        html.includes(`id="${id}"`),
        `nav is labelled by #${id}, which no element in the document defines`,
      ).toBe(true);
      // and the label must be the group's own VISIBLE title, not empty
      const labelled = new RegExp(`id="${id}"[^>]*>([^<]+)<`).exec(html);
      expect(labelled?.[1]?.trim(), `#${id} has no visible text`).toBeTruthy();
    }
  });

  it("does not promote a footer group into the page heading outline", async () => {
    // The group titles are subordinate to the page's own sections; a heading
    // here would sit at the same level as them.
    const html = await renderRoute("/");
    for (const nav of html.match(/<nav\b[^>]*aria-labelledby=[\s\S]*?<\/nav>/gi) ?? []) {
      expect(nav, "a footer group title is rendered as a heading").not.toMatch(
        /<h[1-3]\b/i,
      );
    }
  });
});

describe("visual truth: a value inside a product preview is a product claim", () => {
  // The previews stand in for screenshots, so these assert what is DISPLAYED
  // rather than what is written in the file — a value moved into a prop or a
  // constant is the same claim to a visitor.
  const PREVIEW_ROUTES = [
    "/features/treatment-memory",
    "/features/charting-records",
    "/features/booking-calendar",
    "/",
  ] as const;

  it.each(PREVIEW_ROUTES)(
    "%s shows only machine frequencies the product accepts",
    async (path) => {
      // Authority: lib/constants.ts MACHINE_FREQUENCIES. The charting field is a
      // two-value list; "27 MHz" (shipped in two previews until MARKETING-01b)
      // is not one of them, so it depicted a record that could not exist.
      const allowed = MACHINE_FREQUENCIES.map((f) => f.replace(/\s*MHz$/, ""));
      const text = renderedText(await renderRoute(path));
      for (const m of text.matchAll(/([\d.]+)\s*MHz/g)) {
        expect(
          allowed,
          `${path}: "${m[1]} MHz" is rendered but is not in MACHINE_FREQUENCIES (${MACHINE_FREQUENCIES.join(", ")})`,
        ).toContain(m[1]);
      }
    },
  );

  it("a frequency the product does not accept would be caught", () => {
    // Non-vacuity: the loop above passes trivially if no frequency renders.
    const allowed = MACHINE_FREQUENCIES.map((f) => f.replace(/\s*MHz$/, ""));
    expect(allowed).not.toContain("27");
    expect(allowed).toContain("27.12");
  });

  it("at least one preview actually renders a frequency", async () => {
    const text = renderedText(await renderRoute("/features/treatment-memory"));
    expect(text, "no MHz value rendered; the frequency guard is vacuous").toMatch(
      /[\d.]+\s*MHz/,
    );
  });

  it.each(PREVIEW_ROUTES)(
    "%s names no calendar view the product does not offer",
    async (path) => {
      // app/(app)/calendar/ViewToggle.tsx offers exactly Week and Month. The
      // single-day column is md:hidden (CalendarMobileDayView), so a desktop
      // browser frame must not label itself a day view.
      expect(
        renderedText(await renderRoute(path)),
        `${path}: names a view state that is not selectable`,
      ).not.toMatch(/\bDay view\b/i);
    },
  );
});

describe("visual truth: the export scope the homepage states is the scope the registry holds", () => {
  // TRUTH-01A trimmed the homepage's export claim to a named subset. Its source
  // comment then went stale in the direction that matters: it listed signed
  // consents and the service menu among what the export does NOT carry, when
  // both export today — a stale note that would talk a future author OUT of a
  // true claim. These assertions pin the comment's facts to the registry, so it
  // cannot go stale silently again.
  const kindOf = (key: string) =>
    (EXPORT_RESOURCE_REGISTRY as Record<string, { kind: string }>)[key]?.kind;

  it("consents and the service catalogue DO export", () => {
    expect(kindOf("client_consent_signatures")).toBe("exported");
    expect(kindOf("services")).toBe("exported");
  });

  it("photos and intake forms still do not", () => {
    expect(kindOf("treatment_images")).toBe("pending");
    expect(kindOf("client_intake_forms")).toBe("pending");
  });

  it("the per-area treatment structure still does not leave in the export", () => {
    // The differentiator the marketing site sells hardest. If either of these
    // flips to `exported`, the homepage copy and this comment both understate
    // the product and should be revisited.
    expect(kindOf("session_blocks")).toBe("pending");
    expect(kindOf("session_block_areas")).toBe("pending");
  });

  it("the homepage states that the export names its own limits", async () => {
    expect(renderedText(await renderRoute("/"))).toMatch(
      /names in writing what it does and does not yet include/i,
    );
  });
});
