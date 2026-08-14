// ===========================================================================
// Integration RC, capacity-ON CALENDAR Quick Book browser proofs (Studio B)
// ===========================================================================
//
// The existing practitioner-booking-studio-b spec proves practitioner-aware
// creation through the CLIENT-PROFILE "+ Book appointment" modal. This spec
// proves the SAME capacity model through the real CALENDAR Quick Book entry
// points that the combined RC ships, the desktop DayColumn empty-cell drawer
// and the mobile CalendarMobileDayView FAB, which were previously unproven at
// the browser layer.
//
// One shared QuickBookDrawer (role="dialog" name="New appointment") backs both
// form factors. Under capacity ON + owner it renders a <select aria-label=
// "Practitioner">; slots are scoped to the selected practitioner; the assigned
// practitioner echoes at data-testid="assigned-practitioner". A member sees no
// selector and books self; a capacity-OFF studio shows no selector and books
// studio-wide. Switching the target clears the picked slot (the cancelled-
// closure guard at QuickBookDrawer.tsx:405/417/455 drops any in-flight slot
// response), so a stale A response can never be submitted for B.
//
// Local-stack only (e2e/helpers/local-env.ts refuses hosted). Never Willow.

import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  seedE2eClient,
  getE2eServiceId,
  seedServiceEligibility,
  setStudioCapacityEnabled,
  setStudioCapacityBookingEnabled,
  setPractitionerActive,
  seedPractitionerDefault,
  getStudioTimezone,
  getClientAppointmentsWithPractitioner,
  getSourceReservationKeys,
  getOwnerPractitionerId,
  type E2eSeed,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { todayInTz } from "../lib/booking/tz";

test.describe.configure({ mode: "serial" });

// 12-hour slot labels like "9:00 AM" (localTimeString12h).
const SLOT = /^\d{1,2}:\d{2}\s?(AM|PM)$/i;

const DRAWER = (page: Page) =>
  page.getByRole("dialog", { name: "New appointment" });
const CHOOSER = (page: Page) =>
  page.getByRole("dialog", { name: "Choose action for selected time" });

// --- Capacity-ON Studio B ---
let seed: E2eSeed;
let serviceId = "";
let clientId = "";
let studioToday = "";
let A: { email: string; displayName: string; practitionerId: string };
let B: { email: string; displayName: string; practitionerId: string };
let C: { email: string; displayName: string; practitionerId: string };

// --- Legacy (capacity-OFF) studio ---
let legacy: E2eSeed;
let legacyServiceId = "";
let legacyClientId = "";
let legacyToday = "";
let legacyOwnerPractitionerId = "";

test.beforeAll(async () => {
  // Studio B: owner O + active A (member) + active B (member) + INACTIVE C.
  seed = await seedE2eStudio();
  serviceId = await getE2eServiceId(seed.studioId);
  ({ clientId } = await seedE2eClient(seed));
  A = await seedE2eMember(seed);
  B = await seedE2eMember(seed);
  C = await seedE2eMember(seed);
  await setPractitionerActive(C.practitionerId, false); // C never a valid target
  await setStudioCapacityEnabled(seed.studioId, true);
  await setStudioCapacityBookingEnabled(seed.studioId, true);
  // The service-insert trigger seeds only the owner; make A + B eligible (not C).
  await seedServiceEligibility(seed.studioId, serviceId, A.practitionerId);
  await seedServiceEligibility(seed.studioId, serviceId, B.practitionerId);
  // Per-practitioner availability, wide open every day so `.first()`/`.last()`
  // future slots always exist (studio tz is local-morning).
  for (let d = 0; d <= 6; d++) {
    await seedPractitionerDefault(seed.studioId, A.practitionerId, d, true, "06:00", "22:00");
    await seedPractitionerDefault(seed.studioId, B.practitionerId, d, true, "06:00", "22:00");
  }
  studioToday = todayInTz(await getStudioTimezone(seed.studioId));

  // Legacy studio: capacity stays OFF (default); studio-wide availability from
  // seedE2eStudio (06:00-22:00 studio-wide).
  legacy = await seedE2eStudio();
  legacyServiceId = await getE2eServiceId(legacy.studioId);
  ({ clientId: legacyClientId } = await seedE2eClient(legacy));
  legacyOwnerPractitionerId = await getOwnerPractitionerId(legacy.studioId);
  legacyToday = todayInTz(await getStudioTimezone(legacy.studioId));
});

// Open Quick Book on a specific day's DayColumn (desktop week grid).
async function openDesktopQuickBook(page: Page, dateStr: string) {
  await page.goto("/calendar");
  await page
    .getByRole("button", { name: `Open quick-book draft for ${dateStr}` })
    .click();
  await expect(DRAWER(page)).toBeVisible({ timeout: 20_000 });
}

// Pick the (single) seeded client for a studio via the drawer search step.
async function pickClient(page: Page, runId: string) {
  const d = DRAWER(page);
  await d.getByPlaceholder("Find existing client").fill(`Notes Client ${runId}`);
  await d.getByRole("button", { name: new RegExp(runId) }).first().click();
}

