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
  APP_CREATED_SCOPE,
  DISCOVERY_SCOPE,
} from "./helpers/fake-google-e2e";

// Synthetic-Google browser E2E: DEDICATED destination (Flow A + idempotency +
// ambiguous provisioning). Real browser, guarded fake Google (no real request).

const BROAD_EVENTS = "https://www.googleapis.com/auth/calendar.events";

test.beforeEach(() => resetFakeGoogle());

async function chooseDedicatedAndGrant(page: import("@playwright/test").Page) {
  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: /Create a Hone Appointments calendar/i }).click();
  await expect(page.getByRole("button", { name: /Grant permission to create a calendar/i })).toBeVisible();
  await page.getByRole("button", { name: /Grant permission to create a calendar/i }).click();
  // The fake OAuth round-trip returns to the integrations page with the grant.
  await page.waitForURL(/gcal=/);
}

test("Flow A, dedicated: only app.created requested, exactly one calendar, ready, dormant", async ({ page }) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE]); // connected, no destination
  configureFakeGoogle({ grantedScopes: [DISCOVERY_SCOPE, APP_CREATED_SCOPE], provisioning: "normal" });
  await loginAsOwner(page, seed);

  await chooseDedicatedAndGrant(page);
  await page.getByRole("button", { name: /Create the Hone Appointments calendar/i }).click();
  await expect(page.getByTestId("gcal-ready")).toBeVisible();

  // The ACTIVE OAuth request asked for ONLY calendar.app.created (never broad events).
  const scopeSets = fakeAuthorizeScopeSets();
  expect(scopeSets.length).toBeGreaterThanOrEqual(1);
  for (const s of scopeSets) {
    expect(s).toContain(APP_CREATED_SCOPE);
    expect(s).not.toContain(BROAD_EVENTS);
  }
  // Exactly one synthetic calendar; provider id + provenance stored.
  expect(fakeCreatedCalendarCount()).toBe(1);
  const st = await getE2eOwnerConnectionState(seed.studioId);
  expect(st?.destination_mode).toBe("dedicated_app_created");
  expect(st?.app_created_calendar_id).toBeTruthy();
  expect(st?.write_calendar_id).toBe(st?.app_created_calendar_id);

  // Synchronization stays OFF; no event/outbox/link.
  await expect(page.getByText(/Synchronization is off\. Hone is not creating or changing appointment events\./i)).toBeVisible();
  expect(await getE2eCalendarSyncCounts()).toEqual({ outbox: 0, links: 0 });

  // No refresh token or secret is ever rendered to the browser.
  const html = await page.content();
  expect(html).not.toContain("fake-refresh");
  expect(html).not.toMatch(/refresh_token|encrypted_refresh_token/);
});

test("idempotency: re-provision (page reload + repeated submit) creates no second calendar", async ({ page }) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE]);
  configureFakeGoogle({ grantedScopes: [DISCOVERY_SCOPE, APP_CREATED_SCOPE], provisioning: "normal" });
  await loginAsOwner(page, seed);

  await chooseDedicatedAndGrant(page);
  await page.getByRole("button", { name: /Create the Hone Appointments calendar/i }).click();
  await expect(page.getByTestId("gcal-ready")).toBeVisible();
  expect(fakeCreatedCalendarCount()).toBe(1);

  // Reload the ready page: already-provisioned → no chooser, no second create.
  await page.reload();
  await expect(page.getByTestId("gcal-ready")).toBeVisible();
  await expect(page.getByRole("button", { name: /Create the Hone Appointments calendar/i })).toHaveCount(0);
  expect(fakeCreatedCalendarCount()).toBe(1);
});

test("ambiguous multi-match: provisioning fails closed (needs attention), no adoption", async ({ page }) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE]);
  configureFakeGoogle({ grantedScopes: [DISCOVERY_SCOPE, APP_CREATED_SCOPE], provisioning: "ambiguous_multi" });
  await loginAsOwner(page, seed);

  await chooseDedicatedAndGrant(page);
  await page.getByRole("button", { name: /Create the Hone Appointments calendar/i }).click();
  // The provision returns an error (no reload); wait for the card error, then the
  // persisted needs-attention state surfaces on the next server render.
  await expect(page.locator('p[role="alert"]')).toBeVisible();
  await page.reload();

  // Two synthetic calendars share the token → the server marks the connection as
  // needing attention and adopts NEITHER (no destination stored).
  await expect(page.getByTestId("gcal-needs-attention")).toBeVisible();
  const st = await getE2eOwnerConnectionState(seed.studioId);
  expect(st?.app_created_calendar_id).toBeNull();
  expect(st?.destination_provisioning_ambiguous_at).toBeTruthy();
  expect(await getE2eCalendarSyncCounts()).toEqual({ outbox: 0, links: 0 });
});

test("ambiguous one-match: an orphan from a failed insert is adopted on retry, no duplicate", async ({ page }) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE]);
  // First insert "times out" but Google created the calendar (orphan).
  configureFakeGoogle({ grantedScopes: [DISCOVERY_SCOPE, APP_CREATED_SCOPE], provisioning: "insert_error_orphan" });
  await loginAsOwner(page, seed);

  await chooseDedicatedAndGrant(page);
  // Attempt 1: insert errors → still on the create step (an error is shown).
  await page.getByRole("button", { name: /Create the Hone Appointments calendar/i }).click();
  await expect(page.getByRole("button", { name: /Create the Hone Appointments calendar/i })).toBeVisible();
  expect(fakeCreatedCalendarCount()).toBe(1); // the orphan exists

  // Attempt 2 (retry): reconcile by the persisted token finds the ONE orphan and
  // adopts it, no second calendar is created.
  await page.getByRole("button", { name: /Create the Hone Appointments calendar/i }).click();
  await expect(page.getByTestId("gcal-ready")).toBeVisible();
  expect(fakeCreatedCalendarCount()).toBe(1);
  const st = await getE2eOwnerConnectionState(seed.studioId);
  expect(st?.app_created_calendar_id).toBeTruthy();
});
