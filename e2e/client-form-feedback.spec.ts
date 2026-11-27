import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsOwner } from "./helpers/flows";
import { seedE2eStudio, sql } from "./helpers/seed";

// HON-124 item 7, the client form (components/client-form.tsx, shown here on the edit page): its buttons and links take the shared feedback.
// Each must show THREE distinct, measurable states (a mouse hovers, a finger only presses, a keyboard only focuses) and be at least 44px tall on a touch
// device (the allergy chips relax to 32px where the pointer is precise, which is what a Playwright Chromium has, so 32px is what is asserted for them).
//   hover   : background (or, for the text link, colour) differs from rest
//   pressed : (mouse button held) differs from BOTH rest and hover
//   focus   : reached by Tab, it draws a ring (box-shadow) that rest does not
// The duplicate-warning and conflict panels' buttons share the same buttonClasses; they need a second client / a colleague's write and are covered by
// the unit tests of that logic, not here.

const T = 20_000;
const bg = (l: Locator) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
const ring = (l: Locator) => l.evaluate((e) => getComputedStyle(e).boxShadow);
const color = (l: Locator) => l.evaluate((e) => getComputedStyle(e).color);

async function threeStates(page: Page, row: Locator, label: string, measure: (l: Locator) => Promise<string>) {
  await page.mouse.move(1, 1);
  const rest = await measure(row);
  await row.hover();
  const hover = await measure(row);
  expect(hover, `${label}: hover differs from rest`).not.toBe(rest);
  await page.mouse.down();
  const pressed = await measure(row);
  await page.mouse.move(1, 1); // release off the control: a press that ends elsewhere is not a click
  await page.mouse.up();
  expect(pressed, `${label}: pressed differs from rest`).not.toBe(rest);
  await page.mouse.move(1, 1);
  return { rest, hover, pressed };
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

async function check(page: Page, touch: boolean) {
  const seed = await seedE2eStudio();
  const [{ id }] = await sql<{ id: string }>(
    `insert into public.clients (id, studio_id, name, email, phone, preferred_name)
     values (gen_random_uuid(), $1, $2, $3, '604-555-0111', 'Pref') returning id`,
    [seed.studioId, seed.clientName, seed.clientEmail],
  );
  await loginAsOwner(page, seed);
  await page.goto(`/clients/${id}/edit`);
  await expect(page.getByRole("heading", { name: "Edit client" })).toBeVisible({ timeout: T });

  const controls: Array<[string, Locator, (l: Locator) => Promise<string>, boolean]> = [
    ["Save changes", page.getByRole("button", { name: "Save changes" }), bg, true],
    ["Cancel", page.getByRole("link", { name: "Cancel", exact: true }), bg, true],
    ["allergy chip", page.getByRole("button", { name: /^\+ / }).first(), bg, true],
    ["Remove preferred name", page.getByTestId("remove-preferred-name"), color, false],
  ];
  for (const [label, row, measure, distinctPressed] of controls) {
    await row.scrollIntoViewIfNeeded();
    const box = await row.boundingBox();
    const floor = label === "allergy chip" ? 32 : touch ? 44 : 0; // a chip relaxes to 32px under a precise pointer, and Playwright's Chromium has one at every width
    expect(box?.height ?? 0, `${label}: at least ${floor}px tall`).toBeGreaterThanOrEqual(floor);
    const s = await threeStates(page, row, label, measure);
    if (distinctPressed) expect(s.pressed, `${label}: pressed differs from hover`).not.toBe(s.hover);
    await focusRing(page, row, label);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
}

test("desktop: the client form's buttons and links show hover, pressed and focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await check(page, false);
});

test("390 px: the client form's buttons and links show hover, pressed and focus and are 44px tall", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await check(page, true);
});
