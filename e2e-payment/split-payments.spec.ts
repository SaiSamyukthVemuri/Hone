import { test, expect, type Page, type Route, type Locator } from "@playwright/test";
import { loginAsOwner } from "../e2e/helpers/flows";
import { seedEligiblePaymentWithLogin, cleanupPaymentScenario, adminQuery, closePool, type PaymentSeed } from "./helpers/payment-fixture";
import { resetFakeStripeLedger, clearFakeStripeOutcome, callsForAccount, cleanupFakeStripeLedger } from "./helpers/fake-stripe-ledger-e2e";
import { openCheckout } from "./helpers/checkout-flow";

// ===========================================================================
// Split payments and partial refunds on ONE visit (HON-123 / HON-122), fake-Stripe lane.
// ===========================================================================
// A $225 visit paid as: $100 card, $50 cash, $75 bank transfer; then a $40 partial card refund. The server-action POST is intercepted the way the
// ambiguous-response spec does it (forwarded to the REAL server, then the browser-facing response is dropped), so the "connection lost after Stripe
// accepted" cases are real. Every count is read from the database and the fake Stripe ledger, never inferred from the screen.

const DEV = "$"; // money prefix in copy
const money = (c: number) => `${DEV}${(c / 100).toFixed(2)} CAD`;

let seed: PaymentSeed;
const pis = () => callsForAccount(seed.connectedAccountId).filter((c) => c.method === "pi_create");
const refundsAtStripe = () => callsForAccount(seed.connectedAccountId).filter((c) => c.method === "refund_create");
const attempts = async () => (await adminQuery(`select id, status, amount_cents, submission_id from public.payment_charge_attempts where appointment_id = $1 and charge_reason = 'session_payment' order by created_at`, [seed.appointmentId])).rows as { id: string; status: string; amount_cents: number; submission_id: string | null }[];
const externals = async () => (await adminQuery(`select method, amount_cents, state from public.visit_external_payments where appointment_id = $1 order by recorded_at`, [seed.appointmentId])).rows as { method: string; amount_cents: number; state: string }[];
const refunds = async () => (await adminQuery(`select amount_cents, kind, status from public.payment_refunds where appointment_id = $1 and legacy = false order by requested_at`, [seed.appointmentId])).rows as { amount_cents: number; kind: string; status: string }[];

test.beforeEach(async () => {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
  seed = await seedEligiblePaymentWithLogin({ label: "split", bookedService: { name: "Split Payment Service", priceCents: 22500 } });
  // The fake mail transport accepts `success+` addresses; the automatic receipt then sends once per succeeded card payment.
  await adminQuery(`update public.clients set email = $2 where id = $1`, [seed.clientId, `success+split-${seed.scenario.runId}@harness.local`]);
  await adminQuery(`update public.platform_rollouts set mode = 'pilot' where key = 'split_payments' and mode = 'off'`);
  await adminQuery(`insert into public.platform_rollout_studios (rollout_key, studio_id) values ('split_payments', $1) on conflict do nothing`, [seed.studioId]);
});
test.afterEach(async () => {
  await adminQuery(`delete from public.platform_rollout_studios where rollout_key = 'split_payments' and studio_id = $1`, [seed.studioId]).catch(() => undefined);
  await cleanupPaymentScenario(seed.studioId).catch(() => undefined);
  cleanupFakeStripeLedger();
});
test.afterAll(async () => { await closePool(); });

async function openSplit(page: Page): Promise<Locator> {
  await loginAsOwner(page, seed);
  await page.goto("/dashboard");
  const modal = await openCheckout(page);
  await modal.getByRole("button", { name: "Split this payment", exact: true }).click();
  const panel = modal.getByTestId("split-visit-payments");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(22500));
  return panel;
}
const pick = (panel: Locator, label: string) => panel.getByText(label, { exact: true }).first().click();
const amount = (panel: Locator, v: string) => panel.getByLabel(/^Amount \(CAD\)/).fill(v);

