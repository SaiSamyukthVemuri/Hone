import { test, expect, type Page } from "@playwright/test";
import { installWebkitLocalhostFix, isWebKit } from "./helpers/webkit-localhost";

// HON-124 item 13: a keyboard-operable "Back to top" on the long public pages. Public, static pages: no seed and no sign-in.
//   - it is not there at the top of the page, and it appears once the visitor has scrolled well down;
//   - with the keyboard alone: End scrolls to the bottom, Shift+Tab from there lands on it (it is the last control on the page), Enter returns to the top;
//   - FOCUS is restored: afterwards the focus is the top of the page (not lost on the removed button), so the next Tab reaches the skip link;
//   - reduced motion: the return to the top is immediate, with no smooth scroll.
// Phone width, touch, as the app's visitors use it.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const PAGES = ["/pricing", "/privacy", "/resources/electrolysis-treatment-record-checklist"];
const BUTTON = "[data-back-to-top]";

// WebKit only: strip the https upgrade the app sends for http://localhost (e2e/helpers/webkit-localhost.ts). A no-op in Chromium.
test.beforeEach(async ({ page }) => {
  if (isWebKit(page)) await installWebkitLocalhostFix(page.context());
});

const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

/** The End key scrolls with the browser's own animation; wait until the page has stopped moving before acting on its position. */
async function settled(page: Page) {
  await expect
    .poll(async () => {
      const a = await scrollY(page);
      await page.waitForTimeout(150);
      return a === (await scrollY(page));
    })
    .toBe(true);
}

for (const path of PAGES) {
  test(`${path}: back to top by keyboard alone, focus restored to the top`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator(BUTTON), "not shown at the top of the page").toHaveCount(0);

    await page.keyboard.press("End");
    await expect(page.locator(BUTTON), "shown once the page has been scrolled well down").toBeVisible();
    await settled(page);
    expect(await scrollY(page)).toBeGreaterThan(844 * 1.5);

    await page.keyboard.press("Shift+Tab");
    await expect(page.locator(BUTTON), "the keyboard reaches it").toBeFocused();
    const box = await page.locator(BUTTON).boundingBox();
    expect(box && box.height, "a touch-sized target").toBeGreaterThanOrEqual(44);

    await page.keyboard.press("Enter");
    await expect.poll(() => scrollY(page), { message: "back at the top", timeout: 10_000 }).toBe(0);
    await expect(page.locator(BUTTON), "gone again at the top").toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.id), "focus is at the top of the page, not lost on the removed button").toBe("mk-top");

    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" }), "the next Tab starts the page's own order again").toBeFocused();
  });
}

test("opening the phone menu hides it: it is neither visible nor clickable and focus stays in the dialog", async ({ page }) => {
  await page.goto("/pricing");
  await page.keyboard.press("End");
  await expect(page.locator(BUTTON)).toBeVisible();
  await settled(page);
  await page.getByRole("button", { name: "Menu" }).click();
  const dialog = page.getByRole("dialog", { name: "Site navigation" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(BUTTON), "gone while the menu is open").toHaveCount(0);
  // Nothing at the button's corner position can be the button, and focus is still inside the dialog.
  const hit = await page.evaluate(() => document.elementFromPoint(window.innerWidth - 40, window.innerHeight - 30)?.closest("[data-back-to-top]") !== null);
  expect(hit, "the button is not under that point").toBe(false);
  expect(await page.evaluate(() => !!document.activeElement?.closest("#site-navigation-dialog")), "focus is inside the dialog").toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator("#site-navigation-dialog"), "the menu is closed (inert while it fades out)").toHaveAttribute("inert", "");
  await expect(page.locator(BUTTON), "back once the menu is closed").toBeVisible();
});

test("reduced motion: the return to the top is immediate", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/pricing");
  await page.keyboard.press("End");
  await expect(page.locator(BUTTON)).toBeVisible();
  await settled(page);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  // One animation frame is enough for a jump; a smooth scroll over this distance would still be far from the top.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  expect(await scrollY(page), "no smooth scroll under reduced motion").toBeLessThan(50);
});

test("a tap on it works on touch as well", async ({ page }) => {
  await page.goto("/pricing");
  await page.keyboard.press("End");
  await settled(page);
  await page.locator(BUTTON).tap();
  await expect.poll(() => scrollY(page), { timeout: 10_000 }).toBe(0);
});
