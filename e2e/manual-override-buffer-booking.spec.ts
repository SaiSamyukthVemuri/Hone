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

// THE FLOW CHANGED SHAPE, THE CAPABILITY DID NOT.
//
// There is no longer a standing "Book outside your normal availability" toggle.
// Smart suggestions were split from real availability, so the manual control is
// neutral ("Choose another time") and a time INSIDE working hours — which 14:30
// is — books normally with no override at all.
//
// The buffer is not an availability fact and cannot be decided from the window:
// only the database knows the gap around a neighbour. So the owner types the
// time and submits; the server refuses with `buffer_conflict`; the override is
// offered in response to THAT, and the re-submit carries the flag. Same
// capability, same owner-only gate, same audit consequence — the
// acknowledgement is now attached to a concrete stated reason instead of being
// a mode the practitioner had to enter up front.

// Open the form, choose a manual time, submit once. Does NOT assert the outcome.
async function submitManualTime(page: Page, clientId: string, localHHMM: string) {
  await page.goto(`/clients/${clientId}`);
  await page.getByRole("button", { name: /\+ Book appointment/i }).click();

  const chooseAnother = page.getByLabel(/Choose another time/i);
  await expect(chooseAnother).toBeVisible({ timeout: 20_000 });
  await chooseAnother.check();

  await page.locator('input[type="time"]').fill(localHHMM);
  // The window must have loaded before the manual path is submittable.
  await expect(page.getByText(/Checking your working hours/i)).toHaveCount(0, {
    timeout: 20_000,
  });
  const confirm = page.getByRole("button", { name: /^Confirm$/ });
  await expect(confirm).toBeEnabled({ timeout: 20_000 });
  await confirm.click();
}

// The owner-only buffer override, offered only after the DB refuses.
const bufferAck = (page: Page) =>
  page.getByRole("checkbox", { name: /Book it anyway/i });

async function acceptBufferOverride(page: Page) {
  await expect(bufferAck(page)).toBeVisible({ timeout: 20_000 });
  await bufferAck(page).check();
  await page.getByRole("button", { name: /^Book anyway$/ }).click();
}

test("owner override books a buffer-proximate time the suggested slots hide; actual overlap still rejected (desktop)", async ({
  page,
}) => {
  const { seed, clientId, neighbourId } = await seedBufferScenario();
  await loginByMagicLink(page, seed.ownerEmail);

  // 1) Buffer-proximate, non-overlapping override booking → SUCCESS. Before 0152
  //    this returned "That time is no longer available"; now it books, via the
  //    refusal-then-override handshake.
  await submitManualTime(page, clientId, PROXIMATE);
  await acceptBufferOverride(page);
  await page.waitForURL(/\/calendar\/[0-9a-f-]{36}/i, { timeout: 20_000 });

  const afterOne = await getAppointmentsForClient(seed.studioId, clientId);
  expect(afterOne, "neighbour + the new proximate booking").toHaveLength(2);
  const created = afterOne.find((a) => a.id !== neighbourId)!;
  const interval = (await getAppointmentInterval(created.id))!;
  expect(interval.status).toBe("confirmed");
  // The new booking ends exactly at the neighbour's start (touching, not overlapping).
  const neighbour = (await getAppointmentInterval(neighbourId))!;
  expect(new Date(interval.ends_at).getTime()).toBe(new Date(neighbour.starts_at).getTime());

  // 2) A TRULY overlapping time → HARD reject (safe copy, no new row), and NO
  //    override is offered for it. That asymmetry is the point: the soft buffer
  //    is overridable, an actual treatment collision never is. The stronger
  //    claim — that the flag cannot bypass an overlap even when it IS sent —
  //    is proven directly against Postgres in
  //    tests/db/capacity-off-working-hours-authority.db.test.ts
  //    ("REAL COLLISIONS ... are NOT bypassable"), which books with the flag
  //    true and still gets 23P01.
  await submitManualTime(page, clientId, OVERLAP);
  await expect(page.getByText(OVERLAP_COPY)).toBeVisible({ timeout: 20_000 });
  await expect(bufferAck(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/clients\//); // stayed on the form, no redirect
  const afterTwo = await getAppointmentsForClient(seed.studioId, clientId);
  expect(afterTwo, "overlap rejected — still only 2 appointments").toHaveLength(2);
});

test("a non-owner is refused the buffer override and told who can (owner-only)", async ({
  page,
}) => {
  // This used to assert the ABSENCE of a control named "Book outside your
  // normal availability". After the rename that name matches nothing for
  // anybody, so the assertion passed for free. It now drives the member into
  // the real buffer refusal and checks they get the explanation, not the
  // acknowledgement — which is a claim that can actually fail.
  const { seed, clientId } = await seedBufferScenario();
  const member = await seedE2eMember(seed);
  await loginByMagicLink(page, member.email);

  await submitManualTime(page, clientId, PROXIMATE);
  // Anchor on the AMBER PANEL's distinctive sentence. "within the buffer around
  // another appointment" alone matches twice — the red error banner carries the
  // server's copy and the panel restates it — which is a strict-mode violation,
  // not a product problem.
  await expect(page.getByText(/It does not overlap one/i)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/Only the studio owner can book inside the buffer/i)).toBeVisible();
  await expect(bufferAck(page)).toHaveCount(0);

  // And nothing was written.
  const appts = await getAppointmentsForClient(seed.studioId, clientId);
  expect(appts, "only the seeded neighbour").toHaveLength(1);
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

    await submitManualTime(page, clientId, PROXIMATE);
    await acceptBufferOverride(page);
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
