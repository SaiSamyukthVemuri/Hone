import { expect, test } from "@playwright/test";

test.describe("public agent readiness", () => {
  test("homepage negotiates Markdown and preserves HTML", async ({ request }) => {
    const md = await request.get("/", { headers: { Accept: "text/markdown" } });
    expect(md.status()).toBe(200);
    expect(md.headers()["content-type"]).toMatch(/^text\/markdown/);
    expect(md.headers()["vary"]?.toLowerCase()).toContain("accept");
    expect(await md.text()).toContain("# Start the next treatment");

    const html = await request.get("/", { headers: { Accept: "text/html" } });
    expect(html.status()).toBe(200);
    expect(html.headers()["content-type"]).toMatch(/^text\/html/);
    // Next 15.5 overwrites Vary on its local HTML render. The deployed CDN
    // response transform owns the final Vary and is verified independently
    // against an actual preview/production URL by scripts/verify-agent-readiness.mjs.
    if (process.env.HONE_VERIFY_EDGE_VARY === "1") {
      expect(html.headers()["vary"]?.toLowerCase()).toContain("accept");
    }
    expect(await html.text()).toContain("<html");
  });

  test("unknown URL is a genuine 404 in both representations", async ({ request }) => {
    for (const route of ["/not-a-real-hone-page-agent-test", "/features/not-a-real-feature", "/features/not-a-real-feature/", "/features/waitlist-invitation", "/features/waitlist-invitation/"]) {
    for (const [accept, type] of [
      ["text/markdown", "text/markdown"],
      ["text/html", "text/html"],
    ]) {
      const response = await request.get(route, {
        headers: { Accept: accept },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(404);
      expect(response.headers()["content-type"]).toContain(type);
      expect(response.headers()["vary"]?.toLowerCase()).toContain("accept");
      const body = await response.text();
      expect(body.length).toBeGreaterThan(20);
      expect(body).toContain("/llms.txt");
    }
    }
  });

  test("feature page remains public with a trailing slash (no login redirect)", async ({ request }) => {
    const response = await request.get("/features/treatment-memory/", {
      headers: { Accept: "text/html" },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(200);
    expect(new URL(response.url()).pathname).toBe("/features/treatment-memory/");
    const body = await response.text();
    expect(body).toContain("Remember every treatment, before the client sits down.");
    expect(body).not.toContain("<title>Sign in");
  });

  test("trailing slash trust routes preserve HTML and Markdown", async ({ request }) => {
    for (const route of ["/about/", "/contact/"]) {
      const html = await request.get(route, {
        headers: { Accept: "text/html" },
        maxRedirects: 0,
      });
      expect(html.status()).toBe(200);
      expect(html.headers()["content-type"]).toMatch(/^text\/html/);
      const markdown = await request.get(route, { headers: { Accept: "text/markdown" } });
      expect(markdown.status()).toBe(200);
      expect(markdown.headers()["content-type"]).toMatch(/^text\/markdown/);
    }
  });
  test("trust pages and machine-readable files remain accessible", async ({ request }) => {
    for (const route of ["/about", "/contact", "/privacy"]) {
      const response = await request.get(route);
      expect(response.status()).toBe(200);
      const body = await response.text();
      expect(body.length).toBeGreaterThan(500);
    }
    const guide = await request.get("/llms.txt");
    expect(guide.status()).toBe(200);
    expect(await guide.text()).toContain("## When to use Hone");
    for (const route of ["/robots.txt", "/sitemap.xml"]) {
      const response = await request.get(route);
      expect(response.status()).toBe(200);
    }
  });
});
