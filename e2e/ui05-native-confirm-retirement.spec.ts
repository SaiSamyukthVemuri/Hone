import { test, expect, type Page } from "@playwright/test";

import { seedE2eStudio, seedE2eClient, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// UI-05 — the retired native confirm, proved on a real surface.
//
// WHAT THIS ADDS OVER THE SOURCE PROOF, AND WHAT IT DELIBERATELY DOES NOT.
//
// The dialog primitive's own contract — role="alertdialog", focus trap, focus
// restored to the opener, Escape only while idle, 44px targets — is already
// proved by tests/components/confirm-dialog.test.ts and exercised in-browser by
// two existing specs on other consumers. Re-proving it here would be ceremony.
//
// What is NEW in this slice is the ADOPTION: that this surface now opens the
// shipped dialog instead of a native confirm, that cancelling mutates nothing,
// and that confirming still performs the same archive. Those are the claims
// asserted below.
//
// A native confirm() cannot be driven by Playwright without a dialog handler at
// all, so the first assertion — that an in-page alertdialog appears — is itself
// the regression fence: if someone reintroduces window.confirm here, no
// alertdialog will ever appear and this fails.

const T = 20_000;

async function seedPortalMessage(page: Page): Promise<{ seed: E2eSeed; clientId: string; subject: string }> {
  const seed = await seedE2eStudio();
  const { clientId } = await seedE2eClient(seed);
  const practitioners = await sql<{ id: string }>(
    `select id from public.practitioners where studio_id = $1 order by created_at limit 1`,
    [seed.studioId],
  );
  const practitionerId = practitioners[0]?.id;
  expect(practitionerId, "fixture: the seeded studio must have a practitioner").toBeTruthy();

  const subject = `E2E portal subject ${seed.runId}`;
  await sql(
    `insert into public.client_portal_messages
       (studio_id, client_id, created_by_practitioner_id, subject, body)
     values ($1, $2, $3, $4, 'Seeded portal body for the UI-05 archive proof.')`,
    [seed.studioId, clientId, practitionerId, subject],
  );

  await loginAsOwner(page, seed);
  await page.goto(`/clients/${clientId}?tab=messages`);
  return { seed, clientId, subject };
}

const archivedAtFor = async (clientId: string): Promise<string | null | undefined> => {
  const rows = await sql<{ archived_at: string | null }>(
    `select archived_at from public.client_portal_messages where client_id = $1`,
    [clientId],
  );
  return rows[0]?.archived_at;
};

test.describe("UI-05 archiving a portal message uses the shipped dialog", () => {
  test("an in-page alertdialog appears — not a native confirm", async ({ page }) => {
    const { subject } = await seedPortalMessage(page);
    await expect(page.getByText(subject)).toBeVisible({ timeout: T });

    // If a native confirm were still in use, Playwright would auto-dismiss it
    // and NO alertdialog would ever exist. So this doubles as the fence against
    // the old API returning.
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Archive" }).first().click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: T });
    await expect(dialog).toContainText("Archive this message?");
    // The consequence is stated, which is the point of a confirmation.
    await expect(dialog).toContainText("The client will no longer see it");
  });

  test("cancelling mutates NOTHING", async ({ page }) => {
    const { clientId, subject } = await seedPortalMessage(page);
    await expect(page.getByText(subject)).toBeVisible({ timeout: T });
    expect(await archivedAtFor(clientId)).toBeNull();

    await page.getByRole("button", { name: "Archive" }).first().click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: T });

    await dialog.getByRole("button", { name: /^Cancel$/ }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);

    // The database is the authority here, not the absence of a spinner.
    expect(await archivedAtFor(clientId)).toBeNull();
  });

  test("confirming performs the SAME archive the native path performed", async ({ page }) => {
    const { clientId, subject } = await seedPortalMessage(page);
    await expect(page.getByText(subject)).toBeVisible({ timeout: T });

    await page.getByRole("button", { name: "Archive" }).first().click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: T });
    await dialog.getByRole("button", { name: "Archive message" }).click();

    await expect
      .poll(async () => archivedAtFor(clientId), { timeout: T })
      .not.toBeNull();
  });

  test("on a 390px viewport the dialog fits without horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { subject } = await seedPortalMessage(page);
    await expect(page.getByText(subject)).toBeVisible({ timeout: T });

    await page.getByRole("button", { name: "Archive" }).first().click();
    await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: T });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
