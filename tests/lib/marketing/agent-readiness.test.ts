import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { middleware } from "../../../middleware";
import {
  preferredPublicRepresentation,
  isUnknownPublicPath,
  normalizePublicPathname,
  appendVaryAccept,
} from "@/lib/marketing/agent-http";
import {
  HOME_MARKDOWN, PUBLIC_MARKDOWN, NOT_FOUND_MARKDOWN,
  ABOUT_PARAGRAPHS, CONTACT_PARAGRAPHS,
} from "@/lib/marketing/agent-content";
import { CONTACT_EMAIL, FOOTER_GROUPS, MARKETING_PAGES } from "@/lib/marketing/content";
import { organizationLd } from "@/lib/marketing/jsonld";

vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: vi.fn(async (request: NextRequest) => NextResponse.next({ request })),
}));

describe("public Markdown negotiation", () => {
  const examples: Array<[string | null, string]> = [
    [null, "html"],
    ["", "html"],
    ["*/*", "html"],
    ["text/markdown", "markdown"],
    ["text/markdown, text/html;q=0.8", "markdown"],
    ["text/html", "html"],
    ["text/html;q=1, text/markdown;q=0.4", "html"],
    ["text/markdown;q=0, text/html", "html"],
    ["text/markdown;q=0, */*;q=1", "html"],
    ["text/markdown, text/html", "markdown"],
    ["text/html, text/markdown", "html"],
    ["text/*;q=0.6,text/markdown;q=0", "html"],
    ["application/json", "not-acceptable"],
    ["text/markdown;q=0", "not-acceptable"],
    ["TEXT/MARKDOWN;Q=1,text/html;q=0.2", "markdown"],
  ];
  it.each(examples)("negotiates %s -> %s", (accept, expected) => {
    expect(preferredPublicRepresentation(accept)).toBe(expected);
  });
  it("appends Accept to existing Vary values once", () => {
    const headers = new Headers({ Vary: "rsc, next-router-state-tree" });
    appendVaryAccept(headers);
    appendVaryAccept(headers);
    expect(headers.get("Vary")).toBe("rsc, next-router-state-tree, Accept");
  });
  it("serves nonempty Markdown for the homepage and keeps HTML as the default", async () => {
    const markdown = await middleware(new NextRequest("https://hone.care/", {
      headers: { accept: "text/markdown" },
    }));
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("Content-Type")).toMatch(/^text\/markdown/);
    expect(markdown.headers.get("Vary")?.toLowerCase()).toContain("accept");
    expect(await markdown.text()).toContain("# Start the next treatment");

    const html = await middleware(new NextRequest("https://hone.care/", {
      headers: { accept: "text/html" },
    }));
    expect(html.status).toBe(200);
    expect(html.headers.get("Vary")?.toLowerCase()).toContain("accept");

    const unavailable = await middleware(new NextRequest("https://hone.care/", {
      headers: { accept: "application/json" },
    }));
    expect(unavailable.status).toBe(406);
  });
  it("negotiates new trust pages without opening private paths", async () => {
    for (const route of ["/about", "/contact", "/about/", "/contact/"]) {
      const resp = await middleware(new NextRequest("https://hone.care" + route, {
        headers: { accept: "text/markdown" },
      }));
      expect(resp.status).toBe(200);
      expect(resp.headers.get("Content-Type")).toMatch(/^text\/markdown/);
      expect((await resp.text()).length).toBeGreaterThan(500);
    }
  });
});

