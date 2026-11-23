import { test, expect, devices, type Page } from "@playwright/test";
import { seedE2eClient, sql } from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { setupFiveUserTeam, closeTeam, clientNameOf, TZ, type Team, type User } from "./hon48-support/five-user-team";
import { weekUrl, monthUrl } from "./hon48-support/calendar-urls";

// HON-48 Week and Month, per practitioner, at desktop width and at phone width.
//
// Runs in the required calendar lane. SYNTHETIC data only: one team studio, five practitioners (ana the owner, bo, cy, di, ed),
// a DIFFERENT number of bookings each so a view that shows the wrong person's calendar cannot match by accident.
//
//   ana 1, bo 2, cy 3, di 4, ed 5 bookings on the seeded day (ed's five are back to back: a crowded day), plus
//   cy's own lunch block, and one booking MOVED from bo to cy after it was made (the view must follow the move: bo ends
//   the day with 2 and cy with 3 only because of it).
//
// "Their own bookings" is the calendar filtered to that practitioner (`people=<id>`, the selection a member's own-first default
// resolves to, #1424): the Week total and the Month day cell equal what the database holds for THAT practitioner, and no other
// practitioner's client appears. The own-first default itself is proved by calendar-own-first.spec.ts (opt-in).
//
// Phone width is Chromium EMULATION of an iPhone 13 (touch, coarse pointer, 390 px). It is NOT WebKit and NOT a physical device;
// the real-device recheck stays a human step.

test.describe.configure({ mode: "serial" });

const { defaultBrowserType: _d, ...IPHONE } = devices["iPhone 13"];
void _d;

const COUNTS: Record<string, number> = { ana: 1, bo: 2, cy: 3, di: 4, ed: 5 };

let t: Team;
let everyone: string[];
const clientsOf: Record<string, string[]> = {}; // user key -> the client names booked with them, after the move
let lunchNote = "";

async function book(u: User, local: string, serviceId: string): Promise<{ id: string; name: string }> {
  const { clientId } = await seedE2eClient(t.seed);
  const [row] = await sql<{ id: string }>(
    "insert into public.appointments (id,studio_id,client_id,practitioner_id,service_id,starts_at,ends_at,duration_minutes,buffer_minutes_snapshot,blocked_ends_at,status) " +
      "select gen_random_uuid(),$1,$2,$3,$4,s,s+interval '15 minutes',15,0,s+interval '15 minutes','confirmed' " +
      "from (select (($5::date + $6::time) at time zone $7) as s) t returning id",
    [t.seed.studioId, clientId, u.practitionerId, serviceId, t.day, local, TZ],
  );
  return { id: row.id, name: await clientNameOf(t.seed, clientId) };
}

test.beforeAll(async ({ browser }) => {
  t = await setupFiveUserTeam(browser);
  everyone = t.users.map((u) => u.practitionerId);
  // Slots are spread so only ed's cluster is back to back.
  const SLOTS: Record<string, string[]> = {
    ana: ["09:00"],
    bo: ["09:00", "11:00"],
    cy: ["09:00", "10:00"], // the third (moved from bo) is added below
    di: ["09:00", "10:00", "11:00", "12:00"],
    ed: ["10:00", "10:15", "10:30", "10:45", "11:00"],
  };
  const byKey = Object.fromEntries(t.users.map((u) => [u.key, u]));
  for (const key of Object.keys(SLOTS)) {
    clientsOf[key] = [];
    for (const local of SLOTS[key]) clientsOf[key].push((await book(byKey[key], local, t.serviceId)).name);
  }
  // A booking made with bo, then MOVED to cy: the views must show it under cy only.
  const moved = await book(byKey.bo, "14:00", t.serviceId);
  await sql("update public.appointments set practitioner_id=$3 where studio_id=$1 and id=$2", [t.seed.studioId, moved.id, byKey.cy.practitionerId]);
  clientsOf.cy.push(moved.name);
  // cy's own lunch block.
  lunchNote = `wm-lunch-${t.seed.runId}`;
  await sql(
    "insert into public.studio_timed_blocks (studio_id,practitioner_id,created_by,starts_at,ends_at,category,private_note) " +
      "select $1,$2,$2,s,s+interval '1 hour','lunch',$3 from (select ($4::date + time '13:00') at time zone $5 as s) t",
    [t.seed.studioId, byKey.cy.practitionerId, lunchNote, t.day, TZ],
  );
});

test.afterAll(async () => {
  await closeTeam(t);
});

async function dbWeekAndDay(u: User): Promise<{ week: number; day: number }> {
  const [r] = await sql<{ week: number; day: number }>(
    "select " +
      "(select count(*)::int from public.appointments where studio_id=$1 and practitioner_id=$4 and status='confirmed' " +
      "  and (starts_at at time zone $2)::date between ($3::date - extract(dow from $3::date)::int) and ($3::date - extract(dow from $3::date)::int + 6)) as week, " +
      "(select count(*)::int from public.appointments where studio_id=$1 and practitioner_id=$4 and status='confirmed' and (starts_at at time zone $2)::date = $3::date) as day",
    [t.seed.studioId, TZ, t.day, u.practitionerId],
  );
  return r;
}

