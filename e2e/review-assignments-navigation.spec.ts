import { expect, test, type Page } from "@playwright/test";
import { loginByMagicLink } from "./helpers/flows";
import { seedClientInStudio, seedE2eMember, seedE2eStudio, setStudioCapacityEnabled, sql } from "./helpers/seed";

// #1330 practitioner-review flow, reached from NORMAL owner navigation, at 1280 and 390. Synthetic data only.
// Proves: real status (date passed vs treatment recorded), actionable vs historical sections, links, names with email secondary,
// owner-only visibility + non-owner 404, and that merely viewing changes no appointment row or audit row.
test.describe.configure({ mode: "serial" });

async function appt(studioId: string, clientId: string, practitionerId: string | null, createdBy: string | null, offsetDays: number, hourUtc: number): Promise<string> {
  const starts = new Date(Date.now() + offsetDays * 86_400_000);
  starts.setUTCHours(hourUtc, 0, 0, 0);
  const ends = new Date(starts.getTime() + 30 * 60_000);
  const rows = await sql<{ id: string }>(
    `insert into public.appointments (id, studio_id, client_id, practitioner_id, created_by_practitioner_id, starts_at, ends_at,
        duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 30, 0, $6, 'confirmed') returning id`,
    [studioId, clientId, practitionerId, createdBy, starts.toISOString(), ends.toISOString()],
  );
  return rows[0]!.id;
}

const snapshot = async (studioId: string) => ({
  appts: await sql(`select to_jsonb(a) as j from public.appointments a where studio_id = $1 order by id`, [studioId]),
  audit: (await sql<{ n: string }>(`select count(*)::text as n from public.appointment_audit where studio_id = $1`, [studioId]))[0]!.n,
});

for (const vp of [{ name: "1280", width: 1280, height: 900 }, { name: "390", width: 390, height: 844 }]) {
  test(`owner reaches and reads the review page by navigation at ${vp.name}; a non-owner cannot`, async ({ browser }) => {
    test.setTimeout(300_000);
    const s = await seedE2eStudio();
    await setStudioCapacityEnabled(s.studioId, false);
    const m = await seedE2eMember(s);
    const cli = await seedClientInStudio(s.studioId, `REV${vp.name}`);
    const ownerId = (await sql<{ id: string }>(`select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1`, [s.studioId]))[0]!.id;

    const upcoming = await appt(s.studioId, cli.clientId, null, null, 4, 10); // future, no practitioner
    const passedNoTreatment = await appt(s.studioId, cli.clientId, null, null, -3, 10); // date passed, nothing recorded
    const treated = await appt(s.studioId, cli.clientId, ownerId, m.practitionerId, -2, 11); // date passed, chart exists
    const startedAt = new Date(Date.now() - 2 * 86_400_000 + 5 * 60_000).toISOString();
    await sql(
      `insert into public.sessions (id, studio_id, client_id, practitioner_id, performed_by_practitioner_id, appointment_id, started_at, modality)
       values (gen_random_uuid(), $1, $2, $3, $3, $4, $5, 'electrolysis')`,
      [s.studioId, cli.clientId, m.practitionerId, treated, startedAt],
    );
    const before = await snapshot(s.studioId);

    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const mctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    try {
      const page: Page = await ctx.newPage();
      await loginByMagicLink(page, s.ownerEmail);

      // Route 1: Calendar toolbar link.
      await page.goto("/calendar?view=week");
      const link = page.getByTestId("calendar-review-assignments");
      await expect(link).toBeVisible({ timeout: 30_000 });
      await expect(link).toHaveText(/Review practitioner assignments/);
      await link.click();
      await expect(page).toHaveURL(/\/calendar\/check-practitioner/, { timeout: 30_000 });
      await expect(page.getByRole("heading", { name: "Review practitioner assignments" })).toBeVisible();

      // Sections: actionable vs historical, with the real status.
      const up = page.getByTestId("check-section-upcoming");
      const dp = page.getByTestId("check-section-date_passed");
      const tr = page.getByTestId("check-section-treatment_recorded");
      await expect(up.getByTestId("check-practitioner-item")).toHaveCount(1);
      await expect(dp.getByTestId("check-practitioner-item")).toHaveCount(1);
      await expect(tr.getByTestId("check-practitioner-item")).toHaveCount(1);
      await expect(up.getByTestId("check-practitioner-status")).toHaveText("Not started.");
      await expect(up.getByTestId("check-practitioner-select")).toBeVisible(); // actionable
      await expect(dp.getByTestId("check-practitioner-status")).toContainText("date has passed. No treatment is recorded");
      await expect(tr.getByTestId("check-practitioner-status")).toContainText("Treatment recorded, started");
      // Historical rows offer no reassignment control.
      await expect(dp.getByTestId("check-practitioner-select")).toHaveCount(0);
      await expect(tr.getByTestId("check-practitioner-select")).toHaveCount(0);
      await expect(dp.getByTestId("check-practitioner-historical")).toBeVisible();
      await expect(tr.getByTestId("check-practitioner-historical")).toBeVisible();
      // The wrong word is gone.
      await expect(page.getByText(/already started/i)).toHaveCount(0);
      // Names first, email secondary.
      await expect(tr.getByText(m.displayName).first()).toBeVisible();
      await expect(tr.getByText(`Chart written by: ${m.displayName}`)).toBeVisible(); // performer by name only
      await expect(tr.getByText(s.ownerEmail).first()).toBeVisible(); // recorded practitioner's email is the secondary line
      await expect(tr.getByText(new RegExp(`Recorded practitioner:\\s*\\S`))).toBeVisible();
      // Links to each appointment.
      for (const [sec, id] of [[up, upcoming], [dp, passedNoTreatment], [tr, treated]] as const) {
        await expect(sec.getByTestId("check-practitioner-open")).toHaveAttribute("href", `/calendar/${id}`);
      }
      await expect(page.getByTestId("check-practitioner-summary")).toContainText("1 can be reassigned now");
      // No horizontal overflow of the document at this width.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);

      // Open appointment link works.
      await tr.getByTestId("check-practitioner-open").click();
      await expect(page).toHaveURL(new RegExp(`/calendar/${treated}`), { timeout: 30_000 });

      // Route 2: Team settings link.
      await page.goto("/settings/team");
      const tlink = page.getByTestId("team-review-assignments");
      await expect(tlink).toBeVisible({ timeout: 30_000 });
      await tlink.click();
      await expect(page).toHaveURL(/\/calendar\/check-practitioner/, { timeout: 30_000 });
      await expect(page.getByTestId("check-section-upcoming")).toBeVisible();

      // Non-owner: no link anywhere, and the page is a 404.
      const mp = await mctx.newPage();
      await loginByMagicLink(mp, m.email);
      await mp.goto("/calendar?view=week");
      await expect(mp.getByTestId("calendar-review-assignments")).toHaveCount(0);
      await mp.goto("/settings/team");
      await expect(mp.getByTestId("team-review-assignments")).toHaveCount(0);
      expect((await mp.goto("/calendar/check-practitioner"))?.status()).toBe(404);
      await expect(mp.getByTestId("check-practitioner-item")).toHaveCount(0);

      // Viewing changed nothing: appointments (status, practitioner, payment fields, everything) and audit are identical.
      const after = await snapshot(s.studioId);
      expect(after).toEqual(before);
    } finally {
      await ctx.close();
      await mctx.close();
    }
  });
}
