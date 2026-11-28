import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsOwner } from "./helpers/flows";
import { seedE2eOverdueDisinfectant, seedE2eProbeInventoryItem, seedE2eStudio, sql } from "./helpers/seed";

// HON-124 item 7, Record Keeping rows (app/(app)/records/page.tsx): a sterile-item row and a disinfectant-batch row are disclosures; their in-row "Trace usage" link, the
// "Review batch" notice link and the Edit / History summaries inside an opened row take the shared feedback. Each must show THREE distinct, measurable states (a mouse
// hovers, a finger only presses, a keyboard only focuses) and be tall enough to tap.
//   hover   : background (or, for a text link, colour / underline weight) differs from rest
//   pressed : (mouse button held) differs from BOTH rest and hover
//   focus   : reached by Tab, it draws a ring (box-shadow) that rest does not
// Synthetic logbook rows are seeded (one sterile purchase, one overdue disinfectant batch). Rows are opened (a client-side toggle), but the Edit form is NEVER opened or
// submitted and no link is followed: every press is released off the control. After each walk, every seeded row is read back as a whole (to_jsonb, so every column and
// updated_at) and must be identical, the studio's audit events must be unchanged, and the page's address must not have changed.
// Not covered here: exposure-incident rows and the per-session usage rows, which need personal-health and clinical-session fixtures.
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

type Snapshot = { sterile: string[]; disinfectants: string[]; audit: number };
const snapshot = async (studioId: string): Promise<Snapshot> => ({
  sterile: (await sql<{ j: string }>("select to_jsonb(t)::text as j from public.record_keeping_sterile_items t where studio_id = $1 order by id", [studioId])).map((r) => r.j),
  disinfectants: (await sql<{ j: string }>("select to_jsonb(t)::text as j from public.record_keeping_disinfectants t where studio_id = $1 order by id", [studioId])).map((r) => r.j),
  audit: Number((await sql<{ n: string }>("select count(*)::text as n from public.record_keeping_audit_events where studio_id = $1", [studioId]))[0].n),
});

const STERILE = "E2E sterile purchase";
const BATCH = "E2E disinfectant jar";

async function setUp(page: Page): Promise<{ studioId: string; before: Snapshot }> {
  const seed = await seedE2eStudio();
  const nextYear = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
  await seedE2eProbeInventoryItem(seed, { lotNumber: `E2E-LOT-${seed.runId}`, description: STERILE, manufacturer: "E2E maker", expiryDate: nextYear });
  await seedE2eOverdueDisinfectant(seed, { name: BATCH });
  await loginAsOwner(page, seed);
  return { studioId: seed.studioId, before: await snapshot(seed.studioId) };
}

const rowOf = (page: Page, text: string) => page.locator("li", { has: page.locator("summary", { hasText: text }) });
const summaryOf = (page: Page, text: string) => rowOf(page, text).locator("summary").first();
const toolsOf = (page: Page, text: string, name: "Edit" | "History") => rowOf(page, text).locator("summary", { hasText: new RegExp(`^${name}$`) });

async function expectNothingChanged(page: Page, studioId: string, before: Snapshot, url: string) {
  expect(await snapshot(studioId), "every seeded row (all columns, updated_at) and the audit events are unchanged: no edit was opened or submitted").toEqual(before);
  expect(page.url(), "no link was followed").toBe(url);
}

async function walkRow(page: Page, text: string, extra: Array<[string, Locator]>) {
  const summary = summaryOf(page, text);
  await summary.scrollIntoViewIfNeeded();
  await threeStates(page, summary, `${text}: the row`);
  await focusRing(page, summary, `${text}: the row`);
  for (const [label, el] of extra) {
    await el.scrollIntoViewIfNeeded();
    await threeStates(page, el, label);
    await focusRing(page, el, label);
  }
  await summary.locator("strong").first().click(); // opens the row: a client-side toggle, nothing is written
  for (const name of ["Edit", "History"] as const) {
    const tool = toolsOf(page, text, name);
    await expect(tool, `${text}: ${name} is shown in the opened row`).toBeVisible({ timeout: T });
    await tool.scrollIntoViewIfNeeded();
    await threeStates(page, tool, `${text}: ${name}`);
    await focusRing(page, tool, `${text}: ${name}`);
  }
}

async function walk(page: Page) {
  const { studioId, before } = await setUp(page);
  await page.goto("/records?section=sterile");
  await expect(summaryOf(page, STERILE)).toBeVisible({ timeout: T });
  let url = page.url();
  await walkRow(page, STERILE, [["Trace usage (in the sterile row)", summaryOf(page, STERILE).getByRole("link", { name: "Trace usage" })]]);
  await expectNothingChanged(page, studioId, before, url);

  await page.goto("/records?section=disinfectants");
  await expect(summaryOf(page, BATCH)).toBeVisible({ timeout: T });
  url = page.url();
  await walkRow(page, BATCH, [["Review batch (the overdue notice)", page.getByRole("link", { name: "Review batch" })]]);
  await expectNothingChanged(page, studioId, before, url);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
}

test("desktop: the Record Keeping rows show hover, pressed and focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await walk(page);
});

test("390 px: the Record Keeping rows show hover, pressed and focus, and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await walk(page);
});

test.describe("on a touch device", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("the Record Keeping row controls are at least 44px tall where the pointer is coarse", async ({ page }) => {
    const { studioId, before } = await setUp(page);
    await page.goto("/records?section=sterile");
    await expect(summaryOf(page, STERILE)).toBeVisible({ timeout: T });
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch emulation must be in effect").toBe(true);
    const tall = async (l: Locator, label: string) => {
      await l.scrollIntoViewIfNeeded();
      expect(await l.evaluate((e) => (e as HTMLElement).offsetHeight), `${label}: at least 44px`).toBeGreaterThanOrEqual(44);
    };
    await tall(summaryOf(page, STERILE), "the sterile row");
    await tall(summaryOf(page, STERILE).getByRole("link", { name: "Trace usage" }), "Trace usage");
    await summaryOf(page, STERILE).locator("strong").first().click();
    await tall(toolsOf(page, STERILE, "Edit"), "Edit");
    await tall(toolsOf(page, STERILE, "History"), "History");
    await page.goto("/records?section=disinfectants");
    await expect(summaryOf(page, BATCH)).toBeVisible({ timeout: T });
    await tall(summaryOf(page, BATCH), "the disinfectant row");
    await tall(page.getByRole("link", { name: "Review batch" }), "Review batch");
    expect(await snapshot(studioId), "nothing was changed").toEqual(before);
  });
});
