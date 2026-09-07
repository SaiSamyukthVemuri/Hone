import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  BUSINESS_SUBNAV_ITEMS,
} from "@/components/business-subnav";
import { NAV_ENTRIES, NON_SEARCHABLE_ROUTES } from "@/lib/search/navigation-registry";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Source with COMMENTS REMOVED.
 *
 * WHY THIS EXISTS. Two assertions in this file were written as
 * `expect(src).not.toContain("startsWith")` and `not.toContain("disabled")`,
 * and both failed against the very comments explaining why the code avoids
 * them. A guard that reads prose is not guarding the code: it can be satisfied
 * by deleting a comment and defeated by writing one, which is precisely
 * backwards. Every assertion below about what the code does NOT do runs
 * against this stripped view; assertions about what it DOES contain may use
 * the raw source, since a false positive there is not a risk.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const LAYOUT = read("app/(app)/layout.tsx");
const MOBILE = read("app/(app)/MobileMenu.tsx");
const SUBNAV = read("components/business-subnav.tsx");
const SUBNAV_CODE = stripComments(SUBNAV);
const BUSINESS = read("app/(app)/business/page.tsx");
const CAPACITY = read("app/(app)/dashboard/capacity/page.tsx");
const FINANCIALS = read("app/(app)/financials/page.tsx");

// ===========================================================================
// BUSINESS — the owner domain's navigation contract
// ===========================================================================
//
// WHAT THIS FILE PROVES. That the word "Business" resolves to the same place
// on every surface that offers it, that the three owner surfaces are reachable
// from each other, that a practitioner is neither shown nor served any of it,
// and that the subnav meets the interaction floor.
//
// WHAT IT DOES NOT PROVE, AND MUST NOT BE READ AS PROVING. Navigation is not
// authority. Every assertion here about who SEES a link is a statement about
// advertising, not about access. The access boundary is each page's own
// server-side role check, asserted separately below by reading for it — and
// even that is not a DATABASE boundary, because RLS on the underlying tables
// is `is_studio_member`. The pages decide who is SHOWN an aggregate.

describe("BUSINESS — the tab", () => {
  it("resolves to /business on desktop AND in the mobile menu", () => {
    // ONE DESTINATION, TWO SURFACES. The phone and the laptop disagreeing
    // about where "Business" is would be a defect an owner meets daily and
    // could never articulate, so both halves are pinned together here rather
    // than in two files that can drift apart.
    expect(LAYOUT).toContain('href="/business"');
    expect(MOBILE).toContain('{ href: "/business", label: "Business" }');
  });

  it("no longer points either surface at /dashboard/capacity", () => {
    // The old destination, retired. Capacity is now reached THROUGH Business,
    // and a stale direct link would make the subnav's Overview tab unreachable
    // for anyone who kept using the header.
    const desktopNav = LAYOUT.slice(0, LAYOUT.indexOf("HEADER MODE"));
    expect(desktopNav).not.toContain('href="/dashboard/capacity"');
    expect(MOBILE).not.toContain('{ href: "/dashboard/capacity", label: "Business" }');
  });

  it("is OWNER-ONLY in presentation on both surfaces", () => {
    expect(LAYOUT).toContain('practitioner.role === "owner"');
    expect(MOBILE).toContain('role === "owner"');
  });

  it("does NOT add Financials as a sixth top-level tab", () => {
    // Reporting is one owner domain. A second top-level entry would compete
    // for header width with the working surfaces and split the domain in two.
    const desktopNav = LAYOUT.slice(0, LAYOUT.indexOf("HEADER MODE"));
    expect(desktopNav).not.toContain('href="/financials"');
    expect(MOBILE).not.toContain('label: "Financials"');
  });

  it("keeps the five working surfaces, plus Business", () => {
    for (const href of ["/dashboard", "/clients", "/calendar", "/records"]) {
      expect(MOBILE, href).toContain(`href: "${href}"`);
    }
  });
});

describe("BUSINESS — the subnav", () => {
  it("offers exactly Overview, Capacity, Financials, in that order", () => {
    expect(BUSINESS_SUBNAV_ITEMS.map((i) => i.label)).toEqual([
      "Overview",
      "Capacity",
      "Financials",
    ]);
    expect(BUSINESS_SUBNAV_ITEMS.map((i) => i.href)).toEqual([
      "/business",
      "/dashboard/capacity",
      "/financials",
    ]);
  });

  it("renders on all three owner surfaces", () => {
    for (const [name, src] of [
      ["business", BUSINESS],
      ["capacity", CAPACITY],
      ["financials", FINANCIALS],
    ] as const) {
      expect(src, name).toContain("<BusinessSubnav />");
      expect(src, name).toContain('from "@/components/business-subnav"');
    }
  });

  it("renders only PAST the owner gate on the two gated surfaces", () => {
    // The refusal is the whole page for a practitioner. Handing them a row of
    // links to two more surfaces they also cannot open would be worse than
    // showing nothing: it advertises three refusals instead of one.
    for (const [name, src] of [
      ["capacity", CAPACITY],
      ["financials", FINANCIALS],
    ] as const) {
      const gate = src.indexOf('role !== "owner"') >= 0
        ? src.indexOf('role !== "owner"')
        : src.indexOf('access === "refused"');
      expect(gate, name).toBeGreaterThan(-1);
      expect(src.indexOf("<BusinessSubnav />"), name).toBeGreaterThan(gate);
    }
  });

  it("no dropdown — three items render as three links", () => {
    for (const forbidden of ["<select", "role=\"menu\"", "aria-haspopup"]) {
      expect(SUBNAV_CODE, forbidden).not.toContain(forbidden);
    }
  });
});

