import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import {
  sql,
  seedE2eStudio,
  seedE2eMember,
  setStudioCapacityEnabled,
  setStudioCapacityBookingEnabled,
  setPractitionerActive,
  seedStudioWideDefault,
  seedPractitionerDefault,
  seedServiceEligibility,
  getE2eServiceId,
  getStudioTimezone,
  type E2eSeed,
} from "./helpers/seed";

// G1 — the public practitioner picker, driven through the RENDERED public
// booking page against a synthetic capacity-LIVE, admission-OPEN studio, and
// verified against the DATABASE rather than inferred from confirmation copy.
//
// WHY THE NEW-CLIENT PATH. The existing-client branch of this form is
// intentionally unreachable (PublicBookForm says so, and a browser run
// confirmed it renders a portal sign-in card with no service selector). The
// RENDERED public booking form is the new-client form on an OPEN studio, which
// commits through create_public_appointment_for_new_client_v2 (0223) and
// delegates to create_public_appointment_v2 (0222). So this is the surface
// where a picker is real.
//
// The WAITLIST and CLOSED admission gates are not driven from here: changing
// admission requires the owner-authorized set_new_client_admission_mode, and
// those gates are proved refusing a practitioner-bearing booking at command
// level in tests/db/public-new-client-practitioner.db.test.ts. Nothing here
// bypasses a gate to make a test pass.
//
// WHAT THIS PROVES, and why each half is needed:
//   * DIFFERENT practitioners can hold the SAME instant — the whole point of
//     G1, and impossible before 0219/0222 because the public validator was
//     studio-wide by construction;
//   * the SAME practitioner cannot be double-booked — narrowing the conflict
//     scope is only correct if it still protects the practitioner against
//     themselves. Without this half the first proves nothing.
//
// Never Willow, never production: one synthetic studio per run, recognizable
// ids, dropped-by-id teardown is unnecessary because the harness scopes by
// runId.

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;
let serviceId: string;
let tz: string;
let bookDate: string;
let A: { email: string; displayName: string; practitionerId: string };
let B: { email: string; displayName: string; practitionerId: string };
let C: { email: string; displayName: string; practitionerId: string };
/** ACTIVE but NOT pinned to the service. Without D the eligibility half of the
 *  options assertion is VACUOUS: C is inactive, so excluding it proves only the
 *  ACTIVE filter, and an active-but-ineligible practitioner — the case the
 *  0170/0222/0225 optional-list rule exists for — went untested. */
let D: { email: string; displayName: string; practitionerId: string };
let clientOne: { name: string; email: string };
let clientTwo: { name: string; email: string };

/** A FRESH identity for the new-client path. That path CREATES the client, so
 *  each booking needs an unused email — a repeat would resolve to the existing
 *  row and stop exercising creation. Spec-local on purpose: e2e/helpers/seed.ts
 *  is shared across lanes and forces extended browser coverage. */
function newClientIdentity(runId: string, label: string): { name: string; email: string } {
  const uniq = randomUUID().slice(0, 8);
  return {
    name: `G1 ${label} ${runId}-${uniq}`,
    email: `g1-${label.toLowerCase()}-${runId}-${uniq}@harness.local`,
  };
}

/** The studio-local date one week out: comfortably inside the booking horizon
 *  and clear of the public past-time filter, so the slot grid is never empty
 *  for clock reasons. */
async function oneWeekOutLocalDate(studioId: string): Promise<string> {
  const rows = await sql<{ d: string }>(
    `select ((now() at time zone $1)::date + 7)::text as d`,
    [await getStudioTimezone(studioId)],
  );
  return rows[0].d;
}

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  serviceId = await getE2eServiceId(seed.studioId);
  tz = await getStudioTimezone(seed.studioId);

  A = await seedE2eMember(seed);
  B = await seedE2eMember(seed);
  C = await seedE2eMember(seed);
  D = await seedE2eMember(seed);
  // Inactive: must never appear in the picker, and must never be bookable.
  await setPractitionerActive(C.practitionerId, false);

  // LIVE, or a practitioner choice buys attribution without parallelism and the
  // first assertion below would be testing 0136's model instead of G1's.
  await setStudioCapacityEnabled(seed.studioId, true);
  await setStudioCapacityBookingEnabled(seed.studioId, true);

  // ELIGIBILITY IS SEEDED BY A TRIGGER, NOT BY THESE CALLS — and the first
  // version of this fixture had it backwards. 0134's
  // `default_eligibility_for_practitioner` fires AFTER INSERT (and on UPDATE OF
  // active) and pins the practitioner to EVERY service the studio already has,
  // so `seedE2eMember` alone made A, B, C and D eligible and both calls below
  // are no-ops. The old comment here claimed the service-insert trigger pinned
  // only the OWNER; on that false premise the picker listing D looked like a
  // defect, when the state the assertion needed had never been built.
  //
  // Kept regardless: they state the intent, they are idempotent, and they keep
  // this fixture correct if that default ever changes.
  await seedServiceEligibility(seed.studioId, serviceId, A.practitionerId);
  await seedServiceEligibility(seed.studioId, serviceId, B.practitionerId);

  // D IS UN-PINNED EXPLICITLY, which is the ONLY way to reach "active, but not
  // eligible for THIS service" — the state 0170's optional-list rule exists
  // for — and it is what the operator's own surface does when a practitioner is
  // unassigned from a service. D's `active` must not be touched after this, or
  // the trigger pins it straight back. Spec-local on purpose: e2e/helpers/seed.ts
  // is shared across lanes and editing it forces extended browser coverage.
  await sql(
    `delete from public.service_practitioners
      where service_id = $1 and practitioner_id = $2`,
    [serviceId, D.practitionerId],
  );

  // THE PRECONDITION IS ASSERTED, NOT ASSUMED — this is the check whose absence
  // let the fixture claim a state it did not have. The list must be NON-EMPTY,
  // because an empty list sends `loadEligiblePractitioners` down 0170's
  // optional-list escape and returns every option unfiltered, so the filter
  // under test would never run; and it must EXCLUDE D, or the assertion below
  // is measuring the trigger rather than the filter.
  const pinned = new Set(
    (
      await sql<{ practitioner_id: string }>(
        `select practitioner_id::text as practitioner_id
           from public.service_practitioners where service_id = $1`,
        [serviceId],
      )
    ).map((r) => r.practitioner_id),
  );
  expect(pinned.size).toBeGreaterThan(0);
  expect(pinned.has(A.practitionerId)).toBe(true);
  expect(pinned.has(B.practitionerId)).toBe(true);
  expect(pinned.has(D.practitionerId)).toBe(false);

  for (let d = 0; d <= 6; d++) {
    await seedStudioWideDefault(seed.studioId, d, true, "06:00", "22:00");
    await seedPractitionerDefault(seed.studioId, A.practitionerId, d, true, "06:00", "22:00");
    await seedPractitionerDefault(seed.studioId, B.practitionerId, d, true, "06:00", "22:00");
  }

  bookDate = await oneWeekOutLocalDate(seed.studioId);
  clientOne = newClientIdentity(seed.runId, "One");
  clientTwo = newClientIdentity(seed.runId, "Two");
});

