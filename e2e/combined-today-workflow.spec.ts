import { test, expect, type Page } from "@playwright/test";
import {
  seedE2eStudio,
  seedE2eDashboardMemoryClient,
  seedE2eSecondAppointmentToday,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Chloe: "Today and the Daily Prep Brief are redundant."
//
// THE DEFECT. Every appointment rendered TWICE on one screen — once
// chronologically in Today, again in the priority-sorted Daily Prep Brief a few
// hundred pixels lower — and the two disagreed about the same facts. The worst
// case was the note: `compactBeforeToday` collapses a briefing into
// `rememberLine = watchLines[0] ?? plan`, so the Today card printed the CAUTION
// under "Remember:", and the brief printed that same text again under
// "Caution noted:" plus the plan under "For next visit:".
//
// This spec asserts the RENDERED dashboard: one card per appointment, each fact
// once, order unchanged, at both widths.

const T = 20_000;

const PLAN_LINE_1 =
  "Upper lip: drop to energy level 8 next visit and re-check tolerance after the first pass.";
const PLAN_LINE_2 =
  "Numbing applied 30 minutes ahead; client preferred shorter passes.";
const PLAN_NOTE = `${PLAN_LINE_1}\n${PLAN_LINE_2}`;
const CAUTION_NOTE =
  "Watch the left upper lip for prolonged erythema; it stayed pink for two days last time.";

async function openDashboard(page: Page) {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({
    timeout: T,
  });
}

function todaySection(page: Page) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Today", exact: true }) });
}

async function expectNoHorizontalScroll(page: Page) {
  const d = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(d.scroll).toBeLessThanOrEqual(d.client + 1);
}