describe("BUSINESS — accessibility", () => {
  it("meets the 44px interaction floor through the shared primitive", () => {
    // Composed, not respelled. A local `min-h-[44px]` would work until someone
    // changed the container's display mode: CSS min-height has no effect on an
    // inline box, which is why CONTROL_MIN_TOUCH ships inline-flex WITH it.
    expect(SUBNAV).toContain("CONTROL_MIN_TOUCH");
    expect(SUBNAV_CODE).not.toContain("min-h-[44px]");
  });

  it("uses the canonical focus ring, not a bespoke focus style", () => {
    expect(SUBNAV).toContain("FOCUS_RING");
    expect(SUBNAV_CODE).not.toMatch(/focus:(border|ring|outline)/);
  });

  it("marks the active route for assistive technology", () => {
    expect(SUBNAV).toContain('aria-current={active ? "page" : undefined}');
  });

  it("signals the active route by GEOMETRY, not colour alone", () => {
    // Two non-colour cues: a 2px underline (survives forced-colors, where
    // box-shadow and background are stripped) and a heavier weight. A tab bar
    // distinguished only by hue is unreadable to roughly one man in twelve.
    expect(SUBNAV).toContain("after:h-0.5");
    expect(SUBNAV).toContain("font-semibold");
  });

  it("matches the active route EXACTLY, never by prefix", () => {
    // `startsWith` would leave Overview permanently lit once /business gains a
    // child route, and would infer /dashboard/capacity from /dashboard.
    expect(SUBNAV).toContain("pathname === item.href");
    expect(SUBNAV_CODE).not.toContain("startsWith");
  });

  it("scrolls the TAB ROW, never the page", () => {
    // A document that scrolls sideways on a phone is the defect this avoids.
    expect(SUBNAV).toContain("overflow-x-auto");
    expect(SUBNAV).toContain("min-w-max");
  });

  it("does not dim the tab being pressed", () => {
    // A previous Hone tab bar dimmed the tab just tapped while the route
    // resolved, so the destination read as disabled at the moment it was
    // chosen. The active state here is derived from the resolved pathname.
    expect(SUBNAV_CODE).not.toMatch(/opacity-(50|60|70)/);
    expect(SUBNAV_CODE).not.toContain("disabled");
  });

  it("labels the nav landmark, so it is distinguishable from the primary nav", () => {
    expect(SUBNAV).toContain('aria-label="Business"');
  });
});

describe("BUSINESS — the landing page", () => {
  it("is owner-gated SERVER-SIDE, before any aggregate is read", () => {
    expect(BUSINESS).toContain('practitioner.role !== "owner"');
    // The refusal must precede every destination card; a practitioner must not
    // receive the owner aggregate by typing the URL.
    expect(BUSINESS.indexOf('role !== "owner"')).toBeLessThan(
      BUSINESS.indexOf("DestinationCard"),
    );
  });

  it("reads NO studio aggregate at all", () => {
    // V1 is a destination index. Summarising either destination would re-issue
    // that destination's briefing for a page whose purpose is to be left.
    for (const forbidden of [
      "getOwnerCapacityBriefing",
      "loadFinancialsView",
      "createClient",
      ".from(",
    ]) {
      expect(BUSINESS, forbidden).not.toContain(forbidden);
    }
  });

  it("names both current destinations and no future ones", () => {
    expect(BUSINESS).toContain('href="/dashboard/capacity"');
    expect(BUSINESS).toContain('href="/financials"');
    // No empty tabs, no coming-soon cards. Demand and Trends are documented in
    // the roadmap, not rendered as placeholders.
    for (const forbidden of ["Coming soon", "coming soon", "Demand", "Trends"]) {
      expect(BUSINESS, forbidden).not.toContain(forbidden);
    }
  });

  it("states the owner question each surface answers", () => {
    expect(BUSINESS).toContain("Do I have room, and who needs rebooking?");
    expect(BUSINESS).toContain("What work happened, and what did the practice earn?");
  });

  it("carries the domain's supporting sentence", () => {
    expect(BUSINESS).toContain("Capacity, money and the health of your practice.");
  });
});

describe("BUSINESS — discoverability", () => {
  const financials = NAV_ENTRIES.find((e) => e.href === "/financials");
  const business = NAV_ENTRIES.find((e) => e.href === "/business");

  it("registers BOTH owner surfaces in search", () => {
    expect(financials).toBeDefined();
    expect(business).toBeDefined();
  });

  it("keeps both owner-visible, so search cannot offer a practitioner a refusal", () => {
    expect(financials?.visibility).toBe("owner");
    expect(business?.visibility).toBe("owner");
  });

  it("finds Financials by the words an owner actually types", () => {
    // The brief's required terms, plus the question itself.
    for (const term of [
      "financials",
      "money",
      "revenue",
      "collected",
      "payments",
      "business",
      "earnings",
    ]) {
      expect(financials?.keywords, term).toContain(term);
    }
  });

  it("neither route remains recorded as deliberately unadvertised", () => {
    const excluded = NON_SEARCHABLE_ROUTES.map((r) => r.route);
    expect(excluded).not.toContain("/financials");
    expect(excluded).not.toContain("/business");
  });

  it("does not CLAIM revenue in what the registry asserts", () => {
    // Keywords are what the owner types; the description is what the product
    // states. Cash and e-transfer are invisible to Hone until recorded, so
    // this surface shows a floor, never the whole of what was earned.
    const description = financials?.description.toLowerCase() ?? "";
    expect(description.length).toBeGreaterThan(0);
    for (const claim of ["revenue", "earning", "income", "profit"]) {
      expect(description, claim).not.toContain(claim);
    }
  });
});
