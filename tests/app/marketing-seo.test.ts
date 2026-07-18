import { afterEach, describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";
import {
  organizationLd,
  webSiteLd,
  softwareApplicationLd,
  breadcrumbLd,
  articleLd,
  faqPageLd,
  priceValue,
} from "@/lib/marketing/jsonld";
import { CANONICAL_HOST, MARKETING_PAGES, PRICING_PLANS } from "@/lib/marketing/content";
import { RESOURCE_ARTICLES } from "@/lib/marketing/resources";

const origEnv = process.env.VERCEL_ENV;
afterEach(() => {
  if (origEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = origEnv;
});

describe("sitemap", () => {
  const entries = sitemap();
  const urls = entries.map((e) => e.url);

  it("lists exactly the indexable marketing/policy pages as absolute prod URLs", () => {
    const indexable = MARKETING_PAGES.filter((p) => p.indexable);
    expect(entries.length).toBe(indexable.length);
    for (const u of urls) expect(u.startsWith(CANONICAL_HOST)).toBe(true);
    expect(urls).toContain(CANONICAL_HOST); // home
    expect(urls).toContain(`${CANONICAL_HOST}/pricing`);
    expect(urls).toContain(`${CANONICAL_HOST}/features/treatment-memory`);
  });

  it("excludes private / auth / token / api routes", () => {
    const paths = urls.map((u) => u.replace(CANONICAL_HOST, "") || "/");
    for (const bad of [
      "/login",
      "/api",
      "/portal",
      "/admin",
      "/dashboard",
      "/settings",
      "/cancel",
      "/reschedule",
      "/manage",
      "/intake",
      "/calendar-feed",
      "/book/",
    ]) {
      expect(paths.some((p) => p.startsWith(bad))).toBe(false);
    }
  });

  it("sets lastModified only on the resource articles (real dates)", () => {
    for (const a of RESOURCE_ARTICLES) {
      const e = entries.find((x) => x.url === `${CANONICAL_HOST}${a.slug}`)!;
      expect(e.lastModified).toBe(a.dateModified);
    }
    const home = entries.find((x) => x.url === CANONICAL_HOST)!;
    expect(home.lastModified).toBeUndefined();
  });
});

describe("robots", () => {
  it("production: allows crawl, disallows private prefixes, points to the sitemap", () => {
    process.env.VERCEL_ENV = "production";
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules!;
    expect(rule.allow).toBe("/");
    const dis = rule.disallow as string[];
    for (const p of ["/api/", "/admin/", "/portal", "/settings/", "/dashboard", "/clients"]) {
      expect(dis).toContain(p);
    }
    expect(r.sitemap).toBe(`${CANONICAL_HOST}/sitemap.xml`);
    expect(r.host).toBe(CANONICAL_HOST);
  });

  it("preview/non-production: disallows everything (noindex reinforcement)", () => {
    process.env.VERCEL_ENV = "preview";
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules!;
    expect(rule.disallow).toBe("/");
    expect(r.sitemap).toBeUndefined();
  });
});

describe("JSON-LD", () => {
  it("Organization + WebSite", () => {
    expect(organizationLd()["@type"]).toBe("Organization");
    expect(organizationLd().url).toBe(CANONICAL_HOST);
    expect(webSiteLd()["@type"]).toBe("WebSite");
  });

  it("SoftwareApplication offers equal the visible plan prices (CAD)", () => {
    const app = softwareApplicationLd();
    expect(app["@type"]).toBe("SoftwareApplication");
    const offers = app.offers.itemListElement;
    const priced = PRICING_PLANS.filter((p) => p.priceLabel);
    expect(offers.length).toBe(priced.length);
    for (const plan of priced) {
      const offer = offers.find((o) => o.name === plan.name)!;
      expect(offer.priceCurrency).toBe("CAD");
      expect(offer.price).toBe(priceValue(plan.priceLabel as string));
    }
    // sanity on the actual numbers
    const byName = Object.fromEntries(offers.map((o) => [o.name, o.price]));
    expect(byName["Founding Solo"]).toBe(29);
    expect(byName["Solo"]).toBe(49);
    expect(byName["Studio"]).toBe(99);
  });

  it("BreadcrumbList positions increment and items are absolute", () => {
    const bc = breadcrumbLd([
      { name: "Home", path: "/" },
      { name: "Pricing", path: "/pricing" },
    ]);
    expect(bc.itemListElement[0].position).toBe(1);
    expect(bc.itemListElement[1].item).toBe(`${CANONICAL_HOST}/pricing`);
  });

  it("Article carries real dates + organizational author", () => {
    const a = articleLd(RESOURCE_ARTICLES[0]);
    expect(a["@type"]).toBe("Article");
    expect(a.datePublished).toBe(RESOURCE_ARTICLES[0].datePublished);
    expect(a.author.name).toBe("The Hone team");
  });

  it("FAQPage maps questions to Q&A", () => {
    const f = faqPageLd([{ q: "Q?", a: "A." }]);
    expect(f["@type"]).toBe("FAQPage");
    expect(f.mainEntity[0].acceptedAnswer.text).toBe("A.");
  });

  it("no aggregateRating or review anywhere (addendum §7)", () => {
    const all = JSON.stringify([
      organizationLd(),
      webSiteLd(),
      softwareApplicationLd(),
      articleLd(RESOURCE_ARTICLES[0]),
      faqPageLd([{ q: "Q?", a: "A." }]),
    ]);
    expect(all).not.toMatch(/aggregateRating/i);
    expect(all).not.toMatch(/"review"/i);
  });
});