async function pickService(page: Page, svcId: string) {
  // The Service <select> is the first combobox in the drawer (no aria-label);
  // the Practitioner <select> (aria-label) is second and only under capacity ON.
  await DRAWER(page).getByRole("combobox").first().selectOption(svcId);
}

// Current appointment ids for a (studio, client), used for self-contained
// delta assertions that hold whether a test runs alone or in the serial suite.
async function apptIds(studioId: string, cId: string): Promise<string[]> {
  return (await getClientAppointmentsWithPractitioner(studioId, cId)).map((a) => a.id);
}

test.describe("desktop calendar Quick Book (capacity ON)", () => {
  test("owner opens Quick Book from the DayColumn, targets B, books a B slot", async ({ page }) => {
    await loginByMagicLink(page, seed.ownerEmail);
    await openDesktopQuickBook(page, studioToday);
    const d = DRAWER(page);

    await pickClient(page, seed.runId);
    await pickService(page, serviceId);

    // Practitioner selector present (capacity ON + owner); inactive C absent.
    const selector = d.getByLabel("Practitioner");
    await expect(selector).toBeVisible({ timeout: 20_000 });
    await expect(d.getByRole("option", { name: C.displayName })).toHaveCount(0);

    await selector.selectOption(B.practitionerId);
    await expect(d.getByTestId("assigned-practitioner")).toContainText(B.displayName);

    const slot = d.getByRole("button", { name: SLOT });
    await expect(slot.first()).toBeVisible({ timeout: 20_000 });
    const before = await apptIds(seed.studioId, clientId);
    await slot.last().click(); // latest future slot for B

    await d.getByRole("button", { name: /^Book appointment$/ }).click();
    await expect(d).toBeHidden({ timeout: 20_000 });

    // DB: exactly one NEW appointment, assigned to B, with a single reservation
    // keyed to B's resource (no duplicate). Delta-based → order-independent.
    await expect
      .poll(async () => (await apptIds(seed.studioId, clientId)).length, {
        timeout: 15_000,
      })
      .toBe(before.length + 1);
    const after = await getClientAppointmentsWithPractitioner(seed.studioId, clientId);
    const created = after.find((a) => !before.includes(a.id))!;
    expect(created.practitioner_id).toBe(B.practitionerId);
    expect(await getSourceReservationKeys("appointment", created.id)).toEqual([
      B.practitionerId,
    ]);
  });

  test("switching the target A->B clears the picked slot (stale A cannot submit for B)", async ({ page }) => {
    await loginByMagicLink(page, seed.ownerEmail);
    await openDesktopQuickBook(page, studioToday);
    const d = DRAWER(page);

    await pickClient(page, seed.runId);
    await pickService(page, serviceId);

    const selector = d.getByLabel("Practitioner");
    await selector.selectOption(A.practitionerId);
    await expect(d.getByTestId("assigned-practitioner")).toContainText(A.displayName);

    const slot = d.getByRole("button", { name: SLOT });
    await expect(slot.first()).toBeVisible({ timeout: 20_000 });
    await slot.last().click();
    const submit = d.getByRole("button", { name: /^Book appointment$/ });
    await expect(submit).toBeEnabled();

    // Switch A -> B: the slot effect re-fetches for B and its cleanup cancels
    // A's in-flight response (QuickBookDrawer.tsx:455-457), so A's picked slot
    // is discarded, submit disables and the assignment flips to B. A stale A
    // slot response can therefore never be committed for B.
    await selector.selectOption(B.practitionerId);
    await expect(d.getByTestId("assigned-practitioner")).toContainText(B.displayName);
    await expect(submit).toBeDisabled();

    // B's freshly scoped slots render; picking one re-enables, no A carry-over.
    await expect(slot.first()).toBeVisible({ timeout: 20_000 });
    await slot.last().click();
    await expect(submit).toBeEnabled();
  });

  test("a member sees no practitioner selector and books only themselves", async ({ page }) => {
    await loginByMagicLink(page, A.email); // A logs in as a non-owner member
    await openDesktopQuickBook(page, studioToday);
    const d = DRAWER(page);

    await pickClient(page, seed.runId);
    await pickService(page, serviceId);
    await expect(d.getByLabel("Practitioner")).toHaveCount(0); // no selector for a member

    const slot = d.getByRole("button", { name: SLOT });
    await expect(slot.first()).toBeVisible({ timeout: 20_000 });
    const before = await apptIds(seed.studioId, clientId);
    await slot.last().click(); // A @ last (distinct resource from owner's B @ last)

    await d.getByRole("button", { name: /^Book appointment$/ }).click();
    await expect(d).toBeHidden({ timeout: 20_000 });

    // The one NEW booking is assigned to the acting member A, never a target.
    await expect
      .poll(async () => (await apptIds(seed.studioId, clientId)).length, {
        timeout: 15_000,
      })
      .toBe(before.length + 1);
    const after = await getClientAppointmentsWithPractitioner(seed.studioId, clientId);
    const created = after.find((a) => !before.includes(a.id))!;
    expect(created.practitioner_id).toBe(A.practitionerId);
  });

  test("Legacy capacity-OFF studio shows no practitioner selector and books studio-wide", async ({ page }) => {
    await loginByMagicLink(page, legacy.ownerEmail);
    await openDesktopQuickBook(page, legacyToday);
    const d = DRAWER(page);

    await pickClient(page, legacy.runId);
    await pickService(page, legacyServiceId);
    await expect(d.getByLabel("Practitioner")).toHaveCount(0); // capacity OFF → no selector

    const slot = d.getByRole("button", { name: SLOT });
    await expect(slot.first()).toBeVisible({ timeout: 20_000 });
    const before = await apptIds(legacy.studioId, legacyClientId);
    await slot.last().click();
    await d.getByRole("button", { name: /^Book appointment$/ }).click();
    await expect(d).toBeHidden({ timeout: 20_000 });

    // Studio-wide booking: exactly one NEW appointment, assigned to the acting
    // owner (the legacy studio-wide result is unchanged by the capacity work).
    await expect
      .poll(async () => (await apptIds(legacy.studioId, legacyClientId)).length, {
        timeout: 15_000,
      })
      .toBe(before.length + 1);
    const after = await getClientAppointmentsWithPractitioner(
      legacy.studioId,
      legacyClientId,
    );
    const created = after.find((a) => !before.includes(a.id))!;
    expect(created.practitioner_id).toBe(legacyOwnerPractitionerId);
  });
});

