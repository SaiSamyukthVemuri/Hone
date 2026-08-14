import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedConfirmedAppointment,
  getOwnerPractitionerId,
  setStudioTimezone,
  sql,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// The practitioner working calendar runs SUNDAY → SATURDAY, and the same
// Sunday boundary drives the DATA RANGE, not just the headers.
//
// THE FAILURE THIS EXISTS TO CATCH is not a mis-ordered header, that is
// obvious the moment anyone looks. It is the silent one: a grid that starts
// Sunday while the query still starts Monday. The header reads correctly, the
// page looks perfect, and the practitioner's Sunday appointment is simply
// GONE. Nothing on screen says anything is wrong.
//
// So every assertion below binds a rendered COLUMN to the local DATE it
// claims to be (data-date), and then asserts what is inside that exact
// column. A cosmetic reorder cannot satisfy it.

const T = 20_000;

// A fixed timezone and a fixed week, so this spec does not drift with the
// calendar date of the run. America/Toronto is the repo's established DST
// fixture zone (lib/booking/tz.ts's two-pass correction was written for it).
// 2026-08-09 is a Sunday; the whole week is EDT (UTC-4), so local→UTC is a
// flat +4h and the seeded instants stay readable.
const TZ = "America/Toronto";
const SUNDAY = "2026-08-09";
const MONDAY = "2026-08-10";
const SATURDAY = "2026-08-15";
const NEXT_SUNDAY = "2026-08-16";
// Opened with a MIDWEEK date on purpose: the page must resolve Wed → its
// Sunday, rather than starting the grid on whatever day was clicked.
const MIDWEEK = "2026-08-12";

// EDT is UTC-4 for this entire week.
function edt(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(`${date}T${String(h + 4).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`).toISOString();
}

async function seedWeek(seed: Awaited<ReturnType<typeof seedE2eStudio>>) {
  await setStudioTimezone(seed.studioId, TZ);
  const practitionerId = await getOwnerPractitionerId(seed.studioId);
  // seedE2eStudio does NOT create a client row (its clientName/clientEmail are
  // the values the public booking flow would use), so seed one here.
  const clientId = (
    await sql<{ id: string }>(
      `insert into public.clients (id, studio_id, name, email)
       values (gen_random_uuid(), $1, $2, $3) returning id`,
      [seed.studioId, seed.clientName, seed.clientEmail],
    )
  )[0].id;

  const mk = async (date: string, hhmm: string) =>
    seedConfirmedAppointment(
      seed.studioId,
      practitionerId,
      clientId,
      edt(date, hhmm),
      edt(date, `${String(Number(hhmm.split(":")[0]) + 1).padStart(2, "0")}:00`),
    );

  return {
    clientId,
    // First column of the week under test.
    sundayAppt: await mk(SUNDAY, "09:00"),
    // Second column.
    mondayAppt: await mk(MONDAY, "10:00"),
    // EXCLUSION CONTROL: belongs to the NEXT week. If the range were
    // inclusive of the following Sunday, this would leak in.
    nextSundayAppt: await mk(NEXT_SUNDAY, "11:00"),
  };
}

async function openWeek(page: Page, anchor: string) {
  await page.goto(`/calendar?view=week&week=${anchor}`);
  await expect(page.getByTestId("week-day-header").first()).toBeVisible({
    timeout: T,
  });
}

// The dates of the seven rendered columns, in visual order.
async function headerDates(page: Page): Promise<string[]> {
  return page
    .getByTestId("week-day-header")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-date") ?? ""));
}

async function headerWeekdayLabels(page: Page): Promise<string[]> {
  return page
    .getByTestId("week-day-header")
    .evaluateAll((els) =>
      els.map((e) => (e.firstElementChild?.textContent ?? "").trim()),
    );
}

// Independent weekday naming: never ask the code under test what "Sunday" is.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function weekdayOf(dateStr: string): string {
  return DOW[new Date(`${dateStr}T12:00:00Z`).getUTCDay()];
}