/** Drive the real public page as an EXISTING client, optionally choosing a
 *  practitioner, and submit. Returns the chosen slot's label so a second
 *  booking can target the SAME instant. */
async function bookPublicly(
  page: Page,
  client: { name: string; email: string },
  opts: { practitionerName?: string; slotLabel?: string },
): Promise<{ slotLabel: string }> {
  await page.goto(`/book/${seed.slug}`);
  await page.getByRole("button", { name: /new client/i }).first().click();

  // DATE FIRST — this removes the stale-grid race BY CONSTRUCTION rather than
  // by waiting. The slot grid only renders once a SERVICE is chosen, so setting
  // the date first means the first grid ever rendered is already the target
  // date's and no "today" grid exists to click into.
  //
  // Waiting was not enough: the heading tracks `date` state immediately while
  // the slots refetch asynchronously, so "not yet loading" is indistinguishable
  // from "finished loading" and a click could still land on today's times. The
  // submitted instant was then in the past and the server refused it with
  // "That time is no longer available" — which reads like a conflict and is
  // not one.
  await page.getByLabel("Date").fill(bookDate);
  await page.getByLabel("Service").selectOption(serviceId);

  if (opts.practitionerName) {
    const picker = page.getByTestId("practitioner-picker");
    await expect(picker).toBeVisible();
    await picker.selectOption({ label: opts.practitionerName });
  }

  await waitForGrid(page, bookDate);

  // Slot buttons are time labels. Target the same instant across bookings when
  // the caller pins one, so "parallel" means genuinely the same start.
  const slot = opts.slotLabel
    ? page.getByRole("button", { name: opts.slotLabel, exact: true })
    : page.getByRole("button", { name: /^\d{1,2}:\d{2}\s*(AM|PM)$/i }).first();
  await expect(slot).toBeVisible({ timeout: 20_000 });

  const slotLabel = (await slot.textContent())?.trim() ?? "";
  await slot.click();

  // BY INPUT TYPE, not by label. getByLabel("Email") matches TWO elements:
  // the field, and the SMS-consent checkbox whose label reads "...Email will
  // still be used...". Both are <label> elements, so the text is ambiguous
  // while the input types are not.
  // HYPOTHESIS CHECK, kept because it is a real invariant and not scaffolding:
  // the picker's value must still be the chosen practitioner at SUBMIT time. A
  // reset here would send "any available" while the test believed it had chosen
  // someone — and the refusal would look like a database problem.
  if (opts.practitionerName) {
    await expect(
      page.getByTestId("practitioner-picker"),
      "the picker lost its selection before submit",
    ).not.toHaveValue("");
  }

  await page.getByLabel("Your name").fill(client.name);
  await page.locator('input[type="email"]').fill(client.email);
  await page.locator('input[type="tel"]').fill("+15555550123");
  await page.getByRole("button", { name: /^book appointment$/i }).click();
  return { slotLabel };
}

/** Wait until the slot grid IS THE TARGET DATE'S and has settled.
 *
 *  THE ROOT CAUSE OF THIS SPEC'S EARLIER FAILURE. The grid renders for whatever
 *  `date` state holds, which starts at the studio's minDate (today). Filling
 *  the date updates the heading immediately but the slots refetch
 *  asynchronously, so a click placed too early lands on TODAY'S grid — and
 *  "7:00 AM" exists there too. The submitted instant was therefore in the past
 *  and the server refused it with "That time is no longer available", which
 *  looked like a conflict and was not one. The product was right; the test was
 *  racing it.
 *
 *  Both conditions are needed: the heading proves WHICH date the grid is for,
 *  and the absence of "Loading slots…" proves the refetch for that date has
 *  finished. */
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
  await expect(page.getByText(/loading slots/i)).toHaveCount(0, {
    timeout: 20_000,
  });
}

