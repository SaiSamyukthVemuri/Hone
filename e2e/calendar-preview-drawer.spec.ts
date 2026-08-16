import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClient,
  seedE2eClientWithPreviousAreas,
  seedE2eIntake,
  seedFutureAppointmentAt,
  seedConfirmedAppointment,
  getStudioTimezone,
  getOwnerPractitionerId,
  sql,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// The calendar appointment drawer as a PREP WORKSPACE.
//
// Runtime proof for the properties source greps cannot see: that the drawer
// opens without leaving /calendar, that it shows a returning client's last
// treatment, that intake links to the AUTHENTICATED practitioner route, that
// lifecycle actions appear only when the server would honour them, and that
// switching appointments never leaves the previous one's prep on screen.
//
// See the long comment above the switching test for what that last one does
// and does NOT establish — the response-ordering half is proved in
// tests/app/calendar/preview-request.test.ts, not here.
//
// The week grid is desktop-only (`hidden md:block`), so every test here runs at
// a desktop viewport; the default Desktop Chrome project already provides one.

const T = 20_000;

async function openWeek(page: Page): Promise<void> {
  await page.goto("/calendar?view=week");
  // The step nav renders as LINKS, not buttons, and is `hidden md:flex` — so
  // this also confirms we are on the desktop week grid, not the mobile view.
  await expect(page.getByRole("link", { name: "Today" }).first()).toBeVisible({
    timeout: T,
  });
}

// The week grid renders one card per appointment; the accessible name carries
// the client name.
function card(page: Page, clientName: string) {
  return page
    .locator("button")
    .filter({ hasText: clientName })
    .first();
}

// A GUARANTEED-future appointment, plus the day it landed on.
//
// `seedFutureAppointmentAt` is named for intent, not for what it does: it seeds
// TODAY at a fixed local hour, so whether the row is still in the future depends
// on what time of day the suite happens to run. That is invisible for a test
// that only reads prep, but Cancel and Reschedule are gated on
// `starts_at > now()` TWICE — once by isAppointmentCancelable in the browser and
// again by practitioner_cancel_appointment's terminal-safe guard — so a test
// that asserts those controls seeded at 17:00 passes all morning and fails
// after 17:00 studio-local.
//
// Seeding a week out removes the clock from the test entirely. The week grid
// renders whatever week it is pointed at, so `openWeekOf` navigates there:
// page.tsx resolves `?day=` to the week containing that date.
async function seedAppointmentNextWeek(
  studioId: string,
  practitionerId: string,
  clientId: string,
  tz: string,
  localHHMM: string,
  // The TIMESTAMP span only. seedConfirmedAppointment always stores
  // duration_minutes = 60, so passing anything else here produces a row whose
  // span and stored duration disagree — which the schema permits (0010 gives
  // duration_minutes only a 5..480 range check and says nothing about the span).
  spanMinutes = 60,
): Promise<{ id: string; date: string }> {
  const rows = await sql<{ startu: string; endu: string; d: string }>(
    `select (to_char((now() at time zone $1)::date + 7, 'YYYY-MM-DD') || ' ' || $2)::timestamp at time zone $1 as startu,
            ((to_char((now() at time zone $1)::date + 7, 'YYYY-MM-DD') || ' ' || $2)::timestamp + ($3 || ' min')::interval) at time zone $1 as endu,
            to_char((now() at time zone $1)::date + 7, 'YYYY-MM-DD') as d`,
    [tz, localHHMM, String(spanMinutes)],
  );
  const id = await seedConfirmedAppointment(
    studioId,
    practitionerId,
    clientId,
    new Date(rows[0].startu).toISOString(),
    new Date(rows[0].endu).toISOString(),
  );
  return { id, date: rows[0].d };
}

async function openWeekOf(page: Page, date: string): Promise<void> {
  await page.goto(`/calendar?view=week&day=${date}`);
  await expect(page.getByRole("link", { name: "Today" }).first()).toBeVisible({
    timeout: T,
  });
}

