import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eDashboardMemoryClient,
  seedE2eMember,
  seedFutureAppointmentAt,
  getStudioTimezone,
  seedE2eStudio,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";

// ===========================================================================
// HON-65 regression (Chloe, 4 Nov 2026): the Dashboard stopped showing "Last treatment".
// ===========================================================================
// #1308 moved the one-line summary inside the CLOSED "Visit details" disclosure, and every other dashboard spec
// opens that disclosure on load, so none noticed. This spec deliberately does NOT: with the details closed, an
// owner and a practitioner each see the line on the row, at desktop and phone width, with no sideways scroll.
// LT_SHOTS_DIR (optional) writes a screenshot of each case.

const T = 15_000;

async function expectLineOnClosedRow(page: Page, shot: string) {
  const details = page.locator('details[data-testid="today-row-details"]').first();
  await expect(details).toBeAttached({ timeout: T });
  await expect(details).not.toHaveAttribute("open", "");
  const line = page.getByTestId("dashboard-memory-compact").first();
  await expect(line).toBeVisible({ timeout: T });
  await expect(line).toContainText("Last treatment:");
  await expect(line).toContainText(/upper lip/i);
  // The full chart is still behind the disclosure.
  await expect(page.getByTestId("dashboard-memory-full")).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  if (process.env.LT_SHOTS_DIR) await page.screenshot({ path: `${process.env.LT_SHOTS_DIR}/${shot}.png`, fullPage: true });
}

for (const width of [1280, 390]) {
  test.describe(`at ${width}px, details CLOSED`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } });

    test(`owner sees Last treatment on the closed row`, async ({ page }) => {
      const seed = await seedE2eStudio();
      await seedE2eDashboardMemoryClient(seed, { cautionNote: null });
      await loginByMagicLink(page, seed.ownerEmail, { openRowDetails: false });
      await page.goto("/dashboard");
      await expectLineOnClosedRow(page, `owner-${width}`);
    });

    test(`practitioner sees Last treatment on the closed row`, async ({ page }) => {
      const seed = await seedE2eStudio();
      const { clientId } = await seedE2eDashboardMemoryClient(seed, { cautionNote: null });
      const member = await seedE2eMember(seed);
      const tz = await getStudioTimezone(seed.studioId);
      await seedFutureAppointmentAt(seed.studioId, member.practitionerId, clientId, tz, "18:00");
      await loginByMagicLink(page, member.email, { openRowDetails: false });
      await page.goto("/dashboard");
      await expectLineOnClosedRow(page, `practitioner-${width}`);
    });
  });
}
