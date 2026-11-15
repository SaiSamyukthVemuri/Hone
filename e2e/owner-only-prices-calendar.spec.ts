// ===========================================================================
// "See published service prices and booking fees" (Sam, 7 Nov 2026): default ON, owners always.
// This spec is the ON half on a real stack: a practitioner (staff) still BOOKS (Quick Book, the full booking
// form) and MOVES, and sees the published price while the control is ON; the owner always does. The OFF half
// (no price markers anywhere, HTML + RSC, while booking and moving still work) cannot be driven from a browser
// until the permission engine can store the control; it was run against the same flows with the seam forced
// OFF (scratch patch, not committed), evidence in the PR body.
// Pages: /calendar week, team day, /clients/<id> (+ "+ Book appointment"), /calendar/<id> (+ Move).
// Local-stack only (e2e/helpers/local-env.ts refuses hosted).
// ===========================================================================

import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  seedE2eClient,
  getE2eServiceId,
  seedServiceEligibility,
  setStudioCapacityEnabled,
  setStudioCapacityBookingEnabled,
  seedPractitionerDefault,
  seedConfirmedAppointment,
  getStudioTimezone,
  getAppointmentsForClient,
  sql,
  type E2eSeed,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { todayInTz } from "../lib/booking/tz";

test.describe.configure({ mode: "serial" });

const SENTINEL_CENTS = 98765;
const SLOT = /^\d{1,2}:\d{2}\s?(AM|PM)$/i;
const DRAWER = (page: Page) => page.getByRole("dialog", { name: "New appointment" });

let seed: E2eSeed;
let serviceId = "";
let clientId = "";
let apptId = "";
let studioToday = "";
let A: { email: string; displayName: string; practitionerId: string };
let B: { email: string; displayName: string; practitionerId: string };

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  serviceId = await getE2eServiceId(seed.studioId);
  await sql(`update public.services set price_cents = $2 where id = $1`, [serviceId, SENTINEL_CENTS]);
  ({ clientId } = await seedE2eClient(seed));
  A = await seedE2eMember(seed);
  B = await seedE2eMember(seed);
  await setStudioCapacityEnabled(seed.studioId, true);
  await setStudioCapacityBookingEnabled(seed.studioId, true);
  await seedServiceEligibility(seed.studioId, serviceId, A.practitionerId);
  await seedServiceEligibility(seed.studioId, serviceId, B.practitionerId);
  for (let d = 0; d <= 6; d++) {
    await seedPractitionerDefault(seed.studioId, A.practitionerId, d, true, "06:00", "22:00");
    await seedPractitionerDefault(seed.studioId, B.practitionerId, d, true, "06:00", "22:00");
  }
  const tz = await getStudioTimezone(seed.studioId);
  studioToday = todayInTz(tz);
  // A confirmed appointment for A tomorrow at 15:00 studio-local, for the detail page and the Move flow.
  const t = await sql<{ s: string; e: string }>(
    `select (((now() at time zone $1)::date + 1)::text || ' 15:00')::timestamp at time zone $1 as s,
            (((now() at time zone $1)::date + 1)::text || ' 16:00')::timestamp at time zone $1 as e`,
    [tz],
  );
  apptId = await seedConfirmedAppointment(
    seed.studioId, A.practitionerId, clientId, new Date(t[0].s).toISOString(), new Date(t[0].e).toISOString(),
  );
});

// Fetch a page both ways with the signed-in context: the document, and the flight (RSC) form.
async function fetchBoth(page: Page, path: string) {
  const html = await (await page.request.get(path)).text();
  const rsc = await (await page.request.get(path, { headers: { RSC: "1" } })).text();
  return { html, rsc };
}

const week = () => `/calendar?view=week`;
const day = () => `/calendar?view=day&day=${studioToday}`;

