import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type CDPSession, type Locator, type Page } from "@playwright/test";
import {
  getE2eServiceId, getOwnerPractitionerId, seedE2eClient, seedE2eMember, seedE2eStudio,
  seedPractitionerDefault, seedServiceEligibility, setStudioCapacityBookingEnabled, setStudioCapacityEnabled,
  setStudioTimezone, sql, type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { loadCalLayoutConstants } from "./helpers/cal-layout-constants";

// Opt-in: ~11 min of serial browser time (35 cases, own studios). OPS decides whether a CI lane runs it; locally set CAL_LAYOUT_E2E=1.
test.skip(process.env.CAL_LAYOUT_E2E !== "1", "opt-in HON-48 day-layout matrix; set CAL_LAYOUT_E2E=1");

// HON-48 team day view: layout and booking-reachability matrix. SYNTHETIC data only.
//
//   working practitioners: 0 | 1 | 2 | 6 ("5+")      viewports: desktop 1280x800 | mobile 390x844 (touch)
//   schedules: empty, then booked
//   flow (1, 2, 6): open the day -> scroll to a later time (wheel, trackpad-style wheel, touch on mobile) -> select a slot
//                   at its VISIBLE position -> create the booking -> it appears in the right column at the right time
//   asserts: header/column alignment, consistent column width, no excessive width, label/grid alignment, horizontal scroll
//   inside the box (never the page) when columns exceed the viewport, date change and practitioner selection recalculate,
//   0 working = an explicit empty state.
//
// Only RELATIVE properties are asserted (no invented absolute limits): equal column widths; never below the code's minimum
// (imported constant, see helpers/cal-layout-constants.ts); one practitioner is compact (below the code's single-column constant,
// or, until that exists, below 60% of the scroll box); horizontal scroll exactly when the columns' minimum widths exceed the box;
// time labels sit on grid lines (1px); the box really scrolls (scrollTop moves) by wheel and by touch and a later slot becomes
// clickable; a booking lands in the right column at the right time. One contract is mine: 0 working shows
// [data-testid="team-day-empty"] and no column header.
// Screenshots: CAL_SHOTS_DIR (default test-results/cal-shots), files <phase>-<viewport>-<n>w-<state>.png, CAL_PHASE=red|green.

const TZ = "America/Los_Angeles";
const GRID_START_HOUR = 6; // calendar-constants HOUR_START; 1px = 1 minute
const SHOTS = process.env.CAL_SHOTS_DIR ?? "test-results/cal-shots";
const PHASE = process.env.CAL_PHASE ?? "run";
const SLOT = /^\d{1,2}:\d{2}\s?(AM|PM)$/i;

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false, target: "16:00", label: "4:00 PM", hour: 16 },
  mobile: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, target: "17:00", label: "5:00 PM", hour: 17 },
} as const;

type Studio = {
  seed: E2eSeed; n: number; people: number; day: string; nextDay: string; dow: number;
  serviceId: string; ids: string[]; working: string[]; names: Record<string, string>; ownerId: string;
  nextWorking: string[]; booked12: boolean;
};
const studios = new Map<number, Promise<Studio>>();

async function insertAppointment(s: Studio, practitionerId: string, clientId: string, date: string, local: string): Promise<void> {
  await sql(
    "insert into public.appointments (id,studio_id,client_id,practitioner_id,service_id,starts_at,ends_at,duration_minutes,buffer_minutes_snapshot,blocked_ends_at,status) " +
    "select gen_random_uuid(),$1,$2,$3,$4,start_at,start_at+interval '30 minutes',30,0,start_at+interval '30 minutes','confirmed' " +
    "from (select ($5::date + $6::time) at time zone $7 as start_at) t",
    [s.seed.studioId, clientId, practitionerId, s.serviceId, date, local, TZ],
  );
}
async function clientNameOf(s: Studio, clientId: string): Promise<string> {
  return (await sql<{ name: string }>("select name from public.clients where studio_id=$1 and id=$2", [s.seed.studioId, clientId]))[0].name;
}

