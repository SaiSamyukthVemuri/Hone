import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  createLocalAuthUser,
  insertBareStudio,
  insertPendingInvite,
  insertEvidenceMembership,
  insertMembershipInStudio,
} from "./helpers/seed";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// Migration 0141 — existing-user invitation reconciliation, proven end to end
// against the real local stack (real magic-link login via Mailpit; no auth
// bypass). The RPC evidence/atomicity logic is covered exhaustively by
// tests/db/invitation-reconciliation.db.test.ts; these specs prove the
// auth-callback ROUTING, the /accept-invitation page, and the chooser/conflict
// destinations in a real browser.

// Sign in via the REAL magic-link flow, following the link but NOT asserting a
// specific landing page (each case lands somewhere different).
async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Agree to Terms of Service and Privacy Policy").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen });
  await page.goto(link);
}

function email(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@harness.local`;
}

test.describe("invitation reconciliation — existing accounts", () => {
  test("no evidence: routed to explicit acceptance; cannot enter the app until accepting", async ({
    page,
  }) => {
    const owner = email("recon1");
    const userId = await createLocalAuthUser(owner);
    expect(userId).toBeTruthy();
    const studio = await insertBareStudio("recon1-target");
    await insertPendingInvite(studio.studioId, owner);

    await signIn(page, owner);

    // Reconcile has no evidence to copy -> explicit acceptance page.
    await page.waitForURL(/\/accept-invitation/, { timeout: 30_000 });
    await expect(
      page.getByRole("heading", { name: "Join your studio" }),
    ).toBeVisible();
    await expect(page.getByText(studio.name)).toBeVisible();
    // The join button is disabled until the current-policy box is checked.
    const join = page.getByRole("button", { name: /Join .* as/ });
    await expect(join).toBeDisabled();

    // Cannot enter the app before accepting: /dashboard bounces (0 memberships).
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/no-access/);

    // Accept the current policies -> membership created -> into the app.
    await page.goto("/accept-invitation");
    await page
      .getByLabel(/I agree to the current/)
      .check();
    await page.getByRole("button", { name: /Join .* as/ }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  });

  test("valid current-version evidence: reconciles automatically, no consent screen", async ({
    page,
  }) => {
    const owner = email("recon2");
    const userId = await createLocalAuthUser(owner);
    // Inactive evidence row (valid current terms/privacy) -> 0 active studios,
    // so after linking the single new studio the user lands on the dashboard.
    await insertEvidenceMembership(userId, owner, false);
    const studio = await insertBareStudio("recon2-target");
    await insertPendingInvite(studio.studioId, owner);

    await signIn(page, owner);

    // Straight into the app — no /accept-invitation detour.
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
    await expect(page).not.toHaveURL(/\/accept-invitation/);
  });

  test("one-studio user added to a second: chooser appears, nothing auto-selected", async ({
    page,
  }) => {
    const owner = email("recon3");
    const userId = await createLocalAuthUser(owner);
    // An ACTIVE prior membership (also valid evidence) -> after linking the new
    // studio the user has 2 active memberships -> the truthful chooser.
    await insertEvidenceMembership(userId, owner, true);
    const studio = await insertBareStudio("recon3-target");
    await insertPendingInvite(studio.studioId, owner);

    await signIn(page, owner);

    await page.waitForURL(/\/no-access\?reason=multiple-studios/, {
      timeout: 30_000,
    });
    await expect(
      page.getByRole("heading", { name: "Choose a studio" }),
    ).toBeVisible();
  });

  test("conflicting membership: safe support message, no raw error text", async ({
    page,
  }) => {
    const invitedEmail = email("recon6");
    const target = await insertBareStudio("recon6-target");
    // Another auth user already holds a membership in the target under the
    // invited email (a conflicting state the RPC must never overwrite).
    const otherId = await createLocalAuthUser(email("recon6-other"));
    await insertMembershipInStudio(target.studioId, otherId, invitedEmail);
    // The invited (existing) account signs in.
    await createLocalAuthUser(invitedEmail);
    await insertPendingInvite(target.studioId, invitedEmail);

    await signIn(page, invitedEmail);

    await page.waitForURL(/\/no-access\?reason=invite-conflict/, {
      timeout: 30_000,
    });
    await expect(
      page.getByText(/contact the studio or Hone support/i),
    ).toBeVisible();
    // No raw DB/Auth internals leaked.
    await expect(page.getByText(/duplicate key|violates|constraint|auth\./i)).toHaveCount(0);
  });
});
