import { expect, test } from "@playwright/test";

import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import { seedE2eMember, seedE2eStudio, type E2eSeed } from "./helpers/seed";

// ===========================================================================
// OWNER CAPACITY — the surface, in a real browser
// ===========================================================================
//
// The numbers themselves are proved against the real database in
// tests/db/owner-capacity.db.test.ts. What only a browser can show is that the
// route resolves inside the authenticated shell, that the owner reaches it from
// the Dashboard, that an ordinary practitioner is refused AND is never offered
// the link, and that the briefing is readable on a 390px phone without the most
// important figures hiding behind a tab.

let seed: E2eSeed;

test.beforeAll(async () => {
  seed = await seedE2eStudio();
});

test("the owner reaches Practice capacity from the Dashboard and reads the briefing", async ({
  page,
}) => {
  await loginAsOwner(page, seed);

  await page.getByRole("link", { name: /practice capacity/i }).click();
  await page.waitForURL(/\/dashboard\/capacity/);

  await expect(page.getByRole("heading", { name: "Practice capacity" })).toBeVisible();

  // The six blocks the briefing promises, all on one page.
  for (const heading of [
    "Admission capacity",
    "Clients",
    "New-client demand",
    "Treatment access",
    "Capacity by week",
    "Recurring demand visibility",
  ]) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }

  // A fresh studio records no treatment plans, so the active-client figure and
  // the admission count must both refuse to answer rather than print 0.
  await expect(page.getByText(/not enough evidence yet/i).first()).toBeVisible();
  await expect(page.getByText(/it is not zero/i).first()).toBeVisible();
  // A group whose figures are all unknown states the reason ONCE and drops the
  // empty cards, rather than printing four labelled boxes of the same sentence.
  await expect(page.getByText("0 future treatments")).toHaveCount(0);
  // A figure that IS knowable still prints, even when its neighbours cannot:
  // nobody has booked a consultation here, and zero is the honest answer.
  await expect(page.getByRole("heading", { name: /next 7 days/i })).toBeVisible();
});

test("an ordinary practitioner is refused, and is never offered the link", async ({ page }) => {
  const member = await seedE2eMember(seed);
  await loginByMagicLink(page, member.email);

  await expect(page.getByRole("link", { name: /practice capacity/i })).toHaveCount(0);

  await page.goto("/dashboard/capacity");
  await expect(page.getByText(/only studio owners can see practice capacity/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Admission capacity" })).toHaveCount(0);
});

test("the briefing is usable on a 390px phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAsOwner(page, seed);
  await page.goto("/dashboard/capacity");

  await expect(page.getByRole("heading", { name: "Practice capacity" })).toBeVisible();
  // Nothing is buried: the admission answer is on screen without scrolling past
  // a tab strip, and the week table scrolls inside itself rather than dragging
  // the page sideways.
  await expect(page.getByRole("heading", { name: "Admission capacity" })).toBeVisible();
  const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(bodyWidth).toBeLessThanOrEqual(390);
});
