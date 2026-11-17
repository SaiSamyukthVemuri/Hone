import { test, expect } from "@playwright/test";
import { seedE2eStudio, seedE2eClient, getOwnerPractitionerId, getE2eServiceId, setStudioTimezone, sql } from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { closeTeam, clientNameOf, rows, setupFiveUserTeam, TZ, type Team } from "./hon48-support/five-user-team";

// HON-48 five-user proof, part 3: ROLE AND TWO-STUDIO DENIAL, by direct request (not by hidden buttons).
//
// Opt-in: HON48_FIVE_USER_E2E=1. The five-user studio (A) and a SECOND studio (B) with its own owner, client and appointment.
//
//   X  every one of the five users requests studio B's appointment page directly: not found, and none of B's data is on
//      their calendar; the same holds the other way round for studio B's owner against an appointment of studio A
//   O  an owner-only page (payments) shows the owner-only notice to each of the four members and not to the owner
//
// Synthetic data only.

test.skip(process.env.HON48_FIVE_USER_E2E !== "1", "opt-in HON-48 five-user proof; set HON48_FIVE_USER_E2E=1");
test.describe.configure({ mode: "serial" });

let t: Team;
let b: Awaited<ReturnType<typeof seedE2eStudio>>;
let bClientName = "";
let bAppointmentId = "";
let aAppointmentId = "";

test.beforeAll(async ({ browser }) => {
  t = await setupFiveUserTeam(browser, 3);
  b = await seedE2eStudio();
  await setStudioTimezone(b.studioId, TZ);
  const { clientId } = await seedE2eClient(b);
  bClientName = await clientNameOf(b, clientId);
  const ownerB = await getOwnerPractitionerId(b.studioId);
  const serviceB = await getE2eServiceId(b.studioId);
  const ins = async (studioId: string, prac: string, client: string, service: string) =>
    (await sql<{ id: string }>(
      "insert into public.appointments (id,studio_id,client_id,practitioner_id,service_id,starts_at,ends_at,duration_minutes,buffer_minutes_snapshot,blocked_ends_at,status) " +
        "select gen_random_uuid(),$1,$2,$3,$4,s,s+interval '60 minutes',60,0,s+interval '60 minutes','confirmed' " +
        "from (select (($5::date + time '11:00') at time zone $6) as s) t returning id",
      [studioId, client, prac, service, t.day, TZ],
    ))[0].id;
  bAppointmentId = await ins(b.studioId, ownerB, clientId, serviceB);
  aAppointmentId = await ins(t.seed.studioId, t.users[0].practitionerId, t.users[0].clientId, t.serviceId);
});
test.afterAll(async () => { await closeTeam(t); });

test("X: each of the five users is refused studio B's appointment and sees none of its data", async () => {
  for (const [i, u] of t.users.entries()) {
    const { page } = t.contexts[i];
    const res = await page.goto(`/calendar/${bAppointmentId}`);
    expect(res?.status(), `${u.key} requesting another studio's appointment`).toBe(404);
    await page.goto(`/calendar?view=day&day=${t.day}`);
    await expect(page.getByRole("main")).not.toContainText(bClientName);
    await page.goto(`/calendar?view=week&day=${t.day}`);
    await expect(page.getByRole("main")).not.toContainText(bClientName);
  }
  // Nothing about studio B moved.
  expect((await rows(b, (await getOwnerPractitionerId(b.studioId)))).length).toBe(1);
});

test("X: studio B's owner is refused studio A's appointment", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginByMagicLink(page, b.ownerEmail);
  const res = await page.goto(`/calendar/${aAppointmentId}`);
  expect(res?.status()).toBe(404);
  await page.goto(`/calendar?view=day&day=${t.day}`);
  await expect(page.getByRole("main")).not.toContainText(t.users[0].clientName);
  await ctx.close();
});

test("O: the owner-only payments page refuses each member and admits the owner", async () => {
  for (const [i, u] of t.users.entries()) {
    const { page } = t.contexts[i];
    await page.goto("/settings/payments");
    const notice = page.getByText("Only the studio owner can manage payments.");
    if (i === 0) await expect(notice, "owner").toHaveCount(0);
    else await expect(notice, `${u.key} (member)`).toBeVisible();
  }
});
