import StripeSdk from "stripe";
import { E2E_APP_ORIGIN, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";
// The harness directly (loopback-only by its own checks), NOT ./payment-fixture:
// that module's import-time seed guard pins the database to local-env's, which
// would stop the operator replay tool from reading a twin on another port
// (Codex P2 4265382406). Specs that SEED still import payment-fixture.
import { adminQuery } from "../../tests/db/helpers/harness";
import { activeRunId, readFakeStripeCalls } from "./fake-stripe-ledger-e2e";
import { metadataDigest } from "./fake-stripe-metadata-digest";

// ===========================================================================
// PAY-CCY-09 (#824): FAKE Stripe webhook transport for the disposable stack.
// ===========================================================================
//
// The fake processor (lib/stripe/e2e-fake-stripe.ts) creates synthetic
// PaymentIntents, Charges and Refunds and records each in the run-scoped fake
// ledger. Real Stripe would then DELIVER events about them. This module plays
// that delivery, and nothing else:
//
//   * PROVIDER FACTS come from the fake ledger: the PaymentIntent id, the money
//     the processor created it with, the CHARGE it produced, and the refund it
//     actually made and the charge that refund targeted. It never invents a
//     refund the fake did not make, never copies money or ids from the Hone row
//     into an event, and refuses to build an event whose provider lineage
//     (refund -> charge -> PaymentIntent, and the row's charge) does not hold
//     (Codex P2 4264919593) — a broken lineage is a finding, not an event.
//     The event's Connect `account` is the account the processor created the
//     PaymentIntent (and made the refund) on, and the row must name it too
//     (Codex P2 4265803389).
//   * METADATA is what the charge path really sends at PaymentIntent create
//     (lib/billing/session-payment-charge.ts), which real Stripe echoes on the
//     PaymentIntent and its Charge. It is only signed when it hashes to the
//     digest the fake processor recorded of the metadata it RECEIVED (Codex P2
//     4265594520), so a wrong value sent by the charge path fails the test
//     instead of being silently corrected from the row.
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
  stripe_idempotency_key: string | null;
};

