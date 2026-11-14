import { expect, test, type Page } from "@playwright/test";
import {
  getOwnerPractitionerId, seedE2eMember, seedE2eStudio, seedPractitionerDefault, setStudioCapacityBookingEnabled,
  setStudioCapacityEnabled, setStudioTimezone, sql, type E2eSeed,
} from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";

// Opt-in browser pass for Roles S2 (#1446 / #1448): ROLES_PEOPLE_E2E=1. It needs 0342 applied on the owned stack and the engine on (core readable).
// SYNTHETIC data only, one team studio: the owner, practitioners A and B, and a desk receptionist R (a studio_receptionists row, no sign-in).
// The staff_role_change gate is opened ONLY for that synthetic studio (as the operator would), and only in the cases that need it.
//
//   1  gate off: Remove is offered for A, B and R and never for the owner; a deactivated person shows "Restoring access is not available yet." and NO button
//   2  Remove needs a meaningful reason (blank and "n/a" keep the button disabled); A is removed: notice, Deactivated list, active=false, one 'staff_deactivated' audit row with the reason
//   3  History shows "Access removed" for A
//   4  Calendar acceptance: after A is removed the owner's team calendar no longer lists A, still lists the owner and B
//   5  B has an upcoming appointment: removal still works (policy 'keep'), the notice reports the count, the appointment stays assigned to B
//   6  gate on: Restore (reason required) brings A back: Active list, active=true, a 'staff_reactivated' audit row; the calendar lists A again
//   7  the receptionist R is removed and restored through the same controls (deactivated_at set, then cleared)
//   8  Team page: Remove carries a required reason field; with a reason it removes the practitioner and writes the audit row
//
// Not covered here (needs the receptionist desk, held default-off, #1303): a receptionist signing in and seeing everyone's calendar. The
// own-calendar-first matrix for practitioners is e2e/calendar-own-first.spec.ts (CAL_OWN_FIRST_E2E=1).
test.skip(process.env.ROLES_PEOPLE_E2E !== "1", "opt-in Roles S2 People remove/restore; set ROLES_PEOPLE_E2E=1");

const TZ = "America/Los_Angeles";
const REASON = "Left the studio at the end of the month";

type Team = {
  seed: E2eSeed;
  ownerId: string;
  a: { id: string; email: string; name: string };
  b: { id: string; email: string; name: string };
  r: { id: string; name: string };
  c: { id: string; email: string; name: string };
};
let team: Promise<Team> | null = null;

function getTeam(): Promise<Team> {
  team ??= (async () => {
    const seed = await seedE2eStudio();
    await setStudioTimezone(seed.studioId, TZ);
    await setStudioCapacityEnabled(seed.studioId, true);
    await setStudioCapacityBookingEnabled(seed.studioId, true);
    const ownerId = await getOwnerPractitionerId(seed.studioId);
    const a = await seedE2eMember(seed);
    const b = await seedE2eMember(seed);
    const c = await seedE2eMember(seed);
    for (const id of [ownerId, a.practitionerId, b.practitionerId, c.practitionerId]) {
      for (let dow = 0; dow < 7; dow++) await seedPractitionerDefault(seed.studioId, id, dow, true, "08:00", "20:00");
    }
    await sql("update public.practitioners set display_name=$3 where studio_id=$1 and id=$2", [seed.studioId, ownerId, "Synthetic Owner"]);
    const r = await sql<{ id: string }>(
      "insert into public.studio_receptionists(studio_id, display_name, email, active) values ($1,'Desk Synthetic',$2,true) returning id",
      [seed.studioId, `desk-${seed.runId}@harness.local`],
    );
    return {
      seed, ownerId,
      a: { id: a.practitionerId, email: a.email, name: a.displayName },
      b: { id: b.practitionerId, email: b.email, name: b.displayName },
      c: { id: c.practitionerId, email: c.email, name: c.displayName },
      r: { id: r[0].id, name: "Desk Synthetic" },
    };
  })();
  return team;
}

const person = (page: Page, id: string) => page.locator(`[data-person="${id}"]`);
const calendarIds = async (page: Page): Promise<string[]> =>
  (await page.getByTestId("team-day-column-header").evaluateAll((els) => els.map((e) => e.getAttribute("data-practitioner-id") ?? ""))).sort();

