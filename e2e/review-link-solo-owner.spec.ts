import { expect, test, type Page } from "@playwright/test";
import { loginByMagicLink } from "./helpers/flows";
import {
  insertPendingInvite,
  seedClientInStudio,
  seedE2eMember,
  seedE2eStudio,
  seedNoStudioAuthUser,
  setPractitionerActive,
  setStudioCapacityEnabled,
  sql,
} from "./helpers/seed";

// Sam 2 Nov: the "Review practitioner assignments" link is hidden when the owner is the studio's only ACTIVE practitioner and nothing is
// left to review; shown once another practitioner is active; shown in a solo studio that still has rows to review. Pending invitations
// and receptionists do not count. The page URL itself stays reachable to owners. Synthetic data, 1280 and 390.
test.describe.configure({ mode: "serial" });

const LINKS = ["calendar-review-assignments", "team-review-assignments"] as const;
const PAGES = { "calendar-review-assignments": "/calendar?view=week", "team-review-assignments": "/settings/team" } as const;

async function openWithOwner(browser: import("@playwright/test").Browser, email: string, width: number, height: number) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await loginByMagicLink(page, email);
  return { ctx, page };
}

async function expectLinks(page: Page, shown: boolean) {
  for (const id of LINKS) {
    await page.goto(PAGES[id]);
    if (shown) await expect(page.getByTestId(id)).toBeVisible({ timeout: 30_000 });
    else {
      // wait for the page itself so "absent" cannot mean "not rendered yet"
      await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(id)).toHaveCount(0);
    }
  }
}

const unresolvedAppt = async (studioId: string, clientId: string) => {
  const starts = new Date(Date.now() + 4 * 86_400_000);
  starts.setUTCHours(10, 0, 0, 0);
  const ends = new Date(starts.getTime() + 30 * 60_000);
  await sql(
    `insert into public.appointments (id, studio_id, client_id, practitioner_id, starts_at, ends_at, duration_minutes,
        buffer_minutes_snapshot, blocked_ends_at, status)
     values (gen_random_uuid(), $1, $2, null, $3, $4, 30, 0, $4, 'confirmed')`,
    [studioId, clientId, starts.toISOString(), ends.toISOString()],
  );
};

for (const vp of [{ name: "1280", width: 1280, height: 900 }, { name: "390", width: 390, height: 844 }]) {
  test.describe(`review link visibility at ${vp.name}`, () => {
    test("(a) solo owner, nothing to review: hidden; the page is still reachable by URL", async ({ browser }) => {
      test.setTimeout(240_000);
      const s = await seedE2eStudio();
      await setStudioCapacityEnabled(s.studioId, false);
      const { ctx, page } = await openWithOwner(browser, s.ownerEmail, vp.width, vp.height);
      try {
        await expectLinks(page, false);
        expect((await page.goto("/calendar/check-practitioner"))?.status()).toBe(200);
        await expect(page.getByTestId("check-practitioner-empty")).toBeVisible();
      } finally {
        await ctx.close();
      }
    });

    test("(b) solo owner with an unresolved appointment (no practitioner recorded): shown, and it opens the review", async ({ browser }) => {
      test.setTimeout(240_000);
      const s = await seedE2eStudio();
      await setStudioCapacityEnabled(s.studioId, false);
      const cli = await seedClientInStudio(s.studioId, `SOLOB${vp.name}`);
      await unresolvedAppt(s.studioId, cli.clientId);
      const { ctx, page } = await openWithOwner(browser, s.ownerEmail, vp.width, vp.height);
      try {
        await expectLinks(page, true);
        await page.goto("/calendar?view=week");
        await page.getByTestId("calendar-review-assignments").click();
        await expect(page).toHaveURL(/\/calendar\/check-practitioner/, { timeout: 30_000 });
        await expect(page.getByTestId("check-practitioner-item")).toHaveCount(1);
      } finally {
        await ctx.close();
      }
    });

    test("(c) owner plus one active practitioner: shown", async ({ browser }) => {
      test.setTimeout(240_000);
      const s = await seedE2eStudio();
      await setStudioCapacityEnabled(s.studioId, false);
      await seedE2eMember(s);
      const { ctx, page } = await openWithOwner(browser, s.ownerEmail, vp.width, vp.height);
      try {
        await expectLinks(page, true);
      } finally {
        await ctx.close();
      }
    });

    test("(d) owner plus a pending invitation only: hidden", async ({ browser }) => {
      test.setTimeout(240_000);
      const s = await seedE2eStudio();
      await setStudioCapacityEnabled(s.studioId, false);
      await insertPendingInvite(s.studioId, `solo-invite-${vp.name}-${Date.now()}@harness.local`);
      const { ctx, page } = await openWithOwner(browser, s.ownerEmail, vp.width, vp.height);
      try {
        await expectLinks(page, false);
      } finally {
        await ctx.close();
      }
    });

    test("(e) owner plus a receptionist only: hidden", async ({ browser }) => {
      test.setTimeout(240_000);
      const s = await seedE2eStudio();
      await setStudioCapacityEnabled(s.studioId, false);
      const r = await seedNoStudioAuthUser();
      const uid = (await sql<{ id: string }>(`select id from auth.users where lower(email) = lower($1)`, [r.email]))[0]!.id;
      await sql(`insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ($1, $2, 'Synthetic Front Desk', true)`, [s.studioId, uid]);
      const { ctx, page } = await openWithOwner(browser, s.ownerEmail, vp.width, vp.height);
      try {
        await expectLinks(page, false);
      } finally {
        await ctx.close();
      }
    });

    test("(f) owner plus a deactivated second practitioner: hidden", async ({ browser }) => {
      test.setTimeout(240_000);
      const s = await seedE2eStudio();
      await setStudioCapacityEnabled(s.studioId, false);
      const m = await seedE2eMember(s);
      await setPractitionerActive(m.practitionerId, false);
      const { ctx, page } = await openWithOwner(browser, s.ownerEmail, vp.width, vp.height);
      try {
        await expectLinks(page, false);
      } finally {
        await ctx.close();
      }
    });
  });
}
