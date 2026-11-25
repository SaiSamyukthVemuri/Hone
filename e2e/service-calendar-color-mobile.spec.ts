import { test, expect, type Locator, type Page } from "@playwright/test";
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

test.describe("Settings navigation on touch screens", () => {
  test.use({ hasTouch: true });

  test("menu, search, section links and Close have at least a 44px hit area", async ({ page }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
    await page.goto("/settings/services");

    async function expectTouchTarget(control: Locator) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box?.width, String(control)).toBeGreaterThanOrEqual(44);
      expect(box?.height, String(control)).toBeGreaterThanOrEqual(44);
    }

    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      const tabs = page.getByRole("navigation", { name: "Settings sections" });
      for (const name of ["Services", "Machines"]) {
        await expectTouchTarget(tabs.getByRole("link", { name, exact: true }));
      }
      for (const name of ["Settings menu", "Find a setting"]) {
        const trigger = page.getByRole("button", { name });
        await expectTouchTarget(trigger);
        await trigger.tap();
        const dialog = page.getByRole("dialog", { name, exact: true });
        const close = dialog.getByRole("button", { name: "Close", exact: true });
        await expectTouchTarget(close);
        await close.tap();
        await expect(dialog).toBeHidden();
      }
    }
  });

  test("overview directory shortcuts and category headings have at least a 44px hit area", async ({ page }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
    for (const [width, height] of [[390, 844], [820, 1180]]) {
      await page.setViewportSize({ width, height });
      await page.goto("/settings");
      await expect(page.getByRole("heading", { name: "Settings directory" })).toBeVisible();
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      const links = page.locator("#settings-directory-title ~ div section").locator("h3 a, ul a");
      const count = await links.count();
      expect(count).toBeGreaterThan(8);
      for (let i = 0; i < count; i++) {
        const box = await links.nth(i).boundingBox();
        const label = `${width}px: ${await links.nth(i).innerText()}`;
        expect(box?.height, label).toBeGreaterThanOrEqual(44);
      }
    }
  });
});

test("Settings uses the standard page width and opens the matching settings section directly", async ({ page }) => {
  const seed = await seedE2eStudio();
  await loginAsOwner(page, seed);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/notifications");
    const main = page.getByTestId("app-main");
    const normal = await main.boundingBox();
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Studio settings", exact: true })).toBeVisible();
    const settings = await main.boundingBox();
    expect(settings!.width).toBeCloseTo(normal!.width, 0);
    expect(settings!.x).toBeCloseTo(normal!.x, 0);
    await expect(page.getByRole("navigation", { name: "Settings sections" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page, `Settings at ${width}px`);
    await page.getByRole("button", { name: "Find a setting" }).click();
    const search = page.getByRole("searchbox", { name: "Find a setting" });
    await search.fill("holiday hours");
    await page.getByRole("link", { name: "Special hours", exact: true }).click();
    await expect(page).toHaveURL(/settings\/availability#special-hours$/);
    await expect(page.locator("#special-hours")).toBeInViewport();
    await page.goto("/settings");
    await page.getByRole("link", { name: "Edit new-client admission" }).click();
    await expect(page).toHaveURL(/settings\/booking\/link#admission-options$/);
    await expect(page.locator("#new-client-admission")).toBeInViewport();
  }
});

test("service edits and navigation survive device rotation in the regular page column", async ({ page }) => {
  const seed = await seedE2eStudio();
  const serviceId = await getE2eServiceId(seed.studioId);
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
  await expect(page.getByRole("button", { name: "Full screen", exact: true })).toHaveCount(0);

  const main = page.getByTestId("app-main");
  const menu = page.getByRole("button", { name: "Settings menu" });
  const save = editor.getByRole("button", { name: /^Save( changes| service)?$/i });
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844], [844, 390], [320, 568]]) {
    await page.setViewportSize({ width, height });
    expect((await main.boundingBox())!.width).toBeLessThanOrEqual(1024);
    await expectNoHorizontalOverflow(page, `service editor at ${width} × ${height}`);
    await expect(name).toHaveValue(value);
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    if (width < 911) {
      await menu.click();
      const dialog = page.getByRole("dialog", { name: "Settings menu" });
      await expect(dialog.getByRole("link", { name: "Settings overview", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveAttribute("aria-expanded", "false");
    } else {
      await expect(page.getByRole("navigation", { name: "Settings categories" })).toBeVisible();
    }
  }
  await expect(name).toHaveValue(value);
});
