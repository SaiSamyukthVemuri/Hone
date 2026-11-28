import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsOwner } from "./helpers/flows";
import { markResendLedger, readResendLedger } from "./helpers/resend-ledger";
import { getE2eServiceId, seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";

// HON-124 item 7, the over-invite recipient chooser (components/waitlist/recipient-chooser.tsx): its six buttons take the shared secondary-button feedback.
// Each must show THREE distinct, measurable states (a mouse hovers, a finger only presses, a keyboard only focuses) and be tall enough to tap.
//   hover   : background differs from rest
//   pressed : (mouse button held) differs from BOTH rest and hover
//   focus   : reached by Tab, it draws a ring (box-shadow) that rest does not
// Reached states (one studio, signed in as the owner, 52 synthetic waiting clients so there are two pages of 50): "Select this page", "Clear this page",
// "Select all 52 listed", "Clear everything", "Next" (page 1) and, after one real click of Next, "Previous" (page 2). "Previous" on page 1 and "Next" on page 2 are DISABLED
// and must show no hover or pressed change at all.
// Every press is released off the control. The one real click is Next: it only turns the chooser's page. The page's own "Send invitations" button is never touched.
// Afterwards nobody is selected, no batch or invitation row exists, the waiting entries are identical (whole rows) and the fake mail ledger saw nothing.
// Each state is read after the 120-180ms transition has settled, or a half-finished hover would differ from the held press by itself.

const T = 30_000;
const SETTLE = 400;
const WAITING = 52;
const look = (l: Locator) => l.evaluate((e) => { const c = getComputedStyle(e); return `${c.backgroundColor}|${c.color}|${c.borderTopColor}`; });
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

async function noChange(page: Page, row: Locator, label: string) {
  await expect(row, `${label}: disabled`).toBeDisabled();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(SETTLE);
  const rest = await look(row);
  await row.hover({ force: true });
  await page.waitForTimeout(SETTLE);
  expect(await look(row), `${label}: a disabled button does not react to a hover`).toBe(rest);
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

async function setUp(page: Page) {
  const seed: E2eSeed = await seedE2eStudio();
  const [{ user_id: owner }] = await sql<{ user_id: string }>(`select user_id from public.practitioners where studio_id = $1 and role = 'owner' and user_id is not null limit 1`, [seed.studioId]);
  await sql(`select * from public.open_new_client_waitlist_admission_round($1,$2,100)`, [seed.studioId, owner]);
  for (let i = 0; i < WAITING; i++) {
    const n = String(i).padStart(2, "0");
    await sql(`select * from public.create_practitioner_waitlist_entry($1,$2,$3,$4,null,null)`, [seed.studioId, owner, `Chooser Person ${n} ${seed.runId}`, `hold+chooser-${n}-${seed.runId}@harness.local`]);
  }
  const serviceId = await getE2eServiceId(seed.studioId);
  const mark = markResendLedger();
  await loginAsOwner(page, seed);
  const rows = async () => ({
    entries: (await sql<{ j: string }>(`select to_jsonb(t)::text as j from public.new_client_waitlist_entries t where studio_id = $1 order by id`, [seed.studioId])).map((r) => r.j),
    batches: (await sql<{ n: number }>(`select count(*)::int n from public.waitlist_invitation_batches where studio_id = $1`, [seed.studioId]))[0]!.n,
    items: (await sql<{ n: number }>(`select count(*)::int n from public.waitlist_invitation_batch_items where studio_id = $1`, [seed.studioId]))[0]!.n,
    invitations: (await sql<{ n: number }>(`select count(*)::int n from public.new_client_waitlist_invitations where studio_id = $1`, [seed.studioId]))[0]!.n,
  });
  return { seed, serviceId, mark, rows, before: await rows() };
}

async function open(page: Page, serviceId: string): Promise<Locator> {
  await page.goto(`/waitlist/over-invite?service=${serviceId}&days=7`);
  const chooser = page.getByTestId("recipient-chooser");
  await expect(chooser).toBeVisible({ timeout: T });
  await expect(chooser.getByTestId("chooser-count")).toContainText("0 selected in all");
  return chooser;
}

const buttons = (chooser: Locator): Array<[string, Locator]> => [
  ["Select this page", chooser.getByRole("button", { name: "Select this page" })],
  ["Clear this page", chooser.getByRole("button", { name: "Clear this page" })],
  ["Select all listed", chooser.getByRole("button", { name: new RegExp(`^Select all ${WAITING} listed$`) })],
  ["Clear everything", chooser.getByRole("button", { name: "Clear everything" })],
  ["Next", chooser.getByRole("button", { name: "Next", exact: true })],
];

async function walk(page: Page) {
  const { serviceId, mark, rows, before } = await setUp(page);
  const chooser = await open(page, serviceId);
  const url = page.url();
  for (const [label, el] of buttons(chooser)) {
    await el.scrollIntoViewIfNeeded();
    await threeStates(page, el, label);
    await focusRing(page, el, label);
  }
  await noChange(page, chooser.getByRole("button", { name: "Previous", exact: true }), "Previous (page 1)");
  // the one real click: Next turns the chooser to page 2, where Previous is live and Next is disabled
  await chooser.getByRole("button", { name: "Next", exact: true }).click();
  await expect(chooser.getByTestId("chooser-range")).toContainText("51–52 of 52");
  const previous = chooser.getByRole("button", { name: "Previous", exact: true });
  await threeStates(page, previous, "Previous");
  await focusRing(page, previous, "Previous");
  await noChange(page, chooser.getByRole("button", { name: "Next", exact: true }), "Next (page 2)");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
  expect(page.url(), "the address did not change").toBe(url);
  await expect(chooser.getByTestId("chooser-count")).toContainText("0 selected in all");
  expect(await rows(), "nothing was written: the waiting entries are identical, no batch, item or invitation exists").toEqual(before);
  expect(readResendLedger(mark), "nothing was emailed").toHaveLength(0);
}

test("desktop: the chooser's buttons show hover, pressed and focus; nothing is selected or sent", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await walk(page);
});

test("390 px: the chooser's buttons show hover, pressed and focus, and the page does not scroll sideways", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await walk(page);
});

test.describe("on a touch device", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("the chooser's buttons are at least 44px tall where the pointer is coarse", async ({ page }) => {
    test.setTimeout(240_000);
    const { serviceId, rows, before } = await setUp(page);
    const chooser = await open(page, serviceId);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch emulation must be in effect").toBe(true);
    for (const [label, el] of [...buttons(chooser), ["Previous", chooser.getByRole("button", { name: "Previous", exact: true })] as [string, Locator]]) {
      await el.scrollIntoViewIfNeeded();
      expect(await el.evaluate((e) => (e as HTMLElement).offsetHeight), `${label}: at least 44px`).toBeGreaterThanOrEqual(44);
    }
    expect(await rows(), "nothing was changed").toEqual(before);
  });
});