// A team of `people` practitioners of whom `n` work on the test day (the first n); the rest are off that day.
function getStudio(n: number): Promise<Studio> {
  if (!studios.has(n)) {
    studios.set(n, (async () => {
      const people = n === 0 ? 3 : n >= 5 ? n + 1 : 3;
      const seed = await seedE2eStudio();
      await setStudioTimezone(seed.studioId, TZ);
      await setStudioCapacityEnabled(seed.studioId, true);
      await setStudioCapacityBookingEnabled(seed.studioId, true);
      const [d] = await sql<{ day: string; next: string; dow: number; ndow: number }>(
        "select ((now() at time zone $1)::date+7)::text as day, ((now() at time zone $1)::date+8)::text as next, " +
        "extract(dow from ((now() at time zone $1)::date+7))::int as dow, extract(dow from ((now() at time zone $1)::date+8))::int as ndow", [TZ]);
      const ownerId = await getOwnerPractitionerId(seed.studioId);
      const members = [];
      for (let i = 0; i < people - 1; i++) members.push(await seedE2eMember(seed));
      const ids = [ownerId, ...members.map((m) => m.practitionerId)];
      const serviceId = await getE2eServiceId(seed.studioId);
      const names: Record<string, string> = {};
      const colors = ["teal", "amber", "violet", "sky", "rose", "emerald", "orange"];
      const working = ids.slice(0, n);
      // the next day: a different working set, so a date change must recompute (1 -> 2 people, otherwise 1)
      const nextWorking = ids.slice(0, n === 1 ? 2 : n === 0 ? 1 : 1);
      for (const [i, id] of ids.entries()) {
        names[id] = `Synthetic Col ${seed.runId}-${i + 1}`;
        await sql("update public.practitioners set display_name=$3, color=$4 where studio_id=$1 and id=$2", [seed.studioId, id, names[id], colors[i % colors.length]]);
        await seedPractitionerDefault(seed.studioId, id, d.dow, working.includes(id), "08:00", "20:00");
        await seedPractitionerDefault(seed.studioId, id, d.ndow, nextWorking.includes(id), "08:00", "20:00");
        await seedServiceEligibility(seed.studioId, serviceId, id);
      }
      return { seed, n, people, day: d.day, nextDay: d.next, dow: d.dow, serviceId, ids, working, names, ownerId, nextWorking, booked12: false };
    })());
  }
  return studios.get(n)!;
}

const view = (page: Page) => page.getByTestId("team-day-view");
const headers = (page: Page) => page.getByTestId("team-day-column-header");
const columns = (page: Page) => page.getByTestId("team-day-column");
const column = (page: Page, id: string) => page.locator(`[data-testid="team-day-column"][data-practitioner-id="${id}"]`);
const hourOffset = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h - GRID_START_HOUR) * 60 + m; };

async function shot(page: Page, vp: string, n: number, state: string): Promise<string> {
  mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${PHASE}-${vp}-${n}w-${state}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function openDay(page: Page, s: Studio, day = s.day): Promise<void> {
  await loginAsOwner(page, s.seed);
  await page.goto(`/calendar?view=day&day=${day}`);
}

// Visible rectangle of the scroll box (viewport-intersected), in page coordinates.
async function visibleBox(loc: Locator): Promise<{ x: number; y: number; w: number; h: number }> {
  return loc.evaluate((el) => { const r = el.getBoundingClientRect(); const x = Math.max(0, r.left), y = Math.max(0, r.top); return { x, y, w: Math.min(innerWidth, r.right) - x, h: Math.min(innerHeight, r.bottom) - y }; });
}


// A real finger: touchStart, many touchMoves, touchEnd through the browser's own input pipeline (what Input.synthesizeScrollGesture did
// not move on this Chromium). Dragging UP scrolls the page DOWN.
async function touchDragUp(page: Page, x: number, y: number, px: number): Promise<void> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const pt = (yy: number) => [{ x: Math.round(x), y: Math.round(yy), id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(y) });
  const steps = Math.max(1, Math.ceil(px / 25));
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(y - (px * i) / steps) });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

const innerHeightOf = (page: Page): number => page.viewportSize()!.height;

// Scroll the grid down by `px` using one input method, never scrollTo.
async function scrollDown(page: Page, method: "wheel" | "trackpad" | "touch", px: number): Promise<number> {
  const v = view(page);
  // on a desktop the grid is its own scroll box; on a phone the PAGE scrolls: whichever moves, the person scrolled
  const pos = () => v.evaluate((el) => el.scrollTop + window.scrollY);
  const before = await pos();
  const b = await visibleBox(v);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  if (method === "wheel") {
    await page.mouse.move(cx, cy);
    for (let d = 0; d < px; d += 100) await page.mouse.wheel(0, Math.min(100, px - d));
  } else if (method === "trackpad") {
    // many small deltas with sideways jitter, as a trackpad produces
    await page.mouse.move(cx, cy);
    for (let d = 0; d < px; d += 6) { await page.mouse.wheel((d / 6) % 2 === 0 ? 1 : -1, 6); }
  } else {
    let left = px;
    while (left > 0) { const d = Math.min(left, Math.floor(innerHeightOf(page) * 0.5)); await touchDragUp(page, cx, Math.min(cy + d / 2, innerHeightOf(page) - 30), d); left -= d; await page.waitForTimeout(150); }
  }
  // wait until the scroll has SETTLED (a trackpad's many small deltas are still moving 250 ms later): same value on 3 reads
  let last = -1, stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    await page.waitForTimeout(100);
    const now = await pos();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
  return last - before;
}

