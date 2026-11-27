import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsOwner } from "./helpers/flows";
import { getOwnerPractitionerId, seedE2eStudio, sql } from "./helpers/seed";

// HON-124 item 7, Settings > Profile > Calendar feed (CalendarFeedCard.tsx): its buttons take the shared feedback. Each must show THREE distinct, measurable states
// (a mouse hovers, a finger only presses, a keyboard only focuses) and be tall enough to tap.
//   hover   : background differs from rest
//   pressed : (mouse button held) differs from BOTH rest and hover
//   focus   : reached by Tab, it draws a ring (box-shadow) that rest does not
// The feed URL is a SECRET LINK, so this spec is built never to make or show one:
//   * a studio WITH a feed has a seeded placeholder hash (the card then offers Regenerate and Disable, and never shows a link); a studio WITHOUT one offers Generate;
//   * Generate, Regenerate's confirm and Disable are only hovered, pressed and focused. Every press is released off the control, so none is clicked. The one real click
//     is the first "Regenerate feed URL", which only opens the confirm step (no write); "Cancel" then closes it;
//   * afterwards the seeded hash is read back and must be byte-identical (and a studio with no feed must still have none);
//   * the page never shows a feed link (its shape is asserted absent), and nothing here screenshots or prints one.
// "Copy feed URL" only exists beside a freshly generated link, so it is not exercised here; it shares the secondary button style with the three below.
// Each state is read after the 120-180ms transition has settled, or a half-finished hover would differ from the held press by itself.

const T = 20_000;
const SETTLE = 400;
const bg = (l: Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
const ring = (l: Locator) => l.evaluate((e) => getComputedStyle(e).boxShadow);
const hashOf = async (practitionerId: string) =>
  (await sql<{ h: string | null }>("select calendar_feed_token_hash as h from public.practitioners where id = $1", [practitionerId]))[0]?.h ?? null;

async function threeStates(page: Page, row: Locator, label: string) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(SETTLE);
  const rest = await bg(row);
  const restText = await row.evaluate((e) => getComputedStyle(e).textDecorationLine + getComputedStyle(e).color);
  await row.hover();
  await page.waitForTimeout(SETTLE);
  const hover = await bg(row);
  const hoverText = await row.evaluate((e) => getComputedStyle(e).textDecorationLine + getComputedStyle(e).color);
  expect(hover !== rest || hoverText !== restText, `${label}: hover differs from rest`).toBe(true);
  await page.mouse.down();
  await page.waitForTimeout(SETTLE);
  const pressed = await bg(row);
  const pressedText = await row.evaluate((e) => getComputedStyle(e).textDecorationLine + getComputedStyle(e).color);
  await page.mouse.move(1, 1); // release off the control: a press that ends elsewhere is not a click
  await page.mouse.up();
  expect(pressed !== rest || pressedText !== restText, `${label}: pressed differs from rest`).toBe(true);
  expect(pressed !== hover || pressedText !== hoverText, `${label}: pressed differs from hover`).toBe(true);
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

async function expectNoFeedLink(page: Page) {
  expect(await page.locator("main").innerText(), "no feed link is ever shown").not.toMatch(/calendar-feed\/[^\s]+\.ics/);
}

/** A studio's owner, signed in on Settings > Profile. `withFeed` seeds a placeholder hash, so the card is in its "active, link not shown" state. */
async function openProfile(page: Page, withFeed: boolean): Promise<{ practitionerId: string; seededHash: string | null }> {
  const seed = await seedE2eStudio();
  const practitionerId = await getOwnerPractitionerId(seed.studioId);
  const seededHash = withFeed ? `e2e-seeded-feed-hash-${seed.runId}` : null;
  if (seededHash) await sql("update public.practitioners set calendar_feed_token_hash = $2 where id = $1", [practitionerId, seededHash]);
  await loginAsOwner(page, seed);
  await page.goto("/settings/profile");
  await expect(page.getByRole("heading", { name: "Calendar feed" })).toBeVisible({ timeout: T });
  return { practitionerId, seededHash };
}

const regenerate = (page: Page) => page.getByRole("button", { name: "Regenerate feed URL" });
const disable = (page: Page) => page.getByRole("button", { name: "Disable feed" });
const confirmBtn = (page: Page) => page.getByRole("button", { name: "This will break the old subscribed URL" });
const cancel = (page: Page) => page.getByRole("button", { name: "Cancel", exact: true });

async function walkActive(page: Page) {
  const { practitionerId, seededHash } = await openProfile(page, true);
  await expect(page.getByRole("button", { name: "Generate calendar feed URL" })).toHaveCount(0);
  for (const [label, el] of [["Regenerate feed URL", regenerate(page)], ["Disable feed", disable(page)]] as Array<[string, Locator]>) {
    await el.scrollIntoViewIfNeeded();
    await threeStates(page, el, label);
    await focusRing(page, el, label);
  }
  await regenerate(page).click(); // only opens the confirm step: nothing is written until the confirm is pressed
  await expect(confirmBtn(page)).toBeVisible({ timeout: T });
  for (const [label, el] of [["This will break the old subscribed URL", confirmBtn(page)], ["Cancel", cancel(page)]] as Array<[string, Locator]>) {
    await el.scrollIntoViewIfNeeded();
    await threeStates(page, el, label);
    await focusRing(page, el, label);
  }
  await expect(confirmBtn(page), "nothing was rotated by the presses").toBeVisible();
  await cancel(page).click();
  await expect(confirmBtn(page)).toHaveCount(0);
  await expectNoFeedLink(page);
  expect(await hashOf(practitionerId), "the seeded feed hash is byte-identical: nothing rotated, disabled or generated").toBe(seededHash);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
}

async function walkNeverCreated(page: Page) {
  const { practitionerId } = await openProfile(page, false);
  const generate = page.getByRole("button", { name: "Generate calendar feed URL" });
  await generate.scrollIntoViewIfNeeded();
  await threeStates(page, generate, "Generate calendar feed URL");
  await focusRing(page, generate, "Generate calendar feed URL");
  await expectNoFeedLink(page);
  expect(await hashOf(practitionerId), "no feed was generated").toBeNull();
}

test("desktop: the calendar feed's buttons show hover, pressed and focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await walkActive(page);
});

