import { test, expect, type Request } from "@playwright/test";
import { loginAsOwner } from "../e2e/helpers/flows";
import {
  seedEligiblePaymentWithLogin,
  getSessionPaymentAttemptRows,
  idempotencySelectorForAttempt,
  cleanupPaymentScenario,
  adminQuery,
  closePool,
  type PaymentSeed,
} from "./helpers/payment-fixture";
import {
  resetFakeStripeLedger,
  clearFakeStripeOutcome,
  configureFakeStripeOutcome,
  readFakeStripeCalls,
  callsForAccount,
  countInvocationsForAccount,
  countEffectsForAccount,
  cleanupFakeStripeLedger,
} from "./helpers/fake-stripe-ledger-e2e";

// ===========================================================================
// F-PAY-002 — an operator-authored total, charged for real through fake Stripe.
// ===========================================================================
//
// Chloe, in production: "I can't do a custom price. When I prepare charge it's
// stuck as whatever the price of the service is. I can't change to discount or
// add product etc."
//
// This is the end-to-end proof that the number she types is the number the
// processor receives — the one claim no unit test can make, because it spans
// the browser, the server action, the persisted row, the executor and the
// Stripe boundary.
//
// The load-bearing assertion is the LAST one: `piCall.amountCents` is the
// AUTHORED total, not the booked service price. If any layer between the form
// and paymentIntents.create quietly re-derived the amount from the current
// menu price, this is where it would show, and nowhere else.
//
// Deliberately the ADD-ON direction (a total ABOVE the booked price). A
// discount is proved at the prepare layer in checkout-default-amount.spec.ts;
// an upward adjustment is the case where a repricing bug would silently charge
// LESS than the operator intended, which is the failure a studio notices last.

const BOOKED_PRICE_CENTS = 12_000; // $120.00 — the booked service
const FINAL_CHARGE_CENTS = 14_500; // $145.00 — service + aftercare product

let seed: PaymentSeed;
const stripeNetworkRequests: string[] = [];

test.beforeAll(async () => {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
  seed = await seedEligiblePaymentWithLogin({
    label: "custom-final",
    bookedService: { name: "Custom Final Electrolysis", priceCents: BOOKED_PRICE_CENTS },
  });
  // Remove the historical fallback so the ONLY reference is the booked service.
  await adminQuery(`update public.sessions set price_paid_cents = null where id = $1`, [
    seed.sessionId,
  ]);
});

test.afterAll(async () => {
  try {
    await cleanupPaymentScenario(seed.studioId);
  } finally {
    cleanupFakeStripeLedger();
    await closePool();
  }
});

