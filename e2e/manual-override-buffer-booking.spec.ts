import { test, expect, type Browser, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClient,
  seedE2eMember,
  setStudioBufferMinutes,
  seedFutureAppointmentAt,
  getOwnerPractitionerId,
  getStudioTimezone,
  getAppointmentsForClient,
  getAppointmentInterval,
  type E2eSeed,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";

// Migration 0152 — Chloe's manual-override booking blocker, end-to-end through
// the REAL client-profile booking UI against the LOCAL stack.
//
// The bug: a practitioner could tick "Book outside your normal availability" and
// type a time that sits inside the studio buffer next to an existing appointment
// (but does NOT actually overlap it), yet submission returned "That time is no
// longer available." The buffer was a HARD, buffer-EXPANDED GiST exclusion, so
// the owner override (which bypasses only working hours) could never reach it.
//
// After 0152 the buffer is a SOFT constraint the owner override bypasses, while
// ACTUAL treatment overlap stays a HARD constraint that the override can NEVER
// bypass. This spec proves both, at desktop and at Chloe's iPhone viewport:
//
//   * A buffer-proximate, non-overlapping override booking SUCCEEDS. (Such a time
//     is deliberately absent from the suggested slots — the buffer filters it —
//     so the manual override is the only way to reach it. Exactly Chloe's flow.)
//   * A truly overlapping override booking is STILL rejected (hard 23P01 → safe
//     copy), so the override never lets two treatments collide.
//   * A non-owner never sees the override control at all (owner-only).
//
// Studio is capacity-OFF (studio-wide) — Chloe's single-chair setup. Buffer 30.
// The seeded neighbour is 60 min (seedFutureAppointmentAt) at 15:00 → 15:00–16:00;
// the booking service is 30 min (seedE2eStudio). 14:30–15:00 touches the
// neighbour's start (no overlap) but is inside the 30-min buffer; 15:30–16:00
// truly overlaps it.

test.describe.configure({ mode: "serial" });

const NEIGHBOUR = "15:00"; // existing 60-min appointment 15:00–16:00
const PROXIMATE = "14:30"; // 14:30–15:00 (30-min svc): inside the buffer, NOT overlapping → override succeeds
const OVERLAP = "15:30"; //  15:30–16:00 (30-min svc): truly overlaps the neighbour → hard reject even with override

// The safe copy the internal booking action returns when the hard actual-overlap
// exclusion (23P01) fires — never a raw SQLSTATE.
const OVERLAP_COPY = /That time is no longer available/i;

async function expectNoPageOverflow(page: Page, label: string) {
  const w = await page.evaluate(() => ({
    s: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  expect(w.s, `${label}: no horizontal overflow (${w.s} vs ${w.c})`).toBeLessThanOrEqual(w.c);
}

// Seed a capacity-OFF studio with a 30-min buffer and a 15:00 neighbour on the
// owner. Returns the identifiers the flow needs.
async function seedBufferScenario(): Promise<{
  seed: E2eSeed;
  clientId: string;
  neighbourId: string;
}> {
  const seed = await seedE2eStudio();
  await setStudioBufferMinutes(seed.studioId, 30);
  const { clientId } = await seedE2eClient(seed);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const tz = await getStudioTimezone(seed.studioId);
  const neighbourId = await seedFutureAppointmentAt(seed.studioId, ownerId, clientId, tz, NEIGHBOUR);
  return { seed, clientId, neighbourId };
}

// Drive the owner override booking form: open, tick the override, type the local
// time, confirm the acknowledgement, submit. Does NOT assert the outcome.
async function submitOverrideBooking(page: Page, clientId: string, localHHMM: string) {
  await page.goto(`/clients/${clientId}`);
  await page.getByRole("button", { name: /\+ Book appointment/i }).click();

  const overrideToggle = page.getByRole("checkbox", {
    name: /Book outside your normal availability/i,
  });
  await expect(overrideToggle).toBeVisible({ timeout: 20_000 });
  await overrideToggle.check();

  await page.locator('input[type="time"]').fill(localHHMM);
  await page
    .getByRole("checkbox", { name: /I confirm I want to book this out-of-hours time/i })
    .check();

  await page.getByRole("button", { name: /^Book out-of-hours$/ }).click();
}

test("owner override books a buffer-proximate time the suggested slots hide; actual overlap still rejected (desktop)", async ({
  page,
}) => {
  const { seed, clientId, neighbourId } = await seedBufferScenario();
  await loginByMagicLink(page, seed.ownerEmail);

  // 1) Buffer-proximate, non-overlapping override booking → SUCCESS. Before 0152
  //    this returned "That time is no longer available"; now it books.
  await submitOverrideBooking(page, clientId, PROXIMATE);
  await page.waitForURL(/\/calendar\/[0-9a-f-]{36}/i, { timeout: 20_000 });

  const afterOne = await getAppointmentsForClient(seed.studioId, clientId);
  expect(afterOne, "neighbour + the new proximate booking").toHaveLength(2);
  const created = afterOne.find((a) => a.id !== neighbourId)!;
  const interval = (await getAppointmentInterval(created.id))!;
  expect(interval.status).toBe("confirmed");
  // The new booking ends exactly at the neighbour's start (touching, not overlapping).
  const neighbour = (await getAppointmentInterval(neighbourId))!;
  expect(new Date(interval.ends_at).getTime()).toBe(new Date(neighbour.starts_at).getTime());

  // 2) A TRULY overlapping override booking → HARD reject (safe copy, no new row).
  await submitOverrideBooking(page, clientId, OVERLAP);
  await expect(page.getByText(OVERLAP_COPY)).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/clients\//); // stayed on the form, no redirect
  const afterTwo = await getAppointmentsForClient(seed.studioId, clientId);
  expect(afterTwo, "overlap rejected — still only 2 appointments").toHaveLength(2);
});

test("non-owner never sees the override control (owner-only)", async ({ page }) => {
  const { seed, clientId } = await seedBufferScenario();
  const member = await seedE2eMember(seed);
  await loginByMagicLink(page, member.email);
  await page.goto(`/clients/${clientId}`);
  await page.getByRole("button", { name: /\+ Book appointment/i }).click();
  await expect(
    page.getByRole("checkbox", { name: /Book outside your normal availability/i }),
  ).toHaveCount(0);
});

test("same override flow completes on an iPhone viewport (Chloe's workflow)", async ({
  browser,
}: {
  browser: Browser;
}) => {
  const { seed, clientId, neighbourId } = await seedBufferScenario();

  // iPhone 13 dimensions + touch (the profile Chloe reported the bug on). The
  // repo's mobile E2E note documents why the Chromium engine at iPhone size is
  // the harness-appropriate stand-in for iOS Safari here.
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  try {
    const page = await ctx.newPage();
    await loginByMagicLink(page, seed.ownerEmail);

    await submitOverrideBooking(page, clientId, PROXIMATE);
    await page.waitForURL(/\/calendar\/[0-9a-f-]{36}/i, { timeout: 20_000 });

    const appts = await getAppointmentsForClient(seed.studioId, clientId);
    expect(appts, "neighbour + the new proximate booking").toHaveLength(2);
    const created = appts.find((a) => a.id !== neighbourId)!;
    expect((await getAppointmentInterval(created.id))!.status).toBe("confirmed");

    await expectNoPageOverflow(page, "iPhone booking → calendar");
  } finally {
    await ctx.close();
  }
});
