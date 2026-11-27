import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsOwner } from "./helpers/flows";
import { getOwnerPractitionerId, getStudioTimezone, seedE2eClient, seedE2eStudio, seedFutureAppointmentAt, sql } from "./helpers/seed";

// HON-124 item 7, the appointment page (/calendar/[id]): its links take the shared feedback. Each must show THREE distinct, measurable states (a mouse hovers, a
// finger only presses, a keyboard only focuses) and be tall enough to tap.
//   hover   : background (buttons) or colour + underline (text links) differs from rest
//   pressed : (mouse button held) differs from BOTH rest and hover
//   focus   : reached by Tab, it draws a ring (box-shadow) that rest does not
// Covered on a confirmed visit: "← Calendar", the client's name link, View profile, Health & Forms, Create treatment plan and + Chart session. On the same visit
// completed: the next-step "Start session" link. The cancelled-visit follow-up summary and the intake-review links need other states and are not opened here.
// Each state is read after the 120-180ms transition has settled, or a half-finished hover would differ from the held press by itself.

const T = 20_000;
const SETTLE = 400;
const bg = (l: Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
const text = (l: Locator) => l.evaluate((e) => `${getComputedStyle(e).color}|${getComputedStyle(e).textDecorationLine}`);
const ring = (l: Locator) => l.evaluate((e) => getComputedStyle(e).boxShadow);

async function threeStates(page: Page, row: Locator, label: string, measure: (l: Locator) => Promise<string>) {
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

async function openVisit(page: Page): Promise<{ apptId: string; clientName: string }> {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const apptId = await seedFutureAppointmentAt(seed.studioId, ownerId, clientId, tz, "14:00");
  await loginAsOwner(page, seed);
  await page.goto(`/calendar/${apptId}`);
  await expect(page.getByRole("link", { name: "Create treatment plan" })).toBeVisible({ timeout: T });
  return { apptId, clientName: seed.clientName };
}

function controls(page: Page, clientName: string): Array<[string, Locator, (l: Locator) => Promise<string>]> {
  return [
    ["← Calendar", page.getByRole("link", { name: "← Calendar" }), text],
    ["client name link", page.getByRole("link", { name: clientName, exact: true }).first(), text],
    ["View profile", page.getByRole("link", { name: "View profile" }), bg],
    ["Health & Forms", page.getByRole("link", { name: "Health & Forms" }), bg],
    ["Create treatment plan", page.getByRole("link", { name: "Create treatment plan" }), bg],
    ["+ Chart session", page.getByRole("link", { name: "+ Chart session" }), bg],
  ];
}

async function check(page: Page) {
  const { apptId, clientName } = await openVisit(page);
  for (const [label, row, measure] of controls(page, clientName)) {
    await row.scrollIntoViewIfNeeded();
    expect(await row.count(), `${label} is present`).toBe(1);
    await threeStates(page, row, label, measure);
    await focusRing(page, row, label);
  }
  // The next-step card on a completed visit.
  await sql("update public.appointments set status = 'completed' where id = $1", [apptId]);
  await page.goto(`/calendar/${apptId}`);
  const start = page.getByRole("link", { name: "Start session" });
  await expect(start).toBeVisible({ timeout: T });
  await threeStates(page, start, "Start session", bg);
  await focusRing(page, start, "Start session");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
}

test("desktop: the appointment page's links show hover, pressed and focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await check(page);
});

test("390 px: the appointment page's links show hover, pressed and focus, and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await check(page);
});

test.describe("on a touch device", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("the appointment page's buttons and back link are at least 44px tall where the pointer is coarse", async ({ page }) => {
    const { clientName } = await openVisit(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch emulation must be in effect").toBe(true);
    for (const [label, row] of controls(page, clientName).filter(([l]) => l !== "client name link")) {
      await row.scrollIntoViewIfNeeded();
      expect(await row.evaluate((e) => (e as HTMLElement).offsetHeight), `${label}: at least 44px`).toBeGreaterThanOrEqual(44);
    }
  });
});
