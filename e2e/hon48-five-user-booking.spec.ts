import { test, expect } from "@playwright/test";
import { getE2eServiceId, seedE2eClient, sql } from "./helpers/seed";
import { dayUrl, monthUrl, weekUrl } from "./hon48-support/calendar-urls";
import {
  closeTeam, clientNameOf, openDrawerForColumn, prepareBooking, reservationCount, rows, setupFiveUserTeam,
  DRAWER, type Team,
} from "./hon48-support/five-user-team";

// HON-48 five-user proof, part 1: FIVE INDEPENDENT SESSIONS BOOKING AT ONCE.
//
// Opt-in (a multi-session browser run, so no lane carries it by default): HON48_FIVE_USER_E2E=1.
//
//   1  five users each book a client in their OWN column at the same moment:
//      five winners, one appointment row per practitioner, one reservation each
//   2  the owner and a member contend for the SAME practitioner and the SAME slot at the same moment:
//      exactly one appointment row, exactly one winner, and the loser sees the booking refused (the drawer stays open)
//   3  the Day view shows every committed row in its own practitioner's column, to every one of the five users
//
// Evidence is the DATABASE rows, not only the toast. Synthetic names and addresses only.

test.skip(process.env.HON48_FIVE_USER_E2E !== "1", "opt-in HON-48 five-user proof; set HON48_FIVE_USER_E2E=1");
test.describe.configure({ mode: "serial" });

let t: Team;
test.beforeAll(async ({ browser }) => { t = await setupFiveUserTeam(browser); });
test.afterAll(async () => { await closeTeam(t); });

test("five users book their own column at the same moment: five winners, one row each", async () => {
  const before = await Promise.all(t.users.map((u) => rows(t.seed, u.practitionerId)));
  const submits = await Promise.all(
    t.users.map(async (u, i) => {
      const { page } = t.contexts[i];
      await openDrawerForColumn(page, t.day, u);
      return prepareBooking(page, u.clientName, t.serviceId, u);
    }),
  );
  await Promise.all(submits.map((s) => s.click()));
  await Promise.all(t.contexts.map(({ page }) => expect(DRAWER(page)).toBeHidden({ timeout: 30_000 })));
  for (const [i, u] of t.users.entries()) {
    const mine = await rows(t.seed, u.practitionerId, u.clientId);
    expect(mine, `${u.key} has exactly one booking for their client`).toHaveLength(1);
    expect((await rows(t.seed, u.practitionerId)).length).toBe(before[i].length + 1);
    expect(await reservationCount(mine[0].id), `${u.key}: one reservation, no orphan or duplicate`).toBe(1);
  }
});

test("owner and a member contend for the same practitioner and slot: one winner, one row", async () => {
  const bo = t.users[1];
  const { clientId: c1 } = await seedE2eClient(t.seed);
  const { clientId: c2 } = await seedE2eClient(t.seed);
  const n1 = await clientNameOf(t.seed, c1);
  const n2 = await clientNameOf(t.seed, c2);
  const before = (await rows(t.seed, bo.practitionerId)).length;
  await openDrawerForColumn(t.contexts[1].page, t.day, bo);
  await openDrawerForColumn(t.contexts[0].page, t.day, bo);
  const sBo = await prepareBooking(t.contexts[1].page, n1, t.serviceId, bo);
  const sOwner = await prepareBooking(t.contexts[0].page, n2, t.serviceId, bo);
  await Promise.all([sBo.click(), sOwner.click()]);
  await expect.poll(async () => (await rows(t.seed, bo.practitionerId)).length, { timeout: 20_000 }).toBe(before + 1);
  await t.contexts[0].page.waitForTimeout(3_000);
  const after = await rows(t.seed, bo.practitionerId);
  expect(after.length).toBe(before + 1);
  const winners = [c1, c2].filter((c) => after.some((r) => r.client_id === c));
  expect(winners, "exactly one of the two contenders holds the slot").toHaveLength(1);
  const loserPage = winners[0] === c1 ? t.contexts[0].page : t.contexts[1].page;
  await expect(DRAWER(loserPage)).toBeVisible();
});

test("the Day view shows every committed booking in its own practitioner's column, to all five users", async () => {
  const booked = await sql<{ name: string; practitioner_id: string }>(
    "select c.name, a.practitioner_id from public.appointments a join public.clients c on c.id=a.client_id " +
      "where a.studio_id=$1 and a.status='confirmed'",
    [t.seed.studioId],
  );
  expect(booked.length).toBeGreaterThanOrEqual(6);
  // Every active practitioner of the studio: the sidebar restores a member's own-calendar-only selection on a link without `people`.
  const everyone = (
    await sql<{ id: string }>("select id from public.practitioners where studio_id=$1 and active order by id", [t.seed.studioId])
  ).map((r) => r.id);
  expect(everyone, "the five seeded practitioners are all listed").toEqual(expect.arrayContaining(t.users.map((u) => u.practitionerId)));
  for (const [i, u] of t.users.entries()) {
    const { page } = t.contexts[i];
    await page.goto(dayUrl(t.day, everyone));
    for (const b of booked) {
      const col = page.locator(`[data-testid="team-day-column"][data-practitioner-id="${b.practitioner_id}"]`);
      await expect(col.getByRole("button").filter({ hasText: b.name }), `${u.key} Day: ${b.name}`).toHaveCount(1, { timeout: 20_000 });
    }
  }
  void getE2eServiceId;
});

test("Week and Month show the committed bookings: the week total and the month day cell match the database", async () => {
  const owner = t.contexts[0].page;
  const everyone = (
    await sql<{ id: string }>("select id from public.practitioners where studio_id=$1 and active order by id", [t.seed.studioId])
  ).map((r) => r.id);
  const [expected] = await sql<{ week: number; day: number }>(
    "select " +
      "(select count(*)::int from public.appointments where studio_id=$1 and status='confirmed' " +
      "  and (starts_at at time zone $2)::date between ($3::date - extract(dow from $3::date)::int) and ($3::date - extract(dow from $3::date)::int + 6)) as week, " +
      "(select count(*)::int from public.appointments where studio_id=$1 and status='confirmed' and (starts_at at time zone $2)::date = $3::date) as day",
    [t.seed.studioId, "America/Los_Angeles", t.day],
  );
  expect(expected.day).toBeGreaterThanOrEqual(6);

  // WEEK: the owner's week reports every committed appointment of the week (all five calendars selected).
  await owner.goto(weekUrl(t.day, everyone));
  await expect(owner.getByRole("main")).toContainText(/all selected/i, { timeout: 20_000 });
  const weekText = await owner.getByRole("main").innerText();
  const weekCount = Number(/(\d+)\s+appointments?/i.exec(weekText)?.[1] ?? NaN);
  expect(weekCount, "the Week view's appointment total equals the database").toBe(expected.week);

  // MONTH: the day's cell shows its chips plus "+N more", together equal to the database count for that day.
  await owner.goto(monthUrl(t.day, everyone));
  const cell = owner.locator(`a[href*="day=${t.day}"]`).first();
  await expect(cell).toBeVisible({ timeout: 20_000 });
  const chips = await cell.locator("span[title]").count();
  const moreText = (await cell.innerText()).match(/\+(\d+)\s+more/i);
  expect(chips + Number(moreText?.[1] ?? 0), "the Month cell accounts for every appointment of the day").toBe(expected.day);
});
