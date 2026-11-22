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

  it("is noindex even in production", () => {
    const robots = marketingMetadata("/sms-consent").robots as { index: boolean };
    expect(robots.index).toBe(false);
  });
  it("is not in the sitemap", () => {
    expect(sitemap().map((e) => e.url).join("\n")).not.toContain("sms-consent");
  });
  it("the page takes its metadata from the same helper", () => {
    const src = readFileSync(join(process.cwd(), "app/sms-consent/page.tsx"), "utf8");
    expect(src).toContain('marketingMetadata("/sms-consent")');
  });
});