/** Wait until the booking is VISIBLE IN THE DATABASE.
 *
 *  Deliberately not an assertion on confirmation copy. This spec's whole claim
 *  is about attribution, and copy is the weakest possible evidence for it — my
 *  first version asserted /confirmed|booked|see you/i and failed while the
 *  booking had in fact been written correctly, which is a test that would also
 *  have passed on a page that said "booked" and attributed to the wrong
 *  practitioner. */
async function waitForAppointments(
  expected: number,
  page?: Page,
): Promise<{ practitioner_id: string | null; starts_at: string }[]> {
  const deadline = Date.now() + 20_000;
  let rows: { practitioner_id: string | null; starts_at: string }[] = [];
  while (Date.now() < deadline) {
    rows = await sql(
      `select a.practitioner_id, a.starts_at::text
         from public.appointments a
        where a.studio_id = $1
        order by a.starts_at, a.practitioner_id`,
      [seed.studioId],
    );
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 500));
  }
  // DIAGNOSTIC, not decoration. A bare length mismatch says the booking did not
  // land but not why, and the page is the only place the refusal is stated.
  if (page) {
    const body = (await page.locator("main").innerText().catch(() => "")) || "";
    const shown = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(-14)
      .join(" | ");
    throw new Error(
      `expected ${expected} appointment(s), found ${rows.length}. Page said: ${shown}`,
    );
  }
  return rows;
}

async function appointmentsOnDate(): Promise<
  { practitioner_id: string | null; starts_at: string; client_name: string }[]
> {
  return sql(
    `select a.practitioner_id, a.starts_at::text, c.name as client_name
       from public.appointments a
       join public.clients c on c.id = a.client_id
      where a.studio_id = $1
        and (a.starts_at at time zone $2)::date = $3::date
      order by a.starts_at, a.practitioner_id`,
    [seed.studioId, tz, bookDate],
  );
}

/** Hold the NEXT server-action POST until the test releases it.
 *
 *  Codex asked for "a deliberately delayed old result", and this is the only
 *  way to produce one: the race needs a studio-wide answer still in flight when
 *  the visitor narrows to a practitioner, which no amount of ordinary driving
 *  can arrange. Armed AFTER the first grid has loaded, so the held request is
 *  the "Next available" lookup rather than the initial slot fetch.
 *
 *  Every later POST continues normally, which matters: selecting a practitioner
 *  fires its own scoped slot fetch and that must not be held too, or the test
 *  would be asserting against a page that never finished rendering. */
async function holdNextServerAction(page: Page): Promise<{
  release: () => void;
  held: () => number;
}> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;
  await page.route("**/book/**", async (route) => {
    const request = route.request();
    if (
      request.method() !== "POST" ||
      !request.headers()["next-action"] ||
      held > 0
    ) {
      return route.continue();
    }
    held += 1;
    await gate;
    return route.continue();
  });
  return { release: () => release(), held: () => held };
}

test("the picker offers only active, service-eligible practitioners", async ({ page }) => {
  await page.goto(`/book/${seed.slug}`);
  // WAIT FOR THE SERVICE-SCOPED OPTIONS FETCH, which this test did not do and
  // which practitioner D exposed. The options are loaded by an effect keyed on
  // the service, so reading them straight after `selectOption` returns the
  // PREVIOUS list — the one fetched with a null serviceId, before any
  // service_practitioners filtering. Inactive C is excluded by the RPC itself
  // whatever the service, so the old assertion held on that stale list; D is
  // excluded ONLY by the service filter, so it needs the scoped answer.
  //
  // ARMED BEFORE THE FORM OPENS (Codex 4307203944). This fixture has exactly
  // ONE service and PublicBookForm selects it by default, so opening the form
  // ALREADY starts the service-scoped request. Registering the wait afterwards
  // races it, and if it lands while the date is being filled then
  // `selectOption(serviceId)` sets the value it already holds — React's state
  // does not change, no replacement request is made, and the wait times out
  // while the product behaved correctly. So the wait goes first and the
  // selectOption below is left as an explicit assertion of intent that nothing
  // depends on.
  const scopedOptions = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      Boolean(r.request().headers()["next-action"]) &&
      (r.request().postData() ?? "").includes(serviceId),
    { timeout: 20_000 },
  );
  await page.getByRole("button", { name: /new client/i }).first().click();
  await page.getByLabel("Date").fill(bookDate);
  await page.getByLabel("Service").selectOption(serviceId);
  await scopedOptions;

  const picker = page.getByTestId("practitioner-picker");
  await expect(picker).toBeVisible();
  // Settle on CONTENT STABILITY, not on a count and not on the answer I want:
  // the response above proves the fetch replied, not that React has
  // re-rendered. Polling for "the list stopped changing" bakes in no
  // conclusion — a picker that wrongly keeps D settles too, and the assertions
  // below then fail, which is the behaviour a real defect should produce.
  const readLabels = () => picker.locator("option").allTextContents();
  let previous = "";
  await expect
    .poll(
      async () => {
        const now = (await readLabels()).join("|");
        const stable = now === previous;
        previous = now;
        return stable;
      },
      { timeout: 20_000, intervals: [250, 250, 500] },
    )
    .toBe(true);
  const labels = await readLabels();

  // "Any available" is first and is the DEFAULT, so ignoring the picker books
  // exactly as the page did before G1.
  expect(labels[0]).toMatch(/any available/i);
  await expect(picker).toHaveValue("");

  expect(labels).toContain(A.displayName);
  expect(labels).toContain(B.displayName);
  // Inactive C is absent, and so is anyone not eligible for this service.
  expect(labels).not.toContain(C.displayName);
  // AND THE ELIGIBILITY HALF, which C cannot prove: D is ACTIVE and passes
  // every other filter, so its absence is attributable to service_practitioners
  // alone. loadEligiblePractitioners applies 0170's rule — the list exists, so
  // membership is required — and fails CLOSED if the eligibility read errors.
  expect(labels).not.toContain(D.displayName);
  // Non-vacuity for D itself: it really is a seeded, ACTIVE member of this
  // studio, so the exclusion above is a filter and not a missing fixture.
  expect(D.displayName).toBeTruthy();
  expect(D.practitionerId).not.toBe(A.practitionerId);
});

