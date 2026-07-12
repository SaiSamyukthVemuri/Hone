import { test, expect } from "@playwright/test";
import {
  seedE2eGoogleConnection,
  seedE2eStudio,
  setStudioGoogleCalendarConnectionEnabled,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

const DISCOVERY_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

// Google Calendar — Phase A, real browser. Exercises the connection FOUNDATION
// UI without any Google account: the studio flag gate (card hidden when OFF,
// shown when ON), the dormant/iCal-distinction copy, and the fail-closed connect
// path when the integration is not provisioned (no GOOGLE_* env in the e2e
// stack). No event sync, no availability change, no external navigation.

test("Google Calendar card: flag-gated, dormant, fail-closed when unconfigured", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  await loginAsOwner(page, seed);

  await test.step("with the flag OFF, the Google Calendar card is absent", async () => {
    await page.goto("/settings/profile");
    await expect(page.getByRole("heading", { name: /^Profile$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /connect google calendar/i })).toHaveCount(0);
    // The one-way iCal feed card is unaffected and still present.
    await expect(page.getByText(/calendar feed/i).first()).toBeVisible();
  });

  await test.step("with the flag ON, the card shows with dormant + iCal-distinction copy", async () => {
    await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
    await page.goto("/settings/profile");
    await expect(page.getByRole("heading", { name: /^Google Calendar$/ })).toBeVisible();
    await expect(
      page.getByText(/one-way subscription that never imports events/i),
    ).toBeVisible();
    await expect(page.getByText(/No event read or write access is requested yet/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /connect google calendar/i })).toBeVisible();
  });

  await test.step("clicking Connect fails closed when the integration is not configured", async () => {
    await page.getByRole("button", { name: /connect google calendar/i }).click();
    // No GOOGLE_* env in the e2e stack -> the action refuses; we stay on the
    // settings page (no navigation to accounts.google.com) and see a clear error.
    await expect(page.getByText(/not configured yet/i)).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/settings\/profile/);
  });
});

// Phase B2.2 — event-scope readiness rendering + fail-closed upgrade. Uses a
// seeded CONNECTED owner connection so the derived readiness surfaces the right
// CTA/message WITHOUT a live Google round-trip (the e2e stack has no GOOGLE_*
// env, so the upgrade action fails closed exactly like Phase-A connect).
test("Google Calendar card: event-scope readiness + fail-closed upgrade + ready state", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);

  await test.step("a connected Phase-A owner shows the dormant banner + Grant event access CTA", async () => {
    await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE]); // no event scope yet
    await loginAsOwner(page, seed);
    await page.goto("/settings/profile");
    await expect(page.getByText(/Event synchronization is still disabled/i)).toBeVisible();
    await expect(page.getByText(/Event access not granted/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /grant calendar event access/i })).toBeVisible();
  });

  await test.step("clicking Grant event access fails closed when unconfigured (no navigation to Google)", async () => {
    await page.getByRole("button", { name: /grant calendar event access/i }).click();
    await expect(page.getByText(/not configured yet/i)).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/settings\/profile/);
  });
});

test("Google Calendar card: an event-scoped owner connection reads as ready-for-future-sync", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE, EVENTS_SCOPE]);
  await loginAsOwner(page, seed);

  await page.goto("/settings/profile");
  await expect(page.getByText(/Ready for future event sync/i).first()).toBeVisible();
  // Even when ready, the dormant banner remains — sync is never claimed active.
  await expect(page.getByText(/Event synchronization is still disabled/i)).toBeVisible();
  // No upgrade CTA when the scope is already granted.
  await expect(page.getByRole("button", { name: /grant calendar event access/i })).toHaveCount(0);
});
