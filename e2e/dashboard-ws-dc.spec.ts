import { test, expect, type Page } from "@playwright/test";
import {
  seedConfirmedAppointment,
  seedE2eDashboardClient,
  seedE2eEndedAppointmentSession,
  seedE2eIntake,
  seedE2eMember,
  seedE2eStudio,
  seedNoStudioAuthUser,
  sql,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import { E2E_APP_ORIGIN } from "./helpers/local-env";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { capture, facts, isMobile } from "./helpers/dashboard-shots";

// WS-DC · Dashboard verification (HON-65 / PR #1299). One synthetic studio in a
// fixed-time visits are the MEMBER practitioner's (so clock-relative owner visits never double-book them); timezone far from the CI clock (Pacific/Auckland), so a UTC-date slip cannot hide.
// The same spec runs against production (BEFORE) and the candidate (AFTER): the
// assertions describe the REQUIRED behaviour, so on production the new-behaviour
// ones are expected RED and the shared ones GREEN. Nothing here marks anything accepted.
// Expected period counts are computed from the seeded rows in SQL, never by the app.

const T = 30_000;
const TZ = "Pacific/Auckland";

let seed: E2eSeed;
let owner: string;
let member: Awaited<ReturnType<typeof seedE2eMember>>;
const names: Record<string, string> = {};

async function localIso(dayISO: string, hhmm: string): Promise<string> {
  const r = await sql<{ t: Date }>(`select (($1 || ' ' || $2)::timestamp at time zone $3) as t`, [dayISO, hhmm, TZ]);
  return new Date(r[0].t).toISOString();
}
async function day(offset: number): Promise<string> {
  const r = await sql<{ d: string }>(`select to_char((now() at time zone $1)::date + $2::int, 'YYYY-MM-DD') d`, [TZ, offset]);
  return r[0].d;
}
async function plusDays(d: string, n: number): Promise<string> {
  return (await sql<{ d: string }>(`select to_char($1::date + $2::int, 'YYYY-MM-DD') d`, [d, n]))[0].d;
}
/** Book a fixed local time; on a studio-wide overlap with a clock-relative visit, flex later by 40 min (never for edge instants). */
async function book(label: string, dayISO: string, hhmm: string, minutes = 8, flex = true): Promise<string | null> {
  const c = await seedE2eDashboardClient(seed, { label });
  names[label] = c.name;
  const [h, m] = hhmm.split(":").map(Number);
  for (let attempt = 0; attempt < (flex ? 8 : 1); attempt++) {
    const total = h * 60 + m + attempt * 40;
    const t = `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    const start = await localIso(dayISO, t);
    const end = new Date(new Date(start).getTime() + minutes * 60_000).toISOString();
    try {
      await seedConfirmedAppointment(seed.studioId, member.practitionerId, c.clientId, start, end);
      return c.name;
    } catch (e) {
      if (!/no_overlapping_(appointments_studio_wide|calendar_reservations_per_resource)/.test(String((e as Error).message))) throw e;
    }
  }
  skippedEdges.push(label);
  return null;
}
const skippedEdges: string[] = [];

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  await sql(`update public.studios set timezone = $2 where id = $1`, [seed.studioId, TZ]);
  owner = (await sql<{ id: string }>(`select id from public.practitioners where studio_id=$1 and role='owner' limit 1`, [seed.studioId]))[0].id;
  member = await seedE2eMember(seed);

  // clock-relative visits FIRST (they cannot flex); the fixed local-time visits then flex around them
  // Needs Attention: 8 clients with a submitted intake (so the list needs "Show more"), and one
  // client with an ended, uncharted visit AND a submitted intake (grouping by client + session).
  for (let i = 1; i <= 8; i++) {
    const c = await seedE2eDashboardClient(seed, { label: `DCIntake${i}` });
    await seedE2eIntake(seed.studioId, c.clientId, "submitted");
    names[`DCIntake${i}`] = c.name;
  }
  // Preparation tier: an intake awaiting review for a client with an UPCOMING visit sorts first.
  const prep = await seedE2eDashboardClient(seed, { label: "DCPrep" });
  await seedE2eIntake(seed.studioId, prep.clientId, "submitted");
  await seedConfirmedAppointment(seed.studioId, member.practitionerId, prep.clientId, await localIso(await day(1), "14:00"), await localIso(await day(1), "14:30"));
  names.DCPrep = prep.name;
  // Documentation: ONE client with TWO recorded sessions that each lack aftercare confirmation and a probe lot.
  // Each session is its own entry (never merged); within a session the two issues fold into one entry.
  const s1 = await seedE2eEndedAppointmentSession(seed, { status: "completed", endedHoursAgo: 5, charted: true, aftercareExplained: false });
  names.groupedClient = (await sql<{ name: string }>(`select name from public.clients where id=$1`, [s1.clientId]))[0].name;
  const a2start = new Date(Date.now() - 30 * 3600_000).toISOString();
  const a2end = new Date(Date.now() - 29 * 3600_000).toISOString();
  const a2 = await seedConfirmedAppointment(seed.studioId, owner, s1.clientId, a2start, a2end);
  await sql(`update public.appointments set status='completed' where id=$1`, [a2]);
  const s2 = (await sql<{ id: string }>(
    `insert into public.sessions (studio_id, client_id, practitioner_id, modality, appointment_id, started_at)
     values ($1,$2,$3,'electrolysis',$4, $5) returning id`,
    [seed.studioId, s1.clientId, owner, a2, a2start],
  ))[0].id;
  await sql(
    `insert into public.session_blocks (studio_id, session_id, sort_order, primary_area, mode, energy_level, minutes_performed, machine_frequency)
     values ($1,$2,1,'Chin','thermo',5,10,'13.56 MHz')`,
    [seed.studioId, s2],
  );
  // Charting needed: a completed appointment with NO session.
  const un = await seedE2eDashboardClient(seed, { label: "DCUncharted" });
  const unA = await seedConfirmedAppointment(seed.studioId, owner, un.clientId, new Date(Date.now() - 52 * 3600_000).toISOString(), new Date(Date.now() - 51 * 3600_000).toISOString());
  await sql(`update public.appointments set status='completed' where id=$1`, [unA]);
  names.DCUncharted = un.name;

  // Display identity (#1299 @ 56fa8b53): a client whose LEGAL name differs from the PREFERRED name, with a recorded
  // visit that lacks contact details (so Needs attention lists them) and a birthday this month (so the chip lists them).
  const dd0 = await day(0);
  const pref = await seedE2eEndedAppointmentSession(seed, { status: "completed", endedHoursAgo: 7, charted: true, aftercareExplained: true });
  names.prefStored = "Storedname Fallbackfamily";
  // clients.preferred_name arrives with HELD migration 0258 and is absent here (and on production). The app reads it through
  // lib/clients/preferred-name-read.ts, which falls back to the stored name on a missing column: this fixture drives THAT.
  await sql(
    `update public.clients set name = $2, phone = null, address = null, date_of_birth = make_date(1990, $3, $4) where id = $1`,
    [pref.clientId, names.prefStored, Number(dd0.slice(5, 7)), ((Number(dd0.slice(8, 10)) + 3) % 27) + 1],
  );

  const d0 = await day(0);
  // populated days
  await book("DCToday1", d0, "09:00", 30);
  await book("DCToday2", d0, "11:00", 30);
  await book("DCToday3", d0, "15:00", 30);
  await book("DCTomorrow", await day(1), "10:00", 30);
  await book("DCYesterday", await day(-1), "10:00", 30);
  // day +3 is deliberately EMPTY.

  // period edges in the studio timezone (8-minute visits so 23:55 and 00:05 never overlap)
  const dow = Number((await sql<{ x: number }>(`select extract(dow from $1::date)::int x`, [d0]))[0].x);
  const weekStart = await plusDays(d0, -dow);
  const monthStart = d0.slice(0, 8) + "01";
  const nextMonthStart = (await sql<{ d: string }>(`select to_char(($1::date + interval '1 month')::date,'YYYY-MM-DD') d`, [monthStart]))[0].d;
  const edges: Array<[string, string, string]> = [
    ["EdgeTodayStart", d0, "00:05"], ["EdgeTodayEnd", d0, "23:55"],
    ["EdgePrevDayEnd", await plusDays(d0, -1), "23:55"], ["EdgeNextDayStart", await plusDays(d0, 1), "00:05"],
    ["EdgeWeekStart", weekStart, "00:05"], ["EdgeWeekEnd", await plusDays(weekStart, 6), "23:55"],
    ["EdgePrevWeekEnd", await plusDays(weekStart, -1), "23:55"], ["EdgeNextWeekStart", await plusDays(weekStart, 7), "00:05"],
    ["EdgeMonthStart", monthStart, "00:05"], ["EdgeMonthEnd", await plusDays(nextMonthStart, -1), "23:55"],
    ["EdgePrevMonthEnd", await plusDays(monthStart, -1), "23:55"], ["EdgeNextMonthStart", nextMonthStart, "00:05"],
  ];
  const seen = new Set<string>();
  for (const [label, dd, hhmm] of edges) {
    const key = `${dd} ${hhmm}`;
    if (seen.has(key)) continue; // two edges can fall on one instant (e.g. today is a Sunday)
    seen.add(key);
    await book(label, dd, hhmm, 8, false);
  }

  // Birthdays this month (studio-local month): 12 clients, one today, one archived (must not show)
  const monthNum = Number(d0.slice(5, 7));
  const dayNum = Number(d0.slice(8, 10));
  for (let i = 1; i <= 12; i++) {
    const c = await seedE2eDashboardClient(seed, { label: `DCBirthday${i}` });
    const bd = i === 1 ? dayNum : ((i * 2) % 27) + 1;
    await sql(`update public.clients set date_of_birth = make_date(1990, $2, $3) where id = $1`, [c.clientId, monthNum, bd]);
    names[`DCBirthday${i}`] = c.name;
  }
  const hidden = await seedE2eDashboardClient(seed, { label: "DCBirthdayArchived" });
  await sql(`update public.clients set date_of_birth = make_date(1990, $2, 5), archived_at = now() where id = $1`, [hidden.clientId, monthNum]);
  names.archivedBirthday = hidden.name;
});

const collapse = async (page: Page) => {
  const t = page.getByTestId("needs-attention-toggle");
  if ((await t.count()) && (await t.getAttribute("aria-expanded")) === "true") await t.click();
};

const open = async (page: Page, qs = "") => {
  await page.goto(`/dashboard${qs}`);
  await expect(page.getByRole("heading", { level: 2, name: "Needs attention" })).toBeVisible({ timeout: T });
};

for (const width of [1280, 390]) {
  test.describe(`owner at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } });

    test("layout: appointments beside Needs Attention on desktop, stacked on mobile; no horizontal overflow", async ({ page }) => {
      await loginAsOwner(page, seed);
      await open(page);
      const f = await capture(page, "owner-today");
      expect(f.appointmentsBox && f.needsBox, "both sections exist").toBeTruthy();
      if (isMobile(page)) {
        expect(f.needsBox!.y, "Needs Attention is below the appointments").toBeGreaterThan(f.appointmentsBox!.y + f.appointmentsBox!.h - 4);
      } else {
        expect(f.needsBox!.x, "Needs Attention is to the right").toBeGreaterThan(f.appointmentsBox!.x + f.appointmentsBox!.w - 4);
        expect(Math.abs(f.needsBox!.y - f.appointmentsBox!.y), "tops aligned").toBeLessThan(40);
      }
      expect(f.horizontalOverflow).toBe(false);
    });

    test("appointments: Previous / Today / Next move one studio-local day, the heading and the roster agree, empty day offers booking", async ({ page }) => {
      await loginAsOwner(page, seed);
      await open(page);
      const rows = page.locator('section[aria-label="Appointments"] > ul > li');
      await expect(rows).toHaveCount(await countOn(0), { timeout: T });
      for (const label of ["DCToday1", "DCToday2", "DCToday3"]) await expect(page.getByText(names[label]).first()).toBeVisible();
      await expect(page.getByTestId("dashboard-today")).toHaveAttribute("aria-current", "page");
      await capture(page, "owner-appointments-today");

      await page.getByTestId("dashboard-next-day").click();
      await page.waitForURL((u) => u.searchParams.get("day") !== null, { timeout: T });
      await expect(page.getByText(names.DCTomorrow).first()).toBeVisible({ timeout: T });
      await expect(page.getByText(names.DCToday1)).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 2, name: /tomorrow/i })).toBeVisible();
      await capture(page, "owner-appointments-tomorrow");

      await page.getByTestId("dashboard-today").click();
      await expect(page.getByText(names.DCToday1).first()).toBeVisible({ timeout: T });
      await page.getByTestId("dashboard-prev-day").click();
      await expect(page.getByText(names.DCYesterday).first()).toBeVisible({ timeout: T });
      await expect(page.getByText(names.DCToday1)).toHaveCount(0);

      // an empty day: no row, an honest empty state, and a booking entry that carries that day
      const empty = await day(3);
      await page.goto(`/dashboard?day=${empty}`);
      await expect(rows).toHaveCount(0, { timeout: T });
      const book = page.getByRole("link", { name: /book appointment/i }).first();
      await expect(book).toBeVisible();
      expect(await book.getAttribute("href")).toContain(empty);
      await capture(page, "owner-appointments-empty-day");
    });

    test("period boundaries follow the studio timezone: Today / This week / This month equal the rows in SQL", async ({ page }) => {
      await loginAsOwner(page, seed);
      const out: Record<string, string> = {};
      for (const [period, startSql, endSql] of [
        ["today", `(now() at time zone '${TZ}')::date`, `(now() at time zone '${TZ}')::date + 1`],
        ["week", `(now() at time zone '${TZ}')::date - extract(dow from (now() at time zone '${TZ}')::date)::int`, `(now() at time zone '${TZ}')::date - extract(dow from (now() at time zone '${TZ}')::date)::int + 7`],
        ["month", `date_trunc('month', now() at time zone '${TZ}')::date`, `(date_trunc('month', now() at time zone '${TZ}') + interval '1 month')::date`],
      ] as const) {
        const exp = Number((await sql<{ n: string }>(
          `select count(*)::int n from public.appointments where studio_id=$1 and (starts_at at time zone '${TZ}')::date >= ${startSql} and (starts_at at time zone '${TZ}')::date < ${endSql}`,
          [seed.studioId],
        ))[0].n);
        await open(page, `?period=${period}`);
        const big = (await page.locator("h3", { hasText: /^Appointments (today|this week|this month)/i }).locator("xpath=..").locator("p.text-3xl").first().innerText()).trim();
        out[period] = big;
        expect(Number(big), `${period}: snapshot total vs SQL count in ${TZ}`).toBe(exp);
      }
      await open(page, "?period=month");
      await capture(page, "owner-snapshot-month");
      test.info().annotations.push({ type: "period-totals", description: JSON.stringify(out) });
    });

    test("Needs Attention: one entry per client+session, ordered, counted, every item reachable, and opening an item marks nothing reviewed", async ({ page }) => {
      await loginAsOwner(page, seed);
      await open(page);
      const f0 = await capture(page, "owner-needs-attention");
      const countText = f0.needsCountText ?? "";
      expect(countText, "an accurate count is shown").toMatch(/\d+ (visit or client|visits and clients)/);
      const total = Number(/^(\d+)/.exec(countText)?.[1] ?? 0);
      // grouped: one client, two recorded sessions -> two separate entries, each folding its own issues
      const rowsFor = page.locator("[data-attention-id]").filter({ hasText: names.groupedClient });
      // expand first so the whole list is in the DOM
      const tgl = page.getByTestId("needs-attention-toggle");
      if (await tgl.count()) { await tgl.click(); await expect(tgl).toHaveAttribute("aria-expanded", "true"); }
      await expect(rowsFor, "two sessions of one client stay two entries").toHaveCount(2);
      for (const i of [0, 1]) expect(await rowsFor.nth(i).locator("[data-attention-issue]").count(), "aftercare + probe lot fold into ONE entry per session").toBeGreaterThan(1);
      await expect(page.locator("[data-attention-id]").filter({ hasText: names.DCUncharted }).locator('[data-attention-issue="charting"]')).toHaveCount(1);
      // order: preparation for an upcoming visit first, documentation after
      const ids = await page.locator("[data-attention-id]").evaluateAll((els) => els.map((e) => ({ scope: e.getAttribute("data-attention-scope"), text: e.textContent ?? "" })));
      const prepAt = ids.findIndex((e) => e.text.includes(names.DCPrep));
      const firstDoc = ids.findIndex((e) => e.scope !== "intake");
      expect(prepAt, "the upcoming-visit intake is listed").toBeGreaterThanOrEqual(0);
      expect(prepAt, "preparation sorts before documentation").toBeLessThan(firstDoc);
      await collapse(page);
      // compact list, then expand to reach EVERY entry
      const toggle = page.getByTestId("needs-attention-toggle");
      await expect(toggle).toBeVisible();
      await toggle.focus();
      await toggle.press("Enter"); // keyboard
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator("[data-attention-id]")).toHaveCount(total);
      await capture(page, "owner-needs-attention-expanded");

      // opening an item changes nothing: snapshot the intake rows, follow a link, come back
      const before = JSON.stringify(await sql(`select id, status, submitted_at, reviewed_at from public.client_intake_forms where studio_id=$1 order by id`, [seed.studioId]).catch(() => sql(`select * from public.client_intake_forms where studio_id=$1 order by id`, [seed.studioId])));
      const first = page.locator("[data-attention-issue] a").first();
      await first.click();
      await page.waitForLoadState("domcontentloaded");
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { level: 2, name: "Needs attention" })).toBeVisible({ timeout: T });
      const after = JSON.stringify(await sql(`select id, status, submitted_at, reviewed_at from public.client_intake_forms where studio_id=$1 order by id`, [seed.studioId]).catch(() => sql(`select * from public.client_intake_forms where studio_id=$1 order by id`, [seed.studioId])));
      expect(after, "opening a Needs Attention link must not mark an intake reviewed").toBe(before);
      expect((await facts(page)).needsCountText, "the count is unchanged after opening an item").toBe(countText);
    });

    test("birthdays: every birthday this month is reachable; archived clients are not listed", async ({ page }) => {
      await loginAsOwner(page, seed);
      await open(page);
      await expect(page.getByRole("heading", { level: 2, name: /birthdays this month/i })).toBeVisible({ timeout: T });
      const shown = [] as string[];
      for (let i = 1; i <= 12; i++) {
        const link = page.getByRole("link", { name: names[`DCBirthday${i}`], exact: true });
        if (await link.count()) shown.push(names[`DCBirthday${i}`]);
      }
      expect(shown.length, "all 12 birthdays are reachable without leaving the page").toBe(12);
      await expect(page.getByText(names.archivedBirthday)).toHaveCount(0);
      await expect(page.getByText("Today", { exact: true }).last()).toBeVisible();
      await capture(page, "owner-birthdays");
    });

    test("owner-only cards are present for the owner (positive control for the practitioner proof)", async ({ page }) => {
      await loginAsOwner(page, seed);
      await open(page, "?period=month");
      await expect(page.getByRole("heading", { level: 2, name: "Practice snapshot" })).toBeVisible({ timeout: T });
      await expect(page.getByText("Booked service value")).toBeVisible({ timeout: T });
      await capture(page, "owner-snapshot-and-setup");
    });
  });
}