// The slot the person would press: the point of the target time inside a column, only if it is actually on screen.
async function visibleSlotPoint(page: Page, id: string, hhmm: string): Promise<{ x: number; y: number } | null> {
  const col = column(page, id);
  const cb = await col.boundingBox();
  const vb = await visibleBox(view(page));
  const hdr = await headers(page).first().boundingBox();
  if (!cb) return null;
  const x = cb.x + Math.min(cb.width / 2, 120);
  const y = cb.y + hourOffset(hhmm) + 6;
  const top = vb.y + (hdr?.height ?? 0) + 2; // under the sticky header row
  const inside = x >= vb.x && x <= vb.x + vb.w && y >= top && y <= vb.y + vb.h - 2;
  return inside ? { x, y } : null;
}

for (const vpName of ["desktop", "mobile"] as const) {
  const vp = VIEWPORTS[vpName];
  for (const n of [0, 1, 2, 6]) {
    test.describe(`${vpName} / ${n} working`, () => {
      test.use({ viewport: vp.viewport, hasTouch: vp.hasTouch, isMobile: vp.isMobile });
      test.setTimeout(240_000);

      if (n === 0) {
        test("EMPTY STATE: nobody working is an explicit empty state, not a blank or broken grid", async ({ page }) => {
          const s = await getStudio(0);
          await openDay(page, s);
          await page.waitForLoadState("networkidle");
          await shot(page, vpName, 0, "empty");
          await expect(page.getByTestId("team-day-empty"), "0 working must show an explicit empty state").toBeVisible();
          await expect(headers(page)).toHaveCount(0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal page scroll").toBe(true);
        });
        return;
      }

      test(`LAYOUT (empty): ${n} column(s), headers aligned with columns, equal sane widths, no page overflow`, async ({ page }) => {
        const s = await getStudio(n);
        await openDay(page, s);
        await expect(view(page)).toBeVisible({ timeout: 60_000 });
        await shot(page, vpName, n, "empty");
        await expect(headers(page), "every working practitioner has a header").toHaveCount(n);
        await expect(columns(page), "every working practitioner has a column").toHaveCount(n);
        const K = await loadCalLayoutConstants();
        const box = (await view(page).boundingBox())!;
        const clientW = await view(page).evaluate((el) => el.clientWidth);
        const hb: { x: number; w: number }[] = [], cb: { x: number; w: number }[] = [];
        for (let i = 0; i < n; i++) {
          const h = (await headers(page).nth(i).boundingBox())!, c = (await columns(page).nth(i).boundingBox())!;
          hb.push({ x: h.x, w: h.width }); cb.push({ x: c.x, w: c.width });
        }
        for (let i = 0; i < n; i++) {
          expect(Math.abs(hb[i].x - cb[i].x), `header ${i} left edge matches its column`).toBeLessThanOrEqual(1);
          expect(Math.abs(hb[i].w - cb[i].w), `header ${i} width matches its column`).toBeLessThanOrEqual(1);
          expect(Math.abs(cb[i].w - cb[0].w), `column ${i} has the same width as column 0`).toBeLessThanOrEqual(1);
          expect(cb[i].w, `column ${i} is not below the code's minimum (${K.minColumnPx}px, ${K.source})`).toBeGreaterThanOrEqual(K.minColumnPx - 1);
        }
        if (n === 1) {
          const cap = K.singleColumnMaxPx ?? 0.6 * (box.width - K.railPx);
          expect(cb[0].w, `one practitioner is compact: ${Math.round(cb[0].w)}px of a ${Math.round(box.width)}px box (limit ${Math.round(cap)}px, ${K.singleColumnMaxPx ? "named constant" : "relative 60% until the constant exists"})`).toBeLessThanOrEqual(cap);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the page itself never scrolls sideways").toBe(true);
        const needsH = K.railPx + n * K.minColumnPx > clientW;
        const overflows = await view(page).evaluate((el) => el.scrollWidth > el.clientWidth + 1);
        expect(overflows, needsH ? "the columns' minimum widths exceed the box, so it scrolls sideways inside itself" : "the columns fit, so there is no sideways scroll").toBe(needsH);
        // slot lines exist in every column, and the hour labels sit on them (1px)
        const labels = view(page).getByText(/^(12\s?PM|12:00)$/i).first();
        await labels.scrollIntoViewIfNeeded();
        const lb = (await labels.boundingBox())!;
        for (let i = 0; i < n; i++) {
          const lines = columns(page).nth(i).locator("div.absolute.inset-x-0.border-b");
          expect(await lines.count(), `column ${i} draws its half-hour slot lines`).toBe((23 - GRID_START_HOUR) * 2);
          const twelve = (await lines.nth((12 - GRID_START_HOUR) * 2).boundingBox())!; // the row that starts at 12:00
          expect(Math.abs(twelve.y - lb.y), `the 12:00 label is on column ${i}'s 12:00 grid line`).toBeLessThanOrEqual(1);
        }
        if (n === 1 || n === 2) await expect(page.getByTestId("team-day-not-working")).toBeVisible(); // the people who are off are named
      });

      for (const method of (vpName === "mobile" ? ["touch"] : ["wheel", "trackpad"]) as ("wheel" | "trackpad" | "touch")[]) {
        // each method books its OWN slot: the cases share a studio, and a second click on a taken slot opens the appointment, not a new booking
        const tv = method === "trackpad" ? { target: "15:00", label: "3:00 PM" } : { target: vp.target, label: vp.label };
        test(`BOOKING (empty -> booked): ${method} scroll to ${tv.label}, select the slot where it is shown, book it, it lands in the right column at the right time`, async ({ page }) => {
          const s = await getStudio(n);
          const target = s.working[n - 1]; // book the LAST working column: the furthest one on a phone
          // the drawer's client list is loaded WITH the page, so the client must exist BEFORE the day is opened
          const { clientId } = await seedE2eClient(s.seed);
          const clientName = await clientNameOf(s, clientId);
          await openDay(page, s);
          await expect(view(page)).toBeVisible({ timeout: 60_000 });
          await expect(headers(page)).toHaveCount(n);

          // 1. bring the target column into view sideways when it is off screen (mobile), by touch/wheel on the box
          const col = column(page, target);
          // (columns are a fixed width: more of them than the box holds scroll SIDEWAYS, on a desktop as well as a phone)
          if (!(await visibleSlotPoint(page, target, "08:00"))) {
            const vbox = await visibleBox(view(page));
            if (!vp.hasTouch) {
              await page.mouse.move(vbox.x + vbox.w / 2, vbox.y + vbox.h / 2);
              for (let i = 0; i < 30 && !(await visibleSlotPoint(page, target, "08:00")); i++) await page.mouse.wheel(150, 0);
              await page.waitForTimeout(200);
            }
            if (!(await visibleSlotPoint(page, target, "08:00")))
            await col.scrollIntoViewIfNeeded();
          }
          // 2. a later time is not on screen until the person scrolls
          expect(await visibleSlotPoint(page, target, tv.target), `${tv.label} should need a scroll`).toBeNull();
          const moved = await scrollDown(page, method, hourOffset(tv.target) - 120);
          await shot(page, vpName, n, `scrolled-${method}`);
          expect(moved, `${method} scroll moved the grid`).toBeGreaterThan(100);
          // a desktop selects the slot where it is drawn. A phone cannot: touch taps on the empty grid are ignored BY DESIGN (PR #228, DayColumn.tsx);
          // the touch create control is the column's "Book <name> on <date>" button, and the time is then chosen in the drawer.
          const pt = vp.hasTouch ? null : await visibleSlotPoint(page, target, tv.target);
          if (!vp.hasTouch) expect(pt, `${tv.label} is reachable on screen after scrolling`).not.toBeNull();
          else await expect(column(page, target), "the target time is on screen after the touch scroll").toBeInViewport();

          // 3. select the slot exactly where it is drawn
          if (vp.hasTouch) {
            const plus = column(page, target).getByRole("button", { name: /^Book .* on \d{4}-\d{2}-\d{2}$/ });
            await plus.scrollIntoViewIfNeeded();
            await plus.tap();
          } else await page.mouse.click(pt!.x, pt!.y);
          const drawer = page.getByRole("dialog", { name: "New appointment" });
          await expect(drawer).toBeVisible({ timeout: 20_000 });
          await drawer.getByPlaceholder("Find existing client").fill(clientName);
          await drawer.getByRole("button", { name: new RegExp(s.seed.runId) }).first().click();
          await drawer.getByRole("combobox").first().selectOption(s.serviceId);
          const slot = drawer.getByRole("button", { name: SLOT }).filter({ hasText: tv.label }).first();
          await expect(slot, `the drawer offers ${tv.label}`).toBeVisible({ timeout: 20_000 });
          await slot.click();
          await shot(page, vpName, n, `drawer-${method}`);
          await drawer.getByRole("button", { name: /^Book appointment$/ }).click();
          await expect(drawer).toBeHidden({ timeout: 20_000 });

          // 4. it is in the DB for that practitioner at that local time, and on the page in that column at that line
          await expect.poll(async () => (await sql<{ c: number }>(
            "select count(*)::int c from public.appointments where studio_id=$1 and client_id=$2 and practitioner_id=$3 and (starts_at at time zone $4)::time = $5::time",
            [s.seed.studioId, clientId, target, TZ, tv.target]))[0].c, { timeout: 20_000 }).toBe(1);
          await page.reload();
          await expect(view(page)).toBeVisible({ timeout: 60_000 });
          const card = column(page, target).getByRole("button").filter({ hasText: clientName });
          await card.scrollIntoViewIfNeeded();
          await expect(card, "the booking appears in the column it was made in").toHaveCount(1);
          for (const other of s.working.filter((id) => id !== target)) {
            await expect(column(page, other).getByRole("button").filter({ hasText: clientName }), "and in no other column").toHaveCount(0);
          }
          const cardBox = (await card.boundingBox())!, colBox = (await column(page, target).boundingBox())!;
          expect(Math.abs((cardBox.y - colBox.y) - hourOffset(tv.target)), "at the right time on the grid (1px = 1 minute)").toBeLessThanOrEqual(1);
          await shot(page, vpName, n, `booked-${method}`);
        });
      }

      test(`LAYOUT (booked): seeded 12:00 bookings sit on the 12:00 label line in every column`, async ({ page }) => {
        const s = await getStudio(n);
        if (!s.booked12) {
          s.booked12 = true;
          for (const id of s.working) { const { clientId } = await seedE2eClient(s.seed); await insertAppointment(s, id, clientId, s.day, "12:00"); }
        }
        await openDay(page, s);
        await expect(view(page)).toBeVisible({ timeout: 60_000 });
        await expect(headers(page)).toHaveCount(n);
        const label = view(page).getByText(/^(12\s?PM|12:00)$/i).first();
        await label.scrollIntoViewIfNeeded();
        const lb = (await label.boundingBox())!;
        for (const id of s.working) {
          const cards = column(page, id).getByRole("button").filter({ hasText: /12:00 PM/ }).filter({ hasNotText: /Open quick-book/ });
          const first = cards.first();
          await expect(first, `a 12:00 appointment is drawn in column ${id.slice(0, 4)}`).toBeVisible();
          const bb = (await first.boundingBox())!;
          expect(Math.abs(bb.y - lb.y), "the appointment's top is on the 12:00 label line").toBeLessThanOrEqual(1);
        }
        await shot(page, vpName, n, "booked12");
      });

      test(`RECALC: a date change recomputes the columns; the practitioner choice in the booking drawer follows`, async ({ page }) => {
        const s = await getStudio(n);
        await openDay(page, s);
        await expect(headers(page)).toHaveCount(n);
        await page.getByRole("link", { name: /next/i }).first().click();
        await expect(view(page)).toHaveAttribute("data-date", s.nextDay, { timeout: 30_000 });
        await expect(headers(page), "the next day has its own working set").toHaveCount(s.nextWorking.length);
        await shot(page, vpName, n, "next-day");
        await page.getByRole("link", { name: /prev|previous/i }).first().click();
        await expect(view(page)).toHaveAttribute("data-date", s.day, { timeout: 30_000 });
        await expect(headers(page)).toHaveCount(n);
        if (n >= 2) {
          const a = s.working[0], b = s.working[1];
          const btn = column(page, a).getByRole("button", { name: /Open quick-book draft for/ });
          await btn.scrollIntoViewIfNeeded();
          const cb = (await btn.boundingBox())!;
          if (vp.hasTouch) {
            // touch create control (taps on the empty grid are ignored by design)
            const plus = column(page, a).getByRole("button", { name: /^Book .* on \d{4}-\d{2}-\d{2}$/ });
            await plus.scrollIntoViewIfNeeded();
            await plus.tap();
          } else await btn.click({ position: { x: 30, y: hourOffset("10:00") } });
          const drawer = page.getByRole("dialog", { name: "New appointment" });
          await expect(drawer).toBeVisible({ timeout: 20_000 });
          await expect(drawer.getByLabel("Practitioner")).toHaveValue(a);
          await drawer.getByLabel("Practitioner").selectOption(b);
          await expect(drawer.getByTestId("assigned-practitioner")).toContainText(s.names[b]);
        }
      });
    });
  }
}
