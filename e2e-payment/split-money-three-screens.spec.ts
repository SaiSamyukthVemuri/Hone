import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loginAsOwner } from "../e2e/helpers/flows";
import { seedEligiblePaymentWithLogin, cleanupPaymentScenario, adminQuery, closePool, type PaymentSeed } from "./helpers/payment-fixture";
import { resetFakeStripeLedger, clearFakeStripeOutcome, cleanupFakeStripeLedger } from "./helpers/fake-stripe-ledger-e2e";
import { openCheckout } from "./helpers/checkout-flow";

// ===========================================================================
// One visit, three screens, the same three numbers (HON-123 / HON-122, Sam's acceptance).
// ===========================================================================
// $225 visit: $100 card, $50 cash, $75 transfer, then a $40 partial refund on the card. CHECKOUT, the VISIT page and the STATEMENT must each read
// Collected $225.00, Refunded $40.00, Net $185.00, with those labels, and agree with the database (payment_refund_money and the bill).
//
// LIVE-MODE NOTE. The fake-Stripe lane runs in TEST mode (stripe_livemode = false on the card attempt), and the statement deliberately counts only live-mode card money.
// No existing statement e2e seeds a live card attempt, so this one flips stripe_livemode on that one card row AFTER the checkout and visit-page checks, and only to read the
// statement. Nothing else about the row changes.

// Optional evidence: with E2E_SHOTS_DIR set, each screen is also saved at 390 wide and desktop. Unset (CI), nothing is written.
async function shots(page: Page, name: string, target?: Locator) {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const [label, vp] of [["390", { width: 390, height: 844 }], ["desktop", { width: 1080, height: 810 }]] as const) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(400);
    writeFileSync(path.join(dir, `${name}-${label}.png`), target ? await target.screenshot().catch(() => page.screenshot({ fullPage: true })) : await page.screenshot({ fullPage: true }));
  }
  await page.setViewportSize({ width: 1080, height: 810 });
}
const money = (c: number) => `$${(c / 100).toFixed(2)} CAD`;
let seed: PaymentSeed;
// Sam, 28 Nov 2026: Still to collect and the visit totals count REAL money only, in every studio, so a Stripe TEST card payment no longer "pays" a visit. The fake-Stripe lane can only make TEST cards, so the
// specs that need a card to count as real money mark that one card live in the database AFTER its charge (and after any refund, which the app only allows in the payment's own mode).
const markCardLive = () => adminQuery(`update public.payment_charge_attempts set stripe_livemode = true where appointment_id = $1`, [seed.appointmentId]);
// A studio with no Stripe connection at all: no settings row, saved card or customer (they are bound to it; a payment that references the saved card is added after, bare).
const neverConnect = async () => {
  for (const t of ["client_payment_methods", "client_stripe_customers", "studio_payment_settings"]) await adminQuery(`delete from public.${t} where studio_id = $1`, [seed.studioId]);
};
// C (Sam, 28 Nov 2026): a studio is LIVE once it has a live-mode Stripe Connect settings row with an account id (no payment needed). Any status counts.
const connectLive = () => adminQuery(
  `insert into public.studio_payment_settings (studio_id, stripe_account_id, stripe_account_status, stripe_charges_enabled, stripe_payouts_enabled, stripe_livemode) values ($1, $2, 'pending', false, false, true)`,
  [seed.studioId, `acct_live_${seed.scenario.runId}`],
);

test.beforeEach(async () => {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
  seed = await seedEligiblePaymentWithLogin({ label: "money3", bookedService: { name: "Three Screens Service", priceCents: 22500 } });
  await adminQuery(`update public.clients set email = $2 where id = $1`, [seed.clientId, `success+money3-${seed.scenario.runId}@harness.local`]);
  await adminQuery(`update public.platform_rollouts set mode = 'pilot' where key = 'split_payments' and mode = 'off'`);
  await adminQuery(`insert into public.platform_rollout_studios (rollout_key, studio_id) values ('split_payments', $1) on conflict do nothing`, [seed.studioId]);
});
test.afterEach(async () => {
  await adminQuery(`delete from public.platform_rollout_studios where rollout_key = 'split_payments' and studio_id = $1`, [seed.studioId]).catch(() => undefined);
  await cleanupPaymentScenario(seed.studioId).catch(() => undefined);
  cleanupFakeStripeLedger();
});
test.afterAll(async () => { await closePool(); });