function drawer(page: Page) {
  return page.getByRole("dialog", { name: "Appointment preview" });
}

test("drawer opens in place, shows prep, and never leaves /calendar", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClientWithPreviousAreas(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const apptId = await seedFutureAppointmentAt(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "14:00",
  );
  await seedE2eIntake(seed.studioId, clientId, "submitted");

  await loginAsOwner(page, seed);
  await openWeek(page);

  const clientName = await clientNameOf(apptId);
  await card(page, clientName).click();

  const d = drawer(page);
  await expect(d).toBeVisible({ timeout: T });

  // 2. URL stays on /calendar — the drawer is not a navigation.
  expect(new URL(page.url()).pathname).toBe("/calendar");

  // 4. Summary: client / time / service / status.
  await expect(d.getByRole("heading", { name: clientName })).toBeVisible();
  await expect(d.getByText("Time")).toBeVisible();
  await expect(d.getByText("Status")).toBeVisible();

  // 5. Last treatment for a returning client. The seeded client has a CHARTED
  //    Jan session and a NEWER EMPTY June session; the canonical authority must
  //    skip the empty one, so seeing the January visit is also proof the naive
  //    "newest session" rule is not in play (NC1).
  await expect(d.getByTestId("today-memory-compact")).toBeVisible({ timeout: T });
  await expect(d.getByTestId("today-memory-compact")).toContainText("Jan");

  // 6. Appointment notes are present as a real editable surface.
  await expect(d.getByRole("heading", { name: "Appointment notes" })).toBeVisible();

  // 7. A submitted intake offers a real Review intake control pointing at the
  //    AUTHENTICATED route — never the client's /intake/<token> page (NC4).
  const review = d.getByTestId("preview-review-intake");
  await expect(review).toBeVisible();
  await expect(review).toHaveAttribute("href", `/clients/${clientId}/intake`);
  expect(await review.getAttribute("href")).not.toMatch(/^\/intake\//);

  // 12. Escape closes.
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
});

test("a reviewed intake offers View intake, still on the authenticated route", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const apptId = await seedFutureAppointmentAt(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "15:00",
  );
  await seedE2eIntake(seed.studioId, clientId, "reviewed");

  await loginAsOwner(page, seed);
  await openWeek(page);
  await card(page, await clientNameOf(apptId)).click();

  const d = drawer(page);
  const view = d.getByTestId("preview-view-intake");
  await expect(view).toBeVisible({ timeout: T });
  await expect(view).toHaveAttribute("href", `/clients/${clientId}/intake`);
  // The submitted-state control must NOT also be present.
  await expect(d.getByTestId("preview-review-intake")).toHaveCount(0);
});

test("an in-progress intake is stated but never presented as reviewable", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const apptId = await seedFutureAppointmentAt(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "16:00",
  );
  await seedE2eIntake(seed.studioId, clientId, "in_progress");

  await loginAsOwner(page, seed);
  await openWeek(page);
  await card(page, await clientNameOf(apptId)).click();

  const d = drawer(page);
  await expect(d.getByText("Started, not yet submitted.")).toBeVisible({ timeout: T });
  await expect(d.getByTestId("preview-review-intake")).toHaveCount(0);
  await expect(d.getByTestId("preview-view-intake")).toHaveCount(0);
});

test("Reschedule opens the shared move dialog; Cancel is offered on a future confirmed booking", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const { id: apptId, date } = await seedAppointmentNextWeek(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "17:00",
  );

  await loginAsOwner(page, seed);
  await openWeekOf(page, date);
  await card(page, await clientNameOf(apptId)).click();

  const d = drawer(page);
  // 10. Cancel is present because this booking is genuinely cancelable.
  await expect(d.getByRole("button", { name: "Cancel appointment" })).toBeVisible({
    timeout: T,
  });

  // 9. Reschedule mounts the SHARED dialog, relabelled through its `label`
  //    prop — the dialog keeps its own "Move appointment" identity.
  await d.getByRole("button", { name: "Reschedule" }).click();
  await expect(page.getByRole("dialog", { name: "Move appointment" })).toBeVisible({
    timeout: T,
  });
});

