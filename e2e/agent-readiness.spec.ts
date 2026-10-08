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
    expect(html.headers()["vary"]?.toLowerCase()).toContain("accept");
    expect(await html.text()).toContain("<html");
  });

  test("unknown URL is a genuine 404 in both representations", async ({ request }) => {
    for (const route of ["/not-a-real-hone-page-agent-test", "/features/not-a-real-feature"]) {
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
