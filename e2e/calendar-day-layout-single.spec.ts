import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type CDPSession, type Locator, type Page } from "@playwright/test";
import {
  getE2eServiceId, getOwnerPractitionerId, seedE2eClient, seedE2eMember, seedE2eStudio, seedPractitionerDefault,
  seedServiceEligibility, setPractitionerActive, setStudioCapacityBookingEnabled, setStudioCapacityEnabled, setStudioTimezone, sql, type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// Opt-in: ~11 min of serial browser time (35 cases, own studios). OPS decides whether a CI lane runs it; locally set CAL_LAYOUT_E2E=1.
test.skip(process.env.CAL_LAYOUT_E2E !== "1", "opt-in HON-48 day-layout matrix; set CAL_LAYOUT_E2E=1");

// HON-48 team day view, path (b): studios where /calendar?view=day does NOT render the team grid at all.
// isTeamCalendar(capacity, activePractitioners) is capacity ON and MORE THAN ONE ACTIVE practitioner; otherwise page.tsx redirects
// to /calendar?day=<date>, which is the WEEK surface on desktop (week-day-column grid) and CalendarMobileDayView on a phone, each with its
// own scroll container. This spec RECORDS which URL and component render (console line CAL_PATH_B) and ASSERTS what a person needs:
// slot lines exist, the container really scrolls by wheel / touch, a later time becomes visible, and a slot there opens the booking drawer.
// Studios: B1 one active practitioner, capacity ON; B2 one active practitioner, capacity OFF; B3 capacity ON, three created, two deactivated
// (the only way the UI can narrow the active set to one: the toolbar has no practitioner selector). Synthetic data only.

const TZ = "America/Los_Angeles";
const GRID_START_HOUR = 6;
const SHOTS = process.env.CAL_SHOTS_DIR ?? "test-results/cal-shots";
const PHASE = process.env.CAL_PHASE ?? "run";
const VPS = {
  desktop: { viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false, target: "16:00", rx: /^(4\s?PM|16:00)$/i },
  mobile: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, target: "17:00", rx: /^(5\s?PM|17:00)$/i },
} as const;
const KINDS = { B1: { capacity: true, extra: 0 }, B2: { capacity: false, extra: 0 }, B3: { capacity: true, extra: 2 } } as const;
type Kind = keyof typeof KINDS;

type S = { seed: E2eSeed; day: string; ownerId: string; serviceId: string };
const cache = new Map<Kind, Promise<S>>();
function getStudio(kind: Kind): Promise<S> {
  if (!cache.has(kind)) cache.set(kind, (async () => {
    const k = KINDS[kind];
    const seed = await seedE2eStudio();
    await setStudioTimezone(seed.studioId, TZ);
    // availability can only be seeded while capacity is ON; capacity OFF studios are switched off afterwards
    await setStudioCapacityEnabled(seed.studioId, true);
    await setStudioCapacityBookingEnabled(seed.studioId, true);
    const [d] = await sql<{ day: string; dow: number }>(
      "select ((now() at time zone $1)::date+7)::text as day, extract(dow from ((now() at time zone $1)::date+7))::int as dow", [TZ]);
    const ownerId = await getOwnerPractitionerId(seed.studioId);
    const serviceId = await getE2eServiceId(seed.studioId);
    await seedPractitionerDefault(seed.studioId, ownerId, d.dow, true, "08:00", "20:00");
    await seedServiceEligibility(seed.studioId, serviceId, ownerId);
    for (let i = 0; i < k.extra; i++) { const m = await seedE2eMember(seed); await setPractitionerActive(m.practitionerId, false); }
    if (!k.capacity) { await setStudioCapacityBookingEnabled(seed.studioId, false); await setStudioCapacityEnabled(seed.studioId, false); }
    return { seed, day: d.day, ownerId, serviceId };
  })());
  return cache.get(kind)!;
}

