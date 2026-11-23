import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";
import { marketingMetadata } from "@/lib/marketing/metadata";

// The evidence page is public (carriers and reviewers open it) but is not a marketing page: it must not be indexed or listed.
describe("/sms-consent is public but not indexed", () => {
  const prev = process.env.VERCEL_ENV;
  beforeEach(() => { process.env.VERCEL_ENV = "production"; });
  afterEach(() => { if (prev === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = prev; });

  for (const path of ["/sms-consent", "/sms-terms"]) {
    it(`${path} is noindex even in production and not in the sitemap`, () => {
      expect((marketingMetadata(path).robots as { index: boolean }).index).toBe(false);
      expect(sitemap().map((e) => e.url).join("\n")).not.toContain(path.slice(1));
    });
  }
  it("the page takes its metadata from the same helper", () => {
    for (const [f, p] of [["app/sms-consent/page.tsx", "/sms-consent"], ["app/sms-terms/page.tsx", "/sms-terms"]]) {
      expect(readFileSync(join(process.cwd(), f), "utf8")).toContain(`marketingMetadata("${p}")`);
    }
  });
});
