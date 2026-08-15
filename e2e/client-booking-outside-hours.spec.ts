import { test, expect } from "@playwright/test";
import { seedE2eStudio, seedE2eClient, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Client-page outside-hours booking (owner flow). The owner opens "Choose
// another time", enters a genuinely out-of-hours time, and only THEN is shown
// the warning and the acknowledgement — which still gate the booking.
//
// This spec changed shape with the smart-suggestions split. It used to check
// the warning immediately on ticking a control called "Book outside your normal
// availability", because that control was the only way to type any time at all.
// Now the control is neutral and the warning is a CONSEQUENCE of the time
// chosen, so the assertion moved to after the time is entered. The out-of-hours
// copy itself is deliberately unchanged: for 23:30 on a 06:00-22:00 day it is
// simply true.
//
// The calm counterpart — a manual time INSIDE working hours, which must show
// none of this — is e2e/manual-time-inside-availability.spec.ts. The pair is
// the point: same control, opposite outcomes, decided by the real window.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true });

test("owner books an out-of-hours appointment from the client page", async ({ page }) => {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  await loginAsOwner(page, seed);

  await page.goto(`/clients/${clientId}`);
  await page.getByRole("button", { name: /\+ Book appointment/i }).click();

  // The manual-time control is neutral: no warning before a time is chosen.
  const chooseAnother = page.getByLabel(/Choose another time/i);
  await expect(chooseAnother).toBeVisible({ timeout: 20_000 });
  await chooseAnother.check();
  await expect(
    page.getByText(/This time is outside your normal availability/i),
  ).toHaveCount(0);

  // A future date + an out-of-hours time (23:30, outside the seeded
  // 06:00–22:00 window).
  await page.locator('input[type="date"]').fill("2099-06-15");
  await page.locator('input[type="time"]').fill("23:30");

  // NOW the explicit warning appears, because now it is true.
  await expect(
    page.getByText(/This time is outside your normal availability/i),
  ).toBeVisible({ timeout: 20_000 });

  await page.getByLabel(/I confirm I want to book this out-of-hours time/i).check();
  await page.getByRole("button", { name: /Book out-of-hours/i }).click();

  // Success redirects to the created appointment on the calendar.
  await page.waitForURL(/\/calendar\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const appointmentId = page.url().split("/").pop() as string;

  // The override semantics are UNCHANGED for a genuinely out-of-hours booking:
  // the row still records it, and still attributes the authorising owner.
  const rows = await sql<{
    booked_outside_availability: boolean;
    outside_availability_authorized_role: string | null;
  }>(
    `select booked_outside_availability, outside_availability_authorized_role
       from public.appointments where id = $1`,
    [appointmentId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].booked_outside_availability).toBe(true);
  expect(rows[0].outside_availability_authorized_role).toBe("owner");
});
