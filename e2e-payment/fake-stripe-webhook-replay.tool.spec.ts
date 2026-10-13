import { test, expect } from "@playwright/test";
import { adminQuery, closePool } from "./helpers/payment-fixture";
import {
  chargeRefundedEvent,
  deliverStripeEvent,
  paymentIntentSucceededEvent,
  processorRefund,
  webhookTarget,
} from "./helpers/fake-stripe-webhook";

// ===========================================================================
// PAY-CCY-09 OPERATOR TOOL (FAKE): replay Stripe webhooks for ONE attempt on a
// running local twin, AFTER the charge / receipt / refund were driven in its
// owner UI. Skipped unless HONE_E2E_REPLAY_ATTEMPT_ID is set, so it is inert in
// the normal payment suite.
// ===========================================================================
//
// Inputs (all required except the event list):
//   HONE_E2E_REPLAY_ATTEMPT_ID  payment_charge_attempts.id to replay for
//   HONE_E2E_RUN_ID             the twin server's fake-processor run id (its ledger)
//   HONE_LOCAL_DB_URL           the twin's LOOPBACK database (the db-target guard
//                               refuses a mismatch with e2e/helpers/local-env.ts)
//   HONE_E2E_WEBHOOK_ORIGIN     the twin app's LOOPBACK origin, e.g. http://127.0.0.1:3995
//   HONE_E2E_WEBHOOK_SECRET     the twin server's STRIPE_WEBHOOK_SECRET (whsec_…)
//   HONE_E2E_REPLAY_EVENTS      optional, comma list of succeeded,refunded
//                               (default: both; refunded only if the fake refunded)
//
// Each event's FIRST delivery may settle state (a refund left pending_stripe by
// an unknown processor outcome becomes succeeded). It is then delivered again
// with the same id and once with a fresh id, and the attempt's money/refund
// state must not change: replay is proven idempotent on the twin, not assumed.

const ATTEMPT = process.env.HONE_E2E_REPLAY_ATTEMPT_ID;

test.skip(!ATTEMPT, "operator tool: set HONE_E2E_REPLAY_ATTEMPT_ID to run");

test.afterAll(async () => {
  await closePool();
});

async function state(attemptId: string) {
  const r = await adminQuery(
    `select status, currency, amount_cents, receipt_status, refund_status,
            refund_amount_cents, stripe_payment_intent_id, stripe_charge_id, stripe_refund_id
       from public.payment_charge_attempts where id = $1`,
    [attemptId],
  );
  return r.rows[0] as Record<string, unknown> | undefined;
}

test("FAKE webhook replay for one attempt is idempotent", async () => {
  const attemptId = ATTEMPT!;
  const target = webhookTarget(); // throws unless loopback + whsec_ secret
  const wanted = (process.env.HONE_E2E_REPLAY_EVENTS ?? "succeeded,refunded")
    .split(",")
    .map((s) => s.trim());

  const before = await state(attemptId);
  expect(before, `attempt ${attemptId} not found on this database`).toBeDefined();

  const builders: Array<[string, () => Promise<{ id: string }>]> = [];
  if (wanted.includes("succeeded")) {
    builders.push(["payment_intent.succeeded", () => paymentIntentSucceededEvent(attemptId)]);
  }
  if (wanted.includes("refunded") && processorRefund(attemptId)) {
    builders.push(["charge.refunded", () => chargeRefundedEvent(attemptId)]);
  }

  const log: Array<{ type: string; eventId: string; status: number; replay: boolean }> = [];
  const deliver = async (type: string, ev: { id: string }, replay: boolean) => {
    const res = await deliverStripeEvent(ev);
    log.push({ type, eventId: ev.id, status: res.status, replay });
    expect(res.status, `${type} ${ev.id}: ${res.body.slice(0, 200)}`).toBe(200);
  };

  // FIRST delivery of each event may legitimately settle state (e.g. a refund
  // left pending_stripe by an unknown processor outcome becomes succeeded).
  const firsts: Array<[string, { id: string }, () => Promise<{ id: string }>]> = [];
  for (const [type, build] of builders) {
    const ev = await build();
    await deliver(type, ev, false);
    firsts.push([type, ev, build]);
  }
  const settled = await state(attemptId);

  // REPLAYS (same id again, then a fresh id with the same facts) change nothing.
  for (const [type, ev, build] of firsts) {
    await deliver(type, ev, true);
    await deliver(type, await build(), true);
  }
  const after = await state(attemptId);

  console.log(
    JSON.stringify(
      { fake: true, target: target.url, attemptId, before, settled, after, deliveries: log },
      null,
      2,
    ),
  );
  expect(after).toEqual(settled);
});
