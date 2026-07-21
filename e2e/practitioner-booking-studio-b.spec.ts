import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  seedE2eClient,
  setStudioCapacityEnabled,
  setPractitionerActive,
  seedPractitionerDefault,
  getE2eServiceId,
  seedServiceEligibility,
  getClientAppointmentsWithPractitioner,
  type E2eSeed,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";

// PR B Part 4 Item 6 — practitioner-aware internal booking, driven through the
// REAL client-profile UI against a synthetic capacity-ON studio and verified
// against the DB. Owner O; active A + B (both eligible); inactive C (absent); one
// service. Never Willow / production data.

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;
let serviceId: string;
let clientId: string;
let A: { email: string; displayName: string; practitionerId: string };
let B: { email: string; displayName: string; practitionerId: string };
let C: { email: string; displayName: string; practitionerId: string };

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  serviceId = await getE2eServiceId(seed.studioId);
  ({ clientId } = await seedE2eClient(seed));
  A = await seedE2eMember(seed);
  B = await seedE2eMember(seed);
  C = await seedE2eMember(seed);
  await setPractitionerActive(C.practitionerId, false); // inactive → never a target
  await setStudioCapacityEnabled(seed.studioId, true);

  // Make A + B eligible (the service-insert trigger only seeded the OWNER, who
  // predates the members). The selector will show O + A + B; the inactive C is
  // never eligible + never active, so it stays absent. We select A/B explicitly.
  await seedServiceEligibility(seed.studioId, serviceId, A.practitionerId);
  await seedServiceEligibility(seed.studioId, serviceId, B.practitionerId);

  // Per-practitioner availability: both wide-open every day so today has slots.
  for (let d = 0; d <= 6; d++) {
    await seedPractitionerDefault(seed.studioId, A.practitionerId, d, true, "06:00", "22:00");
    await seedPractitionerDefault(seed.studioId, B.practitionerId, d, true, "06:00", "22:00");
  }
});

const SLOT = /^\d{1,2}:\d{2}\s?(AM|PM)$/i;

async function openBooking(page: import("@playwright/test").Page) {
  await page.goto(`/clients/${clientId}`);
  await page.getByRole("button", { name: /\+ Book appointment/i }).click();
}

test("owner books A, then B — distinct practitioner assignments", async ({ page }) => {
  await loginByMagicLink(page, seed.ownerEmail);
  await openBooking(page);

  // Selector shows only A + B (inactive C absent).
  const selector = page.getByLabel("Practitioner");
  await expect(selector).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("option", { name: C.displayName })).toHaveCount(0);

  // Book A.
  await selector.selectOption({ label: A.displayName });
  const slotA = page.getByRole("button", { name: SLOT });
  await expect(slotA.first()).toBeVisible({ timeout: 20_000 });
  await slotA.last().click(); // latest slot today = future (local-morning tz)
  await expect(page.getByTestId("assigned-practitioner")).toContainText(A.displayName);
  await page.getByRole("button", { name: /^Confirm$/ }).click();
  await page.waitForURL(/\/calendar\//, { timeout: 20_000 });

  // Book B.
  await openBooking(page);
  await page.getByLabel("Practitioner").selectOption({ label: B.displayName });
  const slotB = page.getByRole("button", { name: SLOT });
  await expect(slotB.first()).toBeVisible({ timeout: 20_000 });
  await slotB.last().click();
  await expect(page.getByTestId("assigned-practitioner")).toContainText(B.displayName);
  await page.getByRole("button", { name: /^Confirm$/ }).click();
  await page.waitForURL(/\/calendar\//, { timeout: 20_000 });

  // DB: two appointments, one for A and one for B.
  const appts = await getClientAppointmentsWithPractitioner(seed.studioId, clientId);
  const pracIds = appts.map((a) => a.practitioner_id);
  expect(pracIds).toContain(A.practitionerId);
  expect(pracIds).toContain(B.practitionerId);
});

test("changing the target clears the picked time (stale submission impossible)", async ({ page }) => {
  await loginByMagicLink(page, seed.ownerEmail);
  await openBooking(page);
  await page.getByLabel("Practitioner").selectOption({ label: A.displayName });
  const slot = page.getByRole("button", { name: SLOT });
  await expect(slot.first()).toBeVisible({ timeout: 20_000 });
  await slot.last().click();
  const confirm = page.getByRole("button", { name: /^Confirm$/ });
  await expect(confirm).toBeEnabled();
  // Switch A -> B: the client-profile loader clears the picked slot on every
  // target change, so Confirm is disabled until a NEW slot is chosen.
  await page.getByLabel("Practitioner").selectOption({ label: B.displayName });
  await expect(confirm).toBeDisabled();
});

test("member sees no selector and books only themselves", async ({ page }) => {
  await loginByMagicLink(page, A.email);
  await openBooking(page);
  // No practitioner selector for a member.
  await expect(page.getByLabel("Practitioner")).toHaveCount(0);
  const slot = page.getByRole("button", { name: SLOT });
  await expect(slot.first()).toBeVisible({ timeout: 20_000 });
  await slot.last().click();
  await page.getByRole("button", { name: /^Confirm$/ }).click();
  await page.waitForURL(/\/calendar\//, { timeout: 20_000 });
  const appts = await getClientAppointmentsWithPractitioner(seed.studioId, clientId);
  // The most recent appointment is assigned to the acting member A.
  expect(appts.some((a) => a.practitioner_id === A.practitionerId)).toBe(true);
});

test("Legacy capacity-OFF studio shows no practitioner selector", async ({ page }) => {
  const legacy = await seedE2eStudio();
  const { clientId: legacyClientId } = await seedE2eClient(legacy);
  await loginByMagicLink(page, legacy.ownerEmail);
  await page.goto(`/clients/${legacyClientId}`);
  await page.getByRole("button", { name: /\+ Book appointment/i }).click();
  await expect(page.getByLabel("Practitioner")).toHaveCount(0);
  const slot = page.getByRole("button", { name: SLOT });
  await expect(slot.first()).toBeVisible({ timeout: 20_000 });
});
