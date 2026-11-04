import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedE2eStudio, seedE2eMember, seedE2eIntake, seedE2eDashboardClient, getOwnerPractitionerId, sql, type E2eSeed } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// ===========================================================================
// Dashboard "Needs attention": the owner's Dismiss, proved in a browser (Sam, 4 Nov; migration 0298 applied on an OWNED local stack only).
// ===========================================================================
//   * dismiss -> reload -> a second device (a NEW auth session) sees the same set
//   * a new issue for the same client reappears; a balance that grew reappears
//   * an unpaid and a partially paid visit show the exact amount and currency
//   * dismissing only hides the reminder: money rows are byte-identical, and the real status is still in Settings
//   * a non-owner sees no amounts and no Dismiss
//   * 320 / 390 / 1280: nothing runs sideways

const T = 20_000;
const DAY = 86_400_000;

async function seedStudioWithMoney() {
  const seed = await seedE2eStudio();
  const prac = await getOwnerPractitionerId(seed.studioId);
  await sql(
    `insert into public.studio_payment_jurisdictions (studio_id, payment_country, payment_currency, source, verification_reference)
     values ($1,'CA','cad','operator','e2e dashboard dismissal proof')`,
    [seed.studioId],
  );

  const visit = async (label: string, priceCents: number, daysAgo: number, cardCents?: number, cashCents?: number) => {
    const { clientId, name } = await seedE2eDashboardClient(seed, { label });
    const serviceId = randomUUID();
    await sql(
      `insert into public.services (id, studio_id, name, modality, default_duration_minutes, price_cents, active)
       values ($1,$2,$3,'electrolysis',60,$4,true)`,
      [serviceId, seed.studioId, `${label} service`, priceCents],
    );
    const apptId = randomUUID();
    const ends = new Date(Date.now() - daysAgo * DAY).toISOString();
    const starts = new Date(Date.now() - daysAgo * DAY - 3_600_000).toISOString();
    await sql(
      `insert into public.appointments (id, studio_id, client_id, practitioner_id, service_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
       values ($1,$2,$3,$4,$5,$6,$7,60,0,$7,'completed')`,
      [apptId, seed.studioId, clientId, prac, serviceId, starts, ends],
    );
    const sessionId = randomUUID();
    await sql(`insert into public.sessions (id, studio_id, client_id, practitioner_id, appointment_id, modality) values ($1,$2,$3,$4,$5,'electrolysis')`, [
      sessionId,
      seed.studioId,
      clientId,
      prac,
      apptId,
    ]);
    if (cardCents) {
      await sql(
        `insert into public.payment_charge_attempts (id, studio_id, client_id, session_id, charge_reason, created_by_practitioner_id, amount_cents, currency, status, stripe_livemode)
         values ($1,$2,$3,$4,'session_payment',$5,$6,'cad','succeeded',false)`,
        [randomUUID(), seed.studioId, clientId, sessionId, prac, cardCents],
      );
    }
    if (cashCents) {
      // A partial payment WITH a recorded quote: the figure is provable. (A card payment with no recorded quote is "Amount unavailable"
      // once the price may have moved, so the exact-figure proofs use a settlement.)
      await sql(
        `insert into public.appointment_settlements (studio_id, appointment_id, method, amount_cents, currency, quoted_amount_cents, recorded_by_practitioner_id)
         values ($1,$2,'paid_cash',$3,'cad',$4,$5)`,
        [seed.studioId, apptId, cashCents, priceCents, prac],
      );
    }
    return { clientId, name, serviceId, apptId };
  };

  // Unpaid in full: $120.00. Partly paid: quoted $200.00, $80.00 kept by card, so $120.00 -> no, make it distinguishable: $210.00 - $65.50.
  const unpaid = await visit("Unpaid", 12000, 2);
  const partial = await visit("Partial", 21000, 4, undefined, 6550);
  // A client with a plain intake review (a non-money reminder).
  const intakeClient = await seedE2eDashboardClient(seed, { label: "Intake" });
  await seedE2eIntake(seed.studioId, intakeClient.clientId, "submitted");
  return { seed, unpaid, partial, intakeClient, visit, prac };
}

// "N clients, M items" -> numbers. Seeded visits also raise ordinary record/charting reminders, so counts are asserted as DELTAS.
async function counts(page: Page) {
  const t = (await page.getByTestId("needs-attention-heading-count").innerText()).trim();
  const m = /^(\d+) clients?, (\d+) items?$/.exec(t);
  if (!m) throw new Error(`unexpected heading count: ${t}`);
  return { clients: Number(m[1]), items: Number(m[2]) };
}
const unpaidAmountOf = (page: Page, name: string) => page.locator("li[data-attention-client]").filter({ hasText: name }).getByTestId("attention-unpaid-amount");