test.describe("practitioner calendar: week starts Sunday", () => {
  test("a midweek date opens the Sunday→Saturday week, with the data range to match", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const seeded = await seedWeek(seed);
    await loginAsOwner(page, seed);
    await openWeek(page, MIDWEEK);

    await test.step("the seven columns run Sunday → Saturday", async () => {
      const dates = await headerDates(page);
      expect(dates).toHaveLength(7);
      // The selected date was a WEDNESDAY; the grid still begins on its Sunday.
      expect(dates[0]).toBe(SUNDAY);
      expect(dates[6]).toBe(SATURDAY);
      expect(dates.map(weekdayOf)).toEqual(DOW);
      // ...and the printed labels agree with the real weekday of each date,
      // which is what a cosmetic-only reorder would break.
      expect(await headerWeekdayLabels(page)).toEqual(DOW);
    });

    await test.step("the SUNDAY appointment is in the FIRST column", async () => {
      // This is the anti-cosmetic assertion. If the fetch range still began
      // Monday, this column would render empty while the header still said
      // "Sun".
      const sundayCol = page.locator(
        `[data-testid="week-day-column"][data-date="${SUNDAY}"]`,
      );
      await expect(sundayCol).toHaveCount(1);
      await expect(sundayCol.getByText(seed.clientName).first()).toBeVisible({
        timeout: T,
      });
    });

    await test.step("the MONDAY appointment is in the SECOND column, not the first", async () => {
      const cols = page.getByTestId("week-day-column");
      expect(
        await cols.evaluateAll((els) =>
          els.map((e) => e.getAttribute("data-date")),
        ),
      ).toEqual([SUNDAY, MONDAY, "2026-08-11", MIDWEEK, "2026-08-13", "2026-08-14", SATURDAY]);
      await expect(
        page
          .locator(`[data-testid="week-day-column"][data-date="${MONDAY}"]`)
          .getByText(seed.clientName)
          .first(),
      ).toBeVisible();
    });

    await test.step("the FOLLOWING Sunday is NOT in this week's grid", async () => {
      // Half-open range: [Sunday, next Sunday). The exclusion control must not
      // appear as a column at all.
      expect(await headerDates(page)).not.toContain(NEXT_SUNDAY);
      await expect(
        page.locator(
          `[data-testid="week-day-column"][data-date="${NEXT_SUNDAY}"]`,
        ),
      ).toHaveCount(0);
      expect(seeded.nextSundayAppt.length).toBeGreaterThan(0);
    });
  });

  test("Next week advances to the FOLLOWING Sunday and picks up its appointment", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await seedWeek(seed);
    await loginAsOwner(page, seed);
    await openWeek(page, MIDWEEK);

    expect((await headerDates(page))[0]).toBe(SUNDAY);

    await page.getByRole("link", { name: "Next", exact: true }).first().click();
    await page.waitForURL(`**/calendar?week=${NEXT_SUNDAY}`, { timeout: T });
    await expect(page.getByTestId("week-day-header").first()).toBeVisible({
      timeout: T,
    });

    const dates = await headerDates(page);
    expect(dates[0]).toBe(NEXT_SUNDAY);
    expect(dates.map(weekdayOf)).toEqual(DOW);
    // The appointment excluded from the previous week now appears, proving the
    // boundary MOVED the appointment rather than dropping it.
    await expect(
      page
        .locator(`[data-testid="week-day-column"][data-date="${NEXT_SUNDAY}"]`)
        .getByText(seed.clientName)
        .first(),
    ).toBeVisible({ timeout: T });
    // ...and the previous week's Sunday is gone from this grid.
    expect(dates).not.toContain(SUNDAY);

    await test.step("Previous week returns to the original Sunday, without drift", async () => {
      await page
        .getByRole("link", { name: "Previous", exact: true })
        .first()
        .click();
      await page.waitForURL(`**/calendar?week=${SUNDAY}`, { timeout: T });
      await expect(page.getByTestId("week-day-header").first()).toBeVisible({
        timeout: T,
      });
      expect((await headerDates(page))[0]).toBe(SUNDAY);
    });
  });
});
