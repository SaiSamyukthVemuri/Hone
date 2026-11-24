import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  getE2eServiceId,
  getServiceCalendarColor,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

import { SERVICE_COLOR_KEYS } from "../lib/calendar/service-colors";

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

    const row = page.getByTestId(`service-row-${serviceId}`);
    await row.getByRole("button", { name: `Edit ${seed.serviceName}`, exact: true }).click();
    const editor = page.getByRole("form", { name: `Edit ${seed.serviceName}`, exact: true });
    const preview = editor.getByTestId("service-calendar-preview");
    await expect(preview).toContainText(seed.serviceName);
    for (const key of SERVICE_COLOR_KEYS) {
      const swatch = editor.getByRole("button", { name: `Calendar color: ${key}`, exact: true });
      await expect(swatch).toBeVisible();
      const bounds = await swatch.boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalOverflow(page, "settings/services @390 (swatches)");

    const violet = editor.getByRole("button", { name: "Calendar color: violet" });
    await violet.tap();
    await expect(violet).toHaveAttribute("aria-pressed", "true");
    await expect(preview).toHaveClass(/bg-violet-100/);
    await editor.getByRole("button", { name: /^Save( changes| service)?$/i }).tap();

    // 3) Persisted as the violet KEY (the canonical map turns it into violet CSS —
    //    unit-proven in tests/lib/calendar/service-colors.test.ts).
    await expect
      .poll(async () => getServiceCalendarColor(serviceId), { timeout: 15_000 })
      .toBe("violet");
  } finally {
    await ctx.close();
  }
});

test("service edits and navigation survive an expanded screen and device rotation", async ({ page }) => {
  const seed = await seedE2eStudio();
  const serviceId = await getE2eServiceId(seed.studioId);
  // Embedded browsers and some phones cannot enter native fullscreen.
  await page.addInitScript(() => {
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: false });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsOwner(page, seed);
  await page.goto("/settings/services");
  await page.getByTestId(`service-row-${serviceId}`).getByRole("button", {
    name: `Edit ${seed.serviceName}`, exact: true,
  }).click();

  const editor = page.getByRole("form", { name: `Edit ${seed.serviceName}`, exact: true });
  const value = "Unsaved service name";
  const name = editor.getByRole("textbox", { name: "Service name" });
  await name.fill(value);
  await page.getByRole("button", { name: "Full screen", exact: true }).click();

  const shell = page.locator("[data-settings-screen]");
  const menu = page.getByRole("button", { name: "Settings menu" });
  const save = editor.getByRole("button", { name: /^Save( changes| service)?$/i });
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844], [844, 390], [320, 568]]) {
    await page.setViewportSize({ width, height });
    await expect(shell).toHaveAttribute("data-settings-expanded", "true");
    await expectNoHorizontalOverflow(page, `expanded editor at ${width} × ${height}`);
    await expect(name).toHaveValue(value);
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    await menu.click();
    await expect(page.getByRole("link", { name: "Overview", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
  }
  await page.getByRole("button", { name: "Exit expanded view" }).click();
  await expect(shell).toHaveAttribute("data-settings-expanded", "false");
  await expect(name).toHaveValue(value);
});
