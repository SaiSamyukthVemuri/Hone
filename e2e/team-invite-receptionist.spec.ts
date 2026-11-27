import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, sql } from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Settings -> Team -> invite a receptionist -> see it pending -> cancel it, in a real browser.
// The database rules (the invite makes a receptionist row and never a practitioner row, a cancelled invite cannot be accepted, removal refuses the next
// request) are proved in tests/db/receptionist-invitation.db.test.ts; this proves the owner's page does what those rules need: the role is offered, the
// pending invite is labelled, and Revoke removes it so it cannot be accepted.

const T = 60_000;

async function openTeam(page: Page) {
  await page.goto("/settings/team");
  await expect(page.getByRole("heading", { name: /^Practitioners$/ })).toBeVisible({ timeout: T });
}

test.describe("Team settings: receptionist invitations", () => {
  test.setTimeout(T * 3);

  test("the owner invites a receptionist, sees it pending as a receptionist, and cancels it", async ({ page }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
    await openTeam(page);

    const invitee = `front-desk-${seed.runId}@harness.local`;
    await page.getByLabel(/email/i).first().fill(invitee);
    await page.locator("select").filter({ has: page.locator('option[value="receptionist"]') }).selectOption("receptionist");
    await page.getByRole("button", { name: /send invite|invite/i }).first().click();

    // The row exists as a RECEPTIONIST invitation in the database (not a practitioner, and no membership of any kind yet).
    await expect
      .poll(async () => (await sql<{ role: string }>(`select role from public.pending_invitations where studio_id = $1 and lower(email) = $2 and status = 'pending'`, [seed.studioId, invitee]))[0]?.role, {
        timeout: 30_000,
      })
      .toBe("receptionist");
    expect((await sql(`select 1 from public.studio_receptionists where studio_id = $1 and lower(email) = $2`, [seed.studioId, invitee])).length).toBe(0);

    // The page shows it pending, labelled receptionist.
    await openTeam(page);
    const row = page.locator("li", { hasText: invitee });
    await expect(row).toBeVisible({ timeout: T });
    await expect(row.getByText(/receptionist/i).first()).toBeVisible();

    // Cancel it: the row goes away on the page and the invitation is revoked, so it can no longer be accepted.
    await row.getByRole("button", { name: /revoke/i }).click();
    await expect(page.locator("li", { hasText: invitee })).toHaveCount(0, { timeout: 30_000 });
    expect((await sql<{ status: string }>(`select status from public.pending_invitations where studio_id = $1 and lower(email) = $2`, [seed.studioId, invitee]))[0]?.status).toBe(
      "revoked",
    );
  });

  test("the front desk list shows an existing receptionist and Deactivate removes their access", async ({ page }) => {
    const seed = await seedE2eStudio();
    const ownerId = (await sql<{ id: string }>(`select id from public.practitioners where studio_id = $1 and role = 'owner'`, [seed.studioId]))[0]!.id;
    const email = `desk-${seed.runId}@harness.local`;
    const userId = (await sql<{ id: string }>(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [email]))[0]!.id;
    await sql(`select public.add_studio_receptionist($1, $2, $3, $4, $5)`, [seed.studioId, ownerId, userId, "Desk Person", email]);
    await loginAsOwner(page, seed);
    await openTeam(page);

    const row = page.locator("li", { hasText: "Desk Person" });
    await expect(row).toBeVisible({ timeout: T });
    await row.getByRole("button", { name: /deactivate/i }).click();
    await expect(row.getByText(/inactive/i)).toBeVisible({ timeout: 30_000 });
    expect((await sql<{ active: boolean }>(`select active from public.studio_receptionists where studio_id = $1 and user_id = $2`, [seed.studioId, userId]))[0]?.active).toBe(false);
  });
});
