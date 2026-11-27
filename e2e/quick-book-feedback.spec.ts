import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsOwner } from "./helpers/flows";
import { getE2eServiceId, getStudioTimezone, seedE2eClient, seedE2eStudio, sql } from "./helpers/seed";

// HON-124 item 7, the calendar's Quick Book drawer (QuickBookDrawer.tsx): its buttons take the shared feedback. Each must show THREE distinct, measurable states
// (a mouse hovers, a finger only presses, a keyboard only focuses) and be tall enough to tap.
//   hover   : background (or, for the text button, colour + underline) differs from rest
//   pressed : (mouse button held) differs from BOTH rest and hover
//   focus   : reached by Tab, it draws a ring (box-shadow) that rest does not
// Walked in order on one drawer: Esc, the two client-source tabs, a client result row, Change, a time slot, Cancel and Book appointment. The picked slot is also
// marked aria-pressed (not colour alone). "Add client" and "Use this service" need a new-client write / a visit history and are not opened here; they share buttonClasses.
// Nothing is booked: every press is released off the control.
// Each state is read after the 120-180ms transition has settled, or a half-finished hover would differ from the held press by itself.

const T = 20_000;
const SETTLE = 400;
const SLOT = /^\d{1,2}:\d{2}\s?(AM|PM)$/i;
const bg = (l: Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
const text = (l: Locator) => l.evaluate((e) => `${getComputedStyle(e).color}|${getComputedStyle(e).textDecorationLine}`);
const ring = (l: Locator) => l.evaluate((e) => getComputedStyle(e).boxShadow);

async function threeStates(page: Page, row: Locator, label: string, measure: (l: Locator) => Promise<string> = bg) {
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

async function openDrawer(page: Page): Promise<{ drawer: Locator; clientName: string; serviceId: string }> {
  const seed = await seedE2eStudio();
  const serviceId = await getE2eServiceId(seed.studioId);
  const { clientId } = await seedE2eClient(seed);
  const [{ name }] = await sql<{ name: string }>("select name from public.clients where id = $1", [clientId]); // seedE2eClient names its own client
  const tz = await getStudioTimezone(seed.studioId);
  // A day a week ahead: the seeded studio is open 06:00-22:00 every day, so every slot of it is in the future whatever time the run starts.
  const [{ day }] = await sql<{ day: string }>("select to_char((now() at time zone $1)::date + 7, 'YYYY-MM-DD') as day", [tz]);
  await loginAsOwner(page, seed);
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    // A phone has no day column to press: the "+" opens a chooser, and the day shown is the selected day.
    await page.goto(`/calendar?view=week&layout=grid&day=${day}`);
    await page.getByRole("button", { name: "Add appointment or block time" }).click();
    await page.getByRole("dialog", { name: "Choose action for selected time" }).getByRole("button", { name: "Book appointment" }).click();
  } else {
    await page.goto(`/calendar?view=week&layout=grid&week=${day}`);
    await page.getByRole("button", { name: `Open quick-book draft for ${day}` }).click();
  }
  const drawer = page.getByRole("dialog", { name: "New appointment" });
  await expect(drawer).toBeVisible({ timeout: T });
  return { drawer, clientName: name, serviceId };
}

async function walk(page: Page) {
  const { drawer, clientName, serviceId } = await openDrawer(page);

  const close = drawer.getByRole("button", { name: "Close", exact: true });
  await threeStates(page, close, "Esc (Close)");
  await focusRing(page, close, "Esc (Close)");

  // The client-source tabs: the unselected one shows the three states, the selected one keeps its fill and still shows the ring; aria-selected says which.
  const search = drawer.getByRole("tab", { name: "Search existing" });
  const add = drawer.getByRole("tab", { name: "Add a new client" });
  await expect(search).toHaveAttribute("aria-selected", "true");
  await threeStates(page, add, "unselected client-source tab");
  await focusRing(page, add, "unselected client-source tab");
  await focusRing(page, search, "selected client-source tab");

  await drawer.getByPlaceholder("Find existing client").fill(clientName);
  const row = drawer.getByRole("button", { name: new RegExp(clientName) }).first();
  await expect(row).toBeVisible({ timeout: T });
  await threeStates(page, row, "client result row");
  await focusRing(page, row, "client result row");
  await row.click();

  const change = drawer.getByRole("button", { name: "Change", exact: true });
  await expect(change).toBeVisible({ timeout: T });
  await threeStates(page, change, "Change", text);
  await focusRing(page, change, "Change");

  await drawer.getByRole("combobox").first().selectOption(serviceId);
  const slots = drawer.getByRole("button", { name: SLOT });
  await expect(slots.first()).toBeVisible({ timeout: T });
  const other = slots.nth(1);
  await threeStates(page, other, "time slot");
  await focusRing(page, other, "time slot");
  await slots.first().click();
  await expect(slots.first(), "the picked slot is marked, not only coloured").toHaveAttribute("aria-pressed", "true");
  await expect(other, "an unpicked slot is not").toHaveAttribute("aria-pressed", "false");

  const cancel = drawer.getByRole("button", { name: "Cancel", exact: true });
  await threeStates(page, cancel, "Cancel");
  await focusRing(page, cancel, "Cancel");
  const book = drawer.getByRole("button", { name: /^Book appointment$/ });
  await expect(book).toBeEnabled({ timeout: T });
  await threeStates(page, book, "Book appointment");
  await focusRing(page, book, "Book appointment");
  await expect(drawer, "nothing was booked or closed by the presses").toBeVisible();
}

test("desktop: the Quick Book drawer's buttons show hover, pressed and focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await walk(page);
});

test("390 px: the Quick Book drawer's buttons show hover, pressed and focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await walk(page);
});

test.describe("on a touch device", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("the drawer's buttons are at least 44px tall where the pointer is coarse", async ({ page }) => {
    const { drawer, clientName, serviceId } = await openDrawer(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch emulation must be in effect").toBe(true);
    const tall = async (l: Locator, label: string) =>
      expect(await l.evaluate((e) => (e as HTMLElement).offsetHeight), `${label}: at least 44px`).toBeGreaterThanOrEqual(44);
    await tall(drawer.getByRole("button", { name: "Close", exact: true }), "Esc (Close)");
    await tall(drawer.getByRole("tab", { name: "Search existing" }), "client-source tab");
    await drawer.getByPlaceholder("Find existing client").fill(clientName);
    await drawer.getByRole("button", { name: new RegExp(clientName) }).first().click();
    await tall(drawer.getByRole("button", { name: "Change", exact: true }), "Change");
    await drawer.getByRole("combobox").first().selectOption(serviceId);
    const slots = drawer.getByRole("button", { name: SLOT });
    await expect(slots.first()).toBeVisible({ timeout: T });
    await tall(slots.first(), "time slot");
    await tall(drawer.getByRole("button", { name: "Cancel", exact: true }), "Cancel");
    await tall(drawer.getByRole("button", { name: /^Book appointment$/ }), "Book appointment");
  });
});
