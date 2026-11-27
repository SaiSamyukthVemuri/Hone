import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsOwner } from "./helpers/flows";
import { seedE2eStudio, type E2eSeed } from "./helpers/seed";

// Hover, pressed and keyboard-focus feedback on the shared navigation controls (HON-124 item 7): the primary nav, the Business menu and its rows, the phone
// menu's rows, and the footer links. Each control must show THREE distinct, measurable states, because a mouse hovers, a finger only presses (:hover never fires on
// touch) and a keyboard only focuses.
//   hover   : background (or, for a footer link, underline) differs from rest
//   pressed : (mouse button held) background differs from BOTH rest and hover
//   focus   : reached by Tab, it draws a ring (box-shadow) that rest does not
// The current page's row has no hover fill of its own, but it must still show the focus ring.

let seed: E2eSeed;
test.beforeAll(async () => {
  seed = await seedE2eStudio();
});

const bg = (l: Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
const ring = (l: Locator) => l.evaluate((e) => getComputedStyle(e).boxShadow);
const underline = (l: Locator) => l.evaluate((e) => getComputedStyle(e).textDecorationLine);

async function threeStates(page: Page, row: Locator, label: string) {
  await page.mouse.move(1, 1);
  const rest = await bg(row);
  await row.hover();
  const hover = await bg(row);
  expect(hover, `${label}: hover differs from rest`).not.toBe(rest);
  await page.mouse.down();
  const pressed = await bg(row);
  await page.mouse.up();
  expect(pressed, `${label}: pressed differs from hover`).not.toBe(hover);
  expect(pressed, `${label}: pressed differs from rest`).not.toBe(rest);
  await page.mouse.move(1, 1);
}

async function focusRing(page: Page, row: Locator, label: string) {
  await row.evaluate((e) => (e as HTMLElement).blur());
  const rest = await ring(row);
  await row.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab"); // arrive by keyboard, so :focus-visible applies
  await expect(row, `${label}: reached by keyboard`).toBeFocused();
  expect(await ring(row), `${label}: keyboard focus draws a ring`).not.toBe(rest);
}

test("desktop: the primary nav and the Business menu show hover, pressed and focus; the footer links show hover underline and focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginAsOwner(page, seed);
  await page.goto("/clients");

  const idle = page.getByTestId("nav-calendar");
  await threeStates(page, idle, "primary nav link");
  await focusRing(page, idle, "primary nav link");

  const current = page.getByTestId("nav-clients");
  await expect(current).toHaveAttribute("aria-current", "page");
  await focusRing(page, current, "the current page's nav link");

  const business = page.getByTestId("nav-business");
  await threeStates(page, business, "Business menu button");
  await focusRing(page, business, "Business menu button");
  await business.click();
  const row = page.locator("#business-menu-panel a").first();
  await threeStates(page, row, "Business menu row");
  await focusRing(page, row, "Business menu row");
  await page.keyboard.press("Escape");

  const footerLink = page.getByRole("contentinfo").getByRole("link", { name: "Privacy" });
  await footerLink.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  expect(await underline(footerLink), "footer link at rest").toBe("none");
  await footerLink.hover();
  expect(await underline(footerLink), "footer link hover underlines it").toContain("underline");
  await page.mouse.move(1, 1);
  await focusRing(page, footerLink, "footer link");
});

test("390 px: the phone menu's rows show hover, pressed and focus, and the current row still shows focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAsOwner(page, seed);
  await page.goto("/clients");
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  const menu = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(menu).toBeVisible();
  const other = menu.getByRole("link", { name: "Calendar", exact: true });
  await threeStates(page, other, "phone menu row");
  await focusRing(page, other, "phone menu row");
  const current = menu.locator('a[aria-current="page"]').first();
  await focusRing(page, current, "phone menu: the current page's row");
  expect((await current.boundingBox())?.height ?? 0, "a touch-sized row").toBeGreaterThanOrEqual(44);
});
