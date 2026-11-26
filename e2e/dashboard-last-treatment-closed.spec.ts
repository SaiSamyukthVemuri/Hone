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
// A practitioner sees the most recent visit without opening the full settings.
// Exercise the default row as both an owner and a practitioner at each width.
// LT_SHOTS_DIR (optional) writes a screenshot of each case.

const T = 15_000;

async function expectLineOnClosedRow(page: Page, shot: string) {
  const toggle = page.getByRole("button", { name: /^Last visit details for / }).first();
  await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: T }); // open by default (Chloe, 26 Nov)
  const line = page.getByTestId("dashboard-memory-compact").first();
  await expect(line).toBeVisible({ timeout: T });
  await expect(line).toContainText("Last treatment:");
  await expect(line).toContainText(/upper lip/i);
  // The visit uses the full line. Side-by-side actions used to squeeze long
  // notes and treatment history into a narrow column even on desktop.
  const row = line.locator("xpath=ancestor::li[1]");
  const body = row.getByTestId("today-row-body");
  const action = row.getByRole("link", { name: "Rebook", exact: true });
  const bodyBox = await body.boundingBox();
  const actionBox = await action.boundingBox();
  expect(bodyBox).not.toBeNull();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.y).toBeGreaterThanOrEqual(bodyBox!.y + bodyBox!.height - 1);
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
      await loginByMagicLink(page, seed.ownerEmail);
      await page.goto("/dashboard");
      await expectLineOnClosedRow(page, `owner-${width}`);
    });

    test(`practitioner sees Last treatment on the closed row`, async ({ page }) => {
      const seed = await seedE2eStudio();
      const { clientId } = await seedE2eDashboardMemoryClient(seed, { cautionNote: null });
      const member = await seedE2eMember(seed);
      const tz = await getStudioTimezone(seed.studioId);
      await seedFutureAppointmentAt(seed.studioId, member.practitionerId, clientId, tz, "18:00");
      await loginByMagicLink(page, member.email);
      await page.goto("/dashboard");
      await expectLineOnClosedRow(page, `practitioner-${width}`);
    });
  });
}