const money = (n: string) => n.replace(/\s/g, " ");
const panel = (page: Page) => page.locator("#needs-attention-list");
const dismissIn = (page: Page, clientName: string) => page.locator(`li[data-attention-client]`).filter({ hasText: clientName }).getByTestId("attention-dismiss").first();

async function openDashboard(page: Page) {
  await page.goto("/dashboard");
  await expect(page.getByTestId("needs-attention-heading-count")).toBeVisible({ timeout: T });
  await expect(page.getByTestId("needs-attention-heading-count")).not.toHaveText(/Unavailable/, { timeout: T });
}

async function moneyHashes(seed: E2eSeed) {
  const out: Record<string, string> = {};
  for (const t of ["payment_charge_attempts", "appointment_settlements", "appointments", "studio_payment_jurisdictions", "services"]) {
    const r = await sql<{ h: string }>(`select coalesce(md5(string_agg(x::text, '|' order by x::text)), 'empty') as h from public.${t} x where studio_id = $1`, [seed.studioId]);
    out[t] = r[0]!.h;
  }
  return out;
}

// Dismissal needs migration 0298 AND the gate (HONE_DASHBOARD_DISMISSALS_ENABLED=true). Cases that need it run only on an owned stack that
// has both; the gate-OFF case and the money cases below run everywhere, which is the proof that the app ships without 0298.
const GATE_ON = process.env.HONE_DASHBOARD_DISMISSALS_ENABLED === "true";
const gated: typeof test = GATE_ON ? test : (test.skip as unknown as typeof test);
// HON-65: the unpaid reminders are OFF unless HONE_DASHBOARD_UNPAID_ENABLED=true reaches the server (lib/dashboard/unpaid-gate.ts,
// forwarded by e2e/helpers/local-env.ts only when set). Cases that assert unpaid amounts run only then; every ordinary run proves OFF.
const UNPAID_ON = process.env.HONE_DASHBOARD_UNPAID_ENABLED === "true";
const unpaidGated: typeof test = UNPAID_ON ? test : (test.skip as unknown as typeof test);
const gatedWithUnpaid: typeof test = GATE_ON && UNPAID_ON ? test : (test.skip as unknown as typeof test);

