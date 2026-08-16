import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eClient,
  setStudioBufferMinutes,
  seedFutureAppointmentAt,
  getOwnerPractitionerId,
  getStudioTimezone,
  sql,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";

// A BUFFER APPROVAL BELONGS TO EXACTLY ONE BOOKING CANDIDATE.
//
// The buffer override is offered only after the database refuses a specific
// time with `buffer_conflict`, and accepting it posts
// allow_outside_availability -- which is persisted as
// booked_outside_availability, stamped into the audit record with an
// authorising owner, and disables the buffer trigger for that row forever.
//
// The leak this spec exists to prevent: approve the override for candidate A,
// then change your mind and book candidate B instead. If the approval survives
// the change, B is submitted with the flag even though the server never
// refused B and the owner never agreed to anything about it. An ordinary,
// conflict-free appointment is then permanently filed as an exception.
//
// The fix binds the approval to the IDENTITY of the candidate it was issued
// for, so any change to instant / service / practitioner revokes it. This spec
// proves the revocation end to end, and checks the DATABASE rather than the
// screen, because a green UI with the column set would still be the defect.
//
// Seeded studio is open 06:00-22:00, buffer 30, booking service 30 min.
// Neighbour appointment 15:00-16:00, so:
//   A = 14:30  -> 14:30-15:00, touches the neighbour, inside the buffer -> refused
//   B = 11:00  -> 11:00-11:30, clean, ordinary, must book with the flag FALSE

const A_BUFFERED = "14:30";
const B_CLEAN = "11:00";

test("a buffer approval for one time does not travel to another", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  await setStudioBufferMinutes(seed.studioId, 30);
  const { clientId } = await seedE2eClient(seed);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const tz = await getStudioTimezone(seed.studioId);
  await seedFutureAppointmentAt(seed.studioId, ownerId, clientId, tz, "15:00");

  await loginByMagicLink(page, seed.ownerEmail);
  await page.goto(`/clients/${clientId}`);
  await page.getByRole("button", { name: /\+ Book appointment/i }).click();

  await page.getByLabel(/Choose another time/i).check();
  const timeInput = page.locator('input[type="time"]');
  await expect(timeInput).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Checking your working hours/i)).toHaveCount(0, {
    timeout: 20_000,
  });

  // 1) Candidate A is refused on the buffer, and the owner APPROVES it.
  await timeInput.fill(A_BUFFERED);
  await page.getByRole("button", { name: /^Confirm$/ }).click();
  const ack = page.getByRole("checkbox", { name: /Book it anyway/i });
  await expect(ack).toBeVisible({ timeout: 20_000 });
  await ack.check();
  await expect(ack).toBeChecked();

  // 2) The owner changes their mind and picks a clean time instead. The
  //    approval must be revoked the moment the candidate changes -- the whole
  //    amber panel belongs to A and must go with it.
  await timeInput.fill(B_CLEAN);
  await expect(page.getByText(/It does not overlap one/i)).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /Book it anyway/i })).toHaveCount(0);
  // B is an ordinary in-hours time, so the calm confirmation is what shows.
  await expect(page.getByText(/inside your working hours/i)).toBeVisible({
    timeout: 20_000,
  });

  // 3) Book B. It must go through as an ORDINARY appointment.
  const confirm = page.getByRole("button", { name: /^Confirm$/ });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await page.waitForURL(/\/calendar\/[0-9a-f-]{36}/i, { timeout: 20_000 });
  const appointmentId = page.url().split("/").pop() as string;

  // THE PERSISTED PROOF. A's approval must not have followed B here.
  const rows = await sql<{
    booked_outside_availability: boolean;
    outside_availability_authorized_by_practitioner_id: string | null;
    starts_at: string;
  }>(
    `select booked_outside_availability,
            outside_availability_authorized_by_practitioner_id,
            starts_at
       from public.appointments where id = $1`,
    [appointmentId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].booked_outside_availability).toBe(false);
  expect(rows[0].outside_availability_authorized_by_practitioner_id).toBeNull();

  const audit = await sql<{ details: Record<string, unknown> }>(
    `select details from public.appointment_audit
      where appointment_id = $1 and action = 'created'`,
    [appointmentId],
  );
  expect(audit).toHaveLength(1);
  expect(audit[0].details.outside_availability).toBe(false);
});
