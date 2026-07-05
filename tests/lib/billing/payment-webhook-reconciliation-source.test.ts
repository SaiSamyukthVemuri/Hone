import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #179. Source-grep tests pin the load-bearing shape of the
// webhook-reconciliation helpers. The runtime contract is critical
// because a webhook handler that silently flips a terminal local
// state would corrupt the audit trail; tests that ensure every
// branch is conditional are the structural defence.

const HELPER_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/payment-webhook-reconciliation.ts",
);
const HELPER = readFileSync(HELPER_PATH, "utf8");

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const HELPER_CODE = codeOnly(HELPER);

const ROUTE_PATH = path.resolve(
  __dirname,
  "../../../app/api/stripe/webhook/route.ts",
);
const ROUTE = readFileSync(ROUTE_PATH, "utf8");

describe("payment-webhook-reconciliation: server boundary", () => {
  it("imports 'server-only'", () => {
    expect(HELPER).toMatch(/^import "server-only";/);
  });

  it("uses createAdminClient (service role)", () => {
    expect(HELPER).toMatch(/createAdminClient/);
  });

  it("imports recordOpsAlert from the ops alerts helper", () => {
    expect(HELPER).toMatch(
      /import \{ recordOpsAlert \} from "@\/lib\/ops\/alerts"/,
    );
  });
});

describe("payment-webhook-reconciliation: NO new Stripe API calls", () => {
  it("does NOT call paymentIntents.create (code only)", () => {
    expect(HELPER_CODE).not.toMatch(/paymentIntents\.create/);
  });

  it("does NOT call refunds.create (code only)", () => {
    expect(HELPER_CODE).not.toMatch(/refunds\.create/);
  });

  it("does NOT call charges.create (code only)", () => {
    expect(HELPER_CODE).not.toMatch(/charges\.create/);
  });

  it("does NOT call setupIntents.create (code only)", () => {
    expect(HELPER_CODE).not.toMatch(/setupIntents\.create/);
  });

  it("does NOT call checkout.sessions (code only)", () => {
    expect(HELPER_CODE).not.toMatch(/checkout\.sessions/);
  });

  it("does NOT import getStripe (no SDK access needed)", () => {
    expect(HELPER).not.toMatch(/import \{[^}]*getStripe/);
  });

  it("does NOT send email or SMS (code only)", () => {
    expect(HELPER_CODE).not.toMatch(/sendEmailSafely|sendSms|twilio/i);
  });

  it("does NOT touch manual_fee_charge_attempts (code only)", () => {
    expect(HELPER_CODE).not.toMatch(/manual_fee_charge_attempts/);
  });
});

describe("payment-webhook-reconciliation: live-mode dormancy guard", () => {
  it("each handler calls shouldIgnoreLiveModeEvent first", () => {
    // The four handlers must call the guard before any other
    // payment_charge_attempts read.
    const handlers = [
      "handlePaymentIntentSucceeded",
      "handlePaymentIntentPaymentFailed",
      "handleChargeRefunded",
      "handleChargeDisputeCreated",
    ];
    for (const name of handlers) {
      const startIdx = HELPER.indexOf(`export async function ${name}(`);
      expect(startIdx).toBeGreaterThan(-1);
      const block = HELPER.slice(startIdx, startIdx + 1500);
      expect(block).toMatch(/shouldIgnoreLiveModeEvent/);
    }
  });

  it("the guard MODE-MATCHES: process iff event.livemode equals the deployment mode (PR #323)", () => {
    expect(HELPER).toMatch(/const deploymentLive = inferStripeLivemode\(\)/);
    expect(HELPER).toMatch(/eventLive === deploymentLive/);
    // The old "ignore whenever either is live" logic is gone.
    expect(HELPER).not.toMatch(/event\.livemode !== true && ctx\.livemode !== true/);
  });

  it("the live-mode guard records a warning ops_alert with stripe_webhook_livemode_event_ignored", () => {
    expect(HELPER).toMatch(
      /severity:\s*"warning"[\s\S]{0,400}event:\s*"stripe_webhook_livemode_event_ignored"/,
    );
  });
});

