import { test, expect } from "@playwright/test";
import { E2E_DB_URL } from "./helpers/local-env";
import { seedE2eStudio, seedE2eMember, seedE2eDraftElectrolysisSession, sql } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// Roles R4 read-only chart mode (Privacy BA2), real browser, LOCAL owned stack only.
//
// The state under test is "clin.edit_records RELEASED and this practitioner Off". The Roles page cannot make it (the key is `not_yet` in the
// catalog), so this spec makes it with SQL on the local stack, exactly as a hosted operator would later: the operator command
// mark_permissions_released, then a stored Off written AFTER the release. It is NEVER valid against a hosted database: the first step refuses
// any non-loopback database host, and the second asserts the resulting state before any page is opened. If the state is not what the proof needs,
// the case reports BLOCKED (skipped with that reason), never a pass or a fail.

const T = 20_000;

// Insurance B-1: the release row is GLOBAL to the stack, so the arrange step must not leave it released for later specs. The prior row is read
// before the arrange step and put back in afterAll (also when the case fails or is skipped after arranging).
let priorRelease: { released_at: string | null; release_tag: string; release_kind: string } | null = null;
test.afterAll(async () => {
  if (!priorRelease) return;
  await sql(
    `update public.permission_key_release set released_at = $1::timestamptz, release_tag = $2, release_kind = $3 where key = 'clin.edit_records'`,
    [priorRelease.released_at, priorRelease.release_tag, priorRelease.release_kind],
  );
});

