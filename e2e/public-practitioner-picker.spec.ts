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
  // Inactive: must never appear in the picker, and must never be bookable.
  await setPractitionerActive(C.practitionerId, false);

  // LIVE, or a practitioner choice buys attribution without parallelism and the
  // first assertion below would be testing 0136's model instead of G1's.
  await setStudioCapacityEnabled(seed.studioId, true);
  await setStudioCapacityBookingEnabled(seed.studioId, true);

  // The service-insert trigger seeds only the OWNER as eligible, so A and B
  // must be made eligible explicitly or the picker correctly hides them.
  await seedServiceEligibility(seed.studioId, serviceId, A.practitionerId);
  await seedServiceEligibility(seed.studioId, serviceId, B.practitionerId);

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

test("the picker offers only active, service-eligible practitioners", async ({ page }) => {
  await page.goto(`/book/${seed.slug}`);
  await page.getByRole("button", { name: /new client/i }).first().click();
  await page.getByLabel("Date").fill(bookDate);
  await page.getByLabel("Service").selectOption(serviceId);

  const picker = page.getByTestId("practitioner-picker");
  await expect(picker).toBeVisible();
  const labels = await picker.locator("option").allTextContents();

  // "Any available" is first and is the DEFAULT, so ignoring the picker books
  // exactly as the page did before G1.
  expect(labels[0]).toMatch(/any available/i);
  await expect(picker).toHaveValue("");

  expect(labels).toContain(A.displayName);
  expect(labels).toContain(B.displayName);
  // Inactive C is absent, and so is anyone not eligible for this service.
  expect(labels).not.toContain(C.displayName);
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
