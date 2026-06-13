import { test, expect, type Page } from "@playwright/test";

// PR #242: public marketing homepage smoke. The homepage is a static,
// public, server-rendered page (no auth, no DB), so this spec needs
// no seed or login. It checks the category positioning renders, the
// page fits the viewport on phone and desktop with no horizontal
// overflow, the Book walkthrough CTA and pricing are visible, the
// agentic section is present, and Sign in is reachable.

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

  test("category positioning, CTAs, pricing, agentic section, sign in", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "Treatment memory for permanent hair removal studios.",
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

    // Agentic section visible (support + safety merged, PR #243).
    await expect(
      page.getByRole("heading", {
        name: "Agentic support, but practitioner-controlled.",
      }),
    ).toBeVisible();
    await expect(page.getByText("Assistant, not decider").first()).toBeVisible();

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
        name: "Treatment memory for permanent hair removal studios.",
        level: 1,
      }),
    ).toBeVisible();
    await expectNoPageOverflow(page, "homepage mobile");

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
