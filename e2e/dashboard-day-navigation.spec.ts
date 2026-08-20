import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  getStudioTimezone,
  seedE2eActiveCardOnFile,
  seedE2eCardOnFileCapability,
  seedE2eDashboardClient,
  seedE2eDashboardMemoryClient,
  seedE2eStudio,
  seedE2eTodayAppointment,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Chloe: "I want an option to go to the next day."
//
// V1 keeps the briefing a ONE-DAY briefing and moves only which day it
// describes. The load-bearing rule is what it does NOT do: off Today it asks
// no history question at all, so it must say nothing about history in either
// direction — not "New client", and not "unavailable" either, because nobody
// posed the question.
//
// Every assertion below pairs the heading with the PEOPLE underneath it. A
// header that says "Tomorrow" over today's appointments is worse than no button
// at all: it is a confident lie about who is walking in.

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

function heading(page: Page, name: string) {
  return page.getByRole("heading", { level: 2, name, exact: true });
}

function row(page: Page, clientName: string): Locator {
  return page.locator("li").filter({ hasText: clientName }).first();
}

/**
 * Wait for the click to actually LAND, then assert the params.
 *
 * Reading `page.url()` straight after a click is a race that fails open: the
 * old document is still current, every control is still on screen, and the
 * assertion happily describes the page you just left.
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

async function seedOn(seed: E2eSeed, label: string, minutesFromNow: number) {
  const client = await seedE2eDashboardClient(seed, { label });
  await seedE2eTodayAppointment(seed, {
    clientId: client.clientId,
    startsMinutesFromNow: minutesFromNow,
    endsMinutesFromNow: minutesFromNow + 45,
  });
  return client;
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
      await expect(page.getByText(todayClient.name).first()).toBeVisible();
      await expect(page.getByText(tomorrowClient.name)).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get("day")).toBeNull();
    });

    await test.step("2. Next day shows TOMORROW's roster, not today's", async () => {
      await page.getByTestId("dashboard-next-day").click();
      await landsOn(page, { day: localDay(tz, 1) });
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
      await expect(page.getByText(tomorrowClient.name).first()).toBeVisible();
      // The load-bearing half: today's client is GONE.
      await expect(page.getByText(todayClient.name)).toHaveCount(0);
    });

    await test.step("3. Next day again keeps advancing", async () => {
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
      await expect(page.getByText(todayClient.name).first()).toBeVisible();
    });

    await test.step("6. Previous day reaches YESTERDAY", async () => {
      await page.getByTestId("dashboard-prev-day").click();
      await landsOn(page, { day: localDay(tz, -1) });
      await expect(page.getByText(yesterdayClient.name).first()).toBeVisible({
        timeout: T,
      });
      await expect(page.getByText(todayClient.name)).toHaveCount(0);
    });

    await test.step("7. browser Back returns to the previous day view", async () => {
      await page.goBack();
      await landsOn(page, { day: null });
      await expect(heading(page, "Today")).toBeVisible({ timeout: T });
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
    for (const bad of ["2026-02-31", "2026-8-2", "not-a-date", "9999-12-31", "%3Cscript%3E"]) {
      await test.step(`8. day=${bad} falls back to Today`, async () => {
        const res = await page.goto(`/dashboard?day=${bad}`);
        expect(res?.status(), `status for day=${bad}`).toBeLessThan(400);
        await expect(heading(page, "Today")).toBeVisible({ timeout: T });
        await expect(page.getByText(todayClient.name).first()).toBeVisible();
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

    await test.step("9. stepping a day PRESERVES the chosen period", async () => {
      await page.goto("/dashboard?period=month");
      await expect(heading(page, "Today")).toBeVisible({ timeout: T });
      await page.getByTestId("dashboard-next-day").click();
      await landsOn(page, { day: localDay(tz, 1), period: "month" });
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
    });

    await test.step("10. a period pill PRESERVES the selected day", async () => {
      // The regression this exists to stop: period links used to be hardcoded
      // to `/dashboard?period=…`, which silently snapped the roster back to
      // today while the pill appeared to do something unrelated.
      await page.getByRole("link", { name: "This week", exact: true }).click();
      await landsOn(page, { day: localDay(tz, 1), period: "week" });
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
    });

    await test.step("11. returning to Today keeps the period", async () => {
      await page.getByTestId("dashboard-today").click();
      await landsOn(page, { day: null, period: "week" });
      await expect(heading(page, "Today")).toBeVisible({ timeout: T });
    });
  });

  test("the outward control is disabled at ±365 and never jumps to Today", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);
    await seedOn(seed, "Horizon Person", 90);
    await loginAsOwner(page, seed);

    const max = localDay(tz, 365);
    const nearMax = localDay(tz, 364);

    await test.step("12. at today + 364, Next is a real link to +365", async () => {
      await page.goto(`/dashboard?day=${nearMax}`);
      const next = page.getByTestId("dashboard-next-day");
      await expect(next).toBeVisible({ timeout: T });
      await expect(next).not.toHaveAttribute("data-disabled", "true");
      await next.click();
      // The load-bearing assertion: it lands on +365, NOT back on today.
      await landsOn(page, { day: max });
    });

    await test.step("13. at today + 365, Next is present but disabled", async () => {
      const next = page.getByTestId("dashboard-next-day");
      await expect(next).toBeVisible();
      await expect(next).toHaveAttribute("data-disabled", "true");
      await expect(next).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByRole("link", { name: "Next day" })).toHaveCount(0);
    });

    await test.step("14. inward navigation still works from the limit", async () => {
      await page.getByTestId("dashboard-prev-day").click();
      await landsOn(page, { day: nearMax });
      await page.getByTestId("dashboard-today").click();
      await landsOn(page, { day: null });
    });

    await test.step("15. the symmetric case at today - 365", async () => {
      await page.goto(`/dashboard?day=${localDay(tz, -365)}`);
      const prev = page.getByTestId("dashboard-prev-day");
      await expect(prev).toBeVisible({ timeout: T });
      await expect(prev).toHaveAttribute("data-disabled", "true");
      await expect(page.getByRole("link", { name: "Previous day" })).toHaveCount(0);
      await page.getByTestId("dashboard-next-day").click();
      await landsOn(page, { day: localDay(tz, -364) });
    });
  });
});

// ===========================================================================
// THE LOAD-BEARING RULE: off Today, V1 asks no history question.
// ===========================================================================

test.describe("history is not asked, and therefore not answered, off Today", () => {
  test("a returning client booked TOMORROW gets no history claim in either direction", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    // A client with a real charted session 30 days ago and an appointment
    // today...
    const { clientId } = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: "Avoid the jawline",
      nextVisitNote: "Lower the energy one step",
    });
    // ...who is ALSO booked tomorrow.
    await seedE2eTodayAppointment(seed, {
      clientId,
      startsMinutesFromNow: 25 * 60,
      endsMinutesFromNow: 25 * 60 + 45,
    });
    await loginAsOwner(page, seed);

    await test.step("16. TODAY is unchanged — the history is all still there", async () => {
      await page.goto("/dashboard");
      await expect(heading(page, "Today")).toBeVisible({ timeout: T });
      await expect(
        row(page, "Memory Client").getByText("Before today", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Remember: Lower the energy one step").first(),
      ).toBeVisible();
      await expect(page.getByText("Avoid the jawline").first()).toBeVisible();
      await expect(page.getByText("Review Before Today").first()).toBeVisible();
    });

    await test.step("17. TOMORROW states nothing about history at all", async () => {
      await page.getByTestId("dashboard-next-day").click();
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
      // The appointment is there.
      const tomorrowRow = row(page, "Memory Client");
      await expect(tomorrowRow).toBeVisible();
      // And the entire preparation block is absent from THAT ROW — no claim
      // either way. Scoped to the row deliberately: the page carries unrelated
      // prose elsewhere (the "Charted within 24h" card explains itself using
      // the words "before today"), and a page-wide substring match would fail
      // on copy that has nothing to do with this client.
      await expect(tomorrowRow.getByText("Before today", { exact: true })).toHaveCount(0);
      await expect(tomorrowRow.getByText("New client · No charted history yet")).toHaveCount(0);
      await expect(tomorrowRow.getByText(/^Remember:/)).toHaveCount(0);
      await expect(tomorrowRow.getByText(/^Latest setup:/)).toHaveCount(0);
      await expect(tomorrowRow.getByText("Avoid the jawline")).toHaveCount(0);
      await expect(tomorrowRow.getByTestId("missing-record-chip")).toHaveCount(0);
      await expect(tomorrowRow.getByTestId("today-memory-compact")).toHaveCount(0);
      // …and nowhere on the page does it answer the unasked question the other
      // way either. These strings exist nowhere but the history block, so a
      // page-wide check is exact here.
      await expect(page.getByText("History unavailable")).toHaveCount(0);
      await expect(page.getByText("New client · No charted history yet")).toHaveCount(0);
    });

    await test.step("18. and the primary action makes no claim either", async () => {
      // "Review Before Today" is the RETURNING-client affordance; it must not
      // be offered from a question that was never asked.
      await expect(page.getByText("Review Before Today")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Open client" }).first()).toBeVisible();
    });
  });

  test("a genuinely NEW client tomorrow is treated identically — that is what makes the silence honest", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const brandNew = await seedOn(seed, "Brand New Person", 25 * 60);
    await loginAsOwner(page, seed);

    await test.step("19. no new-client claim is made off Today", async () => {
      await page.goto("/dashboard");
      await page.getByTestId("dashboard-next-day").click();
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
      await expect(row(page, brandNew.name)).toBeVisible();
      // Even though this client really IS new, V1 did not ask, so it does not
      // say. A returning client and a new one are indistinguishable here by
      // design — the alternative is a claim that was never established.
      await expect(page.getByText("New client · No charted history yet")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Open client" }).first()).toBeVisible();
    });
  });

  test("#598 card status and consultation notes survive on tomorrow", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    await seedE2eCardOnFileCapability(seed);
    const withCard = await seedOn(seed, "Card Person", 25 * 60);
    await seedE2eActiveCardOnFile(seed, withCard.clientId);
    const noCard = await seedOn(seed, "Nocard Person", 25 * 60 + 60);
    await loginAsOwner(page, seed);

    await test.step("20. card status renders on a tomorrow row", async () => {
      await page.goto("/dashboard");
      await page.getByTestId("dashboard-next-day").click();
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
      // Card status describes the client NOW, so it is true on any day.
      await expect(
        row(page, withCard.name).locator('[data-card-status="card_on_file"]'),
      ).toBeVisible({ timeout: T });
      await expect(
        row(page, noCard.name).locator('[data-card-status="no_card"]'),
      ).toBeVisible();
      // A failed read would say unavailable; a successful one must never.
      await expect(page.getByText("Card status unavailable")).toHaveCount(0);
    });
  });

  test("the linked-session actions still win on a selected day", async ({ page }) => {
    const seed = await seedE2eStudio();
    const client = await seedE2eDashboardClient(seed, { label: "Past Person" });
    await seedE2eTodayAppointment(seed, {
      clientId: client.clientId,
      startsMinutesFromNow: -23 * 60,
      endsMinutesFromNow: -23 * 60 + 45,
      status: "completed",
    });
    await loginAsOwner(page, seed);

    await test.step("21. a completed, uncharted past appointment still says so", async () => {
      // These branches are decided BEFORE history in the resolver, so an
      // unasked question must not disturb them.
      await page.goto("/dashboard");
      await page.getByTestId("dashboard-prev-day").click();
      await expect(page.getByText(client.name).first()).toBeVisible({ timeout: T });
      await expect(page.getByText("Charting needed").first()).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Chart appointment" }).first(),
      ).toBeVisible();
    });
  });

  test("the Current pill is a statement about NOW, so it appears only on today", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const inRoom = await seedOn(seed, "In Room Person", -20);
    await seedOn(seed, "Tomorrow Room Person", 24 * 60 - 20);
    await loginAsOwner(page, seed);

    await test.step("22. today's in-progress appointment is Current", async () => {
      await page.goto("/dashboard");
      await expect(
        row(page, inRoom.name).getByTestId("today-current-pill"),
      ).toBeVisible({ timeout: T });
    });

    await test.step("23. NO row on another day carries a Current pill", async () => {
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

    await test.step("24. all three controls fit and meet the 44px tap target", async () => {
      await page.goto("/dashboard");
      await expect(heading(page, "Today")).toBeVisible({ timeout: T });

      // On today the "Today" link is deliberately absent — a control that
      // cannot do anything is noise on a 390px header.
      await expect(page.getByTestId("dashboard-today")).toHaveCount(0);

      // Step to tomorrow, where all THREE controls are present: that is the
      // widest the row ever gets, so it is the case that must fit.
      await page.getByTestId("dashboard-next-day").tap();
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });

      for (const id of ["dashboard-prev-day", "dashboard-today", "dashboard-next-day"]) {
        const control = page.getByTestId(id);
        await expect(control, id).toBeVisible();
        const box = await control.boundingBox();
        expect(box, `${id} has no box`).not.toBeNull();
        expect(box!.height, `${id} height`).toBeGreaterThanOrEqual(44);
        expect(box!.x, `${id} left`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${id} right`).toBeLessThanOrEqual(390);
      }

      // And the return path works under a thumb.
      await page.getByTestId("dashboard-today").tap();
      await expect(heading(page, "Today")).toBeVisible({ timeout: T });
    });
  });
});
