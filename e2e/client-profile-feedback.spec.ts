import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsOwner } from "./helpers/flows";
import { seedE2eClientWithPreviousAreas, seedE2eIntake, seedE2eStudio, sql } from "./helpers/seed";

// HON-124 item 7, the client profile (app/(app)/clients/[id]/page.tsx): its navigation links take the shared feedback. Each must show THREE distinct, measurable states
// (a mouse hovers, a finger only presses, a keyboard only focuses) and be tall enough to tap.
//   hover   : background (or, for a text link, colour / underline) differs from rest
//   pressed : (mouse button held) differs from BOTH rest and hover
//   focus   : reached by Tab, it draws a ring (box-shadow) that rest does not
// Reached states (one synthetic client, signed in as the owner): the Overview tab with a SUBMITTED intake and a charted past session (the "<- Clients" back link, the header
// "Edit", "+ Log session", "Add skin & hair analysis", the Client info "Edit", "View intake"), the Photos tab ("Open treatment photos") and the Sessions tab ("Open session").
// Not covered: "View statement" (the statements area is being changed elsewhere), the emergency-contact phone link (plain text), and the "View intake" links of the
// in-progress and reviewed intake states (the same class list as the submitted one).
// Every control here is a LINK: every press is released off the control, so nothing is followed; the page's address is read back unchanged, and the client, intake and
// session rows are read back whole (to_jsonb, every column and updated_at) and must be identical.
// Each state is read after the 120-180ms transition has settled, or a half-finished hover would differ from the held press by itself.

const T = 20_000;
const SETTLE = 400;
const look = (l: Locator) =>
  l.evaluate((e) => {
    const c = getComputedStyle(e);
    return `${c.backgroundColor}|${c.color}|${c.textDecorationLine}|${c.textDecorationThickness}`;
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

type Snapshot = { client: string[]; intake: string[]; sessions: string[] };
const snapshot = async (clientId: string): Promise<Snapshot> => {
  const rows = async (q: string) => (await sql<{ j: string }>(q, [clientId])).map((r) => r.j);
  return {
    client: await rows("select to_jsonb(t)::text as j from public.clients t where id = $1"),
    intake: await rows("select to_jsonb(t)::text as j from public.client_intake_forms t where client_id = $1 order by id"),
    sessions: await rows("select to_jsonb(t)::text as j from public.sessions t where client_id = $1 order by id"),
  };
};

async function setUp(page: Page): Promise<{ clientId: string; before: Snapshot }> {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClientWithPreviousAreas(seed);
  await seedE2eIntake(seed.studioId, clientId, "submitted");
  await loginAsOwner(page, seed);
  return { clientId, before: await snapshot(clientId) };
}

type Target = { path: (id: string) => string; ready: (page: Page) => Locator; links: (page: Page) => Array<[string, Locator]> };
const OVERVIEW: Target = {
  path: (id) => `/clients/${id}`,
  ready: (page) => page.getByRole("link", { name: "+ Log session" }),
  links: (page) => [
    ["← Clients", page.getByRole("link", { name: "← Clients" })],
    ["Edit (header)", page.getByRole("link", { name: "Edit", exact: true }).first()],
    ["+ Log session", page.getByRole("link", { name: "+ Log session" })],
    ["Add skin & hair analysis", page.getByRole("link", { name: "Add skin & hair analysis" })],
    ["Edit (Client info)", page.getByRole("link", { name: "Edit", exact: true }).nth(1)],
    ["View intake", page.getByRole("link", { name: "View intake" })],
  ],
};
const PHOTOS: Target = {
  path: (id) => `/clients/${id}?tab=photos`,
  ready: (page) => page.getByRole("link", { name: "Open treatment photos" }),
  links: (page) => [["Open treatment photos", page.getByRole("link", { name: "Open treatment photos" })]],
};
const SESSIONS: Target = {
  path: (id) => `/clients/${id}?tab=sessions`,
  ready: (page) => page.getByRole("link", { name: "Open session" }).first(),
  links: (page) => [["Open session", page.getByRole("link", { name: "Open session" }).first()]],
};

async function walk(page: Page) {
  const { clientId, before } = await setUp(page);
  for (const target of [OVERVIEW, PHOTOS, SESSIONS]) {
    await page.goto(target.path(clientId));
    await expect(target.ready(page)).toBeVisible({ timeout: T });
    const url = page.url();
    for (const [label, el] of target.links(page)) {
      await el.scrollIntoViewIfNeeded();
      await threeStates(page, el, label);
      await focusRing(page, el, label);
    }
    expect(page.url(), "no link was followed").toBe(url);
    expect(await snapshot(clientId), "the client, intake and session rows are identical, every column").toEqual(before);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
  }
}

test("desktop: the client profile's links show hover, pressed and focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await walk(page);
});

test("390 px: the client profile's links show hover, pressed and focus, and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await walk(page);
});

test.describe("on a touch device", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("the client profile's links are at least 44px tall where the pointer is coarse", async ({ page }) => {
    const { clientId, before } = await setUp(page);
    let checked = false;
    for (const target of [OVERVIEW, PHOTOS, SESSIONS]) {
      await page.goto(target.path(clientId));
      await expect(target.ready(page)).toBeVisible({ timeout: T });
      if (!checked) {
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch emulation must be in effect").toBe(true);
        checked = true;
      }
      for (const [label, el] of target.links(page)) {
        await el.scrollIntoViewIfNeeded();
        expect(await el.evaluate((e) => (e as HTMLElement).offsetHeight), `${label}: at least 44px`).toBeGreaterThanOrEqual(44);
      }
    }
    expect(await snapshot(clientId), "nothing was changed").toEqual(before);
  });
});
