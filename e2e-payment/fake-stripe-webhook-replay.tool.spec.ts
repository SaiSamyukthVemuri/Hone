import { test, expect } from "@playwright/test";
// The loopback-only harness, not ./helpers/payment-fixture: that module's seed
// guard pins the database to local-env's, and this tool reads the TWIN's
// (Codex P2 4265382406). This tool only reads; it seeds nothing.
import { adminQuery, closePool } from "../tests/db/helpers/harness";
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
// Run it with its OWN config, which starts no server (Codex P2 4265382410):
//
//   npx playwright test --config e2e-payment/replay-tool.playwright.config.ts
//
// Inputs (all required except the event list; none falls back to a default, so
// the tool can never quietly read the shared stack or post to the lane's port):
//   HONE_E2E_REPLAY_ATTEMPT_ID  payment_charge_attempts.id to replay for
//   HONE_E2E_RUN_ID             the twin server's fake-processor run id (its ledger)
//   HONE_LOCAL_DB_URL           the twin's LOOPBACK database, any port (read only)
//   HONE_E2E_WEBHOOK_ORIGIN     the twin app's LOOPBACK origin, e.g. http://127.0.0.1:3995
//   HONE_E2E_WEBHOOK_SECRET     the twin server's STRIPE_WEBHOOK_SECRET (whsec_…)
//   HONE_E2E_REPLAY_EVENTS      optional, comma list of succeeded,refunded
//                               (default: both; refunded only if the fake refunded).
//                               An unknown or empty name, refunded named with no
//                               fake refund, or nothing to build FAILS the tool.
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

const KNOWN_EVENTS = new Set(["succeeded", "refunded"]);

const REQUIRED = [
  "HONE_E2E_RUN_ID",
  "HONE_LOCAL_DB_URL",
  "HONE_E2E_WEBHOOK_ORIGIN",
  "HONE_E2E_WEBHOOK_SECRET",
] as const;

test("FAKE webhook replay for one attempt is idempotent", async () => {
  const attemptId = ATTEMPT!;
  if (process.env.HONE_E2E_REPLAY_TOOL_CONFIG !== "1") {
    throw new Error(
      "replay tool: run it with --config e2e-payment/replay-tool.playwright.config.ts " +
        "(no webServer); a lane config would start its own server instead of using the twin",
    );
  }
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`replay tool: set ${missing.join(", ")} (no defaults, by design)`);
  }
  const target = webhookTarget(); // throws unless loopback + whsec_ secret
  // Every requested name must be known, and at least one event must be built:
  // an empty list or a typo would otherwise deliver nothing and "prove"
  // idempotence by comparing an untouched row to itself (Codex P2 4265594526).
  const wanted = (process.env.HONE_E2E_REPLAY_EVENTS ?? "succeeded,refunded")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = wanted.filter((w) => !KNOWN_EVENTS.has(w));
  if (wanted.length === 0 || unknown.length > 0) {
    throw new Error(
      `replay tool: HONE_E2E_REPLAY_EVENTS must name succeeded and/or refunded; got ${JSON.stringify(
        process.env.HONE_E2E_REPLAY_EVENTS ?? "",
      )}`,
    );
  }

  const before = await state(attemptId);
  expect(before, `attempt ${attemptId} not found on this database`).toBeDefined();

  const builders: Array<[string, () => Promise<{ id: string }>]> = [];
  if (wanted.includes("succeeded")) {
    builders.push(["payment_intent.succeeded", () => paymentIntentSucceededEvent(attemptId)]);
  }
  if (wanted.includes("refunded")) {
    if (processorRefund(attemptId)) {
      builders.push(["charge.refunded", () => chargeRefundedEvent(attemptId)]);
    } else if (process.env.HONE_E2E_REPLAY_EVENTS !== undefined) {
      // Asked for by name, but the fake processor made no refund to report.
      throw new Error(`replay tool: refunded was requested, but the fake processor made no refund for ${attemptId}`);
    }
  }
  if (builders.length === 0) {
    throw new Error("replay tool: no requested event can be built for this attempt; nothing would be proven");
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

  // A delivered charge.refunded must have RECONCILED the refund to the
  // processor's own refund, not merely been acknowledged: a route that answers
  // 200 and ignores the event would otherwise leave pending_stripe in place and
  // the replays below would "prove" idempotence of a failure (Codex P2 4265724221).
  const processor = processorRefund(attemptId);
  if (firsts.some(([type]) => type === "charge.refunded") && processor) {
    expect(settled, "charge.refunded did not reconcile the refund").toMatchObject({
      refund_status: "succeeded",
      stripe_refund_id: processor.id,
      refund_amount_cents: processor.amount,
    });
  }

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
