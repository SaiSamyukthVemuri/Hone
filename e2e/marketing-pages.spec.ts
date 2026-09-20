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

// The two policy routes were missing from this file entirely. They are public,
// indexable and linked from every footer, and they are the pair MARKETING-01b
// repaired: their shell used to wrap the header and the footer in <main>, so
// "skip to main content" skipped nothing. They now go through the same checks
// as every other public route, plus the bypass proof below.
const POLICY_ROUTES: { path: string; h1: string }[] = [
  { path: "/privacy", h1: "Hone Privacy Policy" },
  { path: "/terms", h1: "Hone Terms of Service" },
];

const ALL_ROUTES = [...ROUTES, ...POLICY_ROUTES];

/**
 * The landmark facts, read from the live DOM rather than from markup order.
 *
 * `closest()` answers the question the HTML spec actually asks: a <header> is
 * the BANNER only when no sectioning ancestor stands between it and the body.
 * PolicyLayout legitimately puts the policy title in a <header> inside its
 * <article>, so "is there a header inside main" is the wrong question and
 * would fail both policy routes for being correct.
 */
async function landmarks(page: Page) {
  return page.evaluate(() => {
    const SECTIONING = "article, aside, main, nav, section";
    const main = document.querySelector("main#main-content");
    const banner = [...document.querySelectorAll("header")].find(
      (h) => !h.closest(SECTIONING),
    );
    const contentinfo = [...document.querySelectorAll("footer")].find(
      (f) => !f.closest(SECTIONING),
    );
    return {
      mainCount: document.querySelectorAll("main, [role='main']").length,
      bypassTarget: Boolean(main),
      bannerExists: Boolean(banner),
      contentInfoExists: Boolean(contentinfo),
      bannerInsideMain: Boolean(main && banner && main.contains(banner)),
      contentInfoInsideMain: Boolean(main && contentinfo && main.contains(contentinfo)),
    };
  });
}

/**
 * WCAG 2.4.1, proved the way a keyboard user experiences it.
 *
 * Server-rendered markup can show the skip link is FIRST IN THE DOM. Only a
 * browser can show that Tab reaches it, that focusing it makes it visible
 * rather than leaving it clipped to 1px, and that activating it actually moves
 * the tab sequence past the repeated nav — which is the whole point of the
 * bypass and the thing the source-token version could not see.
 */
async function bypassWorks(page: Page, label: string) {
  const l = await landmarks(page);
  expect(l.mainCount, `${label}: exactly one main landmark`).toBe(1);
  expect(l.bypassTarget, `${label}: main#main-content exists`).toBe(true);
  expect(l.bannerExists, `${label}: a banner landmark exists`).toBe(true);
  expect(l.contentInfoExists, `${label}: a contentinfo landmark exists`).toBe(true);
  expect(l.bannerInsideMain, `${label}: banner is outside main`).toBe(false);
  expect(l.contentInfoInsideMain, `${label}: contentinfo is outside main`).toBe(false);

  const skip = page.locator('a[href="#main-content"]');
  await expect(skip, `${label}: the page has a bypass link`).toHaveCount(1);

  await page.keyboard.press("Tab");
  await expect(skip, `${label}: the first Tab reaches the skip link`).toBeFocused();

  // Focused, it must actually appear. `sr-only` alone clips it to 1px, which
  // would leave sighted keyboard users — most of the people it helps — with an
  // invisible focus stop.
  const box = await skip.boundingBox();
  expect(box?.width ?? 0, `${label}: the focused skip link is still clipped`).toBeGreaterThan(50);

  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  const landedInMain = await page.evaluate(() => {
    const main = document.querySelector("main#main-content");
    return Boolean(main && document.activeElement && main.contains(document.activeElement));
  });
  expect(landedInMain, `${label}: tabbing after the bypass still lands outside main`).toBe(true);
}

async function noOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  expect(w.s, `${label}: no horizontal overflow`).toBeLessThanOrEqual(w.c);
}

test.describe("marketing routes are public + well-formed", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const route of ALL_ROUTES) {
    test(`${route.path} — 200, one H1, landmarks`, async ({ page }) => {
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
      await bypassWorks(page, `${route.path} @1280`);
    });
  }
});

test.describe("marketing routes fit small screens", () => {
  test.use({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });

  for (const route of ALL_ROUTES) {
    test(`${route.path} — no phone overflow`, async ({ page }) => {
      await page.goto(route.path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await noOverflow(page, `${route.path} mobile`);
    });
  }
});

// The policy routes carry the repair this lane made, so they are proved at the
// three widths the shell actually changes behaviour across: phone, tablet, and
// desktop. The bypass has to work at every one of them — a nav that collapses
// into a menu button at 390 is still a nav to tab through.
for (const width of [390, 768, 1440]) {
  test.describe(`policy routes bypass the nav at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const route of POLICY_ROUTES) {
      test(`${route.path} @${width}`, async ({ page }) => {
        const resp = await page.goto(route.path);
        expect(resp?.status(), `${route.path} status`).toBe(200);
        await expect(page.getByRole("heading", { level: 1, name: route.h1 })).toBeVisible();
        await bypassWorks(page, `${route.path} @${width}`);
        await noOverflow(page, `${route.path} @${width}`);
      });
    }
  });
}

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
