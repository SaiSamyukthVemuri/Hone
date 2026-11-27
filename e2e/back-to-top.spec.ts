import { test, expect, type Page } from "@playwright/test";

// HON-124 item 13: a keyboard-operable "Back to top" on the long public pages. Public, static pages: no seed and no sign-in.
//   - it is not there at the top of the page, and it appears once the visitor has scrolled well down;
//   - with the keyboard alone: End scrolls to the bottom, Shift+Tab from there lands on it (it is the last control on the page), Enter returns to the top;
//   - FOCUS is restored: afterwards the focus is the top of the page (not lost on the removed button), so the next Tab reaches the skip link;
//   - reduced motion: the return to the top is immediate, with no smooth scroll.
// Phone width, touch, as the app's visitors use it.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const PAGES = ["/pricing", "/privacy", "/resources/electrolysis-treatment-record-checklist"];
const BUTTON = "[data-back-to-top]";

const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

for (const path of PAGES) {
  test(`${path}: back to top by keyboard alone, focus restored to the top`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator(BUTTON), "not shown at the top of the page").toHaveCount(0);

    await page.keyboard.press("End");
    await expect(page.locator(BUTTON), "shown once the page has been scrolled well down").toBeVisible();
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

test("reduced motion: the return to the top is immediate", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/pricing");
  await page.keyboard.press("End");
  await expect(page.locator(BUTTON)).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  // One animation frame is enough for a jump; a smooth scroll over this distance would still be far from the top.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  expect(await scrollY(page), "no smooth scroll under reduced motion").toBeLessThan(50);
});

test("a tap on it works on touch as well", async ({ page }) => {
  await page.goto("/pricing");
  await page.keyboard.press("End");
  await page.locator(BUTTON).tap();
  await expect.poll(() => scrollY(page), { timeout: 10_000 }).toBe(0);
});
