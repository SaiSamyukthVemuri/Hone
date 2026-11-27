import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MARKETING_PAGES, PRICING_FAQ } from "@/lib/marketing/content";
import { RESOURCE_ARTICLES } from "@/lib/marketing/resources";
import { buildSearchIndex, searchEntries } from "@/lib/marketing/search-index";

// HON-124 item 1: the public site search. The index is built from the constants that render the pages, and the search touches no network and keeps no query.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the index", () => {
  const index = buildSearchIndex();

  it("has every indexable public page once, and nothing that is not one", () => {
    const pages = index.filter((e) => e.kind !== "Pricing question").map((e) => e.href);
    expect(pages.sort()).toEqual(MARKETING_PAGES.filter((p) => p.indexable).map((p) => p.path).sort());
    for (const e of index) expect(e.href, "a public path, never an app or token route").toMatch(/^\/(?!(?:api|login|admin|portal|book|manage|cancel|reschedule|intake|invitation|calendar-feed|ingest)\b)/);
  });

  it("has every pricing question, from the one constant the page and the FAQPage JSON-LD use", () => {
    const qs = index.filter((e) => e.kind === "Pricing question");
    expect(qs.map((e) => e.title)).toEqual(PRICING_FAQ.map((f) => f.q));
    expect(qs.every((e) => e.href === "/pricing#faq")).toBe(true);
  });

  it("titles the guides with their own headlines and gives the policy pages a name", () => {
    for (const a of RESOURCE_ARTICLES) expect(index.find((e) => e.href === a.slug)?.title).toBe(a.title);
    expect(index.find((e) => e.href === "/privacy")?.title).toBe("Privacy policy");
    expect(index.find((e) => e.href === "/terms")?.title).toBe("Terms of service");
  });
});

describe("the matcher", () => {
  const index = buildSearchIndex();
  it("finds a question by its words and ranks a title hit above a text hit", () => {
    expect(searchEntries(index, "setup fee")[0]?.title).toBe("Is there a setup fee?");
    const r = searchEntries(index, "paper");
    expect(r[0]?.title).toContain("paper");
  });
  it("needs every word, ignores case and punctuation, and answers nothing for an empty or unmatched query", () => {
    expect(searchEntries(index, "SETUP, Fee!").length).toBeGreaterThan(0);
    expect(searchEntries(index, "setup zzzzqx")).toEqual([]);
    expect(searchEntries(index, "   ")).toEqual([]);
    expect(searchEntries(index, "")).toEqual([]);
  });
  it("is capped", () => {
    expect(searchEntries(index, "e", 3).length).toBeLessThanOrEqual(3);
  });
});

describe("privacy: a query goes nowhere", () => {
  const files = ["app/_components/marketing/SiteSearch.tsx", "lib/marketing/search-index.ts"];
  it("makes no request, keeps nothing and puts nothing in the URL or in analytics", () => {
    for (const f of files) {
      const code = strip(read(f));
      expect(code, `${f}: no network call`).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|["'`]use server["'`]/);
      expect(code, `${f}: no storage`).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
      expect(code, `${f}: no analytics or telemetry`).not.toMatch(/analytics|SafeAnalytics|track\w*\(|posthog|sentry|gtag|dataLayer/i);
    }
    const ui = strip(read(files[0]));
    expect(ui, "the query is not put in the URL").not.toMatch(/useSearchParams|searchParams|URLSearchParams|history\.(push|replace)State|router\.(replace)\(/);
    expect(ui, "Enter follows a result's own path only").toMatch(/router\.push\(shown\[0\]\.href\)/);
  });

  it("is mounted in the header, and no /search route exists", () => {
    expect(read("app/_components/marketing/SiteHeader.tsx")).toContain("<SiteSearch />");
    expect(() => read("app/search/page.tsx")).toThrow();
  });
});

describe("accessibility contract", () => {
  const ui = read("app/_components/marketing/SiteSearch.tsx");
  it("is a labelled modal dialog, rendered only while open, with a labelled box and a status line", () => {
    expect(ui).toMatch(/role="dialog"[\s\S]{0,80}aria-modal="true"[\s\S]{0,80}aria-label="Search the site"/);
    expect(ui).toMatch(/\{open \? \(/);
    expect(ui).toMatch(/htmlFor="site-search-input"/);
    expect(ui).toMatch(/role="status"/);
  });
  it("has touch-sized controls", () => {
    expect((ui.match(/min-h-11|min-h-12/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