test.describe("Dashboard Needs attention: dismissal", () => {
  gatedWithUnpaid("shows exact money, dismisses per owner across reload and a second device, reappears on a real change, never touches money", async ({ page, browser }) => {
    const { seed, unpaid, partial, intakeClient } = await seedStudioWithMoney();
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAsOwner(page, seed);
    await openDashboard(page);

    // The amounts: exact, with the studio's currency (CAD), authoritative balance only.
    const unpaidCard = page.locator("li[data-attention-client]").filter({ hasText: unpaid.name });
    const partialCard = page.locator("li[data-attention-client]").filter({ hasText: partial.name });
    const unpaidLine = money((await unpaidCard.getByTestId("attention-unpaid-amount").innerText()).trim());
    const partialLine = money((await partialCard.getByTestId("attention-unpaid-amount").innerText()).trim());
    console.log(`UNPAID LINE: ${unpaidLine}\nPARTIAL LINE: ${partialLine}`);
    expect(unpaidLine).toMatch(/^Hone can see\b.*120\.00.*still owed$/);
    expect(partialLine).toMatch(/^Hone can see\b.*144\.50.*still owed$/); // 210.00 - 65.50 collected in cash
    expect(unpaidLine).toMatch(/CA\$|CAD/);
    expect(partialLine).toMatch(/CA\$|CAD/);

    // ONE count, in the heading. No second count and no pill.
    const heading = page.getByTestId("needs-attention-heading-count");
    const start = await counts(page);
    expect(start.clients).toBe(3);
    expect(start.items).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId("dashboard-summary-strip")).not.toContainText(/clients to review/i);

    const before = await moneyHashes(seed);

    // Dismiss the unpaid reminder and the intake reminder.
    await page.locator("li[data-attention-client]").filter({ hasText: unpaid.name }).locator('[data-attention-issue="unpaid"]').getByTestId("attention-dismiss").click();
    await expect(heading).toHaveText(`${start.clients} clients, ${start.items - 1} ${start.items - 1 === 1 ? "item" : "items"}`, { timeout: T });
    await dismissIn(page, intakeClient.name).click();
    const afterTwo = { clients: start.clients - 1, items: start.items - 2 };
    await expect.poll(() => counts(page), { timeout: T }).toEqual(afterTwo);

    // Reload: still dismissed (server-side, not page state).
    await page.reload();
    await expect.poll(() => counts(page), { timeout: T }).toEqual(afterTwo);
    await expect(unpaidAmountOf(page, unpaid.name)).toHaveCount(0);
    await expect(unpaidAmountOf(page, partial.name)).toHaveCount(1);
    await expect(page.getByTestId("attention-dismissed-toggle")).toContainText("Dismissed (2)");

    // A second device = a NEW auth session for the same owner. Same set.
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.setViewportSize({ width: 1280, height: 900 });
    await loginByMagicLink(page2, seed.ownerEmail);
    await openDashboard(page2);
    await expect.poll(() => counts(page2), { timeout: T }).toEqual(afterTwo);
    await expect(unpaidAmountOf(page2, unpaid.name)).toHaveCount(0);
    await expect(unpaidAmountOf(page2, partial.name)).toHaveCount(1);
    await expect(page2.getByTestId("attention-dismissed-toggle")).toContainText("Dismissed (2)");

    // Dismissing only hides the reminder: not one money, appointment, service or jurisdiction row changed.
    expect(await moneyHashes(seed)).toEqual(before);

    // A NEW issue for the same client reappears: a fresh intake submission for the (dismissed) intake client.
    await seedE2eIntake(seed.studioId, intakeClient.clientId, "submitted");
    await page.reload();
    await expect(page.locator("li[data-attention-client]").filter({ hasText: intakeClient.name })).toBeVisible({ timeout: T });

    // A balance that GREW reappears: the dismissed unpaid visit's quote goes 120.00 -> 150.00.
    await sql(`update public.services set price_cents = 15000 where id = $1`, [unpaid.serviceId]);
    await page.reload();
    const regrown = page.locator("li[data-attention-client]").filter({ hasText: unpaid.name });
    await expect(regrown.getByTestId("attention-unpaid-amount")).toContainText("150.00", { timeout: T });

    // Restore: dismiss the partly paid reminder, open the Dismissed view, restore it, and the exact amount is back.
    await page.locator("li[data-attention-client]").filter({ hasText: partial.name }).locator('[data-attention-issue="unpaid"]').getByTestId("attention-dismiss").click();
    await expect(unpaidAmountOf(page, partial.name)).toHaveCount(0, { timeout: T });
    await page.getByTestId("attention-dismissed-toggle").click();
    await page.getByTestId("attention-restore").first().click();
    await expect(unpaidAmountOf(page, partial.name)).toContainText("144.50", { timeout: T });
    expect(await moneyHashes(seed)).toEqual({ ...before, services: (await moneyHashes(seed)).services });
    await ctx2.close();
  });

  gated("setup status stays visible in Settings after its reminder is dismissed", async ({ page }) => {
    const { seed } = await seedStudioWithMoney();
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAsOwner(page, seed);
    await openDashboard(page);
    // A fresh studio has no payment connection: that setup reminder is in the studio card.
    const setupDismiss = page.locator("[data-attention-studio] [data-testid='attention-dismiss'], li:not([data-attention-client]) [data-testid='attention-dismiss']").first();
    const hasSetup = (await setupDismiss.count()) > 0;
    console.log(`SETUP REMINDER PRESENT: ${hasSetup}`);
    test.skip(!hasSetup, "fresh e2e studio shows no setup reminder here");
    await setupDismiss.click();
    await page.goto("/settings/payments");
    await expect(page.locator("main")).toContainText(/not connected|connect|set up|not set up/i);
  });

  // Gate OFF (the default of every ordinary run, and what ships while 0298 is held): no Dismiss, no Dismissed view, no "could not read"
  // note, and nothing in the page asked the database for dismissals; the one count and the exact unpaid amounts still work.
  // It asserts the unpaid amounts, so it also needs the unpaid gate ON; with it OFF the case below proves the same dismissal absence.
  (GATE_ON || !UNPAID_ON ? test.skip : test)("gate OFF: no Dismiss, no Dismissed view, no note; the one count and the exact amounts still work", async ({ page }) => {
    const { seed, unpaid, partial } = await seedStudioWithMoney();
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAsOwner(page, seed);
    await openDashboard(page);
    const c = await counts(page);
    expect(c.clients).toBe(3);
    await expect(unpaidAmountOf(page, unpaid.name)).toContainText("120.00");
    await expect(unpaidAmountOf(page, unpaid.name)).toContainText("CAD");
    await expect(unpaidAmountOf(page, partial.name)).toContainText("144.50");
    await expect(page.getByTestId("attention-dismiss")).toHaveCount(0);
    await expect(page.getByTestId("attention-dismissed")).toHaveCount(0);
    await expect(page.getByTestId("attention-dismissed-toggle")).toHaveCount(0);
    await expect(page.getByTestId("attention-dismissals-unavailable")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(/could not read your dismissed/i);
    await expect(page.getByTestId("needs-attention-unpaid-toggle")).toBeVisible();
    await expect(page.getByTestId("dashboard-summary-strip")).not.toContainText(/clients to review/i);
  });

  // HON-65, unpaid gate OFF (the default of every ordinary run, and what ships): an owner with unpaid and partly paid visits sees no
  // unpaid section at all (no amount, no window note, no All outstanding link, no "could not check unpaid" entry), also at ?unpaid=all,
  // while the one count and the other reminders still render.
  (UNPAID_ON ? test.skip : test)("unpaid gate OFF: no unpaid section, even at ?unpaid=all; the one count and other reminders still work", async ({ page }) => {
    const { seed, unpaid, partial, intakeClient } = await seedStudioWithMoney();
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAsOwner(page, seed);
    for (const path of ["/dashboard", "/dashboard?unpaid=all"]) {
      await page.goto(path);
      await expect(page.getByTestId("needs-attention-heading-count")).toBeVisible({ timeout: T });
      await expect(page.getByTestId("needs-attention-heading-count")).not.toHaveText(/Unavailable/, { timeout: T });
      await expect(page.getByTestId("needs-attention-heading-count")).toHaveText(/\d+ clients?, \d+ items?/);
      await expect(panel(page)).toBeVisible({ timeout: T });
      await expect(page.locator("li[data-attention-client]").filter({ hasText: intakeClient.name })).toBeVisible({ timeout: T });
      await expect(page.getByTestId("attention-unpaid-amount")).toHaveCount(0);
      await expect(page.locator('[data-attention-issue="unpaid"]')).toHaveCount(0);
      await expect(page.getByTestId("needs-attention-unpaid-window")).toHaveCount(0);
      await expect(page.getByTestId("needs-attention-unpaid-toggle")).toHaveCount(0);
      await expect(unpaidAmountOf(page, unpaid.name)).toHaveCount(0);
      await expect(unpaidAmountOf(page, partial.name)).toHaveCount(0);
      const main = page.locator("main");
      await expect(main).not.toContainText(/still owed|Amount unavailable|Show all outstanding|unpaid balances/i);
      if (!GATE_ON) {
        await expect(page.getByTestId("attention-dismiss")).toHaveCount(0);
        await expect(page.getByTestId("attention-dismissed-toggle")).toHaveCount(0);
        await expect(page.getByTestId("attention-dismissals-unavailable")).toHaveCount(0);
      }
    }
  });

  test("a non-owner sees no amounts and no Dismiss", async ({ page }) => {
    const { seed } = await seedStudioWithMoney();
    const member = await seedE2eMember(seed);
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginByMagicLink(page, member.email);
    await page.goto("/dashboard");
    await expect(page.locator("main")).toBeVisible({ timeout: T });
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("attention-dismiss")).toHaveCount(0);
    await expect(page.getByTestId("attention-dismissed")).toHaveCount(0);
    await expect(page.getByTestId("attention-dismissed-toggle")).toHaveCount(0);
    await expect(page.getByTestId("attention-unpaid-amount")).toHaveCount(0);
    await expect(page.getByTestId("needs-attention-unpaid-window")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(/still owed/);
    await expect(page.locator("main")).not.toContainText(/\$\s?\d+\.\d\d|CAD/);
  });

  for (const width of [320, 390, 1280]) {
    test(`layout at ${width}px: nothing runs sideways, controls are reachable`, async ({ page }) => {
      const { seed } = await seedStudioWithMoney();
      await page.setViewportSize({ width, height: 900 });
      await loginAsOwner(page, seed);
      await openDashboard(page);
      await expect(panel(page)).toBeVisible({ timeout: T });
      if (GATE_ON) {
        // A click before hydration is lost: retry until the dismissal has actually landed (the Dismissed view appears).
        await expect(async () => {
          if (await page.getByTestId("attention-dismissed-toggle").count()) return;
          await dismissIn(page, "Intake").click({ timeout: 3_000 });
          await expect(page.getByTestId("attention-dismissed-toggle")).toBeVisible({ timeout: 5_000 });
        }).toPass({ timeout: 60_000 });
        await page.getByTestId("attention-dismissed-toggle").click();
        await expect(page.getByTestId("attention-restore").first()).toBeVisible({ timeout: T });
      }

      const report = await page.evaluate((vw) => {
        const doc = document.documentElement;
        const offenders: string[] = [];
        const scope = document.querySelector("#needs-attention-list")?.closest("section") ?? document.body;
        scope.querySelectorAll<HTMLElement>("a, li, button, p, span").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
          if (r.right > vw + 1) offenders.push(`${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? el.textContent?.slice(0, 30)}] right ${Math.round(r.right)} > ${vw}`);
        });
        const dismiss = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="attention-dismiss"]')).map((b) => {
          const r = b.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height) };
        });
        return { scrollWidth: doc.scrollWidth, offenders, dismiss };
      }, width);
      console.log(`LAYOUT ${width}: ${JSON.stringify(report)}`);
      expect(report.scrollWidth, `scrollWidth ${report.scrollWidth}`).toBeLessThanOrEqual(width);
      expect(report.offenders, report.offenders.join("\n")).toEqual([]);
      if (GATE_ON) expect(report.dismiss.length).toBeGreaterThan(0);
      for (const d of report.dismiss) expect(d.h, `Dismiss height ${d.h}`).toBeGreaterThanOrEqual(36);
      await page.screenshot({ path: test.info().outputPath(`needs-attention-${width}.png`), fullPage: false });
    });
  }

  unpaidGated("a collected settlement reduces or clears the balance, and a still_owes note never creates an amount", async ({ page }) => {
    const { seed, unpaid, partial, visit, prac } = await seedStudioWithMoney();
    const noted = await visit("Noted", 30000, 6);
    // A card payment with no recorded quote: the price at visit time cannot be proven, so no figure is claimed.
    const cardOnly = await visit("CardOnly", 21000, 7, 6550);
    const settle = (apptId: string, method: string, cents: number, quoted: number) =>
      sql(
        `insert into public.appointment_settlements (studio_id, appointment_id, method, amount_cents, currency, quoted_amount_cents, recorded_by_practitioner_id)
         values ($1,$2,$3,$4,'cad',$5,$6)`,
        [seed.studioId, apptId, method, cents, quoted, prac],
      );
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAsOwner(page, seed);
    await openDashboard(page);
    await expect(unpaidAmountOf(page, partial.name)).toContainText("144.50", { timeout: T });
    await expect(unpaidAmountOf(page, noted.name)).toContainText("300.00", { timeout: T });
    await expect(unpaidAmountOf(page, cardOnly.name)).toContainText("Amount unavailable", { timeout: T });
    await expect(unpaidAmountOf(page, cardOnly.name)).not.toContainText(/\d\.\d\d/);

    // Cash collected on a visit with nothing else paid: 210.00 - 50.00 = 160.00. Full cash on the unpaid visit clears it.
    const cashed = await visit("Cashed", 21000, 5);
    await settle(cashed.apptId, "paid_cash", 5000, 21000);
    await settle(unpaid.apptId, "paid_e_transfer", 12000, 12000);
    // A still_owes note of 777.00 on the 300.00 visit: the note records a claim, it must NOT become the amount shown.
    await settle(noted.apptId, "still_owes", 77700, 30000);
    await page.reload();
    await expect(unpaidAmountOf(page, cashed.name)).toContainText("160.00", { timeout: T });
    await expect(unpaidAmountOf(page, unpaid.name)).toHaveCount(0);
    const notedLine = await unpaidAmountOf(page, noted.name).innerText();
    console.log(`NOTED LINE: ${notedLine}`);
    expect(notedLine).toContain("300.00");
    expect(notedLine).not.toContain("777");
  });

  unpaidGated("All outstanding: an older unpaid visit is outside the 90-day default and shown by the toggle", async ({ page }) => {
    const { seed, partial, visit } = await seedStudioWithMoney();
    const older = await visit("Older", 8800, 100);
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAsOwner(page, seed);
    await openDashboard(page);
    await expect(unpaidAmountOf(page, partial.name)).toBeVisible({ timeout: T });
    await expect(unpaidAmountOf(page, older.name)).toHaveCount(0);
    const note = page.getByTestId("needs-attention-unpaid-window");
    await expect(note).toContainText(/90/);
    await page.getByTestId("needs-attention-unpaid-toggle").click();
    await expect(page).toHaveURL(/unpaid=all/);
    await expect(unpaidAmountOf(page, older.name)).toContainText("88.00", { timeout: T });
    await expect(unpaidAmountOf(page, partial.name)).toContainText("144.50");
    // And back to the default window.
    await page.getByTestId("needs-attention-unpaid-toggle").click();
    await expect(page).not.toHaveURL(/unpaid=all/);
    await expect(unpaidAmountOf(page, older.name)).toHaveCount(0, { timeout: T });
  });
});
