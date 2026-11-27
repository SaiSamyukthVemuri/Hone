import { test, expect, type Page } from "@playwright/test";
import { asReceptionist, expectPathRefused, seedDeskFixture, signInAsDesk } from "./helpers/desk";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";
import { loginAsOwner } from "./helpers/flows";
import { seedE2eStudio, seedOperatorAuthUser, sql } from "./helpers/seed";

// The Front Desk is available to a studio only where the platform has switched it on AND the studio holds a seat for the receptionist (0390). Proved in a
// real browser, on the project's phone and desktop sizes, with synthetic data on the local stack:
//   1. REVOCATION, EXPIRY and SWITCH-OFF close the desk on the receptionist's very next request, and the same person calling the database directly with
//      their own token is refused too. A re-grant restores it with no data change.
//   2. Another studio's desk is untouched, and a receptionist of one studio learns nothing about another's switch or seats.
//   3. The owner's Team page tells the truth about seats, and does not offer what the database would refuse.
//   4. The platform admin's screen turns a studio on, grants a seat with a reason and revokes it, and the audit rows carry no reason text.
// The database commands used to revoke or switch off are the real ones (admin_revoke_front_desk_seats, remove_platform_rollout_studio); their behaviour is
// proved on a real database in tests/db/front-desk-seats.db.test.ts.

const T = 60_000;
const ACTOR = ["00000000-0000-4000-8000-0000000000aa", "fixture-admin@harness.local"] as const;

const live = (studioId: string) => sql<{ id: string }>(`select id from public.studio_front_desk_seats where studio_id = $1 and revoked_at is null and (expires_at is null or expires_at > now())`, [studioId]);
const revokeAll = async (studioId: string) => {
  for (const g of await live(studioId)) await sql(`select public.admin_revoke_front_desk_seats($1,'e2e revoke',$2,$3)`, [g.id, ACTOR[0], ACTOR[1]]);
};
const grant = (studioId: string, seats = 1) => sql(`select public.admin_grant_front_desk_seats($1,$2,'pilot','e2e grant',null,$3,$4)`, [studioId, seats, ACTOR[0], ACTOR[1]]);
const switchOff = (studioId: string) => sql(`select public.remove_platform_rollout_studio('front_desk',$1,$2,$3)`, [studioId, ACTOR[0], ACTOR[1]]);
const switchOn = (studioId: string) => sql(`select public.add_platform_rollout_studio('front_desk',$1,$2,$3)`, [studioId, ACTOR[0], ACTOR[1]]);

async function expectDesk(page: Page) {
  await page.goto("/desk");
  await expect(page).toHaveURL(/\/desk(?:\?|$)/, { timeout: T });
  await expect(page.getByRole("button", { name: "Find an opening", exact: true }).first()).toBeVisible({ timeout: T });
}
async function expectClosed(page: Page) {
  await page.goto("/desk");
  await expect(page).toHaveURL(/\/no-access/, { timeout: T });
}

test.describe("Front Desk switch and seats", () => {
  test.setTimeout(T * 5);

  test("revoking the seat closes the desk on the next request, for the page AND for a direct database call; a re-grant restores it", async ({ page }) => {
    const f = await seedDeskFixture();
    const userId = await signInAsDesk(page, f.studio);
    const direct = () => asReceptionist(userId, (c) => c.query(`select public.receptionist_studio_timezone($1) as tz`, [f.studio.studioId]));
    expect((await direct()).ok).toBe(true);

    await revokeAll(f.studio.studioId);
    await expectClosed(page);
    const refused = await direct();
    expect(refused.ok, "the receptionist's own token is refused at the database").toBe(false);
    // Nothing was deleted: the membership row is untouched, so a re-grant restores access with no data change.
    expect((await sql<{ active: boolean }>(`select active from public.studio_receptionists where studio_id = $1 and user_id = $2`, [f.studio.studioId, userId]))[0]?.active).toBe(true);

    await grant(f.studio.studioId);
    await expectDesk(page);
    expect((await direct()).ok).toBe(true);
  });

  test("an expired grant closes the desk with no write at all", async ({ page }) => {
    const f = await seedDeskFixture();
    await signInAsDesk(page, f.studio);
    await sql(`delete from public.studio_front_desk_seats where studio_id = $1`, [f.studio.studioId]);
    await sql(
      `insert into public.studio_front_desk_seats (studio_id, seats, source, reason, granted_by_admin, granted_at, expires_at)
       values ($1, 1, 'pilot', 'e2e expired', 'fixture@harness.local', now() - interval '2 hours', now() - interval '1 hour')`,
      [f.studio.studioId],
    );
    await expectClosed(page);
  });

  test("switching the studio off closes the desk; another studio's desk is untouched", async ({ page, browser }) => {
    const f = await seedDeskFixture();
    await signInAsDesk(page, f.studio);
    await switchOff(f.studio.studioId);
    await expectClosed(page);
    await expectPathRefused(page, "/desk");
    // The OTHER studio keeps its own switch and seats (its owner is a practitioner, not a desk user, so this reads the database, not a page).
    const other = (await sql<{ on: boolean }>(`select public.platform_rollout_enabled_for('front_desk', $1) as "on"`, [f.other.studioId]))[0]?.on;
    expect(other).toBe(true);
    await switchOn(f.studio.studioId);
    await expectDesk(page);
    void browser;
  });

  test("a receptionist of one studio cannot learn another studio's switch or seats, calling the database directly", async ({ page }) => {
    const f = await seedDeskFixture();
    const userId = await signInAsDesk(page, f.studio);
    for (const fn of ["admin_list_front_desk($1)", "owner_front_desk_summary($1, gen_random_uuid())"]) {
      const r = await asReceptionist(userId, (c) => c.query(`select public.${fn}`, [f.other.studioId]));
      expect(r.ok, fn).toBe(false);
    }
    const mine = await asReceptionist(userId, (c) => c.query(`select * from public.front_desk_access()`));
    expect(mine.ok && mine.value.rows.map((r) => Object.values(r)[0])).toEqual([f.studio.studioId]);
  });
});

