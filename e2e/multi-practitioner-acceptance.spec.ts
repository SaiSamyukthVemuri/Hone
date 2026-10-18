import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import {
  sql,
  seedE2eStudio,
  seedE2eMember,
  setStudioCapacityEnabled,
  setStudioCapacityBookingEnabled,
  seedStudioWideDefault,
  seedPractitionerDefault,
  seedServiceEligibility,
  getE2eServiceId,
  getStudioTimezone,
  getOwnerPractitionerId,
  getCancellationToken,
  getSourceReservationKeys,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// ===========================================================================
// #824 MULTI-PRACTITIONER ACCEPTANCE — the operator's sequence, walked once.
// ===========================================================================
//
// THIS SPEC DELIBERATELY OVERLAPS e2e/public-practitioner-picker.spec.ts, and
// that is the point rather than an oversight. The picker spec proves G1's
// mechanism in pieces, each piece isolated so a failure localises. This spec
// walks the WHOLE sequence the operator asked to see as acceptance evidence —
// pick A, book, pick B, book, reschedule one, then read the owner's calendar —
// because a set of passing unit-shaped browser cases is not the same evidence
// as one journey that holds together end to end.
//
// WHAT IT DOES NOT DUPLICATE. The picker spec owns the edge cases and they are
// not restated here: option eligibility and the inactive practitioner, the
// kill switch hiding the picker, the delayed studio-wide answer discarded when
// the visitor narrows mid-flight, history navigation, and the slot-taken
// refusal. If one of those breaks, that spec is where it should fail.
//
// WHAT IS GENUINELY NEW HERE, and why each case exists:
//   * DIFFERENT AVAILABILITY. The picker spec seeds A and B with the SAME
//     window (06:00-22:00), so it cannot show that the grid follows the chosen
//     practitioner. Here A works mornings and B works afternoons, which makes
//     "each practitioner's availability is shown correctly" falsifiable.
//   * RESCHEDULE. The picker spec never reschedules (zero mentions). 0171
//     reuses `v_orig.practitioner_id` for the successor, so the contract is
//     that a reschedule PRESERVES the assignment rather than re-attributing to
//     the active owner — which is what the pre-G1 public path would have done.
//   * THE OWNER'S CALENDAR. Also absent from the picker spec. The calendar
//     loads via `getAppointmentsForRange(studio.id, ...)`, i.e. studio-wide,
//     so the owner must see BOTH practitioners' bookings.
//   * THE LEGACY MODE, BY DESIGN. Capacity-OFF is the schema default and most
//     studios are in it. There, blocking is correct behaviour, and pinning it
//     stops a future reader filing it as a bug.
//
// ATTRIBUTION IS READ FROM THE DATABASE, never inferred from confirmation
// copy. Copy that says "booked" is satisfied by a booking attributed to the
// wrong practitioner, so it is the weakest possible evidence for the one claim
// this spec exists to make.
//
// Synthetic studios only, one per run, recognizable ids. Never production.

test.describe.configure({ mode: "serial" });

/** CAPACITY LIVE. Practitioner-scoped availability only beats the studio-wide
 *  row while capacity is ON (0219's header: scoped rows are retained across a
 *  rollback and 0170's validator refuses to prefer them for that reason), and
 *  reservations are only practitioner-keyed while it is ON. Everything about
 *  this journey is therefore a capacity-LIVE claim, stated rather than
 *  implied. */
let live: E2eSeed;
let liveService: string;
let bookDate: string;
let ownerPractitionerId: string;
/** The booked service's length. "Inside the window" is a claim about the whole
 *  appointment, so the duration is part of every window assertion below. */
let serviceMinutes: number;
let A: { email: string; displayName: string; practitionerId: string };
let B: { email: string; displayName: string; practitionerId: string };

/** A's window and B's window are DISJOINT, so a slot proves which practitioner
 *  the grid is for. 12:00 is the boundary: A ends at it, B starts after it. */
const A_WINDOW = { start: "06:00", end: "12:00" } as const;
const B_WINDOW = { start: "13:00", end: "22:00" } as const;

function newClientIdentity(runId: string, label: string): { name: string; email: string } {
  const uniq = randomUUID().slice(0, 8);
  return {
    name: `ACC ${label} ${runId}-${uniq}`,
    email: `acc-${label.toLowerCase()}-${runId}-${uniq}@harness.local`,
  };
}

async function oneWeekOutLocalDate(studioId: string): Promise<string> {
  const rows = await sql<{ d: string }>(
    `select ((now() at time zone $1)::date + 7)::text as d`,
    [await getStudioTimezone(studioId)],
  );
  return rows[0].d;
}

/** "7:00 AM" -> minutes since local midnight, so a slot label can be compared
 *  against a seeded window instead of eyeballed. */
function labelToMinutes(label: string): number {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(label.trim());
  if (!m) throw new Error(`unparseable slot label: ${JSON.stringify(label)}`);
  const hour12 = Number(m[1]) % 12;
  const pm = /pm/i.test(m[3]);
  return (hour12 + (pm ? 12 : 0)) * 60 + Number(m[2]);
}

function windowToMinutes(hhmm: string): number {
  const [h, mm] = hhmm.split(":").map(Number);
  return h * 60 + mm;
}

test.beforeAll(async () => {
  live = await seedE2eStudio();
  liveService = await getE2eServiceId(live.studioId);
  ownerPractitionerId = await getOwnerPractitionerId(live.studioId);

  A = await seedE2eMember(live);
  B = await seedE2eMember(live);

  await setStudioCapacityEnabled(live.studioId, true);
  await setStudioCapacityBookingEnabled(live.studioId, true);

  // The service-insert trigger seeds only the OWNER as eligible, so A and B
  // must be made eligible explicitly or the picker correctly hides them.
  await seedServiceEligibility(live.studioId, liveService, A.practitionerId);
  await seedServiceEligibility(live.studioId, liveService, B.practitionerId);

  for (let d = 0; d <= 6; d++) {
    // The studio-wide row SPANS both windows. If it did not, a scoped window
    // could be passing because the studio-wide row already excluded the other
    // practitioner's hours, and the precedence rule would be untested.
    await seedStudioWideDefault(live.studioId, d, true, "06:00", "22:00");
    await seedPractitionerDefault(live.studioId, A.practitionerId, d, true, A_WINDOW.start, A_WINDOW.end);
    await seedPractitionerDefault(live.studioId, B.practitionerId, d, true, B_WINDOW.start, B_WINDOW.end);
  }

  serviceMinutes = (
    await sql<{ m: number }>(
      `select default_duration_minutes::int as m from public.services where id = $1`,
      [liveService],
    )
  )[0].m;
  expect(serviceMinutes, "the fixture service must have a real duration").toBeGreaterThan(0);

  bookDate = await oneWeekOutLocalDate(live.studioId);
});

/** THE WHOLE APPOINTMENT, start THROUGH end.
 *
 *  A start-only bound is the adjacent property, not the one that matters: a
 *  30-minute booking starting at 11:45 begins inside a 06:00-12:00 window and
 *  ENDS outside it. Every offered slot is checked for both edges including the
 *  service duration, so an overrunning slot fails here instead of committing. */
function expectSlotFitsWindow(
  label: string,
  w: { start: string; end: string },
  context: string,
): void {
  const start = labelToMinutes(label);
  expect(
    start,
    `${context}: ${label} starts before the window opens (${w.start})`,
  ).toBeGreaterThanOrEqual(windowToMinutes(w.start));
  expect(
    start + serviceMinutes,
    `${context}: ${label} + ${serviceMinutes}m overruns the window close (${w.end})`,
  ).toBeLessThanOrEqual(windowToMinutes(w.end));
}

/** The COMMITTED row's own bounds, in studio-local minutes. The slot labels are
 *  what the page offered; this is what the database actually stored, which is
 *  the thing the window claim is ultimately about. */
async function committedBounds(
  appointmentId: string,
): Promise<{ startMin: number; endMin: number; localDate: string }> {
  const rows = await sql<{ s: string; e: string; d: string }>(
    `select to_char((a.starts_at at time zone st.timezone), 'HH24:MI') as s,
            to_char((a.ends_at   at time zone st.timezone), 'HH24:MI') as e,
            to_char((a.starts_at at time zone st.timezone), 'YYYY-MM-DD') as d
       from public.appointments a
       join public.studios st on st.id = a.studio_id
      where a.id = $1`,
    [appointmentId],
  );
  return {
    startMin: windowToMinutes(rows[0].s),
    endMin: windowToMinutes(rows[0].e),
    localDate: rows[0].d,
  };
}

async function expectCommittedWithinWindow(
  appointmentId: string,
  w: { start: string; end: string },
  context: string,
): Promise<void> {
  const { startMin, endMin } = await committedBounds(appointmentId);
  expect(startMin, `${context}: committed start is before ${w.start}`).toBeGreaterThanOrEqual(
    windowToMinutes(w.start),
  );
  expect(endMin, `${context}: committed END ${endMin} overruns ${w.end}`).toBeLessThanOrEqual(
    windowToMinutes(w.end),
  );
}

/** Wait for THE SELECTED PRACTITIONER'S slot response, not merely "a fetch
 *  answered".
 *
 *  Choosing a practitioner does NOT change the date, so the heading is already
 *  correct and `waitForGrid` is satisfied the instant the select fires while
 *  `slots` still holds the PREVIOUS practitioner's grid. A date-matched wait
 *  cannot help here either, for the same reason. The booking form calls
 *  `fetchPublicSlotsAction({ slug, serviceId, date, practitionerId, ... })`, so
 *  the request that carries BOTH that practitioner's id and the date is that
 *  practitioner's scoped fetch and nothing else. */
function awaitScopedSlots(page: Page, practitionerId: string) {
  return page.waitForResponse(
    (r) => {
      if (r.request().method() !== "POST") return false;
      if (!r.request().headers()["next-action"]) return false;
      const body = r.request().postData() ?? "";
      return body.includes(practitionerId) && body.includes(bookDate);
    },
    { timeout: 20_000 },
  );
}

async function waitForGrid(page: Page, localDate: string): Promise<void> {
  const [y, m, d] = localDate.split("-").map((n) => Number(n));
  const monthDay = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  await expect(
    page.getByText(new RegExp(`available times for .*${monthDay}`, "i")),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/loading slots/i)).toHaveCount(0, { timeout: 20_000 });
}

