import { describe, expect, it } from "vitest";
import {
  ANALYTICS_EVENTS,
  CANONICAL_HOST,
  CURRENCY,
  DEMO_FLOW,
  FOOTER_GROUPS,
  MARKETING_PAGES,
  POSITIONING,
  PRICING_PLANS,
  PRIMARY_NAV,
  PRODUCT_MENU,
  SITEMAP_PATHS,
  WALKTHROUGH,
} from "@/lib/marketing/content";

// The shared marketing-data module (lib/marketing/content.ts) is the single
// source of truth every marketing page/component reads. These pins lock the
// load-bearing, easy-to-erode truths of the flagship rebuild so a later stage
// cannot silently reintroduce a "Book" CTA on a lead-capture form, a non-CAD
// price, fake scarcity, or a Google Calendar claim.

// Collect every string value reachable from the module's exports so the
// prohibited-language scans below cover the whole surface, not a hand-picked few.
const ALL_STRINGS: string[] = [
  ...Object.values(POSITIONING),
  ...Object.values(WALKTHROUGH),
  ...PRICING_PLANS.flatMap((p) =>
    [p.name, p.priceLabel, p.cadence, p.badge, p.bestFor, p.transition, p.seats].filter(
      (v): v is string => typeof v === "string",
    ),
  ),
  ...PRIMARY_NAV.flatMap((l) => [l.href, l.label]),
  ...PRODUCT_MENU.flatMap((l) => [l.href, l.label]),
  ...FOOTER_GROUPS.flatMap((g) => [g.title, ...g.links.flatMap((l) => [l.href, l.label])]),
  ...MARKETING_PAGES.flatMap((p) => [p.title, p.description].filter((v): v is string => !!v)),
];
const HAYSTACK = ALL_STRINGS.join("  ").toLowerCase();

describe("marketing content: CTA truthfulness (addendum §3)", () => {
  it("treats /demo as a lead-capture flow", () => {
    expect(DEMO_FLOW).toBe("lead_capture");
  });

  it("uses the honest 'Request' verb on every walkthrough surface, never 'Book'", () => {
    const ctaSurfaces = [
      WALKTHROUGH.primaryLabel,
      WALKTHROUGH.primaryLabelShort,
      WALKTHROUGH.demoHeading,
      WALKTHROUGH.submitLabel,
      WALKTHROUGH.successMessage,
    ];
    for (const surface of ctaSurfaces) {
      expect(surface.toLowerCase()).not.toContain("book");
    }
    expect(WALKTHROUGH.primaryLabel).toBe("Request a 15-minute walkthrough");
    expect(WALKTHROUGH.submitLabel.toLowerCase()).toContain("request");
  });

  it("points the walkthrough at /demo", () => {
    expect(WALKTHROUGH.href).toBe("/demo");
  });
});

describe("marketing content: CAD pricing (prompt §15)", () => {
  it("declares CAD as the SaaS currency", () => {
    expect(CURRENCY).toBe("CAD");
  });

  it("labels every published price with CAD $", () => {
    for (const plan of PRICING_PLANS) {
      if (plan.priceLabel !== null) {
        expect(plan.priceLabel).toMatch(/^CAD \$\d/);
      }
    }
  });

  it("uses the exact founding / solo / studio prices", () => {
    const byId = Object.fromEntries(PRICING_PLANS.map((p) => [p.id, p]));
    expect(byId["founding-solo"].priceLabel).toBe("CAD $29");
    expect(byId["founding-solo"].transition).toContain("CAD $39");
    expect(byId["founding-solo"].transition).toContain("first 12 months");
    expect(byId["solo"].priceLabel).toBe("CAD $49");
    expect(byId["solo"].badge).toBe("Most popular");
    expect(byId["studio"].priceLabel).toBe("CAD $99");
    expect(byId["studio"].seats).toBe("up to three practitioners");
  });
});

