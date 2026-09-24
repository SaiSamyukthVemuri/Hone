import { test, expect, type Page } from "@playwright/test";

// Public marketing homepage smoke (copy deck v2.2, MKT-02B). The homepage is a
// static, public, server-rendered page (no auth/DB), so no seed or login is
// needed. Category: electrolysis practice software; differentiator: treatment
// memory; one conversion: the founder-led walkthrough (a "Request", never a
// "Book", because /demo is a lead-capture flow).
//
// The H1 is now the PROMISE, not the category — the category is the eyebrow
// directly above it. The film's own behaviour is proved separately, in
// marketing-homepage-film.spec.ts; this spec checks the page around it.

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
        name: "Start the next treatment where the last one ended.",
        level: 1,
      }),
    ).toBeVisible();
    // The category is the eyebrow, and it is no longer duplicated in the H1.
    await expect(page.getByText("Electrolysis practice software").first()).toBeVisible();
    await expectNoPageOverflow(page, "homepage desktop");

    // Primary CTA is "Request …" (never "Book") and links to /demo.
    const headerCta = page.getByRole("link", { name: "Request a walkthrough" }).first();
    await expect(headerCta).toBeVisible();
    expect(await headerCta.getAttribute("href")).toBe("/demo");
    await expect(page.getByText(/Book a walkthrough|Book the walkthrough/)).toHaveCount(0);

    // The deck's nine blocks, each by its heading, in the order they appear.
    for (const name of [
      "Before the client sits down",
      "Every area keeps its own history",
      "More than a note",
      "Know what was used, and when",
      "Your client records should stay yours.",
      "Simple plans, in Canadian dollars.",
      "See it with a returning client.",
    ]) {
      await expect(page.getByRole("heading", { name }), `missing: ${name}`).toBeVisible();
    }

    // The trust strip: four lines, one row, no heading.
    await expect(page.getByText("Records isolated by studio")).toBeVisible();
    await expect(
      page.getByText("Imported history stays marked as imported"),
    ).toBeVisible();

    // Signature product visual (anonymized demo data).
    await expect(page.getByText("Before today").first()).toBeVisible();
    await expect(page.getByText(/Maya R\./).first()).toBeVisible();

    // CAD pricing (not the old $19 pilot). No badge on any plan here — the
    // deck removed it from the homepage; /pricing owns plan emphasis.
    await expect(page.getByText("CAD $49")).toBeVisible();
    await expect(page.getByText("$19")).toHaveCount(0);

    // Ownership: evidence-backed claims + policy link. The export line names
    // its subset rather than claiming "full studio history" (TRUTH-01A).
    await expect(page.getByText("Each studio's records are isolated")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Export your records as CSV, on every plan" }),
    ).toBeVisible();
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
        name: "Start the next treatment where the last one ended.",
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