async function countOn(offset: number): Promise<number> {
  const d = await day(offset);
  const r = await sql<{ n: number }>(
    `select count(*)::int n from public.appointments a where a.studio_id=$1 and (a.starts_at at time zone $2)::date = $3::date`,
    [seed.studioId, TZ, d],
  );
  return Number(r[0].n);
}

for (const width of [1280, 390]) {
  test.describe(`practitioner at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } });

    test("sees the dashboard without any owner-only card, and the server response carries none of it (HTML and RSC)", async ({ browser, page }) => {
      await loginAsOwner(page, seed);
      const ownerHtml = await (await page.request.get("/dashboard?period=month")).text();
      const ownerRsc = await (await page.request.get("/dashboard?period=month", { headers: { RSC: "1" } })).text();
      for (const marker of ["Practice snapshot", "Booked service value"]) {
        expect(ownerHtml + ownerRsc, `positive control: the owner payload carries "${marker}"`).toContain(marker);
      }
      const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
      const p = await ctx.newPage();
      await loginByMagicLink(p, member.email);
      await p.goto("/dashboard?period=month");
      await expect(p.getByRole("heading", { level: 2, name: "Needs attention" })).toBeVisible({ timeout: T });
      await capture(p, "practitioner");
      await expect(p.getByRole("heading", { level: 2, name: "Practice snapshot" })).toHaveCount(0);
      await expect(p.getByText("Booked service value")).toHaveCount(0);
      await expect(p.getByTestId("booking-setup-card")).toHaveCount(0);
      const html = await (await p.request.get("/dashboard?period=month")).text();
      const rsc = await (await p.request.get("/dashboard?period=month", { headers: { RSC: "1" } })).text();
      for (const marker of ["Practice snapshot", "Booked service value", "Completed service value", "Practice capacity"]) {
        expect(html, `practitioner HTML must not carry "${marker}"`).not.toContain(marker);
        expect(rsc, `practitioner RSC must not carry "${marker}"`).not.toContain(marker);
      }
      await ctx.close();
    });
  });
}

test.describe("receptionist stand-in (signed in, no practitioner row)", () => {
  test("is kept out of the dashboard and receives none of its data", async ({ browser }) => {
    const u = await seedNoStudioAuthUser();
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto("/login");
    await p.getByLabel("I am using my invited email address").check();
    await p.locator("#login-email").fill(u.email);
    const seen = await listMessageIds(u.email);
    await p.getByRole("button", { name: /send magic link/i }).click();
    await p.goto(await waitForMagicLink(u.email, E2E_APP_ORIGIN, { excludeIds: seen }));
    await p.waitForURL((x) => !/\/(login|auth)/.test(x.pathname), { timeout: 30_000 });
    const res = await p.request.get("/dashboard");
    const body = await res.text();
    for (const marker of ["Practice snapshot", "Booked service value", names.DCToday1, "Needs attention"]) {
      expect(body, `no dashboard data for a user without a studio: "${marker}"`).not.toContain(marker);
    }
    await ctx.close();
  });
});

// Capture-only: the same views on production (BEFORE) and the candidate (AFTER), no layout-specific waits, so
// the screenshots and facts exist for both builds. Asserts only that the page loaded (an h1 exists).
for (const width of [1280, 390]) {
  test.describe(`capture at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } });
    test("owner views and practitioner view", async ({ page, browser }) => {
      await loginAsOwner(page, seed);
      const views: Array<[string, string]> = [
        ["cap-owner-today", ""],
        ["cap-owner-tomorrow", `?day=${await day(1)}`],
        ["cap-owner-yesterday", `?day=${await day(-1)}`],
        ["cap-owner-empty-day", `?day=${await day(3)}`],
        ["cap-owner-period-today", "?period=today"],
        ["cap-owner-period-week", "?period=week"],
        ["cap-owner-period-month", "?period=month"],
      ];
      for (const [name, qs] of views) {
        await page.goto(`/dashboard${qs}`);
        await expect(page.locator("h1").first()).toBeVisible({ timeout: T });
        await page.waitForLoadState("networkidle").catch(() => undefined);
        await capture(page, name);
      }
      const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
      const p = await ctx.newPage();
      await loginByMagicLink(p, member.email);
      await p.goto("/dashboard?period=month");
      await expect(p.locator("h1").first()).toBeVisible({ timeout: T });
      await p.waitForLoadState("networkidle").catch(() => undefined);
      await capture(p, "cap-practitioner-month");
      await ctx.close();
    });
  });
}

