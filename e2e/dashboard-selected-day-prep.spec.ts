import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  getStudioTimezone,
  seedE2eActiveCardOnFile,
  seedE2eCardOnFileCapability,
  seedE2eDashboardClient,
  seedE2eDashboardMemoryClient,
  seedE2eNoteOnlyVisit,
  seedE2eFullDetailSentinels,
  sql,
  seedE2eIntake,
  seedE2eStudio,
  seedE2eTodayAppointment,
  seedPinnedNote,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Chloe, on production, after day navigation shipped:
//
//   "It looks wonky. No pinned notes or anything else I usually see."
//
// She had opened a FUTURE day to prepare for it. The briefing suppressed the
// whole preparation layer off Today, so the row collapsed to name / card /
// intake / actions — technically truthful and practically useless.
//
// This spec reproduces that day and asserts the preparation is back, WITHOUT
// the relationship claims that off-Today must never make.

const T = 30_000;

function localDay(tz: string, offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function row(page: Page, name: string): Locator {
  return page.locator("li").filter({ hasText: name }).first();
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

// Three days out — far enough that the heading is a bare date, which is the
// case that rendered the same string twice.
const OFFSET = 3;

test.describe("preparing a future day", () => {
  test("a returning client three days out shows real preparation, and no relationship claim", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);
    await seedE2eCardOnFileCapability(seed);

    // A. the returning treatment client — card, pin, prior treatment, plan note.
    const { clientId } = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: "Avoid the jawline",
      nextVisitNote: "Lower the energy one step",
    });
    await seedE2eActiveCardOnFile(seed, clientId);
    await seedPinnedNote(seed.studioId, clientId, "Prefers the 2pm slot");
    await seedE2eTodayAppointment(seed, {
      clientId,
      startsMinutesFromNow: OFFSET * 24 * 60 + 60,
      endsMinutesFromNow: OFFSET * 24 * 60 + 105,
    });

    // B. the new consultation client — no card, intake awaiting review.
    const newClient = await seedOn(seed, "Fresh Consult", OFFSET * 24 * 60 + 180);
    await seedE2eIntake(seed.studioId, newClient.clientId, "submitted");

    await loginAsOwner(page, seed);
    await page.goto(`/dashboard?day=${localDay(tz, OFFSET)}`);

    await test.step("1. the date is printed ONCE", async () => {
      // The screenshot showed "Sunday, August 23" stacked over itself.
      const label = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "long",
        month: "long",
        day: "numeric",
      }).format(new Date(Date.now() + OFFSET * 86_400_000));
      await expect(
        page.getByRole("heading", { level: 2, name: label, exact: true }),
      ).toBeVisible({ timeout: T });
      await expect(page.getByText(label, { exact: true })).toHaveCount(1);
    });

    const returning = row(page, "Memory Client");

    await test.step("2. the PINNED note is there — it always was", async () => {
      await expect(returning.getByText("Prefers the 2pm slot")).toBeVisible({
        timeout: T,
      });
    });

    await test.step("3. the previous treatment is back", async () => {
      await expect(returning.getByTestId("dashboard-memory-compact")).toBeVisible();
      await expect(returning.getByTestId("dashboard-memory-toggle")).toBeVisible();
    });

    await test.step("4. the plan note reaches her as Remember", async () => {
      await expect(
        returning.getByText(/Remember: Lower the energy one step/),
      ).toBeVisible();
    });

    await test.step("5. the full treatment expands WITHOUT leaving the Dashboard", async () => {
      await returning.getByTestId("dashboard-memory-toggle").click();
      await expect(returning.getByTestId("dashboard-memory-full")).toBeVisible({
        timeout: T,
      });
      expect(new URL(page.url()).pathname).toBe("/dashboard");
    });

    await test.step("6. #598 survives — card status and the actions", async () => {
      await expect(
        returning.locator('[data-card-status="card_on_file"]'),
      ).toBeVisible();
      await expect(
        row(page, newClient.name).locator('[data-card-status="no_card"]'),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: /consultation notes/i }).first()).toBeVisible();
      await expect(page.getByRole("link", { name: /review intake/i }).first()).toBeVisible();
    });

    await test.step("7. NO relationship claim is made on either row", async () => {
      // The rule that survives from V1: off Today the page does not ask
      // new-vs-returning, so it must not answer it — in either direction, and
      // for either client.
      await expect(page.getByText("New client · No charted history yet")).toHaveCount(0);
      await expect(page.getByText("Returning client")).toHaveCount(0);
      await expect(page.getByText("Before today", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Review Before Today")).toHaveCount(0);
    });

    await test.step("8. the genuinely new client gets no fabricated history", async () => {
      const fresh = row(page, newClient.name);
      await expect(fresh.getByTestId("dashboard-memory-compact")).toHaveCount(0);
      await expect(fresh.getByTestId("dashboard-memory-unavailable")).toHaveCount(0);
      await expect(fresh.getByText(/^Remember:/)).toHaveCount(0);
    });
  });

  test("TODAY is unchanged — the full briefing is still there", async ({ page }) => {
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: "Avoid the jawline",
      nextVisitNote: "Lower the energy one step",
    });
    await seedPinnedNote(seed.studioId, clientId, "Prefers the 2pm slot");
    await loginAsOwner(page, seed);

    await test.step("9. Today still shows Before today, Remember, Caution and the memory", async () => {
      await page.goto("/dashboard");
      await expect(
        page.getByRole("heading", { level: 2, name: "Today", exact: true }),
      ).toBeVisible({ timeout: T });
      const today = row(page, "Memory Client");
      await expect(today.getByText("Before today", { exact: true })).toBeVisible();
      await expect(today.getByText("Remember: Lower the energy one step")).toBeVisible();
      await expect(today.getByText("Avoid the jawline")).toBeVisible();
      await expect(today.getByText("Prefers the 2pm slot")).toBeVisible();
      await expect(today.getByTestId("dashboard-memory-compact")).toBeVisible();
      await expect(page.getByText("Review Before Today").first()).toBeVisible();
    });

    await test.step("10. the plan note is NOT printed twice on Today", async () => {
      // It is the same field as the Before-Today "Remember" line; printing it
      // under two labels is a bug this row has had once already.
      // ONE shared renderer: the note is the row's Remember line, printed
      // exactly once. The #607 second element that could have duplicated it
      // is gone.
      const today = row(page, "Memory Client");
      await expect(today.getByText(/^Remember: Lower the energy one step/)).toHaveCount(1);
    });

    await test.step("11. the heading and its sub-line differ on Today", async () => {
      await expect(
        page.getByRole("heading", { level: 2, name: "Today", exact: true }),
      ).toBeVisible();
      await expect(page.getByText(/^\w+day, \w+ \d+$/).first()).toBeVisible();
    });
  });
});

