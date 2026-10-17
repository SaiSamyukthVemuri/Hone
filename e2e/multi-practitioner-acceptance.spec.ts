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

  bookDate = await oneWeekOutLocalDate(live.studioId);
});

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
  practitionerName: string,
): Promise<{ slotLabel: string }> {
  await openNewClientForm(page, live.slug, liveService, bookDate);

  const picker = page.getByTestId("practitioner-picker");
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: practitionerName });

  await waitForGrid(page, bookDate);
  const labels = await offeredSlotLabels(page);
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

  await picker.selectOption({ label: A.displayName });
  await waitForGrid(page, bookDate);
  const aLabels = await offeredSlotLabels(page);
  expect(aLabels.length, "A must be offered at least one slot").toBeGreaterThan(0);
  for (const label of aLabels) {
    const mins = labelToMinutes(label);
    expect(
      mins,
      `slot ${label} is outside A's seeded window ${A_WINDOW.start}-${A_WINDOW.end}`,
    ).toBeGreaterThanOrEqual(windowToMinutes(A_WINDOW.start));
    expect(mins).toBeLessThan(windowToMinutes(A_WINDOW.end));
  }

  await picker.selectOption({ label: B.displayName });
  await waitForGrid(page, bookDate);
  const bLabels = await offeredSlotLabels(page);
  expect(bLabels.length, "B must be offered at least one slot").toBeGreaterThan(0);
  for (const label of bLabels) {
    const mins = labelToMinutes(label);
    expect(
      mins,
      `slot ${label} is outside B's seeded window ${B_WINDOW.start}-${B_WINDOW.end}`,
    ).toBeGreaterThanOrEqual(windowToMinutes(B_WINDOW.start));
    expect(mins).toBeLessThan(windowToMinutes(B_WINDOW.end));
  }

  // NON-VACUITY FOR THE WINDOWS: the two grids are genuinely different. If the
  // scoped rows were being ignored (capacity rolled back, say) both grids would
  // be the studio-wide 06:00-22:00 set and every assertion above would still
  // pass while proving nothing about the choice.
  expect(
    aLabels.filter((l) => bLabels.includes(l)),
    "A's and B's grids must not overlap — the scoped windows are disjoint",
  ).toEqual([]);

  // --- (2b) the booking is ASSIGNED to the chosen practitioner -------------
  const aBooking = await bookWithPractitioner(page, clientA, A.displayName);
  const aRows = await waitForClientAppointments(live.studioId, clientA.email, 1, page);
  expect(aRows[0].practitioner_id, "booking must be assigned to A").toBe(A.practitionerId);

  const bBooking = await bookWithPractitioner(page, clientB, B.displayName);
  const bRows = await waitForClientAppointments(live.studioId, clientB.email, 1, page);
  expect(bRows[0].practitioner_id, "booking must be assigned to B").toBe(B.practitionerId);

  // THE CONTROL THAT MAKES THIS MEAN ANYTHING. Pre-G1 the public path attributed
  // every appointment to the studio's active OWNER, so a test that only checked
  // "two appointments exist, each with a practitioner" would have passed on the
  // old behaviour. Neither booking may be the owner's, and they must differ.
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
  await waitForGrid(page, bookDate);
  const rescheduleLabels = await offeredSlotLabels(page);
  // A DIFFERENT time, still inside A's window: the successor must stay bookable
  // for A, so a slot from B's afternoon would be testing the wrong thing.
  const newLabel = rescheduleLabels.find((l) => l !== aBooking.slotLabel);
  expect(newLabel, "the reschedule grid must offer an alternative time").toBeTruthy();
  for (const label of rescheduleLabels) {
    expect(
      labelToMinutes(label),
      `reschedule offered ${label}, outside A's window — the successor would not be A's`,
    ).toBeLessThan(windowToMinutes(A_WINDOW.end));
  }

  await page.getByRole("button", { name: newLabel!, exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /confirm new time/i }).click();
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

  for (const [id, expectedName, label] of [
    [successorId, A.displayName, "A's rescheduled booking"],
    [bRows[0].id, B.displayName, "B's booking"],
  ] as const) {
    await page.goto(`/calendar/${id}`);
    const header = page.locator("header").first();
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
  for (let d = 0; d <= 6; d++) {
    await seedStudioWideDefault(legacy.studioId, d, true, "06:00", "22:00");
    await seedPractitionerDefault(legacy.studioId, P.practitionerId, d, true, "06:00", "22:00");
    await seedPractitionerDefault(legacy.studioId, Q.practitionerId, d, true, "06:00", "22:00");
  }

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