// Candidate additions (OPS, #1299 @ 56fa8b53). Same assertions run on production for BEFORE; the new-behaviour ones are expected RED there.
for (const width of [1280, 390]) {
  test.describe(`display identity, setup card, unavailable state at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } });

    test("display identity FALLBACK: with no preferred_name column the stored name shows in Needs attention and in birthdays, with no error", async ({ page }) => {
      await loginAsOwner(page, seed);
      await open(page);
      const tgl = page.getByTestId("needs-attention-toggle");
      if (await tgl.count()) { await tgl.click(); await expect(tgl).toHaveAttribute("aria-expanded", "true"); }
      const entry = page.locator("[data-attention-id]").filter({ hasText: names.prefStored });
      expect(await entry.count(), "the stored name heads a Needs attention entry (missing details)").toBeGreaterThan(0);
      await expect(page.getByRole("link", { name: names.prefStored, exact: true }).last(), "birthday chip shows the stored name").toBeVisible();
      await expect(page.getByText(/something went wrong|application error/i), "the page renders without an error").toHaveCount(0);
      await capture(page, "owner-display-identity-fallback");
    });

    // NOT RUNNABLE until migration 0258 (clients.preferred_name) is applied: the column is absent on production and on any stack
    // built from it. Recorded, not faked; a local pre-apply rehearsal would have to be labelled as such.
    test.skip("display identity WITH a preferred name: preferred name shown, legal name nowhere (NOT RUNNABLE until 0258)", async () => {});

    test("setup card: an unfinished studio reads 'incomplete'; a studio whose only gap is its own admission choice reads 'paused by owner'", async ({ page, browser }) => {
      await loginAsOwner(page, seed);
      await open(page);
      await expect(page.getByTestId("setup-paused-by-owner"), "default studio is unfinished, not paused").toHaveCount(0);
      await expect(page.getByTestId("booking-setup-card")).toBeVisible({ timeout: T });
      await capture(page, "owner-setup-incomplete");

      // second synthetic studio: live treatment consent + new clients closed, nothing else structural missing
      const s2 = await seedE2eStudio();
      await sql(
        `insert into public.consent_form_templates (studio_id, title, description, body, form_type, version, status, is_live)
         values ($1, 'Treatment consent', 'E2E', 'E2E treatment consent body', 'treatment_consent', 1, 'active', true)`,
        [s2.studioId],
      );
      await sql(
        `with permit as (select set_config('hone.admission_mode_studio_id', $1::text, true) as p)
         update public.studios set new_client_admission_mode = 'closed' from permit where id = $1::uuid`,
        [s2.studioId],
      );
      const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
      const p = await ctx.newPage();
      await loginAsOwner(p, s2);
      await p.goto("/dashboard");
      await expect(p.locator("h1").first()).toBeVisible({ timeout: T });
      await expect(p.getByTestId("setup-paused-by-owner"), "paused by the owner's own choice").toBeVisible({ timeout: T });
      await expect(p.getByTestId("setup-paused-by-owner")).toContainText("That is your setting, not unfinished setup.");
      await capture(p, "owner-setup-paused");
      await ctx.close();
    });

    test("when the intake read fails the panel says it could not check, never a quiet zero", async ({ page }) => {
      await loginAsOwner(page, seed);
      // Table-wide revoke takes the whole page down (the Today roster's own intake read throws, as on production), so it cannot
      // isolate this card. Only the awaiting-review read orders by the row id, so withdraw SELECT on that one column.
      const cols = (await sql<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema='public' and table_name='client_intake_forms' and column_name <> 'id'`,
      )).map((r) => `"${r.column_name}"`).join(", ");
      await sql(`revoke select on public.client_intake_forms from authenticated`);
      await sql(`grant select (${cols}) on public.client_intake_forms to authenticated`);
      try {
        await page.goto("/dashboard");
        await expect(page.locator("h1").first()).toBeVisible({ timeout: T });
        await page.waitForLoadState("networkidle").catch(() => undefined);
        const note = page.getByTestId("needs-attention-unavailable");
        await expect(note, "an unreadable source is announced").toBeVisible({ timeout: T });
        await expect(note).toHaveAttribute("role", "status");
        await capture(page, "owner-needs-attention-unavailable");
      } finally {
        await sql(`grant select on public.client_intake_forms to authenticated`);
      }
    });
  });
}
