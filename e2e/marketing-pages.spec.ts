import { test, expect, type Page } from "@playwright/test";

// Marketing site smoke across every shipped public route. These pages are
// static, public, server-rendered (no auth/DB), so no seed/login is needed.
// Each must be reachable by an anonymous visitor (200, not a /login bounce),
// have exactly one H1 with the expected text, expose semantic landmarks, and
// never scroll horizontally on phone, tablet, or desktop.

const ROUTES: { path: string; h1: string }[] = [
  { path: "/", h1: "Electrolysis practice software that remembers every treatment." },
  { path: "/pricing", h1: "Straightforward pricing, in Canadian dollars." },
  { path: "/electrolysis-software", h1: "Software built for an electrolysis practice, not a generic salon." },
  { path: "/features/treatment-memory", h1: "Remember every treatment, before the client sits down." },
  { path: "/features/booking-calendar", h1: "Online booking and a calendar for the treatment room." },
  { path: "/features/charting-records", h1: "Chart the treatment while it's fresh, keep clean records." },
  { path: "/resources", h1: "Practical guides for running an electrolysis practice." },
  { path: "/resources/electrolysis-treatment-record-checklist", h1: "What to record in an electrolysis treatment record" },
  { path: "/resources/moving-an-electrolysis-practice-from-paper-records", h1: "Moving an electrolysis practice from paper records" },
  { path: "/demo", h1: "Request a 15-minute Hone walkthrough." },
];

async function noOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  expect(w.s, `${label}: no horizontal overflow`).toBeLessThanOrEqual(w.c);
}

test.describe("marketing routes are public + well-formed", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const route of ROUTES) {
    test(`${route.path}: 200, one H1, landmarks`, async ({ page }) => {
      const resp = await page.goto(route.path);
      expect(resp?.status(), `${route.path} status`).toBe(200);
      // Not bounced to the practitioner login.
      expect(page.url(), `${route.path} not redirected to login`).not.toContain("/login");
      await expect(page.getByRole("heading", { level: 1, name: route.h1 })).toBeVisible();
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("header").first()).toBeVisible();
      await expect(page.locator("main")).toBeVisible();
      await expect(page.locator("footer")).toBeVisible();
      await noOverflow(page, `${route.path} desktop`);
    });
  }
});

test.describe("marketing routes fit small screens", () => {
  test.use({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });

  for (const route of ROUTES) {
    test(`${route.path}: no phone overflow`, async ({ page }) => {
      await page.goto(route.path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await noOverflow(page, `${route.path} mobile`);
    });
  }
});

test.describe("reduced motion", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("content is fully visible with prefers-reduced-motion", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/");
    // The signature product visual assembles under motion; reduced motion must
    // show its final state (all rows present) with no reliance on animation.
    await expect(page.getByText("Before today").first()).toBeVisible();
    await expect(page.getByText(/Increase spacing/).first()).toBeVisible();
    await ctx.close();
  });
});
