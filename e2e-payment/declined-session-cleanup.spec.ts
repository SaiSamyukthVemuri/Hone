import { test, expect } from "@playwright/test";
import Stripe from "stripe";
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
  countEffectsForAccount,
  cleanupFakeStripeLedger,
} from "./helpers/fake-stripe-ledger-e2e";
import { openCheckout, prepareInModal, closeModal, armReady } from "./helpers/checkout-flow";
import { PAYMENT_E2E_APP_ORIGIN, PAYMENT_WEB_SERVER_ENV } from "./helpers/payment-env";

// ===========================================================================
// A declined session payment: the original Stripe attempt is closed, a replacement is untouched.
// ===========================================================================
//
// After the webhook records the decline as failed, Hone cancels the ORIGINAL PaymentIntent (verified first) so it cannot be
// completed later beside a replacement. Staff can prepare a replacement straight away. A duplicate or late
// payment_failed for the old intent must then be a no-op: no Stripe call, and neither attempt row moves.

let seed: PaymentSeed;

type AttemptRow = Record<string, unknown>;
async function attemptRows(sessionId: string): Promise<AttemptRow[]> {
  const r = await adminQuery(
    `select id, status, stripe_payment_intent_id, stripe_status, stripe_customer_id, stripe_account_id, amount_cents, currency, updated_at::text as updated_at
       from public.payment_charge_attempts where session_id = $1 and charge_reason = 'session_payment' order by created_at`,
    [sessionId],
  );
  return r.rows as AttemptRow[];
}

// A signed payment_intent.payment_failed for the OLD intent, as Stripe would send it again: the snapshot at the time of the
// decline (requires_payment_method with a card error), not the intent's current state.
async function postDuplicateDecline(old: AttemptRow): Promise<number> {
  const secret = (PAYMENT_WEB_SERVER_ENV as Record<string, string>).STRIPE_WEBHOOK_SECRET;
  const event = {
    id: `evt_test_e2e_dup_${old.stripe_payment_intent_id}`,
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type: "payment_intent.payment_failed",
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    account: old.stripe_account_id,
    data: {
      object: {
        id: old.stripe_payment_intent_id,
        object: "payment_intent",
        status: "requires_payment_method",
        amount: old.amount_cents,
        currency: old.currency,
        customer: old.stripe_customer_id,
        livemode: false,
        amount_received: 0,
        latest_charge: null,
        metadata: {
          hone_session_payment_charge_attempt_id: old.id,
          hone_charge_reason: "session_payment",
          hone_studio_id: seed.studioId,
          hone_client_id: seed.clientId,
          hone_environment: "test",
        },
        last_payment_error: { type: "card_error", code: "card_declined", decline_code: "generic_decline", message: "Your card was declined." },
      },
    },
  };
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const res = await fetch(`${PAYMENT_E2E_APP_ORIGIN}/api/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
  return res.status;
}

test.afterAll(async () => {
  cleanupFakeStripeLedger();
  await closePool();
});

test("a declined session payment: original intent cancelled once, replacement preparable and untouched, duplicate notice a no-op", async ({ page }) => {
  resetFakeStripeLedger();
  clearFakeStripeOutcome();
  seed = await seedEligiblePaymentWithLogin({
    label: "declclean",
    bookedService: { name: "Declined Cleanup Service", priceCents: 22500 },
  });
  try {
    await loginAsOwner(page, seed);
    await page.goto("/dashboard");
    const modal = await openCheckout(page);
    await prepareInModal(modal);
    const prepared = await getSessionPaymentAttemptRows(seed.sessionId);
    expect(prepared).toHaveLength(1);
    configureFakeStripeOutcome(idempotencySelectorForAttempt(prepared[0].id), "decline");
    configureFakeStripeWebhookTiming("after");
    await closeModal(page);
    const { confirm } = await armReady(page);
    await confirm.click();

    // 1. The attempt ends failed, and Hone records that Stripe confirmed the original intent cancelled. Polled from the database.
    try {
      await expect
        .poll(async () => (await attemptRows(seed.sessionId)).map((r) => `${r.status}/${r.stripe_status}`), { timeout: 30_000, intervals: [250] })
        .toEqual(["failed/canceled"]);
    } finally {
      const rows = await attemptRows(seed.sessionId);
      const alerts = await adminQuery(`select event, severity, safe_details from public.ops_alerts where (studio_id = $1 or safe_details->>'studio_id' = $1::text) order by created_at`, [seed.studioId]);
      console.log(`[cleanup-details] ${JSON.stringify(alerts.rows.map((a) => [a.event, a.safe_details]))}`);
      console.log(`[cleanup] attempts=${JSON.stringify(rows.map((r) => [r.status, r.stripe_status, r.stripe_payment_intent_id != null]))} alerts=${JSON.stringify(alerts.rows.map((a) => `${a.severity}:${a.event}`))}`);
    }
    const [original] = await attemptRows(seed.sessionId);
    const afterDecline = callsForAccount(seed.connectedAccountId).map((c) => c.method);
    expect(afterDecline.filter((m) => m === "pi_create")).toHaveLength(1);
    expect(afterDecline.filter((m) => m === "pi_cancel")).toHaveLength(1); // the original intent, cancelled exactly once
    expect(afterDecline.filter((m) => m === "refund_create")).toHaveLength(0);

    // 2. A replacement payment can be prepared straight away.
    await page.goto("/dashboard");
    const modal2 = await openCheckout(page);
    await prepareInModal(modal2);
    const both = await attemptRows(seed.sessionId);
    expect(both).toHaveLength(2);
    const replacement = both.find((r) => r.id !== original.id)!;
    expect(replacement.status).toBe("ready");
    expect(replacement.stripe_payment_intent_id).toBeNull();
    const replacementBefore = JSON.stringify(replacement);
    const originalBefore = JSON.stringify(both.find((r) => r.id === original.id));
    const callsBefore = callsForAccount(seed.connectedAccountId).length;

    // 3. A duplicate (or late) payment_failed for the OLD intent is a no-op: answered 200, no Stripe call, no row moves.
    expect(await postDuplicateDecline(original)).toBe(200);
    await page.waitForTimeout(1_500);
    expect(callsForAccount(seed.connectedAccountId)).toHaveLength(callsBefore);
    const settled = await attemptRows(seed.sessionId);
    expect(JSON.stringify(settled.find((r) => r.id === replacement.id))).toBe(replacementBefore);
    expect(JSON.stringify(settled.find((r) => r.id === original.id))).toBe(originalBefore);

    // 4. No second charge and nothing Paid.
    expect(callsForAccount(seed.connectedAccountId).filter((c) => c.method === "pi_create")).toHaveLength(1);
    expect(countEffectsForAccount(seed.connectedAccountId)).toBe(1);
    expect(settled.filter((r) => r.status === "succeeded")).toHaveLength(0);
    await page.goto(`/clients/${seed.clientId}/sessions/${seed.sessionId}`);
    await expect(page.getByTestId("payment-summary-paid")).toHaveCount(0);
  } finally {
    await cleanupPaymentScenario(seed.studioId);
  }
});