test("a completed appointment offers neither Cancel nor Reschedule", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const apptId = await seedFutureAppointmentAt(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "18:00",
  );
  // Drive the row terminal. The server refuses cancellation from here, so the
  // UI must not offer it (NC3).
  await setStatus(apptId, "completed");

  await loginAsOwner(page, seed);
  await openWeek(page);
  await card(page, await clientNameOf(apptId)).click();

  const d = drawer(page);
  // The prep sections still load — this is about ACTIONS, not content.
  await expect(d.getByRole("heading", { name: "Appointment notes" })).toBeVisible({
    timeout: T,
  });
  await expect(d.getByRole("button", { name: "Cancel appointment" })).toHaveCount(0);
  await expect(d.getByRole("button", { name: "Reschedule" })).toHaveCount(0);
  // 11. The escape hatch still works.
  await expect(d.getByRole("link", { name: "Open full details" })).toBeVisible();
});

// Switching appointments must never leave the previous one's prep on screen.
//
// WHAT THIS PROVES, HONESTLY. This is a behavioural REGRESSION assertion, not a
// mutation-detected proof, and it is labelled that way because it was measured:
// no single mutation to the drawer turns it red. Three separate mechanisms have
// to fail together, and the architecture prevents that today.
//
//   * Removing the switch-time clear does not flip it — closing the drawer
//     already clears the cached detail on its own.
//   * Removing BOTH clears does not flip it — the response guard then rejects
//     appointment A's superseded payload (issued seq 1, current seq 3).
//   * Removing the GUARD does not flip it either — Next.js serializes
//     server-action requests, so B is not dispatched until A settles and B
//     therefore always resolves LAST, correcting the state. Measured while
//     deliberately delaying A: A's response at 663ms, B's at 4971ms. Delaying
//     at the Playwright route layer is worse still: route handlers dispatch
//     serially, so holding A holds B behind it.
//
// So the ordering guard is defence in depth against a Next.js implementation
// detail that is not a documented contract, and its LOGIC is proved directly in
// tests/app/calendar/preview-request.test.ts. This test is kept because it goes
// live the moment that architecture changes — move the load to a route handler
// and real concurrency appears — and because the end-state it asserts is the
// thing a practitioner would actually see go wrong.
test("switching from A to B ends on B's data, never A's", async ({ page }) => {
  const seed = await seedE2eStudio();
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);

  // A: a returning client with charted history and a submitted intake.
  // B: a brand-new client with neither. Any A content under B is unmistakable.
  const { clientId: clientA } = await seedE2eClientWithPreviousAreas(seed);
  const { clientId: clientB } = await seedE2eClient(seed);
  const apptA = await seedFutureAppointmentAt(seed.studioId, ownerId, clientA, tz, "09:00");
  const apptB = await seedFutureAppointmentAt(seed.studioId, ownerId, clientB, tz, "10:00");
  await seedE2eIntake(seed.studioId, clientA, "submitted");

  await loginAsOwner(page, seed);
  await openWeek(page);

  const nameA = await clientNameOf(apptA);
  const nameB = await clientNameOf(apptB);

  // Open A and let its prep arrive, so there is genuinely something cached to
  // leak before switching away.
  await card(page, nameA).click();
  const dA = drawer(page);
  await expect(dA.getByTestId("today-memory-compact")).toBeVisible({ timeout: T });

  // Switch to B as fast as the UI allows.
  await page.keyboard.press("Escape");
  await card(page, nameB).click();

  const dB = drawer(page);
  await expect(dB.getByRole("heading", { name: nameB })).toBeVisible({ timeout: T });
  await expect(dB.getByText("No previous treatment charted for this client.")).toBeVisible({
    timeout: T,
  });

  // None of A's clinical content is present under B's name.
  await expect(dB.getByTestId("today-memory-compact")).toHaveCount(0);
  await expect(dB.getByTestId("preview-review-intake")).toHaveCount(0);
  await expect(dB.getByRole("heading", { name: nameA })).toHaveCount(0);
});

