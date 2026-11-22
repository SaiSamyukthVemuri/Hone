import { test, expect, type Page } from "@playwright/test";
import {
  getE2eServiceId, getOwnerPractitionerId, seedE2eClient, seedE2eMember, seedE2eStudio, seedPractitionerDefault, seedServiceEligibility,
  setStudioCapacityBookingEnabled, setStudioCapacityEnabled, setStudioTimezone, sql, type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// FIVE-PRACTITIONER CALENDAR ACCEPTANCE.
//
// One studio, five ACTIVE practitioners, on the Day and Week views, on a desktop and a phone viewport:
//   - no overlap and no misattribution: every appointment is drawn for its own practitioner and for nobody else, three of them at the very same
//     instant in three different columns, a fourth person's half hour next to them;
//   - the right people are shown: the one who does not work that day has no Day column but is still listed in the sidebar, and their own Week view is empty;
//   - per-practitioner availability: the person with short hours is offered only slots inside their hours, a full-day person is offered more.
// Evidence is the database for who owns what, and the page for what is drawn where. Synthetic data and harness addresses only.

const TZ = "America/Los_Angeles";
const GRID_START_HOUR = 6; // calendar-constants HOUR_START; 1px = 1 minute
const SLOT = /^\d{1,2}:\d{2}\s?(AM|PM)$/i;

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false },
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
} as const;

type Person = { key: string; id: string; name: string; clientId: string; clientName: string; at: string | null; works: boolean; hours: [string, string] };
type Studio = { seed: E2eSeed; day: string; serviceId: string; people: Person[] };
let studio: Promise<Studio> | null = null;

async function insertAppointment(s: { seed: E2eSeed; serviceId: string }, p: Person, date: string, local: string) {
  await sql(
    "insert into public.appointments (id,studio_id,client_id,practitioner_id,service_id,starts_at,ends_at,duration_minutes,buffer_minutes_snapshot,blocked_ends_at,status) " +
      "select gen_random_uuid(),$1,$2,$3,$4,start_at,start_at+interval '30 minutes',30,0,start_at+interval '30 minutes','confirmed' " +
      "from (select ($5::date + $6::time) at time zone $7 as start_at) t",
    [s.seed.studioId, p.clientId, p.id, s.serviceId, date, local, TZ],
  );
}

function getStudio(): Promise<Studio> {
  studio ??= (async () => {
    const seed = await seedE2eStudio();
    await setStudioTimezone(seed.studioId, TZ);
    await setStudioCapacityEnabled(seed.studioId, true);
    await setStudioCapacityBookingEnabled(seed.studioId, true);
    const [d] = await sql<{ day: string; dow: number }>(
      "select ((now() at time zone $1)::date+7)::text as day, extract(dow from ((now() at time zone $1)::date+7))::int as dow", [TZ]);
    const serviceId = await getE2eServiceId(seed.studioId);
    const ownerId = await getOwnerPractitionerId(seed.studioId);
    const ids = [ownerId];
    for (let i = 0; i < 4; i++) ids.push((await seedE2eMember(seed)).practitionerId);
    // 1,2,4 are booked at the same instant; 3 has SHORT hours and a half hour beside them; 5 does not work that day.
    const plan: Array<Pick<Person, "key" | "at" | "works" | "hours">> = [
      { key: "one", at: "10:00", works: true, hours: ["08:00", "20:00"] },
      { key: "two", at: "10:00", works: true, hours: ["08:00", "20:00"] },
      { key: "three", at: "10:30", works: true, hours: ["10:00", "12:00"] },
      { key: "four", at: "10:00", works: true, hours: ["08:00", "20:00"] },
      { key: "five", at: null, works: false, hours: ["08:00", "20:00"] },
    ];
    const colors = ["teal", "amber", "violet", "sky", "rose"];
    const people: Person[] = [];
    for (const [i, p] of plan.entries()) {
      const id = ids[i]!;
      const name = `Synthetic Five ${seed.runId}-${p.key}`;
      await sql("update public.practitioners set display_name=$3, color=$4 where studio_id=$1 and id=$2", [seed.studioId, id, name, colors[i]]);
      await seedPractitionerDefault(seed.studioId, id, d.dow, p.works, p.hours[0], p.hours[1]);
      await seedServiceEligibility(seed.studioId, serviceId, id);
      const { clientId } = await seedE2eClient(seed);
      const clientName = (await sql<{ name: string }>("select name from public.clients where studio_id=$1 and id=$2", [seed.studioId, clientId]))[0]!.name;
      people.push({ ...p, id, name, clientId, clientName });
    }
    const s = { seed, serviceId };
    for (const p of people) if (p.at) await insertAppointment(s, p, d.day, p.at);
    return { seed, day: d.day, serviceId, people };
  })();
  return studio;
}

