import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// HON-124 item 11. The booking-link copy control on /settings/booking at an iPhone-sized viewport (390x844, touch, mobile).
//   * clipboard allowed: "Copied" appears only after the write, and the clipboard holds the link;
//   * clipboard write rejected, or no clipboard API at all: the person is told "Couldn't copy" in the live region, "Copied" never appears,
//     and the link text is selected so it can be copied by hand;
//   * keyboard only: Tab reaches the button, Enter copies.
// Synthetic fixture studio only.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const T = 20_000;
const COPY = (page: Page) => page.getByRole("button", { name: "Copy booking link" });
const FIELD = (page: Page) => page.getByLabel("Booking link", { exact: true });

async function openBooking(page: Page) {
  await page.goto("/settings/booking");
  await expect(page.getByRole("heading", { name: "Booking link", exact: true })).toBeVisible({ timeout: T });
  await expect(COPY(page)).toBeVisible({ timeout: T });
}

async function expectNoHorizontalScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over).toBeLessThanOrEqual(1);
}

test.describe("booking link copy control, iPhone viewport", () => {
  test.beforeEach(async ({ page }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
  });

  test("clipboard allowed: Copied appears after the write and the clipboard holds the link", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openBooking(page);
    const link = await FIELD(page).inputValue();
    await COPY(page).click();
    await expect(COPY(page)).toHaveText("Copied");
    await expect(page.getByRole("status").filter({ hasText: "Copied" })).toHaveCount(1);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(link.replace(/^https?:\/\//, ""));
    await expectNoHorizontalScroll(page);
  });

  test("write rejected: says Couldn't copy, never Copied, and selects the link text", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) }, configurable: true });
    });
    await openBooking(page);
    await COPY(page).click();
    await expect(page.getByRole("status").filter({ hasText: "Couldn’t copy" })).toBeVisible({ timeout: T });
    await expect(COPY(page)).not.toHaveText("Copied");
    const sel = await FIELD(page).evaluate((el: HTMLInputElement) => ({ s: el.selectionStart, e: el.selectionEnd, n: el.value.length, active: document.activeElement === el }));
    expect(sel).toEqual({ s: 0, e: sel.n, n: sel.n, active: true });
    expect(sel.n).toBeGreaterThan(0);
    await expectNoHorizontalScroll(page);
  });

  test("no clipboard API at all: the same calm message and selection, and no thrown error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    });
    await openBooking(page);
    await COPY(page).click();
    await expect(page.getByRole("status").filter({ hasText: "Couldn’t copy" })).toBeVisible({ timeout: T });
    await expect(COPY(page)).not.toHaveText("Copied");
    expect(await FIELD(page).evaluate((el: HTMLInputElement) => el.selectionEnd! - el.selectionStart!)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test("keyboard only: Tab reaches the button and Enter copies", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openBooking(page);
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Copy booking link");
    }
    expect(reached, "Tab reaches the copy button").toBe(true);
    await page.keyboard.press("Enter");
    await expect(COPY(page)).toHaveText("Copied");
  });
});