test("opening the week issues no per-appointment detail load", async ({ page }) => {
  const seed = await seedE2eStudio();
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  for (const hhmm of ["09:00", "10:00", "11:00", "12:00"]) {
    const { clientId } = await seedE2eClient(seed);
    await seedFutureAppointmentAt(seed.studioId, ownerId, clientId, tz, hhmm);
  }

  await loginAsOwner(page, seed);

  // Count server-action POSTs to the calendar route during the initial render.
  let actionPosts = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/calendar") {
      actionPosts += 1;
    }
  });

  await openWeek(page);
  await page.waitForTimeout(2000);

  // Four appointments on screen, ZERO detail loads. The drawer's load is
  // click-triggered; the grid pays nothing.
  expect(actionPosts).toBe(0);
});

// Cancelling from the drawer must BE the governed cancellation, not a
// drawer-local write that happens to reach the same status.
//
// Status alone would not prove that: a parallel `update appointments set
// status='cancelled'` sets it too. The facts asserted below are the ones only
// practitioner_cancel_appointment produces, and it produces them in ONE
// transaction — the audit row with actor_type='practitioner', the actor id
// resolved server-side, and `source: practitioner_action`. A second cancel path
// would have to reimplement all of it to pass this.
test("Cancel writes through the governed command, with audit and attribution", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const { id: apptId, date } = await seedAppointmentNextWeek(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "13:00",
  );

  await loginAsOwner(page, seed);
  await openWeekOf(page, date);
  await card(page, await clientNameOf(apptId)).click();

  const d = drawer(page);
  const cancel = d.getByRole("button", { name: "Cancel appointment" });
  await expect(cancel).toBeVisible({ timeout: T });

  // The reason typed here must reach the command's p_reason, not be dropped by
  // a drawer that only knows how to flip a status.
  await d.getByPlaceholder("Reason (optional)").fill("Client rescheduled by phone");
  await cancel.click();

  // onCancelled dismisses the drawer: its summary is stale the moment the row
  // goes terminal, and leaving it open would keep offering refused actions.
  await expect(d).toHaveCount(0, { timeout: T });

  await expect
    .poll(async () => (await cancellationOf(apptId)).status, { timeout: T })
    .toBe("cancelled");

  const row = await cancellationOf(apptId);
  expect(row.cancellation_reason).toBe("Client rescheduled by phone");
  expect(row.cancelled_at).not.toBeNull();
  // Attribution is read from the live practitioner row by the RPC, never taken
  // from the browser.
  expect(row.cancelled_by).toBe("owner");

  const audit = await cancelAuditOf(apptId);
  expect(audit.length).toBe(1);
  expect(audit[0].actor_type).toBe("practitioner");
  expect(audit[0].actor_id).toBe(ownerId);
  expect(audit[0].source).toBe("practitioner_action");
});

// Closing and reopening must not leave the calendar or the drawer in a stale
// state. The drawer is ONE instance serving every card in its column, so the
// second open is the one that would show the first appointment's prep if the
// lazy load were not re-keyed on close.
test("closing and reopening leaves the calendar and the drawer truthful", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const { clientId: clientA } = await seedE2eClientWithPreviousAreas(seed);
  const { clientId: clientB } = await seedE2eClient(seed);
  const apptA = await seedFutureAppointmentAt(seed.studioId, ownerId, clientA, tz, "09:00");
  const apptB = await seedFutureAppointmentAt(seed.studioId, ownerId, clientB, tz, "10:00");

  await loginAsOwner(page, seed);
  await openWeek(page);
  const nameA = await clientNameOf(apptA);
  const nameB = await clientNameOf(apptB);

  // Open A, close it, open B, close it, then come back to A.
  await card(page, nameA).click();
  await expect(drawer(page).getByTestId("today-memory-compact")).toBeVisible({ timeout: T });
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);

  await card(page, nameB).click();
  await expect(drawer(page).getByRole("heading", { name: nameB })).toBeVisible({ timeout: T });
  await expect(drawer(page).getByTestId("today-memory-compact")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);

  // Reopening A re-loads A's prep rather than serving B's emptiness from the
  // previous open, and the grid never navigated away.
  await card(page, nameA).click();
  const dA = drawer(page);
  await expect(dA.getByRole("heading", { name: nameA })).toBeVisible({ timeout: T });
  await expect(dA.getByTestId("today-memory-compact")).toBeVisible({ timeout: T });
  expect(new URL(page.url()).pathname).toBe("/calendar");

  // The week grid underneath is still live: both cards are still there.
  await page.keyboard.press("Escape");
  await expect(card(page, nameA)).toBeVisible();
  await expect(card(page, nameB)).toBeVisible();
});