async function monthCellTotal(page: Page, day: string): Promise<number> {
  const cell = page.locator(`a[href*="day=${day}"]`).first();
  await expect(cell).toBeVisible({ timeout: 20_000 });
  const chips = await cell.locator("span[title]").count();
  const more = (await cell.innerText()).match(/\+(\d+)\s+more/i);
  return chips + Number(more?.[1] ?? 0);
}

test("the seeded database holds what the spec claims (the control the views are judged against)", async () => {
  for (const u of t.users) {
    const db = await dbWeekAndDay(u);
    expect(db.day, `${u.key} day count in the database`).toBe(COUNTS[u.key]);
    expect(db.week, `${u.key} week count in the database`).toBeGreaterThanOrEqual(COUNTS[u.key]);
  }
});

for (const key of Object.keys(COUNTS)) {
  test(`${key}: Week and Month, filtered to their own calendar, show exactly their bookings (desktop)`, async () => {
    const u = t.users.find((x) => x.key === key)!;
    const page = t.contexts[t.users.indexOf(u)].page;
    const db = await dbWeekAndDay(u);

    await page.goto(weekUrl(t.day, [u.practitionerId]));
    const main = page.getByRole("main");
    await expect(main).toContainText(/appointments?/i, { timeout: 20_000 });
    const weekText = await main.innerText();
    expect(Number(/(\d+)\s+appointments?/i.exec(weekText)?.[1] ?? NaN), `${key}: the Week total is their own`).toBe(db.week);
    for (const mine of clientsOf[key]) expect(weekText, `${key}: Week names their client ${mine}`).toContain(mine);
    for (const other of Object.keys(COUNTS).filter((k) => k !== key)) {
      for (const theirs of clientsOf[other]) expect(weekText, `${key}: Week must not show ${other}'s client`).not.toContain(theirs);
    }
    // A block belongs to the person it was made for.
    if (key === "cy") await expect(main).toContainText(/lunch/i);
    else await expect(main).not.toContainText(/lunch/i);

    await page.goto(monthUrl(t.day, [u.practitionerId]));
    expect(await monthCellTotal(page, t.day), `${key}: the Month day cell accounts for every one of their bookings that day`).toBe(db.day);
  });
}

test("the crowded day (ed, five back to back) is readable in Month: three chips and an honest +2 more", async () => {
  const ed = t.users.find((u) => u.key === "ed")!;
  const page = t.contexts[t.users.indexOf(ed)].page;
  await page.goto(monthUrl(t.day, [ed.practitionerId]));
  const cell = page.locator(`a[href*="day=${t.day}"]`).first();
  await expect(cell).toBeVisible({ timeout: 20_000 });
  expect(await cell.locator("span[title]").count()).toBe(3);
  await expect(cell).toContainText("+2 more");
});

test("everyone selected: the Week and Month totals are the sum of the five", async () => {
  const owner = t.contexts[0].page;
  const sum = Object.values(COUNTS).reduce((a, b) => a + b, 0);
  await owner.goto(monthUrl(t.day, everyone));
  expect(await monthCellTotal(owner, t.day)).toBe(sum);
});

// ---------------------------------------------------------------------------------------------------------------------
// PHONE (iPhone 13, 390 x 844, touch). The owner on a phone; Week is the single-day mobile view, Month is the grid.

async function phone(browser: import("@playwright/test").Browser): Promise<Page> {
  const ctx = await browser.newContext({ ...IPHONE });
  const page = await ctx.newPage();
  await loginByMagicLink(page, t.seed.ownerEmail);
  return page;
}

async function noSideScroll(page: Page, what: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, `${what}: the page must not scroll sideways at phone width`).toBeLessThanOrEqual(1);
}

test("phone: Month for one practitioner shows their own day total and fits the screen", async ({ browser }) => {
  const page = await phone(browser);
  for (const key of ["bo", "ed"]) {
    const u = t.users.find((x) => x.key === key)!;
    await page.goto(monthUrl(t.day, [u.practitionerId]));
    expect(await monthCellTotal(page, t.day), `${key}: phone Month day cell`).toBe(COUNTS[key]);
    await noSideScroll(page, `${key} Month`);
    const box = (await page.locator(`a[href*="day=${t.day}"]`).first().boundingBox())!;
    expect(box.width, "the day cell is a usable tap target").toBeGreaterThanOrEqual(43.5);
    expect(box.height, "the day cell is a usable tap target").toBeGreaterThanOrEqual(43.5);
  }
  await page.context().close();
});

test("phone: Week for one practitioner opens on the day and names their own clients, not anyone else's", async ({ browser }) => {
  const page = await phone(browser);
  for (const key of ["bo", "ed"]) {
    const u = t.users.find((x) => x.key === key)!;
    await page.goto(weekUrl(t.day, [u.practitionerId]));
    const main = page.getByRole("main");
    await expect(main).toBeVisible();
    await noSideScroll(page, `${key} Week`);
    const text = await main.innerText();
    for (const mine of clientsOf[key]) expect(text, `${key}: phone Week reaches their client ${mine}`).toContain(mine);
    for (const other of Object.keys(COUNTS).filter((k) => k !== key)) {
      for (const theirs of clientsOf[other]) expect(text, `${key}: phone Week must not show ${other}'s client`).not.toContain(theirs);
    }
  }
  await page.context().close();
});