describe("marketing content: no forbidden language", () => {
  it("never leads with banned SaaS filler or claims (prompt §4)", () => {
    for (const banned of [
      "all-in-one",
      "ai-powered",
      "revolutionary",
      "supercharge",
      "seamless",
      "next-generation",
      "world-class",
      "best-in-class",
    ]) {
      expect(HAYSTACK).not.toContain(banned);
    }
  });

  it("uses no fake scarcity or pilot/beta framing (prompt §7, §15)", () => {
    for (const banned of [
      "spots remaining",
      "spots left",
      "countdown",
      "limited time",
      "beta",
      "pilot",
      "coming soon",
      "sms quota",
    ]) {
      expect(HAYSTACK).not.toContain(banned);
    }
  });

  it("never markets Google Calendar synchronization (DORMANT, prompt §3)", () => {
    for (const banned of ["google calendar", "calendar sync", "two-way sync", "busy import"]) {
      expect(HAYSTACK).not.toContain(banned);
    }
  });
});

describe("marketing content: navigation is dead-link free (prompt §8, §9)", () => {
  const SHIPPED_PATHS = new Set<string>([
    "/",
    "/electrolysis-software",
    "/features/treatment-memory",
    "/features/booking-calendar",
    "/features/charting-records",
    "/pricing",
    "/resources",
    "/resources/electrolysis-treatment-record-checklist",
    "/resources/moving-an-electrolysis-practice-from-paper-records",
    "/demo",
    "/privacy",
    "/terms",
    "/login",
  ]);

  const PHASE_2_FORBIDDEN = [
    "/features/intake-consent",
    "/features/treatment-photos",
    "/features/client-portal",
    "/features/payments",
    "/for/solo-electrologists",
    "/for/electrolysis-studios",
  ];

  const allLinks = [
    ...PRIMARY_NAV,
    ...PRODUCT_MENU,
    ...FOOTER_GROUPS.flatMap((g) => g.links),
  ];

  it("links only to shipped routes, mailto, or /login", () => {
    for (const link of allLinks) {
      const ok = SHIPPED_PATHS.has(link.href) || link.href.startsWith("mailto:");
      expect(ok, `nav href not shipped: ${link.href} (${link.label})`).toBe(true);
    }
  });

  it("contains no Phase-2 links", () => {
    const hrefs = new Set(allLinks.map((l) => l.href));
    for (const forbidden of PHASE_2_FORBIDDEN) {
      expect(hrefs.has(forbidden)).toBe(false);
    }
  });
});

describe("marketing content: page metadata (prompt §21, §22)", () => {
  it("pins the required titles", () => {
    const byPath = Object.fromEntries(MARKETING_PAGES.map((p) => [p.path, p]));
    expect(byPath["/"].title).toBe(
      "Electrolysis Practice Software That Remembers Every Treatment | Hone",
    );
    expect(byPath["/electrolysis-software"].title).toBe(
      "Electrolysis Software for Booking, Charting & Client Records | Hone",
    );
    expect(byPath["/pricing"].title).toBe("Hone Pricing | Electrolysis Practice Software");
    expect(byPath["/features/treatment-memory"].title).toBe(
      "Treatment Memory Software for Electrologists | Hone",
    );
    expect(byPath["/features/booking-calendar"].title).toBe(
      "Electrolysis Booking and Calendar Software | Hone",
    );
    expect(byPath["/features/charting-records"].title).toBe(
      "Electrolysis Charting and Treatment Records | Hone",
    );
  });

  it("gives every indexable content page a unique, non-empty description", () => {
    const described = MARKETING_PAGES.filter((p) => p.description !== null);
    const descriptions = described.map((p) => p.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    for (const d of descriptions) expect((d as string).length).toBeGreaterThan(40);
  });

  it("has unique canonical paths and a sitemap of only indexable routes", () => {
    const paths = MARKETING_PAGES.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(SITEMAP_PATHS).toContain("/");
    expect(SITEMAP_PATHS).toContain("/pricing");
    expect(SITEMAP_PATHS).not.toContain("/login");
  });

  it("uses the production canonical host", () => {
    expect(CANONICAL_HOST).toBe("https://hone.care");
  });
});

describe("marketing content: analytics events are non-PII (prompt §24)", () => {
  it("exposes namespaced event names only", () => {
    for (const name of Object.values(ANALYTICS_EVENTS)) {
      expect(name).toMatch(/^marketing:[a-z_]+$/);
    }
    // No event name hints at capturing identity/free text.
    const joined = Object.values(ANALYTICS_EVENTS).join(" ");
    for (const leak of ["email", "name", "studio", "token"]) {
      expect(joined).not.toContain(leak);
    }
  });
});