test("390 px: the calendar feed's buttons show hover, pressed and focus, and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await walkActive(page);
});

test("a studio with no feed: Generate shows hover, pressed and focus and nothing is generated", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await walkNeverCreated(page);
});

test.describe("on a touch device", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("the calendar feed's buttons are at least 44px tall where the pointer is coarse", async ({ page }) => {
    const { practitionerId, seededHash } = await openProfile(page, true);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch emulation must be in effect").toBe(true);
    const tall = async (l: Locator, label: string) => {
      await l.scrollIntoViewIfNeeded();
      expect(await l.evaluate((e) => (e as HTMLElement).offsetHeight), `${label}: at least 44px`).toBeGreaterThanOrEqual(44);
    };
    await tall(regenerate(page), "Regenerate feed URL");
    await tall(disable(page), "Disable feed");
    await regenerate(page).click();
    await tall(confirmBtn(page), "This will break the old subscribed URL");
    await tall(cancel(page), "Cancel");
    expect(await hashOf(practitionerId), "the seeded feed hash is byte-identical").toBe(seededHash);
  });

  test("Generate is at least 44px tall where the pointer is coarse", async ({ page }) => {
    const { practitionerId } = await openProfile(page, false);
    const generate = page.getByRole("button", { name: "Generate calendar feed URL" });
    await generate.scrollIntoViewIfNeeded();
    expect(await generate.evaluate((e) => (e as HTMLElement).offsetHeight), "Generate: at least 44px").toBeGreaterThanOrEqual(44);
    expect(await hashOf(practitionerId), "no feed was generated").toBeNull();
  });
});
