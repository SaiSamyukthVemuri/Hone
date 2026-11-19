import { test, expect } from "@playwright/test";
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
  configureFakeStripeWebhookTiming,
  callsForAccount,
  countInvocationsForAccount,
  countEffectsForAccount,
  cleanupFakeStripeLedger,
} from "./helpers/fake-stripe-ledger-e2e";
import { openCheckout, prepareInModal, closeModal, armReady } from "./helpers/checkout-flow";

// ===========================================================================
// A declined card ends FAILED through Stripe's own decline event.
// ===========================================================================
//
// The fake refuses a declined charge the way Stripe does: the create call throws a card error carrying the
// PaymentIntent, and a signed payment_intent.payment_failed event follows. The executor deliberately does NOT write a
// terminal failure from the thrown error (an intent that is not confirmed canceled can still complete), so the attempt
// waits as pending_stripe and the webhook moves it to failed.
//
// Stripe promises no order between the API response and the event, so BOTH orders are pinned:
//   after          the event arrives a moment after the charge call returned (the usual order);
//   before_return  the event is delivered and processed BEFORE the charge call returns, i.e. before the executor has bound
//                  the intent to its attempt.
// Either way the end state must be the same: one attempt, failed, no Paid, one processor effect, no retry, no cancel,
// no refund. If the early order leaves the attempt pending, that is a FINDING about the webhook path, not a test to loosen.

let seed: PaymentSeed;

async function declineScenario(timing: "after" | "before_return", label: string, page: import("@playwright/test").Page) {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
  seed = await seedEligiblePaymentWithLogin({
    label,
    bookedService: { name: "Declined Charge Service", priceCents: 22500 },
  });
  try {
    await loginAsOwner(page, seed);
    await page.goto("/dashboard");
    const modal = await openCheckout(page);
    await prepareInModal(modal);
    const prepared = await getSessionPaymentAttemptRows(seed.sessionId);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].status).toBe("ready");
    configureFakeStripeOutcome(idempotencySelectorForAttempt(prepared[0].id), "decline");
    configureFakeStripeWebhookTiming(timing);
    await closeModal(page);
    const { confirm } = await armReady(page);
    expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(0);

    await confirm.click();

    // The attempt ends failed, reconciled by the webhook. Polled from the database, never from the page.
    try {
      await expect
        .poll(async () => (await getSessionPaymentAttemptRows(seed.sessionId)).map((r) => r.status), { timeout: 30_000, intervals: [250] })
        .toEqual(["failed"]);
    } finally {
      // EVIDENCE, whatever the end state: the attempt's stored intent id (null = never bound) and the alerts raised.
      const row = await adminQuery(
        `select status, stripe_payment_intent_id is not null as pi_bound, stripe_status
           from public.payment_charge_attempts where session_id = $1 and charge_reason = 'session_payment'`,
        [seed.sessionId],
      );
      const alerts = await adminQuery(
        `select event, severity from public.ops_alerts where studio_id = $1 order by created_at`,
        [seed.studioId],
      );
      console.log(
        `[decline ${timing}] attempt=${JSON.stringify(row.rows)} alerts=${JSON.stringify(alerts.rows.map((a) => `${a.severity}:${a.event}`))}`,
      );
    }

    // Exactly one attempt, no success row, no second charge, no cancel, no refund, no Paid.
    const rows = await getSessionPaymentAttemptRows(seed.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows.filter((r) => r.status === "succeeded" || r.status === "pending_stripe")).toHaveLength(0);
    // Wait past the fake's own delivery window, then re-read: nothing retried and nothing moved.
    await page.waitForTimeout(2_000);
    expect(countInvocationsForAccount(seed.connectedAccountId)).toBe(1);
    expect(countEffectsForAccount(seed.connectedAccountId)).toBe(1);
    const methods = callsForAccount(seed.connectedAccountId).map((c) => c.method);
    expect(methods.filter((m) => m === "pi_create")).toHaveLength(1);
    expect(methods.filter((m) => m === "refund_create")).toHaveLength(0);
    expect(methods.filter((m) => m === "pi_cancel")).toHaveLength(0);
    expect((await getSessionPaymentAttemptRows(seed.sessionId)).map((r) => r.status)).toEqual(["failed"]);

    await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
    await expect(page.getByTestId("payment-summary-paid")).toHaveCount(0);
    await page.goto("/dashboard");
    await expect(page.getByTestId("appointment-payment-paid")).toHaveCount(0);
  } finally {
    await cleanupPaymentScenario(seed.studioId);
  }
}

test.afterAll(async () => {
  cleanupFakeStripeLedger();
  await closePool();
});

test("a declined charge ends failed through the webhook when the event arrives AFTER the charge call returns", async ({ page }) => {
  await declineScenario("after", "declafter", page);
});

test("a declined charge ends failed through the webhook when the event arrives BEFORE the charge call returns", async ({ page }) => {
  await declineScenario("before_return", "declbefore", page);
});
