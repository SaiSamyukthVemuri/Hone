import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  seedE2eGoogleConnection,
  setStudioGoogleCalendarConnectionEnabled,
  setE2eOwnerActive,
  getE2eOwnerConnectionState,
} from "../e2e/helpers/seed";
import { loginAsOwner, loginByMagicLink } from "../e2e/helpers/flows";
import {
  configureFakeGoogle,
  resetFakeGoogle,
  fakeGoogleEvents,
  fakeCreatedCalendarCount,
  APP_CREATED_SCOPE,
  EVENTS_OWNED_SCOPE,
  DISCOVERY_SCOPE,
} from "./helpers/fake-google-e2e";

// Synthetic-Google browser E2E — SECURITY cases + credential-boundary PENDING
// states. Guarded fake Google (no real request).

test.beforeEach(() => resetFakeGoogle());

test("unauthenticated cannot reach the owner Integrations page", async ({ page }) => {
  await page.goto("/settings/integrations");
  await expect(page).toHaveURL(/\/login/);
});

test("a non-owner is redirected away from the owner Integrations page", async ({ page }) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  const member = await seedE2eMember(seed);
  await loginByMagicLink(page, member.email);
  await page.goto("/settings/integrations");
  await expect(page).toHaveURL(/\/settings\/profile/);
  await expect(page.getByTestId("gcal-destination-chooser")).toHaveCount(0);
});

test("an inactive practitioner is denied server-side (destination not recorded)", async ({ page }) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE]);
  await loginAsOwner(page, seed);
  await page.goto("/settings/integrations");
  // Deactivate AFTER navigation; the next action re-reads and must reject.
  await setE2eOwnerActive(seed.studioId, false);
  await page.getByRole("button", { name: /Create a Hone Appointments calendar/i }).click();
  await expect(page.getByRole("alert")).toContainText(/inactive/i);
  const st = await getE2eOwnerConnectionState(seed.studioId);
  expect(st?.destination_mode).toBeNull();
  await setE2eOwnerActive(seed.studioId, true); // restore
});

test("account switch is rejected — a different Google identity never replaces credentials", async ({ page }) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE]); // account 'e2e-sub'
  configureFakeGoogle({ grantedScopes: [DISCOVERY_SCOPE, APP_CREATED_SCOPE], userSub: "a-different-google-account" });
  await loginAsOwner(page, seed);

  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: /Create a Hone Appointments calendar/i }).click();
  await page.getByRole("button", { name: /Grant permission to create a calendar/i }).click();
  await page.waitForURL(/gcal=/);
  await expect(page.getByText(/different from the one already connected/i)).toBeVisible();
  // Pre-replacement: the event scope was NOT stored.
  const st = await getE2eOwnerConnectionState(seed.studioId);
  expect(st?.granted_scopes).not.toContain(APP_CREATED_SCOPE);
});

test("partial grant is rejected pre-replacement — previous grant preserved, still pending", async ({ page }) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE]);
  // The user declines the destination scope — the fake grants only discovery.
  configureFakeGoogle({ grantedScopes: [DISCOVERY_SCOPE] });
  await loginAsOwner(page, seed);

  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: /Create a Hone Appointments calendar/i }).click();
  await page.getByRole("button", { name: /Grant permission to create a calendar/i }).click();
  await page.waitForURL(/gcal=/);
  await expect(page.getByText(/permission wasn't granted/i)).toBeVisible();
  // Still on the permission step; no destination scope stored.
  await expect(page.getByRole("button", { name: /Grant permission to create a calendar/i })).toBeVisible();
  const st = await getE2eOwnerConnectionState(seed.studioId);
  expect(st?.granted_scopes).not.toContain(APP_CREATED_SCOPE);
  expect(fakeCreatedCalendarCount()).toBe(0);
});

test("a tampered/unknown OAuth state is rejected at the callback", async ({ page }) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE]);
  await loginAsOwner(page, seed);
  // Hit the real callback directly with a state that was never issued.
  await page.goto("/api/google-calendar/oauth/callback?code=x&state=forged-nonexistent-state");
  await expect(page).toHaveURL(/gcal=error/);
});

test("dedicated PROVISIONING-PENDING — grant kept, provisioning fails, retryable, no destination stored", async ({ page }) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE]);
  configureFakeGoogle({ grantedScopes: [DISCOVERY_SCOPE, APP_CREATED_SCOPE], provisioning: "insert_error_orphan" });
  await loginAsOwner(page, seed);

  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: /Create a Hone Appointments calendar/i }).click();
  await page.getByRole("button", { name: /Grant permission to create a calendar/i }).click();
  await page.waitForURL(/gcal=/);
  // Grant succeeded (credentials replaced) — provisioning now fails.
  await page.getByRole("button", { name: /Create the Hone Appointments calendar/i }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  // The new grant is RETAINED; the destination is NOT completed; retry stays dedicated.
  await expect(page.getByRole("button", { name: /Create the Hone Appointments calendar/i })).toBeVisible();
  const st = await getE2eOwnerConnectionState(seed.studioId);
  expect(st?.granted_scopes).toContain(APP_CREATED_SCOPE); // grant retained (post-replacement)
  expect(st?.destination_mode).toBe("dedicated_app_created");
  expect(st?.app_created_calendar_id).toBeNull(); // provisioning pending
});

test("existing-owned SELECTION-PENDING — grant kept, awaiting calendar selection", async ({ page }) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await seedE2eGoogleConnection(seed.studioId, [DISCOVERY_SCOPE]);
  configureFakeGoogle({
    grantedScopes: [DISCOVERY_SCOPE, EVENTS_OWNED_SCOPE],
    calendarList: [{ id: "own-1", summary: "My Real Calendar", accessRole: "owner" }],
  });
  await loginAsOwner(page, seed);

  await page.goto("/settings/integrations");
  await page.getByRole("button", { name: /^Use an existing calendar$/i }).click();
  await page.getByRole("button", { name: /Grant permission to use your calendar/i }).click();
  await page.waitForURL(/gcal=/);
  // Grant succeeded (retained); selection still pending (no destination stored yet).
  await expect(page.getByRole("button", { name: /Choose a calendar you own/i })).toBeVisible();
  const st = await getE2eOwnerConnectionState(seed.studioId);
  expect(st?.granted_scopes).toContain(EVENTS_OWNED_SCOPE); // grant retained
  expect(st?.destination_mode).toBe("existing_owned");
  expect(st?.write_calendar_id).toBeNull();
  expect(st?.destination_ownership_validated_at).toBeNull();
  // Proof the flow went through the SYNTHETIC provider (no real Google request).
  expect(fakeGoogleEvents().some((e) => e.type === "token_exchange")).toBe(true);
});
