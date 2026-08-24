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
// DASH-SNAPSHOT-SCROLL-01 — the period filter re-cuts the numbers IN PLACE
// ===========================================================================
//
// The Practice snapshot is the LAST reporting section on the Dashboard, below
// Today, To do and Birthdays, so a practitioner reading it is always scrolled
// down. Its period pills are ordinary query-only <Link>s, and Next's App Router
// applies its default forward-navigation scroll to every one of them:
// `ScrollAndFocusHandler` takes the segment's DOM node, sees its top edge is
// above the viewport, and sets `documentElement.scrollTop = 0`
// (node_modules/next/dist/client/components/layout-router.js). The period
// changed correctly and the practitioner was thrown to the top of the page,
// away from the very numbers they had just asked to re-cut.
//
// The proof is structural, never pixel comparison: it reads the scroll offset
// and the snapshot heading's viewport-relative top, and it also records the
// LOWEST scroll offset reached during the navigation — so a jump to the top
// that something later scrolled back cannot pass as "no jump".

/**
 * Sub-pixel rounding only. The defect moves the page by the full height of
 * everything above the snapshot (~1000px at this viewport), so this separates
 * the two outcomes by two orders of magnitude without pinning any layout.
 */
const SCROLL_TOLERANCE_PX = 4;

/**
 * Start recording the LOWEST scroll offset from now on. A period click is a
 * client-side navigation, so `window` survives it and the listener sees the
 * reset itself rather than only its aftermath.
 */
async function armScrollFloor(page: Page) {
  await page.evaluate(() => {
    const w = window as typeof window & {
      __honeScrollFloor?: number;
      __honeScrollFloorArmed?: boolean;
    };
    w.__honeScrollFloor = window.scrollY;
    if (w.__honeScrollFloorArmed) return;
    w.__honeScrollFloorArmed = true;
    window.addEventListener(
      "scroll",
      () => {
        w.__honeScrollFloor = Math.min(
          w.__honeScrollFloor ?? window.scrollY,
          window.scrollY,
        );
      },
      { passive: true },
    );
  });
}

/**
 * Settle, then read the offset and the floor together.
 *
 * The App Router's reset runs in a layout effect (synchronous with the commit)
 * but the scroll EVENT it triggers is dispatched before the next paint. Two
 * animation frames means neither can still be in flight — a fixed timeout would
 * be the flaky way to say the same thing.
 */
async function readScroll(page: Page): Promise<{ y: number; floor: number }> {
  return page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const w = window as typeof window & { __honeScrollFloor?: number };
    return { y: window.scrollY, floor: w.__honeScrollFloor ?? window.scrollY };
  });
}

