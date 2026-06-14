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

    // Visual proof added in the density pass: the Records section shows a
    // printable procedure-record mockup and the Smarter-prep section shows
    // the Daily prep "tomorrow morning" brief.
    await expect(
      page.getByText("Print this client's procedure record"),
    ).toBeVisible();
    await expect(page.getByText("Tomorrow morning")).toBeVisible();
    await expect(page.getByText("Based on recorded Hone data.")).toBeVisible();

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

    // The density-pass visuals stack under their copy and fit the phone
    // (no overflow asserted above covers the record + prep mockups).
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
