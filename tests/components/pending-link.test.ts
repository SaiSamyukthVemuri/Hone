import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// UI-01 supporting guards for PendingLink.
//
// The BEHAVIOURAL proof is e2e/perceived-speed.spec.ts, which holds a real RSC
// navigation in a real browser and asserts the order the user experiences. This
// file is deliberately not a second copy of that: it pins the properties a
// browser assertion is bad at localising, so a regression names its own cause
// instead of surfacing as "the pending state did not appear".
//
//   1. THE CLIENT BUDGET. Exactly one "use client" boundary ships with UI-01,
//      and it is NOT in components/ui/. That directory is the server-compatible
//      primitive layer and #609 guards it in two places; PendingLink cannot be
//      a member of it, because useLinkStatus forces a client boundary.
//   2. THE TWO TRAPS. `visibility: hidden` on a pending label silently drops
//      the link's accessible name; an unguarded animation ignores
//      prefers-reduced-motion. Both look correct in a screenshot and in a
//      browser assertion, and both are wrong.
//   3. AUTHORITY. A pending state may say a request is in flight and nothing
//      else. It must never read as an outcome.
//   4. LAYOUT TRANSPARENCY (UI-01C). The container form must add NOTHING to
//      the flow of the control it acknowledges. Two halves, and a browser
//      assertion localises neither: the rendered markup must put the caller's
//      children directly on the anchor, and every class the form adds must
//      compile to `position: absolute` — which is precisely what keeps those
//      nodes out of the anchor's flex layout. The geometry itself is proved in
//      the browser, at two viewports, by e2e/perceived-speed.spec.ts.

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PendingContainerLink, PendingLink } = await import(
  "@/components/pending-link"
);

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const PENDING_LINK = "components/pending-link.tsx";
const src = read(PENDING_LINK);

// Strip comments: these files discuss `invisible`, `hidden`, `display: contents`
// and the withdrawn loading boundary by name when explaining what they refuse
// to do, and prose must not satisfy or trip a source assertion.
const codeOnly = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
const code = codeOnly(src);

describe("UI-01 ships exactly one client boundary, in the right place", () => {
  it("declares 'use client' — useLinkStatus leaves no choice", () => {
    expect(src).toMatch(/^"use client";/);
    expect(code).toContain("useLinkStatus");
  });

  it("does NOT live in components/ui/, the server-compatible primitive layer", () => {
    // tests/components/ui-foundations.test.ts asserts that no file in
    // components/ui/ declares "use client" or touches a stateful React hook,
    // because a visual foundation must never be the reason a server-rendered
    // clinical page starts hydrating. PendingLink would violate both. Carving
    // an exception into that guard would have weakened a rule with a real
    // stated purpose; the component moved instead.
    expect(PENDING_LINK.startsWith("components/ui/")).toBe(false);
  });

  it("stays a leaf island — next/link and one class helper, nothing else", () => {
    const imports = [...code.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(
      new Set(["next/link", "react", "./ui/control-base"]),
    );
  });

  it("adds no runtime dependency", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };
    for (const banned of [
      "framer-motion",
      "motion",
      "clsx",
      "tailwind-merge",
      "react-spinners",
      "nprogress",
    ]) {
      expect(Object.keys(pkg.dependencies)).not.toContain(banned);
    }
  });
});

