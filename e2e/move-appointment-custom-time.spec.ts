import { test, expect, type Browser, type Page, type BrowserContext } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  seedE2eClient,
  getClientIdByEmail,
  getAppointmentsForClient,
  getE2eServiceId,
  getStudioTimezone,
  seedConfirmedAppointment,
  seedFutureAppointmentAt,
  seedPractitionerDefault,
  setStudioCapacityBookingEnabled,
  setStudioCapacityEnabled,
  sql,
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

// FUTURE dates derived from the real clock (not hardcoded years) so the spec never
// becomes a time bomb: a fixed future date turns into a PAST date once it passes, and
// the server rejects past custom times. Far enough out to stay clearly future + distinct.
const futureYmd = (offsetDays: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );

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
    await customMove(page, "mobile", futureYmd(400), "05:00");
    await ctx.close();
  });

  await test.step("tablet: owner moves to a late outside-hours custom time (23:00)", async () => {
    const { ctx, page } = await ownerCtx(browser, { width: 820, height: 1180 }, true);
    await customMove(page, "tablet", futureYmd(401), "23:00");
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
    await d2.locator(String.raw`input[type="date"]`).fill(futureYmd(402));
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

// ---------------------------------------------------------------------------
// EMERG-02 — the customer-reported "Move appointment stays greyed out".
//
// The reported shape is a capacity-ON studio whose appointment is still held by
// a practitioner who is no longer service-eligible. The DB command REFUSES to
// preserve that practitioner on a time-only move — `move_or_reassign_appointment`
// coalesces a NULL target to the appointment's current practitioner and then
// validates it independently, returning `practitioner_reassignment_required`
// (0144 -> 0174; proved directly by tests/db/move-target-integrity.db.test.ts).
//
// So the DISABLED BUTTON IS CORRECT and must stay. What was missing is any
// statement of WHY at the point of action: the owner scrolls to a greyed
// primary button in the footer with the only hint far above it, and — when the
// appointment holds no practitioner at all — with no hint anywhere.
//
// These tests pin the DISCLOSURE and the recovery path. They must never be
// "fixed" by enabling the button: that would submit a move the database
// refuses.
// ---------------------------------------------------------------------------

type Fixture = {
  seed: E2eSeed;
  tz: string;
  clientId: string;
  A: { email: string; displayName: string; practitionerId: string };
  B: { email: string; displayName: string; practitionerId: string };
  serviceId: string;
};

// Capacity-ON studio, two active members A + B, both with wide-open hours.
async function capacityFixture(): Promise<Fixture> {
  const seed = await seedE2eStudio();
  const tz = await getStudioTimezone(seed.studioId);
  const { clientId } = await seedE2eClient(seed);
  const A = await seedE2eMember(seed);
  const B = await seedE2eMember(seed);
  await setStudioCapacityEnabled(seed.studioId, true);
  await setStudioCapacityBookingEnabled(seed.studioId, true);
  for (let d = 0; d <= 6; d++) {
    await seedPractitionerDefault(seed.studioId, A.practitionerId, d, true, "06:00", "22:00");
    await seedPractitionerDefault(seed.studioId, B.practitionerId, d, true, "06:00", "22:00");
  }
  const serviceId = await getE2eServiceId(seed.studioId);
  return { seed, tz, clientId, A, B, serviceId };
}

// seedConfirmedAppointment leaves `service_id` NULL, and BOTH the eligibility
// lookup and the DB command skip the service check entirely when it is NULL
// (`if v_appt.service_id is not null ...`). A service-less appointment therefore
// cannot express this defect at all — attach the studio's service so eligibility
// is actually consulted. Missing this is why the first reproduction ran green.
const attachService = (apptId: string, serviceId: string) =>
  sql(`update public.appointments set service_id = $2 where id = $1`, [apptId, serviceId]);

// seedFutureAppointmentAt only seeds TODAY, so an EARLY-MORNING studio-local
// time — the whole point of the outside-hours case — is already in the past by
// the time the suite runs and the appointment is no longer movable. Seed the
// same studio-local time on a future date instead.
async function seedLocalTimeOnFutureDate(f: Fixture, offsetDays: number, localHHMM: string) {
  const rows = await sql<{ startu: string; endu: string }>(
    `select (to_char((now() at time zone $1)::date + $3::int, 'YYYY-MM-DD') || ' ' || $2)::timestamp at time zone $1 as startu,
            ((to_char((now() at time zone $1)::date + $3::int, 'YYYY-MM-DD') || ' ' || $2)::timestamp + interval '60 min') at time zone $1 as endu`,
    [f.tz, localHHMM, offsetDays],
  );
  return seedConfirmedAppointment(
    f.seed.studioId,
    f.A.practitionerId,
    f.clientId,
    new Date(rows[0].startu).toISOString(),
    new Date(rows[0].endu).toISOString(),
  );
}

const removeEligibility = (serviceId: string, practitionerId: string) =>
  sql(`delete from public.service_practitioners where service_id = $1 and practitioner_id = $2`, [
    serviceId,
    practitionerId,
  ]);

async function openMoveDialog(page: Page, apptId: string) {
  await page.goto(`/calendar/${apptId}`);
  await page.getByRole("button", { name: /^Move appointment$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Move appointment" });
  await expect(dialog).toBeVisible();
  return dialog;
}

// Enter a valid future custom date/time and acknowledge the override.
async function fillCustom(dialog: ReturnType<Page["getByRole"]>, date: string, time: string) {
  await dialog.getByRole("button", { name: "Custom time" }).click();
  await dialog.locator('input[type="date"]').fill(date);
  await dialog.locator('input[type="time"]').fill(time);
  await dialog.getByRole("checkbox").check();
}

test.describe("EMERG-02 — custom-time move gate", () => {
test.describe.configure({ mode: "default" });

test("EMERG-02 A: ineligible current practitioner — custom time states WHY at the footer, and reassignment recovers", async ({
  browser,
}) => {
  const f = await capacityFixture();
  const apptId = await seedFutureAppointmentAt(f.seed.studioId, f.A.practitionerId, f.clientId, f.tz, "15:00");
  await attachService(apptId, f.serviceId);
  await removeEligibility(f.serviceId, f.A.practitionerId); // A can no longer hold this service

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await loginByMagicLink(page, f.seed.ownerEmail);
  const dialog = await openMoveDialog(page, apptId);
  await expect(dialog.getByLabel("Practitioner")).toBeVisible({ timeout: 20_000 });

  await fillCustom(dialog, futureYmd(410), "05:00");

  const confirm = dialog.getByRole("button", { name: /^Move appointment$/ });
  // The gate itself is CORRECT — the database would refuse this move.
  await expect(confirm, "blocked while the current practitioner cannot hold the appointment").toBeDisabled();
  // THE DEFECT: the footer said nothing about why.
  const reason = dialog.getByTestId("confirm-disabled-reason");
  await expect(reason, "a disabled primary action must state its prerequisite").toBeVisible();
  await expect(reason).toContainText(/practitioner/i);

  // Recovery: an explicit, eligible reassignment target unblocks the SAME custom time.
  await dialog.getByLabel("Practitioner").selectOption({ label: f.B.displayName });
  await expect(reason).toHaveCount(0);
  await expect(confirm.or(dialog.getByRole("button", { name: /Move and reassign appointment/ }))).toBeEnabled();
  await ctx.close();
});

test("EMERG-02 B (negative control): a capacity-ON studio CANNOT hold an unassigned confirmed appointment", async () => {
  const f = await capacityFixture();
  const apptId = await seedFutureAppointmentAt(f.seed.studioId, f.A.practitionerId, f.clientId, f.tz, "16:00");
  await attachService(apptId, f.serviceId);

  // `appointments.practitioner_id` is nullable (ON DELETE SET NULL), which is
  // why move-confirm-state does NOT gate its notice on a non-empty current id.
  // That branch is DEFENSIVE, and this is the proof: on a capacity-ON studio
  // `appointments_capacity_requires_practitioner` (0134) forbids the state for a
  // confirmed appointment — and reassignment is only ever enabled when capacity
  // is ON, so the branch cannot fire in production. Recorded here so a later
  // reader does not mistake it for dead code and delete it, and so that a
  // WEAKENING of the constraint shows up as a failure right next to the gate
  // that depends on it.
  await expect(
    sql(`update public.appointments set practitioner_id = null where id = $1`, [apptId]),
  ).rejects.toThrow(/appointments_capacity_requires_practitioner/);
});

test("EMERG-02 M: the prerequisite is legible and the flow usable on a 390x844 touch viewport", async ({
  browser,
}) => {
  const f = await capacityFixture();
  const apptId = await seedFutureAppointmentAt(f.seed.studioId, f.A.practitionerId, f.clientId, f.tz, "17:00");
  await attachService(apptId, f.serviceId);
  await removeEligibility(f.serviceId, f.A.practitionerId);

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await loginByMagicLink(page, f.seed.ownerEmail);
  const dialog = await openMoveDialog(page, apptId);
  await expect(dialog.getByLabel("Practitioner")).toBeVisible({ timeout: 20_000 });
  await fillCustom(dialog, futureYmd(413), "05:45");

  // The footer is a flex sibling of the scroll body, so the reason is painted
  // WITH the button rather than scrolled away above it — that adjacency is the
  // whole point of the fix on a small screen.
  const reason = dialog.getByTestId("confirm-disabled-reason");
  await expect(reason).toBeVisible();
  await expect(reason).toBeInViewport();
  const confirm = dialog.getByRole("button", { name: /^Move appointment$/ });
  await expect(confirm).toBeInViewport();
  await expect(confirm).toBeDisabled();
  await expectNoPageOverflow(page, "mobile custom-time prerequisite");

  // Recovering on mobile enables the same custom time.
  await dialog.getByLabel("Practitioner").selectOption({ label: f.B.displayName });
  await expect(reason).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Move and reassign appointment/ })).toBeEnabled();
  await expectNoPageOverflow(page, "mobile custom-time ready");
  await ctx.close();
});

test("EMERG-02 L: an appointment ALREADY outside published hours moves to another custom time", async ({ browser }) => {
  // Closest match to the real customer report: the appointment's CURRENT start
  // is outside ordinary availability (04:00, before the 06:00 open) and its
  // practitioner is healthy. Custom-time override must work end to end.
  const f = await capacityFixture();
  // 04:00 local, two hours before the 06:00 open, on a future date.
  const apptId = await seedLocalTimeOnFutureDate(f, 3, "04:00");
  await attachService(apptId, f.serviceId);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await loginByMagicLink(page, f.seed.ownerEmail);
  const dialog = await openMoveDialog(page, apptId);
  await expect(dialog.getByLabel("Practitioner")).toBeVisible({ timeout: 20_000 });
  await fillCustom(dialog, futureYmd(412), "05:15");

  const confirm = dialog.getByRole("button", { name: /^Move appointment$/ });
  await expect(dialog.getByTestId("confirm-disabled-reason")).toHaveCount(0);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });

  const rows = await sql<{ practitioner_id: string | null; starts_at: string }>(
    `select practitioner_id, starts_at from public.appointments where id = $1`,
    [apptId],
  );
  expect(rows).toHaveLength(1);
  // PRACTITIONER PRESERVED — a time-only custom move never reassigns.
  expect(rows[0].practitioner_id).toBe(f.A.practitionerId);
  await ctx.close();
});
});
