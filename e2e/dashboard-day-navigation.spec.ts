import { test, expect, type Page } from "@playwright/test";
import {
  getStudioTimezone,
  seedE2eDashboardClient,
  seedE2eStudio,
  seedE2eTodayAppointment,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Chloe: "I want an option to go to the next day."
//
// The Dashboard briefing was Today-only, so planning tomorrow meant leaving for
// the Calendar. This spec drives the real control on the real page against the
// local stack, because the risk here is not the arithmetic — that is unit-
// tested — but whether the ROSTER actually follows the header. A header that
// says "Tomorrow" over today's appointments is worse than no button at all: it
// is a confident lie about who is walking in.
//
// So every assertion below pairs the heading with the PEOPLE underneath it.

const T = 30_000;

/** Studio-local calendar date, offset by whole days — same rule as the page. */
function localDay(tz: string, offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  // en-CA renders ISO-ordered y-m-d, which is the param format.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

async function seedOn(
  seed: E2eSeed,
  label: string,
  minutesFromNow: number,
) {
  const client = await seedE2eDashboardClient(seed, { label });
  await seedE2eTodayAppointment(seed, {
    clientId: client.clientId,
    startsMinutesFromNow: minutesFromNow,
    endsMinutesFromNow: minutesFromNow + 45,
  });
  return client;
}

function heading(page: Page, name: string) {
  return page.getByRole("heading", { level: 2, name, exact: true });
}

/**
 * Wait for the click to actually LAND, then assert the params.
 *
 * Reading `page.url()` straight after a click is a race that fails open: the
 * old document is still current, every control is still on screen, and the
 * assertion happily describes the page you just left. Both of the first
 * versions of this spec were green-looking for exactly that reason.
 */
async function landsOn(
  page: Page,
  expected: { day: string | null; period?: string | null },
) {
  await page.waitForURL(
    (u) =>
      u.searchParams.get("day") === expected.day &&
      (expected.period === undefined ||
        u.searchParams.get("period") === expected.period),
    { timeout: T },
  );
}

test.describe("Dashboard day navigation", () => {
  test("next / previous / today move the roster, and the roster matches the heading", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);

    // The studio's timezone is chosen so "now" is local morning, so ±23–25h
    // lands cleanly inside the adjacent local day regardless of DST.
    const todayClient = await seedOn(seed, "Today Person", 90);
    const tomorrowClient = await seedOn(seed, "Tomorrow Person", 25 * 60);
    const yesterdayClient = await seedOn(seed, "Yesterday Person", -23 * 60);

    await loginAsOwner(page, seed);

    await test.step("1. the Dashboard still opens on Today", async () => {
      await page.goto("/dashboard");
      await expect(heading(page, "Today")).toBeVisible({ timeout: T });
      await expect(page.getByText(todayClient.name)).toBeVisible();
      await expect(page.getByText(tomorrowClient.name)).toHaveCount(0);
      // No day param on the canonical view.
      expect(new URL(page.url()).searchParams.get("day")).toBeNull();
    });

    await test.step("2. Next day shows TOMORROW's roster, not today's", async () => {
      await page.getByTestId("dashboard-next-day").click();
      await landsOn(page, { day: localDay(tz, 1) });
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
      await expect(page.getByText(tomorrowClient.name)).toBeVisible();
      // The load-bearing half: today's client is GONE.
      await expect(page.getByText(todayClient.name)).toHaveCount(0);
    });

    await test.step("3. Next day again advances one more day, and keeps advancing", async () => {
      await page.getByTestId("dashboard-next-day").click();
      await landsOn(page, { day: localDay(tz, 2) });
      // Two days out has nobody, and the empty sentence must not say "today".
      await expect(page.getByText("No appointments today.")).toHaveCount(0);
      await expect(page.getByText(/^No appointments on /)).toBeVisible();
    });

    await test.step("4. Previous day walks back the way it came", async () => {
      await page.getByTestId("dashboard-prev-day").click();
      await landsOn(page, { day: localDay(tz, 1) });
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
    });

    await test.step("5. Today returns to the canonical Today view", async () => {
      await page.getByTestId("dashboard-today").click();
      await landsOn(page, { day: null });
      await expect(heading(page, "Today")).toBeVisible({ timeout: T });
      await expect(page.getByText(todayClient.name)).toBeVisible();
    });

    await test.step("6. Previous day reaches YESTERDAY — the briefing looks backwards too", async () => {
      await page.getByTestId("dashboard-prev-day").click();
      await landsOn(page, { day: localDay(tz, -1) });
      await expect(page.getByText(yesterdayClient.name)).toBeVisible({
        timeout: T,
      });
      await expect(page.getByText(todayClient.name)).toHaveCount(0);
    });
  });

  test("a hostile or nonsense day param degrades to Today — it never 500s", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const todayClient = await seedOn(seed, "Fallback Person", 90);
    await loginAsOwner(page, seed);

    // `2026-02-31` is the dangerous one: it satisfies every shape check and
    // ROLLS OVER in date maths, so a page that trusted it would title one day
    // and query another. `2026-8-2` is the other class — it makes the date
    // helpers throw, which on an async Server Component is a 500 for the whole
    // Dashboard, not a bad roster.
    for (const bad of [
      "2026-02-31",
      "2026-8-2",
      "not-a-date",
      "9999-12-31",
      "%3Cscript%3E",
    ]) {
      await test.step(`7. day=${bad} falls back to Today`, async () => {
        const res = await page.goto(`/dashboard?day=${bad}`);
        expect(res?.status(), `status for day=${bad}`).toBeLessThan(400);
        await expect(heading(page, "Today")).toBeVisible({ timeout: T });
        await expect(page.getByText(todayClient.name)).toBeVisible();
      });
    }
  });

  test("day and period coexist — neither control clears the other", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);
    await seedOn(seed, "Period Person", 90);
    await loginAsOwner(page, seed);

    await test.step("8. stepping a day PRESERVES the chosen period", async () => {
      await page.goto("/dashboard?period=month");
      await expect(heading(page, "Today")).toBeVisible({ timeout: T });
      await page.getByTestId("dashboard-next-day").click();
      await landsOn(page, { day: localDay(tz, 1), period: "month" });
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
    });

    await test.step("9. a period pill PRESERVES the selected day", async () => {
      // The regression this exists to stop: period links used to be hardcoded
      // to `/dashboard?period=…`, which silently snapped the roster back to
      // today while the pill appeared to do something unrelated.
      await page.getByRole("link", { name: "This week", exact: true }).click();
      await landsOn(page, { day: localDay(tz, 1), period: "week" });
      // Still on tomorrow: the pill changed the reporting window only.
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
    });

    await test.step("10. returning to Today keeps the period", async () => {
      await page.getByTestId("dashboard-today").click();
      await landsOn(page, { day: null, period: "week" });
      await expect(heading(page, "Today")).toBeVisible({ timeout: T });
    });
  });

  test("the Current pill is a statement about NOW, so it appears only on today", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    // Now is inside this interval.
    const inRoom = await seedOn(seed, "In Room Person", -20);
    // Same clock-time tomorrow. A naive "does now fall inside the booked
    // interval" check is false here anyway — but a naive "is this the first
    // upcoming appointment" highlight would light it up, and the practitioner
    // would read tomorrow's chair as occupied.
    await seedOn(seed, "Tomorrow Room Person", 24 * 60 - 20);
    await loginAsOwner(page, seed);

    await test.step("11. today's in-progress appointment is Current", async () => {
      await page.goto("/dashboard");
      await expect(
        page.locator("li").filter({ hasText: inRoom.name }).first()
          .getByTestId("today-current-pill"),
      ).toBeVisible({ timeout: T });
    });

    await test.step("11b. NO row on another day carries a Current pill", async () => {
      await page.getByTestId("dashboard-next-day").click();
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
      await expect(page.getByTestId("today-current-pill")).toHaveCount(0);
    });
  });

});