async function shot(page: Page, vp: string, kind: string, state: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${PHASE}-${vp}-single-${kind}-${state}.png`) });
}

// Mark and describe the nearest ancestor that really scrolls vertically, else the window.
async function scroller(page: Page, from: Locator): Promise<"element" | "window"> {
  return from.evaluate((el) => {
    let n: HTMLElement | null = el as HTMLElement;
    while (n && n !== document.body) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) { n.setAttribute("data-cal-scroller", "1"); return "element" as const; }
      n = n.parentElement;
    }
    return "window" as const;
  });
}
// the person scrolled if EITHER the marked box or the page moved (a phone scrolls the page, a desktop the grid's own box)
const pos = (page: Page, _kind: "element" | "window") =>
  page.evaluate(() => (document.querySelector("[data-cal-scroller]")?.scrollTop ?? 0) + window.scrollY);

async function scrollBy(page: Page, hasTouch: boolean, at: { x: number; y: number }, px: number): Promise<void> {
  if (hasTouch) {
    const cdp: CDPSession = await page.context().newCDPSession(page);
    const h = page.viewportSize()!.height;
    let left = px;
    while (left > 0) {
      const d = Math.min(left, Math.floor(h * 0.5)), y0 = Math.min(at.y + d / 2, h - 30);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: Math.round(at.x), y: Math.round(y0), id: 1 }] });
      for (let i = 1; i <= Math.ceil(d / 25); i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(at.x), y: Math.round(y0 - Math.min(d, i * 25)), id: 1 }] });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      left -= d; await page.waitForTimeout(150);
    }
    await cdp.detach();
  } else {
    await page.mouse.move(at.x, at.y);
    for (let d = 0; d < px; d += 100) await page.mouse.wheel(0, Math.min(100, px - d));
  }
  await page.waitForTimeout(300);
}

for (const vpName of ["desktop", "mobile"] as const) {
  const vp = VPS[vpName];
  for (const kind of ["B1", "B2", "B3"] as Kind[]) {
    test.describe(`single-path ${vpName} / ${kind}`, () => {
      test.use({ viewport: vp.viewport, hasTouch: vp.hasTouch, isMobile: vp.isMobile });
      test.setTimeout(240_000);

      test(`${kind}: where ?view=day lands, that the grid has slot lines, that it scrolls, and that a later time can be booked`, async ({ page }) => {
        const s = await getStudio(kind);
        await loginAsOwner(page, s.seed);
        await page.goto(`/calendar?view=day&day=${s.day}`);
        await page.waitForLoadState("networkidle");
        const url = new URL(page.url());
        const present = {
          teamDayView: await page.getByTestId("team-day-view").count(),
          weekDayColumns: await page.getByTestId("week-day-column").count(),
          mobileTimeline: await page.getByTestId("mobile-day-timeline").count(),
        };
        const surface = present.teamDayView ? "team-day-view" : present.weekDayColumns && vpName === "desktop" ? "week grid" : present.mobileTimeline ? "mobile day timeline" : "unknown";
        await shot(page, vpName, kind, "landed");

        // the surface that must exist: slot lines for the day being looked at
        const dayCol = page.locator(`[data-testid="week-day-column"][data-date="${s.day}"], [data-testid="team-day-column"]`).first();
        const timeline = page.getByTestId("mobile-day-timeline");
        const gridHost = vpName === "mobile" && !present.teamDayView ? timeline : dayCol;
        await expect(gridHost, `a calendar grid is shown at ${url.pathname}${url.search}`).toBeVisible({ timeout: 30_000 });
        const lineCount = await gridHost.locator("div.absolute.inset-x-0.border-b, [data-slot-line], [data-hour-line]").count();
        const kindOfScroller = await scroller(page, gridHost);
        const start = await pos(page, kindOfScroller);
        const vb = vpName === "mobile" && kindOfScroller === "window"
          ? { x: vp.viewport.width / 2, y: vp.viewport.height / 2 }
          : await (kindOfScroller === "element" ? page.locator("[data-cal-scroller]") : gridHost).evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.max(r.left, 0) + Math.min(r.width, innerWidth) / 2, y: Math.max(r.top, 0) + Math.min(r.height, innerHeight) / 2 }; });
        await scrollBy(page, vp.hasTouch, vb, 600);
        const moved = (await pos(page, kindOfScroller)) - start;
        await shot(page, vpName, kind, "scrolled");
        console.log("CAL_PATH_B " + JSON.stringify({ viewport: vpName, studio: kind, finalUrl: url.pathname + url.search, surface, present, slotLines: lineCount, scroller: kindOfScroller, scrolledPx: Math.round(moved) }));

        expect(surface, "which component renders (recorded)").not.toBe("unknown");
        // Sam's requirement: ONE active practitioner is shown the DAY view with one compact column, not redirected to the week grid
        expect(surface, `one active practitioner gets the Day view (landed on ${url.pathname}${url.search} as a ${surface})`).toBe("team-day-view");
        expect(await page.getByTestId("team-day-view").getAttribute("data-column-count"), "one column").toBe("1");
        expect(lineCount, "the grid draws its slot lines").toBeGreaterThan(0);
        expect(moved, `${vp.hasTouch ? "touch" : "wheel"} scrolling moves the ${kindOfScroller}`).toBeGreaterThan(100);
        await expect(page.getByText(vp.rx).locator("visible=true").first(), `the ${vp.target} time label becomes visible`).toBeInViewport();

        // a slot there opens the booking drawer for this day
        if (vpName === "desktop") {
          const col = present.teamDayView ? page.getByTestId("team-day-column").first() : page.locator(`[data-testid="week-day-column"][data-date="${s.day}"]`);
          const btn = col.getByRole("button", { name: /Open quick-book draft for/ });
          const cb = (await col.boundingBox())!;
          const y = cb.y + (Number(vp.target.slice(0, 2)) - GRID_START_HOUR) * 60 + 6;
          expect(y > 0 && y < vp.viewport.height, "the 16:00 slot is on screen after the scroll").toBe(true);
          await page.mouse.click(cb.x + cb.width / 2, y);
          void btn;
        } else {
          if (present.teamDayView) {
            const plus = page.getByTestId("team-day-column").first().getByRole("button", { name: /^Book .* on \d{4}-\d{2}-\d{2}$/ });
            await plus.scrollIntoViewIfNeeded();
            await plus.tap();
          } else await page.getByRole("button", { name: "Add appointment or block time" }).tap();
        }
        await shot(page, vpName, kind, "after-slot-select");
        const opened = await page.getByRole("dialog").first().isVisible().catch(() => false);
        const chooser = await page.getByRole("dialog", { name: /Choose action|New appointment|Add/ }).first().isVisible().catch(() => false);
        expect(opened || chooser, "selecting a slot (or the add button on a phone) opens a booking dialog").toBe(true);
        void seedE2eClient;
      });
    });
  }
}