/** Drop the browser-facing response of server-action POSTs. `passFirst` lets that many through untouched; the next one reaches the REAL server and is then dropped; everything after is dropped unsent. */
async function loseResponses(page: Page, passFirst: number) {
  let seen = 0;
  const handler = async (route: Route) => {
    const req = route.request();
    if (!(req.method() === "POST" && req.headers()["next-action"])) return route.continue();
    seen += 1;
    if (seen <= passFirst) return route.continue();
    if (seen === passFirst + 1) {
      const res = await route.fetch();
      const text = await res.text().catch(() => "");
      console.log(`[split-e2e] dropped action response: ${text.replace(/\s+/g, " ").slice(0, 500)}`);
    }
    await route.abort("failed").catch(() => {});
  };
  await page.route("**/dashboard**", handler);
  return async () => { await page.unroute("**/dashboard**", handler); };
}

test("the $225 example: lost response after Stripe accepts, then cash once, transfer reserved, both click orders, void, one $75 charge", async ({ page, browser }, testInfo) => {
  const panel = await openSplit(page);

  // ---- $100 by card; Stripe accepts but the browser never hears.
  await amount(panel, "100.00");
  expect(pis()).toHaveLength(0);
  const restore = await loseResponses(page, 1); // prepare passes; the run reaches Stripe and its answer is lost
  await panel.getByRole("button", { name: `Charge card ${money(10000)}`, exact: true }).click();
  const checking = panel.getByTestId("split-checking");
  await expect(checking).toBeVisible({ timeout: 30_000 });
  await expect(checking.getByText("Checking payment status", { exact: true })).toBeVisible();
  // No charge control while the outcome is unknown, and no second charge.
  await expect(panel.getByRole("button", { name: /^Charge card/ })).toHaveCount(0);
  expect(pis()).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await testInfo.attach("checking-payment-status-iphone-390x844", { body: await page.screenshot(), contentType: "image/png" });
  await page.setViewportSize({ width: 1080, height: 810 });

  // ---- Reconnect: the same attempt is re-asked, never recharged.
  await restore();
  await expect(checking).toHaveCount(0, { timeout: 40_000 });
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(12500));
  expect((await attempts()).map((a) => [a.status, a.amount_cents])).toEqual([["succeeded", 10000]]);
  expect(pis()).toHaveLength(1);

  // ONE receipt for the $100 payment (automatic), and asking again cannot send a second.
  const receipts = async () => Number((await adminQuery(`select count(*)::int as n from public.payment_charge_attempts where appointment_id = $1 and receipt_sent_at is not null`, [seed.appointmentId])).rows[0].n);
  await expect.poll(receipts, { timeout: 30_000 }).toBe(1);
  const again = panel.getByRole("button", { name: `Send receipt for ${money(10000)} card payment` });
  if (await again.count()) await again.click();
  expect(await receipts()).toBe(1);

  // ---- $50 cash, once: a double submit is one row.
  await pick(panel, "Cash");
  await amount(panel, "50.00");
  const cashBtn = panel.getByRole("button", { name: `Record cash received ${money(5000)}`, exact: true });
  await cashBtn.dblclick();
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(7500));
  expect((await externals()).filter((e) => e.method === "paid_cash")).toHaveLength(1);

  // ---- A stale second tab opened BEFORE the transfer is recorded (it still offers the $75 card).
  const stale = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 1080, height: 810 } });
  const page2 = await stale.newPage();
  await page2.goto("/dashboard");
  const modal2 = await openCheckout(page2);
  const panel2 = modal2.getByTestId("split-visit-payments");
  await expect(panel2.getByTestId("split-collectable")).toHaveText(money(7500));

  // ---- $75 transfer: stays owed, and RESERVED, until confirmed.
  await pick(panel, "E-transfer");
  await amount(panel, "75.00");
  await panel.getByRole("button", { name: `Record transfer ${money(7500)}`, exact: true }).click();
  await expect(panel.getByTestId("split-pending-transfer")).toBeVisible();
  expect((await externals()).filter((e) => e.state === "pending_confirmation")).toHaveLength(1);

  // ---- CLICK ORDER 1: the card click arrives after the transfer was recorded. Zero Stripe attempts.
  const piBefore = pis().length;
  const attemptsBefore = (await attempts()).length;
  await pick(panel2, "Card");
  await amount(panel2, "75.00");
  await panel2.getByRole("button", { name: `Charge card ${money(7500)}`, exact: true }).click();
  await expect(panel2.getByTestId("split-note")).toContainText("This amount is reserved for a pending transfer.");
  expect(pis()).toHaveLength(piBefore);
  expect(await attempts()).toHaveLength(attemptsBefore); // no payment_charge_attempts row either
  expect(callsForAccount(seed.connectedAccountId).length).toBe(piBefore);

  // ---- Void releases it; then ONE $75 card charge is allowed.
  await panel.getByRole("button", { name: "Cancel this transfer" }).click();
  await panel.getByLabel("Reason for cancelling the transfer").fill("Client paid by card instead");
  await panel.getByRole("button", { name: `Cancel ${money(7500)} transfer and release the amount`, exact: true }).click();
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(7500));
  await pick(panel, "Card");
  await amount(panel, "75.00");
  await panel.getByRole("button", { name: `Charge card ${money(7500)}`, exact: true }).click();
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(0), { timeout: 30_000 });
  expect((await attempts()).map((a) => a.status)).toEqual(["succeeded", "succeeded"]);
  expect(pis()).toHaveLength(2); // $100 and $75: no duplicate anywhere
  await expect.poll(receipts, { timeout: 30_000 }).toBe(2); // one receipt per card payment
  expect(callsForAccount(seed.connectedAccountId).filter((c) => c.replay)).toHaveLength(0);
  await stale.close();
});

