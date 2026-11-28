import { expect, test, type Locator, type Page } from "@playwright/test";
import { seedOperatorAuthUser } from "./helpers/seed";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// HON-124 item 7, the admin header: its six controls (Overview, New studio, Rollouts, Ops alerts, Exit to app and the Sign out button) take the shared
// navigation-row feedback on the dark bar. Each must show THREE distinct, measurable states (a mouse hovers, a finger only presses, a keyboard only focuses),
// be at least 44px tall, and at 390 px the row must wrap without a horizontal scroll.
//   hover   : background differs from rest
//   pressed : (mouse button held) background differs from BOTH rest and hover
//   focus   : reached by Tab, it draws a ring (box-shadow) that rest does not, and the ring's colour contrasts with the dark bar behind it (>= 3:1), so it is visible
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

/** The first OPAQUE colour in a CSS value: a computed box-shadow lists Tailwind's empty (transparent) layers first. */
const rgb = (s: string): [number, number, number] => {
  for (const m of s.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/g)) {
    if (m[4] === undefined || Number(m[4]) > 0) return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return [NaN, NaN, NaN];
};
const luminance = ([r, g, b]: [number, number, number]) => {
  const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** The colour the bar paints behind the row: the nearest ancestor with a non-transparent background. */
const barColour = (l: Locator) =>
  l.evaluate((e) => {
    for (let n = e.parentElement; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
    }
    return "rgb(255, 255, 255)";
  });

async function focusRing(page: Page, row: Locator, label: string) {
  await row.evaluate((e) => (e as HTMLElement).blur());
  const rest = await ring(row);
  await row.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab"); // arrive by keyboard, so :focus-visible applies
  await expect(row, `${label}: reached by keyboard`).toBeFocused();
  const drawn = await ring(row);
  expect(drawn, `${label}: keyboard focus draws a ring`).not.toBe(rest);
  const ringColour = rgb(drawn); // the ring layer of the box-shadow
  const bar = rgb(await barColour(row));
  expect(ringColour.every(Number.isFinite) && bar.every(Number.isFinite), `${label}: the ring and bar colours parse (${drawn})`).toBe(true);
  expect(ringColour, `${label}: the ring colour differs from the bar`).not.toEqual(bar);
  expect(contrast(ringColour, bar), `${label}: the ring contrasts with the bar (>= 3:1)`).toBeGreaterThanOrEqual(3);
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
