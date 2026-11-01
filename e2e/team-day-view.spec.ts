import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eMember,
  seedE2eClient,
  setStudioCapacityEnabled,
  setStudioCapacityBookingEnabled,
  seedPractitionerDefault,
  seedServiceEligibility,
  getE2eServiceId,
  getOwnerPractitionerId,
  getSourceReservationKeys,
  setStudioTimezone,
  sql,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// HON-48 team day view: one column per working practitioner, each under a
// header bar in that practitioner's colour, with their own appointments and
// their own off-hours, breaks and blocks greyed in their own column.
//
// Five SYNTHETIC practitioners in America/Los_Angeles on a fresh local studio.
// Synthetic names only; no real reference layout, client or invitation.
//
// What this proves, per column, against the rendered page AND the rows:
//   * five simultaneous appointments, one per practitioner, each in its own
//     column at the same height;
//   * each practitioner's individual hours, scoped lunch block and scoped
//     sterilization break greyed in that column only;
//   * a late-evening appointment whose UTC instant is on the NEXT date stays on
//     its Los Angeles date, at its local time, and is absent from the next day;
//   * a conflicting booking for the same practitioner is refused by the
//     database while the other four practitioners hold the same time;
//   * a click in a column drafts a booking for that column's practitioner; a
//     member sees the same columns and may create only in their own.

test.describe.configure({ mode: "serial" });

const TZ = "America/Los_Angeles";
const GRID_START_HOUR = 6; // calendar-constants HOUR_START; 1px = 1 minute.

type Practitioner = {
  key: "ana" | "bo" | "cy" | "di" | "ed";
  id: string;
  name: string;
  color: string;
  open: string;
  close: string;
  email?: string;
};

let seed: E2eSeed;
let day: string;
let nextDay: string;
let roster: Practitioner[];
const booking = new Map<string, { id: string; clientName: string }>();
let late: { id: string; clientName: string };

const byKey = (key: Practitioner["key"]) => roster.find((p) => p.key === key)!;

async function insertAppointment(practitionerId: string, clientId: string, serviceId: string, date: string, local: string) {
  const [row] = await sql<{ id: string }>(
    "insert into public.appointments " +
    "(id,studio_id,client_id,practitioner_id,service_id,starts_at,ends_at,duration_minutes,buffer_minutes_snapshot,blocked_ends_at,status) " +
    "select gen_random_uuid(),$1,$2,$3,$4,start_at,start_at+interval '30 minutes',30,0,start_at+interval '30 minutes','confirmed' " +
    "from (select ($5::date + $6::time) at time zone $7 as start_at) t returning id",
    [seed.studioId, clientId, practitionerId, serviceId, date, local, TZ],
  );
  return row.id;
}

async function clientName(clientId: string): Promise<string> {
  const [row] = await sql<{ name: string }>("select name from public.clients where studio_id=$1 and id=$2", [seed.studioId, clientId]);
  return row.name;
}