describe("unknown route protection", () => {
  it("returns a real 404 with a helpful Markdown body", async () => {
    const r = await middleware(new NextRequest(
      "https://hone.care/definitely-does-not-exist-agent-readiness-2026",
      { headers: { accept: "text/markdown" } },
    ));
    expect(r.status).toBe(404);
    expect(r.headers.get("Content-Type")).toMatch(/^text\/markdown/);
    expect(r.headers.get("Vary")?.toLowerCase()).toContain("accept");
    const body = await r.text();
    expect(body.length).toBeGreaterThan(20);
    expect(body).toContain("/llms.txt");
    expect(body).toContain("/sitemap.xml");
  });
  it("returns 404 HTML for browsers and HEAD 404 for probes", async () => {
    const url = "https://hone.care/pricing/not-a-real-page";
    const r = await middleware(new NextRequest(url, {
      headers: { accept: "text/html" },
    }));
    expect(r.status).toBe(404);
    expect(r.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(await r.text()).toContain("<h1");
    const head = await middleware(new NextRequest(url, { method: "HEAD" }));
    expect(head.status).toBe(404);

    const feature = await middleware(new NextRequest(
      "https://hone.care/features/unshipped-resource",
      { headers: { accept: "text/markdown" } },
    ));
    expect(feature.status).toBe(404);
    expect(feature.headers.get("Content-Type")).toMatch(/^text\/markdown/);
    expect(await feature.text()).toContain("/llms.txt");

    const missingSlash = await middleware(new NextRequest(
      "https://hone.care/features/unshipped-resource/",
      { headers: { accept: "text/markdown" } },
    ));
    expect(missingSlash.status).toBe(404);
    const validSlash = await middleware(new NextRequest(
      "https://hone.care/about/",
      { headers: { accept: "text/markdown" } },
    ));
    expect(validSlash.status).toBe(200);
    expect(await validSlash.text()).toContain("# About Hone");
  });
  it("does not intercept existing private, API or token route families", () => {
    for (const route of [
      "/dashboard", "/clients/abc", "/settings", "/admin",
      "/api/cron/calendar-sync", "/portal/verify/secret",
      "/invitation/secret", "/book/willow-electrolysis",
      "/reschedule/secret", "/calendar-feed/test.ics",
    ]) expect(isUnknownPublicPath(route)).toBe(false);
    expect(isUnknownPublicPath("/new-unknown-root")).toBe(true);
    expect(isUnknownPublicPath("/features")).toBe(true);
    expect(isUnknownPublicPath("/features/not-a-feature")).toBe(true);
    expect(isUnknownPublicPath("/features/treatment-memory")).toBe(false);
    expect(isUnknownPublicPath("/features/waitlist-invitation")).toBe(false);
    expect(isUnknownPublicPath("/features/treatment-memory/")).toBe(false);
    expect(isUnknownPublicPath("/features/not-a-feature/")).toBe(true);
    expect(isUnknownPublicPath("/about/")).toBe(false);
    expect(isUnknownPublicPath("/contact/")).toBe(false);
    expect(isUnknownPublicPath("/about//")).toBe(true);
    expect(normalizePublicPathname("/about/")).toBe("/about");
    expect(normalizePublicPathname("/")).toBe("/");
    expect(isUnknownPublicPath("/privacy/typo")).toBe(true);
    expect(isUnknownPublicPath("/")).toBe(false);
  });
});

describe("public agent and company information", () => {
  it("uses substantial source-aligned About and Contact copy", () => {
    expect(ABOUT_PARAGRAPHS.join(" ").length).toBeGreaterThanOrEqual(500);
    expect(CONTACT_PARAGRAPHS.join(" ").length).toBeGreaterThanOrEqual(500);
    expect(PUBLIC_MARKDOWN["/about"]).toContain("Ontario, Canada");
    expect(PUBLIC_MARKDOWN["/contact"]).toContain(CONTACT_EMAIL);
    expect(HOME_MARKDOWN).toContain("/features/treatment-memory");
    expect(NOT_FOUND_MARKDOWN).toContain("/sitemap.xml");
  });
  it("publishes and links indexable trust anchors", () => {
    for (const route of ["/about", "/contact", "/privacy"]) {
      expect(MARKETING_PAGES.find((p) => p.path === route)?.indexable).toBe(true);
    }
    const company = FOOTER_GROUPS.find((group) => group.title === "Company");
    expect(company?.links.map((link) => link.href)).toContain("/about");
    expect(company?.links.map((link) => link.href)).toContain("/contact");
  });
  it("adds honest structured contact and country-level address without inventing contact details", () => {
    const organization = organizationLd();
    expect(organization.contactPoint).toEqual(expect.arrayContaining([
      expect.objectContaining({ "@type": "ContactPoint", contactType: "customer support", email: CONTACT_EMAIL }),
    ]));
    expect(organization.address).toEqual({
      "@type": "PostalAddress", addressRegion: "Ontario", addressCountry: "CA",
    });
    expect(JSON.stringify(organization)).not.toContain("streetAddress");
    expect(JSON.stringify(organization)).not.toContain("telephone");
  });
  it("pins post-render Vary: Accept to the three public representations only", () => {
    const config = JSON.parse(readFileSync(path.resolve(process.cwd(), "vercel.json"), "utf8"));
    expect(config.crons).toHaveLength(3); // existing scheduling remains unchanged
    const varyRules = config.routes;
    expect(varyRules).toHaveLength(2);
    const matches = (route: string) => varyRules.some((rule: {src:string;continue:boolean;transforms:Array<{type:string;op:string;target:{key:string};args:string}>}) =>
      rule.continue === true &&
      new RegExp(rule.src).test(route) &&
      rule.transforms.some((t) =>
        t.type === "response.headers" && t.op === "append" &&
        t.target.key.toLowerCase() === "vary" && t.args.toLowerCase() === "accept",
      ),
    );
    for (const route of ["/", "/about", "/contact", "/about/", "/contact/"]) expect(matches(route)).toBe(true);
    for (const route of ["/clients", "/api/cron/calendar-sync", "/portal/verify/token", "/privacy", "/features/treatment-memory", "/about/private"]) expect(matches(route)).toBe(false);
  });
  it("follows llms.txt v2 H1, summary, guidance, H2 file-list format", () => {
    const value = readFileSync(path.resolve(process.cwd(), "public/llms.txt"), "utf8");
    expect(value).toMatch(/^# Hone\n\n> /);
    expect(value).toContain("## When to use Hone");
    expect(value).toMatch(/- \[Treatment memory\]\(https:\/\/hone\.care\/features\/treatment-memory\)/);
    expect(value).toContain("/about");
    expect(value).toContain("/contact");
    expect(value).not.toContain("https://hone.care/clients/");
  });
});
