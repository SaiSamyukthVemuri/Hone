import { test, expect } from "@playwright/test";
import { seedE2eStudio, seedE2eClient } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Client-page outside-hours booking parity (owner flow). The owner sees the
// "Book outside your normal availability" override on the client profile's Book
// appointment card, enters an out-of-hours time, confirms, and books — reusing
// the same server action + override contract as the calendar Quick Book. The
// server-side owner enforcement is proven in the unit test; this proves the
// owner UI end-to-end at mobile width.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true });

test("owner books an out-of-hours appointment from the client page", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);

  await page.goto(`/clients/${clientId}`);
  await page.getByRole("button", { name: /\+ Book appointment/i }).click();

  // The owner-only override toggle is visible.
  const overrideToggle = page.getByLabel(/Book outside your normal availability/i);
  await expect(overrideToggle).toBeVisible({ timeout: 20_000 });
  await overrideToggle.check();

  // The explicit warning appears.
  await expect(
    page.getByText(/This time is outside your normal availability/i),
  ).toBeVisible();

  // Pick a future date + an out-of-hours time (23:30, outside the seeded
  // 06:00–22:00 window), then confirm.
  await page.locator('input[type="date"]').fill("2099-06-15");
  await page.locator('input[type="time"]').fill("23:30");
  await page.getByLabel(/I confirm I want to book this out-of-hours time/i).check();

  await page.getByRole("button", { name: /Book out-of-hours/i }).click();

  // Success redirects to the created appointment on the calendar.
  await page.waitForURL(/\/calendar\/[0-9a-f-]{36}/, { timeout: 20_000 });
});