test("the $225 / $40 / $185 case reads the same on checkout, the visit page and the statement", async ({ page }) => {
  await loginAsOwner(page, seed);
  await page.goto("/dashboard");
  const modal = await openCheckout(page);
  await modal.getByRole("button", { name: "Split this payment", exact: true }).click();
  const panel = modal.getByTestId("split-visit-payments");
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(22500));
  const amount = (v: string) => panel.getByLabel(/^Amount \(CAD\)/).fill(v);
  const pick = (label: string) => panel.getByText(label, { exact: true }).first().click();

  await amount("100.00");
  await panel.getByRole("button", { name: `Charge card ${money(10000)}`, exact: true }).click();
  // CHANGED (Sam, 28 Nov 2026): the card is a Stripe TEST payment, so it does not reduce Still to collect: $225 (was $125).
  await expect.poll(async () => (await adminQuery(`select status from public.payment_charge_attempts where appointment_id = $1`, [seed.appointmentId])).rows[0]?.status, { timeout: 30_000 }).toBe("succeeded");
  await pick("Cash"); await amount("50.00");
  await panel.getByRole("button", { name: `Record cash received ${money(5000)}`, exact: true }).click();
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(17500));   // was $75
  await pick("E-transfer"); await amount("75.00");
  await panel.getByRole("button", { name: `Record transfer ${money(7500)}`, exact: true }).click();
  await expect(panel.getByTestId("split-pending-transfer")).toBeVisible();

  await panel.getByRole("button", { name: "Refund or reduce a payment" }).click();
  const form = panel.getByTestId("split-refund-form");
  await form.getByRole("combobox").selectOption({ index: 0 });
  await form.getByLabel("Refund amount").fill("40.00");
  await form.getByLabel("Reason").fill("Client unhappy with part of the visit");
  // The refund confirmation states the TRUE effect before staff confirm: the visit's balance is not reopened.
  const effect = form.getByTestId("split-refund-effect");
  await expect(effect).toContainText("Refund $40.00 CAD to the card.");
  await expect(effect).toContainText("Balance due stays");
  await expect(effect).not.toContainText(/owe|reopen/i);
  await shots(page, "0-refund-confirmation", form);
  await form.getByRole("button", { name: `Record ${money(4000)} refund`, exact: true }).click();
  await expect.poll(async () => Number((await adminQuery(`select count(*)::int as n from public.payment_refunds where appointment_id = $1 and legacy = false and status = 'succeeded'`, [seed.appointmentId])).rows[0].n), { timeout: 30_000 }).toBe(1);

  // The database's own figures, the authority the three screens must agree with.
  const refundMoney = (await adminQuery(`select * from public.payment_refund_money((select id from public.payment_charge_attempts where appointment_id = $1 limit 1), null)`, [seed.appointmentId])).rows[0];
  expect([Number(refundMoney.payment_cents), Number(refundMoney.succeeded_cents), Number(refundMoney.reserved_cents)]).toEqual([10000, 4000, 0]);
  expect(Number((await adminQuery(`select total_cents from public.visit_bills where appointment_id = $1 and superseded_at is null`, [seed.appointmentId])).rows[0].total_cents)).toBe(22500);

  // While the transfer is still pending it is Waiting, not Collected. CHANGED (Sam, 28 Nov 2026): the card and its refund are TEST entries, so only the $50 cash is collected: $50 / $0 / $50
  // (was $150 / $40 / $110), the $75 transfer is Waiting.
  await expect(panel.getByTestId("money-collected")).toHaveText(money(5000), { timeout: 30_000 });
  await expect(panel.getByTestId("money-refunded")).toHaveText(money(0));
  await expect(panel.getByTestId("money-net")).toHaveText(money(5000));
  await expect(panel.getByTestId("money-waiting")).toHaveText(money(7500));
  // From here the card stands for a real (live) card payment, so the headline $225 / $40 / $185 case is read on a real-money visit. The refund above was made in the payment's own (test) mode.
  await markCardLive();

  // 1. CHECKOUT, in the window where the panel can still be open. A visit that is paid in full has no Checkout button on the roster (the modal belongs to that button and unmounts
  //    with it), so the final $225 / $40 / $185 / $0.00 checkout figures are pinned by tests/components/visit-money-screens.test.ts and the database figures below, not a browser read.
  await expect(panel.getByTestId("split-balance").getByText(/^(Collected|Refunded|Net)$/)).toHaveCount(3);
  await expect(panel.getByTestId("money-refund_pending")).toHaveCount(0);
  await shots(page, "1-checkout-transfer-pending", modal);

  await panel.getByRole("button", { name: `Confirm ${money(7500)} transfer received`, exact: true }).click();
  await expect.poll(async () => (await adminQuery(`select state from public.visit_external_payments where appointment_id = $1 and method = 'paid_e_transfer'`, [seed.appointmentId])).rows[0]?.state, { timeout: 30_000 }).toBe("confirmed");
  // PRODUCT RULE (Sam, 27 Nov 2026): refunding a fully paid visit does not reopen a balance. The database says nothing is owed.
  expect(Number((await adminQuery(`select outstanding_cents from public.visit_payment_position((select studio_id from public.visit_bills where appointment_id = $1 and superseded_at is null), $1)`, [seed.appointmentId])).rows[0].outstanding_cents)).toBe(0);

  // The roster says Paid for a visit that is paid after the refund, and still offers ONE way back into the payment panel (Manage payments), never a charge button.
  await page.goto("/dashboard");
  await expect(page.getByTestId("appointment-payment-paid")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Checkout", exact: true })).toHaveCount(0);
  const manage = page.getByRole("button", { name: "Manage payments", exact: true });
  await expect(manage).toHaveCount(1);
  await manage.click();
  const reopened = page.getByTestId("split-visit-payments");
  await expect(reopened).toBeVisible();
  await expect(reopened.getByTestId("money-refund-status")).toHaveText("Partially refunded");
  await expect(reopened.getByTestId("split-collectable")).toHaveText(money(0));
  await page.keyboard.press("Escape");

  // 2. VISIT page (owner only), in place of the single card payment's "Paid".
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  const region = page.getByRole("region", { name: "Session payment" });
  await expect(region.getByTestId("visit-money-collected")).toHaveText(money(22500));
  await expect(region.getByTestId("visit-money-refunded")).toHaveText(money(4000));
  await expect(region.getByTestId("visit-money-net")).toHaveText(money(18500));
  await expect(region.getByTestId("visit-money-still_to_collect")).toHaveText(money(0));
  await expect(region.getByText(/^Paid ·/)).toHaveCount(0);
  await expect(region.getByText(/Not paid/i)).toHaveCount(0);
  await shots(page, "2-visit");

  // 3. STATEMENT (the card was marked live above).
  await page.goto(`/financials/statements/${seed.clientId}`);
  await expect(page.getByTestId("statement-money-collected")).toContainText("$225.00");
  await expect(page.getByTestId("statement-money-refunded")).toHaveText("$40.00");
  await expect(page.getByTestId("statement-money-net")).toHaveText("$185.00");
  await expect(page.locator("main")).not.toContainText("Total paid");
  await expect(page.locator("main")).not.toContainText("Not paid"); // the refund did not reopen the visit
  await shots(page, "3-statement");
});

