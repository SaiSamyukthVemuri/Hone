import { test, expect, type Page } from "@playwright/test";

// Marketing site smoke across every shipped public route. These pages are
// static, public, server-rendered (no auth/DB), so no seed/login is needed.
// Each must be reachable by an anonymous visitor (200, not a /login bounce),
// have exactly one H1 with the expected text, expose semantic landmarks, and
// never scroll horizontally on phone, tablet, or desktop.

const ROUTES: { path: string; h1: string }[] = [
  // ONE ROW PER OWNING LANE, which is what made the merge conflict resolvable
  // without choosing a side: / is MKT-02A's (#762), /pricing is MKT-02D's (#761),
  // and /electrolysis-software, the two /features pages and /demo are MKT-02E's.
  // Each lane changed only its own rows; the conflict was purely positional.
  { path: "/", h1: "Start the next treatment where the last one ended." },
  { path: "/pricing", h1: "Simple plans, in Canadian dollars." },
  { path: "/electrolysis-software", h1: "Electrolysis software built around how electrolysis is charted" },
  { path: "/features/treatment-memory", h1: "Remember every treatment, before the client sits down." },
  { path: "/features/booking-calendar", h1: "Booking connected to the treatment record" },
  { path: "/features/charting-records", h1: "Electrolysis charting built around treatments, not generic notes" },
  { path: "/resources", h1: "Practical guides for running an electrolysis practice." },
  { path: "/resources/electrolysis-treatment-record-checklist", h1: "What to record in an electrolysis treatment record" },
  { path: "/resources/moving-an-electrolysis-practice-from-paper-records", h1: "Moving an electrolysis practice from paper records" },
  { path: "/demo", h1: "See it with a returning client" },
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
    });
  }
});

test.describe("marketing routes fit small screens", () => {
  test.use({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });

  for (const route of ROUTES) {
    test(`${route.path} — no phone overflow`, async ({ page }) => {
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

// THE SAME PLAYER ON A SECOND PAGE, WHICH IS WHY THIS IS NOT A DUPLICATE OF
// e2e/marketing-homepage-film.spec.ts. That spec is the deep proof of the
// ProductFilm and it runs on `/`, where the film AUTOPLAYS (MKT-03). /demo uses
// the component with no props, which is the MANUAL contract: a lead form whose
// visitors did not come for 3.6 MB of video. What is unproven is that call
// site, so both properties are asserted against /demo specifically, by the same
// methods that spec uses -- request counting and keyboard drive.
const FILM_URL = /\/film\/hone-treatment-memory-v3-1\.mp4/;

test.describe("the product film on /demo", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("/demo — nothing is fetched, and no video exists, until someone asks", async ({ page }) => {
    // "Video lazy" as ZERO REQUESTS, not as `preload="none"`: the attribute is a
    // hint a browser may ignore, and the 3.6 MB is spent on a visitor who came
    // to fill in a form either way.
    const hits: string[] = [];
    page.on("request", (r) => {
      if (FILM_URL.test(r.url())) hits.push(r.url());
    });

    await page.goto("/demo");
    await expect(page.getByRole("button", { name: /^Play:/ })).toBeVisible();
    await expect(page.locator("video")).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(
      hits,
      `the film was fetched on /demo before anyone pressed play: ${hits.join(", ")}`,
    ).toHaveLength(0);
  });

  // Pressing play REMOVES the poster's start button. The button holding focus
  // is unmounted, and focus on a removed element falls to <body> — the visitor
  // who just asked for the film is silently returned to the top of the
  // document, with the Pause control they now need reachable only by tabbing
  // the whole page again. Driven by keyboard, because that is who it happens to.
  test("/demo — keyboard play hands focus to the Pause control, and the film plays", async ({ page }) => {
    await page.goto("/demo");

    const play = page.getByRole("button", { name: /^Play:/ });
    await expect(play).toBeVisible();
    await play.focus();
    await page.keyboard.press("Enter");

    const pause = page.getByRole("button", { name: "Pause the product film" });
    await expect(pause).toBeFocused();
    expect(
      await page.evaluate(() => document.activeElement?.tagName ?? ""),
      "focus fell out of the film when the start button unmounted",
    ).toBe("BUTTON");

    // And the film is genuinely playing — the state the focus was handed to.
    const video = page.locator("video");
    await expect
      .poll(async () => video.evaluate((v) => (v as HTMLVideoElement).currentTime), { timeout: 20_000 })
      .toBeGreaterThan(0.2);
  });
});