async function openPeople(page: Page): Promise<void> {
  await page.goto("/settings/roles");
  await page.getByRole("tab", { name: "People" }).click();
  await expect(page.getByTestId("roles-people")).toBeVisible();
}

async function openOwnerCalendar(page: Page): Promise<void> {
  await page.goto("/calendar");
  await expect(page.getByTestId("calendar-sidebar")).toBeAttached();
}

async function removeThrough(page: Page, id: string, reason: string): Promise<void> {
  const row = person(page, id);
  await row.getByTestId("remove-access").getByRole("button", { name: "Remove access" }).click();
  await row.getByTestId("remove-access-reason").fill(reason);
  await row.getByTestId("remove-access-confirm").click();
}

const auditRows = (studioId: string, kind: string) =>
  sql<{ reason: string; membership_id: string; membership_kind: string }>(
    "select reason, membership_id, membership_kind from public.permission_audit where studio_id=$1 and kind=$2 order by id",
    [studioId, kind],
  );
const activeOf = async (table: "practitioners" | "studio_receptionists", id: string) =>
  (await sql<{ active: boolean }>(`select active from public.${table} where id=$1`, [id]))[0].active;
const openGate = (studioId: string) =>
  sql("insert into public.permission_ship_gates(studio_id,gate,met) values ($1,'staff_role_change',true) on conflict (studio_id,gate) do update set met=true", [studioId]);

test.describe.configure({ mode: "serial" });

test("1: gate off: Remove for A, B and R, never the owner; a deactivated person has a plain line and no Restore button", async ({ page }) => {
  const t = await getTeam();
  await sql("update public.practitioners set active=false where id=$1", [t.c.id]); // C is already deactivated (only to look at the line)
  await loginByMagicLink(page, t.seed.ownerEmail);
  await openPeople(page);
  for (const id of [t.a.id, t.b.id, t.r.id]) await expect(person(page, id).getByTestId("remove-access")).toBeVisible();
  await expect(person(page, t.ownerId).getByTestId("remove-access")).toHaveCount(0);
  await expect(person(page, t.c.id)).toContainText("Restoring access is not available yet.");
  await expect(person(page, t.c.id).getByRole("button", { name: /restore access/i })).toHaveCount(0);
  await expect(person(page, t.c.id).getByTestId("restore-access")).toHaveCount(0);
});

test("2: Remove needs a meaningful reason; A is removed with a notice, an audit row and active=false", async ({ page }) => {
  const t = await getTeam();
  await loginByMagicLink(page, t.seed.ownerEmail);
  await openPeople(page);
  const row = person(page, t.a.id);
  await row.getByTestId("remove-access").getByRole("button", { name: "Remove access" }).click();
  const confirm = row.getByTestId("remove-access-confirm");
  await expect(confirm).toBeDisabled();
  await row.getByTestId("remove-access-reason").fill("n/a");
  await expect(confirm).toBeDisabled();
  await row.getByTestId("remove-access-reason").fill(REASON);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId("change-role-ok")).toContainText(`${t.a.name}'s access was removed. It is in the history.`);
  await expect(page.locator('[data-people-state="deactivated"]').locator(`[data-person="${t.a.id}"]`)).toBeVisible();
  expect(await activeOf("practitioners", t.a.id)).toBe(false);
  const rows = await auditRows(t.seed.studioId, "staff_deactivated");
  expect(rows.filter((r) => r.membership_id === t.a.id)).toEqual([{ reason: REASON, membership_id: t.a.id, membership_kind: "practitioner" }]);
});

test("3: History shows 'Access removed'", async ({ page }) => {
  const t = await getTeam();
  await loginByMagicLink(page, t.seed.ownerEmail);
  await page.goto("/settings/roles");
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.locator('[data-audit-kind="staff_deactivated"]').first()).toContainText("Access removed");
});

test("4: calendar: the removed practitioner is gone from the team calendar; the owner and B remain", async ({ page }) => {
  const t = await getTeam();
  await loginByMagicLink(page, t.seed.ownerEmail);
  await openOwnerCalendar(page);
  const ids = await calendarIds(page);
  expect(ids).not.toContain(t.a.id);
  expect(ids).toContain(t.ownerId);
  expect(ids).toContain(t.b.id);
});

