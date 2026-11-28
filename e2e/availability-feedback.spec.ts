import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsOwner } from "./helpers/flows";
import { seedE2eStudio } from "./helpers/seed";

// HON-124 item 7, Settings > Availability (AvailabilityClient.tsx): its buttons take the shared feedback. Each must show THREE distinct, measurable states
// (a mouse hovers, a finger only presses, a keyboard only focuses) and be tall enough to tap.
//   hover   : background (or, for the text button, colour) differs from rest
//   pressed : (mouse button held) differs from BOTH rest and hover
//   focus   : reached by Tab, it draws a ring (box-shadow) that rest does not
// Covered: a Quick set preset, a weekday column of the week grid (and the one being edited), Save, Cancel and "Close this day" in the day editor, and the two
// "+ Add ..." buttons. The special-hours and blocked-time Save/Cancel pairs share the same buttonClasses and are not opened here.
// Each state is read after the 120-180ms transition has settled, or a half-finished hover would differ from the held press by itself.

const T = 20_000;
const SETTLE = 400;
const bg = (l: Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
const color = (l: Locator) => l.evaluate((e) => getComputedStyle(e).color);
const ring = (l: Locator) => l.evaluate((e) => getComputedStyle(e).boxShadow);

async function threeStates(page: Page, row: Locator, label: string, measure: (l: Locator) => Promise<string>, distinctPressed: boolean) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(SETTLE);
  const rest = await measure(row);
  await row.hover();
  await page.waitForTimeout(SETTLE);
  const hover = await measure(row);
  expect(hover, `${label}: hover differs from rest`).not.toBe(rest);
  await page.mouse.down();
  await page.waitForTimeout(SETTLE);
  const pressed = await measure(row);
  await page.mouse.move(1, 1); // release off the control: a press that ends elsewhere is not a click
  await page.mouse.up();
  expect(pressed, `${label}: pressed differs from rest`).not.toBe(rest);
  if (distinctPressed) expect(pressed, `${label}: pressed differs from hover`).not.toBe(hover);
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

async function open(page: Page) {
  const seed = await seedE2eStudio();
  await loginAsOwner(page, seed);
  await page.goto("/settings/availability");
  await expect(page.getByRole("button", { name: "Edit Monday" })).toBeVisible({ timeout: T });
}

async function check(page: Page, floor: number) {
  await open(page);
  const preset = page.getByRole("button", { name: "Weekdays 9–5" });
  const column = page.getByRole("button", { name: "Edit Tuesday" });
  const addSpecial = page.getByRole("button", { name: "+ Add special hours" });
  const addBlocked = page.getByRole("button", { name: "+ Add blocked time" });
  const plain: Array<[string, Locator, (l: Locator) => Promise<string>, boolean]> = [
    ["Quick set preset", preset, bg, true],
    ["week-grid day column", column, bg, true],
    ["+ Add special hours", addSpecial, bg, true],
    ["+ Add blocked time", addBlocked, bg, true],
  ];
  for (const [label, row, measure, distinct] of plain) {
    await row.scrollIntoViewIfNeeded();
    if (label !== "week-grid day column") expect((await row.boundingBox())?.height ?? 0, `${label}: at least ${floor}px tall`).toBeGreaterThanOrEqual(floor);
    await threeStates(page, row, label, measure, distinct);
    await focusRing(page, row, label);
  }

  // The day being edited keeps its own fill, but must still show the keyboard ring.
  await page.getByRole("button", { name: "Edit Monday" }).click();
  await expect(page.getByLabel("Monday opens")).toBeVisible({ timeout: T });
  const monday = page.getByRole("button", { name: "Edit Monday" });
  const tuesday = page.getByRole("button", { name: "Edit Tuesday" });
  await focusRing(page, monday, "the day being edited");
  // The day being edited is told apart by more than colour (aria-current), and its fill differs from both a resting and a hovered column.
  await expect(monday, "the edited day is marked aria-current").toHaveAttribute("aria-current", "true");
  await expect(tuesday, "another day is not").not.toHaveAttribute("aria-current", /.*/);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(SETTLE);
  const editedFill = await bg(monday);
  const restFill = await bg(tuesday);
  await tuesday.hover();
  await page.waitForTimeout(SETTLE);
  const hoverFill = await bg(tuesday);
  await page.mouse.move(1, 1);
  expect(editedFill, "the edited day's fill differs from a resting day").not.toBe(restFill);
  expect(editedFill, "the edited day's fill differs from a hovered day").not.toBe(hoverFill);

  const editor: Array<[string, Locator, (l: Locator) => Promise<string>, boolean]> = [
    ["Save", page.getByRole("button", { name: /^Save$/ }), bg, true],
    ["Cancel", page.getByRole("button", { name: /^Cancel$/ }).first(), bg, true],
    ["Close this day", page.getByRole("button", { name: "Close this day" }), color, false],
  ];
  for (const [label, row, measure, distinct] of editor) {
    await row.scrollIntoViewIfNeeded();
    expect((await row.boundingBox())?.height ?? 0, `${label}: at least ${floor}px tall`).toBeGreaterThanOrEqual(floor);
    await threeStates(page, row, label, measure, distinct);
    await focusRing(page, row, label);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
}

// A Playwright Chromium has a precise pointer at every width, so the compact 32px floor of the small buttons is what is asserted here; the touch test below holds the 44px.
test("desktop: the availability buttons show hover, pressed and focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await check(page, 32);
});

test("390 px: the availability buttons show hover, pressed and focus, and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await check(page, 32);
});

test.describe("on a touch device", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("the availability buttons are at least 44px tall where the pointer is coarse", async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch emulation must be in effect").toBe(true);
    for (const el of [
      page.getByRole("button", { name: "Weekdays 9–5" }),
      page.getByRole("button", { name: "+ Add special hours" }),
      page.getByRole("button", { name: "+ Add blocked time" }),
    ]) {
      await el.scrollIntoViewIfNeeded();
      expect(await el.evaluate((e) => (e as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: "Edit Monday" }).click();
    await expect(page.getByLabel("Monday opens")).toBeVisible({ timeout: T });
    for (const el of [page.getByRole("button", { name: /^Save$/ }), page.getByRole("button", { name: "Close this day" })]) {
      await el.scrollIntoViewIfNeeded();
      expect(await el.evaluate((e) => (e as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
    }
  });
});