test("a genuinely unpaid bill still shows what is owed: $225 bill, $185 received -> Still to collect $40.00, Not paid, and the Checkout prompt", async ({ page }) => {
  await loginAsOwner(page, seed);
  await page.goto("/dashboard");
  const modal = await openCheckout(page);
  await modal.getByRole("button", { name: "Split this payment", exact: true }).click();
  const panel = modal.getByTestId("split-visit-payments");
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(22500));
  const amount = (v: string) => panel.getByLabel(/^Amount \(CAD\)/).fill(v);
  const pick = (label: string) => panel.getByText(label, { exact: true }).first().click();
  await amount("100.00");
  await panel.getByRole("button", { name: `Charge card ${money(10000)}`, exact: true }).click();
  // CHANGED (Sam, 28 Nov 2026): wait for the charge in the database, then mark the card live (a real card); a TEST card would not reduce Still to collect.
  await expect.poll(async () => (await adminQuery(`select status from public.payment_charge_attempts where appointment_id = $1`, [seed.appointmentId])).rows[0]?.status, { timeout: 30_000 }).toBe("succeeded");
  await markCardLive();
  await pick("Cash"); await amount("50.00");
  await panel.getByRole("button", { name: `Record cash received ${money(5000)}`, exact: true }).click();
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(7500));
  await pick("E-transfer"); await amount("35.00");
  await panel.getByRole("button", { name: `Record transfer ${money(3500)}`, exact: true }).click();
  await expect(panel.getByTestId("split-pending-transfer")).toBeVisible();
  await panel.getByRole("button", { name: `Confirm ${money(3500)} transfer received`, exact: true }).click();
  await expect.poll(async () => (await adminQuery(`select state from public.visit_external_payments where appointment_id = $1 and method = 'paid_e_transfer'`, [seed.appointmentId])).rows[0]?.state, { timeout: 30_000 }).toBe("confirmed");

  expect(Number((await adminQuery(`select outstanding_cents from public.visit_payment_position((select studio_id from public.visit_bills where appointment_id = $1 and superseded_at is null), $1)`, [seed.appointmentId])).rows[0].outstanding_cents)).toBe(4000);

  await page.goto("/dashboard");
  await expect(page.getByTestId("checkout-button")).toHaveCount(1); // the Checkout prompt stays
  const m2 = await openCheckout(page);
  const p2 = m2.getByTestId("split-visit-payments");
  await expect(p2.getByTestId("money-collected")).toHaveText(money(18500));
  await expect(p2.getByTestId("money-refunded")).toHaveText(money(0));
  await expect(p2.getByTestId("money-net")).toHaveText(money(18500));
  await expect(p2.getByTestId("split-collectable")).toHaveText(money(4000));
  await shots(page, "u1-checkout", m2);

  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  const region = page.getByRole("region", { name: "Session payment" });
  await expect(region.getByTestId("visit-money-net")).toHaveText(money(18500));
  await expect(region.getByTestId("visit-money-still_to_collect")).toHaveText(money(4000));
  await shots(page, "u2-visit");

  await page.goto(`/financials/statements/${seed.clientId}`);
  await expect(page.getByTestId("statement-money-net")).toHaveText("$185.00");
  await expect(page.locator("main")).toContainText("Not paid");
  await shots(page, "u3-statement");
});

