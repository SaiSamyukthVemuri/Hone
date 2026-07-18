import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RESOURCE_ARTICLES,
  RESOURCE_AUTHOR,
  RESOURCE_DISCLAIMER,
} from "@/lib/marketing/resources";

// Resource-content integrity (addendum §5): real organizational authorship,
// published + last-reviewed dates, an operational-information disclaimer that is
// explicitly not medical/legal advice with a jurisdiction pointer, a corrections
// mechanism, and NO invented practitioner reviewer or credential.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const HUB = read("app/resources/page.tsx");
const BYLINE = read("app/_components/marketing/article.tsx");
const ARTICLE_FILES = [
  "app/resources/electrolysis-treatment-record-checklist/page.tsx",
  "app/resources/moving-an-electrolysis-practice-from-paper-records/page.tsx",
];

describe("resource metadata", () => {
  it("has real organizational authorship and ISO dates", () => {
    expect(RESOURCE_AUTHOR).toBe("The Hone team");
    expect(RESOURCE_ARTICLES.length).toBe(2);
    for (const a of RESOURCE_ARTICLES) {
      expect(a.author).toBe(RESOURCE_AUTHOR);
      expect(a.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(a.dateModified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(a.authorHref.startsWith("/")).toBe(true);
    }
  });

  it("disclaimer is not-medical/legal-advice with a jurisdiction pointer", () => {
    expect(RESOURCE_DISCLAIMER).toMatch(/not medical or legal advice/i);
    expect(RESOURCE_DISCLAIMER).toMatch(/jurisdiction/i);
    expect(RESOURCE_DISCLAIMER).toMatch(/authority/i);
  });
});

describe("byline renders machine-readable dates + linked author", () => {
  it("uses <time dateTime> for published + last-reviewed and rel=author", () => {
    expect(BYLINE).toMatch(/<time dateTime=\{article\.datePublished\}/);
    expect(BYLINE).toMatch(/<time dateTime=\{article\.dateModified\}/);
    expect(BYLINE).toMatch(/Published/);
    expect(BYLINE).toMatch(/Last reviewed/);
    expect(BYLINE).toMatch(/rel="author"/);
  });
});

describe("resource hub", () => {
  it("lists the shipped guides with no coming-soon filler", () => {
    expect(HUB).toMatch(/RESOURCE_ARTICLES\.map/);
    const scan = stripComments(HUB).replace(/\s+/g, " ");
    expect(scan).not.toMatch(/coming soon|more guides soon|check back/i);
  });
});

describe("each article", () => {
  for (const file of ARTICLE_FILES) {
    describe(file, () => {
      const raw = read(file);
      const scan = stripComments(raw).replace(/\s+/g, " ");

      it("has one H1, its metadata, byline, disclaimer, and corrections", () => {
        expect((raw.match(/<Display\b/g) ?? []).length).toBe(1);
        expect(scan).toMatch(/marketingMetadata\(/);
        expect(scan).toMatch(/ArticleByline/);
        expect(scan).toMatch(/ArticleDisclaimer/);
        expect(scan).toMatch(/ArticleCorrections/);
      });

      it("invents no named practitioner reviewer or credential", () => {
        expect(scan).not.toMatch(/reviewed by (Dr\.?\s)?[A-Z][a-z]+ [A-Z][a-z]+/);
        expect(scan).not.toMatch(/\bDr\.\s+[A-Z]/);
        expect(scan).not.toMatch(/\b(RN|MD|CPE|CME|LE)\b(?![a-z])/);
      });

      it("makes no Google Calendar or overclaim", () => {
        expect(scan).not.toMatch(/google calendar/i);
        expect(scan).not.toMatch(/all.in.one|AI.powered|\bHIPAA\b/i);
      });
    });
  }
});