// MOBILE. The drawer is desktop-only BY CONSTRUCTION — DayColumn (which mounts
// it) lives inside `hidden md:block`, and the mobile day view PR #380 owns small
// screens, where an appointment taps through to the full detail page instead.
//
// This test exists so that stays a DECISION rather than an accident: it proves
// this branch did not quietly attach a desktop drawer to the mobile hierarchy,
// where a `max-w-md` overlay would sit on top of the day timeline and take the
// practitioner's primary navigation with it.
test.describe("mobile width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("an appointment still opens the full detail page, not the drawer", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eClient(seed);
    const tz = await getStudioTimezone(seed.studioId);
    const ownerId = await getOwnerPractitionerId(seed.studioId);
    const apptId = await seedFutureAppointmentAt(
      seed.studioId,
      ownerId,
      clientId,
      tz,
      "14:00",
    );

    await loginAsOwner(page, seed);
    await page.goto("/calendar?view=week");

    // The mobile day view owns this width: its Today control is a BUTTON, and
    // it is the one that is visible here (the desktop step nav is hidden md:flex).
    //
    // `exact` is load-bearing. Playwright matches an accessible name as a
    // case-insensitive SUBSTRING unless told otherwise, and the week strip's
    // selected pill is labelled "Today, Sun 16, selected" — so the non-exact
    // form resolves to two buttons and fails on strict mode rather than on the
    // thing under test.
    await expect(
      page.getByRole("button", { name: "Today", exact: true }),
    ).toBeVisible({ timeout: T });

    const clientName = await clientNameOf(apptId);
    await page.getByRole("link").filter({ hasText: clientName }).first().click();

    await expect(page).toHaveURL(new RegExp(`/calendar/${apptId}`), { timeout: T });
    // The drawer never opened; the practitioner got the full record.
    await expect(drawer(page)).toHaveCount(0);
  });
});

