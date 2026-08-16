import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClient,
  seedConfirmedAppointment,
  setStudioBufferMinutes,
  getE2eServiceId,
  getOwnerPractitionerId,
  getStudioTimezone,
  sql,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { addDays, startOfWeek, todayInTz, utcInstantFromLocal } from "../lib/booking/tz";

// A BUFFER EXCEPTION BELONGS TO ONE EXACT BOOKING CANDIDATE — INCLUDING ITS CLIENT.
//
// Quick Book is the one surface where the client can change without touching
// the service, practitioner, time or duration. If the buffer approval is keyed
// only on those, then:
//
//   1. client A is refused on the buffer and the owner acknowledges it;
//   2. the owner presses "Change" and selects client B;
//   3. every other dimension is identical, so the key is unchanged;
//   4. the stale approval still applies and B is submitted with
//      allow_outside_availability=true -- for an appointment the server never
//      refused and the owner never acknowledged.
//
// Booking B at the same instant is itself buffer-conflicting (the buffer is a
// property of the PRACTITIONER's calendar, not the client), so the honest
// outcome is a FRESH refusal requiring a NEW acknowledgement. What must never
// happen is the stale TRUE exception riding along.
//
// DATE DISCIPLINE: this spec pins an explicit date one week out and navigates
// the calendar to that week, so nothing depends on the wall-clock time the
// suite happens to run at. A today-relative fixture would pass all morning and
// fail after the chosen hour had passed.

const NEIGHBOUR_LOCAL = "15:00"; // seeded 60-min appointment -> 15:00-16:00
const BUFFERED_LOCAL = "14:30"; // 30-min service -> 14:30-15:00, inside the 30-min buffer

const DRAWER = (page: Page) =>
  page.getByRole("dialog", { name: "New appointment" });

const bufferAck = (page: Page) =>
  page.getByRole("checkbox", { name: /Book it anyway/i });

async function clientName(clientId: string): Promise<string> {
  const rows = await sql<{ name: string }>(
    `select name from public.clients where id = $1`,
    [clientId],
  );
  return rows[0].name;
}

async function selectClient(page: Page, name: string) {
  const d = DRAWER(page);
  await d.getByPlaceholder("Find existing client").fill(name);
  await d.getByRole("button", { name: new RegExp(escapeRe(name)) }).first().click();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("a buffer approval for one client does not travel to another", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  await setStudioBufferMinutes(seed.studioId, 30);
  const serviceId = await getE2eServiceId(seed.studioId);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const tz = await getStudioTimezone(seed.studioId);

  const { clientId: clientAId } = await seedE2eClient(seed);
  const { clientId: clientBId } = await seedE2eClient(seed);
  const nameA = await clientName(clientAId);
  const nameB = await clientName(clientBId);

  // A fixed future date, and the week that contains it.
  const targetDate = addDays(todayInTz(tz), 7);
  const week = startOfWeek(targetDate);

  // The neighbour that creates the buffer, on the owner's calendar.
  const nStart = utcInstantFromLocal(targetDate, NEIGHBOUR_LOCAL, tz);
  const nEnd = new Date(nStart.getTime() + 60 * 60_000);
  await seedConfirmedAppointment(
    seed.studioId,
    ownerId,
    clientAId,
    nStart.toISOString(),
    nEnd.toISOString(),
  );

  await loginByMagicLink(page, seed.ownerEmail);
  await page.goto(`/calendar?week=${week}`);
  await page
    .getByRole("button", { name: `Open quick-book draft for ${targetDate}` })
    .click();
  const d = DRAWER(page);
  await expect(d).toBeVisible({ timeout: 20_000 });

  // 1) Client A, the buffer-proximate time, refused, and ACKNOWLEDGED.
  await selectClient(page, nameA);
  await d.getByRole("combobox").first().selectOption(serviceId);
  await d.getByLabel(/Choose another time/i).check();
  const timeInput = d.locator('input[type="time"]');
  await expect(timeInput).toBeVisible({ timeout: 20_000 });
  await expect(d.getByText(/Checking your working hours/i)).toHaveCount(0, {
    timeout: 20_000,
  });
  await timeInput.fill(BUFFERED_LOCAL);

  const save = d.getByRole("button", { name: /^Book appointment$/ });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(bufferAck(page)).toBeVisible({ timeout: 20_000 });
  await bufferAck(page).check();
  await expect(bufferAck(page)).toBeChecked();

  // 2) Swap ONLY the client. Service, practitioner, time and duration are
  //    untouched -- which is exactly why a key that omits the client cannot
  //    tell these two appointments apart.
  await d.getByRole("button", { name: /^Change$/ }).click();
  await selectClient(page, nameB);

  // 3) THE REPRODUCTION POINT. The approval belonged to A.
  await expect(bufferAck(page)).toHaveCount(0);
  await expect(d.getByText(/It does not overlap one/i)).toHaveCount(0);

  // 4) Submitting for B must not carry A's exception. B collides with the same
  //    buffer, so the honest result is a fresh refusal and a NEW acknowledgement.
  await expect(save).toBeEnabled();
  await save.click();
  await expect(bufferAck(page)).toBeVisible({ timeout: 20_000 });
  await expect(bufferAck(page)).not.toBeChecked();

  // 5) THE PERSISTED PROOF: nothing was written for B at all, and certainly
  //    nothing carrying the exception.
  const bRows = await sql<{ id: string; booked_outside_availability: boolean }>(
    `select id, booked_outside_availability
       from public.appointments where studio_id = $1 and client_id = $2`,
    [seed.studioId, clientBId],
  );
  expect(bRows).toHaveLength(0);
});
