import { test, expect, type Browser, type Page, type BrowserContext } from "@playwright/test";
import {
  seedE2eStudio,
  getClientIdByEmail,
  getAppointmentsForClient,
  type E2eSeed,
} from "./helpers/seed";
import { bookAppointment, loginAsOwner } from "./helpers/flows";

// Practitioner Move appointment — the ONE shared responsive workflow (migration
// 0133), exercised end-to-end on mobile, tablet, and desktop against the LOCAL
// stack. This spec proves the parts only a real browser can:
//   * the SAME MoveAppointmentDialog + server actions drive a real move at each
//     viewport (bottom sheet on phone, centered modal on tablet/desktop);
//   * a move UPDATES the same appointment row — the id is preserved, the row
//     count never grows (no cancel + rebook), the status stays confirmed, and
//     only the time changes;
//   * the dialog is an accessible modal: Escape closes it when idle, and the
//     confirm control is disabled until a time is chosen;
//   * the mobile sheet never makes the page scroll horizontally.
//
// The RPC-level rejection paths (23P01 double-book, stale optimistic-concurrency,
// no_change, not-authorized, not-movable) are covered DETERMINISTICALLY by the DB
// integration suite (tests/db/practitioner-move-appointment.db.test.ts) and the
// outcome-mapping source guard (tests/source-guards/move-appointment-guards),
// which can stage concurrency/authz the UI cannot reach without a race.

test.describe.configure({ mode: "serial" });

const SLOT = /^\d{1,2}:\d{2} (AM|PM)$/; // same 12h label the booking flow matches

// getAppointmentsForClient runs raw `pg`, which returns timestamptz as a Date
// object — so compare the INSTANT (epoch ms), never the Date reference.
const instant = (v: string | Date): number => new Date(v).getTime();

let seed: E2eSeed;
let clientId: string;
let apptId: string;

async function expectNoPageOverflow(page: Page, label: string) {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    widths.scrollWidth,
    `${label}: page must not scroll horizontally (${widths.scrollWidth} vs ${widths.clientWidth})`,
  ).toBeLessThanOrEqual(widths.clientWidth);
}

// Drive one full move of the SAME appointment at the given viewport, then assert
// the same-record invariant straight from the database (the source of truth).
// `pickLast` alternates the chosen slot between the earliest and latest offered
// time so consecutive moves always change the time (never a no_change no-op).
async function moveOnce(
  page: Page,
  label: string,
  pickLast: boolean,
): Promise<void> {
  const before = await getAppointmentsForClient(seed.studioId, clientId);
  const prev = before.find((a) => a.id === apptId)!;
  expect(prev, `${label}: appointment exists before move`).toBeTruthy();

  await page.goto(`/calendar/${apptId}`);
  const dialog = page.getByRole("dialog", { name: "Move appointment" });

  // Entry point: the single Move trigger in the confirmed+future section.
  await page.getByRole("button", { name: "Move appointment" }).click();
  await expect(dialog).toBeVisible();

  // Confirm is disabled until a time is selected (the UX gate).
  const confirm = dialog.getByRole("button", { name: /^Move appointment$/ });
  await expect(confirm).toBeDisabled();

  // Slots load for the appointment's own date (own reservation excluded).
  const slots = dialog.getByRole("button", { name: SLOT });
  await expect(slots.first()).toBeVisible({ timeout: 15_000 });
  const count = await slots.count();
  expect(count, `${label}: at least one available time`).toBeGreaterThan(0);

  if (label === "mobile") {
    await expectNoPageOverflow(page, "mobile move sheet open");
  }

  await (pickLast ? slots.nth(count - 1) : slots.first()).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // On success the dialog closes and the calendar refreshes.
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });

  // Same-record invariant, read from the DB.
  const after = await getAppointmentsForClient(seed.studioId, clientId);
  expect(after, `${label}: still exactly one appointment (no cancel+rebook)`).toHaveLength(
    before.length,
  );
  const moved = after.find((a) => a.id === apptId)!;
  expect(moved, `${label}: same appointment id preserved`).toBeTruthy();
  expect(moved.status, `${label}: still confirmed`).toBe("confirmed");
  expect(instant(moved.starts_at), `${label}: start time changed`).not.toBe(
    instant(prev.starts_at),
  );
}

async function ctxPage(
  browser: Browser,
  viewport: { width: number; height: number },
  touch: boolean,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    viewport,
    hasTouch: touch,
    ...(touch ? { deviceScaleFactor: 2 } : {}),
  });
  const page = await ctx.newPage();
  await loginAsOwner(page, seed);
  return { ctx, page };
}

test("move appointment: shared responsive workflow preserves the same record", async ({
  browser,
}) => {
  await test.step("seed studio + book one confirmed appointment", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    seed = await seedE2eStudio();
    await bookAppointment(page, seed);
    clientId = (await getClientIdByEmail(seed.studioId, seed.clientEmail))!;
    expect(clientId).toBeTruthy();
    const appts = await getAppointmentsForClient(seed.studioId, clientId);
    expect(appts).toHaveLength(1);
    expect(appts[0].status).toBe("confirmed");
    apptId = appts[0].id;
    await ctx.close();
  });

  await test.step("desktop: move via the appointment detail page", async () => {
    const { ctx, page } = await ctxPage(browser, { width: 1280, height: 800 }, false);
    await moveOnce(page, "desktop", /* pickLast */ true);
    await ctx.close();
  });

  await test.step("mobile: move via the bottom-sheet dialog", async () => {
    const { ctx, page } = await ctxPage(browser, { width: 390, height: 844 }, true);
    await moveOnce(page, "mobile", /* pickLast */ false);
    await ctx.close();
  });

  await test.step("tablet: move via the centered dialog", async () => {
    const { ctx, page } = await ctxPage(browser, { width: 820, height: 1180 }, true);
    await moveOnce(page, "tablet", /* pickLast */ true);
    await ctx.close();
  });

  await test.step("a11y: modal role + Escape-when-idle closes without moving", async () => {
    const { ctx, page } = await ctxPage(browser, { width: 1280, height: 800 }, false);
    const before = await getAppointmentsForClient(seed.studioId, clientId);
    const prevStart = before.find((a) => a.id === apptId)!.starts_at;

    await page.goto(`/calendar/${apptId}`);
    const dialog = page.getByRole("dialog", { name: "Move appointment" });
    await page.getByRole("button", { name: "Move appointment" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");

    // Escape while idle (no submission in flight) closes the dialog.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // Nothing moved.
    const after = await getAppointmentsForClient(seed.studioId, clientId);
    expect(after).toHaveLength(before.length);
    expect(instant(after.find((a) => a.id === apptId)!.starts_at)).toBe(instant(prevStart));
    await ctx.close();
  });
});