function column(page: Page, practitionerId: string): Locator {
  return page.locator(`[data-testid="team-day-column"][data-practitioner-id="${practitionerId}"]`);
}
function header(page: Page, practitionerId: string): Locator {
  return page.locator(`[data-testid="team-day-column-header"][data-practitioner-id="${practitionerId}"]`);
}
function card(scope: Locator, name: string): Locator {
  return scope.getByRole("button").filter({ hasText: name });
}
async function tints(scope: Locator): Promise<string[]> {
  return scope.locator("[data-availability-tint]").evaluateAll((els) =>
    els.map((el) => `${(el as HTMLElement).style.top}+${(el as HTMLElement).style.height}`),
  );
}
// Grid offset of the start of a local "HH:MM", in px (= minutes).
const offset = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h - GRID_START_HOUR) * 60 + m;
};

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  await setStudioTimezone(seed.studioId, TZ);
  await setStudioCapacityEnabled(seed.studioId, true);
  await setStudioCapacityBookingEnabled(seed.studioId, true);
  // A week ahead, so every appointment is upcoming and the break rule
  // materializes; the date is derived from the clock, never hard-coded.
  const [d] = await sql<{ day: string; next: string; dow: number }>(
    "select ((now() at time zone $1)::date+7)::text as day, ((now() at time zone $1)::date+8)::text as next, " +
    "extract(dow from ((now() at time zone $1)::date+7))::int as dow",
    [TZ],
  );
  day = d.day;
  nextDay = d.next;

  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const members = [];
  for (let i = 0; i < 4; i++) members.push(await seedE2eMember(seed));
  roster = [
    { key: "ana", id: ownerId, name: `Synthetic Ana ${seed.runId}`, color: "teal", open: "09:00", close: "17:00" },
    { key: "bo", id: members[0].practitionerId, email: members[0].email, name: `Synthetic Bo ${seed.runId}`, color: "amber", open: "12:00", close: "22:00" },
    { key: "cy", id: members[1].practitionerId, email: members[1].email, name: `Synthetic Cy ${seed.runId}`, color: "violet", open: "07:00", close: "13:00" },
    { key: "di", id: members[2].practitionerId, email: members[2].email, name: `Synthetic Di ${seed.runId}`, color: "sky", open: "10:00", close: "18:00" },
    { key: "ed", id: members[3].practitionerId, email: members[3].email, name: `Synthetic Ed ${seed.runId}`, color: "rose", open: "09:00", close: "17:00" },
  ];
  const serviceId = await getE2eServiceId(seed.studioId);
  for (const p of roster) {
    await sql("update public.practitioners set display_name=$3, color=$4 where studio_id=$1 and id=$2", [seed.studioId, p.id, p.name, p.color]);
    await seedPractitionerDefault(seed.studioId, p.id, d.dow, true, p.open, p.close);
    await seedServiceEligibility(seed.studioId, serviceId, p.id);
    // Five simultaneous 12:00 appointments, one per practitioner.
    const { clientId } = await seedE2eClient(seed);
    booking.set(p.id, { id: await insertAppointment(p.id, clientId, serviceId, day, "12:00"), clientName: await clientName(clientId) });
  }
  // Bo's late-evening appointment: 21:00 Los Angeles is the next UTC date.
  const { clientId: lateClient } = await seedE2eClient(seed);
  late = { id: await insertAppointment(byKey("bo").id, lateClient, serviceId, day, "21:00"), clientName: await clientName(lateClient) };
  // Di's own lunch block and Ed's own sterilization break.
  await sql(
    "insert into public.studio_timed_blocks (studio_id,practitioner_id,created_by,starts_at,ends_at,category,private_note) " +
    "select $1,$2,$2,s,s+interval '1 hour','lunch',$3 from (select ($4::date + time '13:00') at time zone $5 as s) t",
    [seed.studioId, byKey("di").id, `team-day-lunch-${seed.runId}`, day, TZ],
  );
  await sql(
    "select public.create_recurring_break_rule_and_materialize($1,'Sterilization',$2::int[],'15:00','15:30',true,$3,$4::date,$5)",
    [seed.studioId, `{${d.dow}}`, ownerId, nextDay, byKey("ed").id],
  );
  // BLOCK-SCOPE F3: a studio-wide block (practitioner_id NULL), the row today's
  // calendar drag-to-block writes. It closes 16:00-16:30 for every practitioner.
  await sql(
    "insert into public.studio_timed_blocks (studio_id,practitioner_id,created_by,starts_at,ends_at,category,private_note) " +
    "select $1,null,$2,s,s+interval '30 minutes','other',null from (select ($3::date + time '16:00') at time zone $4 as s) t",
    [seed.studioId, ownerId, day, TZ],
  );
});

