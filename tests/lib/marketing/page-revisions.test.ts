import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PAGE_REVISIONS } from "@/lib/marketing/page-revisions";
import { CONTACT_EMAIL } from "@/lib/marketing/content";

// HON-124 items 3, 12 and 15 (public pages).
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const code = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

describe("item 15: the shown revision date is a real, pinned constant", () => {
  it("every date is a valid ISO calendar date and none is in the future", () => {
    for (const [p, d] of Object.entries(PAGE_REVISIONS)) {
      expect(d, p).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const t = Date.parse(`${d}T00:00:00Z`);
      expect(Number.isFinite(t), p).toBe(true);
      expect(new Date(t).toISOString().slice(0, 10), p).toBe(d); // a real calendar day, not 2026-02-31
      expect(t, p).toBeLessThanOrEqual(Date.now());
    }
  });
  it("each dated page renders its date from the module, and nothing derives a date from the clock or the build", () => {
    const component = code(read("app/_components/marketing/PageRevision.tsx"));
    expect(component).toMatch(/PAGE_REVISIONS\[path\]/);
    expect(component).not.toMatch(/Date\.now|new Date\(\)|process\.env|BUILD|VERCEL/);
    expect(code(read("lib/marketing/page-revisions.ts"))).not.toMatch(/Date\.now|new Date\(|process\.env/);
    const files: Record<string, string> = {
      "/pricing": "app/pricing/page.tsx",
      "/features/booking-calendar": "app/features/booking-calendar/page.tsx",
      "/features/charting-records": "app/features/charting-records/page.tsx",
      "/features/treatment-memory": "app/features/treatment-memory/page.tsx",
    };
    expect(Object.keys(files).sort()).toEqual(Object.keys(PAGE_REVISIONS).sort());
    for (const [route, f] of Object.entries(files)) expect(read(f), f).toContain(`<PageRevision path="${route}" />`);
  });
  it("the policy pages keep their own reviewed dates (a legal decision), unchanged by this module", () => {
    expect(read("app/privacy/page.tsx")).toMatch(/const LAST_UPDATED = "/);
    expect(read("app/terms/page.tsx")).toMatch(/lastUpdated="/);
  });
});

describe("item 12: FAQ answers are plain text on the page", () => {
  it("the two new booking answers are in the pricing FAQ array (rendered as text, and in the page's FAQ structured data)", () => {
    // The array now lives in the shared content module (the page, its JSON-LD and the site search read it).
    const content = read("lib/marketing/content.ts");
    const src = read("app/pricing/page.tsx");
    expect(content).toContain('q: "Can my clients book online?"');
    expect(content).toContain('q: "Can clients change or cancel their own appointment?"');
    expect(src).toMatch(/PRICING_FAQ\.map/);
    expect(src).toMatch(/faqPageLd\(PRICING_FAQ\)/);
  });
});

describe("item 3: the studio and Hone support are separate contacts on booking surfaces", () => {
  it("the shared booking/portal footer names both, apart, and Hone support is the existing contact address", () => {
    const f = read("app/_components/MarketingFooter.tsx");
    expect(f).toContain('data-testid="contact-paths"');
    expect(f).toMatch(/About your appointment or treatment:[\s\S]{0,80}contact your studio directly/);
    expect(f).toMatch(/Hone support, for problems with this website:/);
    expect(f).toContain("mailto:${CONTACT_EMAIL}");
    expect(CONTACT_EMAIL).toBe("hello@hone.care");
    // the support line never claims to handle appointments
    expect(f).not.toMatch(/Hone support[^<]{0,80}appointment/);
  });
});