async function attemptFacts(attemptId: string): Promise<AttemptFacts> {
  const r = await adminQuery(
    `select id, studio_id, client_id, session_id, appointment_id, charge_reason,
            card_authorization_signature_id, stripe_account_id,
            stripe_payment_intent_id, stripe_charge_id, stripe_idempotency_key
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

/** What the fake processor CREATED for this PaymentIntent: money and charge. */
function processorCreate(a: AttemptFacts, runId: string) {
  const paymentIntentId = a.stripe_payment_intent_id;
  // THIS attempt's create: the PaymentIntent id AND the idempotency key the
  // charge path stored on the row. An id alone is not enough: a ledger that
  // outlived a server restart once held three creates all named
  // pi_test_e2e_<run>_1 (twin finding, 2026-10-14), and the first one found
  // belonged to another attempt. More than one match is ambiguous lineage.
  const creates = readFakeStripeCalls(runId).filter(
    (c) => c.method === "pi_create" && !c.replay && c.resultId === paymentIntentId,
  );
  assertLineage(
    creates.length <= 1,
    `${creates.length} processor creates are named ${paymentIntentId} in run ${runId} (ids reused)`,
  );
  const create = creates[0];
  if (!create || create.amountCents == null || !create.currency) {
    throw new Error(`the fake ledger has no create for ${paymentIntentId} in run ${runId}`);
  }
  assertLineage(
    a.stripe_idempotency_key !== null && create.idempotencyKey === a.stripe_idempotency_key,
    `${paymentIntentId} was created under key ${create.idempotencyKey}, the attempt stored ${a.stripe_idempotency_key}`,
  );
  return {
    amount: create.amountCents,
    currency: create.currency,
    chargeId: create.chargeId ?? null,
    metadataDigest: create.metadataDigest ?? null,
    stripeAccount: create.stripeAccount ?? null,
  };
}

/** The connected account an event is delivered under is the one the processor
 * CREATED the object on (Codex P2 4265803389): Stripe delivers a Connect event
 * from that account, and the webhook route derives studio context from it. The
 * row must name the same account, and a refund must have been made on it. */
function connectAccount(
  a: AttemptFacts,
  created: { stripeAccount: string | null },
  refund?: { id: string; stripeAccount: string | null },
): string {
  assertLineage(
    created.stripeAccount !== null && created.stripeAccount === a.stripe_account_id,
    `${a.stripe_payment_intent_id} was created on ${created.stripeAccount}, the attempt names ${a.stripe_account_id}`,
  );
  if (refund) {
    assertLineage(
      refund.stripeAccount === created.stripeAccount,
      `refund ${refund.id} was made on ${refund.stripeAccount}, the charge on ${created.stripeAccount}`,
    );
  }
  return created.stripeAccount as string;
}

/** The metadata an event will carry must be what the charge path actually SENT
 * at create (Codex P2 4265594520). Built from the row, it is only trusted when
 * it hashes to the processor's own record of the create. */
function eventMetadata(a: AttemptFacts, created: { metadataDigest: string | null }) {
  const md = chargeMetadata(a);
  assertLineage(
    created.metadataDigest !== null && metadataDigest(md) === created.metadataDigest,
    `the metadata the processor received for ${a.stripe_payment_intent_id} differs from the attempt row`,
  );
  return md;
}

/** The refund the fake processor actually made for this attempt, if any, with
 * the charge it targeted. */
export function processorRefund(attemptId: string, runId: string = activeRunId()) {
  const key = `hone:payment_refund:${attemptId}:v1`;
  const effects = readFakeStripeCalls(runId).filter(
    (c) =>
      c.method === "refund_create" &&
      !c.replay &&
      c.idempotencyKey === key &&
      !c.resultId.endsWith("_refused"),
  );
  // One refund per attempt key. Two effects under one key mean the processor's
  // idempotency did not hold (e.g. across a server restart): ambiguous lineage.
  assertLineage(
    effects.length <= 1,
    `${effects.length} processor refunds were made under ${key} in run ${runId}`,
  );
  const effect = effects[0];
  return effect
    ? {
        id: effect.resultId,
        amount: effect.amountCents,
        chargeId: effect.chargeId ?? null,
        stripeAccount: effect.stripeAccount ?? null,
      }
    : null;
}

/** Refuse to build an event whose provider lineage does not hold. */
function assertLineage(holds: boolean, what: string): void {
  if (!holds) {
    throw new Error(`fake-stripe-webhook: provider lineage broken: ${what}; no event built`);
  }
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
  const created = processorCreate(a, runId);
  assertLineage(created.chargeId !== null, `the processor produced no charge for ${a.stripe_payment_intent_id}`);
  assertLineage(
    a.stripe_charge_id === created.chargeId,
    `the attempt names charge ${a.stripe_charge_id}, the processor produced ${created.chargeId}`,
  );
  const amount = over.amount ?? created.amount;
  return eventEnvelope(
    "payment_intent.succeeded",
    connectAccount(a, created),
    {
      id: a.stripe_payment_intent_id,
      object: "payment_intent",
      status: "succeeded",
      amount,
      amount_received: amount,
      currency: over.currency ?? created.currency,
      latest_charge: created.chargeId,
      metadata: eventMetadata(a, created),
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
  const created = processorCreate(a, runId);
  const refund = processorRefund(attemptId, runId);
  if (!refund) {
    throw new Error(`the fake processor made no refund for attempt ${attemptId}; nothing to report`);
  }
  // refund -> charge -> PaymentIntent from the processor's own record, and the
  // Hone row must name that same charge.
  assertLineage(refund.chargeId !== null, `refund ${refund.id} names no charge`);
  assertLineage(
    refund.chargeId === created.chargeId,
    `refund ${refund.id} targeted ${refund.chargeId}, but ${a.stripe_payment_intent_id} produced ${created.chargeId}`,
  );
  assertLineage(
    a.stripe_charge_id === refund.chargeId,
    `the attempt names charge ${a.stripe_charge_id}, the processor refunded ${refund.chargeId}`,
  );
  const chargeId = refund.chargeId as string;
  const currency = over.currency ?? created.currency;
  const amount = over.amount ?? created.amount;
  const refunded = over.amountRefunded ?? refund.amount ?? amount;
  return eventEnvelope(
    "charge.refunded",
    connectAccount(a, created, refund),
    {
      id: chargeId,
      object: "charge",
      payment_intent: a.stripe_payment_intent_id,
      amount,
      amount_captured: amount,
      amount_refunded: refunded,
      currency,
      refunded: refunded === amount,
      metadata: eventMetadata(a, created),
      livemode: false,
      refunds: {
        object: "list",
        data: [
          {
            id: refund.id,
            object: "refund",
            amount: refund.amount,
            currency,
            charge: chargeId,
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
