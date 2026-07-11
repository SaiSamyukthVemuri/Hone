import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  setStudioGoogleCalendarConnectionEnabled,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

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