describe("PR #319: setup_intent.succeeded live-mode dormancy guard", () => {
  it("shouldIgnoreLiveModeEvent is exported for the route to reuse", () => {
    expect(HELPER).toMatch(
      /export async function shouldIgnoreLiveModeEvent\(/,
    );
  });

  it("the route imports the shared guard from the reconciliation module", () => {
    expect(ROUTE).toMatch(
      /import \{[\s\S]*shouldIgnoreLiveModeEvent[\s\S]*\} from "@\/lib\/billing\/payment-webhook-reconciliation"/,
    );
  });

  it("handleSetupIntentSucceeded calls the guard BEFORE any client_payment_methods write (and before the customer-lineage read)", () => {
    const startIdx = ROUTE.indexOf(
      "async function handleSetupIntentSucceeded(",
    );
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = ROUTE.indexOf("\nasync function ", startIdx + 1);
    const block = ROUTE.slice(startIdx, endIdx === -1 ? undefined : endIdx);

    const guardIdx = block.indexOf(
      'shouldIgnoreLiveModeEvent(event, ctx, "setup_intent.succeeded")',
    );
    // Anchor on the actual DB operations (.from("...")), not bare mentions —
    // a comment naming the tables must not fool the ordering check.
    const pmIdx = block.indexOf('.from("client_payment_methods")');
    const lineageIdx = block.indexOf('.from("client_stripe_customers")');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(pmIdx).toBeGreaterThan(-1); // the handler does write cards in test mode
    // Guard runs first — before the card write AND before the lineage read.
    expect(guardIdx).toBeLessThan(pmIdx);
    expect(guardIdx).toBeLessThan(lineageIdx);
  });

  it("a live event returns an ignored summary WITHOUT throwing (idempotency preserved)", () => {
    const startIdx = ROUTE.indexOf(
      "async function handleSetupIntentSucceeded(",
    );
    const block = ROUTE.slice(startIdx, startIdx + 1200);
    // Ignored path returns a sanitized summary (marked processed by the route),
    // never throws — so Stripe is not retried into a storm.
    expect(block).toMatch(
      /shouldIgnoreLiveModeEvent\(event, ctx, "setup_intent\.succeeded"\)\s*\)\s*\{\s*return \{[\s\S]{0,160}livemodeEventIgnored: true/,
    );
    // The ignored return carries no card/PII — only ids + the flag.
    const returnBlock = block.slice(
      block.indexOf("livemodeEventIgnored: true") - 200,
      block.indexOf("livemodeEventIgnored: true") + 40,
    );
    expect(returnBlock).not.toMatch(/payment_method|card|customer/i);
  });
});

describe("payment-webhook-reconciliation: metadata lookup order", () => {
  it("resolves the canonical key 'hone_payment_charge_attempt_id' first", () => {
    expect(HELPER).toMatch(/hone_payment_charge_attempt_id/);
    expect(HELPER).toMatch(
      /1\. Canonical metadata[\s\S]{0,800}canonicalId/,
    );
  });

  it("falls back to the legacy 'hone_session_payment_charge_attempt_id' second", () => {
    expect(HELPER).toMatch(/hone_session_payment_charge_attempt_id/);
    expect(HELPER).toMatch(
      /2\. Legacy metadata[\s\S]{0,800}legacyId/,
    );
  });

  it("falls back to stripe_payment_intent_id or stripe_charge_id last", () => {
    expect(HELPER).toMatch(/3\. Stripe id fallback/);
    expect(HELPER).toMatch(/fallbackByPaymentIntentId/);
    expect(HELPER).toMatch(/fallbackByChargeId/);
  });
});

describe("payment-webhook-reconciliation: metadata mismatch handling", () => {
  it("verifies studio_id, client_id, charge_reason against the row", () => {
    expect(HELPER).toMatch(/hone_studio_id/);
    expect(HELPER).toMatch(/hone_client_id/);
    expect(HELPER).toMatch(/hone_charge_reason/);
  });

  it("records a critical ops_alert with event 'stripe_webhook_metadata_mismatch'", () => {
    expect(HELPER).toMatch(
      /severity:\s*"critical"[\s\S]{0,400}event:\s*"stripe_webhook_metadata_mismatch"/,
    );
  });

  it("does NOT mutate the row on a metadata mismatch", () => {
    // The verifyMetadataAgainstRow helper returns false, and the
    // handlers short-circuit with metadataMismatch:true BEFORE any
    // UPDATE call.
    const blocks = HELPER.match(/metadataMismatch:\s*true/g) ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });
});

describe("resolved-row livemode guard — symmetric across ALL mutating handlers", () => {
  // Extract each mutating handler's body so the guard is checked per-handler.
  function handlerBody(name: string): string {
    const start = HELPER.indexOf(`export async function ${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThan(-1);
    const next = HELPER.indexOf("\nexport async function ", start + 1);
    return HELPER.slice(start, next === -1 ? undefined : next);
  }

  const MUTATING = [
    ["handlePaymentIntentSucceeded", "payment_intent_succeeded_livemode_row_mismatch"],
    ["handlePaymentIntentPaymentFailed", "payment_intent_failed_livemode_row_mismatch"],
    ["handleChargeRefunded", "charge_refunded_livemode_row_mismatch"],
  ] as const;

  for (const [handler, alertEvent] of MUTATING) {
    it(`${handler} guards the resolved row's stripe_livemode and refuses to mutate on mismatch`, () => {
      const body = handlerBody(handler);
      // The guard compares the ROW's mode to the deployment mode.
      expect(body).toMatch(/attempt\.stripe_livemode !== inferStripeLivemode\(\)/);
      // Critical, correctly-named ops alert with the no-mutation message.
      expect(body).toMatch(
        new RegExp(`severity:\\s*"critical"[\\s\\S]{0,400}event:\\s*"${alertEvent}"`),
      );
      expect(body).toMatch(/Row was NOT mutated/);
      // Structured no-mutation return.
      expect(body).toMatch(/livemodeRowMismatch:\s*true/);
      // The guard sits BEFORE the row-mutating UPDATE (no mutation on mismatch).
      const guard = body.indexOf("livemodeRowMismatch: true");
      const update = body.indexOf(".update(");
      expect(guard).toBeGreaterThan(-1);
      expect(update).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(update);
    });
  }
});

describe("payment_intent.succeeded: status-conditional reconciliation", () => {
  it("idempotent on already-succeeded rows (no flip, may stamp missing charge id)", () => {
    expect(HELPER).toMatch(
      /attempt\.status === "succeeded"[\s\S]{0,2000}alreadySucceeded:\s*true/,
    );
  });

  it("critical ops_alert on terminal local state (failed/cancelled/blocked)", () => {
    // The code keys list severity before event; pin both literals
    // appearing close together in either order.
    expect(HELPER).toMatch(
      /severity:\s*"critical"[\s\S]{0,400}payment_intent_succeeded_local_terminal_mismatch/,
    );
  });

  it("flips ready/pending_stripe to succeeded via status-conditional UPDATE", () => {
    expect(HELPER).toMatch(
      /\.update\(updates\)[\s\S]{0,2000}\.in\("status",\s*\["ready",\s*"pending_stripe"\]\)/,
    );
  });

  it("stamps charged_at + clears failure fields", () => {
    expect(HELPER).toMatch(/status:\s*"succeeded"[\s\S]{0,2000}charged_at/);
    expect(HELPER).toMatch(/failure_code:\s*null/);
    expect(HELPER).toMatch(/failure_message_safe:\s*null/);
  });
});

describe("payment_intent.payment_failed: status-conditional reconciliation", () => {
  it("critical ops_alert if row is already succeeded (no silent flip)", () => {
    expect(HELPER).toMatch(
      /severity:\s*"critical"[\s\S]{0,400}payment_intent_failed_after_local_succeeded/,
    );
  });

  it("idempotent on already-failed rows", () => {
    expect(HELPER).toMatch(
      /attempt\.status === "failed"[\s\S]{0,2000}alreadyFailed:\s*true/,
    );
  });

  it("critical ops_alert on cancelled/blocked terminal state", () => {
    expect(HELPER).toMatch(
      /severity:\s*"critical"[\s\S]{0,400}payment_intent_failed_local_terminal_mismatch/,
    );
  });

  it("flips ready/pending_stripe to failed with sanitised code + message", () => {
    expect(HELPER).toMatch(
      /status:\s*"failed"[\s\S]{0,2000}failure_code:\s*code[\s\S]{0,2000}failure_message_safe:\s*safeMessage/,
    );
  });

  it("sanitises the Stripe last_payment_error code + message", () => {
    expect(HELPER).toMatch(/sanitizeFailureCode\(lastError\?\.code/);
    expect(HELPER).toMatch(/sanitizeFailureMessage\(lastError\?\.message/);
  });
});

describe("charge.refunded: full vs partial discrimination", () => {
  it("computes isFullRefund as charge.refunded === true AND amount_refunded === amount_captured", () => {
    expect(HELPER).toMatch(
      /charge\.refunded === true && amountRefunded === amountCaptured/,
    );
  });

  it("partial refund: critical ops_alert + NO row mutation", () => {
    expect(HELPER).toMatch(
      /severity:\s*"critical"[\s\S]{0,400}charge_refunded_partial_out_of_band/,
    );
    expect(HELPER).toMatch(/partialRefundIgnored:\s*true/);
  });

  it("the partial-refund safeDetails carries the amount captured + amount refunded", () => {
    expect(HELPER).toMatch(/amount_captured:\s*amountCaptured/);
    expect(HELPER).toMatch(/amount_refunded:\s*amountRefunded/);
  });
});

describe("charge.refunded: full refund reconciliation paths", () => {
  it("idempotent on already-refunded rows (may stamp missing refund id)", () => {
    expect(HELPER).toMatch(
      /attempt\.refund_status === "succeeded"[\s\S]{0,2000}alreadyRefunded:\s*true/,
    );
  });

  it("pending_stripe refund: flip to succeeded via conditional UPDATE", () => {
    expect(HELPER).toMatch(
      /refund_status === "pending_stripe"[\s\S]{0,2000}\.eq\("refund_status",\s*"pending_stripe"\)/,
    );
  });

  it("out-of-band (null or failed) full refund: warning ops_alert charge_refunded_out_of_band_reconciled", () => {
    expect(HELPER).toMatch(
      /severity:\s*"warning"[\s\S]{0,400}charge_refunded_out_of_band_reconciled/,
    );
  });

  it("out-of-band UPDATE is scoped to null OR 'failed' refund_status (no concurrent race)", () => {
    expect(HELPER).toMatch(
      /\.or\("refund_status\.is\.null,refund_status\.eq\.failed"\)/,
    );
  });
});

describe("charge.dispute.created: alert-only", () => {
  it("looks up the charge id from dispute.charge", () => {
    expect(HELPER).toMatch(
      /typeof dispute\.charge === "string"[\s\S]{0,2000}dispute\.charge\?.id/,
    );
  });

  it("records a critical ops_alert with event 'payment_charge_dispute_created'", () => {
    expect(HELPER).toMatch(
      /severity:\s*"critical"[\s\S]{0,400}event:\s*"payment_charge_dispute_created"/,
    );
  });

  it("safeDetails carries dispute id + charge id + amount + currency + reason + status", () => {
    const block =
      HELPER.match(
        /event:\s*"payment_charge_dispute_created"[\s\S]{0,2000}\},\s*\}\)/,
      )?.[0] ?? "";
    expect(block).toMatch(/stripe_dispute_id:\s*dispute\.id/);
    expect(block).toMatch(/stripe_charge_id:\s*chargeId/);
    expect(block).toMatch(/amount:\s*dispute\.amount/);
    expect(block).toMatch(/currency:\s*dispute\.currency/);
    expect(block).toMatch(/reason:\s*dispute\.reason/);
    expect(block).toMatch(/status:\s*dispute\.status/);
  });

  it("does NOT mutate any payment_charge_attempts row", () => {
    // The dispute handler does .select(...) for studio/client context
    // but never .update or .insert on payment_charge_attempts.
    const startIdx = HELPER.indexOf(
      "export async function handleChargeDisputeCreated(",
    );
    const endIdx = HELPER.length;
    const body = HELPER.slice(startIdx, endIdx);
    expect(body).not.toMatch(
      /from\("payment_charge_attempts"\)[\s\S]{0,800}\.update\(/,
    );
    expect(body).not.toMatch(
      /from\("payment_charge_attempts"\)[\s\S]{0,800}\.insert\(/,
    );
  });
});

describe("payment-webhook-reconciliation: no-match handling", () => {
  it("payment_intent.succeeded no-match -> warning ops_alert + no mutation", () => {
    expect(HELPER).toMatch(
      /severity:\s*"warning"[\s\S]{0,400}payment_intent_succeeded_no_match/,
    );
  });

  it("payment_intent.payment_failed no-match -> warning ops_alert + no mutation", () => {
    expect(HELPER).toMatch(
      /severity:\s*"warning"[\s\S]{0,400}payment_intent_failed_no_match/,
    );
  });

  it("charge.refunded no-match -> warning ops_alert + no mutation", () => {
    expect(HELPER).toMatch(
      /severity:\s*"warning"[\s\S]{0,400}charge_refunded_no_match/,
    );
  });
});

describe("payment-webhook-reconciliation: reason-agnostic by construction", () => {
  it("the handlers never branch on hardcoded charge_reason literals", () => {
    expect(HELPER_CODE).not.toMatch(
      /charge_reason\s*===?\s*"session_payment"|charge_reason\s*===?\s*"late_cancellation_fee"|charge_reason\s*===?\s*"no_show_fee"/,
    );
  });

  it("metadata mismatch comparison reads charge_reason as a generic field", () => {
    expect(HELPER).toMatch(
      /m\["hone_charge_reason"\] !== args\.attempt\.charge_reason/,
    );
  });
});

describe("Webhook route wiring (PR #179)", () => {
  it("imports all four reconciliation handlers (+ the shared live-mode guard, PR #319)", () => {
    expect(ROUTE).toMatch(
      /import \{\s*\n?\s*handlePaymentIntentSucceeded,\s*\n?\s*handlePaymentIntentPaymentFailed,\s*\n?\s*handleChargeRefunded,\s*\n?\s*handleChargeDisputeCreated,\s*\n?\s*shouldIgnoreLiveModeEvent,\s*\n?\s*\} from "@\/lib\/billing\/payment-webhook-reconciliation"/,
    );
  });

  it("dispatches payment_intent.succeeded to the handler", () => {
    expect(ROUTE).toMatch(
      /case "payment_intent\.succeeded":[\s\S]{0,200}handlePaymentIntentSucceeded\(event, ctx\)/,
    );
  });

  it("dispatches payment_intent.payment_failed to the handler", () => {
    expect(ROUTE).toMatch(
      /case "payment_intent\.payment_failed":[\s\S]{0,200}handlePaymentIntentPaymentFailed\(event, ctx\)/,
    );
  });

  it("dispatches charge.refunded to the handler", () => {
    expect(ROUTE).toMatch(
      /case "charge\.refunded":[\s\S]{0,200}handleChargeRefunded\(event, ctx\)/,
    );
  });

  it("dispatches charge.dispute.created to the handler", () => {
    expect(ROUTE).toMatch(
      /case "charge\.dispute\.created":[\s\S]{0,200}handleChargeDisputeCreated\(event, ctx\)/,
    );
  });
});

describe("Webhook route: signature + idempotency preserved", () => {
  it("still verifies Stripe signature via stripe.webhooks.constructEvent", () => {
    expect(ROUTE).toMatch(/stripe\.webhooks\.constructEvent/);
  });

  it("still claims the event via claim_stripe_event RPC", () => {
    expect(ROUTE).toMatch(/claim_stripe_event/);
  });

  it("still returns 200 on already_processed (duplicate event id)", () => {
    expect(ROUTE).toMatch(
      /claim\.already_processed[\s\S]{0,2000}alreadyProcessed:\s*true/,
    );
  });

  it("still returns 400 on bad signature", () => {
    // The status:400 returns appear several places after the
    // GENERIC_BAD_SIGNATURE constant declaration; widen the slack.
    expect(ROUTE).toMatch(
      /Invalid signature[\s\S]{0,5000}status:\s*400/,
    );
  });
});

describe("Webhook route: PR #179 does NOT introduce new Stripe API calls", () => {
  it("the route still has no paymentIntents.create call", () => {
    const routeCode = codeOnly(ROUTE);
    expect(routeCode).not.toMatch(/paymentIntents\.create/);
  });

  it("the route still has no refunds.create call", () => {
    const routeCode = codeOnly(ROUTE);
    expect(routeCode).not.toMatch(/refunds\.create/);
  });

  it("the route still has no charges.create call", () => {
    const routeCode = codeOnly(ROUTE);
    expect(routeCode).not.toMatch(/charges\.create/);
  });
});
