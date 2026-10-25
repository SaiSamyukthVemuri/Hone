import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  seedE2eClient,
  setStudioCapacityEnabled,
  setStudioCapacityBookingEnabled,
  seedPractitionerDefault,
  getE2eServiceId,
  seedServiceEligibility,
  getClientAppointmentsWithPractitioner,
  type E2eSeed,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { markResendLedger, readResendLedger } from "./helpers/resend-ledger";

// SCH-001. An owner-created booking for ANOTHER practitioner emails the ASSIGNED
// practitioner (not the owner who clicked Confirm), and the appointment detail
// page names that practitioner. Driven through the real client-profile UI on a
// synthetic capacity-ON studio, read back from the fake Resend capture ledger
// (lib/email/e2e-fake-resend.ts) and the database. Unit proof of the recipient
// logic already exists (tests/app/calendar/booking-post-commit-safety.test.ts);
// what no test had was the delivered email itself. Synthetic data only.

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;
let serviceId: string;
let clientId: string;
let B: { email: string; displayName: string; practitionerId: string };

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  serviceId = await getE2eServiceId(seed.studioId);
  ({ clientId } = await seedE2eClient(seed));
  B = await seedE2eMember(seed);
  await setStudioCapacityEnabled(seed.studioId, true);
  await setStudioCapacityBookingEnabled(seed.studioId, true);
  await seedServiceEligibility(seed.studioId, serviceId, B.practitionerId);
  for (let d = 0; d <= 6; d++) {
    await seedPractitionerDefault(seed.studioId, B.practitionerId, d, true, "06:00", "22:00");
  }
});

const SLOT = /^\d{1,2}:\d{2}\s?(AM|PM)$/i;

test("owner books for B: B is emailed, the owner is not, and the detail page names B", async ({ page }) => {
  await loginByMagicLink(page, seed.ownerEmail);
  await page.goto(`/clients/${clientId}`);
  await page.getByRole("button", { name: /\+ Book appointment/i }).click();

  const selector = page.getByLabel("Practitioner");
  await expect(selector).toBeVisible({ timeout: 20_000 });
  await selector.selectOption({ label: B.displayName });
  const slots = page.getByRole("button", { name: SLOT });
  await expect(slots.first()).toBeVisible({ timeout: 20_000 });
  await slots.last().click();
  await expect(page.getByTestId("assigned-practitioner")).toContainText(B.displayName);

  const mark = markResendLedger();
  await page.getByRole("button", { name: /^Confirm$/ }).click();
  await page.waitForURL(/\/calendar\/[0-9a-f-]{36}/, { timeout: 20_000 });

  // The booking is B's, in the database.
  const appts = await getClientAppointmentsWithPractitioner(seed.studioId, clientId);
  expect(appts).toHaveLength(1);
  expect(appts[0].practitioner_id).toBe(B.practitionerId);

  // The detail page names B.
  await expect(page.getByText(B.displayName).first()).toBeVisible();

  // The assigned practitioner was emailed. The send happens after the commit,
  // so poll the ledger rather than assume it has landed.
  const toB = () =>
    readResendLedger(mark).filter((r) => r.to.toLowerCase() === B.email.toLowerCase());
  await expect.poll(() => toB().length, { timeout: 20_000, message: "no email to the assigned practitioner" }).toBeGreaterThan(0);

  // The owner who made the booking did NOT receive the practitioner notification.
  const ownerSubjects = readResendLedger(mark)
    .filter((r) => r.to.toLowerCase() === seed.ownerEmail.toLowerCase())
    .map((r) => r.subject);
  for (const record of toB()) {
    expect(ownerSubjects, "the owner received B's notification").not.toContain(record.subject);
  }
});
