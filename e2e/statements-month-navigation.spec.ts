import { test, expect, type Page } from "@playwright/test";

import { loginAsOwner } from "./helpers/flows";
import { seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";

// HON-100: the Statements month controls must tell ONE story. After any way of changing the month (arrow, picker, back, reload) the address bar's
// month, the picker's value and the month named on the page are the same month.
//
// THE PROPERTY under test is that agreement, not "the arrow's href is right" (the unit tests already pin the href). The picker is a native
// <input type="month">: once a person has used it, the browser treats its value as theirs, so a field that was given only a default value can keep
// showing the month they picked while an arrow moves the page to another. Only a browser can see that.
//
// Synthetic studio, read-only pages: nothing is written by the page under test.

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const label = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

let seed: E2eSeed;
test.beforeAll(async () => {
  seed = await seedE2eStudio();
  // The statements show nothing until the studio's payment currency is set (a studio starts without one).
  await sql(`insert into public.studio_payment_jurisdictions (studio_id, payment_country, payment_currency, source, verification_reference) values ($1,'CA','cad','operator','synthetic e2e')`, [seed.studioId]);
});

const picker = (page: Page) => page.getByRole("form", { name: "Choose a month" }).locator('input[type="month"]');
const urlMonth = (page: Page) => new URL(page.url()).searchParams.get("month");

/** Heading, picker and address bar all name `ym`. */
async function expectAllAgree(page: Page, ym: string, why: string) {
  await expect.poll(() => urlMonth(page), { message: `${why}: address bar`, timeout: 20_000 }).toBe(ym);
  await expect(picker(page), `${why}: picker`).toHaveValue(ym, { timeout: 20_000 });
  await expect(page.getByRole("main"), `${why}: month named on the page`).toContainText(label(ym), { timeout: 20_000 });
}

// The Studio tab and the Clients tab share the same controls; the client statement's One-month view too, but it needs a client and is covered by the
// same component. Both owner-wide tabs are driven here.
for (const base of ["/financials/statement", "/financials/statements"]) {
  test.describe(`month controls on ${base}`, () => {
    test("pick a month, then press Previous: the picker, the heading and the address bar agree", async ({ page }) => {
      await loginAsOwner(page, seed);
      await page.goto(`${base}?month=2026-03`);
      await expectAllAgree(page, "2026-03", "start");

      // Use the picker (this is what makes the field the person's own).
      await picker(page).fill("2026-01");
      await expectAllAgree(page, "2026-01", "after picking January");

      // Then the arrow.
      await page.getByRole("link", { name: "Previous month" }).click();
      await expectAllAgree(page, "2025-12", "after Previous");

      // And forward again, twice.
      await page.getByRole("link", { name: "Next month" }).click();
      await expectAllAgree(page, "2026-01", "after Next");
      await page.getByRole("link", { name: "Next month" }).click();
      await expectAllAgree(page, "2026-02", "after Next again");
    });

    test("back, forward and reload keep all three in step", async ({ page }) => {
      await loginAsOwner(page, seed);
      await page.goto(`${base}?month=2026-03`);
      await picker(page).fill("2026-01");
      await expectAllAgree(page, "2026-01", "picked");
      await page.getByRole("link", { name: "Previous month" }).click();
      await expectAllAgree(page, "2025-12", "previous");

      await page.goBack();
      await expectAllAgree(page, "2026-01", "back once");
      await page.goBack();
      await expectAllAgree(page, "2026-03", "back twice");
      await page.goForward();
      await expectAllAgree(page, "2026-01", "forward once");
      await page.reload();
      await expectAllAgree(page, "2026-01", "reload");
    });
  });
}