test("a transfer confirmed settles the bill and nothing is charged", async ({ page }) => {
  const panel = await openSplit(page);
  await pick(panel, "E-transfer");
  await amount(panel, "225.00");
  await panel.getByRole("button", { name: `Record transfer ${money(22500)}`, exact: true }).click();
  await expect(panel.getByTestId("split-pending-transfer")).toBeVisible();
  // Reserved in full: still owed, and no way to charge a card for it.
  await expect(panel.getByRole("button", { name: /^Charge card/ })).toHaveCount(0);
  await panel.getByRole("button", { name: `Confirm ${money(22500)} transfer received`, exact: true }).click();
  await expect(panel.getByTestId("split-pending-transfer")).toHaveCount(0);
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(0));
  expect((await externals()).map((e) => e.state)).toEqual(["confirmed"]);
  expect(pis()).toHaveLength(0);
  expect(await attempts()).toHaveLength(0);
});

test("a $40 partial refund with a lost response: ONE refund at Stripe, $60 still refundable", async ({ page }, testInfo) => {
  const panel = await openSplit(page);
  await amount(panel, "100.00");
  await panel.getByRole("button", { name: `Charge card ${money(10000)}`, exact: true }).click();
  await expect(panel.getByTestId("split-collectable")).toHaveText(money(12500), { timeout: 30_000 });
  expect(pis()).toHaveLength(1);

  await panel.getByRole("button", { name: "Refund or reduce a payment" }).click();
  const form = panel.getByTestId("split-refund-form");
  await expect(form.getByRole("combobox")).toContainText(`up to ${money(10000)} refundable`);
  await form.getByLabel("Refund amount").fill("40.00");
  await form.getByLabel("Reason").fill("Client unhappy with part of the visit");
  const restore = await loseResponses(page, 0); // the refund reaches Stripe; the answer is lost
  await form.getByRole("button", { name: `Record ${money(4000)} refund`, exact: true }).click();
  await expect(panel.getByTestId("split-note")).toContainText("Checking refund status", { timeout: 30_000 });
  expect(refundsAtStripe()).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await testInfo.attach("checking-refund-status-iphone-390x844", { body: await page.screenshot(), contentType: "image/png" });
  await page.setViewportSize({ width: 1080, height: 810 });
  await restore();

  // Retry with the same details: still ONE refund, in Stripe and in Hone.
  await form.getByLabel("Refund amount").fill("40.00");
  await form.getByLabel("Reason").fill("Client unhappy with part of the visit");
  await form.getByRole("button", { name: `Record ${money(4000)} refund`, exact: true }).click();
  await page.reload();
  const modal = await openCheckout(page);
  const panel2 = modal.getByTestId("split-visit-payments");
  await expect(panel2.getByTestId("split-collectable")).toHaveText(money(16500)); // $225 − ($100 − $40 returned)
  await panel2.getByRole("button", { name: "Refund or reduce a payment" }).click();
  await expect(panel2.getByRole("combobox")).toContainText(`up to ${money(6000)} refundable`);
  expect(refundsAtStripe()).toHaveLength(1);
  expect(refundsAtStripe()[0].amountCents).toBe(4000);
  expect((await refunds()).map((r) => [r.amount_cents, r.status])).toEqual([[4000, "succeeded"]]);
});
