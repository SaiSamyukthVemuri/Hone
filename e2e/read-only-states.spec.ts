import { test, expect } from "@playwright/test";
import { E2E_DB_URL } from "./helpers/local-env";
import { seedE2eStudio, seedE2eMember, seedE2eDraftElectrolysisSession, seedConfirmedAppointment, sql } from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";

// Team, 4 Nov 2026: the two states #1351 b67bb4298 added (Privacy DW1, Insurance I-5), in a real browser, LOCAL owned stack only.
// NOT part of the repository tree (copied in untracked for the run). Restores everything it changes (release rows, the permission function).
const T = 20_000;
let prior: { key: string; released_at: string | null; release_tag: string; release_kind: string }[] = [];
let swapped = false;
test.afterAll(async () => {
  if (swapped) {
    await sql(`drop function if exists public.has_studio_permission(uuid, text, uuid, uuid, uuid)`);
    await sql(`alter function public.has_studio_permission_orig_e2e(uuid, text, uuid, uuid, uuid) rename to has_studio_permission`);
    swapped = false;
  }
  for (const r of prior) await sql(`update public.permission_key_release set released_at = $1::timestamptz, release_tag = $2, release_kind = $3 where key = $4`, [r.released_at, r.release_tag, r.release_kind, r.key]);
});

test("no-view and failed-read states on the appointment and session pages", async ({ browser }) => {
  const host = new URL(E2E_DB_URL).hostname;
  test.skip(!["127.0.0.1", "localhost", "::1"].includes(host), `BLOCKED: database host ${host} is not loopback`);
  const seed = await seedE2eStudio();
  const member = await seedE2eMember(seed);
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);
  const owner = (await sql<{ id: string }>(`select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1`, [seed.studioId]))[0]!;
  const start = new Date(Date.now() + 86_400_000).toISOString(), end = new Date(Date.now() + 86_400_000 + 3_600_000).toISOString();
  const apptId = await seedConfirmedAppointment(seed.studioId, owner.id, clientId, start, end);
  prior = await sql(`select key, released_at::text as released_at, release_tag, release_kind from public.permission_key_release where key in ('clin.view_records','clin.edit_records')`);
  await sql(`select public.mark_permissions_released(array['clin.view_records','clin.edit_records'], 'LOCAL-STATES-PROOF', 'full') where exists (select 1 from public.permission_key_release where key in ('clin.view_records','clin.edit_records') and released_at is null)`).catch(() => undefined);
  const released = await sql<{ n: string }>(`select count(*)::text as n from public.permission_key_release where key in ('clin.view_records','clin.edit_records') and released_at is not null`);
  test.skip(released[0]?.n !== "2", "BLOCKED: both keys are not released on this stack");

  const ctx = await browser.newContext();
  const prac = await ctx.newPage();
  await loginByMagicLink(prac, member.email);

  await test.step("DW1: practitioner with view Off sees 'Not available to your role.' on the appointment cards, never the read-only sentence", async () => {
    await sql(`insert into public.studio_role_permissions (studio_id, role, key, scope, set_at) values ($1,'practitioner','clin.view_records','off',now()) on conflict (studio_id, role, key) do update set scope='off', set_at=now()`, [seed.studioId]);
    await prac.goto(`/calendar/${apptId}`);
    await expect(prac.getByTestId("chart-session-not-available")).toBeVisible({ timeout: T });
    await expect(prac.getByText("You can view this chart but not change it.")).toHaveCount(0);
    await prac.screenshot({ path: test.info().outputPath("dw1-no-view-appointment.png"), fullPage: true });
    await sql(`delete from public.studio_role_permissions where studio_id = $1 and key = 'clin.view_records'`, [seed.studioId]);
  });

  await test.step("I-5: a FAILED edit-key read shows the check-failed words on the session page, never the read-only sentence", async () => {
    await sql(`alter function public.has_studio_permission(uuid, text, uuid, uuid, uuid) rename to has_studio_permission_orig_e2e`);
    swapped = true;
    await sql(`create function public.has_studio_permission(p_studio uuid, p_key text, p_client uuid default null, p_appointment uuid default null, p_practitioner uuid default null)
      returns boolean language plpgsql stable security definer set search_path = '' as $f$
      begin
        if p_key = 'clin.edit_records' then raise exception 'e2e injected permission read failure'; end if;
        return public.has_studio_permission_orig_e2e(p_studio, p_key, p_client, p_appointment, p_practitioner);
      end $f$`);
    await sql(`grant execute on function public.has_studio_permission(uuid, text, uuid, uuid, uuid) to authenticated`);
    await prac.goto(`/clients/${clientId}/sessions/${sessionId}`);
    await expect(prac.getByTestId("chart-read-only-note")).toContainText("We couldn't check your permissions", { timeout: T });
    await expect(prac.getByText("You can view this chart but not change it.")).toHaveCount(0);
    await prac.screenshot({ path: test.info().outputPath("i5-failed-read-session.png"), fullPage: true });
  });
  await ctx.close();
});
