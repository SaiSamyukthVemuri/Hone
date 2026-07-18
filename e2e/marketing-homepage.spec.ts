import { test, expect, type Page } from "@playwright/test";

// Public marketing homepage smoke (flagship rebuild). The homepage is a static,
// public, server-rendered page (no auth/DB), so no seed or login is needed.
// Category: electrolysis practice software; differentiator: treatment memory;
// one conversion: the founder-led walkthrough (a "Request", never a "Book",
// because /demo is a lead-capture flow). Checks the hero, the required sections,
// the CAD pricing teaser, the signature product visual, trust, sign-in, and no
// horizontal overflow on phone and desktop.

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

  test("category hero, sections, CAD pricing, trust, walkthrough CTA", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "Electrolysis practice software that remembers every treatment.",
        level: 1,
      }),
    ).toBeVisible();
    await expectNoPageOverflow(page, "homepage desktop");

    // Primary CTA is "Request …" (never "Book") and links to /demo.
    const headerCta = page.getByRole("link", { name: "Request a walkthrough" }).first();
    await expect(headerCta).toBeVisible();
    expect(await headerCta.getAttribute("href")).toBe("/demo");
    await expect(page.getByText(/Book a walkthrough|Book the walkthrough/)).toHaveCount(0);

    // Required sections.
    await expect(
      page.getByRole("heading", { name: "Most tools stop at the appointment." }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "The part other tools forget." }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "See if Hone fits your studio." }),
    ).toBeVisible();

    // Signature product visual (anonymized demo data).
    await expect(page.getByText("Before today").first()).toBeVisible();
    await expect(page.getByText(/Maya R\./).first()).toBeVisible();

    // CAD pricing teaser (not the old $19 pilot).
    await expect(page.getByText("CAD $49")).toBeVisible();
    await expect(page.getByText("Most popular")).toBeVisible();
    await expect(page.getByText("$19")).toHaveCount(0);

    // Trust: evidence-backed claims + policy link.
    await expect(page.getByText("Studio data stays isolated")).toBeVisible();
    await expect(page.getByRole("link", { name: "privacy policy" })).toBeVisible();

    // Sign in reachable, links to /login.
    const signIn = page.getByRole("link", { name: "Sign in" }).first();
    await expect(signIn).toBeVisible();
    expect(await signIn.getAttribute("href")).toBe("/login");

    // The hero CTA navigates to the walkthrough page.
    await page.getByRole("link", { name: "Request a 15-minute walkthrough" }).first().click();
    await page.waitForURL(/\/demo/);
  });
});

test.describe("marketing homepage (mobile)", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("fits the phone; menu exposes the CTA and sign in", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "Electrolysis practice software that remembers every treatment.",
        level: 1,
      }),
    ).toBeVisible();
    await expectNoPageOverflow(page, "homepage mobile");

    // Product visual stacks under the copy and fits the phone.
    await expect(page.getByText("Before today").first()).toBeVisible();

    // The menu exposes the walkthrough CTA and Sign in.
    await page.getByRole("button", { name: "Menu" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("link", { name: "Request a walkthrough" })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expectNoPageOverflow(page, "homepage mobile menu open");
  });
});
