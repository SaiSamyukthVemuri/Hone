import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  getE2eServiceId, getOwnerPractitionerId, seedE2eClient, seedE2eMember, seedE2eStudio, seedPractitionerDefault,
  seedServiceEligibility, setStudioCapacityBookingEnabled, setStudioCapacityEnabled, setStudioTimezone, sql, type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { TEAM_DAY_COLUMN_MIN_WIDTH_REM, TEAM_DAY_RAIL_PX } from "../lib/calendar/team-day-layout";

// HON-48 calendar sidebar (production, #1288): practitioner checkboxes, the exact empty message, the Day column width rule
// (1 / 2 / 6 selected), the mini calendar's today vs selected marks in the STUDIO timezone, the Time insights counting rules, the
// mobile drawer, and keyboard use. SYNTHETIC data only.
//
// Opt-in like the day-layout matrix (serial browser time, own studio): set CAL_SIDEBAR_E2E=1. Screenshots go to CAL_SHOTS_DIR.
test.skip(process.env.CAL_SIDEBAR_E2E !== "1", "opt-in HON-48 sidebar matrix; set CAL_SIDEBAR_E2E=1");

const TZ = "America/Los_Angeles";
const SHOTS = process.env.CAL_SHOTS_DIR ?? "test-results/cal-sidebar-shots";
const EMPTY_MESSAGE = "Select a practitioner to view their calendar."; // lib/calendar/practitioner-selection.ts EMPTY_SELECTION_MESSAGE
const MIN_COL_PX = TEAM_DAY_COLUMN_MIN_WIDTH_REM * 16;
const RAIL_PX = TEAM_DAY_RAIL_PX;

const DESKTOP = { viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false } as const;
const MOBILE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } as const;

type Studio = {
  seed: E2eSeed; names: string[]; ids: string[]; serviceId: string; clientName: string;
  today: string; tomorrow: string; day: string; // day = a future day with every practitioner working
  D: string; D1: string; D2: string; A: string; Aprev: string; Anext: string; // Time insights dataset, all in the future
};
let studio: Promise<Studio> | null = null;

