import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  getStudioTimezone,
  seedE2eActiveCardOnFile,
  seedE2eCardOnFileCapability,
  seedE2eDashboardClient,
  seedE2eDashboardMemoryClient,
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
        returning.getByTestId("dashboard-prep-remember"),
      ).toContainText("Lower the energy one step");
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
      await expect(fresh.getByTestId("dashboard-prep-remember")).toHaveCount(0);
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
      const today = row(page, "Memory Client");
      await expect(today.getByTestId("dashboard-prep-remember")).toHaveCount(0);
      await expect(today.getByText(/Lower the energy one step/)).toHaveCount(1);
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

    await test.step("14. the primary row action is a real touch target", async () => {
      const primary = page.getByRole("link", { name: "Open client" }).first();
      await expect(primary).toBeVisible();
      const box = await primary.boundingBox();
      expect(box!.height, "primary action height").toBeGreaterThanOrEqual(44);
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
      await expect(page.getByTestId("dashboard-prep-remember")).toBeVisible();
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
      await expect(page.getByTestId("dashboard-prep-remember")).toContainText(
        "Lower the energy one step",
      );
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