// Sam's two statement checks, on ONE real-looking split visit whose card stays a Stripe TEST payment (the fake-Stripe lane's own mode):
//   (1) the TEST card payment ($100) and its $40 refund contribute ZERO to the studio statement and to analytics;
//   (2) the real $50 cash and $75 transfer on the same visit DO appear on /financials/statement and in the analytics total: $125.00, nothing else.
test("a Stripe TEST card payment and its refund add nothing to the studio statement or analytics, while real cash and transfer do", async ({ page }) => {
  await loginAsOwner(page, seed);
  await page.goto("/dashboard");
  const modal = await openCheckout(page);
  await modal.getByRole("button", { name: "Split this payment", exact: true }).click();
  const panel = modal.getByTestId("split-visit-payments");
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(22500));
  const amount = (v: string) => panel.getByLabel(/^Amount \(CAD\)/).fill(v);
  const pick = (label: string) => panel.getByText(label, { exact: true }).first().click();
  await amount("100.00");
  await panel.getByRole("button", { name: `Charge card ${money(10000)}`, exact: true }).click();
  // CHANGED (Sam, 28 Nov 2026): the TEST card does not reduce Still to collect (it stays $225, was $125), and the later figures follow (cash leaves $175, was $75).
  await expect.poll(async () => (await adminQuery(`select status from public.payment_charge_attempts where appointment_id = $1`, [seed.appointmentId])).rows[0]?.status, { timeout: 30_000 }).toBe("succeeded");
  await pick("Cash"); await amount("50.00");
  await panel.getByRole("button", { name: `Record cash received ${money(5000)}`, exact: true }).click();
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(17500));
  await pick("E-transfer"); await amount("75.00");
  await panel.getByRole("button", { name: `Record transfer ${money(7500)}`, exact: true }).click();
  await panel.getByRole("button", { name: `Confirm ${money(7500)} transfer received`, exact: true }).click();
  await expect.poll(async () => (await adminQuery(`select state from public.visit_external_payments where appointment_id = $1 and method = 'paid_e_transfer'`, [seed.appointmentId])).rows[0]?.state, { timeout: 30_000 }).toBe("confirmed");
  await panel.getByRole("button", { name: "Refund or reduce a payment" }).click();
  const form = panel.getByTestId("split-refund-form");
  await form.getByRole("combobox").selectOption({ index: 0 });
  await form.getByLabel("Refund amount").fill("40.00");
  await form.getByLabel("Reason").fill("Client unhappy with part of the visit");
  await form.getByRole("button", { name: `Record ${money(4000)} refund`, exact: true }).click();
  await expect.poll(async () => Number((await adminQuery(`select count(*)::int as n from public.payment_refunds where appointment_id = $1 and legacy = false and status = 'succeeded'`, [seed.appointmentId])).rows[0].n), { timeout: 30_000 }).toBe(1);

  // The card really is a TEST-mode payment in the database.
  expect((await adminQuery(`select stripe_livemode from public.payment_charge_attempts where appointment_id = $1`, [seed.appointmentId])).rows.map((r) => r.stripe_livemode)).toEqual([false]);

  // The VISIT page lists all four entries and labels each Stripe TEST-mode one individually; real cash and transfer stay unlabelled.
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  const entryList = page.getByRole("region", { name: "Session payment" }).getByTestId("visit-money-entries");
  const entryRows = entryList.getByTestId("visit-money-entry");
  await expect(entryRows).toHaveCount(4);
  const testCard = entryRows.filter({ hasText: "Test payment" });
  const testRefund = entryRows.filter({ hasText: "Test refund" });
  await expect(testCard).toHaveCount(1);
  await expect(testCard).toContainText("Excluded from statements and analytics.");
  await expect(testCard).toContainText("$100.00");
  await expect(testRefund).toHaveCount(1);
  await expect(testRefund).toContainText("Excluded from statements and analytics.");
  await expect(testRefund).toContainText("$40.00");
  for (const [name, amt] of [["Cash", "$50.00"], ["E-transfer", "$75.00"]] as const) {
    const real = entryRows.filter({ hasText: name });
    await expect(real).toHaveCount(1);
    await expect(real).toContainText(amt);
    await expect(real).toHaveAttribute("data-test-mode", "false");
    await expect(real).not.toContainText(/Test|Excluded/);
  }
  await expect(entryList.getByText("Excluded from statements and analytics.")).toHaveCount(2);
  await shots(page, "t1-visit-test-labels");

  // Sam, 28 Nov 2026: the visit's Collected / Refunded / Net are REAL money only in EVERY studio. This studio is a TRIAL (test Stripe only): $50 cash + $75 transfer = $125 / $0 / $125 on the visit
  // (was $225 / $40 / $185 here), while the test payment and test refund stay listed and labelled. The statement and analytics below read the same $125.
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  const trial = page.getByRole("region", { name: "Session payment" });
  await expect(trial.getByTestId("visit-money-collected")).toHaveText(money(12500));
  await expect(trial.getByTestId("visit-money-refunded")).toHaveText(money(0));
  await expect(trial.getByTestId("visit-money-net")).toHaveText(money(12500));
  await expect(trial.getByTestId("visit-money-still_to_collect")).toHaveText(money(10000));
  await shots(page, "t1b-visit-trial-real-money-only");
  // And the same once the studio connects live Stripe (nothing about the real money changes).
  await connectLive();
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  const live = page.getByRole("region", { name: "Session payment" });
  await expect(live.getByTestId("visit-money-collected")).toHaveText(money(12500));
  await expect(live.getByTestId("visit-money-refunded")).toHaveText(money(0));
  await expect(live.getByTestId("visit-money-net")).toHaveText(money(12500));
  await expect(live.getByTestId("visit-money-entry").filter({ hasText: "Test payment" })).toHaveCount(1);
  await expect(live.getByTestId("visit-money-entry").filter({ hasText: "Test refund" })).toHaveCount(1);
  await shots(page, "t2-visit-live-real-money-only");

  await page.goto("/financials/statement");
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(summary).toContainText("Total collected");
  await expect(summary).toContainText("$125.00");
  await expect(summary).not.toContainText("$225.00");
  await expect(summary).not.toContainText("$185.00");
  await expect(summary).not.toContainText("$100.00");
  // $125.00 is made of Cash $50 and E-transfer $75, with NO card line.
  await expect(summary.getByRole("listitem").filter({ hasText: "Cash" })).toContainText("$50.00");
  await expect(summary.getByRole("listitem").filter({ hasText: "E-transfer" })).toContainText("$75.00");
  await expect(summary.getByRole("listitem").filter({ hasText: /^Card/ })).toHaveCount(0);
  await shots(page, "s1-studio-statement");

  await page.goto("/financials/analytics");
  const collected = page.locator('section[aria-labelledby="ov-collected-total"]');
  // Analytics prints whole dollars ("$125CAD"): exactly the cash and the transfer, never the TEST card or its refund.
  await expect(collected).toContainText(/\$125(\.00)?\s*CAD/);
  await expect(collected).not.toContainText(/\$(225|185|100)(\.00)?\s*CAD/);
  await shots(page, "s2-analytics");
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// C + real-money rule (Sam, 28 Nov 2026): cash-first studios, and the ACCEPTANCE case: a $225 visit, a $225 TEST charge, then $225 confirmed cash.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function openSplit(page: Page) {
  await page.goto("/dashboard");
  const modal = await openCheckout(page);
  await modal.getByRole("button", { name: "Split this payment", exact: true }).click();
  const panel = modal.getByTestId("split-visit-payments");
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(22500));
  return { modal, panel };
}
async function recordCashAndTransfer(page: Page, cash: string, transfer: string) {
  const { modal, panel } = await openSplit(page);
  const amount = (v: string) => panel.getByLabel(/^Amount \(CAD\)/).fill(v);
  const pick = (label: string) => panel.getByText(label, { exact: true }).first().click();
  const c = money(Math.round(Number(cash) * 100));
  const t = money(Math.round(Number(transfer) * 100));
  await pick("Cash"); await amount(cash);
  await panel.getByRole("button", { name: `Record cash received ${c}`, exact: true }).click();
  await expect(panel.getByTestId("money-collected")).toHaveText(c, { timeout: 30_000 });
  await pick("E-transfer"); await amount(transfer);
  await panel.getByRole("button", { name: `Record transfer ${t}`, exact: true }).click();
  await panel.getByRole("button", { name: `Confirm ${t} transfer received`, exact: true }).click();
  await expect(panel.getByTestId("money-collected")).toHaveText(money(22500), { timeout: 30_000 });
  return { modal, panel };
}
// What the visit page, the studio statement and analytics show for ONE visit whose only real money is $225 cash (a labelled TEST payment may sit beside it).
async function expectThreeScreensReal225(page: Page, tag: string, testEntry: boolean) {
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  const region = page.getByRole("region", { name: "Session payment" });
  await expect(region.getByTestId("visit-money-collected")).toHaveText(money(22500));
  await expect(region.getByTestId("visit-money-refunded")).toHaveText(money(0));
  await expect(region.getByTestId("visit-money-net")).toHaveText(money(22500));
  await expect(region.getByTestId("visit-money-still_to_collect")).toHaveText(money(0));
  const entries = region.getByTestId("visit-money-entries").getByTestId("visit-money-entry");
  if (testEntry) {
    await expect(entries.filter({ hasText: "Test payment" })).toHaveCount(1);
    await expect(entries.filter({ hasText: "Test payment" })).toContainText("Excluded from statements and analytics.");
    await expect(entries.filter({ hasText: "Test payment" })).toContainText("$225.00");
    await expect(entries.filter({ hasText: "Cash" })).toContainText("$225.00");
  }
  await shots(page, `${tag}-visit`);
  await page.goto("/financials/statement");
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(summary).toContainText("$225.00");
  await expect(summary).not.toContainText("$450.00");
  await expect(summary.getByRole("listitem").filter({ hasText: "Cash" })).toContainText("$225.00");
  await page.goto("/financials/analytics");
  const collected = page.locator('section[aria-labelledby="ov-collected-total"]');
  await expect(collected).toContainText(/\$225(\.00)?\s*CAD/);
  await expect(collected).not.toContainText(/\$450(\.00)?\s*CAD/);
}