test.describe("mobile calendar Quick Book (capacity ON)", () => {
  // iPhone-12 class viewport (chromium-only lane: declare explicitly, the
  // devices[] presets carry webkit which this lane does not install).
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });

  async function openMobileQuickBook(page: Page) {
    await page.goto("/calendar"); // mobile shell renders CalendarMobileDayView (today)
    const fab = page.getByRole("button", { name: "Add appointment or block time" });
    await expect(fab).toBeVisible({ timeout: 20_000 });
    // Real 56px FAB tap target (>= 44px).
    const box = await fab.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
    await fab.click();
    await CHOOSER(page).getByRole("button", { name: "Book appointment" }).click();
    await expect(DRAWER(page)).toBeVisible({ timeout: 20_000 });
  }

  test("owner books through the mobile FAB with an explicit practitioner; submit stays locked until valid", async ({ page }) => {
    await loginByMagicLink(page, seed.ownerEmail);
    await openMobileQuickBook(page);
    const d = DRAWER(page);

    await pickClient(page, seed.runId);
    await pickService(page, serviceId);

    const selector = d.getByLabel("Practitioner");
    await expect(selector).toBeVisible({ timeout: 20_000 });
    await selector.selectOption(B.practitionerId);
    await expect(d.getByTestId("assigned-practitioner")).toContainText(B.displayName);

    // Submit-locking: no slot picked yet → the button is disabled.
    const submit = d.getByRole("button", { name: /^Book appointment$/ });
    await expect(submit).toBeDisabled();

    const slot = d.getByRole("button", { name: SLOT });
    await expect(slot.first()).toBeVisible({ timeout: 20_000 });
    const before = await apptIds(seed.studioId, clientId);
    await slot.first().click(); // B @ first (distinct from desktop's B @ last)
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(d).toBeHidden({ timeout: 20_000 });

    // DB: one NEW appointment assigned to B, with a reservation keyed to B.
    await expect
      .poll(async () => (await apptIds(seed.studioId, clientId)).length, {
        timeout: 15_000,
      })
      .toBe(before.length + 1);
    const after = await getClientAppointmentsWithPractitioner(seed.studioId, clientId);
    const created = after.find((a) => !before.includes(a.id))!;
    expect(created.practitioner_id).toBe(B.practitionerId);
    expect(await getSourceReservationKeys("appointment", created.id)).toEqual([
      B.practitionerId,
    ]);
  });

  test("a mobile member sees no selector and books only themselves", async ({ page }) => {
    await loginByMagicLink(page, A.email);
    await openMobileQuickBook(page);
    const d = DRAWER(page);

    await pickClient(page, seed.runId);
    await pickService(page, serviceId);
    await expect(d.getByLabel("Practitioner")).toHaveCount(0);

    const slot = d.getByRole("button", { name: SLOT });
    await expect(slot.first()).toBeVisible({ timeout: 20_000 });
    const before = await apptIds(seed.studioId, clientId);
    await slot.first().click(); // A @ first (distinct from desktop member's A @ last)
    await d.getByRole("button", { name: /^Book appointment$/ }).click();
    await expect(d).toBeHidden({ timeout: 20_000 });

    // The one NEW booking is assigned to the acting member A (self-only).
    await expect
      .poll(async () => (await apptIds(seed.studioId, clientId)).length, {
        timeout: 15_000,
      })
      .toBe(before.length + 1);
    const after = await getClientAppointmentsWithPractitioner(seed.studioId, clientId);
    const created = after.find((a) => !before.includes(a.id))!;
    expect(created.practitioner_id).toBe(A.practitionerId);
  });
});