// Reschedule must trust the drawer's REFRESHED schedule, not the week grid's
// copy of it.
//
// THE BUG THIS PINS. The week payload is rendered once and then sits on screen.
// If the appointment moves elsewhere — another tab, another practitioner, a drag
// on another device — that payload is stale. The drawer re-reads the appointment
// when it opens and already uses the fresh row for its action gate, so Cancel
// and Reschedule correctly appear or disappear. But the move dialog was handed
// the STALE `starts_at`/`ends_at` off the grid, and those are not decoration:
// they become p_expected_starts_at / p_expected_ends_at, and 0133 refuses any
// drift with `stale_appointment`.
//
// The result was a drawer that had just read the truth and then argued with it —
// and because the props never change while the drawer is open, every retry
// failed the same way. The practitioner's only escape was a full reload.
//
// This test stages exactly that: the grid holds 13:00, the row moves to 14:00
// underneath it, and the practitioner then reschedules from the drawer. It fails
// against the pre-fix head (the move is refused as stale) and passes after.
test("Reschedule uses the refreshed schedule, not the stale week-grid copy", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const { id: apptId, date } = await seedAppointmentNextWeek(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "13:00",
  );

  await loginAsOwner(page, seed);
  // The grid now holds 13:00 and will not learn otherwise on its own.
  await openWeekOf(page, date);

  // The appointment moves out from under the rendered grid. Assert the stage is
  // actually set: without this the test could pass for the boring reason that
  // nothing ever diverged.
  await shiftAppointmentMinutes(apptId, 60);
  expect((await localDateTimeOf(apptId, tz)).time).toBe("14:00");

  await card(page, await clientNameOf(apptId)).click();
  const d = drawer(page);
  await expect(d).toBeVisible({ timeout: T });

  // The drawer has re-read the row, so Reschedule is offered on the FRESH state.
  const reschedule = d.getByRole("button", { name: "Reschedule" });
  await expect(reschedule).toBeVisible({ timeout: T });
  await reschedule.click();

  const dlg = page.getByRole("dialog", { name: "Move appointment" });
  await expect(dlg).toBeVisible({ timeout: T });

  // Owner-only custom time, so the target does not depend on generated slots.
  await dlg.getByRole("button", { name: "Custom time" }).click();
  const target = futureYmd(30);
  await dlg.locator('input[type="date"]').fill(target);
  await dlg.locator('input[type="time"]').fill("10:00");
  await dlg.getByRole("checkbox").check();

  const confirm = dlg.getByRole("button", { name: /^Move appointment$/ });
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // The move is ACCEPTED. Pre-fix this dialog stays open with the 0133
  // stale-appointment refusal, because the expected values describe 13:00 while
  // the row says 14:00.
  await expect(dlg).toHaveCount(0, { timeout: T });

  // And it really moved — to the requested target, not back to either the stale
  // grid time or the intermediate 14:00.
  const row = await cancellationOf(apptId);
  expect(row.status).toBe("confirmed");
  const finalLocal = await localDateTimeOf(apptId, tz);
  expect(finalLocal.date).toBe(target);
  expect(finalLocal.time).toBe("10:00");
});

// The dialog must state the STORED duration, and the command must honour it.
//
// `duration_minutes` and `ends_at - starts_at` are different facts. The schema
// keeps them independent (0010 range-checks the column and says nothing about
// the span), and 0133 preserves the stored column while computing the new end
// from it, never trusting a caller-supplied end. So on a row where they
// disagree, a drawer that reconstructs the duration from the span announces a
// number the command has already decided to ignore.
//
// This seeds exactly that row — a 90 minute span with a stored duration of 60 —
// and pins both halves: what the dialog SAYS before the move, and what the
// command DOES to the row.
test("Reschedule states the stored duration, and the move preserves it", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  // 13:00 -> 14:30 on the clock, but duration_minutes stays 60.
  const { id: apptId, date } = await seedAppointmentNextWeek(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "13:00",
    90,
  );

  // The mismatch is the whole premise, so assert it rather than assume the
  // seeding helper produced it.
  const before = await scheduleFactsOf(apptId);
  expect(before.durationMinutes).toBe(60);
  expect(before.spanMinutes).toBe(90);

  await loginAsOwner(page, seed);
  await openWeekOf(page, date);
  await card(page, await clientNameOf(apptId)).click();

  const d = drawer(page);
  await expect(d).toBeVisible({ timeout: T });

  // The DRAWER SUMMARY states the stored duration too, not the 90 minute span a
  // reconstruction would produce. Display, dialog copy and command all agree.
  await expect(d).toContainText("· 60m", { timeout: T });
  await expect(d).not.toContainText("· 90m");

  await d.getByRole("button", { name: "Reschedule" }).click();

  const dlg = page.getByRole("dialog", { name: "Move appointment" });
  await expect(dlg).toBeVisible({ timeout: T });
  await dlg.getByRole("button", { name: "Custom time" }).click();
  const target = futureYmd(31);
  await dlg.locator('input[type="date"]').fill(target);
  await dlg.locator('input[type="time"]').fill("11:00");

  // WHAT IT SAYS. 60 is the stored fact; 90 is the span a reconstruction would
  // have produced, and it must appear nowhere.
  await expect(dlg.getByText("Duration unchanged: 60 min")).toBeVisible({ timeout: T });
  await expect(dlg.getByText("Duration unchanged: 90 min")).toHaveCount(0);

  await dlg.getByRole("checkbox").check();
  await dlg.getByRole("button", { name: /^Move appointment$/ }).click();
  await expect(dlg).toHaveCount(0, { timeout: T });

  // WHAT IT DOES. 0133 rebuilt ends_at from the stored 60, so the moved row is
  // 60 minutes long — the number the dialog promised, not the 90 it displaced.
  const after = await scheduleFactsOf(apptId);
  expect(after.durationMinutes).toBe(60);
  expect(after.spanMinutes).toBe(60);
  const moved = await localDateTimeOf(apptId, tz);
  expect(moved.date).toBe(target);
  expect(moved.time).toBe("11:00");
});

