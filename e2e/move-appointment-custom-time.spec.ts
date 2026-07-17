import { test, expect, type Browser, type Page, type BrowserContext } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  getClientIdByEmail,
  getAppointmentsForClient,
  type E2eSeed,
} from "./helpers/seed";
import { bookAppointment, loginAsOwner, loginByMagicLink } from "./helpers/flows";

// Owner custom-time override for Move appointment (a code-only follow-up on the
// 0133 RPC). Proves the parts only a browser can: the owner-only mode selector,
// the custom-time input + outside-hours acknowledgement gate, the same-record
// invariant, a11y (Escape-idle / focus), and that a NON-owner never sees the
// custom option. The server authorization (owner role, acknowledgement, unknown
// mode, membership) is covered exhaustively by the action unit tests.

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;
let clientId: string;
let apptId: string;

async function expectNoPageOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  expect(w.s, `${label}: no horizontal overflow (${w.s} vs ${w.c})`).toBeLessThanOrEqual(w.c);
}

const instant = (v: string | Date): number => new Date(v).getTime();

async function ownerCtx(browser: Browser, viewport: { width: number; height: number }, touch: boolean) {
  const ctx = await browser.newContext({ viewport, hasTouch: touch, ...(touch ? { deviceScaleFactor: 2 } : {}) });
  const page = await ctx.newPage();
  await loginAsOwner(page, seed);
  return { ctx, page };
}

// Open the Move dialog on the detail page and switch into custom-time mode.
async function openCustom(page: Page) {
  await page.goto(`/calendar/${apptId}`);
  const dialog = page.getByRole("dialog", { name: "Move appointment" });
  await page.getByRole("button", { name: "Move appointment" }).click();
  await expect(dialog).toBeVisible();
  const customBtn = dialog.getByRole("button", { name: "Custom time" });
  await expect(customBtn).toBeVisible(); // owner sees the option
  await customBtn.click();
  return dialog;
}

// Fill a custom studio-local date + outside-hours time, acknowledge, move, and
// assert the same-record invariant from the DB. Returns nothing; throws on failure.
async function customMove(page: Page, label: string, date: string, time: string) {
  const before = await getAppointmentsForClient(seed.studioId, clientId);
  const prev = before.find((a) => a.id === apptId)!;

  const dialog = await openCustom(page);
  const timeInput = dialog.locator('input[type="time"]');
  const dateInput = dialog.locator('input[type="date"]');
  const ack = dialog.getByRole("checkbox");
  const confirm = dialog.getByRole("button", { name: /^Move appointment$/ });

  await expect(dialog.getByText(/Custom time can be outside regular operating hours/)).toBeVisible();
  await expect(confirm).toBeDisabled(); // nothing entered yet

  await dateInput.fill(date);
  await timeInput.fill(time);
  await expect(confirm, `${label}: still disabled before acknowledgement`).toBeDisabled();

  if (label === "mobile") await expectNoPageOverflow(page, "mobile custom sheet");

  await ack.check();
  await expect(confirm, `${label}: enabled after acknowledgement`).toBeEnabled();
  await confirm.click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });

  const after = await getAppointmentsForClient(seed.studioId, clientId);
  expect(after, `${label}: no duplicate appointment (row count unchanged)`).toHaveLength(before.length);
  const moved = after.find((a) => a.id === apptId)!;
  expect(moved, `${label}: same appointment id preserved`).toBeTruthy();
  expect(moved.status).toBe("confirmed");
  expect(instant(moved.starts_at), `${label}: moved to the custom time`).not.toBe(instant(prev.starts_at));
}

test("owner custom-time move works across mobile, tablet, desktop; non-owner cannot", async ({ browser }) => {
  await test.step("seed + book one confirmed appointment", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    seed = await seedE2eStudio();
    await bookAppointment(page, seed);
    clientId = (await getClientIdByEmail(seed.studioId, seed.clientEmail))!;
    const appts = await getAppointmentsForClient(seed.studioId, clientId);
    expect(appts).toHaveLength(1);
    apptId = appts[0].id;
    await ctx.close();
  });

  await test.step("mobile: owner moves to an OUTSIDE-HOURS custom time (05:00, before the 06:00 open)", async () => {
    const { ctx, page } = await ownerCtx(browser, { width: 390, height: 844 }, true);
    await customMove(page, "mobile", "2027-06-15", "05:00");
    await ctx.close();
  });

  await test.step("tablet: owner moves to a late outside-hours custom time (23:00)", async () => {
    const { ctx, page } = await ownerCtx(browser, { width: 820, height: 1180 }, true);
    await customMove(page, "tablet", "2027-06-16", "23:00");
    // Landscape: the shared dialog still fits + footer reachable.
    const dialog = await openCustom(page);
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(dialog.getByRole("button", { name: /^Move appointment$/ })).toBeVisible();
    await expectNoPageOverflow(page, "tablet landscape custom dialog");
    await ctx.close();
  });

  await test.step("desktop: Escape closes when idle; keyboard acknowledgement; move persists", async () => {
    const { ctx, page } = await ownerCtx(browser, { width: 1280, height: 800 }, false);
    // Escape while idle closes the dialog (no move).
    const dialog = await openCustom(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    // Keyboard-driven acknowledgement + move.
    const before = await getAppointmentsForClient(seed.studioId, clientId);
    const prev = before.find((a) => a.id === apptId)!;
    const d2 = await openCustom(page);
    await d2.locator('input[type="date"]').fill("2027-06-17");
    await d2.locator('input[type="time"]').fill("04:00");
    const ack = d2.getByRole("checkbox");
    await ack.focus();
    await page.keyboard.press("Space"); // toggle the acknowledgement via keyboard
    await expect(ack).toBeChecked();
    const confirm = d2.getByRole("button", { name: /^Move appointment$/ });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(d2).toHaveCount(0, { timeout: 15_000 });
    const after = await getAppointmentsForClient(seed.studioId, clientId);
    expect(after).toHaveLength(before.length);
    expect(instant(after.find((a) => a.id === apptId)!.starts_at)).not.toBe(instant(prev.starts_at));
    await ctx.close();
  });

  await test.step("non-owner: NO custom-time option; available mode still works", async () => {
    const member = await seedE2eMember(seed);
    const ctx: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await loginByMagicLink(page, member.email);
    await page.goto(`/calendar/${apptId}`);
    const dialog = page.getByRole("dialog", { name: "Move appointment" });
    await page.getByRole("button", { name: "Move appointment" }).click();
    await expect(dialog).toBeVisible();
    // The owner-only mode selector is not rendered for a non-owner.
    await expect(dialog.getByRole("button", { name: "Custom time" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Available times" })).toHaveCount(0);
    // Available-slot mode remains usable: generated time buttons load.
    await expect(dialog.getByRole("button", { name: /^\d{1,2}:\d{2} (AM|PM)$/ }).first()).toBeVisible({ timeout: 15_000 });
    await ctx.close();
  });
});
