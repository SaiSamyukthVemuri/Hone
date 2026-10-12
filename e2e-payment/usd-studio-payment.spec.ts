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
  cleanupFakeStripeLedger,
} from "./helpers/fake-stripe-ledger-e2e";

// ===========================================================================
// PAY-CCY-05 (#824) — a US studio's session payment, end to end, in USD
// ===========================================================================
//
// A synthetic US studio (switched to US/usd through the 0214 command before it
// had any account, then bound to an account Stripe reported as US) charges a
// completed session and refunds it, through the real UI, server actions and
// database, with the FAKE Stripe processor. Nothing reaches Stripe.
//
// What it proves, in the browser and in the ledger:
//   * the final-charge field is labelled in US dollars;
//   * the prepared attempt is stamped usd by the server (never by the form);
//   * the PaymentIntent the fake receives is usd, for the authored amount;
//   * the refund returns that charge and the row records it;
//   * no real Stripe network request is made.
// The Canadian path is the rest of this lane's specs, unchanged.

const BOOKED_PRICE_CENTS = 15_000; // $150.00

let seed: PaymentSeed;
const stripeNetworkRequests: string[] = [];

test.beforeAll(async () => {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
  seed = await seedEligiblePaymentWithLogin({
    label: "usd-studio",
    paymentCountry: "US",
    bookedService: { name: "US Electrolysis 60", priceCents: BOOKED_PRICE_CENTS },
  });
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

test("US studio: prepare, charge and refund a session payment in USD", async ({ page }) => {
  page.on("request", (req: Request) => {
    if (/api\.stripe\.com/.test(req.url())) stripeNetworkRequests.push(req.url());
  });

  const jurisdiction = await adminQuery(
    `select payment_country, payment_currency from public.studio_payment_jurisdictions where studio_id = $1`,
    [seed.studioId],
  );
  expect(jurisdiction.rows[0]).toEqual({ payment_country: "US", payment_currency: "usd" });

  await loginAsOwner(page, seed);
  await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
  const region = page.getByRole("region", { name: "Session payment" });

  // The field names the studio's currency.
  await expect(region.getByText("Final charge (USD)")).toBeVisible({ timeout: 20_000 });
  const finalCharge = region.getByLabel("Final charge in US dollars");
  await expect(finalCharge).toHaveValue("150.00");

  await region.getByRole("button", { name: /prepare session payment/i }).click();
  const runCharge = region.getByRole("button", { name: /^run charge$/i });
  await expect(runCharge).toBeVisible({ timeout: 20_000 });

  const prepared = await getSessionPaymentAttemptRows(seed.sessionId);
  expect(prepared).toHaveLength(1);
  const row = await adminQuery(
    `select amount_cents, currency, status from public.payment_charge_attempts where id = $1`,
    [prepared[0].id],
  );
  expect(row.rows[0]).toEqual({ amount_cents: BOOKED_PRICE_CENTS, currency: "usd", status: "ready" });

  configureFakeStripeOutcome(idempotencySelectorForAttempt(prepared[0].id), "success");
  await runCharge.click();
  await region.getByRole("button", { name: /confirm: run charge/i }).click();
  await expect(region.getByTestId("payment-summary-paid")).toContainText(/Paid · \$150\.00/, {
    timeout: 30_000,
  });

  const piCall = readFakeStripeCalls().find((c) => c.method === "pi_create")!;
  expect(piCall.stripeAccount).toBe(seed.connectedAccountId);
  expect(piCall.amountCents).toBe(BOOKED_PRICE_CENTS);
  expect(piCall.currency).toBe("usd");

  // Refund (owner): the same charge, the same money.
  await page.reload();
  const regionAfter = page.getByRole("region", { name: "Session payment" });
  await regionAfter.getByRole("button", { name: /^refund charge$/i }).click();
  await regionAfter.getByRole("button", { name: /confirm: refund charge/i }).click();
  await expect(regionAfter.getByText("Refund succeeded.")).toBeVisible({ timeout: 30_000 });

  const refunded = await adminQuery(
    `select status, currency, amount_cents, refund_status, refund_amount_cents
       from public.payment_charge_attempts where id = $1`,
    [prepared[0].id],
  );
  expect(refunded.rows[0]).toEqual({
    status: "succeeded",
    currency: "usd",
    amount_cents: BOOKED_PRICE_CENTS,
    refund_status: "succeeded",
    refund_amount_cents: BOOKED_PRICE_CENTS,
  });
  const refundCalls = callsForAccount(seed.connectedAccountId).filter(
    (c) => c.method === "refund_create",
  );
  expect(refundCalls).toHaveLength(1);
  expect(refundCalls[0].amountCents).toBe(BOOKED_PRICE_CENTS);

  expect(stripeNetworkRequests).toEqual([]);
});