// TEST A. A cancellation in another window must be SAID, not merely obeyed.
//
// The grid is rendered while the booking is active and then sits there; the
// calendar filters cancelled rows out upstream, so only the drawer's own re-read
// can ever bring a `cancelled` status into this surface. The branch already
// gated the actions on that fresh status — Cancel and Reschedule disappear —
// but the label chain had no cancelled arm and fell through to "Upcoming". The
// drawer therefore refused to act on a booking it was still calling upcoming.
test("a cancellation in another window reads as Cancelled, never Upcoming", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const { id: apptId, date } = await seedAppointmentNextWeek(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "13:00",
  );

  await loginAsOwner(page, seed);
  // The grid renders it as a live, confirmed booking.
  await openWeekOf(page, date);

  // Another window cancels it.
  await cancelAppointmentRow(apptId);
  expect((await cancellationOf(apptId)).status).toBe("cancelled");

  await card(page, await clientNameOf(apptId)).click();
  const d = drawer(page);
  await expect(d).toBeVisible({ timeout: T });

  // What it SAYS matches what it DOES.
  await expect(d.getByText("Cancelled")).toBeVisible({ timeout: T });
  await expect(d.getByText("Upcoming")).toHaveCount(0);
  await expect(d.getByRole("button", { name: "Cancel appointment" })).toHaveCount(0);
  await expect(d.getByRole("button", { name: "Reschedule" })).toHaveCount(0);
  // The escape hatch to the full record stays.
  await expect(d.getByRole("link", { name: "Open full details" })).toBeVisible();
});

// TEST B. The visible summary and the Reschedule dialog must describe the SAME
// appointment.
//
// The drawer re-reads the row and used that fresh copy for the status line, the
// action gate and (after the previous repair) the move payload — while still
// formatting the date, time and duration from the week grid. So a booking moved
// in another window displayed its old time beside its new status, and Reschedule
// opened on a third answer.
//
// The studio is pinned to 24h here so the assertion is an exact clock string
// rather than a locale-formatted one ("2:00 PM" can carry a narrow no-break
// space, which is not what this test is about).
test("the summary shows the refreshed schedule, and Reschedule agrees with it", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const tz = await getStudioTimezone(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  await setStudioTimeFormat(seed.studioId, "24h");
  const { id: apptId, date } = await seedAppointmentNextWeek(
    seed.studioId,
    ownerId,
    clientId,
    tz,
    "13:00",
  );

  await loginAsOwner(page, seed);
  // The grid holds 13:00–14:00.
  await openWeekOf(page, date);

  // It moves to 14:00–15:00 underneath the rendered grid.
  await shiftAppointmentMinutes(apptId, 60);
  expect((await localDateTimeOf(apptId, tz)).time).toBe("14:00");

  await card(page, await clientNameOf(apptId)).click();
  const d = drawer(page);
  await expect(d).toBeVisible({ timeout: T });

  // The summary describes the row as it is now, not as the grid remembers it.
  await expect(d).toContainText("14:00", { timeout: T });
  await expect(d).not.toContainText("13:00");

  // And Reschedule opens on the same appointment the summary just described.
  await d.getByRole("button", { name: "Reschedule" }).click();
  const dlg = page.getByRole("dialog", { name: "Move appointment" });
  await expect(dlg).toBeVisible({ timeout: T });
  await expect(dlg).toContainText("14:00");
  await expect(dlg).not.toContainText("13:00");
});