// Six practitioners (owner + five members) so that 0 / 1 / 2 / 6 selected are all reachable. Every practitioner is open every day.
function getStudio(): Promise<Studio> {
  studio ??= (async () => {
    const seed = await seedE2eStudio();
    await setStudioTimezone(seed.studioId, TZ);
    await setStudioCapacityEnabled(seed.studioId, true);
    await setStudioCapacityBookingEnabled(seed.studioId, true);
    const ownerId = await getOwnerPractitionerId(seed.studioId);
    const serviceId = await getE2eServiceId(seed.studioId);
    const members = [];
    for (let i = 0; i < 5; i++) members.push(await seedE2eMember(seed));
    const ids = [ownerId, ...members.map((m) => m.practitionerId)];
    for (const id of ids) {
      await seedServiceEligibility(seed.studioId, serviceId, id);
      for (let dow = 0; dow < 7; dow++) await seedPractitionerDefault(seed.studioId, id, dow, true, "00:00", "23:59");
    }
    const ownerName = (await sql<{ n: string }>("select display_name as n from public.practitioners where id=$1", [ownerId]))[0].n;
    const names = [ownerName, ...members.map((m) => m.displayName)];
    const { clientId } = await seedE2eClient(seed);
    const [c] = await sql<Record<"today" | "tomorrow" | "day" | "A" | "Aprev" | "Anext" | "D" | "D1" | "D2", string>>(
      `with a as (select (date_trunc('month', (now() at time zone $1)::date) + interval '2 month')::date as a),
            d as (select a, (a + 9 + ((3 - extract(dow from (a + 9))::int + 7) % 7))::date as d from a)
       select (now() at time zone $1)::date::text as today, ((now() at time zone $1)::date + 1)::text as tomorrow,
              ((now() at time zone $1)::date + 7)::text as day,
              a::text as "A", (a - 1)::text as "Aprev", (a + interval '1 month')::date::text as "Anext",
              d::text as "D", (d + 1)::text as "D1", (d + 2)::text as "D2" from d`, [TZ]);

    // Time insights dataset. All times studio-local. D is a Wednesday between the 10th and the 16th of month A (the month after next).
    //   Day D   P0 09:00-10:00 confirmed 60 | P0 11:00-11:30 completed 30 | P0 13:00-14:00 CANCELLED (never counted)
    //           P1 10:00-11:30 no_show 90   | P1 12:00-13:00 timed BLOCK (never counted) | P2 15:00-16:00 confirmed 60
    //   D+1     P0 23:30 -> D+2 00:30 confirmed (crosses midnight: 30 min on each day, one appointment on each)
    //   Edges   P0 last day of A-1 23:00 -> day 1 of A 01:00 (60 min in A-1, 60 min in A, one appointment in each)
    //           P0 last day of A-1 10:00-11:00 and P0 day 1 of A+1 10:00-11:00: spill-over days drawn in A's grid, NOT part of A
    const appt = (pi: number, day: string, from: string, dayTo: string, to: string, status: string) => sql(
      `insert into public.appointments (id, studio_id, client_id, practitioner_id, service_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
       select gen_random_uuid(), $1, $2, $3, $4, s, e, (extract(epoch from (e - s))/60)::int, 0, e, $9
         from (select (($5::date + $6::time) at time zone $10) as s, (($7::date + $8::time) at time zone $10) as e) t`,
      [seed.studioId, clientId, ids[pi], serviceId, day, from, dayTo, to, status, TZ]);
    await appt(0, c.D, "09:00", c.D, "10:00", "confirmed");
    await appt(0, c.D, "11:00", c.D, "11:30", "completed");
    await appt(0, c.D, "13:00", c.D, "14:00", "cancelled");
    await appt(1, c.D, "10:00", c.D, "11:30", "no_show");
    await sql(
      "insert into public.studio_timed_blocks (studio_id,practitioner_id,created_by,starts_at,ends_at,category,private_note) " +
      "select $1,$2,$2,s,s+interval '1 hour','lunch',$3 from (select ($4::date + time '12:00') at time zone $5 as s) t",
      [seed.studioId, ids[1], `cal-sidebar-block-${seed.runId}`, c.D, TZ]);
    await appt(2, c.D, "15:00", c.D, "16:00", "confirmed");
    await appt(0, c.D1, "23:30", c.D2, "00:30", "confirmed");
    await appt(0, c.Aprev, "23:00", c.A, "01:00", "confirmed");
    await appt(0, c.Aprev, "10:00", c.Aprev, "11:00", "confirmed");
    await appt(0, c.Anext, "10:00", c.Anext, "11:00", "confirmed");

    const clientName = (await sql<{ name: string }>("select name from public.clients where studio_id=$1 and id=$2", [seed.studioId, clientId]))[0].name;
    return { seed, names, ids, serviceId, clientName, ...c };
  })();
  return studio;
}

