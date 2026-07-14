import { test, expect } from "@playwright/test";
import {
  seedE2eGoogleConnection,
  seedE2eStudio,
  setStudioGoogleCalendarConnectionEnabled,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

const DISCOVERY_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
// B2.4: readiness is destination-aware. An existing-owned destination requires the
// EXACT calendar.events.owned scope (broad calendar.events no longer satisfies it).
const EVENTS_OWNED_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";

// Google Calendar — Phase A + B2.4, real browser. Exercises the connection UI and
// the owner DESTINATION chooser WITHOUT any Google account: the studio flag gate,
// the dormant/iCal-distinction copy, the destination chooser rendering, and the
// fail-closed OAuth paths when the integration is not provisioned (no GOOGLE_* env
// in the e2e stack). No event sync, no availability change, no external navigation.

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
    await expect(page.getByText(/No event read or write access is requested when you/i)).toBeVisible();
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

// B2.4 — a connected owner with NO destination sees the destination chooser; the
// dormant statement is explicit. Choosing a mode records it (a plain DB write, no
// Google call), then the destination-scope grant fails closed (no GOOGLE_* env).
test("Google Calendar card: connected owner sees the destination chooser + fail-closed grant", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE]); // connected, no destination yet
  await loginAsOwner(page, seed);

  await page.goto("/settings/profile");
  await expect(
    page.getByText(/Synchronization is off\. Hone is not creating or changing appointment events\./i),
  ).toBeVisible();

  await test.step("the owner sees both destination options", async () => {
    await expect(page.getByText(/Where should Hone add appointments\?/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Create a Hone Appointments calendar/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Use an existing calendar$/i })).toBeVisible();
  });

  await test.step("choosing dedicated advances to the permission step, which fails closed", async () => {
    await page.getByRole("button", { name: /Create a Hone Appointments calendar/i }).click();
    await expect(
      page.getByRole("button", { name: /Grant permission to create a calendar/i }),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /Grant permission to create a calendar/i }).click();
    await expect(page.getByText(/not configured yet/i)).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/settings\/profile/);
  });
});

test("Google Calendar card: a fully-configured owned destination reads as ready-for-future-sync", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE, EVENTS_OWNED_SCOPE], "existing_owned");
  await loginAsOwner(page, seed);

  await page.goto("/settings/profile");
  await expect(page.getByTestId("gcal-ready")).toBeVisible();
  await expect(page.getByText(/Destination ready for future event sync/i)).toBeVisible();
  // Even when ready, the dormant statement remains — sync is never claimed active.
  await expect(
    page.getByText(/Synchronization is off\. Hone is not creating or changing appointment events\./i),
  ).toBeVisible();
  // No destination chooser once a destination is configured.
  await expect(page.getByTestId("gcal-destination-chooser")).toHaveCount(0);
});