test("the public-assignment kill switch hides the picker entirely", async ({ page }) => {
  // THE P1 FROM REVIEW. `practitioner_capacity_booking_enabled` (0136) is the
  // operator's control over whether the PUBLIC path may assign a practitioner
  // at all. It defaults FALSE, so every LEGACY studio is in that state, and
  // shipping G1 without this gate would have ACTIVATED practitioner selection
  // on every open new-client studio — the activation this lane was told not to
  // perform.
  //
  // The gate is SERVER-SIDE: fetchPublicPractitionerOptionsAction returns no
  // options while the flag is off, and the control renders only when there is
  // more than one. So the proof is that the picker is absent even though this
  // studio has TWO eligible, active practitioners and the grid still works.
  await setStudioCapacityBookingEnabled(seed.studioId, false);
  try {
    await page.goto(`/book/${seed.slug}`);
    await page.getByRole("button", { name: /new client/i }).first().click();
    await page.getByLabel("Date").fill(bookDate);
    await page.getByLabel("Service").selectOption(serviceId);

    // The grid must still load: this gate removes a CHOICE, never booking.
    await expect(page.getByRole("button", { name: /^\d{1,2}:\d{2}/ }).first()).toBeVisible();
    await expect(page.getByTestId("practitioner-picker")).toHaveCount(0);
  } finally {
    // Restore for the rest of the suite, which runs serially on one worker.
    await setStudioCapacityBookingEnabled(seed.studioId, true);
  }
});

test("DIFFERENT practitioners hold the SAME instant, and the DB agrees", async ({ page }) => {
  const first = await bookPublicly(page, clientOne, { practitionerName: A.displayName });
  expect(await waitForAppointments(1, page)).toHaveLength(1);

  // The same slot label, so this is genuinely the same start instant.
  await bookPublicly(page, clientTwo, {
    practitionerName: B.displayName,
    slotLabel: first.slotLabel,
  });
  expect(await waitForAppointments(2, page)).toHaveLength(2);

  const rows = await appointmentsOnDate();
  expect(rows).toHaveLength(2);
  // Same instant...
  expect(rows[0].starts_at).toBe(rows[1].starts_at);
  // ...two DIFFERENT practitioners, and they are the two that were CHOSEN —
  // not the owner the pre-G1 path would have assigned to both.
  const chosen = new Set(rows.map((r) => r.practitioner_id));
  expect(chosen.size).toBe(2);
  expect(chosen).toContain(A.practitionerId);
  expect(chosen).toContain(B.practitionerId);
});

test("the SAME practitioner's taken instant is not offered, and is not double-booked", async ({ page }) => {
  // THE CONTROL for the test above. Narrowing the conflict scope to one
  // practitioner is only correct if that practitioner stays protected against
  // themselves — otherwise the parallel-booking test would be passing on a page
  // that had simply stopped checking conflicts.
  //
  // At the UI level the refusal is an ABSENCE: 0219's scoped loader removes the
  // taken instant from A's own grid, which is the page and the command agreeing
  // — exactly the property 0222 restored. The submitted-attempt refusal cannot
  // be driven from this page precisely because the page will not offer it, and
  // it is proved at command level instead:
  // tests/db/public-practitioner-booking.db.test.ts, "SAME practitioner, same
  // instant: the second booking is REFUSED".
  const before = await appointmentsOnDate();
  expect(before).toHaveLength(2);

  const takenLabel = (
    await sql<{ l: string }>(
      `select to_char((a.starts_at at time zone $2), 'FMHH12:MI AM') as l
         from public.appointments a
        where a.studio_id = $1 and a.practitioner_id = $3
        order by a.starts_at limit 1`,
      [seed.studioId, tz, A.practitionerId],
    )
  )[0].l;

  await page.goto(`/book/${seed.slug}`);
  await page.getByRole("button", { name: /new client/i }).first().click();
  await page.getByLabel("Date").fill(bookDate);
  await page.getByLabel("Service").selectOption(serviceId);
  await page.getByTestId("practitioner-picker").selectOption({ label: A.displayName });
  await waitForGrid(page, bookDate);

  // The grid must be NON-EMPTY, or "the taken slot is absent" would be
  // satisfied by a page that offered nothing at all.
  const anySlot = page.getByRole("button", { name: /^\d{1,2}:\d{2}\s*(AM|PM)$/i });
  await expect(anySlot.first()).toBeVisible({ timeout: 20_000 });
  expect(await anySlot.count()).toBeGreaterThan(0);

  // A's own taken instant is gone from A's own grid.
  await expect(
    page.getByRole("button", { name: takenLabel, exact: true }),
  ).toHaveCount(0);

  // And A holds exactly ONE appointment at that instant — never two.
  const aRows = await sql<{ n: string }>(
    `select count(*)::text as n from public.appointments
      where studio_id = $1 and practitioner_id = $2`,
    [seed.studioId, A.practitionerId],
  );
  expect(aRows[0].n).toBe("1");
  expect(await appointmentsOnDate()).toHaveLength(2);
});

