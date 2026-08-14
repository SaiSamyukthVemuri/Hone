import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  seedE2eClient,
  setStudioCapacityEnabled,
  setStudioCapacityBookingEnabled,
  setStudioTimeFormat,
  setPractitionerActive,
  seedPractitionerDefault,
  seedFutureAppointmentAt,
  getClientAppointmentsWithPractitioner,
  getAppointmentAuditActions,
  getStudioTimezone,
  getOwnerPractitionerId,
  type E2eSeed,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";

// PR B Part 4 Item 7, owner-only practitioner reassignment on the SHARED Move
// workflow, driven through the REAL appointment-detail UI and verified against the
// DB. Owner O; active A + B; inactive C (absent); one client. Never Willow.

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;
let seedTz: string;
let clientId: string;
let A: { email: string; displayName: string; practitionerId: string };
let B: { email: string; displayName: string; practitionerId: string };
let C: { email: string; displayName: string; practitionerId: string };

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  seedTz = await getStudioTimezone(seed.studioId);
  ({ clientId } = await seedE2eClient(seed));
  A = await seedE2eMember(seed);
  B = await seedE2eMember(seed);
  C = await seedE2eMember(seed);
  await setPractitionerActive(C.practitionerId, false);
  await setStudioCapacityEnabled(seed.studioId, true);
  await setStudioCapacityBookingEnabled(seed.studioId, true);
  await setStudioTimeFormat(seed.studioId, "12h");
  for (let d = 0; d <= 6; d++) {
    await seedPractitionerDefault(seed.studioId, A.practitionerId, d, true, "06:00", "22:00");
    await seedPractitionerDefault(seed.studioId, B.practitionerId, d, true, "06:00", "22:00");
  }
});

const SLOT = /^\d{1,2}:\d{2}\s?(AM|PM)$/i;
async function openMove(page: Page, apptId: string) {
  await page.goto(`/calendar/${apptId}`);
  await page.getByRole("button", { name: /^Move appointment$/ }).click();
  return page.getByRole("dialog", { name: "Move appointment" });
}

test("owner sees the selector (inactive C absent) and changing the target clears the picked time", async ({ page }) => {
  const apptId = await seedFutureAppointmentAt(seed.studioId, A.practitionerId, clientId, seedTz, "15:00");
  await loginByMagicLink(page, seed.ownerEmail);
  const dialog = await openMove(page, apptId);
  const selector = dialog.getByLabel("Practitioner");
  await expect(selector).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByRole("option", { name: C.displayName })).toHaveCount(0);

  await selector.selectOption({ label: B.displayName });
  const slot = dialog.getByRole("button", { name: SLOT });
  await expect(slot.first()).toBeVisible({ timeout: 20_000 });
  await slot.last().click();
  const confirm = dialog.getByRole("button").last();
  await expect(confirm).toBeEnabled();
  await expect(confirm).toHaveText(/reassign/i);
  // Switch back to A (current): the picked slot is cleared → confirm disabled.
  await selector.selectOption({ label: `${A.displayName} (current)` });
  await expect(confirm).toBeDisabled();
});

test("owner moves and reassigns A→B; the DB shows B + a moved_and_reassigned audit", async ({ page }) => {
  // A distinct time from the prior (uncommitted) 15:00 appointment to avoid an
  // A-vs-A overlap at seed time.
  const apptId = await seedFutureAppointmentAt(seed.studioId, A.practitionerId, clientId, seedTz, "17:00");
  await loginByMagicLink(page, seed.ownerEmail);
  const dialog = await openMove(page, apptId);
  await dialog.getByLabel("Practitioner").selectOption({ label: B.displayName });
  const slot = dialog.getByRole("button", { name: SLOT });
  await expect(slot.first()).toBeVisible({ timeout: 20_000 });
  await slot.last().click();
  const confirm = dialog.getByRole("button").last();
  await expect(confirm).toHaveText(/Move and reassign appointment/i);
  await confirm.click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  const appts = await getClientAppointmentsWithPractitioner(seed.studioId, clientId);
  expect(appts.find((a) => a.id === apptId)?.practitioner_id).toBe(B.practitionerId);
  expect(await getAppointmentAuditActions(apptId)).toContain("moved_and_reassigned");
});

test("a member sees no practitioner selector on their own appointment", async ({ page }) => {
  const apptId = await seedFutureAppointmentAt(seed.studioId, A.practitionerId, clientId, seedTz, "16:00");
  await loginByMagicLink(page, A.email);
  const dialog = await openMove(page, apptId);
  await expect(dialog.getByLabel("New date")).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByLabel("Practitioner")).toHaveCount(0);
});

test("Legacy capacity-OFF studio: the Move dialog has no practitioner selector", async ({ page }) => {
  const legacy = await seedE2eStudio();
  const legacyTz = await getStudioTimezone(legacy.studioId);
  const { clientId: legacyClient } = await seedE2eClient(legacy);
  const legacyOwner = await getOwnerPractitionerId(legacy.studioId);
  const legacyId = await seedFutureAppointmentAt(legacy.studioId, legacyOwner, legacyClient, legacyTz, "15:00");
  await loginByMagicLink(page, legacy.ownerEmail);
  const dialog = await openMove(page, legacyId);
  await expect(dialog.getByLabel("New date")).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByLabel("Practitioner")).toHaveCount(0);
});