test("a practitioner with clin.edit_records Off sees the chart read-only; the owner still edits", async ({ browser }) => {
  const host = new URL(E2E_DB_URL).hostname;
  test.skip(!["127.0.0.1", "localhost", "::1"].includes(host), `BLOCKED: database host ${host} is not loopback; this fixture is local-stack only`);

  const seed = await seedE2eStudio();
  const member = await seedE2eMember(seed);
  const { clientId, sessionId } = await seedE2eDraftElectrolysisSession(seed);

  // Codex P2 x2: an ATTACHED plan and the session start time, so read-only mode can be seen to keep the information and drop the controls.
  const planName = `RO Plan ${seed.runId}`;
  const plan = (await sql<{ id: string }>(`insert into public.treatment_plans (studio_id, client_id, status, name) values ($1,$2,'active',$3) returning id`, [seed.studioId, clientId, planName]))[0]!;
  await sql(`update public.sessions set treatment_plan_id = $1 where id = $2`, [plan.id, sessionId]);

  priorRelease = (
    await sql<{ released_at: string | null; release_tag: string; release_kind: string }>(
      `select released_at::text as released_at, release_tag, release_kind from public.permission_key_release where key = 'clin.edit_records'`,
    )
  )[0] ?? null;

  await test.step("arrange (local only): operator releases the key, then the owner's Off is stored for the practitioner role", async () => {
    await sql(
      `select public.mark_permissions_released(array['clin.edit_records'], 'LOCAL-BA2-PROOF', 'full')
        where not exists (select 1 from public.permission_key_release where key = 'clin.edit_records' and released_at is not null)`,
    );
    await sql(
      `insert into public.studio_role_permissions (studio_id, role, key, scope, set_at) values ($1, 'practitioner', 'clin.edit_records', 'off', now())
       on conflict (studio_id, role, key) do update set scope = excluded.scope, set_at = excluded.set_at`,
      [seed.studioId],
    );
  });

  await test.step("assert the state first (BLOCKED, not pass/fail, if it is missing)", async () => {
    const released = await sql<{ released_at: string | null }>(`select released_at::text from public.permission_key_release where key = 'clin.edit_records'`);
    const stored = await sql<{ scope: string }>(
      `select scope from public.studio_role_permissions where studio_id = $1 and role = 'practitioner' and key = 'clin.edit_records'`,
      [seed.studioId],
    );
    const effective = await sql<{ e: string }>(`select public.perm_effective_scope($1, 'practitioner', 'clin.edit_records') as e`, [seed.studioId]);
    test.skip(!released[0]?.released_at || stored[0]?.scope !== "off" || effective[0]?.e !== "off", "BLOCKED: clin.edit_records is not released with the practitioner Off on this stack");
  });

  const ownerCtx = await browser.newContext();
  const memberCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const prac = await memberCtx.newPage();
  const sessionUrl = `/clients/${clientId}/sessions/${sessionId}`;

  await test.step("control: the owner (key not Off for the owner role) still sees the edit controls and no read-only note", async () => {
    await loginAsOwner(owner, seed);
    await owner.goto(sessionUrl);
    await expect(owner.getByTestId("add-settings-block-cta")).toBeVisible({ timeout: T });
    await expect(owner.getByTestId("chart-read-only-note")).toHaveCount(0);
    await expect(owner.getByRole("button", { name: /procedure risks explained/i })).toBeVisible({ timeout: T });
    // owner: the plan has its Detach control and the start time keeps its editor (no static stand-in)
    await expect(owner.getByRole("button", { name: /detach treatment plan/i })).toBeVisible({ timeout: T });
    await expect(owner.getByTestId("session-started-at-static")).toHaveCount(0);
    await expect(owner.getByTestId("plan-attachment-read-only")).toHaveCount(0);
  });

  await test.step("practitioner (Off): session chart is read-only: note shown, edit controls withdrawn", async () => {
    await loginByMagicLink(prac, member.email);
    await prac.goto(sessionUrl);
    await expect(prac.getByTestId("chart-read-only-note")).toBeVisible({ timeout: T });
    await expect(prac.getByTestId("chart-read-only-note")).toContainText("You can view this chart but not change it.");
    await expect(prac.getByTestId("add-settings-block-cta")).toHaveCount(0);
    await expect(prac.getByRole("button", { name: /procedure risks explained/i })).toHaveCount(0); // Codex P2: no control that would be refused
    // Codex P2 (r4472078942): the session start time stays visible as static text
    await expect(prac.getByTestId("session-started-at-static")).toBeVisible({ timeout: T });
    await expect(prac.getByTestId("session-started-at-static")).toContainText("Started");
    // Codex P2 (r4472078957): no plan attach/detach control; the attached plan is still shown, as read-only text
    await expect(prac.getByRole("button", { name: /detach|attach/i })).toHaveCount(0);
    await expect(prac.getByTestId("plan-attachment-read-only")).toContainText(planName);
    await prac.screenshot({ path: test.info().outputPath("practitioner-session-read-only.png"), fullPage: true });
  });

  await test.step("practitioner (Off): client profile treatment tab shows the read-only note; the owner's does not", async () => {
    await prac.goto(`/clients/${clientId}?tab=treatment`);
    await expect(prac.getByTestId("chart-read-only-note")).toBeVisible({ timeout: T });
    await owner.goto(`/clients/${clientId}?tab=treatment`);
    await expect(owner.getByTestId("chart-read-only-note")).toHaveCount(0);
  });

  await test.step("practitioner (Off): no way to START a chart is offered, and the new-session URL explains instead of erroring (Codex P2)", async () => {
    await prac.goto(`/clients/${clientId}`);
    await expect(prac.getByTestId("log-session-read-only")).toBeVisible({ timeout: T });
    await expect(prac.getByRole("link", { name: /log session/i })).toHaveCount(0);
    await prac.goto(`/clients/${clientId}/sessions/new`);
    await expect(prac.getByTestId("new-session-read-only")).toBeVisible({ timeout: T });
    await expect(prac.getByRole("button", { name: /electrolysis/i })).toHaveCount(0);
    await owner.goto(`/clients/${clientId}`);
    await expect(owner.getByRole("link", { name: /log session/i })).toBeVisible({ timeout: T });
  });

  await test.step("viewing is NOT withdrawn: the practitioner can still open the chart (no view refusal)", async () => {
    await expect(prac.getByText(/not available to your role/i)).toHaveCount(0);
  });

  await ownerCtx.close();
  await memberCtx.close();
});
