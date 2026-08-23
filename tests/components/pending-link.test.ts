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

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const PENDING_LINK = "components/pending-link.tsx";
const src = read(PENDING_LINK);

// Strip comments: this file discusses `invisible`, `hidden` and the withdrawn
// loading boundary by name when explaining what it refuses to do, and prose
// must not satisfy or trip a source assertion.
const code = src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");

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

describe("the day navigation is wired to it, and nothing else was swept up", () => {
  const dashboard = read("app/(app)/dashboard/page.tsx");

  it("uses PendingLink for exactly the three day-nav segments", () => {
    expect(dashboard.match(/<PendingLink/g) ?? []).toHaveLength(3);
    for (const testid of [
      "dashboard-prev-day",
      "dashboard-today",
      "dashboard-next-day",
    ]) {
      expect(dashboard).toMatch(
        new RegExp(`<PendingLink[\\s\\S]{0,400}${testid}`),
      );
    }
  });

  it("leaves every other Link on the page alone", () => {
    // A shared pending primitive invites a mechanical sweep. It is applied
    // where a route boundary structurally cannot help — query-only navigation —
    // and nowhere else. The dashboard still has many plain <Link> elements and
    // that is the intended state.
    expect((dashboard.match(/<Link/g) ?? []).length).toBeGreaterThan(5);
  });
});