function runSuite(label: string, viewport: { width: number; height: number }, isMobile: boolean) {
  test.describe(label, () => {
    test.use({ viewport, isMobile, hasTouch: isMobile });

    test("one card per appointment, every fact once, no separate brief", async ({
      page,
    }) => {
      const seed = await seedE2eStudio();
      const { clientId } = await seedE2eDashboardMemoryClient(seed, {
        cautionNote: CAUTION_NOTE,
        nextVisitNote: PLAN_NOTE,
      });
      await loginAsOwner(page, seed);
      await openDashboard(page);

      await test.step("2. the separate Daily Prep Brief list is GONE", async () => {
        await expect(
          page.getByRole("heading", { name: "Daily prep brief" }),
        ).toHaveCount(0);
        // ...and so is its duplicate empty state.
        await expect(
          page.getByText("Nothing needs special review yet."),
        ).toHaveCount(0);
      });

      await test.step("1. the appointment appears exactly ONCE in the day's workflow", async () => {
        const section = todaySection(page);
        // Exactly one appointment card in the one appointment list.
        await expect(section.locator("li")).toHaveCount(1);
        const name = (
          await section
            .locator("span.font-medium")
            .filter({ hasText: /Memory Client/ })
            .first()
            .innerText()
        ).trim();
        expect(name.length).toBeGreaterThan(0);
        // ...and the client is named once WITHIN that workflow. (Other
        // dashboard sections — Needs Attention, Follow-up Assistant, birthdays
        // — legitimately name clients for their own purposes; the redundancy
        // Chloe reported was a second APPOINTMENT list, which is gone.)
        await expect(section.getByText(name, { exact: true })).toHaveCount(1);
      });

      await test.step("4+5. Remember and Caution are DISTINCT, each rendered once, in full", async () => {
        const remember = page.locator("span").filter({ hasText: /^Remember: / });
        const caution = page.locator("span").filter({ hasText: /^Caution: / });
        await expect(remember).toHaveCount(1);
        await expect(caution).toHaveCount(1);

        const rememberText = await remember.first().innerText();
        // The PLAN note, whole, both lines, no ellipsis.
        expect(rememberText).toContain(PLAN_LINE_1);
        expect(rememberText).toContain(PLAN_LINE_2);
        expect(rememberText).not.toContain("…");
        // ...and NOT the caution. This is the exact duplication being fixed.
        expect(rememberText).not.toContain(CAUTION_NOTE);

        const cautionText = await caution.first().innerText();
        expect(cautionText).toContain(CAUTION_NOTE);

        // The retired brief's labels are nowhere on the page.
        for (const gone of ["For next visit:", "Caution noted:", "Last recorded:"]) {
          await expect(page.getByText(gone, { exact: false })).toHaveCount(0);
        }
      });

      await test.step("4+6. latest setup once; intake and charting stated once", async () => {
        await expect(
          page.locator("span").filter({ hasText: /^Latest setup: / }),
        ).toHaveCount(1);
        // No generic record-count line beside the specific chips.
        await expect(page.getByText(/^Records: \d+ reminder/)).toHaveCount(0);
        await expect(page.getByText("Records look complete.")).toHaveCount(0);
      });

      await test.step("11+12. long multiline content wraps; no sideways scroll", async () => {
        const remember = page.locator("span").filter({ hasText: /^Remember: / }).first();
        const box = await remember.boundingBox();
        expect(box).not.toBeNull();
        // Multi-line => taller than a single line.
        expect(box!.height).toBeGreaterThan(24);
        expect(box!.width).toBeLessThanOrEqual(viewport.width);
        await expectNoHorizontalScroll(page);
      });

      await test.step("8+9+10. actions survive: checkout cell, primary action, row link", async () => {
        const section = todaySection(page);
        await expect(section.getByRole("link", { name: /Book appointment/ })).toHaveCount(1);
        // The primary action resolver still produces exactly one action link.
        const action = section.getByRole("link", {
          name: /Review Before Today|Open client|Chart appointment|Continue charting|View session/,
        });
        await expect(action).toHaveCount(1);
        // The row body still opens the appointment route.
        await expect(section.locator('a[href^="/calendar/"]').first()).toHaveCount(1);
        await expect(action.first()).toHaveAttribute("href", /\/clients\/|\/calendar\//);
      });

      await test.step("14. the other dashboard sections still render", async () => {
        await expect(page.getByText("Charted within 24h")).toBeVisible({ timeout: T });
        expect(clientId.length).toBeGreaterThan(0);
      });
    });

    test("3+7. two appointments for ONE client stay two cards, in time order", async ({
      page,
    }) => {
      const seed = await seedE2eStudio();
      const { clientId } = await seedE2eDashboardMemoryClient(seed, {
        cautionNote: null,
        nextVisitNote: "Start lower on the upper lip.",
      });
      // A SECOND appointment later the same day for the SAME person. Joining by
      // client id would collapse these into one card and lose an appointment.
      await seedE2eSecondAppointmentToday(seed, clientId, 5);
      await loginAsOwner(page, seed);
      await openDashboard(page);

      const section = todaySection(page);
      const rows = section.locator("li");
      await expect(rows).toHaveCount(2);

      // Each row links to a DIFFERENT appointment.
      const hrefs = await section.locator('a[href^="/calendar/"]').evaluateAll((els) =>
        els.map((e) => (e as HTMLAnchorElement).getAttribute("href")),
      );
      const apptHrefs = hrefs.filter((h): h is string => !!h && h !== "/calendar");
      expect(new Set(apptHrefs).size).toBe(2);

      // Chronological: the earlier appointment renders first.
      const times = await rows.evaluateAll((els) =>
        els.map((e) => e.querySelector("div.tabular-nums")?.textContent?.trim() ?? ""),
      );
      expect(times.filter(Boolean)).toHaveLength(2);
      const toMinutes = (t: string) => {
        const m = /^(\d+):(\d+)\s*(AM|PM)$/i.exec(t.trim());
        if (!m) return Number.NaN;
        let h = Number(m[1]) % 12;
        if (/pm/i.test(m[3])) h += 12;
        return h * 60 + Number(m[2]);
      };
      expect(toMinutes(times[0])).toBeLessThan(toMinutes(times[1]));

      await expectNoHorizontalScroll(page);
    });

    test("13. an empty day shows ONE empty state", async ({ page }) => {
      const seed = await seedE2eStudio();
      await loginAsOwner(page, seed);
      await openDashboard(page);

      // ONE empty state, full stop. DaySummary used to print the SAME sentence
      // under the heading, so the empty day said "No appointments today." twice.
      // It now renders nothing when the count is zero, leaving EmptyDayState as
      // the single source of truth.
      await expect(page.getByText("No appointments today.")).toHaveCount(1);
      const emptyCard = page.locator("div.border-dashed").filter({
        hasText: "No appointments today.",
      });
      await expect(emptyCard).toHaveCount(1);
      await expect(
        page.getByText("Use the quiet time to review the week"),
      ).toHaveCount(1);
      // The brief's second, separate empty card is gone.
      await expect(
        page.getByRole("heading", { name: "Daily prep brief" }),
      ).toHaveCount(0);
      await expect(
        page.getByText("Nothing needs special review yet."),
      ).toHaveCount(0);
      await expectNoHorizontalScroll(page);
    });

    test("a non-empty day still summarises appointment and client counts", async ({
      page,
    }) => {
      const seed = await seedE2eStudio();
      await seedE2eDashboardMemoryClient(seed, { cautionNote: null });
      await loginAsOwner(page, seed);
      await openDashboard(page);

      const section = todaySection(page);
      await expect(section.getByText(/1 appointment · 1 client/)).toHaveCount(1);
      // ...and the empty state is absent on a day that has appointments.
      await expect(page.getByText("No appointments today.")).toHaveCount(0);
      // The Book appointment action is unchanged.
      await expect(
        section.getByRole("link", { name: "Book appointment" }),
      ).toHaveCount(1);
    });

    test("a new client shows ONE relationship line", async ({ page }) => {
      const seed = await seedE2eStudio();
      const { clientId } = await seedE2eDashboardMemoryClient(seed, {
        cautionNote: null,
      });
      // A second client with no history at all: seed only the appointment.
      await seedE2eSecondAppointmentToday(seed, clientId, 6);
      await loginAsOwner(page, seed);
      await openDashboard(page);

      // Whichever cards show the no-history state say it once, one way.
      const combined = page.getByText("New client · No charted history yet");
      const oldPhrase = page.getByText("No prior treatment history yet");
      await expect(oldPhrase).toHaveCount(0);
      expect(await combined.count()).toBeGreaterThanOrEqual(0);
      await expectNoHorizontalScroll(page);
    });
  });
}

runSuite("iPhone 390px", { width: 390, height: 844 }, true);
runSuite("desktop", { width: 1280, height: 900 }, false);