/** Open the public new-client form on the target DATE FIRST.
 *
 *  Date before service is not cosmetic: the grid only renders once a service is
 *  chosen, so setting the date first means the first grid ever rendered is
 *  already the target date's. The picker spec learned this the hard way — a
 *  click on a stale "today" grid submits a past instant and the server refuses
 *  it with "That time is no longer available", which reads like a conflict and
 *  is not one. */
async function openNewClientForm(
  page: Page,
  studioSlug: string,
  serviceId: string,
  localDate: string,
): Promise<void> {
  await page.goto(`/book/${studioSlug}`);
  await page.getByRole("button", { name: /new client/i }).first().click();
  await page.getByLabel("Date").fill(localDate);
  await page.getByLabel("Service").selectOption(serviceId);
}

/** The slot labels currently offered, as text. */
async function offeredSlotLabels(page: Page): Promise<string[]> {
  const slots = page.getByRole("button", { name: /^\d{1,2}:\d{2}\s*(AM|PM)$/i });
  await expect(slots.first()).toBeVisible({ timeout: 20_000 });
  return (await slots.allTextContents()).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Choose a practitioner, then book the first slot offered FOR THEM. */
async function bookWithPractitioner(
  page: Page,
  client: { name: string; email: string },
  member: { displayName: string; practitionerId: string },
  window: { start: string; end: string },
): Promise<{ slotLabel: string }> {
  await openNewClientForm(page, live.slug, liveService, bookDate);

  const picker = page.getByTestId("practitioner-picker");
  await expect(picker).toBeVisible();
  const scoped = awaitScopedSlots(page, member.practitionerId);
  await picker.selectOption({ label: member.displayName });
  await scoped;

  await waitForGrid(page, bookDate);
  const labels = await offeredSlotLabels(page);
  // The slot about to be CLICKED must fit whole, or the booking commits an
  // appointment that overruns the practitioner's hours.
  for (const label of labels) {
    expectSlotFitsWindow(label, window, `${member.displayName}'s grid`);
  }
  const slotLabel = labels[0];

  await page.getByRole("button", { name: slotLabel, exact: true }).click();

  // The picker must STILL hold the choice at submit time. A silent reset would
  // send "any available" while this test believed it had chosen someone, and
  // the resulting attribution would look like a database fault.
  await expect(
    page.getByTestId("practitioner-picker"),
    "the picker lost its selection before submit",
  ).not.toHaveValue("");

  await page.getByLabel("Your name").fill(client.name);
  // BY INPUT TYPE: getByLabel("Email") is ambiguous, matching the field and the
  // SMS-consent checkbox whose label mentions email.
  await page.locator('input[type="email"]').fill(client.email);
  await page.locator('input[type="tel"]').fill("+15555550123");
  await page.getByRole("button", { name: /^book appointment$/i }).click();
  return { slotLabel };
}

/** Wait for a client's appointment rows to appear, with their attribution. */
async function waitForClientAppointments(
  studioId: string,
  clientEmail: string,
  expected: number,
  page?: Page,
): Promise<Array<{ id: string; practitioner_id: string | null; starts_at: string; status: string }>> {
  const deadline = Date.now() + 20_000;
  let rows: Array<{ id: string; practitioner_id: string | null; starts_at: string; status: string }> = [];
  while (Date.now() < deadline) {
    rows = await sql(
      `select a.id, a.practitioner_id, a.starts_at::text, a.status
         from public.appointments a
         join public.clients c on c.id = a.client_id
        where a.studio_id = $1 and lower(c.email) = lower($2)
        order by a.starts_at`,
      [studioId, clientEmail],
    );
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (page) {
    const body = (await page.locator("main").innerText().catch(() => "")) || "";
    const shown = body.split("\n").map((l) => l.trim()).filter(Boolean).slice(-14).join(" | ");
    throw new Error(
      `expected ${expected} appointment(s) for ${clientEmail}, found ${rows.length}. Page said: ${shown}`,
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// (1) + (2) + (3) + (4) — the operator's sequence, in one walk.
// ---------------------------------------------------------------------------

test("ACCEPTANCE: pick A, pick B, reschedule one, and the owner's calendar attributes both", async ({
  page,
}) => {
  const clientA = newClientIdentity(live.runId, "JourneyA");
  const clientB = newClientIdentity(live.runId, "JourneyB");

  // --- (2a) each practitioner's availability is shown correctly -------------
  // A works mornings only. Every slot offered for A must fall inside A's
  // window — not merely the first one, or a grid that leaked B's afternoon
  // would still pass.
  await openNewClientForm(page, live.slug, liveService, bookDate);
  const picker = page.getByTestId("practitioner-picker");
  await expect(picker).toBeVisible();

  const scopedA = awaitScopedSlots(page, A.practitionerId);
  await picker.selectOption({ label: A.displayName });
  await scopedA;
  await waitForGrid(page, bookDate);
  const aLabels = await offeredSlotLabels(page);
  expect(aLabels.length, "A must be offered at least one slot").toBeGreaterThan(0);
  for (const label of aLabels) expectSlotFitsWindow(label, A_WINDOW, "A's grid");

  const scopedB = awaitScopedSlots(page, B.practitionerId);
  await picker.selectOption({ label: B.displayName });
  await scopedB;
  await waitForGrid(page, bookDate);
  const bLabels = await offeredSlotLabels(page);
  expect(bLabels.length, "B must be offered at least one slot").toBeGreaterThan(0);
  for (const label of bLabels) expectSlotFitsWindow(label, B_WINDOW, "B's grid");

  // NON-VACUITY FOR THE WINDOWS: the two grids are genuinely different. If the
  // scoped rows were being ignored (capacity rolled back, say) both grids would
  // be the studio-wide 06:00-22:00 set and every assertion above would still
  // pass while proving nothing about the choice.
  expect(
    aLabels.filter((l) => bLabels.includes(l)),
    "A's and B's grids must not overlap — the scoped windows are disjoint",
  ).toEqual([]);

  // --- (2b) the booking is ASSIGNED to the chosen practitioner -------------
  const aBooking = await bookWithPractitioner(page, clientA, A, A_WINDOW);
  const aRows = await waitForClientAppointments(live.studioId, clientA.email, 1, page);
  expect(aRows[0].practitioner_id, "booking must be assigned to A").toBe(A.practitionerId);

  const bBooking = await bookWithPractitioner(page, clientB, B, B_WINDOW);
  const bRows = await waitForClientAppointments(live.studioId, clientB.email, 1, page);
  expect(bRows[0].practitioner_id, "booking must be assigned to B").toBe(B.practitionerId);

  // THE CONTROL THAT MAKES THIS MEAN ANYTHING. Pre-G1 the public path attributed
  // every appointment to the studio's active OWNER, so a test that only checked
  // "two appointments exist, each with a practitioner" would have passed on the
  // old behaviour. Neither booking may be the owner's, and they must differ.
  // THE COMMITTED ROWS, start THROUGH end. The grids above are what the page
  // OFFERED; these are what the database stored, which is what "inside the
  // practitioner's hours" ultimately means.
  await expectCommittedWithinWindow(aRows[0].id, A_WINDOW, "A's booking");
  await expectCommittedWithinWindow(bRows[0].id, B_WINDOW, "B's booking");

  expect(aRows[0].practitioner_id).not.toBe(ownerPractitionerId);
  expect(bRows[0].practitioner_id).not.toBe(ownerPractitionerId);
  expect(aRows[0].practitioner_id).not.toBe(bRows[0].practitioner_id);
  expect(aBooking.slotLabel).not.toBe(bBooking.slotLabel);

  // --- (3) reschedule preserves the assignment ----------------------------
  const originalId = aRows[0].id;
  const originalStart = aRows[0].starts_at;
  const originalKeys = await getSourceReservationKeys("appointment", originalId);
  expect(originalKeys.length, "the original booking must hold a reservation").toBeGreaterThan(0);

  const token = await getCancellationToken(live.studioId, originalId);
  expect(token, "the booking must carry a reschedule token").toBeTruthy();

  await page.goto(`/reschedule/${token}`);
  // THE RESCHEDULE PAGE OPENS ON TODAY, not on the appointment's date, so its
  // date must be set exactly as the booking form's is. Without this the grid
  // below is TODAY'S and the wait for the target date never resolves.
  //
  // AND THE HEADING IS NOT A SETTLE SIGNAL HERE (Codex, 724b0388). Unlike the
  // booking form — where the picker spec removes this race BY CONSTRUCTION by
  // setting the date before a grid exists — this page already has a rendered
  // grid, and `loadingSlots` comes from useTransition inside the slot
  // useEffect. So between `fill()` and that effect firing, the heading ALREADY
  // shows the new date, "Loading slots…" is NOT yet present, and `slots` still
  // holds TODAY'S. waitForGrid would pass on the stale grid, and the window
  // assertions below cannot detect it: today's slots are A's too, so they
  // satisfy the same bounds. Only the fetch itself distinguishes them.
  //
  // So: let the initial grid settle, then arm a wait for the slot request the
  // date change triggers, and only read slots after it has answered.
  await expect(page.getByText(/loading slots/i)).toHaveCount(0, { timeout: 20_000 });
  // MATCHED ON THE DATE, not merely "a server action answered". The date change
  // triggers fetchRescheduleSlotsAction({ token, date }), so the request that
  // carries `bookDate` in its body IS that date's slot request. Waiting for any
  // next-action POST would also be satisfied by an unrelated action and put us
  // back in front of a stale grid. Deliberately strict: if the encoding ever
  // stops carrying the date literally this TIMES OUT loudly rather than
  // silently reading stale buttons again.
  const slotFetch = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      Boolean(r.request().headers()["next-action"]) &&
      (r.request().postData() ?? "").includes(bookDate),
    { timeout: 20_000 },
  );
  await page.getByLabel("Pick a new date").fill(bookDate);
  await slotFetch;
  await waitForGrid(page, bookDate);
  const rescheduleLabels = await offeredSlotLabels(page);
  // A DIFFERENT time, still inside A's window: the successor must stay bookable
  // for A, so a slot from B's afternoon would be testing the wrong thing.
  //
  // TWO CLOCKS ON THIS PAGE, measured during the first run of this spec and
  // recorded because it will mislead the next person to assert here. The SLOT
  // GRID is studio-local, but the "Currently" summary row renders through
  // FormattedDateTime, which calls toLocaleString([]) -- the VIEWER's
  // timezone. On this fixture (studio Etc/GMT+10, browser UTC) the same
  // appointment reads 06:00 in the grid and "4:00 PM" in the summary. Compare
  // slot labels against the seeded window, never against that summary row.
  const newLabel = rescheduleLabels.find((l) => l !== aBooking.slotLabel);
  expect(newLabel, "the reschedule grid must offer an alternative time").toBeTruthy();
  // BOTH EDGES, like the initial grids above. Codex caught this asserting only
  // the UPPER bound: a reschedule grid that offered 03:00 — before A's seeded
  // 06:00 opening — would have stayed green, and because `newLabel` is taken
  // from this same list the test could have rescheduled INTO that invalid time
  // and still passed. A one-sided bound is not "inside the window".
  // ...and the WHOLE duration, not just the start. A 30-minute slot offered at
  // 11:45 starts inside 06:00-12:00 and ends outside it, so a start-only bound
  // would let the reschedule commit an appointment that overruns A's hours.
  for (const label of rescheduleLabels) {
    expectSlotFitsWindow(label, A_WINDOW, "the reschedule grid");
  }

  await page.getByRole("button", { name: newLabel!, exact: true }).click();

  // THE POLICY ACKNOWLEDGEMENT IS CONDITIONAL, and this is not defensive
  // padding. RescheduleForm renders the checkbox only when
  // `requiresAcknowledgement` holds, which needs the studio to have policy
  // TEXT (PR #133 omits the block entirely otherwise). This fixture seeds no
  // policies, so there is no checkbox; e2e/public-reschedule-v2.spec.ts seeds
  // them and therefore ticks one. Asserting the button is enabled first means
  // a FUTURE fixture that does seed policies fails loudly here instead of
  // silently clicking a disabled button.
  const ack = page.getByRole("checkbox");
  if ((await ack.count()) > 0) await ack.check();
  const confirm = page.getByRole("button", { name: /confirm new time/i });
  await expect(confirm, "the reschedule submit must be enabled once a time is picked").toBeEnabled();
  await confirm.click();
  await expect(page.getByText(/You.re rescheduled\./i)).toBeVisible({ timeout: 20_000 });

  // 0171 writes a SUCCESSOR row rather than mutating the original, so "the
  // assignment survived" is a claim about the new row.
  const successors = await sql<{
    id: string;
    practitioner_id: string | null;
    starts_at: string;
  }>(
    `select id, practitioner_id, starts_at::text
       from public.appointments
      where rescheduled_from_appointment_id = $1`,
    [originalId],
  );
  expect(successors.length, "the reschedule must write exactly one successor").toBe(1);
  expect(
    successors[0].practitioner_id,
    "the reschedule must PRESERVE A's assignment, not re-attribute to the owner",
  ).toBe(A.practitionerId);
  expect(successors[0].starts_at, "the successor must be at a NEW time").not.toBe(originalStart);

  // THE SELECTED DATE, NOT JUST A DIFFERENT INSTANT (Codex, this head). Every
  // other check here is satisfied by a successor on ANOTHER DAY of the same
  // week: the request wait proves only that `bookDate` was SENT, "not the
  // original instant" proves only that it moved, the window helper compares
  // TIME-OF-DAY alone, and the week view would still show a misplaced
  // appointment. So the committed date is compared with the date chosen.
  const successorBounds = await committedBounds(successors[0].id);
  expect(
    successorBounds.localDate,
    `the reschedule must honour the selected date ${bookDate}, not merely move the time`,
  ).toBe(bookDate);
  // Non-vacuity: the ORIGINAL was on that date too, so this assertion is about
  // the successor keeping it rather than about the fixture's only possible day.
  expect((await committedBounds(originalId)).localDate).toBe(bookDate);
  // The RESCHEDULED appointment must also fit whole — this is the second half
  // of "both the initial booking and the reschedule".
  await expectCommittedWithinWindow(successors[0].id, A_WINDOW, "A's rescheduled booking");

  // ...and the OLD slot is released. 0171 cancels the original as
  // `rescheduled`; its reservation must not keep holding the instant, or the
  // freed time would stay unbookable.
  const original = await sql<{ status: string; cancellation_kind: string | null }>(
    `select status, cancellation_kind from public.appointments where id = $1`,
    [originalId],
  );
  expect(original[0].cancellation_kind).toBe("rescheduled");
  expect(
    await getSourceReservationKeys("appointment", originalId),
    "the original booking's reservation must be released",
  ).toEqual([]);

  // --- (4) the owner's calendar attributes both ---------------------------
  await loginAsOwner(page, live);
  const successorId = successors[0].id;

  // The grid is studio-wide (`getAppointmentsForRange(studio.id, ...)`), so the
  // owner must see BOTH practitioners' bookings. Attribution itself renders in
  // the detail page's HEADER, via PractitionerLine — which prints the
  // practitioner's display_name, or "Unassigned" when the row has none.
  //
  // SCOPED TO THE HEADER DELIBERATELY. A page-wide getByText would also match
  // the client briefing card, the notes and any other mention, so it would be
  // asserting "this name appears somewhere" rather than "this appointment is
  // attributed to them" — the adjacent-property mistake.
  const ownerName = (
    await sql<{ display_name: string }>(
      `select display_name from public.practitioners where id = $1`,
      [ownerPractitionerId],
    )
  )[0].display_name;

  // THE GRID FIRST, because the detail pages alone do not prove the owner can
  // SEE either booking (Codex, 724b0388). Both ids come straight from SQL and
  // `goto('/calendar/<id>')` bypasses the calendar entirely, so a regression
  // that filtered A or B out of getAppointmentsForRange — or out of the grid
  // rendering — would leave every assertion below green. "The owner's calendar
  // shows both practitioners' bookings" is a claim about the GRID.
  //
  // `?week=` anchors the week view to the week containing that studio-local
  // date, and DayColumn labels each entry "<client> · <service> · <time> · <n>m",
  // so the client names are what identify the two bookings there. Scoped to
  // main so the navigation chrome cannot satisfy it.
  // REACHED THROUGH THE RENDERED ENTRIES, never by pasting an id into the URL.
  // Asserting the grid shows a name and THEN navigating to /calendar/<id> from
  // SQL still proves nothing about the entry: the two could be different
  // bookings and every assertion would hold. So the walk is the real one a
  // practitioner performs — click the card in the week grid, which opens the
  // in-context preview dialog, then follow its "Open full details" link — and
  // the id from the database is used ONLY to verify where that link landed.
  // That makes the grid entry and the row provably the same appointment.
  for (const [expectedId, clientName, expectedName, label] of [
    [successorId, clientA.name, A.displayName, "A's rescheduled booking"],
    [bRows[0].id, clientB.name, B.displayName, "B's booking"],
  ] as const) {
    await page.goto(`/calendar?week=${bookDate}`);
    const entry = page.locator("main").getByRole("button").filter({ hasText: clientName });
    // EXACTLY ONE, and the count is load-bearing twice over. A's client has TWO
    // appointment rows on this date — the cancelled original and the successor
    // — but calendar/page.tsx drops cancelled rows before the grid
    // ("Only cancelled appointments are hidden (their slot is freed)"), so a
    // count of 1 also proves the released booking is GONE from what the owner
    // sees. A count of 2 would mean a cancelled booking still occupies the
    // grid, which is the UI half of the slot-release claim asserted in the
    // database above.
    await expect(
      entry,
      `${label} must appear as exactly one entry in the owner's calendar grid`,
    ).toHaveCount(1);
    await entry.click();

    const drawer = page.getByRole("dialog", { name: /appointment preview/i });
    await expect(drawer, "clicking the grid entry must open its preview").toBeVisible({
      timeout: 20_000,
    });
    await drawer.getByRole("link", { name: /open full details/i }).click();

    // WHERE THE RENDERED ENTRY LED. The id is the assertion, not the route.
    await expect(
      page,
      `${label}'s grid entry must lead to its own detail page`,
    ).toHaveURL(new RegExp(`/calendar/${expectedId}(\\?|$)`));
    // `main header`, NOT `header`. The app shell renders its own top-level
    // <header> (the primary-navigation banner), so locator("header").first()
    // matches the NAV and never sees the attribution — measured: the first run
    // of this assertion failed while the page was correct, showing A's name in
    // main. StatusHeader is the only <header> inside <main>.
    const header = page.locator("main header").first();
    await expect(
      header.getByText(expectedName, { exact: false }),
      `${label} must be attributed to ${expectedName} on the owner's calendar`,
    ).toBeVisible({ timeout: 20_000 });
    // Pre-G1 this header would have shown the OWNER for every public booking.
    // That is the regression this whole journey exists to catch, so it is
    // asserted rather than left implied by the positive match above.
    await expect(
      header.getByText(ownerName, { exact: false }),
      `${label} must NOT be attributed to the owner (${ownerName})`,
    ).toHaveCount(0);
    // And it is not the null case reading as a pass: PractitionerLine prints
    // "Unassigned" when the row carries no practitioner.
    await expect(header.getByText(/unassigned/i)).toHaveCount(0);
  }

  // NON-VACUITY: the two detail pages must not both be showing the same name,
  // which is exactly what the pre-G1 owner-attribution behaviour would render.
  expect(A.displayName).not.toBe(B.displayName);
  expect(ownerName).not.toBe(A.displayName);
  expect(ownerName).not.toBe(B.displayName);
});

// ---------------------------------------------------------------------------
// The LEGACY mode, pinned as INTENDED behaviour rather than left to be
// rediscovered as a bug.
// ---------------------------------------------------------------------------

test("LEGACY capacity-OFF, BY DESIGN: one booking blocks the instant for everyone", async ({
  page,
}) => {
  // WHY THERE IS NO "PICK B" HERE, and why that is the finding rather than a
  // gap in the test. 0136 constrains the pair:
  //     check (practitioner_capacity_enabled or not practitioner_capacity_booking_enabled)
  // so capacity-OFF forces public assignment OFF — a capacity-OFF studio CANNOT
  // show a picker, and the visitor cannot choose at all. Combined with 0219's
  // header — "every reservation is keyed to the STUDIO, so choosing a
  // practitioner buys no parallelism: another practitioner's appointment still
  // blocks the slot. That is 0136's model, not a defect here." — the legacy
  // contract is: no choice, and no parallelism. Both halves are asserted.
  const legacy = await seedE2eStudio();
  const service = await getE2eServiceId(legacy.studioId);
  const P = await seedE2eMember(legacy);
  const Q = await seedE2eMember(legacy);
  await seedServiceEligibility(legacy.studioId, service, P.practitionerId);
  await seedServiceEligibility(legacy.studioId, service, Q.practitionerId);
  // STUDIO-WIDE ONLY, and the reason is the third limb of the legacy contract,
  // found by this spec's first run rather than assumed. Seeding
  // practitioner-scoped availability here is REFUSED BY THE DATABASE:
  //   "per-practitioner availability requires practitioner capacity to be
  //    enabled for this studio"
  // so a legacy studio cannot even express per-practitioner hours. That is
  // asserted below rather than worked around silently.
  for (let d = 0; d <= 6; d++) {
    await seedStudioWideDefault(legacy.studioId, d, true, "06:00", "22:00");
  }

  await expect(
    seedPractitionerDefault(legacy.studioId, P.practitionerId, 6, true, "06:00", "12:00"),
    "a capacity-OFF studio must REFUSE per-practitioner availability outright",
  ).rejects.toThrow(/per-practitioner availability requires practitioner capacity/i);

  // DEFAULTS LEFT ALONE deliberately: `practitioner_capacity_enabled` defaults
  // FALSE (0134:55). Asserting that rather than assuming it, because the whole
  // case rests on the studio really being in the legacy state.
  // ITS OWN DATE, from ITS OWN timezone. `bookDate` above is derived from the
  // LIVE studio, and a date that is one week out in one timezone can be a
  // different local day in another — a silent off-by-one that would show up as
  // an empty slot grid and read like a broken fixture.
  const legacyDate = await oneWeekOutLocalDate(legacy.studioId);

  const flags = await sql<{ cap: boolean; booking: boolean }>(
    `select practitioner_capacity_enabled as cap,
            practitioner_capacity_booking_enabled as booking
       from public.studios where id = $1`,
    [legacy.studioId],
  );
  expect(flags[0].cap, "this case requires the LEGACY default").toBe(false);
  expect(flags[0].booking).toBe(false);

  const first = newClientIdentity(legacy.runId, "LegacyOne");

  await openNewClientForm(page, legacy.slug, service, legacyDate);
  // HALF ONE: no picker exists, so the visitor cannot choose a practitioner.
  await expect(
    page.getByTestId("practitioner-picker"),
    "a capacity-OFF studio must not offer a practitioner choice",
  ).toHaveCount(0);

  await waitForGrid(page, legacyDate);
  const labels = await offeredSlotLabels(page);
  const target = labels[0];
  await page.getByRole("button", { name: target, exact: true }).click();
  await page.getByLabel("Your name").fill(first.name);
  await page.locator('input[type="email"]').fill(first.email);
  await page.locator('input[type="tel"]').fill("+15555550123");
  await page.getByRole("button", { name: /^book appointment$/i }).click();
  await waitForClientAppointments(legacy.studioId, first.email, 1, page);

  // HALF TWO: the same instant is no longer offered to anyone, although a
  // SECOND eligible practitioner is free for it. Under capacity-ON this is the
  // case the journey above proves works; here it is correctly refused.
  await openNewClientForm(page, legacy.slug, service, legacyDate);
  await waitForGrid(page, legacyDate);
  const afterLabels = await offeredSlotLabels(page);
  expect(
    afterLabels,
    "legacy studios key reservations to the STUDIO, so the taken instant must " +
      "disappear for every practitioner — this is 0136's model, not a defect",
  ).not.toContain(target);
});

// ---------------------------------------------------------------------------
// A receptionist is not a treating resource.
// ---------------------------------------------------------------------------

test("a receptionist never appears in the public picker", async ({ page }) => {
  // DENIED TWICE OVER, per 0219's header: the options function filters
  // `role in ('owner','practitioner')`, and a receptionist is not a
  // `practitioners` row at all — it lives in `studio_receptionists` (0216:47).
  //
  // SEEDED, so the assertion is not vacuous. Asserting "the picker does not
  // list a receptionist" without creating one would pass on a studio that has
  // none, which is every studio in this harness by default.
  const displayName = `ACC Receptionist ${live.runId}-${randomUUID().slice(0, 8)}`;
  await sql(
    `insert into public.studio_receptionists (studio_id, display_name, email, active)
     values ($1, $2, $3, true)`,
    [live.studioId, displayName, `acc-recep-${live.runId}@harness.local`],
  );
  const seeded = await sql<{ n: number }>(
    `select count(*)::int as n from public.studio_receptionists
      where studio_id = $1 and display_name = $2`,
    [live.studioId, displayName],
  );
  expect(seeded[0].n, "the receptionist fixture must exist for this to mean anything").toBe(1);

  await openNewClientForm(page, live.slug, liveService, bookDate);
  const picker = page.getByTestId("practitioner-picker");
  await expect(picker).toBeVisible();
  const labels = await picker.locator("option").allTextContents();

  expect(labels, "a receptionist is not a treating resource").not.toContain(displayName);
  // Non-vacuity: the picker IS populated, so the absence above is a real
  // exclusion rather than an empty list.
  expect(labels).toContain(A.displayName);
  expect(labels).toContain(B.displayName);
});