test("the rows the view must show: five simultaneous, one late across UTC midnight, scoped block and break", async () => {
  const rows = await sql<{ practitioner_id: string; local: string; utc_date: string }>(
    "select practitioner_id, to_char(starts_at at time zone $2, 'YYYY-MM-DD HH24:MI') as local, " +
    "to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD') as utc_date from public.appointments where studio_id=$1 order by starts_at, practitioner_id",
    [seed.studioId, TZ],
  );
  expect(rows).toHaveLength(6);
  expect(rows.filter((r) => r.local === `${day} 12:00`).map((r) => r.practitioner_id).sort()).toEqual(roster.map((p) => p.id).sort());
  const lateRow = rows.find((r) => r.local === `${day} 21:00`)!;
  expect(lateRow.practitioner_id).toBe(byKey("bo").id);
  expect(lateRow.utc_date).toBe(nextDay); // the UTC instant is on the next date
  const [scope] = await sql<{ block: string; brk: string }>(
    "select (select practitioner_id::text from public.studio_timed_blocks where studio_id=$1 and category='lunch') as block, " +
    "(select string_agg(distinct practitioner_id::text, ',') from public.studio_recurring_break_occurrences where studio_id=$1 and occurrence_date=$2::date) as brk",
    [seed.studioId, day],
  );
  expect(scope).toEqual({ block: byKey("di").id, brk: byKey("ed").id });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 1000 } });

  test("five practitioner columns with coloured headers, correct attribution, own off-time, LA times", async ({ page }) => {
    await loginAsOwner(page, seed);
    await page.goto(`/calendar?view=day&day=${day}`);
    await expect(page.getByTestId("team-day-view")).toHaveAttribute("data-date", day);
    await expect(page.getByTestId("calendar-view-day")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("team-day-column")).toHaveCount(5);
    await expect(page.getByTestId("team-day-not-working")).toHaveCount(0);

    // Headers: name printed on a bar in the practitioner's own colour.
    const backgrounds = new Set<string>();
    for (const p of roster) {
      const h = header(page, p.id);
      await expect(h).toContainText(p.name);
      await expect(h).toHaveAttribute("data-color", new RegExp(p.color, "i"));
      backgrounds.add(await h.evaluate((el) => getComputedStyle(el).backgroundColor));
    }
    expect(backgrounds.size).toBe(5);
    await expect(header(page, byKey("bo").id)).toContainText("12:00 PM – 10:00 PM");
    await expect(header(page, byKey("cy").id)).toContainText("7:00 AM – 1:00 PM");

    // Attribution: each client in exactly its practitioner's column, all five
    // simultaneous cards at the same height (12:00 local).
    const tops: number[] = [];
    for (const p of roster) {
      const own = booking.get(p.id)!;
      const col = column(page, p.id);
      await expect(card(col, own.clientName)).toHaveCount(1);
      for (const other of roster.filter((o) => o.id !== p.id)) {
        await expect(card(column(page, other.id), own.clientName)).toHaveCount(0);
      }
      const colBox = (await col.boundingBox())!;
      const cardBox = (await card(col, own.clientName).boundingBox())!;
      tops.push(Math.round(cardBox.y - colBox.y));
      // In-card practitioner tag is dropped: the header names the column.
      await expect(card(col, own.clientName).locator("[data-practitioner-tag]")).toHaveCount(0);
    }
    expect(new Set(tops)).toEqual(new Set([offset("12:00")]));

    // Late evening: 21:00 Los Angeles, in Bo's column at 21:00 on the grid.
    const bo = column(page, byKey("bo").id);
    const lateCard = card(bo, late.clientName);
    await expect(lateCard).toHaveCount(1);
    await expect(lateCard).toContainText("9:00");
    const boBox = (await bo.boundingBox())!;
    expect(Math.round((await lateCard.boundingBox())!.y - boBox.y)).toBe(offset("21:00"));

    // Individual off-time: each column greys its own hours outside open-close.
    for (const p of roster) {
      const before = offset(p.open);
      const after = offset(p.close);
      const expected = [...(before > 0 ? [`0px+${before}px`] : []), `${after}px+${1020 - after}px`];
      expect(await tints(column(page, p.id))).toEqual(expected);
    }
    // Scoped lunch only in Di's column; scoped sterilization only in Ed's.
    for (const p of roster) {
      await expect(column(page, p.id).getByTitle(/^Lunch/)).toHaveCount(p.key === "di" ? 1 : 0);
      await expect(column(page, p.id).getByTitle(/^Sterilization/)).toHaveCount(p.key === "ed" ? 1 : 0);
      // BLOCK-SCOPE F3: scoped blocks say whose they are; the studio-wide
      // block greys EVERY column and says so.
      if (p.key === "di") await expect(column(page, p.id).getByTitle(/^Lunch/)).toHaveAttribute("title", new RegExp(`· Only ${p.name}$`));
      if (p.key === "ed") await expect(column(page, p.id).getByTitle(/^Sterilization/)).toHaveAttribute("title", `Sterilization · Only ${p.name}`);
      await expect(column(page, p.id).getByTitle("Unavailable · All practitioners", { exact: true })).toHaveCount(1);
    }

    await page.screenshot({ path: test.info().outputPath("team-day-desktop.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // The next Los Angeles day does not show the late appointment, even
    // though its UTC instant falls on that date.
    await page.getByTestId("calendar-next").click();
    await expect(page.getByTestId("team-day-view")).toHaveAttribute("data-date", nextDay);
    await expect(page.getByRole("button").filter({ hasText: late.clientName })).toHaveCount(0);
  });

  test("a conflicting booking for the same practitioner is refused; the other columns hold the same time", async ({ page }) => {
    const ana = byKey("ana");
    const serviceId = await getE2eServiceId(seed.studioId);
    const { clientId } = await seedE2eClient(seed);
    const count = async () => Number((await sql<{ n: number }>(
      "select count(*)::int as n from public.appointments where studio_id=$1 and practitioner_id=$2 and status='confirmed'",
      [seed.studioId, ana.id],
    ))[0].n);
    const before = await count();
    // 12:15 overlaps Ana's own 12:00-12:30: the per-practitioner reservation
    // exclusion refuses it (23P01), while Bo..Ed hold 12:00 in the same studio.
    await expect(insertAppointment(ana.id, clientId, serviceId, day, "12:15")).rejects.toMatchObject({ code: "23P01" });
    expect(await count()).toBe(before);
    // Control: the same insert for Ana at a free time is accepted, so the
    // refusal above is the overlap and nothing else.
    const { clientId: controlClient } = await seedE2eClient(seed);
    await insertAppointment(ana.id, controlClient, serviceId, day, "14:00");
    expect(await count()).toBe(before + 1);

    await loginAsOwner(page, seed);
    await page.goto(`/calendar?view=day&day=${day}`);
    await expect(card(column(page, ana.id), await clientName(clientId))).toHaveCount(0);
    for (const p of roster) await expect(card(column(page, p.id), booking.get(p.id)!.clientName)).toHaveCount(1);
  });

  test("a click in a practitioner's column drafts a booking for that practitioner", async ({ page }) => {
    const di = byKey("di");
    await loginAsOwner(page, seed);
    await page.goto(`/calendar?view=day&day=${day}`);
    const col = column(page, di.id);
    const box = (await col.boundingBox())!;
    // 15:00 local in Di's open, empty afternoon.
    await col.scrollIntoViewIfNeeded();
    const target = col.getByRole("button", { name: `Open quick-book draft for ${di.name} on ${day}` });
    await target.click({ position: { x: box.width / 2, y: offset("15:00") + 5 } });
    const drawer = page.getByRole("dialog", { name: "New appointment", exact: true });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("combobox", { name: "Practitioner", exact: true })).toHaveValue(di.id);
  });

  // Members read every appointment in their studio today (0172
  // appointments_member_select = is_studio_member), so the day view shows a
  // member the same five columns the week view already shows them.
  test("a member sees the same columns and may create only in their own column", async ({ page }) => {
    const bo = byKey("bo");
    await loginByMagicLink(page, bo.email!);
    await page.goto(`/calendar?view=day&day=${day}`);
    await expect(page.getByTestId("team-day-column")).toHaveCount(5);
    for (const p of roster) {
      await expect(card(column(page, p.id), booking.get(p.id)!.clientName)).toHaveCount(1);
      await expect(column(page, p.id).getByRole("button", { name: /^Open quick-book draft for / })).toHaveCount(p.id === bo.id ? 1 : 0);
    }
  });
});