// --- helpers ---------------------------------------------------------------

async function clientNameOf(appointmentId: string): Promise<string> {
  const rows = await sql<{ name: string }>(
    `select c.name from public.appointments a
       join public.clients c on c.id = a.client_id
      where a.id = $1`,
    [appointmentId],
  );
  return rows[0].name;
}

// Move the row out from under an already-rendered grid, the way another tab or
// another practitioner would. Returns the new starts_at.
async function shiftAppointmentMinutes(
  appointmentId: string,
  minutes: number,
): Promise<string> {
  const rows = await sql<{ starts_at: string }>(
    `update public.appointments
        set starts_at = starts_at + ($2 || ' minutes')::interval,
            ends_at   = ends_at   + ($2 || ' minutes')::interval,
            blocked_ends_at = blocked_ends_at + ($2 || ' minutes')::interval
      where id = $1
      returning starts_at`,
    [appointmentId, String(minutes)],
  );
  return rows[0].starts_at;
}

// Cancel the row directly, the way another window's cancellation would leave it.
async function cancelAppointmentRow(appointmentId: string): Promise<void> {
  await sql(
    `update public.appointments
        set status = 'cancelled', cancelled_at = now()
      where id = $1`,
    [appointmentId],
  );
}

async function setStudioTimeFormat(studioId: string, format: "12h" | "24h"): Promise<void> {
  await sql(`update public.studios set time_format_preference = $2 where id = $1`, [
    studioId,
    format,
  ]);
}

// The two schedule facts, read separately so a test can prove they disagree.
async function scheduleFactsOf(
  appointmentId: string,
): Promise<{ durationMinutes: number; spanMinutes: number }> {
  const rows = await sql<{ dur: number; span: number }>(
    `select duration_minutes as dur,
            (extract(epoch from (ends_at - starts_at)) / 60)::int as span
       from public.appointments where id = $1`,
    [appointmentId],
  );
  return { durationMinutes: Number(rows[0].dur), spanMinutes: Number(rows[0].span) };
}

// The appointment's start as the STUDIO sees it, so the assertion is not written
// in whatever timezone the runner happens to have.
async function localDateTimeOf(
  appointmentId: string,
  tz: string,
): Promise<{ date: string; time: string }> {
  const rows = await sql<{ d: string; t: string }>(
    `select to_char(starts_at at time zone $2, 'YYYY-MM-DD') as d,
            to_char(starts_at at time zone $2, 'HH24:MI')    as t
       from public.appointments where id = $1`,
    [appointmentId, tz],
  );
  return { date: rows[0].d, time: rows[0].t };
}

// A real future date derived from the clock, never a hardcoded one: a fixed date
// becomes a PAST date once it passes and the server rejects past custom times.
const futureYmd = (offsetDays: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86_400_000));

type CancellationRow = {
  status: string;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
};

async function cancellationOf(appointmentId: string): Promise<CancellationRow> {
  const rows = await sql<CancellationRow>(
    `select status, cancellation_reason, cancelled_by, cancelled_at
       from public.appointments where id = $1`,
    [appointmentId],
  );
  return rows[0];
}

async function cancelAuditOf(
  appointmentId: string,
): Promise<Array<{ actor_type: string; actor_id: string | null; source: string | null }>> {
  return sql<{ actor_type: string; actor_id: string | null; source: string | null }>(
    `select actor_type, actor_id::text as actor_id, details->>'source' as source
       from public.appointment_audit
      where appointment_id = $1 and action = 'cancelled'
      order by created_at`,
    [appointmentId],
  );
}

async function setStatus(appointmentId: string, status: string): Promise<void> {
  await sql(`update public.appointments set status = $2 where id = $1`, [
    appointmentId,
    status,
  ]);
}