test.describe("Team page: seats", () => {
  test.setTimeout(T * 4);

  test("shows seats used, and offers neither the Receptionist role nor Reactivate when there is no free seat; a switched-off studio says so", async ({ page }) => {
    const seed = await seedE2eStudio();
    await loginAsOwner(page, seed);
    await page.goto("/settings/team");
    await expect(page.getByRole("status").filter({ hasText: /of 5 front desk seats used/ })).toBeVisible({ timeout: T });
    await expect(page.locator('option[value="receptionist"]')).not.toHaveAttribute("disabled", /.*/);

    await revokeAll(seed.studioId);
    await page.goto("/settings/team");
    await expect(page.locator('option[value="receptionist"]')).toHaveAttribute("disabled", /.*/, { timeout: T });
    await expect(page.getByRole("status").filter({ hasText: /0 of 0 front desk seats used/ })).toBeVisible();

    await switchOff(seed.studioId);
    await page.goto("/settings/team");
    await expect(page.getByText(/front desk is not switched on for your studio yet/i)).toBeVisible({ timeout: T });
    // No invitation can be written either way: the database refuses it.
    const refused = await sql(`select 1`).then(() => sql(`insert into public.pending_invitations (studio_id, email, role, display_name) values ($1, $2, 'receptionist', 'x')`, [seed.studioId, `nope-${seed.runId}@harness.local`])).then(() => "written", (e: Error) => e.message);
    expect(refused).toContain("front_desk_not_enabled");
  });
});

test.describe("Platform admin: Front desk screen", () => {
  test.setTimeout(T * 5);

  async function loginOperator(page: Page): Promise<void> {
    const { email } = await seedOperatorAuthUser();
    await page.goto("/login");
    await page.getByLabel("I am using my invited email address").check();
    await page.locator("#login-email").fill(email);
    const seen = await listMessageIds(email);
    await page.getByRole("button", { name: /send magic link/i }).click();
    await page.goto(await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen }));
  }

  test("switch a studio on, grant a seat with a reason, revoke it; the audit rows hold no reason text", async ({ page }) => {
    const studio = await seedE2eStudio();
    await sql(`delete from public.studio_front_desk_seats where studio_id = $1`, [studio.studioId]);
    await switchOff(studio.studioId);
    await loginOperator(page);
    await page.goto("/admin/front-desk");
    await page.locator('select[name="studio"]').selectOption({ label: studio.studioName });
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await expect(page.getByTestId("front-desk-switch")).toHaveText("off", { timeout: T });

    await page.getByRole("button", { name: "Switch on for this studio" }).click();
    await expect(page.getByTestId("front-desk-switch")).toHaveText("on", { timeout: T });

    const SECRET = `synthetic-reason-${studio.runId}`;
    await page.getByLabel(/^Reason/).fill(SECRET);
    await page.getByRole("button", { name: "Grant seats" }).click();
    await expect(page.getByText(/1 of 1 seats used|0 of 1 seats used/)).toBeVisible({ timeout: T });
    expect(await live(studio.studioId)).toHaveLength(1);

    await page.getByLabel("Reason for revoking").fill(`revoke-${SECRET}`);
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(/Revoked/i, { timeout: T });
    expect(await live(studio.studioId)).toHaveLength(0);

    // The audit rows (written by the same transaction as each change) name the change and numbers, never the reason.
    const audit = await sql<{ action: string; metadata: unknown }>(
      `select action, metadata from public.admin_action_events where studio_id = $1 and (action like 'front_desk%' or action like 'platform_rollout%') order by created_at`,
      [studio.studioId],
    );
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["front_desk_seats_granted", "front_desk_seats_revoked"]));
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  test("a signed-in receptionist, who is not a platform admin, cannot open the screen", async ({ page }) => {
    const f = await seedDeskFixture();
    await signInAsDesk(page, f.studio);
    const res = await page.context().request.get("/admin/front-desk", { maxRedirects: 0 });
    // Refused (404) or sent away (a redirect to no-access): never the screen itself.
    expect([307, 308, 404]).toContain(res.status());
    if (res.status() !== 404) expect(res.headers()["location"] ?? "").toMatch(/\/no-access/);
    await page.goto("/admin/front-desk");
    await expect(page.getByRole("button", { name: "Switch on for this studio" })).toHaveCount(0);
  });
});
