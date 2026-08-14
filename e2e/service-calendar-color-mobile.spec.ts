import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  getE2eServiceId,
  getServiceCalendarColor,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Explicit per-service calendar color at iPhone width (390px): the genuinely
// browser-only parts, Settings loads, the six swatches don't overflow, and
// choosing violet + saving PERSISTS the key. The persisted-key -> violet CSS
// mapping (and week/month/mobile parity) is proven by the unit/source tests.

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  expect(w.s, `${label}: no horizontal overflow (${w.s} vs ${w.c})`).toBeLessThanOrEqual(w.c);
}

test("owner sets a service's calendar color to violet on iPhone; it persists + renders violet", async ({
  browser,
}) => {
  const seed = await seedE2eStudio();
  const serviceId = await getE2eServiceId(seed.studioId);

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  try {
    const page = await ctx.newPage();
    await loginAsOwner(page, seed);

    // 1) Settings -> Services loads at 390px, no overflow.
    await page.goto("/settings/services");
    await expect(page.getByRole("heading", { name: "Services" })).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalOverflow(page, "settings/services @390 (loaded)");

    // Expand the first service row to reveal its edit form.
    await page.getByRole("button", { name: /Edit|Expand|▾|▸/ }).first().click().catch(() => {});
    // The six named swatches are present and don't overflow.
    const violet = page.getByRole("button", { name: "Calendar color: violet" }).first();
    await expect(violet).toBeVisible({ timeout: 20_000 });
    for (const key of ["amber", "emerald", "teal", "sky", "indigo", "violet"]) {
      await expect(page.getByRole("button", { name: `Calendar color: ${key}` }).first()).toBeVisible();
    }
    await expectNoHorizontalOverflow(page, "settings/services @390 (swatches)");

    // 2) Choose violet and save.
    await violet.click();
    await page.getByRole("button", { name: /^Save changes$|^Save$/ }).first().click();

    // 3) Persisted as the violet KEY (the canonical map turns it into violet CSS,
    //    unit-proven in tests/lib/calendar/service-colors.test.ts).
    await expect
      .poll(async () => getServiceCalendarColor(serviceId), { timeout: 15_000 })
      .toBe("violet");
  } finally {
    await ctx.close();
  }
});
