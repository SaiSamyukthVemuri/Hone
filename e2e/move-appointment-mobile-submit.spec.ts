import { test, expect, type Browser, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  getClientIdByEmail,
  getAppointmentsForClient,
  type E2eSeed,
} from "./helpers/seed";
import { bookAppointment, loginAsOwner } from "./helpers/flows";

// Regression for the reported iPhone defect: tapping "Move appointment" made the
// whole footer/button vanish for ~1s (while the invisible action still ran), then
// reappear as "Moving appointment…". The submit control must NEVER disappear or be
// invisibly clickable. These tests delay the move server action so the pending UI can
// be inspected across frames, and prove duplicate-submit protection + failure recovery.

test.describe.configure({ mode: "serial" });

const instant = (v: string | Date): number => new Date(v).getTime();
const futureYmd = (offset: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(Date.now() + offset * 86_400_000),
  );

let seed: E2eSeed;
let clientId: string;
let apptId: string;

// Per-page control over the move server-action network response.
type MoveControl = { delayMs: number; abort: boolean; count: number };
async function installMoveInterceptor(page: Page): Promise<MoveControl> {
  const ctrl: MoveControl = { delayMs: 0, abort: false, count: 0 };
  await page.route("**/calendar/**", async (route, request) => {
    // Server actions POST to the current route. We only act while a flag is set,
    // set only around the Move tap, when the sole action POST is the move itself.
    if (request.method() === "POST" && (ctrl.delayMs > 0 || ctrl.abort)) {
      ctrl.count += 1;
      if (ctrl.abort) {
        await route.abort("failed");
        return;
      }
      await new Promise((r) => setTimeout(r, ctrl.delayMs));
    }
    await route.continue();
  });
  return ctrl;
}

async function ownerPage(browser: Browser, viewport: { width: number; height: number }, touch: boolean) {
  const ctx = await browser.newContext({ viewport, hasTouch: touch, ...(touch ? { deviceScaleFactor: 3 } : {}) });
  const page = await ctx.newPage();
  const ctrl = await installMoveInterceptor(page);
  await loginAsOwner(page, seed);
  return { ctx, page, ctrl };
}

// Open Move → Custom time, enter a valid future outside-hours time + acknowledge.
// Does NOT submit.
async function openCustomReady(page: Page, date: string, time: string) {
  await page.goto(`/calendar/${apptId}`);
  const dialog = page.getByRole("dialog", { name: "Move appointment" });
  await page.getByRole("button", { name: "Move appointment" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Custom time" }).click();
  await dialog.locator('input[type="date"]').fill(date);
  await dialog.locator('input[type="time"]').fill(time);
  await dialog.getByRole("checkbox").check();
  return dialog;
}

async function expectNoPageOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s, `${label}: no horizontal overflow`).toBeLessThanOrEqual(w.c);
}