test("5: B has an upcoming appointment: removal still works, the notice reports the count, the appointment stays with B", async ({ page }) => {
  const t = await getTeam();
  const clientId = (await sql<{ id: string }>("select id from public.clients where studio_id=$1 limit 1", [t.seed.studioId]))[0].id;
  await sql(
    `insert into public.appointments (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
     values ($1,$2,$3, now() + interval '3 days', now() + interval '3 days 30 minutes', 30, 'confirmed')`,
    [t.seed.studioId, t.b.id, clientId],
  );
  await loginByMagicLink(page, t.seed.ownerEmail);
  await openPeople(page);
  await removeThrough(page, t.b.id, REASON);
  await expect(page.getByTestId("change-role-ok")).toContainText("They still have 1 upcoming appointment, which stays assigned to them.");
  expect(await activeOf("practitioners", t.b.id)).toBe(false);
  expect((await sql<{ n: number }>("select count(*)::int n from public.appointments where studio_id=$1 and practitioner_id=$2", [t.seed.studioId, t.b.id]))[0].n).toBe(1);
});

test("6: gate on: Restore (reason required) brings A back; the calendar lists A again", async ({ page }) => {
  const t = await getTeam();
  await openGate(t.seed.studioId);
  await loginByMagicLink(page, t.seed.ownerEmail);
  await openPeople(page);
  const row = person(page, t.a.id);
  await row.getByTestId("restore-access").getByRole("button", { name: "Restore access" }).click();
  const confirm = row.getByTestId("restore-access-confirm");
  await expect(confirm).toBeDisabled();
  await row.getByTestId("restore-access-reason").fill("Back from leave and covering the front chairs");
  await confirm.click();
  await expect(page.getByTestId("change-role-ok")).toContainText(`${t.a.name}'s access was restored. It is in the history.`);
  await expect(page.locator('[data-people-state="active"]').locator(`[data-person="${t.a.id}"]`)).toBeVisible();
  expect(await activeOf("practitioners", t.a.id)).toBe(true);
  expect((await auditRows(t.seed.studioId, "staff_reactivated")).map((r) => r.membership_id)).toContain(t.a.id);
  await openOwnerCalendar(page);
  expect(await calendarIds(page)).toContain(t.a.id);
});

test("7: the receptionist is removed and restored through the same controls (deactivated_at set, then cleared)", async ({ page }) => {
  const t = await getTeam();
  await loginByMagicLink(page, t.seed.ownerEmail);
  await openPeople(page);
  await removeThrough(page, t.r.id, REASON);
  await expect(page.getByTestId("change-role-ok")).toContainText(`${t.r.name}'s access was removed.`);
  const q = async () => (await sql<{ active: boolean; deactivated_at: string | null }>("select active, deactivated_at from public.studio_receptionists where id=$1", [t.r.id]))[0];
  expect(await q()).toMatchObject({ active: false });
  expect((await q()).deactivated_at).not.toBeNull();
  const row = person(page, t.r.id);
  await row.getByTestId("restore-access").getByRole("button", { name: "Restore access" }).click();
  await row.getByTestId("restore-access-reason").fill("Returning to the front desk on Monday");
  await row.getByTestId("restore-access-confirm").click();
  await expect(page.getByTestId("change-role-ok")).toContainText(`${t.r.name}'s access was restored.`);
  expect(await q()).toEqual({ active: true, deactivated_at: null });
});

test("8: Team: Remove carries a required reason field; with a reason it removes and writes the audit row", async ({ page }) => {
  const t = await getTeam();
  await sql("update public.practitioners set active=true where id=$1", [t.c.id]);
  await loginByMagicLink(page, t.seed.ownerEmail);
  await page.goto("/settings/team");
  const form = page.locator("form").filter({ has: page.locator(`input[name="id"][value="${t.c.id}"]`) });
  const reason = form.locator('input[name="reason"]');
  await expect(reason).toHaveAttribute("required", "");
  await reason.fill(REASON);
  await form.getByRole("button", { name: "Remove" }).click();
  await expect.poll(() => activeOf("practitioners", t.c.id)).toBe(false);
  expect((await auditRows(t.seed.studioId, "staff_deactivated")).map((r) => r.membership_id)).toContain(t.c.id);
});
