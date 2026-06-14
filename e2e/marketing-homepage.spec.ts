import { test, expect, type Page } from "@playwright/test";

// Public marketing homepage smoke. The homepage is a static, public,
// server-rendered page (no auth, no DB), so this spec needs no seed or
// login. PR #244 rewrote the copy in a human, electrologist-first voice
// (public category phrase: "Treatment memory for electrologists."). It
// checks that phrase renders, the page fits the viewport on phone and
// desktop with no horizontal overflow, the Book walkthrough CTA and
// pricing are visible, the forward-looking "Smarter prep" section is
// present, and Sign in is reachable.

async function expectNoPageOverflow(page: Page, label: string) {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    widths.scrollWidth,
    `${label}: page must not scroll horizontally (scrollWidth ${widths.scrollWidth} vs clientWidth ${widths.clientWidth})`,
  ).toBeLessThanOrEqual(widths.clientWidth);
}

test.describe("marketing homepage (desktop)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("category positioning, CTAs, pricing, smarter-prep section, sign in", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "Treatment memory for electrologists.",
        level: 1,
      }),
    ).toBeVisible();
    await expectNoPageOverflow(page, "homepage desktop");

    // Book walkthrough CTA (header button + hero) links to /demo.
    const headerCta = page
      .getByRole("link", { name: "Book walkthrough" })
      .first();
    await expect(headerCta).toBeVisible();
    expect(await headerCta.getAttribute("href")).toBe("/demo");

    // Pricing visible.
    await expect(page.getByText("$19").first()).toBeVisible();
    await expect(page.getByText(/Founding pilot/).first()).toBeVisible();

    // Forward-looking section is present, in plain language (PR #244).
    await expect(
      page.getByRole("heading", { name: "Smarter prep, without autopilot." }),
    ).toBeVisible();

    // The key product mockups all render — the hero app-window preview,
    // the Before Today centerpiece, the procedure-record mockup, the
    // proof strip (PR #247 marquee — items appear twice, so .first()),
    // and the Daily prep brief.
    await expect(page.getByText("Demo Studio · Today")).toBeVisible();
    await expect(page.getByText("Before Today · Maya R.")).toBeVisible();
    await expect(
      page.getByText("Built with working electrologists").first(),
    ).toBeVisible();
    await expect(
      page.getByText("Print this client's procedure record"),
    ).toBeVisible();
    await expect(page.getByText("Tomorrow morning")).toBeVisible();
    await expect(page.getByText("Based on recorded Hone data.")).toBeVisible();

    // PR #247: the Calendar-vs-Hone comparison renders both product
    // cards — the limited appointment card and the treatment-memory card.
    await expect(page.getByText("Appointment data")).toBeVisible();
    await expect(page.getByText("Treatment memory", { exact: true })).toBeVisible();
    await expect(page.getByText("10:00 AM").first()).toBeVisible();
    await expect(
      page.getByText("Aftercare not marked last session").first(),
    ).toBeVisible();

    // PR #248: the Privacy section is a compact checklist (not the old
    // 5-card grid); the claims and the policy link render.
    await expect(page.getByText("Studio data stays isolated.")).toBeVisible();
    await expect(page.getByText("Secure sign-in.")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "privacy policy" }),
    ).toBeVisible();

    // Sign in reachable in the header nav, links to /login.
    const signIn = page.getByRole("link", { name: "Sign in" }).first();
    await expect(signIn).toBeVisible();
    expect(await signIn.getAttribute("href")).toBe("/login");

    // The hero CTA navigates to the walkthrough page.
    await page.getByRole("link", { name: "Book a walkthrough" }).first().click();
    await page.waitForURL(/\/demo/);
  });
});

test.describe("marketing homepage (mobile)", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("fits the phone, menu exposes CTA and sign in", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "Treatment memory for electrologists.",
        level: 1,
      }),
    ).toBeVisible();
    await expectNoPageOverflow(page, "homepage mobile");

    // The product mockups stack under their copy and fit the phone
    // (the no-overflow assertion above covers the app-window frames,
    // Before Today centerpiece, record, and prep mockups).
    await expect(page.getByText("Before Today · Maya R.")).toBeVisible();
    await expect(
      page.getByText("Print this client's procedure record"),
    ).toBeVisible();
    await expect(page.getByText("Tomorrow morning")).toBeVisible();

    // Hero CTA is reachable on the phone.
    await expect(
      page.getByRole("link", { name: "Book a walkthrough" }).first(),
    ).toBeVisible();

    // The menu exposes the Book walkthrough CTA and Sign in.
    await page.getByRole("button", { name: "Menu" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("link", { name: "Book walkthrough" })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expectNoPageOverflow(page, "homepage mobile menu open");
  });
});
