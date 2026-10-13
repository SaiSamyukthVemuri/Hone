import StripeSdk from "stripe";
import { E2E_APP_ORIGIN, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";
import { adminQuery } from "./payment-fixture";
import { activeRunId, readFakeStripeCalls } from "./fake-stripe-ledger-e2e";

// ===========================================================================
// PAY-CCY-09 (#824): FAKE Stripe webhook transport for the disposable stack.
// ===========================================================================
//
// The fake processor (lib/stripe/e2e-fake-stripe.ts) creates synthetic
// PaymentIntents, Charges and Refunds and records each in the run-scoped fake
// ledger. Real Stripe would then DELIVER events about them. This module plays
// that delivery, and nothing else:
//
//   * PROVIDER FACTS come from the fake ledger: the PaymentIntent / Refund id,
//     and the amount and currency the synthetic processor created them with.
//     It never invents a refund the fake did not make, and never copies money
//     from the Hone row into an event (that would make every money check pass
//     by construction).
//   * METADATA is what the charge path really sends at PaymentIntent create
//     (lib/billing/session-payment-charge.ts), which real Stripe echoes on the
//     PaymentIntent and its Charge.
//   * The event is SIGNED with the stack's webhook secret using the Stripe
//     SDK's own test signer, and POSTed to the app's real route, which verifies
//     it with the real constructEvent. Nothing in the app is bypassed.
//
// SAFETY: test-only (never imported by app/lib/components; pinned by
// tests/dependencies/e2e-payment-helpers-test-only.test.ts). It refuses any
// non-loopback target, so it cannot reach a deployed environment. The app
// side accepts fake processor objects only where lib/stripe/e2e-fake-guard.ts
// already allows them.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Where events go, and the secret they are signed with. Env overrides let the
 * same transport drive a persistent local twin; both must stay on loopback. */
export function webhookTarget(): { url: string; secret: string } {
  const origin = process.env.HONE_E2E_WEBHOOK_ORIGIN ?? E2E_APP_ORIGIN;
  const secret = process.env.HONE_E2E_WEBHOOK_SECRET ?? E2E_WEB_SERVER_ENV.STRIPE_WEBHOOK_SECRET;
  const u = new URL(origin);
  if (!LOOPBACK.has(u.hostname)) {
    throw new Error(`fake-stripe-webhook refuses non-loopback target ${u.hostname}`);
  }
  if (!secret || !secret.startsWith("whsec_")) {
    throw new Error("fake-stripe-webhook needs the stack's whsec_ webhook secret");
  }
  return { url: new URL("/api/stripe/webhook", origin).toString(), secret };
}

type AttemptFacts = {
  id: string;
  studio_id: string;
  client_id: string;
  session_id: string | null;
  appointment_id: string | null;
  charge_reason: string;
  card_authorization_signature_id: string | null;
  stripe_account_id: string;
  stripe_payment_intent_id: string;
  stripe_charge_id: string | null;
};

async function attemptFacts(attemptId: string): Promise<AttemptFacts> {
  const r = await adminQuery(
    `select id, studio_id, client_id, session_id, appointment_id, charge_reason,
            card_authorization_signature_id, stripe_account_id,
            stripe_payment_intent_id, stripe_charge_id
       from public.payment_charge_attempts where id = $1`,
    [attemptId],
  );
  const row = r.rows[0] as AttemptFacts | undefined;
  if (!row?.stripe_payment_intent_id) {
    throw new Error(`attempt ${attemptId} has no PaymentIntent to deliver an event about`);
  }
  return row;
}

/** The metadata the charge path sends at create (and Stripe echoes). */
function chargeMetadata(a: AttemptFacts): Record<string, string> {
  return {
    hone_studio_id: a.studio_id,
    hone_client_id: a.client_id,
    hone_session_id: a.session_id ?? "",
    hone_appointment_id: a.appointment_id ?? "",
    hone_session_payment_charge_attempt_id: a.id,
    hone_charge_reason: a.charge_reason,
    hone_card_authorization_signature_id: a.card_authorization_signature_id ?? "",
    hone_environment: "test",
  };
}

/** The money the fake processor CREATED this PaymentIntent with. */
function processorMoney(paymentIntentId: string, runId: string) {
  const create = readFakeStripeCalls(runId).find(
    (c) => c.method === "pi_create" && !c.replay && c.resultId === paymentIntentId,
  );
  if (!create || create.amountCents == null || !create.currency) {
    throw new Error(`the fake ledger has no create for ${paymentIntentId} in run ${runId}`);
  }
  return { amount: create.amountCents, currency: create.currency };
}

/** The refund the fake processor actually made for this attempt, if any. */
export function processorRefund(attemptId: string, runId: string = activeRunId()) {
  const key = `hone:payment_refund:${attemptId}:v1`;
  const effect = readFakeStripeCalls(runId).find(
    (c) =>
      c.method === "refund_create" &&
      !c.replay &&
      c.idempotencyKey === key &&
      !c.resultId.endsWith("_refused"),
  );
  return effect ? { id: effect.resultId, amount: effect.amountCents } : null;
}

let seq = 0;
function eventEnvelope(type: string, account: string, object: unknown, runId: string) {
  seq += 1;
  return {
    id: `evt_test_e2e_${runId}_${Date.now()}_${seq}`,
    object: "event",
    api_version: "2026-04-22.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    account,
    data: { object },
  };
}

export type FakeEventOverrides = {
  /** Deliberately state different money, to prove the app refuses it. */
  amount?: number;
  currency?: string;
  /** Deliberately state a partial refund, to prove the app refuses it. */
  amountRefunded?: number;
};

/** payment_intent.succeeded for this attempt's synthetic PaymentIntent. */
export async function paymentIntentSucceededEvent(
  attemptId: string,
  over: FakeEventOverrides = {},
  runId: string = activeRunId(),
) {
  const a = await attemptFacts(attemptId);
  const money = processorMoney(a.stripe_payment_intent_id, runId);
  return eventEnvelope(
    "payment_intent.succeeded",
    a.stripe_account_id,
    {
      id: a.stripe_payment_intent_id,
      object: "payment_intent",
      status: "succeeded",
      amount: over.amount ?? money.amount,
      amount_received: over.amount ?? money.amount,
      currency: over.currency ?? money.currency,
      latest_charge: a.stripe_charge_id,
      metadata: chargeMetadata(a),
      livemode: false,
    },
    runId,
  );
}

/** charge.refunded naming the refund the fake processor actually made. */
export async function chargeRefundedEvent(
  attemptId: string,
  over: FakeEventOverrides = {},
  runId: string = activeRunId(),
) {
  const a = await attemptFacts(attemptId);
  if (!a.stripe_charge_id) throw new Error(`attempt ${attemptId} has no charge`);
  const money = processorMoney(a.stripe_payment_intent_id, runId);
  const refund = processorRefund(attemptId, runId);
  if (!refund) {
    throw new Error(`the fake processor made no refund for attempt ${attemptId}; nothing to report`);
  }
  const currency = over.currency ?? money.currency;
  const amount = over.amount ?? money.amount;
  return eventEnvelope(
    "charge.refunded",
    a.stripe_account_id,
    {
      id: a.stripe_charge_id,
      object: "charge",
      payment_intent: a.stripe_payment_intent_id,
      amount,
      amount_captured: amount,
      amount_refunded: over.amountRefunded ?? refund.amount ?? amount,
      currency,
      refunded: (over.amountRefunded ?? refund.amount ?? amount) === amount,
      metadata: chargeMetadata(a),
      livemode: false,
      refunds: {
        object: "list",
        data: [
          {
            id: refund.id,
            object: "refund",
            amount: refund.amount,
            currency,
            charge: a.stripe_charge_id,
            payment_intent: a.stripe_payment_intent_id,
            status: "succeeded",
          },
        ],
      },
    },
    runId,
  );
}

/** Sign with the stack's webhook secret and POST to the app's real route. */
export async function deliverStripeEvent(
  event: { id: string },
): Promise<{ status: number; body: string }> {
  const { url, secret } = webhookTarget();
  const payload = JSON.stringify(event);
  // Offline: the SDK's test signer computes the same HMAC header Stripe sends.
  // The placeholder key is never used for a request.
  const signer = new StripeSdk("sk_test_e2e_offline_signer_only");
  const header = signer.webhooks.generateTestHeaderString({ payload, secret });
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: payload,
  });
  return { status: res.status, body: await res.text() };
}
