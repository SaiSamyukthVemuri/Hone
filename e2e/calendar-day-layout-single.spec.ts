import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type CDPSession, type Locator, type Page } from "@playwright/test";
import {
  getE2eServiceId, getOwnerPractitionerId, seedE2eClient, seedStudioWideDefault, seedE2eMember, seedE2eStudio, seedPractitionerDefault,
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
// B4/B5 (Codex P2 on #1280): capacity OFF, ONE active practitioner, the STUDIO open, but the practitioner carries a leftover PERSONAL closed
// weekday default (B4) or a personal closed override for the day (B5). With capacity off those personal rows are not in force: the Day column
// and its slot grid must show, and booking must work, not "No practitioner is working".
const KINDS = {
  B1: { capacity: true, extra: 0, personal: null }, B2: { capacity: false, extra: 0, personal: null }, B3: { capacity: true, extra: 2, personal: null },
  B4: { capacity: false, extra: 0, personal: "closed-default" }, B5: { capacity: false, extra: 0, personal: "closed-override" },
  // B6 (Codex on #1280): capacity OFF, one active, a PRACTITIONER-SCOPED timed block at 15:00. Scoped blocks and breaks are dormant with
  // capacity off (0137), so the Day column must not draw it: 15:00 stays bookable and a booking there succeeds.
  B6: { capacity: false, extra: 0, personal: "scoped-block" },
} as const;
type Kind = keyof typeof KINDS;

type S = { seed: E2eSeed; day: string; ownerId: string; serviceId: string; clientId: string; clientName: string };
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
    await seedStudioWideDefault(seed.studioId, d.dow, true, "08:00", "20:00");
    if (k.personal === "scoped-block") {
      await sql(
        "insert into public.studio_timed_blocks (studio_id,practitioner_id,created_by,starts_at,ends_at,category,private_note) " +
        "select $1,$2,$2,s,s+interval '1 hour','lunch',$3 from (select ($4::date + time '15:00') at time zone $5 as s) t",
        [seed.studioId, ownerId, `cal-layout-b6-${seed.runId}`, d.day, TZ]);
    }
    if (k.personal === "closed-default") await seedPractitionerDefault(seed.studioId, ownerId, d.dow, false, null, null);
    else await seedPractitionerDefault(seed.studioId, ownerId, d.dow, true, "08:00", "20:00");
    if (k.personal === "closed-override") {
      await sql("insert into public.studio_availability_overrides (studio_id, effective_date, practitioner_id, is_open) values ($1,$2,$3,false)", [seed.studioId, d.day, ownerId]);
    }
    await seedServiceEligibility(seed.studioId, serviceId, ownerId);
    for (let i = 0; i < k.extra; i++) { const m = await seedE2eMember(seed); await setPractitionerActive(m.practitionerId, false); }
    if (!k.capacity) { await setStudioCapacityBookingEnabled(seed.studioId, false); await setStudioCapacityEnabled(seed.studioId, false); }
    // the drawer's client list loads WITH the page, so the client exists before any page is opened
    const { clientId } = await seedE2eClient(seed);
    const clientName = (await sql<{ name: string }>("select name from public.clients where studio_id=$1 and id=$2", [seed.studioId, clientId]))[0].name;
    return { seed, day: d.day, ownerId, serviceId, clientId, clientName };
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
  for (const kind of ["B1", "B2", "B3", "B4", "B5", "B6"] as Kind[]) {
    test.describe(`single-path ${vpName} / ${kind}`, () => {
      test.use({ viewport: vp.viewport, hasTouch: vp.hasTouch, isMobile: vp.isMobile });
      test.setTimeout(240_000);

      test(`${kind}: where ?view=day lands, that the grid has slot lines, that it scrolls, and that a later time can be booked`, async ({ page }) => {
        const s = await getStudio(kind);
        // B6: the two viewports share one studio, so each books its OWN half hour inside the dormant block (desktop 15:00, phone 15:30)
        const tg = kind === "B6" ? { target: vpName === "desktop" ? "15:00" : "15:30", label: vpName === "desktop" ? "3:00 PM" : "3:30 PM", rx: /^(3\s?PM|15:00)$/i } : { target: vp.target, label: vpName === "desktop" ? "4:00 PM" : "5:00 PM", rx: vp.rx };
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
        await expect(page.getByText(/No practitioner is working/i), "no false 'nobody is working' message").toHaveCount(0);
        await expect(page.getByTestId("team-day-empty"), "no empty state: one practitioner IS working").toHaveCount(0);
        expect(surface, `one active practitioner gets the Day view (landed on ${url.pathname}${url.search} as a ${surface})`).toBe("team-day-view");
        expect(await page.getByTestId("team-day-view").getAttribute("data-column-count"), "one column").toBe("1");
        expect(lineCount, "the grid draws its slot lines").toBeGreaterThan(0);
        expect(moved, `${vp.hasTouch ? "touch" : "wheel"} scrolling moves the ${kindOfScroller}`).toBeGreaterThan(100);
        await expect(page.getByText(tg.rx).locator("visible=true").first(), `the ${tg.target} time label becomes visible`).toBeInViewport();

        // B6: the dormant scoped block is not drawn in the Day column (checked BEFORE any drawer opens), so 15:00 is open
        if (kind === "B6") await expect(page.getByTestId("team-day-column").first().getByText(/lunch/i), "a dormant scoped block is not drawn").toHaveCount(0);

        // a slot there opens the booking drawer for this day
        if (vpName === "desktop") {
          const col = present.teamDayView ? page.getByTestId("team-day-column").first() : page.locator(`[data-testid="week-day-column"][data-date="${s.day}"]`);
          const btn = col.getByRole("button", { name: /Open quick-book draft for/ });
          const cb = (await col.boundingBox())!;
          const y = cb.y + (Number(tg.target.slice(0, 2)) - GRID_START_HOUR) * 60 + 6;
          expect(y > 0 && y < vp.viewport.height, "the target slot is on screen after the scroll").toBe(true);
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

        // B4/B5/B6: booking really works from here: pick the client, the service and the time in the drawer, book, and the row lands at that local time
        if (KINDS[kind].personal) {
          const drawer = page.getByRole("dialog", { name: "New appointment" });
          await expect(drawer).toBeVisible({ timeout: 20_000 });
          await drawer.getByPlaceholder("Find existing client").fill(s.clientName);
          await drawer.getByRole("button", { name: new RegExp(s.seed.runId) }).first().click();
          await drawer.getByRole("combobox").first().selectOption(s.serviceId);
          const label = tg.label;
          const slot = drawer.getByRole("button", { name: /^\d{1,2}:\d{2}\s?(AM|PM)$/i }).filter({ hasText: label }).first();
          await expect(slot, `the drawer offers ${label}`).toBeVisible({ timeout: 20_000 });
          await slot.click();
          await shot(page, vpName, kind, "drawer");
          await drawer.getByRole("button", { name: /^Book appointment$/ }).click();
          await expect(drawer).toBeHidden({ timeout: 20_000 });
          await expect.poll(async () => (await sql<{ c: number }>(
            "select count(*)::int c from public.appointments where studio_id=$1 and client_id=$2 and practitioner_id=$3 and (starts_at at time zone $4)::time = $5::time",
            [s.seed.studioId, s.clientId, s.ownerId, TZ, tg.target]))[0].c, { timeout: 20_000 }).toBe(1);
          await shot(page, vpName, kind, "booked");
        }
      });
    });
  }
}