test("mobile Move submit: footer stays painted, immediate disabled 'Moving…', no duplicate, recovers on failure", async ({ browser }) => {
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

  await test.step("iPhone: pending state is immediate + footer never disappears; exactly one move", async () => {
    const { ctx, page, ctrl } = await ownerPage(browser, { width: 390, height: 844 }, true);
    const before = await getAppointmentsForClient(seed.studioId, clientId);
    const prevStart = before.find((a) => a.id === apptId)!.starts_at;

    const dialog = await openCustomReady(page, futureYmd(400), "05:00");
    const confirm = dialog.getByRole("button", { name: /Move appointment|Moving appointment/ });
    const keep = dialog.getByRole("button", { name: "Keep current time" });
    const footer = confirm.locator("xpath=.."); // the footer div is the button's parent
    const vp = page.viewportSize()!;

    await expect(confirm).toHaveText(/^Move appointment$/);
    await expect(confirm).toBeEnabled();

    // Delay the move response so we can inspect the pending UI.
    ctrl.delayMs = 2500;
    await confirm.click();

    // 1-6: the SAME button is still there, visible, in the viewport, disabled, and its
    // text changed synchronously to "Moving appointment…".
    await expect(confirm).toBeVisible();
    await expect(confirm).toHaveText(/Moving appointment/);
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveAttribute("aria-busy", "true");
    // 7: Keep current time remains visible + disabled.
    await expect(keep).toBeVisible();
    await expect(keep).toBeDisabled();
    // 10: modal remains open.
    await expect(dialog).toBeVisible();

    // 2/3/4 + 8/9: over multiple frames the button + footer stay visible, on-screen,
    // above the bottom safe area, and the footer never collapses to zero height.
    for (let i = 0; i < 4; i++) {
      const b = (await confirm.boundingBox())!;
      expect(b, `frame ${i}: submit button has a box`).toBeTruthy();
      expect(b.width * b.height, `frame ${i}: button not zero-size`).toBeGreaterThan(0);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, `frame ${i}: button right edge on-screen`).toBeLessThanOrEqual(vp.width + 0.5);
      expect(b.y + b.height, `frame ${i}: button bottom above the viewport bottom`).toBeLessThanOrEqual(vp.height + 0.5);
      const f = (await footer.boundingBox())!;
      expect(f.height, `frame ${i}: footer height not collapsed`).toBeGreaterThan(0);
      await page.waitForTimeout(400);
    }

    // 11/12: a forced second click during the pending window starts NO second request.
    await confirm.dispatchEvent("click");
    await page.waitForTimeout(100);

    // Let the delayed move resolve → success closes the dialog.
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    expect(ctrl.count, "exactly one move request was issued").toBe(1);

    // Success: same appointment id, moved to the custom time, no duplicate row.
    const after = await getAppointmentsForClient(seed.studioId, clientId);
    expect(after).toHaveLength(before.length);
    const moved = after.find((a) => a.id === apptId)!;
    expect(moved.status).toBe("confirmed");
    expect(instant(moved.starts_at)).not.toBe(instant(prevStart));
    await ctx.close();
  });

  await test.step("failure path: aborted move keeps the footer, re-enables the button, retains input, allows retry", async () => {
    const { ctx, page, ctrl } = await ownerPage(browser, { width: 390, height: 844 }, true);
    const before = await getAppointmentsForClient(seed.studioId, clientId);
    const prevStart = before.find((a) => a.id === apptId)!.starts_at;

    const dialog = await openCustomReady(page, futureYmd(402), "23:15");
    const confirm = dialog.getByRole("button", { name: /Move appointment|Moving appointment/ });
    const footer = confirm.locator("xpath=..");

    // Abort the move request → the client sees a safe failure.
    ctrl.abort = true;
    await confirm.click();

    // Footer + dialog never disappear; error surfaces; button becomes enabled again.
    await expect(footer).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(confirm).toHaveText(/^Move appointment$/, { timeout: 10_000 });
    await expect(confirm).toBeEnabled();
    // The entered custom time + acknowledgement are retained for a deliberate retry.
    await expect(dialog.locator('input[type="time"]')).toHaveValue("23:15");
    await expect(dialog.getByRole("checkbox")).toBeChecked();
    expect(ctrl.count, "exactly one (failed) request was issued").toBe(1);

    // Retry succeeds once the network recovers → the appointment moves.
    ctrl.abort = false;
    await confirm.click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    const after = await getAppointmentsForClient(seed.studioId, clientId);
    expect(after).toHaveLength(before.length);
    expect(instant(after.find((a) => a.id === apptId)!.starts_at)).not.toBe(instant(prevStart));
    await ctx.close();
  });

  for (const [label, vp, touch] of [
    ["iPhone portrait", { width: 390, height: 844 }, true],
    ["tablet portrait", { width: 820, height: 1180 }, true],
    ["desktop", { width: 1280, height: 800 }, false],
  ] as const) {
    await test.step(`layout: footer fully on-screen at ${label}`, async () => {
      const { ctx, page } = await ownerPage(browser, vp, touch);
      const dialog = await openCustomReady(page, futureYmd(410), "04:30");
      const confirm = dialog.getByRole("button", { name: /Move appointment|Moving appointment/ });
      const b = (await confirm.boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(vp.width + 0.5);
      expect(b.y + b.height, `${label}: footer button above viewport bottom`).toBeLessThanOrEqual(vp.height + 0.5);
      await expect(confirm).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Keep current time" })).toBeVisible();
      await expectNoPageOverflow(page, label);
      await ctx.close();
    });
  }
});