test("(a) a studio that connected live Stripe and never ran a card: cash $100 + transfer $125 are the first real money, totals right, balance $0, no card attempt", async ({ page }) => {
  await connectLive();
  await loginAsOwner(page, seed);
  const { modal, panel } = await recordCashAndTransfer(page, "100.00", "125.00");
  await expect(panel.getByTestId("money-refunded")).toHaveText(money(0));
  await expect(panel.getByTestId("money-net")).toHaveText(money(22500));
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(0));
  expect(Number((await adminQuery(`select count(*)::int as n from public.payment_charge_attempts where appointment_id = $1`, [seed.appointmentId])).rows[0].n)).toBe(0);
  await shots(page, "k1-cashfirst-live-checkout", modal);
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  const region = page.getByRole("region", { name: "Session payment" });
  await expect(region.getByTestId("visit-money-collected")).toHaveText(money(22500));
  await expect(region.getByTestId("visit-money-net")).toHaveText(money(22500));
  await shots(page, "k2-cashfirst-live-visit");
});

test("(b) a studio that NEVER connected Stripe and takes only cash and transfers: both recorded, totals right, no Stripe wording on the panel", async ({ page }) => {
  await neverConnect();
  await loginAsOwner(page, seed);
  const { modal, panel } = await recordCashAndTransfer(page, "100.00", "125.00");
  await expect(panel.getByTestId("money-net")).toHaveText(money(22500));
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(0));
  await expect(panel).not.toContainText(/stripe/i);
  await shots(page, "k3-never-connected-checkout", modal);
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  await expect(page.getByRole("region", { name: "Session payment" }).getByTestId("visit-money-net")).toHaveText(money(22500));
  await shots(page, "k4-never-connected-visit");
});

