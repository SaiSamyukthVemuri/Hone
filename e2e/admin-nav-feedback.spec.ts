import { expect, test, type Locator, type Page } from "@playwright/test";
import { seedOperatorAuthUser } from "./helpers/seed";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// HON-124 item 7, the admin header: its six controls (Overview, New studio, Rollouts, Ops alerts, Exit to app and the Sign out button) take the shared
// navigation-row feedback on the dark bar. Each must show THREE distinct, measurable states (a mouse hovers, a finger only presses, a keyboard only focuses),
// be at least 44px tall, and at 390 px the row must wrap without a horizontal scroll.
//   hover   : background differs from rest
//   pressed : (mouse button held) background differs from BOTH rest and hover
//   focus   : reached by Tab, it draws a ring (box-shadow) that rest does not
// Sign out is only pressed, never released on the control, so the session stays.

const NAMES = ["Overview", "New studio", "Rollouts", "Ops alerts", "Exit to app", "Sign out"] as const;

const bg = (l: Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
const ring = (l: Locator) => l.evaluate((e) => getComputedStyle(e).boxShadow);

async function loginOperator(page: Page): Promise<void> {
  const { email } = await seedOperatorAuthUser();
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  await page.goto(await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen }));
}

function control(page: Page, name: (typeof NAMES)[number]): Locator {
  const nav = page.getByTestId("admin-nav");
  return name === "Sign out" ? nav.getByRole("button", { name }) : nav.getByRole("link", { name, exact: true });
}

async function threeStates(page: Page, row: Locator, label: string) {
  await page.mouse.move(1, 1);
  const rest = await bg(row);
  await row.hover();
  const hover = await bg(row);
  expect(hover, `${label}: hover differs from rest`).not.toBe(rest);
  await page.mouse.down();
  const pressed = await bg(row);
  await page.mouse.move(1, 1); // release off the control: a press that ends elsewhere is not a click
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

async function checkAll(page: Page) {
  await loginOperator(page);
  await page.goto("/admin");
  await expect(page.getByTestId("admin-nav")).toBeVisible();
  for (const name of NAMES) {
    const row = control(page, name);
    await expect(row, `${name} is present`).toBeVisible();
    const box = await row.boundingBox();
    expect(box?.height ?? 0, `${name}: at least 44px tall`).toBeGreaterThanOrEqual(44);
    await threeStates(page, row, name);
    await focusRing(page, row, name);
  }
}

test("desktop: the six admin header controls show hover, pressed and focus and are 44px tall", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await checkAll(page);
});

test("390 px: the six admin header controls show hover, pressed and focus, and the header does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await checkAll(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll at 390 px").toBeLessThanOrEqual(0);
});
