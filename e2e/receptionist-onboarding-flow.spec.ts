import { test, expect, devices, type Page } from "@playwright/test";
import { expectPathRefused, signInWithMagicLink } from "./helpers/desk";
import { loginAsOwner } from "./helpers/flows";
import {
  getE2eServiceId, getOwnerPractitionerId, seedE2eClient, seedE2eMember, seedE2eStudio, sql,
} from "./helpers/seed";

// Receptionist onboarding, end to end in a real browser, on desktop and on an emulated iPhone:
//   owner: Settings -> Team -> invite a receptionist  ->  receptionist: sign in, accept  ->  lands on THIS studio's desk
//   -> books a visit for a returning client  ->  owner removes the receptionist  ->  the receptionist's ALREADY-OPEN page is refused on its next request.
// The database rules are in tests/db/receptionist-invitation.db.test.ts; the desk's own behaviour is in desk-calendar.spec.ts. This proves the chain between them.

const T = 60_000;

for (const profile of [
  { name: "desktop", context: {} },
  { name: "iPhone", context: { ...devices["iPhone 13"] } },
]) {
  test(`onboarding: invite, accept, the right desk, book, removal refused in an open session (${profile.name})`, async ({ browser }) => {
    test.setTimeout(T * 5);
    const studio = await seedE2eStudio();
    const member = await seedE2eMember(studio);
    const ownerId = await getOwnerPractitionerId(studio.studioId);
    const serviceId = await getE2eServiceId(studio.studioId);

    // THIS studio's visit (client names set so the privacy assertions have something to bite on), and ANOTHER studio's visit that must never appear.
    const { clientId } = await seedE2eClient(studio);
    await sql("update public.clients set name='Ari Account', preferred_name='Ari Rowan', phone='+14165550188' where id=$1", [clientId]);
    const { clientId: returningId } = await seedE2eClient(studio);
    await sql("update public.clients set name='Morgan Vale', preferred_name=null where id=$1", [returningId]);
    const [{ local_day: date }] = await sql<{ local_day: string }>(
      `with slot as (select ((now() at time zone timezone)::date + 1 + time '13:00') at time zone timezone as starts, timezone from public.studios where id = $1),
            booked as (insert into public.appointments (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, blocked_ends_at, duration_minutes, buffer_minutes_snapshot, status)
                       select $1, $2, $3, $4, starts, starts + interval '30 minutes', starts + interval '30 minutes', 30, 0, 'confirmed' from slot returning starts_at)
       select to_char(booked.starts_at at time zone slot.timezone, 'YYYY-MM-DD') as local_day from booked, slot`,
      [studio.studioId, ownerId, clientId, serviceId],
    );
    const other = await seedE2eStudio();
    const otherClient = await seedE2eClient(other);
    await sql("update public.clients set name='Other Studio Person', preferred_name='Other Studio Person' where id=$1", [otherClient.clientId]);
    await sql(
      `insert into public.appointments (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at, blocked_ends_at, duration_minutes, buffer_minutes_snapshot, status)
       select $1, $2, $3, $4, a.starts_at, a.ends_at, a.blocked_ends_at, 30, 0, 'confirmed' from public.appointments a where a.studio_id = $5 limit 1`,
      [other.studioId, await getOwnerPractitionerId(other.studioId), otherClient.clientId, await getE2eServiceId(other.studioId), studio.studioId],
    );

    // 1. OWNER invites a receptionist from Settings -> Team.
    const ownerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    await loginAsOwner(ownerPage, studio);
    await ownerPage.goto("/settings/team");
    const deskEmail = `desk-${profile.name.toLowerCase()}-${studio.runId}@harness.local`;
    await ownerPage.getByLabel(/email/i).first().fill(deskEmail);
    await ownerPage.locator("select").filter({ has: ownerPage.locator('option[value="receptionist"]') }).selectOption("receptionist");
    await ownerPage.getByRole("button", { name: /send invite|invite/i }).first().click();
    await expect
      .poll(async () => (await sql<{ role: string }>(`select role from public.pending_invitations where studio_id=$1 and lower(email)=$2 and status='pending'`, [studio.studioId, deskEmail]))[0]?.role, { timeout: 30_000 })
      .toBe("receptionist");

    // 2. RECEPTIONIST signs in (real magic link), accepts, and lands on THIS studio's desk.
    const deskCtx = await browser.newContext(profile.context);
    const desk = await deskCtx.newPage();
    await signInWithMagicLink(desk, deskEmail);
    await desk.waitForURL(/\/accept-invitation/, { timeout: T });
    await desk.getByLabel(/I agree to the current/).check();
    await desk.getByRole("button", { name: /Join .* as/ }).click();
    await desk.waitForURL(/\/desk(?:\?|$)/, { timeout: T });

    // The membership is a RECEPTIONIST row of this studio, and there is no practitioner row.
    const rows = await sql<{ studio_id: string; active: boolean }>(
      `select r.studio_id, r.active from public.studio_receptionists r join auth.users u on u.id = r.user_id where lower(u.email) = $1`, [deskEmail]);
    expect(rows).toEqual([{ studio_id: studio.studioId, active: true }]);
    expect((await sql(`select 1 from public.practitioners p join auth.users u on u.id = p.user_id where lower(u.email) = $1`, [deskEmail])).length).toBe(0);
    // A practitioner page is closed to them.
    await expectPathRefused(desk, "/dashboard");

    // 3. THIS studio's desk: this studio's visit, by the name the desk is allowed to show, and nothing of the other studio or the account name.
    await desk.goto(`/desk?view=month&date=${date}`);
    await expect(desk.getByRole("button", { name: /Ari Rowan/ })).toBeVisible({ timeout: T });
    await expect(desk.getByText("Other Studio Person")).toHaveCount(0);
    await expect(desk.getByText("Ari Account")).toHaveCount(0);
    await expectNoOverflow(desk, profile.name === "iPhone");

    // 4. Book through the desk for a returning client, with the member practitioner.
    await desk.getByRole("button", { name: "Find an opening", exact: true }).first().click();
    const book = desk.getByRole("region", { name: "Desk booking" });
    await book.getByRole("combobox", { name: "Service", exact: true }).selectOption(serviceId);
    await book.getByRole("combobox", { name: "Time of day", exact: true }).selectOption({ label: "Noon onward" });
    await book.getByRole("button", { name: "Search availability" }).click();
    await expect(book.getByRole("heading", { name: "First opening per practitioner" })).toBeVisible({ timeout: T });
    await book.getByRole("button", { name: new RegExp(member.displayName) }).filter({ hasText: /PM/i }).first().click();
    await book.getByRole("textbox", { name: "Find an existing client" }).fill("Vale");
    await book.getByRole("button", { name: "Find client", exact: true }).click();
    await book.getByRole("button", { name: /^Morgan Vale/ }).click();
    await desk.getByRole("button", { name: "Book appointment for Morgan Vale" }).click();
    await expect
      .poll(async () => (await sql(`select 1 from public.appointments where studio_id=$1 and client_id=$2 and created_by_receptionist_id is not null`, [studio.studioId, returningId])).length, { timeout: 30_000 })
      .toBe(1);

    // 5. OWNER removes the receptionist (Team -> Deactivate). The receptionist's page is STILL OPEN.
    await ownerPage.goto("/settings/team");
    await ownerPage.locator("li", { hasText: deskEmail }).getByRole("button", { name: /deactivate/i }).click();
    await ownerPage.getByTestId("confirm-dialog-confirm").click();
    await expect
      .poll(async () => (await sql<{ active: boolean }>(`select r.active from public.studio_receptionists r join auth.users u on u.id = r.user_id where lower(u.email)=$1`, [deskEmail]))[0]?.active, { timeout: 30_000 })
      .toBe(false);

    // 6. The very next request of that open session is refused: following a link on the already-loaded desk lands on /no-access, and the desk is gone.
    await desk.getByRole("link", { name: "Week", exact: true }).first().click();
    await expect(desk).toHaveURL(/\/no-access/, { timeout: T });
    await expectPathRefused(desk, "/desk");

    await ownerCtx.close();
    await deskCtx.close();
  });
}

async function expectNoOverflow(page: Page, check: boolean) {
  if (!check) return;
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "the desk must not scroll sideways on a phone").toBeLessThanOrEqual(0);
}