// ACCEPTANCE, studio 1: a TRIAL studio (test Stripe only). A $225 test charge, then $225 confirmed cash.
test("ACCEPTANCE (trial studio): a $225 TEST charge then $225 cash reads $225 collected / $0 refunded / $225 net / $0 still to collect on the visit, the statement and analytics; the test charge is listed and labelled", async ({ page }) => {
  await loginAsOwner(page, seed);
  const { modal, panel } = await openSplit(page);
  await panel.getByLabel(/^Amount \(CAD\)/).fill("225.00");
  await panel.getByRole("button", { name: `Charge card ${money(22500)}`, exact: true }).click();
  await expect.poll(async () => (await adminQuery(`select status from public.payment_charge_attempts where appointment_id = $1`, [seed.appointmentId])).rows[0]?.status, { timeout: 30_000 }).toBe("succeeded");
  await page.reload();
  const m1 = await openCheckout(page);
  const p1 = m1.getByTestId("split-visit-payments");
  await expect(p1.getByTestId("split-collectable")).toHaveText(money(22500));    // a test charge does not pay the visit
  await p1.getByText("Cash", { exact: true }).first().click();
  await expect(p1.locator("#split-amount-help")).toContainText(money(22500));    // what staff see: real cash may be taken up to the agreed balance
  await shots(page, "h1-trial-test-charge-cash-offered", m1);
  await p1.getByLabel(/^Amount \(CAD\)/).fill("225.00");
  await p1.getByRole("button", { name: `Record cash received ${money(22500)}`, exact: true }).click();
  await expect(p1.getByTestId("money-collected")).toHaveText(money(22500), { timeout: 30_000 });
  await expect(p1.getByTestId("split-collectable")).toHaveText(money(0));
  await shots(page, "h2-trial-after-cash", m1);
  expect(Number((await adminQuery(`select outstanding_cents from public.visit_payment_position((select studio_id from public.visit_bills where appointment_id = $1 and superseded_at is null), $1)`, [seed.appointmentId])).rows[0].outstanding_cents)).toBe(0);
  await markCardLive();   // statements and analytics read live money only; the cash is the only real money, so they must show $225 whether or not this is read
  await adminQuery(`update public.payment_charge_attempts set stripe_livemode = false where appointment_id = $1`, [seed.appointmentId]);
  await expectThreeScreensReal225(page, "h3-trial", true);
});

