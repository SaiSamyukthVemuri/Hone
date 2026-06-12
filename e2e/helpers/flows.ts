import { expect, type Page } from "@playwright/test";
import type { E2eSeed } from "./seed";
import { listMessageIds, waitForMagicLink } from "./mail";
import { E2E_APP_ORIGIN } from "./local-env";

// Shared UI flows for the E2E specs (PR #227/#228). Extracted from
// the core-memory-loop spec so the mobile spec reuses the exact same
// real flows (public booking; REAL magic-link login via Mailpit).

export async function bookAppointment(page: Page, s: E2eSeed): Promise<void> {
  await page.goto(`/book/${s.slug}`);
  await expect(page.getByText(s.studioName).first()).toBeVisible();
  await page.getByRole("button", { name: /new client/i }).click();
  // Single seeded consultation service is preselected; pick the first
  // available slot, jumping forward if the default day has none.
  const slotButton = page.getByRole("button", {
    name: /^\d{1,2}:\d{2} (AM|PM)$/,
  });
  const nextDay = page.getByRole("button", { name: /next available day/i });
  await expect(async () => {
    const slots = await slotButton.count();
    const next = await nextDay.count();
    expect(slots + next).toBeGreaterThan(0);
  }).toPass({ timeout: 20_000 });
  if ((await slotButton.count()) === 0) {
    await nextDay.click();
    await expect(slotButton.first()).toBeVisible({ timeout: 20_000 });
  }
  await slotButton.first().click();
  await page.getByLabel(/your name/i).fill(s.clientName);
  await page.getByLabel(/^email/i).fill(s.clientEmail);
  await page.getByLabel(/phone/i).fill("+1 555 555 0123");
  await page.getByRole("button", { name: /book appointment/i }).click();
  // Confirmation state replaces the form.
  await expect(
    page.getByRole("heading", { name: /your appointment is booked/i }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(s.clientEmail).first()).toBeVisible();
}

export async function loginAsOwner(page: Page, s: E2eSeed): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Agree to Terms of Service and Privacy Policy").check();
  await page.locator("#login-email").fill(s.ownerEmail);
  // Magic links are single-use: snapshot the inbox BEFORE requesting
  // so a repeat login (new context/device) waits for the fresh link.
  const seen = await listMessageIds(s.ownerEmail);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(s.ownerEmail, E2E_APP_ORIGIN, {
    excludeIds: seen,
  });
  await page.goto(link);
  await page.waitForURL(/dashboard/, { timeout: 30_000 });
}
