import { test, expect } from "@playwright/test";
import { seedE2eStudio, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { shot } from "./helpers/settings-shots";
import type { Page } from "@playwright/test";

// WS-E · settings redesign verification, part 3: the shell's behaviour for the
// owner. Mobile drawer (below 700px), unsaved-changes guard, keyboard and focus.
// Synthetic studio only.

const T = 20_000;
let seed: E2eSeed;

/** Open a rail group (they are <details>) and follow one of its section links. */
async function go(page: Page, entry: string, section: string): Promise<void> {
  const rail = page.getByRole("navigation", { name: "Settings sections" });
  const link = rail.getByRole("link", { name: section, exact: true });
  if (!(await link.isVisible())) await rail.locator("summary", { hasText: entry }).first().click();
  await link.click();
}

test.beforeAll(async () => {
  seed = await seedE2eStudio();
});

test.describe("mobile drawer", () => {
  for (const [width, drawer] of [
    [699, true],
    [701, false],
  ] as const) {
    test(`at ${width}px the menu button is ${drawer ? "shown" : "hidden"} and the rail is ${drawer ? "a drawer" : "inline"}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await loginAsOwner(page, seed);
      await page.goto("/settings/profile");
      const menu = page.getByRole("button", { name: "Settings menu", exact: true });
      const rail = page.getByRole("navigation", { name: "Settings sections" });
      if (drawer) {
        await expect(menu).toBeVisible({ timeout: T });
        await expect(menu).toHaveAttribute("aria-expanded", "false");
        await expect(rail).toBeHidden();
      } else {
        await expect(menu).toBeHidden({ timeout: T });
        await expect(rail).toBeVisible();
      }
    });
  }

  test("390px: open, choose a destination (drawer closes), no horizontal overflow, escape closes", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsOwner(page, seed);
    await page.goto("/settings/profile");
    const menu = page.getByRole("button", { name: "Settings menu", exact: true });
    const rail = page.getByRole("navigation", { name: "Settings sections" });
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(rail).toBeVisible();
    await shot(page, "owner-mobile-drawer-open");

    await page.keyboard.press("Escape");
    await expect(rail, "Escape closes the drawer").toBeHidden();
    await menu.click();
    await go(page, "Calendar", "Display preferences");
    await expect(page).toHaveURL(/\/settings\/calendar/, { timeout: T });
    await expect(rail, "choosing a destination closes the drawer").toBeHidden();
    await expect(menu).toHaveAttribute("aria-expanded", "false");

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal page scroll at 390px").toBeLessThanOrEqual(0);
    await shot(page, "owner-mobile-calendar");
  });
});

test.describe("unsaved-changes guard", () => {
  test("leaving a dirty form asks first; Stay keeps the edits; Leave discards; no prompt after a save", async ({ page }) => {
    await loginAsOwner(page, seed);
    await page.goto("/settings/calendar");
    await expect(page.getByRole("heading", { name: "Display preferences" })).toBeVisible({ timeout: T });
    const toProfile = () => go(page, "Profile", "Personal details");
    const toCalendar = () => go(page, "Calendar", "Display preferences");

    // Clean form: navigation is immediate.
    await toProfile();
    await expect(page).toHaveURL(/\/settings\/profile/, { timeout: T });
    await toCalendar();
    await expect(page).toHaveURL(/\/settings\/calendar/, { timeout: T });

    // Dirty form: the app's own dialog, not window.confirm.
    const other = page.locator('button[aria-pressed="false"]', { hasText: /-hour/ });
    const otherLabel = (await other.innerText()).trim();
    await other.click();
    await toProfile();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Leave without saving?", { timeout: T });
    await shot(page, "owner-unsaved-guard");
    await dialog.getByRole("button", { name: "Stay" }).click();
    await expect(page).toHaveURL(/\/settings\/calendar/);
    await expect(page.getByRole("button", { name: otherLabel })).toHaveAttribute("aria-pressed", "true");

    await toProfile();
    await page.getByRole("alertdialog").getByRole("button", { name: "Leave" }).click();
    await expect(page).toHaveURL(/\/settings\/profile/, { timeout: T });

    // After a successful save there is nothing to lose.
    await toCalendar();
    await page.locator('button[aria-pressed="false"]', { hasText: /-hour/ }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: T });
    await toProfile();
    await expect(page).toHaveURL(/\/settings\/profile/, { timeout: T });
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("reloading a dirty form asks the browser to confirm (beforeunload)", async ({ page }) => {
    await loginAsOwner(page, seed);
    await page.goto("/settings/calendar");
    // Make the form dirty whatever is saved: choose the time format that is NOT pressed.
    await page.locator('button[aria-pressed="false"]', { hasText: /-hour/ }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    const blocked = await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(blocked, "a dirty form cancels beforeunload").toBe(true);
  });
});

test.describe("keyboard and focus", () => {
  test("the rail is reachable by Tab, the active link is marked, and focus is visible", async ({ page }) => {
    await loginAsOwner(page, seed);
    await page.goto("/settings/profile");
    const rail = page.getByRole("navigation", { name: "Settings sections" });
    const first = rail.locator("a, summary").first();
    await first.focus();
    await expect(first).toBeFocused();
    const outline = await first.evaluate((el) => {
      const s = getComputedStyle(el);
      return `${s.outlineStyle}|${s.outlineWidth}|${s.boxShadow}`;
    });
    expect(outline, "a focused rail entry shows a focus indicator").not.toMatch(/^none\|0px\|none$/);
    await page.keyboard.press("Tab");
    const moved = await page.evaluate(() => {
      const a = document.activeElement;
      return { inRail: !!a?.closest('nav[aria-label="Settings sections"]'), tag: a?.tagName };
    });
    expect(moved.inRail, "Tab moves to the next rail entry").toBe(true);
    // Current-page state for a plain entry is exposed as aria-current="page"...
    await page.goto("/settings/booking");
    await expect(rail.locator('a[aria-current="page"]')).toHaveCount(1, { timeout: T });
    await expect(rail.locator('a[aria-current="page"]')).toHaveText("Booking");
    // ...and for a grouped entry, as aria-current="location" on the chosen section link.
    await go(page, "Profile", "Personal details");
    await expect(rail.locator('a[aria-current="location"]')).toHaveText("Personal details", { timeout: T });
  });
});
