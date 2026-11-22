import { test, expect, type Page } from "@playwright/test";
import { seedE2eStudio, seedE2eMember, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// Team removal and restore, end to end, on a SYNTHETIC studio on the LOCAL stack (never a real studio). The story, in one serial test:
//   1. the owner removes member A through the Team page;
//   2. A, signed in with their own login, sees nothing of the studio (sent to /no-access, no client name on any page);
//   3. colleague B still reads the studio's records (the synthetic client is visible) and still cannot read finances;
//   4. a restore that conflicts with an ACTIVE receptionist membership is refused with the plain sentence, A stays removed, and NO record is written;
//   5. after the conflict is cleared, the owner restores A: exactly ONE record (owner -> A, 'restored');
//   6. a second, stale Team page still showing "Restore" (a repeated click) changes nothing: still exactly ONE record;
//   7. A can sign in and read again.
// The record is read from the database (it is not shown in the app in this patch).

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;
let memberA: { email: string; displayName: string; practitionerId: string };
let memberB: { email: string; displayName: string; practitionerId: string };

const events = async (): Promise<Array<{ action: string; actor: string; target: string }>> =>
  sql<{ action: string; actor: string; target: string }>(
    "select action, actor_practitioner_id::text as actor, target_practitioner_id::text as target from public.practitioner_access_events where studio_id = $1 order by created_at, id",
    [seed.studioId],
  );
const activeOf = async (practitionerId: string): Promise<boolean> =>
  (await sql<{ active: boolean }>("select active from public.practitioners where id = $1", [practitionerId]))[0]!.active;
const userIdOf = async (practitionerId: string): Promise<string> =>
  (await sql<{ user_id: string }>("select user_id from public.practitioners where id = $1", [practitionerId]))[0]!.user_id;

async function signInAs(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  await loginByMagicLink(page, email);
}

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  memberA = await seedE2eMember(seed);
  memberB = await seedE2eMember(seed);
});

test("remove, the removed see nothing, a colleague keeps clinical access and not finances, a conflict is refused, restore records once", async ({ page }) => {
  expect(E2E_APP_ORIGIN).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1)/);

  // 1. the owner removes A through the page
  await loginAsOwner(page, seed);
  await page.goto("/settings/team");
  const rowA = page.getByRole("listitem").filter({ hasText: memberA.displayName });
  await rowA.getByRole("button", { name: "Remove" }).click();
  await expect.poll(() => activeOf(memberA.practitionerId)).toBe(false);
  expect(await events()).toHaveLength(0); // removal is not recorded in this patch (CONTROL for step 5)
  await page.goto("/settings/team");
  await expect(page.getByTestId("team-removed").getByText(memberA.displayName)).toBeVisible();

  // 2. the removed member sees nothing
  await signInAs(page, memberA.email);
  await page.waitForURL(/\/no-access/, { timeout: 30_000 });
  await page.goto("/clients");
  await page.waitForURL(/\/no-access/, { timeout: 30_000 });
  await expect(page.getByText(seed.clientName)).toHaveCount(0);

  // 3. colleague B: records yes, finances no
  await signInAs(page, memberB.email);
  await page.goto("/clients");
  await expect(page.getByText(seed.clientName).first()).toBeVisible();
  await page.goto("/financials");
  await expect(page.getByText(/Only the studio owner can see studio financials/i)).toBeVisible();

  // 4. conflict: A's user is an ACTIVE receptionist, so the restore is refused and nothing is written
  const aUser = await userIdOf(memberA.practitionerId);
  await sql(
    `insert into public.studio_receptionists (studio_id, user_id, display_name, email, active) values ($1, $2, 'Synthetic Front Desk', 'synthetic-front-desk@harness.local', true)`,
    [seed.studioId, aUser],
  );
  await signInAs(page, seed.ownerEmail);
  await page.goto("/settings/team");
  const stale = await page.context().newPage(); // a second Team page that will still show "Restore" later (step 6)
  await stale.goto("/settings/team");
  await page.getByTestId("team-removed").getByRole("listitem").filter({ hasText: memberA.displayName }).getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("team-restore-notice")).toContainText(/currently an active receptionist/i);
  expect(await activeOf(memberA.practitionerId)).toBe(false);
  expect(await events()).toHaveLength(0);

  // 5. the conflict is cleared; the restore works and writes exactly one record
  await sql("update public.studio_receptionists set active = false where studio_id = $1 and user_id = $2", [seed.studioId, aUser]);
  await page.goto("/settings/team");
  await page.getByTestId("team-removed").getByRole("listitem").filter({ hasText: memberA.displayName }).getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("team-restore-notice")).toContainText(/^Restored\./);
  expect(await activeOf(memberA.practitionerId)).toBe(true);
  const rows = await events();
  expect(rows).toEqual([{ action: "restored", actor: expect.any(String), target: memberA.practitionerId }]);
  const ownerPractitioner = (await sql<{ id: string }>("select id from public.practitioners where studio_id = $1 and role = 'owner'", [seed.studioId]))[0]!.id;
  expect(rows[0]!.actor).toBe(ownerPractitioner);

  // 6. a repeated click from the stale page changes nothing
  await stale.getByTestId("team-removed").getByRole("listitem").filter({ hasText: memberA.displayName }).getByRole("button", { name: "Restore" }).click();
  await stale.waitForLoadState("networkidle");
  expect(await events()).toHaveLength(1);
  expect(await activeOf(memberA.practitionerId)).toBe(true);
  await stale.close();

  // 7. A is back
  await signInAs(page, memberA.email);
  await page.goto("/clients");
  await expect(page.getByText(seed.clientName).first()).toBeVisible();
});
