import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsOwner } from "./helpers/flows";
import { seedE2eStudio } from "./helpers/seed";

// HON-124 item 7, Record Keeping (app/(app)/records/page.tsx): the section menu, the stock-status tabs, the "Trace usage" button and the "Back to" link take the shared
// feedback. Each must show THREE distinct, measurable states (a mouse hovers, a finger only presses, a keyboard only focuses) and be tall enough to tap.
//   hover   : background (or, for a text link, colour / underline) differs from rest
//   pressed : (mouse button held) differs from BOTH rest and hover
//   focus   : reached by Tab, it draws a ring (box-shadow) that rest does not
// The section menu and the tabs are LINKS and "Trace usage" submits a search; every press is released off the control, so nothing is followed or submitted, and the
// page's address is read back unchanged at the end. A studio with no records is enough: every control walked here renders without data.
// The record rows (their disclosure summaries and "Trace usage" / "Open session" links) are NOT walked here; they need seeded logbook data.
// Each state is read after the 120-180ms transition has settled, or a half-finished hover would differ from the held press by itself.

const T = 20_000;
const SETTLE = 400;
const look = (l: Locator) =>
  l.evaluate((e) => {
    const c = getComputedStyle(e);
    return `${c.backgroundColor}|${c.color}|${c.textDecorationLine}`;
  });
const ring = (l: Locator) => l.evaluate((e) => getComputedStyle(e).boxShadow);

async function threeStates(page: Page, row: Locator, label: string) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(SETTLE);
  const rest = await look(row);
  await row.hover();
  await page.waitForTimeout(SETTLE);
  const hover = await look(row);
  expect(hover, `${label}: hover differs from rest`).not.toBe(rest);
  await page.mouse.down();
  await page.waitForTimeout(SETTLE);
  const pressed = await look(row);
  await page.mouse.move(1, 1); // release off the control: a press that ends elsewhere is not a click
  await page.mouse.up();
  expect(pressed, `${label}: pressed differs from rest`).not.toBe(rest);
  expect(pressed, `${label}: pressed differs from hover`).not.toBe(hover);
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

async function openSterile(page: Page): Promise<void> {
  const seed = await seedE2eStudio();
  await loginAsOwner(page, seed);
  await page.goto("/records?section=sterile");
  await expect(page.getByRole("heading", { name: "Record Keeping" })).toBeVisible({ timeout: T });
}

const sections = (page: Page) => page.getByRole("navigation", { name: "Record keeping sections" });
const tabs = (page: Page) => page.getByRole("navigation", { name: "Stock status" });
const traceButton = (page: Page) => page.getByRole("button", { name: "Trace usage" });

async function walk(page: Page) {
  await openSterile(page);
  const url = page.url();
  const walked: Array<[string, Locator]> = [
    ["Disinfectants (section menu, unselected)", sections(page).getByRole("link", { name: "Disinfectants" })],
    ["Discarded (stock tab, unselected)", tabs(page).getByRole("link", { name: "Discarded" })],
    ["Trace usage", traceButton(page)],
  ];
  for (const [label, el] of walked) {
    await el.scrollIntoViewIfNeeded();
    await threeStates(page, el, label);
    await focusRing(page, el, label);
  }
  // The chosen entries are marked (aria-current) and show a keyboard ring too.
  for (const [label, el] of [["Sterile Items (section menu, chosen)", sections(page).getByRole("link", { name: "Sterile Items" })], ["All (stock tab, chosen)", tabs(page).getByRole("link", { name: "All", exact: true })]] as Array<[string, Locator]>) {
    await expect(el, `${label} is marked current`).toHaveAttribute("aria-current", "page");
    await focusRing(page, el, label);
  }
  expect(page.url(), "no press followed a link or submitted the search").toBe(url);
  await page.goto("/records?section=sterile&view=add");
  const back = page.getByRole("link", { name: /Back to/ });
  await expect(back).toBeVisible({ timeout: T });
  const addUrl = page.url();
  await threeStates(page, back, "Back to the logbook");
  await focusRing(page, back, "Back to the logbook");
  expect(page.url(), "the back link was not followed").toBe(addUrl);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
}

test("desktop: the Record Keeping controls show hover, pressed and focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await walk(page);
});

test("390 px: the Record Keeping controls show hover, pressed and focus, and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await walk(page);
});

test.describe("on a touch device", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("the Record Keeping controls are at least 44px tall where the pointer is coarse", async ({ page }) => {
    await openSterile(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch emulation must be in effect").toBe(true);
    const tall = async (l: Locator, label: string) => {
      await l.scrollIntoViewIfNeeded();
      expect(await l.evaluate((e) => (e as HTMLElement).offsetHeight), `${label}: at least 44px`).toBeGreaterThanOrEqual(44);
    };
    await tall(sections(page).getByRole("link", { name: "Disinfectants" }), "Disinfectants (section menu)");
    await tall(tabs(page).getByRole("link", { name: "Discarded" }), "Discarded (stock tab)");
    await tall(traceButton(page), "Trace usage");
    await page.goto("/records?section=sterile&view=add");
    await tall(page.getByRole("link", { name: /Back to/ }), "Back to the logbook");
  });
});
