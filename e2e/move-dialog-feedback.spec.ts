import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsOwner } from "./helpers/flows";
import { listMessageIds } from "./helpers/mail";
import { getE2eServiceId, getOwnerPractitionerId, seedE2eClient, seedE2eStudio, sql } from "./helpers/seed";

// HON-124 item 7, the "Move appointment" dialog (MoveAppointmentDialog.tsx): its buttons take the shared feedback. Each must show THREE distinct, measurable states
// (a mouse hovers, a finger only presses, a keyboard only focuses) and be tall enough to tap.
//   hover   : background differs from rest
//   pressed : (mouse button held) differs from BOTH rest and hover
//   focus   : reached by Tab, it draws a ring (box-shadow) that rest does not
// A move is a WRITE that emails the client, so this spec is built never to make one: "Move appointment" (the confirm) is only hovered, pressed and focused, and every
// press is released off the control, so nothing is clicked. The only real clicks are the opener, a time tile and the available/custom toggle, which change client
// state only. Afterwards the appointment's starts_at, ends_at and status are read back and must be unchanged, and no client email, text message or calendar sync was queued.
// Each state is read after the 120-180ms transition has settled, or a half-finished hover would differ from the held press by itself.

const T = 20_000;
const SETTLE = 400;
const SLOT = /^\d{1,2}:\d{2} (AM|PM)$/;
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

type Fixture = { studioId: string; apptId: string; clientEmail: string; mailBefore: string[] };
type Snapshot = { starts_at: string; ends_at: string; status: string; sms: number; sync: number };

const snapshot = async (f: Fixture): Promise<Snapshot> => {
  const [a] = await sql<{ starts_at: string; ends_at: string; status: string }>("select starts_at::text, ends_at::text, status from public.appointments where id = $1", [f.apptId]);
  const [{ n: sms }] = await sql<{ n: string }>("select count(*)::text as n from public.sms_outbound_messages where studio_id = $1", [f.studioId]);
  const [{ n: sync }] = await sql<{ n: string }>("select count(*)::text as n from public.calendar_sync_outbox where studio_id = $1", [f.studioId]);
  return { ...a, sms: Number(sms), sync: Number(sync) };
};

/** One studio, one client with a known address, one confirmed appointment tomorrow. The owner is signed in. */
async function setUp(page: Page): Promise<{ f: Fixture; before: Snapshot }> {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const clientEmail = `move-client-${seed.runId}@harness.local`;
  await sql("update public.clients set email = $2 where id = $1", [clientId, clientEmail]);
  const practitionerId = await getOwnerPractitionerId(seed.studioId);
  const serviceId = await getE2eServiceId(seed.studioId);
  const [{ id: apptId }] = await sql<{ id: string }>(
    `with slot as (select ((now() at time zone timezone)::date + 1 + time '13:00') at time zone timezone as starts from public.studios where id = $1)
     insert into public.appointments (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, blocked_ends_at, duration_minutes, buffer_minutes_snapshot, status)
     select $1, $2, $3, $4, starts, starts + interval '30 minutes', starts + interval '30 minutes', 30, 0, 'confirmed' from slot returning id`,
    [seed.studioId, practitionerId, clientId, serviceId],
  );
  const f: Fixture = { studioId: seed.studioId, apptId, clientEmail, mailBefore: await listMessageIds(clientEmail) };
  await loginAsOwner(page, seed);
  return { f, before: await snapshot(f) };
}

const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Move appointment" });

async function openDialog(page: Page, f: Fixture) {
  await page.goto(`/calendar/${f.apptId}`);
  await page.getByRole("button", { name: "Move appointment", exact: true }).first().click();
  await expect(dialogOf(page)).toBeVisible({ timeout: T });
  await expect(dialogOf(page).getByRole("button", { name: SLOT }).first()).toBeVisible({ timeout: T });
}

/** Nothing moved, nothing queued: the appointment is exactly as seeded, and no client email, text or calendar sync appeared. */
async function expectNothingMoved(f: Fixture, before: Snapshot) {
  expect(await snapshot(f), "the appointment's times and status are unchanged and nothing was queued").toEqual(before);
  expect(await listMessageIds(f.clientEmail), "no email reached the client").toEqual(f.mailBefore);
}

async function walk(page: Page) {
  const { f, before } = await setUp(page);
  await openDialog(page, f);
  const d = dialogOf(page);
  const slots = d.getByRole("button", { name: SLOT });
  const available = d.getByRole("button", { name: "Available times" });
  const custom = d.getByRole("button", { name: "Custom time" });
  // The tiles: an UNCHOSEN one shows all three states; the chosen one is a dark fill and carries aria-pressed.
  const idleSlot = slots.nth(1);
  const walked: Array<[string, Locator]> = [
    ["Close", d.getByRole("button", { name: "Close" })],
    ["Custom time (unchosen)", custom],
    ["a time tile (unchosen)", idleSlot],
    ["Keep current time", d.getByRole("button", { name: "Keep current time" })],
  ];
  for (const [label, el] of walked) {
    await el.scrollIntoViewIfNeeded();
    await threeStates(page, el, label);
    await focusRing(page, el, label);
  }
  await expect(available, "the chosen mode is marked, not only coloured").toHaveAttribute("aria-pressed", "true");
  await slots.first().click(); // a client-side selection only: nothing is written until "Move appointment" is pressed
  await expect(slots.first(), "the chosen tile is marked, not only coloured").toHaveAttribute("aria-pressed", "true");
  const confirm = d.getByRole("button", { name: /^Move appointment$/ });
  await expect(confirm).toBeEnabled();
  await confirm.scrollIntoViewIfNeeded();
  await threeStates(page, confirm, "Move appointment (confirm)");
  await focusRing(page, confirm, "Move appointment (confirm)");
  await expect(dialogOf(page), "nothing was moved by the presses: the dialog is still open").toBeVisible();
  await expectNothingMoved(f, before);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
}

test("desktop: the Move appointment dialog's buttons show hover, pressed and focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await walk(page);
});

test("390 px: the Move appointment dialog's buttons show hover, pressed and focus, and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await walk(page);
});

test.describe("on a touch device", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("the Move appointment dialog's buttons are at least 44px tall where the pointer is coarse", async ({ page }) => {
    const { f, before } = await setUp(page);
    await openDialog(page, f);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch emulation must be in effect").toBe(true);
    const d = dialogOf(page);
    const tall = async (l: Locator, label: string) => {
      await l.scrollIntoViewIfNeeded();
      expect(await l.evaluate((e) => (e as HTMLElement).offsetHeight), `${label}: at least 44px`).toBeGreaterThanOrEqual(44);
    };
    await tall(d.getByRole("button", { name: "Close" }), "Close");
    await tall(d.getByRole("button", { name: "Available times" }), "Available times");
    await tall(d.getByRole("button", { name: "Custom time" }), "Custom time");
    await tall(d.getByRole("button", { name: SLOT }).first(), "a time tile");
    await tall(d.getByRole("button", { name: "Keep current time" }), "Keep current time");
    await d.getByRole("button", { name: SLOT }).first().click();
    await tall(d.getByRole("button", { name: /^Move appointment$/ }), "Move appointment (confirm)");
    await expectNothingMoved(f, before);
  });
});