test("a DELAYED studio-wide jump is discarded when the visitor narrows mid-flight", async ({
  page,
}) => {
  // THE BEHAVIOURAL PROOF for two findings that source ordering guards could
  // only pin by shape: the in-flight invalidation, and the synchronous ref that
  // makes the invalidation read the CURRENT selection rather than a stale one.
  //
  // "Next available" answers STUDIO-WIDE. Started under "Any available" and
  // still in flight when the visitor picks a practitioner, its answer is about
  // a different question -- and before the fix it still ran setDate(), jumping
  // the page to a date that practitioner may have no slots on, after the button
  // that started it had already disappeared.
  await page.goto(`/book/${seed.slug}`);
  await page.getByRole("button", { name: /new client/i }).first().click();
  await page.getByLabel("Date").fill(bookDate);
  await page.getByLabel("Service").selectOption(serviceId);
  await waitForGrid(page, bookDate);

  const picker = page.getByTestId("practitioner-picker");
  await expect(picker).toBeVisible();
  await expect(picker, "the jump must start under Any available").toHaveValue("");

  // BOTH LABELS. PublicBookForm has two jump surfaces sharing one handler
  // (see its comment at the onFindNext definition): the empty-slot path renders
  // "Next available" and the populated-slot path "Next available day". This
  // fixture's date HAS slots, so the populated label is the one on screen --
  // my first version anchored on /^next available$/i and never matched it.
  const jump = page.getByRole("button", { name: /^next available( day)?$/i });
  await expect(jump, "the jump is offered while no practitioner is chosen").toBeVisible();

  // ARM ONLY NOW, so the held POST is the jump and not the first slot fetch.
  const gate = await holdNextServerAction(page);
  await jump.click();
  await expect
    .poll(() => gate.held(), { timeout: 20_000 })
    .toBeGreaterThan(0);

  // THE WINDOW. The visitor narrows while the studio-wide answer is held.
  await picker.selectOption({ label: A.displayName });
  // The jump is withdrawn once a practitioner is chosen, which is the gate the
  // earlier finding added; assert it so this test also covers that.
  await expect(jump, "the studio-wide jump is not offered once narrowed").toHaveCount(0);

  // Release the stale answer, and WAIT FOR IT TO BE DELIVERED. Asserting
  // immediately after release is what made the first version of this test
  // vacuous: `toHaveValue(bookDate)` was already true at that instant, so it
  // passed before the released response could possibly apply setDate.
  const delivered = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      !!r.request().headers()["next-action"],
    { timeout: 20_000 },
  );
  gate.release();
  await delivered;

  // THEN SETTLE THE GRID, which is the second half of why the first version
  // could not fail. Selecting a practitioner refetches slots, and while
  // `loadingSlots` is true NEITHER the jump nor the Back control renders and
  // the date assertion is trivially satisfied -- the loading window answered
  // every negative assertion for me. waitForGrid asserts the heading for this
  // date AND that "loading slots" is gone, so what follows is read from a
  // settled page.
  //
  // Under a build without the invalidation this is also the first thing to
  // fail: the stale response moves the page, so the heading is for another
  // date and this times out.
  await waitForGrid(page, bookDate);

  // THE CLAIM: the page did not move.
  await expect(
    page.getByLabel("Date"),
    "a studio-wide answer the visitor narrowed away from must not move the page",
  ).toHaveValue(bookDate);
  // And left no navigation behind, since a discarded response never pushed
  // history.
  await expect(
    page.getByRole("button", { name: /back to previous result/i }),
    "a discarded jump must not leave a Back control",
  ).toHaveCount(0);
  await expect(
    picker,
    "the selection the visitor made must be the one that survived",
  ).toHaveValue(A.practitionerId);
});

test("history navigation does not survive a practitioner change", async ({ page }) => {
  // The third finding in this family: dateHistory holds dates reached by the
  // STUDIO-WIDE jump, the forward control hides once a practitioner is chosen,
  // but "Back to previous result" renders from that stack alone -- so Back
  // survived the scope change and could navigate to a studio-wide result the
  // chosen practitioner has no availability on, presented as a previous result.
  await page.goto(`/book/${seed.slug}`);
  await page.getByRole("button", { name: /new client/i }).first().click();
  await page.getByLabel("Date").fill(bookDate);
  await page.getByLabel("Service").selectOption(serviceId);
  await waitForGrid(page, bookDate);

  const picker = page.getByTestId("practitioner-picker");
  const jump = page.getByRole("button", { name: /^next available( day)?$/i });
  const back = page.getByRole("button", { name: /back to previous result/i });

  // A COMPLETED jump, so there is genuine history to strand.
  await expect(back, "no history before the first jump").toHaveCount(0);
  await jump.click();
  await expect(back, "a completed jump leaves a Back control").toBeVisible({
    timeout: 20_000,
  });
  const jumped = await page.getByLabel("Date").inputValue();
  expect(jumped, "the jump must have moved the page").not.toBe(bookDate);

  // Narrow. The history answered a question the visitor has stopped asking.
  await picker.selectOption({ label: A.displayName });

  // SETTLE FIRST. Both Back controls live inside the
  // `{loadingSlots ? … : slots.length === 0 ? … : …}` branch, so while the
  // scoped refetch is in flight neither renders and `toHaveCount(0)` passes
  // for a reason that has nothing to do with the history. That is precisely
  // how the first version of this test passed against a build with the clear
  // REMOVED.
  await waitForGrid(page, jumped);

  await expect(
    back,
    "studio-wide jump history must not survive a scope change -- Back would " +
      "navigate to a date this practitioner may have no availability on",
  ).toHaveCount(0);
});

