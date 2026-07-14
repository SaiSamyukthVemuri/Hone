import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eGoogleConnection,
  setStudioGoogleCalendarConnectionEnabled,
  getE2eOwnerConnectionState,
  getE2eCalendarSyncCounts,
} from "../e2e/helpers/seed";
import { loginAsOwner } from "../e2e/helpers/flows";
import {
  configureFakeGoogle,
  resetFakeGoogle,
  fakeAuthorizeScopeSets,
  fakeCreatedCalendarCount,
  EVENTS_OWNED_SCOPE,
  APP_CREATED_SCOPE,
  DISCOVERY_SCOPE,
} from "./helpers/fake-google-e2e";

// Synthetic-Google browser E2E — EXISTING-OWNED destination (Flow B). Real
// browser, guarded fake Google (no real request). Proves only calendar.events.owned
// is requested, the picker shows ONLY owner-role calendars, the server revalidates
// ownership, and no event/outbox/link is created.

const BROAD_EVENTS = "https://www.googleapis.com/auth/calendar.events";

test.beforeEach(() => resetFakeGoogle());

test("Flow B — existing owned: only events.owned requested, owner-only picker, ready, dormant", async ({ page }) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE]); // connected, no destination
  configureFakeGoogle({
    grantedScopes: [DISCOVERY_SCOPE, EVENTS_OWNED_SCOPE],
    calendarList: [
      { id: "own-1", summary: "My Real Calendar", accessRole: "owner" },
      { id: "wr-1", summary: "A Shared Writable Calendar", accessRole: "writer" },
      { id: "rd-1", summary: "A Read-only Calendar", accessRole: "reader" },
      { id: "fb-1", summary: "A Free-Busy Calendar", accessRole: "freeBusyReader" },
    ],
  });
  await loginAsOwner(page, seed);

  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: /^Use an existing calendar$/i }).click();
  await expect(page.getByRole("button", { name: /Grant permission to use your calendar/i })).toBeVisible();
  await page.getByRole("button", { name: /Grant permission to use your calendar/i }).click();
  await page.waitForURL(/gcal=/);

  // The ACTIVE OAuth request asked for ONLY calendar.events.owned.
  for (const s of fakeAuthorizeScopeSets()) {
    expect(s).toContain(EVENTS_OWNED_SCOPE);
    expect(s).not.toContain(BROAD_EVENTS);
    expect(s).not.toContain(APP_CREATED_SCOPE);
  }

  // The picker shows ONLY owner-role calendars.
  await page.getByRole("button", { name: /Choose a calendar you own/i }).click();
  const options = page.locator("select option");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveText(/My Real Calendar/);
  const optionText = (await page.locator("select").innerText()).toLowerCase();
  expect(optionText).not.toContain("shared writable");
  expect(optionText).not.toContain("read-only");
  expect(optionText).not.toContain("free-busy");

  // Select the owned calendar → server revalidates ownership → destination ready.
  await page.selectOption("select", "own-1");
  await page.getByRole("button", { name: /Use this calendar/i }).click();
  await expect(page.getByTestId("gcal-ready")).toBeVisible();

  const st = await getE2eOwnerConnectionState(seed.studioId);
  expect(st?.destination_mode).toBe("existing_owned");
  expect(st?.write_calendar_id).toBe("own-1");
  expect(st?.destination_ownership_validated_at).toBeTruthy();
  expect(st?.app_created_calendar_id).toBeNull();

  // No dedicated calendar was created; synchronization stays off; no event/outbox/link.
  expect(fakeCreatedCalendarCount()).toBe(0);
  await expect(page.getByText(/Synchronization is off\. Hone is not creating or changing appointment events\./i)).toBeVisible();
  expect(await getE2eCalendarSyncCounts()).toEqual({ outbox: 0, links: 0 });
});