test.describe("Practice snapshot — the period filter updates IN PLACE", () => {
  test("Today / This week / This month re-cut the snapshot without jumping the viewport", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);
    await seedOn(seed, "Snapshot Person", 90);
    await loginAsOwner(page, seed);

    // Held OFF Today for the whole run, so every period change also has to
    // carry the selected day: the two controls share one href builder and this
    // is the cheapest place to prove the fix did not disturb it.
    const day = localDay(tz, 1);
    const snapshot = heading(page, "Practice snapshot");
    // Scoped to the snapshot's OWN control row — its next-sibling div. The
    // day-nav group above carries a segment named "Today" too, so a page-wide
    // by-name lookup is ambiguous for exactly the pill this fix is about.
    const pill = (label: string) =>
      snapshot
        .locator("xpath=following-sibling::div[1]")
        .getByRole("link", { name: label, exact: true });
    // `uppercase` is a CSS transform, and whether it reaches the accessible
    // name is a browser detail this proof has no interest in pinning.
    const appointmentsCard = (periodLabel: string) =>
      page.getByRole("heading", {
        level: 3,
        name: new RegExp(`^Appointments ${periodLabel}$`, "i"),
      });

    await page.goto(`/dashboard?day=${day}`);
    await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });

    await test.step("16. the snapshot sits below the fold — the precondition", async () => {
      await expect(snapshot).toBeVisible({ timeout: T });
      // Deterministic placement rather than scrollIntoViewIfNeeded, which can
      // leave the pills themselves at the very bottom edge — Playwright would
      // then auto-scroll on click and move the baseline it is measuring.
      await snapshot.evaluate((el) => {
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 120);
      });
      const { y } = await readScroll(page);
      expect(y, "the Dashboard must be scrolled for this proof to mean anything")
        .toBeGreaterThan(0);
      // Default period, before any pill has been touched.
      await expect(pill("This week")).toHaveAttribute("aria-current", "page");
    });

    const journey = [
      { step: 17, label: "Today", period: "today", periodLabel: "today" },
      { step: 18, label: "This month", period: "month", periodLabel: "this month" },
      { step: 19, label: "This week", period: "week", periodLabel: "this week" },
    ] as const;

    for (const leg of journey) {
      await test.step(`${leg.step}. "${leg.label}" re-cuts the numbers in place`, async () => {
        const before = await readScroll(page);
        const beforeTop = (await snapshot.boundingBox())!.y;
        await armScrollFloor(page);

        await pill(leg.label).click();

        // 1. the period URL is the expected one, and the DAY survived it.
        await landsOn(page, { day, period: leg.period });
        // 2. the snapshot itself re-rendered for the new period: the server
        //    metrics card is relabelled and the selected pill moved.
        await expect(appointmentsCard(leg.periodLabel)).toBeVisible({ timeout: T });
        await expect(pill(leg.label)).toHaveAttribute("aria-current", "page");
        for (const other of ["Today", "This week", "This month"]) {
          if (other === leg.label) continue;
          await expect(pill(other)).not.toHaveAttribute("aria-current", "page");
        }
        // 3. the heading is still on screen — the roster did not come back.
        await expect(heading(page, "Tomorrow")).toBeVisible();

        const after = await readScroll(page);
        const afterTop = (await snapshot.boundingBox())!.y;

        // 4. the viewport did not jump to the top, at any point.
        expect(after.y, "still scrolled after the period change").toBeGreaterThan(0);
        expect(
          after.floor,
          "the page must never REACH the top, even transiently",
        ).toBeGreaterThan(0);
        expect(
          Math.abs(after.y - before.y),
          "scroll offset before vs after",
        ).toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);
        // 5. and the snapshot is materially where it was on screen. Nothing
        //    above it changes with the period, so its viewport-relative top is
        //    the honest measure of "did the page move under the reader".
        expect(
          Math.abs(afterTop - beforeTop),
          "snapshot heading's viewport position before vs after",
        ).toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);
      });
    }

    await test.step("20. browser Back restores the PREVIOUS period, day intact", async () => {
      await page.goBack();
      await landsOn(page, { day, period: "month" });
      await expect(appointmentsCard("this month")).toBeVisible({ timeout: T });
      await expect(pill("This month")).toHaveAttribute("aria-current", "page");
      await expect(heading(page, "Tomorrow")).toBeVisible();
    });

    await test.step("21. Forward returns to the period Back left", async () => {
      await page.goForward();
      await landsOn(page, { day, period: "week" });
      await expect(pill("This week")).toHaveAttribute("aria-current", "page");
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

    await test.step("17. TOMORROW makes no RELATIONSHIP claim — but does carry preparation", async () => {
      await page.getByTestId("dashboard-next-day").click();
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
      const tomorrowRow = row(page, "Memory Client");
      await expect(tomorrowRow).toBeVisible();

      // SUPERSEDED BY PRODUCTION FEEDBACK. This step used to assert that the
      // ENTIRE preparation block was absent off Today. That was the V1 truth
      // rule applied too widely: it also removed the clinical preparation a
      // practitioner opens a future day to read, and she reported the result
      // as "no pinned notes or anything else I usually see".
      //
      // What survives is the part that was actually load-bearing: the page
      // still asks no new-vs-returning question off Today, so it still states
      // no answer in either direction. The Before-Today history model does not
      // run, and none of its vocabulary appears.
      await expect(tomorrowRow.getByText("Before today", { exact: true })).toHaveCount(0);
      await expect(tomorrowRow.getByText("New client · No charted history yet")).toHaveCount(0);
      await expect(tomorrowRow.getByText(/^Latest setup:/)).toHaveCount(0);
      await expect(tomorrowRow.getByTestId("missing-record-chip")).toHaveCount(0);
      await expect(page.getByText("History unavailable")).toHaveCount(0);
      await expect(page.getByText("New client · No charted history yet")).toHaveCount(0);

      // …and what is NOW expected: appointment-bounded preparation from the
      // prep-memory authority, which is a different loader with a three-state
      // contract and no clock in it.
      await expect(tomorrowRow.getByTestId("dashboard-memory-compact")).toBeVisible();
      await expect(tomorrowRow.getByTestId("dashboard-prep-remember")).toContainText(
        "Lower the energy one step",
      );
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

      // SUPERSEDED. The "Today" control used to be omitted on today, on the
      // reasoning that a control which cannot do anything is noise. In
      // practice its absence changed the group's width between days and moved
      // "Next →" out from under a thumb that was tapping it repeatedly — so a
      // two-tap "forward, forward" landed on "Today" and threw the
      // practitioner back. It is now always present, inert on today, which is
      // the same reasoning already applied to the disabled horizon controls.
      await expect(page.getByTestId("dashboard-today")).toBeVisible();

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

// ===========================================================================
// Leaving for the Calendar must keep the day you were looking at.
// ===========================================================================
//
// Both Dashboard exits used to target bare `/calendar`, which was right while
// the briefing was Today-only. Once it can show another day, a bare link
// silently drops the context: the Calendar anchors its week from `?day=` and
// falls back to today's week without it. Stepping to a date and pressing the
// obvious "book" button landed somewhere else entirely.

test.describe("Dashboard → Calendar keeps the selected day", () => {
  test("View calendar and Book appointment both carry the day, across a week boundary", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);
    await seedOn(seed, "Anchor Person", 90);
    await loginAsOwner(page, seed);

    const tomorrow = localDay(tz, 1);
    const today = localDay(tz, 0);
    // Ten days out is guaranteed to be a different week, so a bare
    // `/calendar` would visibly load the wrong one.
    const distant = localDay(tz, 10);

    await test.step("A. tomorrow → View calendar lands on tomorrow's week", async () => {
      // Tomorrow has no appointments, so the empty state — and its calendar
      // link — is what renders.
      await page.goto(`/dashboard?day=${tomorrow}`);
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
      await page.getByRole("link", { name: "View calendar" }).click();
      await page.waitForURL(
        (u) => u.pathname === "/calendar" && u.searchParams.get("day") === tomorrow,
        { timeout: T },
      );
      await expect(
        page.locator(`[data-testid="week-day-column"][data-date="${tomorrow}"]`),
      ).toHaveCount(1);
    });

    await test.step("B. tomorrow → Book appointment carries the same day", async () => {
      await page.goto(`/dashboard?day=${tomorrow}`);
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
      await page.getByRole("link", { name: "Book appointment" }).click();
      await page.waitForURL(
        (u) => u.pathname === "/calendar" && u.searchParams.get("day") === tomorrow,
        { timeout: T },
      );
      await expect(
        page.locator(`[data-testid="week-day-column"][data-date="${tomorrow}"]`),
      ).toHaveCount(1);
    });

    await test.step("C. a DISTANT day loads that week, not today's", async () => {
      await page.goto(`/dashboard?day=${distant}`);
      await page.getByRole("link", { name: "Book appointment" }).click();
      await page.waitForURL(
        (u) => u.pathname === "/calendar" && u.searchParams.get("day") === distant,
        { timeout: T },
      );
      // The week CONTAINING the selected day is loaded…
      await expect(
        page.locator(`[data-testid="week-day-column"][data-date="${distant}"]`),
      ).toHaveCount(1);
      // …and today is NOT in it, which is what a bare /calendar would have shown.
      await expect(
        page.locator(`[data-testid="week-day-column"][data-date="${today}"]`),
      ).toHaveCount(0);
    });

    await test.step("D. on actual today the URL stays canonical", async () => {
      await page.goto("/dashboard");
      await expect(heading(page, "Today")).toBeVisible({ timeout: T });
      await page.getByRole("link", { name: "Book appointment" }).click();
      await page.waitForURL((u) => u.pathname === "/calendar", { timeout: T });
      // No redundant `day` pinned on the ordinary path.
      expect(new URL(page.url()).searchParams.get("day")).toBeNull();
      await expect(
        page.locator(`[data-testid="week-day-column"][data-date="${today}"]`),
      ).toHaveCount(1);
    });

    await test.step("E. a malformed Dashboard day never reaches the Calendar URL", async () => {
      // It resolves to actual today on the Dashboard, so the link is plain
      // `/calendar` — the malformed text is not forwarded.
      await page.goto("/dashboard?day=2026-02-31");
      await expect(heading(page, "Today")).toBeVisible({ timeout: T });
      await page.getByRole("link", { name: "Book appointment" }).click();
      await page.waitForURL((u) => u.pathname === "/calendar", { timeout: T });
      expect(page.url()).not.toContain("2026-02-31");
      expect(new URL(page.url()).searchParams.get("day")).toBeNull();
    });
  });
});

test.describe("Dashboard → Calendar on a 390px phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the mobile day view opens on the day the Dashboard was showing", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);
    await seedOn(seed, "Phone Anchor", 90);
    await loginAsOwner(page, seed);
    const tomorrow = localDay(tz, 1);

    await test.step("F. tomorrow → calendar selects tomorrow, not today", async () => {
      await page.goto(`/dashboard?day=${tomorrow}`);
      await expect(heading(page, "Tomorrow")).toBeVisible({ timeout: T });
      await page.getByRole("link", { name: "Book appointment" }).tap();
      await page.waitForURL(
        (u) => u.pathname === "/calendar" && u.searchParams.get("day") === tomorrow,
        { timeout: T },
      );
      // The mobile strip marks its selection; the label carries "Today, " only
      // for the actual current day, so this proves it did not fall back.
      const selected = page.locator('[data-selected="true"]').first();
      await expect(selected).toBeVisible({ timeout: T });
      const label = await selected.getAttribute("aria-label");
      expect(label, "selected pill label").not.toMatch(/^Today,/);
      const dayNumber = String(Number(tomorrow.slice(8, 10)));
      expect(label).toContain(dayNumber);
    });
  });
});