const column = (page: Page, id: string) => page.locator(`[data-testid="team-day-column"][data-practitioner-id="${id}"]`);
// A card is a button on the desktop grids and a link on the phone timeline.
const cardsFor = (loc: ReturnType<Page["locator"]>, clientName: string) => loc.locator("a, button").filter({ hasText: clientName }).filter({ hasNotText: /Open quick-book/ });
const offset = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h! - GRID_START_HOUR) * 60 + m!; };

for (const [label, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`five practitioners (${label})`, () => {
    test.use(vp);

    test("Day view: each appointment is in its own practitioner's column only, at its own time, and nothing overlaps", async ({ page }) => {
      test.setTimeout(180_000);
      const s = await getStudio();
      await loginAsOwner(page, s.seed);
      await page.goto(`/calendar?view=day&day=${s.day}`);
      await expect(page.getByTestId("team-day-view")).toBeVisible({ timeout: 60_000 });
      const working = s.people.filter((p) => p.works);
      await expect(page.getByTestId("team-day-column-header")).toHaveCount(working.length);
      // the person who does not work that day has no column
      await expect(column(page, s.people[4]!.id)).toHaveCount(0);
      for (const p of working) {
        await expect(column(page, p.id)).toHaveCount(1);
        const mine = cardsFor(column(page, p.id), p.clientName);
        await mine.first().scrollIntoViewIfNeeded();
        await expect(mine, `${p.key}'s appointment is drawn in ${p.key}'s column`).toHaveCount(1);
        for (const other of working.filter((o) => o.id !== p.id)) {
          await expect(cardsFor(column(page, other.id), p.clientName), `and not in ${other.key}'s column`).toHaveCount(0);
        }
        const cardBox = (await mine.boundingBox())!;
        const colBox = (await column(page, p.id).boundingBox())!;
        expect(Math.abs(cardBox.y - colBox.y - offset(p.at!)), `${p.key}'s card sits at ${p.at} on the grid (1px = 1 minute)`).toBeLessThanOrEqual(1);
        // no overlap inside the column: this person's cards never intersect each other
        const all = column(page, p.id).getByRole("button").filter({ hasText: /\d{1,2}:\d{2}/ }).filter({ hasNotText: /Open quick-book/ });
        const n = await all.count();
        const boxes: Array<{ y: number; h: number }> = [];
        for (let i = 0; i < n; i++) { const b = await all.nth(i).boundingBox(); if (b) boxes.push({ y: b.y, h: b.height }); }
        boxes.sort((a, b) => a.y - b.y);
        for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.y, "no two cards in one column overlap").toBeGreaterThanOrEqual(boxes[i - 1]!.y + boxes[i - 1]!.h - 1);
      }
      // the database agrees about who owns what
      for (const p of s.people.filter((x) => x.at)) {
        const owner = await sql<{ practitioner_id: string }>("select practitioner_id from public.appointments where studio_id=$1 and client_id=$2 and status='confirmed'", [s.seed.studioId, p.clientId]);
        expect(owner.map((r) => r.practitioner_id)).toEqual([p.id]);
      }
    });

    test("Week view: choosing one practitioner shows only their appointment on that date, and everyone shows all four", async ({ page }) => {
      test.setTimeout(180_000);
      const s = await getStudio();
      await loginAsOwner(page, s.seed);
      const surface = () => page.locator(`[data-testid="${label === "desktop" ? "week-day-column" : "mobile-day-timeline"}"][data-date="${s.day}"]`);
      for (const p of s.people) {
        await page.goto(`/calendar?view=week&day=${s.day}&people=${p.id}`);
        await expect(surface()).toBeVisible({ timeout: 60_000 });
        for (const q of s.people) {
          const expected = q.id === p.id && q.at ? 1 : 0;
          await expect(cardsFor(surface(), q.clientName), `${p.key} selected: ${q.key}'s appointment ${expected ? "is" : "is not"} on ${s.day}`).toHaveCount(expected);
        }
      }
      await page.goto(`/calendar?view=week&day=${s.day}&people=${s.people.map((x) => x.id).join(",")}`);
      await expect(surface()).toBeVisible({ timeout: 60_000 });
      // Everyone selected: appointments that overlap in time share one date column, so the page offers a chooser ("Choose from N appointments"). Whichever
      // way the page draws them, each one is listed once, with ITS OWN client and ITS OWN practitioner, and nobody else's.
      const chooser = page.getByRole("button", { name: /^Choose from \d+ appointments$/ });
      let scope: ReturnType<Page["locator"]> = surface();
      if (await chooser.count()) {
        await chooser.first().click();
        scope = page.getByRole("dialog", { name: /Choose an appointment/ });
        await expect(scope).toBeVisible({ timeout: 15_000 });
      }
      for (const p of s.people.filter((x) => x.at)) {
        const row = cardsFor(scope, p.clientName);
        await expect(row, `everyone selected: ${p.key} is listed once`).toHaveCount(1, { timeout: 15_000 });
        await expect(row, `and under ${p.key}'s own name`).toContainText(p.name);
      }
      expect(await cardsFor(scope, s.people[4]!.clientName).count(), "the practitioner who is off that day has nothing listed").toBe(0);
      // the sidebar lists all five active practitioners, including the one who is off that day
      if (label === "desktop") await expect(page.getByTestId("calendar-sidebar-practitioner")).toHaveCount(5);
    });

    test("availability: the short-hours practitioner is offered only slots inside their hours; a full-day practitioner is offered more", async ({ page }) => {
      test.setTimeout(180_000);
      const s = await getStudio();
      await loginAsOwner(page, s.seed);
      const offered = async (p: Person) => {
        await page.goto(`/calendar?view=day&day=${s.day}`);
        await expect(page.getByTestId("team-day-view")).toBeVisible({ timeout: 60_000 });
        const col = column(page, p.id);
        await col.scrollIntoViewIfNeeded();
        const box = (await col.boundingBox())!;
        await col.getByRole("button", { name: `Open quick-book draft for ${p.name} on ${s.day}` }).click({ position: { x: box.width / 2, y: offset("12:05") } });
        const drawer = page.getByRole("dialog", { name: "New appointment" });
        await expect(drawer).toBeVisible({ timeout: 20_000 });
        const { clientName } = s.people.find((x) => x.key === "five")!;
        await drawer.getByPlaceholder("Find existing client").fill(clientName);
        await drawer.getByRole("button", { name: new RegExp(clientName) }).first().click();
        await drawer.getByRole("combobox").first().selectOption(s.serviceId);
        const selector = drawer.getByLabel("Practitioner");
        if (await selector.count()) await selector.selectOption(p.id);
        const slots = drawer.getByRole("button", { name: SLOT });
        await expect(slots.first()).toBeVisible({ timeout: 20_000 });
        return (await slots.allTextContents()).map((t) => t.trim());
      };
      const to24 = (t: string) => { const m = /^(\d{1,2}):(\d{2})\s?(AM|PM)$/i.exec(t)!; let h = Number(m[1]) % 12; if (m[3]!.toUpperCase() === "PM") h += 12; return h * 60 + Number(m[2]); };
      const short = await offered(s.people[2]!);
      expect(short.length).toBeGreaterThan(0);
      for (const t of short) { const mins = to24(t); expect(mins, `${t} is inside 10:00-12:00`).toBeGreaterThanOrEqual(10 * 60); expect(mins).toBeLessThan(12 * 60); }
      const full = await offered(s.people[0]!);
      expect(full.length).toBeGreaterThan(short.length);
      expect(full.some((t) => to24(t) >= 12 * 60), "a full-day practitioner is offered the afternoon").toBe(true);
    });
  });
}