test("a slot taken between render and submit is refused with actionable copy, and writes no client", async ({
  page,
}) => {
  // CODEX P2 4264946618, proved on the path that actually reaches a visitor.
  //
  // `no_practitioner_available` is answered by 0225's PRE-INSERT guard, which
  // returns before the later result mapping -- so the "just been taken"
  // sentence I had added there was dead code for a new client, and the
  // reachable surface showed the GENERIC error for an ordinary race. Third time
  // in this PR that a message sat behind a guard that returns first, which is
  // why this is proved through the rendered page and not by reading source.
  //
  // THE RACE IS ARRANGED, not waited for: the grid renders, a slot is chosen,
  // THEN every eligible practitioner is occupied at that instant, and only then
  // is the form submitted. That is precisely the window the message exists for.
  await page.goto(`/book/${seed.slug}`);
  await page.getByRole("button", { name: /new client/i }).first().click();
  await page.getByLabel("Date").fill(bookDate);
  await page.getByLabel("Service").selectOption(serviceId);

  // "Any available" stays selected -- the DEFAULT interaction the finding is
  // about.
  await expect(page.getByTestId("practitioner-picker")).toHaveValue("");
  await waitForGrid(page, bookDate);

  // THE FIRST OFFERED SLOT IS NOT NECESSARILY FREE FOR A, and taking `.first()`
  // on faith is what made this test red once "Any available" became a UNION.
  //
  // It had been passing for a reason it never stated. Before the union, the
  // default grid asked a STUDIO-WIDE question, which under capacity ON collects
  // every practitioner's conflicts -- so the earliest slot, already held by A
  // and B from the parallel-booking test above, was HIDDEN, and `.first()`
  // handed back a later time A happened to be free for. The union correctly
  // offers that earliest slot again, because the OWNER is free then. The test
  // then picked it, narrowed eligibility to A, and could not occupy A there:
  // `create_public_appointment_v2` answered `time_unavailable`, because A was
  // already booked at that instant.
  //
  // So the assumption, not the product, was wrong. State the requirement
  // instead: this test needs a slot that is OFFERED by default AND free for A,
  // because A is about to become the only eligible practitioner and must be
  // occupiable. Nothing about the claim under test changes.
  const slotButtons = page.getByRole("button", {
    name: /^\d{1,2}:\d{2}\s*(AM|PM)$/i,
  });
  await expect(slotButtons.first()).toBeVisible({ timeout: 20_000 });
  const offered = (await slotButtons.allTextContents()).map((t) => t.trim());
  let slotLabel = "";
  for (const label of offered) {
    if ((await heldAt(A.practitionerId, label)) === 0) {
      slotLabel = label;
      break;
    }
  }
  expect(
    slotLabel,
    "no offered slot is free for A, so A cannot be made the sole occupant",
  ).toMatch(/^\d{1,2}:\d{2}\s*(AM|PM)$/i);
  await page.getByRole("button", { name: slotLabel, exact: true }).click();

  // CLOSE THE WINDOW, through the real command so the fixture cannot be more
  // permissive than production. Each occupying booking gets its OWN client row:
  // one client holding two appointments at one instant could trip a
  // client-level rule and refuse for the wrong reason.
  //
  // Postgres parses "7:00 AM" directly, so the label needs no conversion --
  // my first attempt invented a to24h() helper for a problem that does not
  // exist.
  //
  // ONE ELIGIBLE PRACTITIONER, SO THE SCENARIO IS DETERMINISTIC. Two earlier
  // attempts failed on fixture detail rather than on the product: the first
  // occupied only A and B and the booking SUCCEEDED, because
  // `services_default_eligibility_trg` pins the OWNER to every new service and
  // the owner was eligible and free; the second derived the whole eligible set
  // and could not occupy one of them at the chosen instant.
  //
  // Restricting eligibility to A needs exactly ONE occupancy and removes every
  // unknown. Restored in `finally`, because this spec's fixture is shared and a
  // later reader should not inherit a narrowed service.
  const saved = await sql<{ practitioner_id: string }>(
    `select practitioner_id from public.service_practitioners where service_id = $1`,
    [serviceId],
  );
  try {
    await sql(`delete from public.service_practitioners where service_id = $1`, [serviceId]);
    await sql(
      `insert into public.service_practitioners (studio_id, service_id, practitioner_id)
       values ($1, $2, $3)`,
      [seed.studioId, serviceId, A.practitionerId],
    );

    // Occupy A at the chosen instant, through the real command so the fixture
    // cannot be more permissive than production. Postgres parses "7:00 AM"
    // directly, so the label needs no conversion.
    const occupant = await sql<{ id: string }>(
      `insert into public.clients (studio_id, name, email)
       values ($1, $2, $3) returning id`,
      [seed.studioId, "SYNTH-FETT occupy A", `occupy-a-${seed.runId.slice(0, 6)}@synth.local`],
    );
    const r = await sql<{ result: string }>(
      `select (public.create_public_appointment_v2(
                 $1, $2, $3,
                 (($4::text || ' ' || $5::text)::timestamp at time zone $6),
                 $7, null, null, $8)).result as result`,
      [
        seed.studioId,
        occupant[0]!.id,
        serviceId,
        bookDate,
        slotLabel,
        tz,
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
        A.practitionerId,
      ],
    );
    expect(
      r[0]?.result,
      `the only eligible practitioner must actually be occupied at ${slotLabel}`,
    ).toBe("created");

    // THE PREMISE, asserted rather than assumed: the resolver must now find
    // nobody. Without this the final expectation could pass for some unrelated
    // reason, and two of my attempts at this test did exactly that.
    const none = await sql<{ resolved: string | null }>(
      `select public.resolve_public_any_available_practitioner(
                $1, $2,
                (($3::text || ' ' || $4::text)::timestamp at time zone $5),
                (($3::text || ' ' || $4::text)::timestamp at time zone $5)
                  + make_interval(mins => (select default_duration_minutes
                                             from public.services where id = $2))
              )::text as resolved`,
      [seed.studioId, serviceId, bookDate, slotLabel, tz],
    );
    expect(
      none[0]?.resolved,
      "nobody eligible may be free, or the refusal under test cannot occur",
    ).toBeNull();

    await page.getByLabel("Your name").fill("SYNTH-FETT Stale Slot");
    await page.locator('input[type="email"]').fill(`stale-${randomUUID().slice(0, 8)}@synth.local`);
    await page.locator('input[type="tel"]').fill("+15555550199");
    await page.getByRole("button", { name: /^book appointment$/i }).click();

    // THE CLAIM, CORRECTED AFTER THREE FAILURES, and the correction is the
    // finding rather than a concession.
    //
    // I expected "that time has just been taken" -- the command's
    // `no_practitioner_available` copy. The page shows "That time is no longer
    // available" instead, because the ACTION's own pre-commit slot
    // re-verification (actions.ts:920) refuses FIRST: with no practitioner
    // submitted it asks a studio-wide question, the instant is now occupied,
    // and it never calls the command at all.
    //
    // So this scenario is ALREADY actionable for the visitor, and the generic
    // error Codex found is NOT reachable from the new-client UI this way. The
    // window where it IS reachable is between that re-verification and the
    // command taking its locks -- sub-second, inside one server action, and not
    // arrangeable from a browser. The mapping fix is still right (the
    // existing-client path and any other caller reach it), and it is proved at
    // command level in tests/db/public-any-available-eligibility plus a source
    // guard that the EARLY boundary carries the copy.
    //
    // What this test therefore proves, honestly stated: a slot taken between
    // render and submit is refused with copy the visitor can act on, and
    // writes no client row. That is worth having, and it is not proof of the
    // code path I set out to prove.
    await expect(
      page.getByText(/that time is no longer available/i),
      "a stale-slot race must be refused with actionable copy, not the generic error",
    ).toBeVisible({ timeout: 20_000 });

    // AND NO ORPHAN: the refusal happened before the client was created.
    const orphans = await sql<{ n: string }>(
      `select count(*)::text as n from public.clients
        where studio_id = $1 and name = $2`,
      [seed.studioId, "SYNTH-FETT Stale Slot"],
    );
    expect(orphans[0].n, "a refused booking must write no client row").toBe("0");
  } finally {
    // RESTORE ONLY WHAT CAN BE RE-CREATED, and the exception is not a shortcut.
    // A database guard refuses to "mark inactive practitioner … eligible for a
    // service", so the saved row belonging to the deliberately-INACTIVE
    // practitioner C cannot be re-inserted -- my first restore attempt failed
    // on exactly that. Not restoring it changes nothing observable: every
    // eligibility decision also requires `active`, so a row for an inactive
    // practitioner cannot affect any outcome. Filtering is therefore faithful,
    // where blanket re-insertion is impossible.
    await sql(`delete from public.service_practitioners where service_id = $1`, [serviceId]);
    for (const row of saved) {
      const active = await sql<{ ok: boolean }>(
        `select active as ok from public.practitioners where id = $1`,
        [row.practitioner_id],
      );
      if (!active[0]?.ok) continue;
      await sql(
        `insert into public.service_practitioners (studio_id, service_id, practitioner_id)
         values ($1, $2, $3) on conflict do nothing`,
        [seed.studioId, serviceId, row.practitioner_id],
      );
    }
  }
});

