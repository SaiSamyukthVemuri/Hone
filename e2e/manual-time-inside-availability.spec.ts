import { test, expect } from "@playwright/test";
import { seedE2eStudio, seedE2eClient, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// SMART SUGGESTIONS ARE NOT AVAILABILITY — the browser proof of the calm path.
//
// Chloe's report: smart scheduling suggests one time, she deliberately wants a
// different one, and although her choice is inside her real working hours and
// conflict-free, Hone made her tick a control saying she was booking OUTSIDE
// her availability and confirm "I understand this is outside my normal
// availability". Both statements were false.
//
// The seeded studio is open 06:00-22:00 every day with a 30-minute service and
// no buffer, so the packed suggestions are the hourly walk (06:00, 07:00, ...,
// 21:00) plus the closing-edge anchor 21:30. 14:20 is therefore NOT a
// suggestion, while being unambiguously inside working hours.
//
// This is the arm a source pin cannot cover: whether the practitioner is
// actually shown alarming copy. It asserts on the rendered UI AND on the row
// the database ends up holding.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true });

const ALARMING = [
  /outside your normal availability/i,
  /outside your published/i,
  /out-of-hours/i,
];

test("a manual time inside working hours books calmly, with no outside-hours language", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);

  await page.goto(`/clients/${clientId}`);
  await page.getByRole("button", { name: /\+ Book appointment/i }).click();

  // The list is labelled as SUGGESTIONS, not as the set of available times.
  await expect(page.getByText(/^Suggested times$/i)).toBeVisible({
    timeout: 20_000,
  });

  // The calm secondary action exists and is not dressed as an override.
  const chooseAnother = page.getByLabel(/Choose another time/i);
  await expect(chooseAnother).toBeVisible();
  await chooseAnother.check();

  await page.locator('input[type="date"]').fill("2099-06-15");
  await page.locator('input[type="time"]').fill("14:20");

  // The calm confirmation, and NOTHING alarming.
  await expect(
    page.getByText(/inside your working hours/i),
  ).toBeVisible({ timeout: 20_000 });
  for (const pattern of ALARMING) {
    await expect(page.getByText(pattern)).toHaveCount(0);
  }
  // No acknowledgement is demanded for an ordinary working time.
  await expect(
    page.getByLabel(/I confirm I want to book this out-of-hours time/i),
  ).toHaveCount(0);

  // The primary action reads as an ordinary booking.
  const confirm = page.getByRole("button", { name: /^Confirm$/ });
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await page.waitForURL(/\/calendar\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const appointmentId = page.url().split("/").pop() as string;

  // THE PERSISTED PROOF. allow_outside_availability must never have been sent:
  // booked_outside_availability is stamped from it (migration 0174), the audit
  // record records it, an authorising owner is attributed alongside it, and the
  // buffer trigger skips any row carrying it (0152). A green UI with this
  // column true would still be the original defect, just quieter.
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

  // And the audit trail must not describe it as an out-of-hours exception.
  const audit = await sql<{ details: Record<string, unknown> }>(
    `select details from public.appointment_audit
      where appointment_id = $1 and action = 'created'`,
    [appointmentId],
  );
  expect(audit).toHaveLength(1);
  expect(audit[0].details.outside_availability).toBe(false);
});