test.describe("preparing a future day — 390px phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the day control is one compact group and nothing overflows", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);
    const { clientId } = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: null,
      nextVisitNote: "Lower the energy one step",
    });
    await seedPinnedNote(seed.studioId, clientId, "Prefers the 2pm slot");
    await seedE2eTodayAppointment(seed, {
      clientId,
      startsMinutesFromNow: OFFSET * 24 * 60 + 60,
      endsMinutesFromNow: OFFSET * 24 * 60 + 105,
    });
    await loginAsOwner(page, seed);

    await test.step("12. all three segments are present on EVERY day", async () => {
      // Including today: the middle segment used to be omitted there, which
      // moved "Next →" ~66px under a thumb that was tapping it repeatedly.
      await page.goto("/dashboard");
      for (const id of ["dashboard-prev-day", "dashboard-today", "dashboard-next-day"]) {
        await expect(page.getByTestId(id), id).toBeVisible({ timeout: T });
      }
      const onToday = await page.getByTestId("dashboard-next-day").boundingBox();

      await page.goto(`/dashboard?day=${localDay(tz, OFFSET)}`);
      for (const id of ["dashboard-prev-day", "dashboard-today", "dashboard-next-day"]) {
        await expect(page.getByTestId(id), id).toBeVisible({ timeout: T });
      }
      const onOther = await page.getByTestId("dashboard-next-day").boundingBox();
      // The arrow does not move between days.
      expect(Math.abs(onOther!.x - onToday!.x), "Next → shifted between days").toBeLessThan(2);
    });

    await test.step("13. every control still clears 44px and fits", async () => {
      for (const id of ["dashboard-prev-day", "dashboard-today", "dashboard-next-day"]) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box!.height, `${id} height`).toBeGreaterThanOrEqual(44);
        expect(box!.x, `${id} left`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${id} right`).toBeLessThanOrEqual(390);
      }
    });

    await test.step("14. EVERY actionable control on the row is a real touch target", async () => {
      // Measured, not asserted from class names: the rendered hit box is the
      // thing a thumb has to find. The disclosure toggle was omitted from this
      // loop once already, and shipped at the height of its own 11px text
      // while every control around it was 44px.
      const primary = page.getByRole("link", { name: "Open client" }).first();
      await expect(primary).toBeVisible();
      const primaryBox = await primary.boundingBox();
      expect(primaryBox!.height, "primary action height").toBeGreaterThanOrEqual(44);

      const toggle = page.getByTestId("dashboard-memory-toggle").first();
      await expect(toggle).toBeVisible();
      const toggleBox = await toggle.boundingBox();
      expect(toggleBox!.height, "disclosure toggle height").toBeGreaterThanOrEqual(44);
      expect(toggleBox!.x, "disclosure toggle left").toBeGreaterThanOrEqual(0);
      expect(
        toggleBox!.x + toggleBox!.width,
        "disclosure toggle right",
      ).toBeLessThanOrEqual(390);
      // The type stays small and quiet — the BOX grew, not the typography.
      const fontSize = await toggle.evaluate(
        (el) => getComputedStyle(el).fontSize,
      );
      expect(fontSize, "toggle typography should stay quiet").toBe("11px");
    });

    await test.step("14b. and it still opens and closes under a thumb", async () => {
      const toggle = page.getByTestId("dashboard-memory-toggle").first();
      await toggle.tap();
      await expect(page.getByTestId("dashboard-memory-full").first()).toBeVisible({
        timeout: T,
      });
      await toggle.tap();
      await expect(page.getByTestId("dashboard-memory-full")).toHaveCount(0);
    });

    await test.step("15. no horizontal overflow at 390px", async () => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(0);
    });

    await test.step("16. the prep the practitioner came for is on screen", async () => {
      await expect(page.getByText("Prefers the 2pm slot")).toBeVisible();
      await expect(page.getByTestId("dashboard-memory-compact")).toBeVisible();
      // One shared prep block now, so the note renders as the row's Remember
      // line on every day rather than through a second off-Today-only element.
      await expect(page.getByText(/Remember: Lower the energy one step/)).toBeVisible();
    });
  });
});

// ===========================================================================
// DATA MINIMISATION — the full clinical record must not reach the browser
// until the practitioner asks for it.
// ===========================================================================
//
// The compact row paints four things. The full model carries the treated areas,
// machine settings, probe LOT NUMBER, tolerance, reaction and numbing notes and
// the practitioner's narrative — for every client on the day. Collapsing that
// in the DOM changes what is RENDERED, not what is TRANSPORTED, so this asserts
// the transport boundary directly, with sentinel values that exist nowhere else.

test.describe("the full treatment is not transported before it is asked for", () => {
  const SENTINELS = {
    probeLot: "SENTINELLOT-77Q",
    reactionNote: "SENTINELREACTION-erythema-noted",
    numbingNote: "SENTINELNUMBING-lidocaine-4pct",
    entryComment: "SENTINELCOMMENT-third-pass-slow",
  };

  test("no full-detail value is in the payload before expansion, and it is after", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);
    const { clientId } = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: "Avoid the jawline",
      nextVisitNote: "Lower the energy one step",
    });
    await seedE2eFullDetailSentinels(seed.studioId, clientId, SENTINELS);
    await seedE2eTodayAppointment(seed, {
      clientId,
      startsMinutesFromNow: OFFSET * 24 * 60 + 60,
      endsMinutesFromNow: OFFSET * 24 * 60 + 105,
    });
    await loginAsOwner(page, seed);

    const url = `/dashboard?day=${localDay(tz, OFFSET)}`;

    await test.step("17. the raw server response carries no full-detail value", async () => {
      // The strongest form of the check: the bytes the server sent, before any
      // script runs. This is where a Client Component prop would appear, in the
      // RSC flight payload inlined into the HTML.
      const res = await page.request.get(url);
      expect(res.status()).toBeLessThan(400);
      const body = await res.text();
      for (const [name, value] of Object.entries(SENTINELS)) {
        expect(body.includes(value), `${name} present in initial response body`).toBe(
          false,
        );
      }
    });

    await test.step("18. …and it is not in the rendered document either", async () => {
      await page.goto(url);
      await expect(page.getByTestId("dashboard-memory-compact")).toBeVisible({
        timeout: T,
      });
      const html = await page.content();
      for (const [name, value] of Object.entries(SENTINELS)) {
        expect(html.includes(value), `${name} present in the DOM before expansion`).toBe(
          false,
        );
      }
    });

    await test.step("19. the compact row still shows what it is meant to", async () => {
      // The point is minimisation, not blindness: the visible projection is
      // still there.
      await expect(page.getByTestId("dashboard-memory-compact")).toContainText(
        "Last treatment:",
      );
      await expect(page.getByText(/Remember: Lower the energy one step/)).toBeVisible();
    });

    await test.step("20. after an EXPLICIT click, the full detail arrives", async () => {
      await page.getByTestId("dashboard-memory-toggle").click();
      await expect(page.getByTestId("dashboard-memory-full")).toBeVisible({
        timeout: T,
      });
      // The two-way half: without it, "never transported" would be satisfied by
      // a disclosure that is simply broken.
      await expect(page.getByTestId("dashboard-memory-full")).toContainText(
        SENTINELS.probeLot,
        { timeout: T },
      );
    });

    await test.step("21. reopening does not refetch", async () => {
      await page.getByTestId("dashboard-memory-toggle").click();
      await expect(page.getByTestId("dashboard-memory-full")).toHaveCount(0);
      let calls = 0;
      page.on("request", (r) => {
        if (r.method() === "POST" && r.url().includes("/dashboard")) calls += 1;
      });
      await page.getByTestId("dashboard-memory-toggle").click();
      await expect(page.getByTestId("dashboard-memory-full")).toContainText(
        SENTINELS.probeLot,
      );
      expect(calls, "the result is cached for the life of the row").toBe(0);
    });
  });

  test("opening one row does not load another row's chart", async ({ page }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);
    const a = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: null,
      nextVisitNote: "Client A plan",
    });
    await seedE2eFullDetailSentinels(seed.studioId, a.clientId, SENTINELS);
    // `seedE2eDashboardMemoryClient` also books its client TODAY at a fixed
    // offset, so calling it twice trips the studio-wide overlap constraint.
    // This test only needs the FUTURE appointments, so release the slot.
    await sql(`delete from public.appointments where studio_id = $1`, [seed.studioId]);
    const b = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: null,
      nextVisitNote: "Client B plan",
    });
    await sql(`delete from public.appointments where studio_id = $1`, [seed.studioId]);
    await seedE2eTodayAppointment(seed, {
      clientId: a.clientId,
      startsMinutesFromNow: OFFSET * 24 * 60 + 60,
      endsMinutesFromNow: OFFSET * 24 * 60 + 105,
    });
    await seedE2eFullDetailSentinels(seed.studioId, b.clientId, {
      probeLot: "SENTINELLOT-OTHER-ROW",
      reactionNote: "SENTINELREACTION-other",
      numbingNote: "SENTINELNUMBING-other",
      entryComment: "SENTINELCOMMENT-other",
    });
    await seedE2eTodayAppointment(seed, {
      clientId: b.clientId,
      startsMinutesFromNow: OFFSET * 24 * 60 + 180,
      endsMinutesFromNow: OFFSET * 24 * 60 + 225,
    });
    await loginAsOwner(page, seed);
    await page.goto(`/dashboard?day=${localDay(tz, OFFSET)}`);

    await test.step("22. expanding the first row leaves the second unloaded", async () => {
      await page.getByTestId("dashboard-memory-toggle").first().click();
      await expect(page.getByTestId("dashboard-memory-full").first()).toContainText(
        SENTINELS.probeLot,
        { timeout: T },
      );
      const html = await page.content();
      expect(
        html.includes("SENTINELLOT-OTHER-ROW"),
        "the unopened row's chart was loaded too",
      ).toBe(false);
    });
  });
});

// ===========================================================================
// FAIL-SOFT — a rejected disclosure must not take the Dashboard with it.
// ===========================================================================
//
// The server action returns its own refusals, so a failure INSIDE the server
// already arrives as `{ status: "unavailable" }`. This covers the other class:
// the browser-side INVOCATION rejecting — dropped connection, undecodable
// response, a deployment-id mismatch on a tab left open across a deploy. The
// action's own try/catch runs on the server and cannot see any of those.
//
// Without containment React re-throws out of the transition and it reaches the
// route error boundary, replacing the whole Dashboard because one OPTIONAL
// per-row read failed.

test.describe("a rejected disclosure fails to its own line", () => {
  test("the Dashboard survives, the row says so, and its neighbour still works", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);

    const a = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: null,
      nextVisitNote: "Row A plan",
    });
    await seedE2eFullDetailSentinels(seed.studioId, a.clientId, {
      probeLot: "SENTINELLOT-ROW-A",
      reactionNote: "SENTINELREACTION-a",
      numbingNote: "SENTINELNUMBING-a",
      entryComment: "SENTINELCOMMENT-a",
    });
    await sql(`delete from public.appointments where studio_id = $1`, [seed.studioId]);
    const b = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: null,
      nextVisitNote: "Row B plan",
    });
    await seedE2eFullDetailSentinels(seed.studioId, b.clientId, {
      probeLot: "SENTINELLOT-ROW-B",
      reactionNote: "SENTINELREACTION-b",
      numbingNote: "SENTINELNUMBING-b",
      entryComment: "SENTINELCOMMENT-b",
    });
    await sql(`delete from public.appointments where studio_id = $1`, [seed.studioId]);
    for (const [clientId, offsetMin] of [
      [a.clientId, OFFSET * 24 * 60 + 60],
      [b.clientId, OFFSET * 24 * 60 + 180],
    ] as const) {
      await seedE2eTodayAppointment(seed, {
        clientId,
        startsMinutesFromNow: offsetMin,
        endsMinutesFromNow: offsetMin + 45,
      });
    }

    await loginAsOwner(page, seed);
    await page.goto(`/dashboard?day=${localDay(tz, OFFSET)}`);
    await expect(page.getByTestId("dashboard-memory-toggle").first()).toBeVisible({
      timeout: T,
    });

    // Break ONLY the server-action invocation. Server Actions POST back to the
    // same route, so aborting the POST reproduces a real transport failure —
    // the action never runs, and the browser-side promise rejects.
    let aborted = 0;
    await page.route("**/dashboard**", async (route) => {
      if (route.request().method() === "POST") {
        aborted += 1;
        return route.abort("failed");
      }
      return route.fallback();
    });

    await test.step("23. the row renders its OWN failure state", async () => {
      await page.getByTestId("dashboard-memory-toggle").first().click();
      await expect(
        page.getByTestId("dashboard-memory-unavailable").first(),
      ).toBeVisible({ timeout: T });
      expect(aborted, "the server action was never reached").toBeGreaterThan(0);
    });

    await test.step("24. the Dashboard did NOT hit the route error boundary", async () => {
      await expect(page.getByText("Something went wrong")).toHaveCount(0);
      // Still the day briefing, still on the same day.
      await expect(page.getByTestId("dashboard-next-day")).toBeVisible();
      expect(new URL(page.url()).searchParams.get("day")).toBe(localDay(tz, OFFSET));
    });

    await test.step("25. nothing else on the row or the page was disturbed", async () => {
      // The compact line, the plan note, and the other row's controls all
      // survive a failure that belongs to one disclosure.
      await expect(page.getByTestId("dashboard-memory-compact").first()).toBeVisible();
      await expect(page.getByText(/^Remember:/).first()).toBeVisible();
      await expect(page.getByTestId("dashboard-memory-toggle")).toHaveCount(2);
    });

    await test.step("26. no clinical sentinel leaked from the failed request", async () => {
      const html = await page.content();
      for (const sentinel of [
        "SENTINELLOT-ROW-A",
        "SENTINELLOT-ROW-B",
        "SENTINELREACTION-a",
        "SENTINELREACTION-b",
      ]) {
        expect(html.includes(sentinel), `${sentinel} present after a failed load`).toBe(
          false,
        );
      }
    });

    await test.step("27. the NEIGHBOURING row is still usable once transport recovers", async () => {
      await page.unroute("**/dashboard**");
      await page.getByTestId("dashboard-memory-toggle").nth(1).click();
      // `.nth(1)`: row A's region is still open showing its failure state, so
      // two disclosure regions are mounted. That is the point — the failure
      // stayed in row A.
      await expect(page.getByTestId("dashboard-memory-full").nth(1)).toContainText(
        "SENTINELLOT-ROW-B",
        { timeout: T },
      );
      // …and row A still shows its own failure, unchanged by B succeeding.
      await expect(
        page.getByTestId("dashboard-memory-unavailable").first(),
      ).toBeVisible();
    });
  });
});

// ===========================================================================
// The plan note is SERVER-rendered, and only where it is visible.
// ===========================================================================

test.describe("the plan note is server-rendered where it is shown", () => {
  // NOTE ON WHAT IS PROVEN WHERE.
  //
  // The decisive proof for the disclosure boundary is the RUNTIME unit test in
  // tests/app/dashboard/today-two-authority-truth.test.ts: `toDisclosureSummary`
  // returns a new object with exactly three keys, so the plan note cannot be on
  // the wire as a disclosure prop regardless of what the type says.
  //
  // A browser proof of the same property is NOT constructible by seeding:
  // Before-Today resolves its "Remember" line from the newest session that
  // recorded a plan note — the same session the prep loader picks — so on Today
  // the note is visible whenever it exists at all. There is no seedable state
  // where it is present but unrendered. Asserting its absence from Today's
  // payload would therefore be asserting something false, and counting
  // occurrences cannot separate the rendered copy from a prop, because Next
  // emits both HTML and an RSC payload for anything rendered.
  //
  // What this covers instead is the visible half of the contract.
  test("off Today the note renders, and nothing else claims it", async ({ page }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);
    const PLAN = "SENTINELPLAN-drop-one-energy-step";
    const { clientId } = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: null,
      nextVisitNote: PLAN,
    });
    await seedE2eTodayAppointment(seed, {
      clientId,
      startsMinutesFromNow: OFFSET * 24 * 60 + 60,
      endsMinutesFromNow: OFFSET * 24 * 60 + 105,
    });
    await loginAsOwner(page, seed);

    await test.step("28. off Today the SERVER paints it, once", async () => {
      await page.goto(`/dashboard?day=${localDay(tz, OFFSET)}`);
      await expect(page.getByText(`Remember: ${PLAN}`)).toBeVisible({ timeout: T });
    });

    await test.step("29. on Today the Before-Today line owns it, not the prep strip", async () => {
      await page.goto("/dashboard");
      await expect(
        page.getByRole("heading", { level: 2, name: "Today", exact: true }),
      ).toBeVisible({ timeout: T });
      // One note, one label. The prep strip does not repeat it.
      await expect(page.getByText(`Remember: ${PLAN}`)).toBeVisible();
    });
  });
});

test.describe("Today never says 'no history' beside a proven treatment", () => {
  test("a client the prep loader proves has history is not called new", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const { clientId } = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: "Avoid the jawline",
      nextVisitNote: "Lower the energy one step",
    });
    await loginAsOwner(page, seed);
    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { level: 2, name: "Today", exact: true }),
    ).toBeVisible({ timeout: T });

    await test.step("30. the two statements never appear together on one row", async () => {
      const row = page.locator("li").filter({ hasText: "Memory Client" }).first();
      const saysNew = await row
        .getByText("New client · No charted history yet")
        .count();
      const showsTreatment = await row
        .getByTestId("dashboard-memory-compact")
        .count();
      // Whatever the two authorities each concluded, the row must never carry
      // both at once.
      expect(
        saysNew === 0 || showsTreatment === 0,
        "row asserted 'New client' beside a proven last treatment",
      ).toBe(true);
    });
  });
});

// ===========================================================================
// THE PARITY TEST — the load-bearing one.
// ===========================================================================
//
// Chloe: "It still looks weird. All the old notes and everything were missing.
// It needs to look the same as today and it's not."
//
// Two appointments for the SAME client with the SAME prior history: one today,
// one three days out. Every preparation fact must appear on both rows. The
// only permitted differences are the temporal label and the Current pill.

test.describe("Today and a future day show the same preparation", () => {
  test("identical history yields identical prep facts on both days", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);

    // Prior history: a plan note, a caution, a recorded setup, a charted
    // treatment, and a MISSING probe lot so a reminder chip is generated.
    const { clientId } = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: "Avoid the jawline",
      nextVisitNote: "Lower the energy one step",
    });
    await seedPinnedNote(seed.studioId, clientId, "Prefers the 2pm slot");
    // The same client also books three days out.
    await seedE2eTodayAppointment(seed, {
      clientId,
      startsMinutesFromNow: OFFSET * 24 * 60 + 60,
      endsMinutesFromNow: OFFSET * 24 * 60 + 105,
    });

    await loginAsOwner(page, seed);

    /** Every preparation fact the row is expected to carry. */
    async function prepFacts(url: string) {
      await page.goto(url);
      const row = page.locator("li").filter({ hasText: "Memory Client" }).first();
      await expect(row).toBeVisible({ timeout: T });
      return {
        pinned: await row.getByText("Prefers the 2pm slot").count(),
        remember: await row.getByText(/Remember: Lower the energy one step/).count(),
        caution: await row.getByText(/Avoid the jawline/).count(),
        setup: await row.getByText(/^Latest setup:/).count(),
        chips: await row.getByTestId("missing-record-chip").count(),
        lastTreatment: await row.getByTestId("dashboard-memory-compact").count(),
        disclosure: await row.getByTestId("dashboard-memory-toggle").count(),
      };
    }

    const today = await prepFacts("/dashboard");
    const future = await prepFacts(`/dashboard?day=${localDay(tz, OFFSET)}`);

    await test.step("31. Today carries the full briefing (the baseline)", async () => {
      expect(today.pinned, "pinned note").toBeGreaterThan(0);
      expect(today.remember, "Remember").toBeGreaterThan(0);
      expect(today.caution, "Caution").toBeGreaterThan(0);
      expect(today.setup, "Latest setup").toBeGreaterThan(0);
      expect(today.chips, "missing-record chip").toBeGreaterThan(0);
      expect(today.lastTreatment, "Last treatment").toBeGreaterThan(0);
      expect(today.disclosure, "View full last treatment").toBeGreaterThan(0);
    });

    await test.step("32. the FUTURE day carries every one of them too", async () => {
      // This is the assertion the owner's complaint reduces to.
      expect(future, "future-day prep must match Today").toEqual(today);
    });

    await test.step("33. only the temporal label differs", async () => {
      // `exact: true` throughout: getByText does case-insensitive SUBSTRING
      // matching, and the unrelated "Charted within 24h" card explains itself
      // using the words "before today".
      await page.goto("/dashboard");
      await expect(
        page.getByText("Before today", { exact: true }).first(),
      ).toBeVisible({ timeout: T });
      await expect(page.getByText("Before this visit", { exact: true })).toHaveCount(0);

      await page.goto(`/dashboard?day=${localDay(tz, OFFSET)}`);
      await expect(
        page.getByText("Before this visit", { exact: true }).first(),
      ).toBeVisible({ timeout: T });
      await expect(page.getByText("Before today", { exact: true })).toHaveCount(0);
    });

    await test.step("34. and the future row still makes no relationship claim", async () => {
      await expect(page.getByText("New client · No charted history yet")).toHaveCount(0);
      await expect(page.getByText("Returning client")).toHaveCount(0);
      await expect(page.getByTestId("today-current-pill")).toHaveCount(0);
    });
  });
});

test.describe("future-day prep at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the future row reads like Today, with no gaps or overflow", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);
    const { clientId } = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: "Avoid the jawline",
      nextVisitNote: "Lower the energy one step",
    });
    await seedPinnedNote(seed.studioId, clientId, "Prefers the 2pm slot");
    await seedE2eTodayAppointment(seed, {
      clientId,
      startsMinutesFromNow: OFFSET * 24 * 60 + 60,
      endsMinutesFromNow: OFFSET * 24 * 60 + 105,
    });
    await loginAsOwner(page, seed);
    await page.goto(`/dashboard?day=${localDay(tz, OFFSET)}`);

    const row = page.locator("li").filter({ hasText: "Memory Client" }).first();
    await expect(row).toBeVisible({ timeout: T });

    await test.step("35. the whole prep block is readable on a phone", async () => {
      await expect(row.getByText("Prefers the 2pm slot")).toBeVisible();
      await expect(row.getByText(/Remember: Lower the energy one step/)).toBeVisible();
      await expect(row.getByText(/Avoid the jawline/)).toBeVisible();
      await expect(row.getByText(/^Latest setup:/)).toBeVisible();
      await expect(row.getByTestId("missing-record-chip").first()).toBeVisible();
      await expect(row.getByTestId("dashboard-memory-compact")).toBeVisible();
    });

    await test.step("36. nothing overflows sideways", async () => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(0);
      // Chips wrap rather than push the row wide.
      for (const chip of await row.getByTestId("missing-record-chip").all()) {
        const box = await chip.boundingBox();
        expect(box!.x + box!.width, "chip right edge").toBeLessThanOrEqual(390);
      }
    });

    await test.step("37. the disclosure is still a real touch target", async () => {
      const toggle = row.getByTestId("dashboard-memory-toggle");
      const box = await toggle.boundingBox();
      expect(box!.height, "disclosure toggle height").toBeGreaterThanOrEqual(44);
      await toggle.tap();
      await expect(row.getByTestId("dashboard-memory-full")).toBeVisible({ timeout: T });
    });
  });
});

// ===========================================================================
// A RECORDED INSTRUCTION SURVIVES WITHOUT CHARTED HISTORY.
// ===========================================================================
//
// "Do we have a recorded instruction to remember?" and "can we prove prior
// charted treatment exists?" are different questions. The first can be YES
// while the second is NO. A visit that charted nothing and recorded only
// "started doxycycline, do not treat" is exactly that shape — and it is the
// case where the note matters most.

test.describe("Remember renders on its own authority", () => {
  const NOTE = "Started doxycycline, do not treat";

  test("a NOTE-ONLY prior visit shows its instruction on Today AND on a future day", async ({
    page,
  }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);
    const client = await seedE2eDashboardClient(seed, { label: "Note Only" });
    await seedE2eNoteOnlyVisit(seed, { clientId: client.clientId, note: NOTE });
    // One appointment today, one three days out.
    await seedE2eTodayAppointment(seed, {
      clientId: client.clientId,
      startsMinutesFromNow: 90,
      endsMinutesFromNow: 135,
    });
    await seedE2eTodayAppointment(seed, {
      clientId: client.clientId,
      startsMinutesFromNow: OFFSET * 24 * 60 + 60,
      endsMinutesFromNow: OFFSET * 24 * 60 + 105,
    });
    await loginAsOwner(page, seed);

    await test.step("38. TODAY shows the instruction", async () => {
      await page.goto("/dashboard");
      const row = page.locator("li").filter({ hasText: client.name }).first();
      await expect(row.getByText(`Remember: ${NOTE}`)).toBeVisible({ timeout: T });
      // …and does not invent a treatment that was never charted.
      await expect(row.getByTestId("dashboard-memory-compact")).toHaveCount(0);
      await expect(row.getByText(/^Latest setup:/)).toHaveCount(0);
    });

    await test.step("39. the FUTURE day shows the SAME instruction", async () => {
      await page.goto(`/dashboard?day=${localDay(tz, OFFSET)}`);
      const row = page.locator("li").filter({ hasText: client.name }).first();
      await expect(row.getByText(`Remember: ${NOTE}`)).toBeVisible({ timeout: T });
      // …and still makes no relationship claim off Today.
      await expect(page.getByText("New client · No charted history yet")).toHaveCount(0);
    });
  });

  test("an ordinary returning client sees Remember EXACTLY once", async ({ page }) => {
    const seed = await seedE2eStudio();
    const tz = await getStudioTimezone(seed.studioId);
    const { clientId } = await seedE2eDashboardMemoryClient(seed, {
      cautionNote: "Avoid the jawline",
      nextVisitNote: "Lower the energy one step",
    });
    await seedE2eTodayAppointment(seed, {
      clientId,
      startsMinutesFromNow: OFFSET * 24 * 60 + 60,
      endsMinutesFromNow: OFFSET * 24 * 60 + 105,
    });
    await loginAsOwner(page, seed);

    for (const [label, url] of [
      ["40. Today", "/dashboard"],
      ["41. future day", `/dashboard?day=${localDay(tz, OFFSET)}`],
    ] as const) {
      await test.step(`${label}: one Remember, and the rest still renders`, async () => {
        await page.goto(url);
        const row = page.locator("li").filter({ hasText: "Memory Client" }).first();
        await expect(row).toBeVisible({ timeout: T });
        // Hoisting the renderer must not leave a second copy behind.
        await expect(
          row.getByText(/^Remember: Lower the energy one step/),
        ).toHaveCount(1);
        await expect(row.getByText(/Avoid the jawline/)).toBeVisible();
        await expect(row.getByText(/^Latest setup:/)).toBeVisible();
        await expect(row.getByTestId("dashboard-memory-compact")).toBeVisible();
      });
    }
  });

  test("a client with NO note gets no fabricated Remember line", async ({ page }) => {
    const seed = await seedE2eStudio();
    const client = await seedE2eDashboardClient(seed, { label: "No Note" });
    await seedE2eTodayAppointment(seed, {
      clientId: client.clientId,
      startsMinutesFromNow: 90,
      endsMinutesFromNow: 135,
    });
    await loginAsOwner(page, seed);

    await test.step("42. nothing recorded, nothing claimed", async () => {
      await page.goto("/dashboard");
      const row = page.locator("li").filter({ hasText: client.name }).first();
      await expect(row).toBeVisible({ timeout: T });
      await expect(row.getByText(/^Remember:/)).toHaveCount(0);
    });
  });
});