// HON-48 (Sam decision 17): Day is the INITIAL view for a team studio. Only an
// entry with no calendar parameter is affected; every explicit link keeps its
// meaning, which is how a user's remembered view survives. Permissions are
// untouched, so a member lands on the same columns as the owner.
test.describe("initial view", () => {
  test.use({ viewport: { width: 1280, height: 1000 } });
  const todayLA = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

  test("a bare /calendar opens the team Day view for the owner and for a member", async ({ page }) => {
    await loginAsOwner(page, seed);
    await page.goto("/calendar");
    await expect(page.getByTestId("team-day-view")).toHaveAttribute("data-date", todayLA());
    await expect(page.getByTestId("calendar-view-day")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("team-day-column")).toHaveCount(5);
  });

  test("a member's bare /calendar shows the same five columns as the owner", async ({ page }) => {
    const bo = byKey("bo");
    await loginByMagicLink(page, bo.email!);
    await page.goto("/calendar");
    await expect(page.getByTestId("team-day-view")).toBeVisible();
    await expect(page.getByTestId("team-day-column")).toHaveCount(5);
  });

  test("explicit links keep their meaning: ?view=week, ?week=, ?day= and ?view=month are not sent to Day", async ({ page }) => {
    await loginAsOwner(page, seed);
    for (const url of ["/calendar?view=week", `/calendar?week=${day}`, `/calendar?day=${day}`, "/calendar?view=month"]) {
      await page.goto(url);
      await expect(page.getByTestId("calendar-view-day"), url).not.toHaveAttribute("aria-current", "page");
      await expect(page.getByTestId("team-day-view"), url).toHaveCount(0);
    }
  });

  test("Day, then Week, then Today stays on the week (Today does not re-enter the default)", async ({ page }) => {
    await loginAsOwner(page, seed);
    await page.goto("/calendar");
    await expect(page.getByTestId("team-day-view")).toBeVisible();
    await page.getByTestId("calendar-view-week").click();
    await expect(page.getByTestId("calendar-view-week")).toHaveAttribute("aria-current", "page");
    await page.getByTestId("calendar-today").click();
    await expect(page.getByTestId("calendar-view-week")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("team-day-view")).toHaveCount(0);
  });

  test("a studio that is not a team calendar still OPENS on the week, and a lone practitioner has a one-column Day view", async ({ page }) => {
    const solo = await seedE2eStudio();
    await loginAsOwner(page, solo);
    await page.goto("/calendar");
    await expect(page.getByTestId("calendar-view-week")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("team-day-view")).toHaveCount(0);
    // The Day tab is offered (capacity off, exactly one active practitioner), not only reachable by URL.
    await expect(page.getByTestId("calendar-view-day")).toHaveCount(1);
    // HON-48: one active practitioner has the Day view, one compact column, capacity off or on.
    await page.goto("/calendar?view=day");
    await expect(page.getByTestId("team-day-view")).toHaveAttribute("data-column-count", "1");
    await setStudioCapacityEnabled(solo.studioId, true);
    await page.goto("/calendar");
    await expect(page.getByTestId("calendar-view-week")).toHaveAttribute("aria-current", "page");
    await page.goto("/calendar?view=day");
    await expect(page.getByTestId("team-day-view")).toHaveAttribute("data-column-count", "1");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("columns scroll inside the day view, never the page; each card still opens", async ({ page }) => {
    await loginAsOwner(page, seed);
    await page.goto(`/calendar?view=day&day=${day}`);
    const view = page.getByTestId("team-day-view");
    await expect(view).toBeVisible();
    await expect(page.getByTestId("team-day-column-header")).toHaveCount(5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await view.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("team-day-phone.png") });

    const ed = byKey("ed");
    await header(page, ed.id).scrollIntoViewIfNeeded();
    await expect(header(page, ed.id)).toBeInViewport();
    const edCard = card(column(page, ed.id), booking.get(ed.id)!.clientName);
    await edCard.scrollIntoViewIfNeeded();
    await edCard.tap();
    const preview = page.getByRole("dialog", { name: /appointment preview/i });
    await expect(preview.getByRole("heading", { name: booking.get(ed.id)!.clientName, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

// HON-48 F1 (held for Sam's rule): who a NEW calendar quick block applies to
// under practitioner capacity. The owner states it ("All practitioners" or
// "Only <name>"); a member's block closes only their own time. Times avoid
// every seeded row: Di 17:00-17:30 (Di works to 18:00), Bo 18:00-18:30.
//
// The MEMBER case needs the member insert policy widened to allow
// practitioner_id = self (unnumbered artifact
// machines/HON48-F1-member-scoped-block-insert-policy.UNNUMBERED.sql). Without
// it the database refuses the row and the drawer shows "This block could not
// be saved for you only. Ask the studio owner to add it." It ships together
// with that migration or not at all.
test.describe("F1: quick block scope", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  const blockDrawer = (page: Page) => page.getByRole("dialog", { name: "Block time" });
  const blockAt = async (local: string) =>
    sql<{ id: string; practitioner_id: string | null }>(
      "select id, practitioner_id from public.studio_timed_blocks where studio_id=$1 and starts_at = ($2::date + $3::time) at time zone $4",
      [seed.studioId, day, local, TZ],
    );
  async function openBlockDrawer(page: Page) {
    await page.goto(`/calendar?day=${day}`);
    await page.getByRole("button", { name: "Add appointment or block time" }).tap();
    await page.getByRole("dialog", { name: "Choose action for selected time" }).getByRole("button", { name: "Block time" }).tap();
    const drawer = blockDrawer(page);
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(day, { exact: true })).toBeVisible();
    return drawer;
  }

  test("the owner must choose; Only Di closes Di's time alone", async ({ page }) => {
    const di = byKey("di");
    await loginAsOwner(page, seed);
    const drawer = await openBlockDrawer(page);
    await drawer.getByLabel("Start", { exact: true }).fill("17:00");
    await drawer.getByLabel("End", { exact: true }).fill("17:30");
    const appliesTo = drawer.getByLabel("Applies to");
    await expect(appliesTo).toHaveValue("");
    await expect(appliesTo.locator("option")).toHaveText(["Choose who this blocks", "All practitioners", ...roster.map((p) => `Only ${p.name}`)]);

    await drawer.getByRole("button", { name: "Save block" }).tap();
    await expect(drawer.getByRole("alert")).toHaveText("Choose who this block applies to.");
    expect(await blockAt("17:00")).toHaveLength(0);

    await appliesTo.selectOption({ label: `Only ${di.name}` });
    await drawer.getByRole("button", { name: "Save block" }).tap();
    await expect(drawer).toHaveCount(0);
    await expect.poll(async () => (await blockAt("17:00")).map((r) => r.practitioner_id)).toEqual([di.id]);
    const [row] = await blockAt("17:00");
    expect(await getSourceReservationKeys("timed_block", row.id)).toEqual([di.id]);

    await page.goto(`/calendar?view=day&day=${day}`);
    for (const p of roster) {
      await expect(column(page, p.id).getByTitle(`Unavailable · Only ${di.name}`, { exact: true })).toHaveCount(p.key === "di" ? 1 : 0);
    }
  });

  test("a member's block closes only their own time; no studio-wide choice is offered", async ({ page }) => {
    const bo = byKey("bo");
    await loginByMagicLink(page, bo.email!);
    const drawer = await openBlockDrawer(page);
    await expect(drawer.getByLabel("Applies to")).toHaveCount(0);
    await expect(drawer.getByText(`Blocks only your time (${bo.name}). Other practitioners stay bookable.`)).toBeVisible();
    await drawer.getByLabel("Start", { exact: true }).fill("18:00");
    await drawer.getByLabel("End", { exact: true }).fill("18:30");
    await drawer.getByRole("button", { name: "Save block" }).tap();
    await expect(drawer).toHaveCount(0);
    await expect.poll(async () => (await blockAt("18:00")).map((r) => r.practitioner_id)).toEqual([bo.id]);
    const [row] = await blockAt("18:00");
    expect(await getSourceReservationKeys("timed_block", row.id)).toEqual([bo.id]);

    await page.goto(`/calendar?view=day&day=${day}`);
    for (const p of roster) {
      await expect(column(page, p.id).getByTitle(`Unavailable · Only ${bo.name}`, { exact: true })).toHaveCount(p.key === "bo" ? 1 : 0);
    }
  });
});
