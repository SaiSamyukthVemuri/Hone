import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MARKETING_PAGES } from "@/lib/marketing/content";
import { marketingMetadata } from "@/lib/marketing/metadata";
import {
  organizationLd,
  webSiteLd,
  softwareApplicationLd,
  articleLd,
  faqPageLd,
  breadcrumbLd,
} from "@/lib/marketing/jsonld";
import { RESOURCE_ARTICLES } from "@/lib/marketing/resources";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

// Every marketing page file (the routes shipped in this PR).
const PAGE_FILES = [
  "app/page.tsx",
  "app/pricing/page.tsx",
  "app/demo/page.tsx",
  "app/electrolysis-software/page.tsx",
  "app/features/treatment-memory/page.tsx",
  "app/features/booking-calendar/page.tsx",
  "app/features/charting-records/page.tsx",
  "app/resources/page.tsx",
  "app/resources/electrolysis-treatment-record-checklist/page.tsx",
  "app/resources/moving-an-electrolysis-practice-from-paper-records/page.tsx",
];

// All marketing source (pages + components + lib) for the PHI / secret scans.
const MARKETING_SRC = [
  ...PAGE_FILES,
  "app/_components/DemoForm.tsx",
  ...readdirSync(join(process.cwd(), "app/_components/marketing"))
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => `app/_components/marketing/${f}`),
  ...readdirSync(join(process.cwd(), "app/_components/marketing/visuals")).map(
    (f) => `app/_components/marketing/visuals/${f}`,
  ),
  "lib/marketing/content.ts",
  "lib/marketing/metadata.ts",
  "lib/marketing/resources.ts",
  "lib/marketing/jsonld.ts",
];

describe("internal links: no dead navigation (§8, §25)", () => {
  const shipped = new Set<string>([...MARKETING_PAGES.map((p) => p.path), "/login"]);

  it("every literal internal href resolves to a shipped route", () => {
    for (const file of PAGE_FILES) {
      const src = read(file);
      const hrefs = [...src.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
      for (const href of hrefs) {
        const path = href.split("#")[0]; // ignore in-page anchors
        if (path === "") continue; // pure "#anchor"
        expect(shipped.has(path), `${file}: dead link ${href}`).toBe(true);
      }
    }
  });
});

describe("one H1 per page + unique titles (§8, §22)", () => {
  it("each marketing page renders exactly one Display (H1)", () => {
    for (const file of PAGE_FILES) {
      const count = (read(file).match(/<Display\b/g) ?? []).length;
      expect(count, `${file}: expected exactly one H1`).toBe(1);
    }
  });

  it("titles are unique across indexable pages", () => {
    const titles = MARKETING_PAGES.map((p) => p.title).filter((t): t is string => !!t);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("canonical + preview indexing (§21)", () => {
  it("every indexable page sets its own canonical path", () => {
    for (const p of MARKETING_PAGES) {
      const meta = marketingMetadata(p.path);
      expect(meta.alternates?.canonical).toBe(p.path);
    }
  });

  it("non-production is noindex (preview safety)", () => {
    const prev = process.env.VERCEL_ENV;
    delete process.env.VERCEL_ENV;
    const meta = marketingMetadata("/");
    expect(meta.robots).toMatchObject({ index: false, follow: false });
    if (prev !== undefined) process.env.VERCEL_ENV = prev;
  });
});

describe("structured data parses as valid JSON-LD", () => {
  it("all builders round-trip through JSON with @context/@type", () => {
    const docs = [
      organizationLd(),
      webSiteLd(),
      softwareApplicationLd(),
      articleLd(RESOURCE_ARTICLES[0]),
      faqPageLd([{ q: "Q?", a: "A." }]),
      breadcrumbLd([{ name: "Home", path: "/" }]),
    ];
    for (const d of docs) {
      const parsed = JSON.parse(JSON.stringify(d));
      expect(parsed["@context"]).toBe("https://schema.org");
      expect(typeof parsed["@type"]).toBe("string");
    }
  });
});

describe("PHI / real-client-data scan", () => {
  it("marketing source contains no real pilot names, non-brand emails, or phone numbers", () => {
    for (const file of MARKETING_SRC) {
      const src = read(file);
      expect(src, `${file}: real name`).not.toMatch(/\b(chloe|willow|laura)\b/i);
      // Only the brand contact addresses are allowed.
      const emails = [...src.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)].map((m) =>
        m[0].toLowerCase(),
      );
      for (const e of emails) {
        expect(["hello@hone.care", "privacy@hone.care"], `${file}: ${e}`).toContain(e);
      }
      expect(src, `${file}: phone`).not.toMatch(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/);
    }
  });
});

describe("secret scan", () => {
  it("marketing source contains no secrets or credentials", () => {
    const patterns = [
      /sk_live_[0-9a-z]/i,
      /sk_test_[0-9a-z]/i,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /SERVICE_ROLE_KEY\s*[:=]/i,
      /eyJ[A-Za-z0-9_-]{20,}\./, // JWT-ish
      /Bearer\s+[A-Za-z0-9._-]{16,}/,
    ];
    for (const file of MARKETING_SRC) {
      const src = read(file);
      for (const rx of patterns) {
        expect(rx.test(src), `${file}: matched ${rx}`).toBe(false);
      }
    }
  });
});
