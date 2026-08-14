import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  setStudioGoogleCalendarConnectionEnabled,
} from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// Google Calendar: owner Integrations surface (Phase B1). Exercises the owner-only
// Settings → Integrations page WITHOUT any Google account: the owner sees the
// dormant "synchronization is off" banner + the connection card, the connect path
// fails closed when unprovisioned (no GOOGLE_* env in the e2e stack), and a
// non-owner is denied. No event sync, no worker, no outbound flag.

test("owner Integrations page: sync-off banner + connect fails closed when unconfigured", async ({
  page,
}) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  await loginAsOwner(page, seed);

  await page.goto("/settings/integrations");
  await expect(page.getByRole("heading", { name: /^Integrations$/ })).toBeVisible();

  // Dormancy is stated plainly: synchronization is off.
  await expect(page.getByTestId("integrations-sync-off")).toBeVisible();
  await expect(page.getByText(/synchronization is currently off/i)).toBeVisible();

  // The connection card (flag ON) offers Connect from the not-connected state.
  await expect(page.getByRole("heading", { name: /^Google Calendar$/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /connect google calendar/i }),
  ).toBeVisible();

  // Connect fails closed (no GOOGLE_* env), no navigation to Google, an error
  // shows, and we remain on the Integrations page.
  await page.getByRole("button", { name: /connect google calendar/i }).click();
  await expect(page.getByText(/not configured yet/i)).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/settings\/integrations/);
});

test("non-owner practitioner cannot access the Integrations page", async ({ page }) => {
  const seed = await seedE2eStudio();
  await setStudioGoogleCalendarConnectionEnabled(seed.studioId, true);
  const member = await seedE2eMember(seed);
  await loginByMagicLink(page, member.email);

  await page.goto("/settings/integrations");
  // Owner-only: the server component redirects a non-owner to their profile.
  await expect(page).toHaveURL(/\/settings\/profile/);
  await expect(page.getByRole("heading", { name: /^Integrations$/ })).toHaveCount(0);
});