test.describe("a practitioner (staff) with the control ON: books, moves, and sees the published price", () => {
  test("the week, team-day and client-profile payloads carry the price (HTML and RSC)", async ({ page }) => {
    await loginByMagicLink(page, A.email);
    for (const p of [week(), day(), `/clients/${clientId}`]) {
      await page.goto(p);
      const { html, rsc } = await fetchBoth(page, p);
      expect(`${html}${rsc}`, `${p}: ON shows the published price`).toContain(String(SENTINEL_CENTS));
    }
  });

  test("Quick Book from the week grid books end to end; the picker prints the amount", async ({ page }) => {
    await loginByMagicLink(page, A.email);
    await page.goto(week());
    await page.getByRole("button", { name: `Open quick-book draft for ${studioToday}` }).click();
    const d = DRAWER(page);
    await expect(d).toBeVisible({ timeout: 20_000 });
    await d.getByPlaceholder("Find existing client").fill(`Notes Client ${seed.runId}`);
    await d.getByRole("button", { name: new RegExp(seed.runId) }).first().click();
    await d.getByRole("combobox").first().selectOption(serviceId);
    await expect(d.getByRole("option", { name: /\$988/ })).toHaveCount(1);
    const slot = d.getByRole("button", { name: SLOT });
    await expect(slot.first()).toBeVisible({ timeout: 20_000 });
    const before = (await getAppointmentsForClient(seed.studioId, clientId)).map((a) => a.id);
    await slot.last().click();
    await d.getByRole("button", { name: /^Book appointment$/ }).click();
    await expect(d).toBeHidden({ timeout: 20_000 });
    await expect
      .poll(async () => (await getAppointmentsForClient(seed.studioId, clientId)).length, { timeout: 15_000 })
      .toBe(before.length + 1);
  });

  test("the full booking form (client profile) books end to end", async ({ page }) => {
    await loginByMagicLink(page, A.email);
    await page.goto(`/clients/${clientId}`);
    await page.getByRole("button", { name: /\+ Book appointment/i }).click();
    await expect(page.getByRole("option", { name: /\$988/ }).first()).toHaveCount(1);
    const slot = page.getByRole("button", { name: SLOT });
    await expect(slot.first()).toBeVisible({ timeout: 20_000 });
    const before = (await getAppointmentsForClient(seed.studioId, clientId)).map((a) => a.id);
    // the first slots of today are already past; take a late one that Quick Book did not
    await slot.nth((await slot.count()) - 3).click();
    const confirm = page.getByRole("button", { name: /^Confirm$/ });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect
      .poll(async () => (await getAppointmentsForClient(seed.studioId, clientId)).length, { timeout: 20_000 })
      .toBe(before.length + 1);
  });

  test("Move (slot) on the appointment detail keeps the appointment", async ({ page }) => {
    await loginByMagicLink(page, A.email);
    const before = (await getAppointmentsForClient(seed.studioId, clientId)).find((a) => a.id === apptId)!;
    await page.goto(`/calendar/${apptId}`);
    await page.getByRole("button", { name: "Move appointment" }).click();
    const dialog = page.getByRole("dialog", { name: "Move appointment" });
    await expect(dialog).toBeVisible();
    const slot = dialog.getByRole("button", { name: SLOT });
    await expect(slot.first()).toBeVisible({ timeout: 20_000 });
    await slot.last().click();
    await dialog.getByRole("button", { name: /^(Move appointment|Move and reassign appointment)$/ }).click();
    await expect(dialog).toHaveCount(0, { timeout: 20_000 });
    const after = (await getAppointmentsForClient(seed.studioId, clientId)).find((a) => a.id === apptId)!;
    expect(after, "same appointment id preserved").toBeTruthy();
    expect(new Date(after.starts_at).getTime(), "the start moved").not.toBe(new Date(before.starts_at).getTime());
  });
});

test.describe("the owner still sees the price (positive control)", () => {
  test("the week and team-day payloads carry the service price", async ({ page }) => {
    await loginByMagicLink(page, seed.ownerEmail);
    for (const p of [week(), `/calendar?view=day&day=${studioToday}`]) {
      await page.goto(p);
      const { html, rsc } = await fetchBoth(page, p);
      expect(`${html}${rsc}`, `${p}: owner payload has the price`).toContain(String(SENTINEL_CENTS));
    }
  });

  test("the Quick Book picker prints the amount for an owner", async ({ page }) => {
    await loginByMagicLink(page, seed.ownerEmail);
    await page.goto(week());
    await page.getByRole("button", { name: `Open quick-book draft for ${studioToday}` }).click();
    const d = DRAWER(page);
    await expect(d).toBeVisible({ timeout: 20_000 });
    await expect(d.getByRole("option", { name: /\$988/ })).toHaveCount(1);
  });

  test("the client profile booking form prints the amount for an owner", async ({ page }) => {
    await loginByMagicLink(page, seed.ownerEmail);
    await page.goto(`/clients/${clientId}`);
    await page.getByRole("button", { name: /\+ Book appointment/i }).click();
    await expect(page.getByRole("option", { name: /\$988/ }).first()).toHaveCount(1);
  });
});