// ACCEPTANCE, studio 2: a studio with NO Stripe connection that still carries a leftover TEST charge on the visit; this is the cash-only studio whose visit page goes in the review package.
test("ACCEPTANCE (no Stripe connection, cash only): a leftover $225 TEST charge then $225 cash reads $225 / $0 / $225 / $0 still to collect; the test charge is listed and labelled; phone and desktop screenshots", async ({ page }) => {
  await loginAsOwner(page, seed);
  const { panel: p0 } = await openSplit(page);                // the bill is made while the studio can still open checkout
  await expect(p0).toBeVisible();
  await neverConnect();
  await adminQuery(
    `insert into public.payment_charge_attempts (studio_id, charge_reason, client_id, session_id, appointment_id, created_by_practitioner_id, amount_cents, currency, status, stripe_livemode, stripe_payment_intent_id, stripe_charge_id, charged_at)
     select $1, 'session_payment', $2, $3, $4, (select id from public.practitioners where studio_id = $1 limit 1), 22500, 'cad', 'succeeded', false, $5, $6, now()`,
    [seed.studioId, seed.clientId, seed.sessionId, seed.appointmentId, `pi_leftover_${seed.scenario.runId}`, `ch_leftover_${seed.scenario.runId}`],
  );
  await page.goto("/dashboard");
  const m = await openCheckout(page);
  const panel = m.getByTestId("split-visit-payments");
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(22500));
  await panel.getByText("Cash", { exact: true }).first().click();
  await panel.getByLabel(/^Amount \(CAD\)/).fill("225.00");
  await panel.getByRole("button", { name: `Record cash received ${money(22500)}`, exact: true }).click();
  await expect(panel.getByTestId("money-collected")).toHaveText(money(22500), { timeout: 30_000 });
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(0));
  await expect(panel).not.toContainText(/stripe/i);
  await shots(page, "n1-cashonly-checkout", m);
  await expectThreeScreensReal225(page, "n2-cashonly", true);
});