describe("PendingLink avoids the two traps a screenshot cannot show", () => {
  it("fades the label instead of removing it, so the link keeps its name", () => {
    expect(code).toContain("opacity-0");
    // `invisible` and `hidden` both pull the label out of the accessibility
    // tree, which would collapse "Today" to "Loading day…" for the duration of
    // the navigation — losing the only words that say where the link goes.
    expect(code).not.toMatch(/\binvisible\b/);
    expect(code).not.toMatch(/["' ]hidden["' ]/);
  });

  it("keeps the pending mark under prefers-reduced-motion, dropping only the spin", () => {
    expect(code).toContain("animate-spin");
    expect(code).toContain("motion-reduce:animate-none");
    // The mark survives; only its rotation stops. A pending state that
    // disappeared entirely under reduced motion would leave the control
    // looking untapped for exactly the users least able to tolerate it.
    expect(code).toContain("motion-reduce:border-t-current");
  });

  it("cannot change the control's size, so a segmented control never reflows", () => {
    // The mark is positioned, not laid out. `relative` is owned by the
    // component rather than the call site so a caller cannot forget it and let
    // the mark escape to a distant positioned ancestor.
    expect(code).toContain("absolute");
    expect(code).toMatch(/cx\("relative"/);
    expect(code).toContain("pointer-events-none");
  });
});

describe("PendingLink's live region exists BEFORE it has anything to say", () => {
  // Outside a <Link>, useLinkStatus reports idle, so this renders the RESTING
  // control — which is exactly the state the rule is about.
  const atRest = renderToStaticMarkup(
    createElement(PendingLink, { href: "/x", children: "Go" } as never),
  );

  it("mounts the status region at rest, empty", () => {
    // THE RULE, and it is not cosmetic. A polite live region must exist before
    // its content changes; a role="status" node inserted already containing its
    // message is not reliably announced — that is role="alert" behaviour. Codex
    // caught this at e30bebde: the region was rendered inside `{pending && …}`,
    // so the pending state was SILENT for screen-reader users, who get no other
    // signal (the mark is aria-hidden, the label change is purely visual).
    expect(atRest).toContain('role="status"');
    // Empty at rest, so it adds nothing to the link's accessible name until
    // there is genuinely something to say.
    expect(atRest).toMatch(/role="status"[^>]*>(<\/span>|\s*<\/span>)/);
  });

  it("still renders no pending MARK at rest", () => {
    // Only the live region is unconditional. The decorative mark stays
    // conditional, which is what keeps the control at its resting size.
    expect(atRest).not.toContain("data-link-pending");
    expect(atRest).not.toContain("animate-spin");
  });

  it("keeps the label's own text at rest", () => {
    expect(atRest).toContain("Go");
    expect(atRest).not.toContain("opacity-0");
  });
});

describe("PendingLink announces the request, never an outcome", () => {
  it("uses one live region with a request-shaped default label", () => {
    expect(code).toContain('role="status"');
    expect(code).toMatch(/pendingLabel = "Opening…"/);
    for (const outcome of ["Opened", "Saved", "Done", "Loaded", "Complete"]) {
      expect(code).not.toContain(`"${outcome}`);
    }
  });

  it("hides the decorative mark from assistive technology", () => {
    // The sentence a screen reader gets is the live region, not a dozen
    // meaningless placeholder elements.
    expect(code).toMatch(/data-link-pending="true"[\s\S]{0,120}aria-hidden="true"/);
  });

  it("starts no navigation of its own — it only reports Next's", () => {
    // Presentation only. An onClick here would make this a second, competing
    // navigation path with different semantics from a real anchor
    // (middle-click, cmd-click, right-click → open in new tab).
    expect(code).not.toContain("onClick");
    expect(code).not.toContain("router.push");
    expect(code).not.toContain("preventDefault");
  });
});

describe("the dashboard is wired to it, and nothing else was swept up", () => {
  const dashboard = read("app/(app)/dashboard/page.tsx");
  const dash = codeOnly(dashboard);

  // UI-01A: same-pathname query navigation, where no route boundary can render.
  const QUERY_NAV = [
    "dashboard-prev-day",
    "dashboard-today",
    "dashboard-next-day",
  ];
  // UI-01B: the appointment row's three SEGMENT-changing actions. Proven safe
  // by the pre-implementation experiment: with zero loading.tsx the old tree
  // and the tapped control both stay mounted while the destination is pending.
  const SEGMENT_NAV = [
    "today-next-action",
    "today-consultation-notes",
    "today-review-intake",
  ];

  it("uses PendingLink for exactly the six named controls", () => {
    expect(dash.match(/<PendingLink\b/g) ?? []).toHaveLength(
      QUERY_NAV.length + SEGMENT_NAV.length,
    );
    for (const testid of [...QUERY_NAV, ...SEGMENT_NAV]) {
      expect(dashboard).toMatch(
        new RegExp(`<PendingLink[\\s\\S]{0,600}${testid}`),
      );
    }
  });

  it("leaves every other Link on the page alone", () => {
    // A shared pending primitive invites a mechanical sweep. It is applied to
    // named controls only.
    //
    // This test used to record TWO deliberate exclusions. UI-01C closed one of
    // them — the appointment row body, which was never excluded on policy but
    // on capability: it is itself a flex container with two children, and the
    // label form wraps children in one span. It now uses the CONTAINER form,
    // which is the same mechanism and not a second one.
    //
    // The birthday link stays plain, because it is low-frequency, and the page
    // still has ordinary <Link> navigations that are intended to stay ordinary.
    // Counted on comment-stripped source: the prose above the row body names
    // `<Link>` while explaining the CHLOE D1 defect, and prose must not be able
    // to satisfy a count.
    expect((dash.match(/<Link\b/g) ?? []).length).toBeGreaterThan(2);
    // ...and the row body is no longer one of them.
    expect(dash).not.toMatch(
      /<Link\b[\s\S]{0,200}href=\{`\/calendar\/\$\{appt\.id\}`\}/,
    );
  });

  it("gives every converted control a request-shaped pending label", () => {
    for (const label of [
      "Loading day…",
      "Opening…",
      "Opening client…",
      "Opening intake…",
      "Opening appointment…",
    ]) {
      expect(dashboard).toContain(`pendingLabel="${label}"`);
    }
    // Never an outcome.
    for (const outcome of ["Opened", "Loaded", "Ready", "Done"]) {
      expect(dashboard).not.toContain(`pendingLabel="${outcome}`);
    }
  });
});

// ===========================================================================
// UI-01C — the second form, and the guarantee that it is not a second
// mechanism
// ===========================================================================

describe("UI-01C: two forms, one mechanism", () => {
  it("exports exactly two forms, and both only READ Next's status", () => {
    expect(code.match(/^export function Pending/gm) ?? []).toHaveLength(2);
    expect(code.match(/useLinkStatus\(\)/g) ?? []).toHaveLength(2);
    // No state of its own in either form: a pending presentation that could
    // disagree with Next about whether a navigation is in flight is a second
    // mechanism no matter where it lives.
    expect(code).not.toContain("useState");
    expect(code).not.toContain("useEffect");
    expect(code).not.toContain("useTransition");
  });

  it("spells the acknowledgement vocabulary ONCE and shares it", () => {
    // A second mechanism starts life as a second copy of these three things.
    expect(code.match(/animate-spin/g) ?? []).toHaveLength(1);
    expect(code.match(/role="status"/g) ?? []).toHaveLength(1);
    // The hook every proof — unit and browser — locates. Once per form, on the
    // element that form paints, and nowhere else.
    expect(code.match(/data-link-pending="true"/g) ?? []).toHaveLength(2);
  });

  it("the container form starts no navigation either", () => {
    expect(code).not.toContain("onClick");
    expect(code).not.toContain("router.push");
    expect(code).not.toContain("preventDefault");
  });

  it("does NOT reach for display: contents", () => {
    // The obvious way to make a wrapper disappear from layout, and rejected:
    // whether `display: contents` also removes the element from the
    // ACCESSIBILITY tree has been implementation-defined and has changed
    // across releases. Nothing wraps the children here, so the question never
    // has to be answered.
    expect(code).not.toMatch(/display:\s*contents/);
    expect(code).not.toMatch(/["' ]contents["' ]/);
  });
});

describe("UI-01C: PendingContainerLink adds nothing to the layout", () => {
  // A row body in miniature: an anchor that is itself a flex container with
  // two children, which is the exact shape the label form cannot serve.
  const atRest = renderToStaticMarkup(
    createElement(
      PendingContainerLink,
      { href: "/calendar/1", className: "flex min-w-0 gap-4" } as never,
      createElement("div", { key: "a", "data-cell": "time" }, "09:00"),
      createElement("div", { key: "b", "data-cell": "text" }, "Client"),
    ),
  );

  it("renders the caller's children as the anchor's OWN children", () => {
    // THE WHOLE POINT. One wrapping element here would make these two flex
    // items a single track and collapse the row. Nothing may sit between the
    // anchor and them.
    expect(atRest).toMatch(
      /<a[^>]*>\s*<div data-cell="time">09:00<\/div>\s*<div data-cell="text">Client<\/div>/,
    );
  });

  it("owns `relative` and leaves the caller's layout classes intact", () => {
    // The scrim is sized against THIS anchor. A call site that had to remember
    // `relative` would eventually forget it and stretch the scrim across a
    // distant ancestor instead.
    expect(atRest).toMatch(/class="relative flex min-w-0 gap-4"/);
  });

  it("adds exactly one node at rest, and it is out of flow", () => {
    // The live region, mounted and empty (rule 3 above), and `sr-only` — which
    // is itself position:absolute, proved below against the real compiler.
    expect(atRest).toMatch(/role="status"[^>]*>(<\/span>|\s*<\/span>)/);
    expect(atRest).toContain('class="sr-only"');
    expect(atRest).not.toContain("data-link-pending");
    expect(atRest).not.toContain("animate-spin");
    // And it does not fade the content: a treatment row that blanked itself on
    // tap would read as a bug, not as an acknowledgement.
    expect(atRest).not.toContain("opacity-0");
    expect(atRest).toContain("09:00");
  });

  it("every class it adds compiles to position:absolute", async () => {
    // NOT an assertion about spellings. `absolute` and `sr-only` are run
    // through the INSTALLED Tailwind and the emitted CSS is read, because the
    // layout-transparency claim rests entirely on one CSS fact: an absolutely
    // positioned child of a flex container is not a flex item and does not
    // participate in flex layout (CSS Flexible Box Layout §4.1). If either
    // utility ever stopped being out of flow, the scrim or the live region
    // would silently become a third flex track in the appointment row.
    const [{ default: postcss }, { default: tw }] = await Promise.all([
      import("postcss"),
      import("@tailwindcss/postcss"),
    ]);
    const base = path.resolve(__dirname, "../../");
    const input = [
      '@import "tailwindcss" source(none);',
      '@source inline("sr-only absolute relative inset-0");',
    ].join("\n");
    const { css } = await postcss([tw({ base })]).process(input, {
      from: path.join(base, "__pending-probe.css"),
    });

    const rule = (selector: string) => {
      const m = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
      expect(m, `${selector} must compile`).not.toBeNull();
      return m![1];
    };
    expect(rule(".sr-only")).toMatch(/position:\s*absolute/);
    expect(rule(".absolute")).toMatch(/position:\s*absolute/);
    // `relative` is the containing block, and it moves nothing: no offsets are
    // emitted with it, so the anchor's own geometry is unchanged.
    expect(rule(".relative")).toMatch(/position:\s*relative/);
    expect(rule(".relative")).not.toMatch(/\b(top|left|right|bottom|inset)\s*:/);
  });
});

describe("UI-01C: the row body and the calendar toolbar are wired to it", () => {
  const dash = codeOnly(read("app/(app)/dashboard/page.tsx"));
  const toolbarSrc = read("app/(app)/calendar/CalendarToolbar.tsx");
  const toggleSrc = read("app/(app)/calendar/ViewToggle.tsx");
  const toolbar = codeOnly(toolbarSrc);
  const toggle = codeOnly(toggleSrc);

  it("the appointment row body uses the container form, once", () => {
    expect(dash.match(/<PendingContainerLink\b/g) ?? []).toHaveLength(1);
    expect(dash).toMatch(
      /<PendingContainerLink[\s\S]{0,300}href=\{`\/calendar\/\$\{appt\.id\}`\}/,
    );
    // Destination and layout both unchanged — this is presentation only.
    expect(dash).toMatch(
      /<PendingContainerLink[\s\S]{0,300}className="flex min-w-0 gap-4"/,
    );
    expect(dash).toContain('pendingLabel="Opening appointment…"');
  });

  it("every calendar toolbar control that navigates is a PendingLink", () => {
    // Six real client navigations: Week and Month (the toggle), then Today,
    // Previous, Next and Upcoming. The toggle renders one element per tab.
    expect(toolbar.match(/<PendingLink\b/g) ?? []).toHaveLength(4);
    expect(toggle.match(/<PendingLink\b/g) ?? []).toHaveLength(1);
    for (const testid of [
      "calendar-today",
      "calendar-prev",
      "calendar-next",
      "calendar-upcoming",
    ]) {
      expect(toolbarSrc).toMatch(
        new RegExp(`<PendingLink[\\s\\S]{0,400}${testid}`),
      );
    }
    expect(toggle).toMatch(/data-testid=\{`calendar-view-\$\{tab\.value\}`\}/);
  });

  it("no plain next/link navigation is left behind in either file", () => {
    // Half-converted is the worst outcome: the toolbar would acknowledge some
    // taps and not others, which reads as intermittent rather than as a rule.
    for (const source of [toolbar, toggle]) {
      expect(source).not.toMatch(/<Link\b/);
      expect(source).not.toMatch(/from "next\/link"/);
    }
  });

  it("neither file became a client component", () => {
    // The primitive is the only client boundary UI-01 ships. The toolbar and
    // the toggle keep rendering on the server; only these anchors hydrate.
    for (const source of [toolbarSrc, toggleSrc]) {
      expect(source).not.toMatch(/^"use client"/);
    }
  });

  it("changes no destination and no existing semantics", () => {
    for (const href of ["todayHref", "prevHref", "nextHref", "upcomingHref"]) {
      expect(toolbar).toContain(`href={${href}}`);
    }
    expect(toggle).toContain("href={tab.href}");
    expect(toolbar).toContain('aria-label="Previous"');
    expect(toolbar).toContain('aria-label="Next"');
    expect(toggle).toContain('aria-current={active ? "page" : undefined}');
  });

  it("gives every toolbar control a request-shaped pending label", () => {
    for (const label of ["Loading calendar…", "Opening upcoming…"]) {
      expect(toolbarSrc).toContain(`pendingLabel="${label}"`);
    }
    expect(toggleSrc).toContain('pendingLabel="Loading view…"');
    for (const outcome of ["Opened", "Loaded", "Ready", "Done"]) {
      expect(toolbarSrc).not.toContain(`pendingLabel="${outcome}`);
      expect(toggleSrc).not.toContain(`pendingLabel="${outcome}`);
    }
  });
});