/** How many appointments one practitioner holds at a given slot LABEL on the
 *  booking date. Deliberately keyed by label rather than by a count of all
 *  rows: this file is serial and shared, so an absolute total couples a test to
 *  everything that ran before it. */
async function heldAt(practitionerId: string, label: string): Promise<number> {
  const rows = await sql<{ n: string }>(
    `select count(*)::text as n
       from public.appointments
      where studio_id = $1
        and practitioner_id = $2
        and to_char((starts_at at time zone $3), 'FMHH12:MI AM') = $4`,
    [seed.studioId, practitionerId, tz, label],
  );
  return Number(rows[0].n);
}

/** Render the public grid for "Any available" — the DEFAULT choice, i.e. the
 *  picker deliberately left alone — and return the visible slot labels. */
async function anyAvailableLabels(page: Page): Promise<string[]> {
  await page.goto(`/book/${seed.slug}`);
  await page.getByRole("button", { name: /new client/i }).first().click();
  await page.getByLabel("Date").fill(bookDate);
  await page.getByLabel("Service").selectOption(serviceId);
  // The picker is present (two eligible practitioners) and is NOT touched, so
  // its value is "" — "Any available". Asserted, because a default that
  // silently became a named practitioner would make every claim below vacuous.
  await expect(page.getByTestId("practitioner-picker")).toHaveValue("");
  await waitForGrid(page, bookDate);
  const slots = page.getByRole("button", { name: /^\d{1,2}:\d{2}\s*(AM|PM)$/i });
  await expect(slots.first()).toBeVisible({ timeout: 20_000 });
  return (await slots.allTextContents()).map((t) => t.trim());
}