// Chloe works from an iPad and a phone between clients, so the control has to
// survive the narrow viewport: three buttons plus a heading on one line is
// exactly the arrangement that overflows.
test.describe("Dashboard day navigation — 390px phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the controls are reachable and tappable on a phone", async ({ page }) => {
    const seed = await seedE2eStudio();
    await seedOn(seed, "Phone Person", 90);
    await loginAsOwner(page, seed);

    await test.step("12. all three controls fit and meet the 44px tap target", async () => {
      await page.goto("/dashboard");
      await expect(heading(page, "Today")).toBeVisible({ timeout: T });

      // On today the "Today" link is deliberately absent — a control that
      // cannot do anything is noise on a 390px header, and hiding it is what
      // keeps the row from wrapping into the Book appointment button.
      await expect(page.getByTestId("dashboard-today")).toHaveCount(0);

      // Step to tomorrow first, where all THREE controls are present: that is
      // the widest the row ever gets, so it is the case that must fit.
      await page.getByTestId("dashboard-next-day").tap();
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });

      for (const id of [
        "dashboard-prev-day",
        "dashboard-today",
        "dashboard-next-day",
      ]) {
        const control = page.getByTestId(id);
        await expect(control, id).toBeVisible();
        const box = await control.boundingBox();
        expect(box, `${id} has no box`).not.toBeNull();
        expect(box!.height, `${id} height`).toBeGreaterThanOrEqual(44);
        // Inside the viewport, not clipped off the right edge.
        expect(box!.x, `${id} left`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${id} right`).toBeLessThanOrEqual(390);
      }

      // And the return path works under a thumb.
      await page.getByTestId("dashboard-today").tap();
      await expect(heading(page, "Today")).toBeVisible({ timeout: T });
    });
  });
});
