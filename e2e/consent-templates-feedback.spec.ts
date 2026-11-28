import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsOwner } from "./helpers/flows";
import { seedE2eStudio, sql } from "./helpers/seed";

// HON-124 item 7, Settings > Consent forms (ConsentTemplatesEditor.tsx): its buttons take the shared feedback. Each must show THREE distinct, measurable states
// (a mouse hovers, a finger only presses, a keyboard only focuses) and be tall enough to tap.
//   hover   : background differs from rest
//   pressed : (mouse button held) differs from BOTH rest and hover
//   focus   : reached by Tab, it draws a ring (box-shadow) that rest does not
// Three synthetic forms give every row button: an active one not yet live (Edit, Make live in client portal, Archive), a live one (Hide from client portal) and an
// archived one (Make active). Then + New consent form and the form's Create form / Cancel are walked. Every press is released off the control, so nothing is
// changed, published or saved.
// Each state is read after the 120-180ms transition has settled, or a half-finished hover would differ from the held press by itself.

const T = 20_000;
const SETTLE = 400;
const bg = (l: Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
const ring = (l: Locator) => l.evaluate((e) => getComputedStyle(e).boxShadow);

async function threeStates(page: Page, row: Locator, label: string) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(SETTLE);
  const rest = await bg(row);
  await row.hover();
  await page.waitForTimeout(SETTLE);
  const hover = await bg(row);
  expect(hover, `${label}: hover differs from rest`).not.toBe(rest);
  await page.mouse.down();
  await page.waitForTimeout(SETTLE);
  const pressed = await bg(row);
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

type Snapshot = Array<{ title: string; status: string; is_live: boolean; version: number; updated_at: string }>;
const EXPECTED = [
  { title: "E2E active form", status: "active", is_live: false, version: 1 },
  { title: "E2E archived form", status: "archived", is_live: false, version: 1 },
  { title: "E2E live form", status: "active", is_live: true, version: 1 },
];
const snapshot = (studioId: string) =>
  sql<Snapshot[number]>(
    "select title, status, is_live, version, updated_at::text as updated_at from public.consent_form_templates where studio_id = $1 order by title",
    [studioId],
  );
/** Consent forms are legally sensitive: after the walk the three seeded forms must still be exactly what was seeded (status, live flag, version, and not even re-saved), and no form was added. */
async function expectUntouched(studioId: string, before: Snapshot) {
  const after = await snapshot(studioId);
  expect(after.map(({ title, status, is_live, version }) => ({ title, status, is_live, version })), "the three forms keep their exact status, live flag and version").toEqual(EXPECTED);
  expect(after.map((r) => r.updated_at), "no form was saved (updated_at unchanged)").toEqual(before.map((r) => r.updated_at));
}

async function openPage(page: Page): Promise<{ studioId: string; before: Snapshot }> {
  const seed = await seedE2eStudio();
  const row = (title: string, type: string, status: string, live: boolean) =>
    sql(
      `insert into public.consent_form_templates (studio_id, title, description, body, form_type, version, status, is_live)
       values ($1, $2, 'E2E consent form', 'E2E consent body', $3, 1, $4, $5)`,
      [seed.studioId, title, type, status, live],
    );
  await row("E2E active form", "general", "active", false);
  await row("E2E live form", "photo_consent", "active", true);
  await row("E2E archived form", "treatment_consent", "archived", false);
  await loginAsOwner(page, seed);
  await page.goto("/settings/consent");
  await expect(page.getByRole("button", { name: "+ New consent form" })).toBeVisible({ timeout: T });
  return { studioId: seed.studioId, before: await snapshot(seed.studioId) };
}

async function walk(page: Page) {
  const { studioId, before } = await openPage(page);
  const rowButtons: Array<[string, Locator]> = [
    ["Edit", page.getByRole("button", { name: "Edit", exact: true }).first()],
    ["Make live in client portal", page.getByRole("button", { name: "Make live in client portal" })],
    ["Hide from client portal", page.getByRole("button", { name: "Hide from client portal" })],
    ["Make active", page.getByRole("button", { name: "Make active" })],
    ["Archive", page.getByRole("button", { name: "Archive", exact: true }).first()],
  ];
  for (const [label, el] of rowButtons) {
    await el.scrollIntoViewIfNeeded();
    expect(await el.count(), `${label} is present`).toBe(1);
    await threeStates(page, el, label);
    await focusRing(page, el, label);
  }
  const add = page.getByRole("button", { name: "+ New consent form" });
  await threeStates(page, add, "+ New consent form");
  await focusRing(page, add, "+ New consent form");
  await add.click();
  const create = page.getByRole("button", { name: "Create form", exact: true });
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await expect(create).toBeVisible({ timeout: T });
  for (const [label, el] of [["Create form", create], ["Cancel", cancel]] as Array<[string, Locator]>) {
    await el.scrollIntoViewIfNeeded();
    await threeStates(page, el, label);
    await focusRing(page, el, label);
  }
  await expect(create, "nothing was created or closed by the presses").toBeVisible();
  await expectUntouched(studioId, before);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
}

test("desktop: the consent forms' buttons show hover, pressed and focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await walk(page);
});

test("390 px: the consent forms' buttons show hover, pressed and focus, and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await walk(page);
});

test.describe("on a touch device", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("the consent forms' buttons are at least 44px tall where the pointer is coarse", async ({ page }) => {
    const { studioId, before } = await openPage(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch emulation must be in effect").toBe(true);
    const tall = async (l: Locator, label: string) => {
      await l.scrollIntoViewIfNeeded();
      expect(await l.evaluate((e) => (e as HTMLElement).offsetHeight), `${label}: at least 44px`).toBeGreaterThanOrEqual(44);
    };
    await tall(page.getByRole("button", { name: "Edit", exact: true }).first(), "Edit");
    await tall(page.getByRole("button", { name: "Make live in client portal" }), "Make live in client portal");
    await tall(page.getByRole("button", { name: "Archive", exact: true }).first(), "Archive");
    await tall(page.getByRole("button", { name: "+ New consent form" }), "+ New consent form");
    await page.getByRole("button", { name: "+ New consent form" }).click();
    await tall(page.getByRole("button", { name: "Create form", exact: true }), "Create form");
    await tall(page.getByRole("button", { name: "Cancel", exact: true }), "Cancel");
    await expectUntouched(studioId, before);
  });
});