test('"Any available" offers a time only the OTHER practitioner is free for', async ({
  page,
}) => {
  // CODEX P1 4265558721 — THE BEHAVIOURAL PROOF.
  //
  // "Any available" passed NULL, and getAvailableSlots derives capacityOn from
  // `flag && practitionerId != null`, so NULL took the STUDIO-WIDE branch. Under
  // capacity ON that branch is wrong in both directions; this proves the
  // false-negative half, which is the one a visitor actually loses bookings to:
  //
  //   capacity ON fans a studio-wide closure out to one reservation row PER
  //   practitioner, so the studio-wide reservation filter (.eq("studio_id", …))
  //   collects EVERY practitioner's conflicts. One practitioner booked at a
  //   time therefore HID that time from the default grid while another eligible
  //   practitioner was free for it.
  //
  // THE CONTROL IS INSIDE THIS TEST, in step 4. "The slot is still offered"
  // alone would also pass on a grid that had simply stopped filtering
  // conflicts, which is a worse bug than the one being fixed. So the same label
  // must DISAPPEAR once BOTH eligible practitioners hold it. Present-then-absent
  // is a union; present-then-present is no filter at all.
  //
  // Self-contained by construction: it discovers its own slot and books both
  // halves through the real page, so it does not depend on what earlier tests
  // in this serial file left behind, and it inserts no appointment rows
  // directly — a direct INSERT would skip the shadow-reservation writers and
  // the grid would never see the conflict at all.

  // THE ELIGIBLE SET IS DERIVED, NOT ASSUMED — and assuming it is how the
  // first version of this test was wrong. It booked A and B and expected the
  // slot to vanish, but 0134 carries TWO auto-eligibility triggers
  // (`default_eligibility_for_service` at service insert,
  // `default_eligibility_for_practitioner` at practitioner insert), so this
  // studio's eligible set is the OWNER **plus** A and B. The owner would still
  // have been free, the slot would still have been offered, and the control
  // would have failed while the code was right.
  const eligible = await sql<{ id: string; display_name: string }>(
    `select p.id, p.display_name
       from public.practitioners p
      where p.studio_id = $1
        and p.active = true
        and p.role in ('owner', 'practitioner')
        and (
          not exists (
            select 1 from public.service_practitioners sp
             where sp.service_id = $2
          )
          or exists (
            select 1 from public.service_practitioners sp
             where sp.service_id = $2 and sp.practitioner_id = p.id
          )
        )
      order by p.display_name`,
    [seed.studioId, serviceId],
  );
  expect(
    eligible.length,
    "the union claim needs at least two eligible practitioners",
  ).toBeGreaterThanOrEqual(2);

  // 1. Discover a slot EVERY eligible practitioner is free for, taken from the
  //    END of the day so it cannot collide with the earliest-slot bookings the
  //    earlier tests in this serial file make.
  await page.goto(`/book/${seed.slug}`);
  await page.getByRole("button", { name: /new client/i }).first().click();
  await page.getByLabel("Date").fill(bookDate);
  await page.getByLabel("Service").selectOption(serviceId);
  await page
    .getByTestId("practitioner-picker")
    .selectOption({ label: eligible[0].display_name });
  await waitForGrid(page, bookDate);
  const firstSlots = page.getByRole("button", {
    name: /^\d{1,2}:\d{2}\s*(AM|PM)$/i,
  });
  await expect(firstSlots.first()).toBeVisible({ timeout: 20_000 });
  const target = (await firstSlots.last().textContent())?.trim() ?? "";
  expect(target, "no slot label was discoverable").toMatch(
    /^\d{1,2}:\d{2}\s*(AM|PM)$/i,
  );
  for (const e of eligible) {
    expect(
      await heldAt(e.id, target),
      `${e.display_name} must start free at the target instant`,
    ).toBe(0);
  }

  // 2. Book the FIRST eligible there, through the real page and real command.
  await bookPublicly(page, newClientIdentity(seed.runId, "AnyAvail0"), {
    practitionerName: eligible[0].display_name,
    slotLabel: target,
  });
  await expect
    .poll(() => heldAt(eligible[0].id, target), { timeout: 20_000 })
    .toBe(1);
  expect(
    await heldAt(eligible[1].id, target),
    "a second eligible practitioner must still be free, or this proves nothing",
  ).toBe(0);

  // 3. THE FINDING. One is busy, the others are free, nobody is chosen ->
  //    the time must STILL be offered.
  const withOneBusy = await anyAvailableLabels(page);
  expect(
    withOneBusy.length,
    "the default grid must be non-empty, or the assertion below is vacuous",
  ).toBeGreaterThan(0);
  expect(
    withOneBusy,
    'one practitioner being booked must not remove the time from "Any available" ' +
      "while another eligible practitioner is free for it",
  ).toContain(target);

  // 4. THE CONTROL. Book EVERY remaining eligible practitioner at the same
  //    instant. Now nobody eligible is free, so the union must drop it. This is
  //    what separates a union from a grid that stopped checking conflicts: a
  //    present-then-present result would mean the filter is simply gone, which
  //    is a worse defect than the one being fixed.
  for (let i = 1; i < eligible.length; i++) {
    await bookPublicly(page, newClientIdentity(seed.runId, `AnyAvail${i}`), {
      practitionerName: eligible[i].display_name,
      slotLabel: target,
    });
    await expect
      .poll(() => heldAt(eligible[i].id, target), { timeout: 20_000 })
      .toBe(1);
  }

  const withAllBusy = await anyAvailableLabels(page);
  expect(
    withAllBusy.length,
    "still non-empty: the day has other times, so an empty grid would mean " +
      "something unrelated broke",
  ).toBeGreaterThan(0);
  expect(
    withAllBusy,
    "with EVERY eligible practitioner booked the time must disappear -- if it " +
      "survives here the grid is not unioning, it is not filtering",
  ).not.toContain(target);
});