async function shot(page: Page, vp: string, state: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${vp}-${state}.png`), fullPage: false });
}

const sidebar = (p: Page) => p.getByTestId("calendar-sidebar");
const toggle = (p: Page) => p.getByTestId("calendar-sidebar-toggle");
const box = (p: Page, name: string) => sidebar(p).getByRole("checkbox", { name, exact: true });
const teamDay = (p: Page) => p.getByTestId("team-day-view");
const columnCount = (p: Page) => teamDay(p).getAttribute("data-column-count");
const insights = (p: Page) => p.getByTestId("calendar-time-insights");
const total = (p: Page) => p.getByTestId("time-insights-total");
const miniDay = (p: Page, iso: string) => p.locator(`[data-testid="calendar-mini-day"][data-date="${iso}"]`);

async function ensureOpen(page: Page): Promise<void> {
  if (!(await sidebar(page).isVisible())) await toggle(page).click();
  await expect(sidebar(page)).toBeVisible();
}
// EXACTLY the first n practitioners checked, through the UI.
async function select(page: Page, s: Studio, n: number): Promise<void> {
  await ensureOpen(page);
  for (let i = 0; i < s.names.length; i++) {
    const want = i < n, b = box(page, s.names[i]);
    if ((await b.isChecked()) !== want) await (want ? b.check() : b.uncheck());
  }
  for (let i = 0; i < s.names.length; i++) {
    if (i < n) await expect(box(page, s.names[i])).toBeChecked(); else await expect(box(page, s.names[i])).not.toBeChecked();
  }
}
async function colWidths(page: Page): Promise<number[]> {
  return teamDay(page).getByTestId("team-day-column").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
}
async function scrollsSideways(loc: Locator): Promise<boolean> {
  return loc.evaluate((el) => el.scrollWidth > el.clientWidth + 1 && ["auto", "scroll"].includes(getComputedStyle(el).overflowX));
}
// Hand-written expected summaries (formatInsightSummary): never derived from the app.
const SUMMARY = {
  dayAll: "4 h · 4 appointments", dayP0: "1 h 30 min · 2 appointments", dayP1: "1 h 30 min · 1 appointment", dayP2: "1 h · 1 appointment",
  zero: "0 h · 0 appointments", d1: "30 min · 1 appointment", d2: "30 min · 1 appointment",
  weekAll: "5 h · 5 appointments", monthAll: "6 h · 6 appointments", monthP0: "3 h 30 min · 4 appointments", prevMonth: "2 h · 2 appointments",
} as const;
const expectTotal = (page: Page, text: string, why: string) => expect(total(page), why).toHaveText(text);

for (const [vpName, vp] of [["desktop", DESKTOP], ["mobile", MOBILE]] as const) {
  test.describe(`calendar sidebar ${vpName}`, () => {
    test.use(vp);
    test.setTimeout(300_000);

    for (const view of ["day", "week", "month"] as const) {
      test(`${view}: the toggle shows and hides the sidebar; every practitioner has a named checkbox`, async ({ page }) => {
        const s = await getStudio();
        await loginAsOwner(page, s.seed);
        await page.goto(`/calendar?view=${view}&day=${s.day}`);
        await ensureOpen(page);
        await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
        await expect(sidebar(page).getByTestId("calendar-sidebar-checkbox")).toHaveCount(s.names.length);
        for (const n of s.names) await expect(box(page, n)).toBeVisible();
        await shot(page, vpName, `${view}-open`);
        await toggle(page).click();
        await expect(sidebar(page)).toBeHidden();
        await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
        await shot(page, vpName, `${view}-closed`);
        await toggle(page).click();
        await expect(sidebar(page)).toBeVisible();
      });
    }

    test("checkboxes: each box adds and removes exactly its own column, and the choice survives a reload", async ({ page }) => {
      const s = await getStudio();
      await loginAsOwner(page, s.seed);
      await page.goto(`/calendar?view=day&day=${s.day}`);
      await select(page, s, 6);
      await expect.poll(() => columnCount(page)).toBe("6");
      await box(page, s.names[2]).uncheck();
      await expect.poll(() => columnCount(page)).toBe("5");
      await expect(teamDay(page).getByTestId("team-day-column-header").filter({ hasText: s.names[2] })).toHaveCount(0);
      await box(page, s.names[2]).check();
      await expect.poll(() => columnCount(page)).toBe("6");
      await select(page, s, 2);
      await expect.poll(() => columnCount(page)).toBe("2");
      await page.reload();
      await ensureOpen(page);
      await expect(box(page, s.names[0])).toBeChecked();
      await expect(box(page, s.names[1])).toBeChecked();
      await expect(box(page, s.names[2])).not.toBeChecked();
      await expect.poll(() => columnCount(page)).toBe("2");
    });

    test("nothing selected: the exact empty message in Day, Week and Month, and everyone is never restored", async ({ page }) => {
      const s = await getStudio();
      await loginAsOwner(page, s.seed);
      await page.goto(`/calendar?view=day&day=${s.day}`);
      await select(page, s, 0);
      await expect(page.getByTestId("calendar-empty-selection")).toHaveText(EMPTY_MESSAGE);
      await expect(teamDay(page).getByTestId("team-day-column")).toHaveCount(0);
      await shot(page, vpName, "day-selected-0");
      for (const view of ["week", "month", "day"]) {
        await page.goto(`/calendar?view=${view}&day=${s.day}`);
        await expect(page.getByText(EMPTY_MESSAGE, { exact: true })).toBeVisible();
        if (view === "week") await shot(page, vpName, "week-selected-0");
        if (view === "month") await shot(page, vpName, "month-selected-0");
      }
      await page.reload();
      await expect(page.getByText(EMPTY_MESSAGE, { exact: true })).toBeVisible();
      await ensureOpen(page);
      for (const n of s.names) await expect(box(page, n)).not.toBeChecked();
      // checking one box brings back exactly that one calendar
      await box(page, s.names[3]).check();
      await expect.poll(() => columnCount(page)).toBe("1");
      await expect(page.getByText(EMPTY_MESSAGE, { exact: true })).toHaveCount(0);
    });

    // Day width: one selected = a single schedule that uses the whole area; several share the width equally and never go
    // below the readable minimum, scrolling sideways inside the box instead (never the page) once they no longer fit.
    for (const n of [1, 2, 6] as const) {
      test(`day: ${n} selected -> ${n} column(s) with the dynamic width rule`, async ({ page }) => {
        const s = await getStudio();
        await loginAsOwner(page, s.seed);
        await page.goto(`/calendar?view=day&day=${s.day}`);
        await select(page, s, n);
        await expect.poll(() => columnCount(page)).toBe(String(n));
        const area = await teamDay(page).evaluate((el) => el.clientWidth) - RAIL_PX;
        const ws = await colWidths(page);
        expect(ws).toHaveLength(n);
        for (const w of ws) expect(w, "never narrower than the readable minimum").toBeGreaterThanOrEqual(MIN_COL_PX - 1);
        expect(Math.max(...ws) - Math.min(...ws), "equal widths within 1 px").toBeLessThanOrEqual(1);
        const fits = n * MIN_COL_PX <= area;
        if (fits) {
          expect(ws.reduce((a, b) => a + b, 0), "fills the area when the minimum fits").toBeGreaterThanOrEqual(area - 2);
          expect(await scrollsSideways(teamDay(page)), "no sideways scroll when it fits").toBe(false);
        } else {
          expect(ws[0], "at the minimum when it does not fit").toBeLessThanOrEqual(MIN_COL_PX + 1);
          expect(await scrollsSideways(teamDay(page)), "scrolls sideways inside the box").toBe(true);
        }
        if (n === 1) expect(ws[0], "a lone column is not a compact strip in an empty area").toBeGreaterThanOrEqual(area - 2);
        const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(pageOverflow, "the page itself never scrolls sideways").toBeLessThanOrEqual(1);
        await shot(page, vpName, `day-selected-${n}`);
      });
    }

    test("selection persists across date changes and Day / Week / Month, and the mini calendar navigates", async ({ page }) => {
      const s = await getStudio();
      await loginAsOwner(page, s.seed);
      await page.goto(`/calendar?view=day&day=${s.day}`);
      await select(page, s, 2);
      await ensureOpen(page);
      await miniDay(page, s.tomorrow).click();
      await expect(page).toHaveURL(new RegExp(`day=${s.tomorrow}`));
      await expect.poll(() => columnCount(page)).toBe("2");
      for (const v of ["week", "month", "day"]) {
        await page.goto(`/calendar?view=${v}&day=${s.tomorrow}`);
        await ensureOpen(page);
        await expect(box(page, s.names[0])).toBeChecked();
        await expect(box(page, s.names[1])).toBeChecked();
        for (const n of s.names.slice(2)) await expect(box(page, n)).not.toBeChecked();
      }
    });

    test("mobile drawer / desktop panel: keyboard", async ({ page }) => {
      const s = await getStudio();
      await loginAsOwner(page, s.seed);
      await page.goto(`/calendar?view=day&day=${s.day}`);
      const isDrawer = vpName === "mobile";
      if (isDrawer) {
        // the drawer is closed, reachable from the toggle, and opens as a modal dialog that takes focus
        await expect(sidebar(page)).toBeHidden();
        await toggle(page).focus();
        await page.keyboard.press("Enter");
        await expect(sidebar(page)).toBeVisible();
        await expect(sidebar(page)).toHaveAttribute("role", "dialog");
        await expect(sidebar(page)).toHaveAttribute("aria-modal", "true");
        await expect(sidebar(page)).toBeFocused();
        await shot(page, vpName, "drawer-open");
      } else {
        await ensureOpen(page);
      }
      // Tab reaches a checkbox; Space toggles it; the column set follows; focus stays on the box
      const first = box(page, s.names[0]);
      await first.focus();
      await expect(first).toBeFocused();
      const before = await first.isChecked();
      await page.keyboard.press("Space");
      await expect(first).toBeChecked({ checked: !before });
      await expect(first).toBeFocused();
      await page.keyboard.press("Space");
      await expect(first).toBeChecked({ checked: before });
      // Tab order inside the panel: mini calendar before insights before practitioners (DOM order = reading order)
      const order = await sidebar(page).evaluate((el) => {
        const idx = (sel: string) => { const n = el.querySelector(sel); return n ? Array.from(el.querySelectorAll("*")).indexOf(n) : -1; };
        return [idx('[data-testid="calendar-mini-month"]'), idx('[data-testid="calendar-time-insights"]'), idx('[data-testid="calendar-sidebar-practitioners"]')];
      });
      expect(order[0]).toBeGreaterThan(-1);
      expect(order[0] < order[1] && order[1] < order[2]).toBe(true);
      if (isDrawer) {
        // Escape closes the drawer and returns focus to the toggle; the backdrop also closes it
        await page.keyboard.press("Escape");
        await expect(sidebar(page)).toBeHidden();
        await expect(toggle(page)).toBeFocused();
        await toggle(page).click();
        await expect(sidebar(page)).toBeVisible();
        await page.getByTestId("calendar-sidebar-backdrop").click({ position: { x: 370, y: 400 } });
        await expect(sidebar(page)).toBeHidden();
      } else {
        await toggle(page).focus();
        await page.keyboard.press("Enter");
        await expect(sidebar(page)).toBeHidden();
        await page.keyboard.press("Space");
        await expect(sidebar(page)).toBeVisible();
      }
    });

    test("Time insights are inside the sidebar (drawer on a phone) and the section collapses", async ({ page }) => {
      const s = await getStudio();
      await loginAsOwner(page, s.seed);
      await page.goto(`/calendar?view=day&day=${s.D}`);
      await select(page, s, 6);
      await expect(insights(page)).toBeVisible();
      await expectTotal(page, SUMMARY.dayAll, "drawer / panel totals");
      await shot(page, vpName, "insights-day-all");
      await insights(page).locator("summary").click();
      await expect(insights(page)).not.toHaveAttribute("open", "");
      await expect(total(page)).toBeHidden();
      await insights(page).locator("summary").click();
      await expect(total(page)).toBeVisible();
    });
  });
}

// ---- desktop only --------------------------------------------------------------------------------------------------------------------

test.describe("calendar sidebar desktop only", () => {
  test.use(DESKTOP);
  test.setTimeout(300_000);

  test("collapsing the sidebar returns its width to the schedule", async ({ page }) => {
    const s = await getStudio();
    await loginAsOwner(page, s.seed);
    await page.goto(`/calendar?view=day&day=${s.day}`);
    await select(page, s, 1);
    const open = await teamDay(page).evaluate((el) => el.getBoundingClientRect().width);
    const side = await sidebar(page).evaluate((el) => el.getBoundingClientRect().width);
    await toggle(page).click();
    await expect(sidebar(page)).toBeHidden();
    await expect.poll(() => teamDay(page).evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(open + side - 40);
    // and the choice is a per-viewer preference that survives a reload
    await page.reload();
    await expect(sidebar(page)).toBeHidden();
    await shot(page, "desktop", "collapsed");
    await toggle(page).click();
    await expect(sidebar(page)).toBeVisible();
  });
});

// Mini calendar: today vs selected, judged in the STUDIO timezone (Los Angeles), with the browser in the same zone and in a zone
// whose calendar date differs from the studio's for most of the day.
for (const tz of [TZ, "Pacific/Auckland"]) {
  test.describe(`mini calendar marks (browser timezone ${tz})`, () => {
    test.use({ ...DESKTOP, timezoneId: tz });
    test.setTimeout(300_000);

    test("today and selected are different marks on different days, and one cell carries both after Today", async ({ page }) => {
      const s = await getStudio();
      await loginAsOwner(page, s.seed);
      await page.goto(`/calendar?view=day&day=${s.tomorrow}`);
      await ensureOpen(page);
      const todayCells = page.locator('[data-testid="calendar-mini-day"][data-mini-today="true"]');
      const selectedCells = page.locator('[data-testid="calendar-mini-day"][data-mini-selected="true"]');
      await expect(todayCells).toHaveCount(1);
      await expect(selectedCells).toHaveCount(1);
      await expect(todayCells).toHaveAttribute("data-date", s.today); // the studio's today, whatever the browser's clock says
      await expect(selectedCells).toHaveAttribute("data-date", s.tomorrow);
      await expect(miniDay(page, s.today)).not.toHaveAttribute("data-mini-selected", "true");
      await expect(miniDay(page, s.tomorrow)).not.toHaveAttribute("data-mini-today", "true");
      await expect(miniDay(page, s.tomorrow)).toHaveAttribute("aria-current", "date");
      await expect(miniDay(page, s.today)).not.toHaveAttribute("aria-current", "date");
      await expect(miniDay(page, s.today)).toHaveAttribute("aria-label", `${s.today}, today`);
      await expect(miniDay(page, s.tomorrow)).toHaveAttribute("aria-label", `${s.tomorrow}, selected`);
      await shot(page, `desktop-${tz.replace("/", "-")}`, "mini-today-vs-selected");

      await page.getByTestId("calendar-mini-today").click();
      await expect(page).toHaveURL(new RegExp(`day=${s.today}`));
      await expect(miniDay(page, s.today)).toHaveAttribute("data-mini-today", "true");
      await expect(miniDay(page, s.today)).toHaveAttribute("data-mini-selected", "true");
      await expect(miniDay(page, s.today)).toHaveAttribute("aria-label", `${s.today}, today, selected`);
    });

    test("a date click navigates the current view; the arrows move only the mini month", async ({ page }) => {
      const s = await getStudio();
      await loginAsOwner(page, s.seed);
      for (const view of ["day", "week"] as const) {
        await page.goto(`/calendar?view=${view}&day=${s.D}`);
        await ensureOpen(page);
        await miniDay(page, s.D1).click();
        await expect(page).toHaveURL(new RegExp(`view=${view}`));
        await expect(page).toHaveURL(new RegExp(`day=${s.D1}`));
        const url = page.url();
        const label = await page.getByTestId("calendar-mini-label").innerText();
        await page.getByTestId("calendar-mini-next").click();
        await expect(page.getByTestId("calendar-mini-label")).not.toHaveText(label);
        expect(page.url(), "the arrows never move the view").toBe(url);
        await page.getByTestId("calendar-mini-prev").click();
        await expect(page.getByTestId("calendar-mini-label")).toHaveText(label);
      }
      // Month has no single selected date: no cell is marked selected, and a click opens that month
      await page.goto(`/calendar?view=month&month=${s.D.slice(0, 7)}-01`);
      await ensureOpen(page);
      await expect(page.locator('[data-testid="calendar-mini-day"][data-mini-selected="true"]')).toHaveCount(0);
      await miniDay(page, s.D1).click();
      await expect(page).toHaveURL(new RegExp(`view=month`));
    });
  });
}

// Time insights rules: booked appointment time and count for the displayed period and the selected practitioners.
test.describe("calendar Time insights rules", () => {
  test.use(DESKTOP);
  test.setTimeout(300_000);

  test("Day: by selection; cancelled and timed blocks never count; no_show and completed do; zero is shown as zero", async ({ page }) => {
    const s = await getStudio();
    await loginAsOwner(page, s.seed);
    await page.goto(`/calendar?view=day&day=${s.D}`);
    await select(page, s, 6);
    await expectTotal(page, SUMMARY.dayAll, "everyone: 60 + 30 + 90 + 60 minutes, 4 appointments (cancelled and block out)");
    await expect(page.getByTestId("time-insights-label")).toContainText("all selected");
    await select(page, s, 1);
    await expectTotal(page, SUMMARY.dayP0, "P0: confirmed + completed, cancelled out");
    await expect(page.getByTestId("time-insights-label")).toContainText(`${s.names[0]} selected`);
    await box(page, s.names[0]).uncheck();
    await box(page, s.names[1]).check();
    await expectTotal(page, SUMMARY.dayP1, "P1: the no-show counts, the lunch block does not");
    await box(page, s.names[1]).uncheck();
    await box(page, s.names[2]).check();
    await expectTotal(page, SUMMARY.dayP2, "P2");
    await box(page, s.names[0]).check();
    await box(page, s.names[1]).check();
    await expect(page.getByTestId("time-insights-label")).toContainText("3 practitioners selected");
    await expectTotal(page, SUMMARY.dayAll, "the three with appointments");
    await select(page, s, 0);
    await expectTotal(page, SUMMARY.zero, "nothing selected is 0, not an estimate");
    await expect(page.getByTestId("time-insights-label")).toContainText("no practitioner selected");
    await expect(page.getByTestId("time-insights-total")).toHaveAttribute("data-minutes", "0");
    await expect(page.getByTestId("time-insights-total")).toHaveAttribute("data-count", "0");
    await shot(page, "desktop", "insights-zero");
  });

  test("the counting rule is stated in the UI", async ({ page }) => {
    const s = await getStudio();
    await loginAsOwner(page, s.seed);
    await page.goto(`/calendar?view=day&day=${s.D}`);
    await ensureOpen(page);
    const tip = await insights(page).locator("[title]").first().getAttribute("title");
    expect(tip).toMatch(/Cancelled and voided appointments are not counted/);
    expect(tip).toMatch(/scheduled, completed and no-show are/);
    expect(tip).toMatch(/Blocks, breaks and closures are never counted/);
    await expect(insights(page)).toContainText("Cancelled excluded; blocks and breaks never counted.");
  });

  test("an appointment crossing midnight counts only the minutes inside each day, and once per period", async ({ page }) => {
    const s = await getStudio();
    await loginAsOwner(page, s.seed);
    await page.goto(`/calendar?view=day&day=${s.D1}`);
    await select(page, s, 6);
    await expectTotal(page, SUMMARY.d1, "D+1: the 30 minutes before midnight");
    await page.goto(`/calendar?view=day&day=${s.D2}`);
    await expectTotal(page, SUMMARY.d2, "D+2: the 30 minutes after midnight, still one appointment");
    await page.goto(`/calendar?view=week&day=${s.D}`);
    await expectTotal(page, SUMMARY.weekAll, "the displayed 7 days: 240 + the crossing appointment's 60, counted once");
    await shot(page, "desktop", "insights-week");
  });

  test("Month is the calendar month only: spill-over days are excluded and a boundary crossing counts the minutes inside", async ({ page }) => {
    const s = await getStudio();
    await loginAsOwner(page, s.seed);
    await page.goto(`/calendar?view=month&month=${s.D.slice(0, 7)}-01`);
    await select(page, s, 6);
    await expectTotal(page, SUMMARY.monthAll, "A: 240 + 60 + the 60 minutes after midnight on day 1; the A-1 and A+1 spill-over appointments are out");
    await shot(page, "desktop", "insights-month");
    await select(page, s, 1);
    await expectTotal(page, SUMMARY.monthP0, "A, first practitioner only");
    await page.goto(`/calendar?view=month&month=${s.Aprev.slice(0, 7)}-01`);
    await select(page, s, 6);
    await expectTotal(page, SUMMARY.prevMonth, "A-1: its own 10:00-11:00 plus the 60 minutes before midnight of the crossing appointment");
  });
});
