import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import { getOwnerPractitionerId, seedE2eDashboardClient, seedE2eMember, seedE2eStudio, sql, type E2eSeed } from "./helpers/seed";

// ===========================================================================
// Business → Overview on a PHONE (390 x 844): the main figures are in the first screen with no scrolling; the reporting period lives in the address;
// Overview → Statements opens the matching month and Back returns to the same period and the same figures; a studio with no activity shows a genuine $0
// beside a figure that is "Not available". Synthetic studios, fake data, read-only pages: nothing here writes through the app.
// Run on Chromium at 390 and, on an owned stack, on a WebKit iPhone 13 project (the engine behind iPhone Safari; NOT real Safari, NOT a device).
// ===========================================================================

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const T = 20_000;
const SHOTS = process.env.OVERVIEW_SHOT_DIR;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${test.info().project.name}.png` });
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY = 86_400_000;

async function currency(seed: E2eSeed) {
  await sql(
    `insert into public.studio_payment_jurisdictions (studio_id, payment_country, payment_currency, source, verification_reference) values ($1,'CA','cad','operator','synthetic overview proof')`,
    [seed.studioId],
  );
}

/** A completed visit with a recorded cash payment, at `startsAt` (a Date). */
async function paidVisit(seed: E2eSeed, prac: string, label: string, startsAt: Date, cents: number) {
  const { clientId } = await seedE2eDashboardClient(seed, { label });
  const serviceId = randomUUID();
  await sql(`insert into public.services (id, studio_id, name, modality, default_duration_minutes, price_cents, active) values ($1,$2,$3,'electrolysis',60,$4,true)`, [serviceId, seed.studioId, `${label} service`, cents]);
  const apptId = randomUUID();
  const ends = new Date(startsAt.getTime() + 3_600_000).toISOString();
  await sql(
    `insert into public.appointments (id, studio_id, client_id, practitioner_id, service_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
     values ($1,$2,$3,$4,$5,$6,$7,60,0,$7,'completed')`,
    [apptId, seed.studioId, clientId, prac, serviceId, startsAt.toISOString(), ends],
  );
  await sql(
    `insert into public.appointment_settlements (studio_id, appointment_id, method, amount_cents, currency, quoted_amount_cents, recorded_by_practitioner_id) values ($1,$2,'paid_cash',$3,'cad',$4,$5)`,
    [seed.studioId, apptId, cents, cents, prac],
  );
}

const hero = (page: Page) => page.getByTestId("overview-hero");
const collected = (page: Page) => page.getByTestId("overview-collected");
const q = (page: Page) => new URL(page.url()).searchParams;

/** Everything the page says about the money, in one comparable string. */
async function figures(page: Page) {
  const read = async (id: string) => (await page.getByTestId(id).innerText()).replace(/\s+/g, " ").trim();
  return [await read("overview-collected"), await read("overview-comparison"), await read("overview-period-text"), await read("overview-visits"), await read("overview-clients"), await read("overview-average")].join(" | ");
}

async function expectNoSideways(page: Page, label: string) {
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s, `${label}: no horizontal overflow (${w.s} vs ${w.c})`).toBeLessThanOrEqual(w.c);
}

test.describe("Business → Overview on a phone", () => {
  test("an active studio: first-screen figures, period in the address, Overview → Statements → Back", async ({ page }) => {
    const now = new Date();
    test.skip(now.getUTCDate() === 1 && now.getUTCHours() < 6, "the first hours of a month have no 'earlier this month' to seed");
    const seed = await seedE2eStudio();
    await currency(seed);
    const prac = await getOwnerPractitionerId(seed.studioId);
    const lastMonthMid = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 15, 0, 0));
    // Last month: $210.00 + $65.50 = $275.50. This month: $90.00, earlier today (in the past, in this month).
    await paidVisit(seed, prac, "Last A", lastMonthMid, 21000);
    await paidVisit(seed, prac, "Last B", new Date(lastMonthMid.getTime() + DAY), 6550);
    await paidVisit(seed, prac, "This", new Date(now.getTime() - 2 * 3_600_000), 9000);

    await loginAsOwner(page, seed);

    // Business menu → Overview. On a phone the Business group is in the menu sheet.
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page).toHaveURL(/\/financials\/overview$/);
    await expect(page.getByRole("heading", { name: "Business overview", level: 1 })).toBeVisible({ timeout: T });

    // FIRST SCREEN: the hero figure and its comparison are in the 390 x 844 viewport at once, with no scrolling and no loading state.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(collected(page)).toHaveText(/\$90/);
    const vp = page.viewportSize()!;
    for (const id of ["overview-collected", "overview-comparison", "overview-period-text"]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.y, `${id} starts inside the first screen`).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, `${id} ends inside the first screen (${vp.height})`).toBeLessThanOrEqual(vp.height);
    }
    await expect(page.locator('[aria-busy="true"], [role="progressbar"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Month to date" }).or(page.locator('[data-period="month_to_date"]'))).toBeVisible();
    await expectNoSideways(page, "Overview");
    await shot(page, "overview-fold-active");

    // Select Last month: the address carries it, the figures are last month's.
    await page.locator('[data-period="previous_month"]').click();
    await expect.poll(() => q(page).get("period"), { timeout: T }).toBe("previous_month");
    await expect(collected(page)).toHaveText(/\$275\.50/, { timeout: T });
    await expect(page.locator('[data-period="previous_month"]')).toHaveAttribute("aria-current", "true");
    const before = await figures(page);
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const lastLabel = `${MONTHS[lastMonth.getUTCMonth()]} ${lastMonth.getUTCFullYear()}`;
    const ym = `${lastMonth.getUTCFullYear()}-${String(lastMonth.getUTCMonth() + 1).padStart(2, "0")}`;

    // Overview → Statements opens that month, and its total is the Overview's figure.
    await page.getByTestId("overview-open-statement").click();
    await expect(page).toHaveURL(new RegExp(`/financials/statement\\?month=${ym}$`), { timeout: T });
    await expect(page.getByRole("main")).toContainText(lastLabel, { timeout: T });
    await expect(page.getByRole("main")).toContainText("275.50", { timeout: T });

    // Back: Overview again, Last month still selected, the same figures.
    await page.goBack();
    await expect(page).toHaveURL(/\/financials\/overview\?period=previous_month$/, { timeout: T });
    await expect(page.locator('[data-period="previous_month"]')).toHaveAttribute("aria-current", "true", { timeout: T });
    await expect(collected(page)).toHaveText(/\$275\.50/, { timeout: T });
    expect(await figures(page)).toBe(before);
    await shot(page, "overview-last-month-after-back");

    // Choose month: a month picked in the field is kept in the address.
    const picker = page.locator('[data-period="month"] input[type="month"]');
    await picker.fill(ym);
    // last month is the named period, so it folds into Last month: one window, one address
    await expect.poll(() => q(page).get("period"), { timeout: T }).toBe("previous_month");

    // Reload keeps the period too.
    await page.reload();
    await expect(page.locator('[data-period="previous_month"]')).toHaveAttribute("aria-current", "true", { timeout: T });
    expect(await figures(page)).toBe(before);
  });

  test("a studio with no activity: a genuine $0 and a figure that is Not available, each shown as what it is", async ({ page }) => {
    const seed = await seedE2eStudio();
    await currency(seed);
    await loginAsOwner(page, seed);
    await page.goto("/financials/overview");
    await expect(page.getByRole("heading", { name: "Business overview", level: 1 })).toBeVisible({ timeout: T });

    await expect(collected(page)).toHaveText(/\$0\b/);
    await expect(collected(page)).toHaveAttribute("data-cents", "0");
    await expect(page.getByTestId("overview-visits")).toContainText("0");
    await expect(page.getByTestId("overview-clients")).toContainText("0");
    // The average of nothing is not $0.
    await expect(page.getByTestId("overview-average")).toContainText("Not available");
    await expect(page.getByTestId("overview-average")).not.toContainText("$");
    // The follow-up figures that are not connected yet say so; none is a number.
    await expect(page.locator('[data-figure-state="unavailable"]').first()).toBeVisible();
    const vp = page.viewportSize()!;
    const box = (await collected(page).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
    await expectNoSideways(page, "zero-activity Overview");
    await shot(page, "overview-fold-zero-activity");
  });

  test("a practitioner who is not the owner gets the owner-only refusal and no figures", async ({ page }) => {
    const seed = await seedE2eStudio();
    await currency(seed);
    const member = await seedE2eMember(seed);
    await loginByMagicLink(page, member.email);
    await page.goto("/financials/overview");
    await expect(page.getByRole("main")).toContainText("Only the studio owner", { timeout: T });
    await expect(page.getByTestId("overview-hero")).toHaveCount(0);
    await expect(page.getByTestId("overview-collected")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A visit in LAST month, unpaid, then paid in full THIS month (the receipt date is this month). The server's clock is the real one, so "last month" and
// "this month" are relative to it (it reads October / November on 26 Nov 2026); the names are derived, never typed, so the case is stable on any day.
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * WHICH DATE EACH PAGE GROUPS MONEY BY. Totals are compared across pages ONLY when they share a basis: comparing a visit-date figure with a
 * received-date figure is comparing two different questions and would "fail" for a payment made in a later month than its visit. Overview and Analytics
 * group by VISIT date. Statements groups by the visit's month TODAY (its rows are the month's visits; no receipt date is stored or shown anywhere on it).
 * When Statements adopts the date the money was RECEIVED, this ONE constant changes to "received_date" and the Statements expectations below flip.
 */
type Basis = "visit_date" | "received_date";
const BASIS: Record<"overview" | "analytics" | "statements", Basis> = { overview: "visit_date", analytics: "visit_date", statements: "visit_date" };
function comparable(a: keyof typeof BASIS, b: keyof typeof BASIS): boolean {
  return BASIS[a] === BASIS[b];
}

/** Run settlement commands AS THE OWNER, through the real authority boundary (the command re-derives the actor from auth.uid()). Ids are ours, never input. */
async function asOwner(seed: E2eSeed, body: string) {
  await sql(
    `do $do$ declare uid uuid; begin
       select id into uid from auth.users where email = '${seed.ownerEmail}';
       perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
       set local role authenticated;
       ${body}
     end $do$`,
  );
}

test("a visit last month, unpaid then paid in full this month: it is last month's collection, owed until confirmed, and never this month's", async ({ page }) => {
  const now = new Date();
  test.skip(now.getUTCDate() === 1 && now.getUTCHours() < 6, "the first hours of a month have no 'earlier this month' to seed");
  const seed = await seedE2eStudio();
  await currency(seed);
  const prac = await getOwnerPractitionerId(seed.studioId);
  const visitAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 15, 0, 0));
  const { clientId } = await seedE2eDashboardClient(seed, { label: "Cross month" });
  const serviceId = randomUUID();
  await sql(`insert into public.services (id, studio_id, name, modality, default_duration_minutes, price_cents, active) values ($1,$2,'Cross month service','electrolysis',60,12000,true)`, [serviceId, seed.studioId]);
  const apptId = randomUUID();
  await sql(
    `insert into public.appointments (id, studio_id, client_id, practitioner_id, service_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
     values ($1,$2,$3,$4,$5,$6,$7,60,0,$7,'completed')`,
    [apptId, seed.studioId, clientId, prac, serviceId, visitAt.toISOString(), new Date(visitAt.getTime() + 3_600_000).toISOString()],
  );
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastYm = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, "0")}`;
  const thisYm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const lastName = MONTHS[last.getUTCMonth()];
  const clientStatement = `/financials/statements/${clientId}?month=${lastYm}`;

  // BEFORE: the owner attested the visit still owes (a recorded quote of $120.00).
  await asOwner(seed, `perform public.record_appointment_settlement('${seed.studioId}', '${apptId}', 'still_owes', 12000, null, false);`);
  await loginAsOwner(page, seed);
  await page.goto(clientStatement);
  await expect(page.getByRole("main")).toContainText("Not paid", { timeout: T });
  await expect(page.getByRole("main")).toContainText("120.00", { timeout: T }); // the balance due
  await expect(page.getByRole("main")).not.toContainText("Paid in full");
  // Overview's Money owed tile is not connected yet: it says Not available, never a stale or partial number.
  await page.goto("/financials/overview?period=previous_month");
  const owedTile = page.locator('[data-figure-state="unavailable"]').filter({ hasText: "Money owed" });
  await expect(owedTile).toContainText("Not available");
  await expect(owedTile).not.toContainText("$");

  // AFTER: paid in full, received now (this month), through the real supersede command.
  await asOwner(
    seed,
    `perform public.supersede_appointment_settlement('${seed.studioId}', (select id from public.appointment_settlements where appointment_id = '${apptId}' and superseded_at is null), 'paid_cash', 12000, 'Paid in full', null, false);`,
  );
  const receipt = (await sql<{ d: string }>(`select to_char(recorded_at at time zone 'UTC', 'YYYY-MM') as d from public.appointment_settlements where appointment_id = $1 and superseded_at is null`, [apptId]))[0].d;
  expect(receipt, "the payment was received THIS month, the visit was LAST month").toBe(thisYm);

  // The balance clears where Money owed is shown today: the visit's own month on the client statement.
  await page.goto(clientStatement);
  await expect(page.getByRole("main")).toContainText("Paid", { timeout: T });
  await expect(page.getByRole("main")).not.toContainText("Not paid");
  await expect(page.getByRole("main")).not.toContainText("Balance due");
  await page.goto("/financials/overview?period=previous_month");
  await expect(owedTile).toContainText("Not available");

  // OVERVIEW, last month: the payment is counted under the VISIT's month, under the headline that says so.
  await expect(page.getByRole("heading", { name: `Collected for visits in ${lastName}` })).toBeVisible({ timeout: T });
  await expect(collected(page)).toHaveText(/\$120\b/, { timeout: T });
  await shot(page, "overview-cross-month-last");
  // ...and NOT this month's, although the money arrived this month.
  await page.goto("/financials/overview");
  await expect(page.getByRole("heading", { name: "Collected for visits this month" })).toBeVisible({ timeout: T });
  await expect(collected(page)).toHaveAttribute("data-cents", "0");

  // CROSS-PAGE TOTALS, only between pages that share a date basis.
  expect(comparable("overview", "analytics")).toBe(true);
  await page.goto("/financials/analytics?period=previous_month");
  await expect(page.getByRole("main")).toContainText("$120.00", { timeout: T }); // Analytics' visit-date figure = Overview's
  if (comparable("overview", "statements")) {
    // Statements groups by the visit's month today: last month's statement holds it, this month's does not.
    await page.goto(`/financials/statement?month=${lastYm}`);
    await expect(page.getByRole("main")).toContainText("120.00", { timeout: T });
    await page.goto(`/financials/statement?month=${thisYm}`);
    await expect(page.getByRole("main")).toContainText("Collected in total: $0.00", { timeout: T });
  } else {
    // Statements by RECEIVED date: the payment is in this month's statement and not last month's. Overview legitimately differs.
    await page.goto(`/financials/statement?month=${thisYm}`);
    await expect(page.getByRole("main")).toContainText("120.00", { timeout: T });
    await page.goto(`/financials/statement?month=${lastYm}`);
    await expect(page.getByRole("main")).toContainText("Collected in total: $0.00", { timeout: T });
  }
});