test("quick checkout: an authored $145 total is prepared, confirmed and charged as 14500", async ({
  page,
}) => {
  page.on("request", (req: Request) => {
    if (/api\.stripe\.com/.test(req.url())) stripeNetworkRequests.push(req.url());
  });

  expect(await getSessionPaymentAttemptRows(seed.sessionId)).toHaveLength(0);
  expect(readFakeStripeCalls()).toHaveLength(0);

  await loginAsOwner(page, seed);
  await page.goto("/dashboard");
  await page.getByTestId("checkout-button").first().click();
  const modal = page.getByTestId("quick-checkout-modal");
  await expect(modal).toBeVisible({ timeout: 20_000 });

  // The booked price is the REMINDER, and it stays visible the whole time.
  await expect(modal.getByTestId("authoritative-amount")).toHaveText("$120.00");

  // The TOTAL, authored by the operator with the client standing there.
  const finalCharge = modal.getByTestId("final-charge-input");
  await expect(finalCharge).toHaveValue("120.00");
  await finalCharge.fill("145.00");
  await expect(modal.getByTestId("checkout-adjustment-delta")).toContainText(
    "Adjusted from $120.00 to $145.00",
  );
  await modal.getByTestId("adjustment-reason-input").fill("Aftercare product");

  // The reference has NOT moved: the reminder is not overwritten by the total.
  await expect(modal.getByTestId("authoritative-amount")).toHaveText("$120.00");

  await modal.getByRole("button", { name: /prepare session payment/i }).click();

  // Prepared → the Ready panel must quote the AUTHORED amount, not the menu.
  const runCharge = modal.getByRole("button", { name: /^run charge$/i });
  await expect(runCharge).toBeVisible({ timeout: 20_000 });
  await expect(modal.getByText(/saved card will be charged \$145\.00/i)).toBeVisible();

  const preparedRows = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(preparedRows).toHaveLength(1);
  expect(preparedRows[0].status).toBe("ready");
  const persisted = await adminQuery(
    `select amount_cents, internal_note from public.payment_charge_attempts where id = $1`,
    [preparedRows[0].id],
  );
  expect(Number(persisted.rows[0].amount_cents)).toBe(FINAL_CHARGE_CENTS);
  expect(String(persisted.rows[0].internal_note)).toContain("Aftercare product");
  expect(readFakeStripeCalls()).toHaveLength(0);

  // Arm the fake for THIS attempt's server-generated idempotency key.
  const selector = idempotencySelectorForAttempt(preparedRows[0].id);
  configureFakeStripeOutcome(selector, "success");

  // The two-click confirm must also quote the authored amount.
  await runCharge.click();
  const confirmCharge = modal.getByRole("button", { name: /confirm: run charge/i });
  await expect(confirmCharge).toContainText("$145.00");
  await confirmCharge.click();

  const paidLine = modal.getByTestId("payment-summary-paid");
  await expect(paidLine).toBeVisible({ timeout: 30_000 });
  await expect(paidLine).toContainText(/Paid · \$145\.00/);

  const chargedRows = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(chargedRows).toHaveLength(1);
  expect(chargedRows[0].status).toBe("succeeded");

  // ===== THE PROOF =====
  expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(1);
  expect(countEffectsForAccount(seed.connectedAccountId)).toBe(1);
  const piCall = readFakeStripeCalls().find((c) => c.method === "pi_create")!;
  expect(piCall.replay).toBe(false);
  expect(piCall.idempotencyKey).toBe(selector);
  expect(piCall.stripeAccount).toBe(`acct_test_e2e_${seed.scenario.runId}`);
  // Exactly the authored total. NOT the $120.00 booked service price.
  expect(piCall.amountCents).toBe(FINAL_CHARGE_CENTS);
  expect(piCall.amountCents).not.toBe(BOOKED_PRICE_CENTS);
  expect(piCall.currency).toBe("cad");

  // No real Stripe network request, and no refund path ran.
  expect(stripeNetworkRequests).toEqual([]);
  expect(
    callsForAccount(seed.connectedAccountId).filter((c) => c.method === "refund_create"),
  ).toHaveLength(0);

  // A prepared amount is an immutable transaction fact: moving the MENU price
  // afterwards must not rewrite what was charged or what is displayed.
  //
  // Checked on the SESSION DETAIL page, not by reopening quick checkout: once
  // the charge succeeds the dashboard cell renders a Paid badge instead of the
  // checkout button, so there is nothing left there to click.
  await adminQuery(`update public.services set price_cents = 9900 where id = $1`, [
    seed.scenario.serviceId,
  ]);
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  const region = page.getByRole("region", { name: "Session payment" });
  await expect(region.getByTestId("payment-summary-paid")).toContainText(
    /Paid · \$145\.00/,
    { timeout: 20_000 },
  );
  // The booked service now reads $99.00, and the charge still reads $145.00.
  const afterRows = await adminQuery(
    `select amount_cents from public.payment_charge_attempts where session_id = $1`,
    [seed.sessionId],
  );
  expect(afterRows.rows).toHaveLength(1);
  expect(Number(afterRows.rows[0].amount_cents)).toBe(FINAL_CHARGE_CENTS);
  // ...and still exactly one processor effect.
  expect(countEffectsForAccount(seed.connectedAccountId)).toBe(1);
});
