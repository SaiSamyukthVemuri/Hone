import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #178. Source-grep tests pin the load-bearing shape of the
// refund helper. The helper is the single allowlisted refunds.create
// call site in the runtime tree; the gate script (PR #178 update)
// enforces exactly 1 occurrence here and zero elsewhere.

const HELPER_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/payment-refund.ts",
);
const HELPER = readFileSync(HELPER_PATH, "utf8");

// codeOnly strips // comment lines so a docblock mention of an
// SDK call (e.g. "No application_fee_amount.") does not trip
// negative regexes that look for the actual SDK access.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const HELPER_CODE = codeOnly(HELPER);

const ACTION_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
);
const ACTION = readFileSync(ACTION_PATH, "utf8");

const FEE_ACTION_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/calendar/[id]/manual-fee-actions.ts",
);
const FEE_ACTION = readFileSync(FEE_ACTION_PATH, "utf8");

// PR #296: refund initiation is studio-owner-only. Both action callers
// gate on role === "owner", AND the shared helper re-checks it (defense in
// depth) before any claim/refund — so a future helper caller cannot bypass
// owner-only. Denial logging carries safe IDs only (no client PII).
describe("refund owner-only gate (PR #296)", () => {
  it("both action callers gate on role === 'owner' before calling the helper", () => {
    // Session payment refund action.
    expect(ACTION).toMatch(/refundPaymentChargeAttemptAction/);
    expect(ACTION).toMatch(/practitioner\.role !== "owner"/);
    const sessGate = ACTION.indexOf('practitioner.role !== "owner"');
    const sessCall = ACTION.indexOf("refundPaymentChargeAttempt({");
    expect(sessGate).toBeGreaterThan(-1);
    expect(sessCall).toBeGreaterThan(sessGate); // gate before the helper call
    // Manual-fee refund action.
    expect(FEE_ACTION).toMatch(/refundFeeAttemptAction/);
    expect(FEE_ACTION).toMatch(/practitioner\.role !== "owner"/);
    const feeGate = FEE_ACTION.indexOf('practitioner.role !== "owner"');
    const feeCall = FEE_ACTION.indexOf("refundPaymentChargeAttempt({");
    expect(feeGate).toBeGreaterThan(-1);
    expect(feeCall).toBeGreaterThan(feeGate);
  });

  it("the shared helper re-checks role === 'owner' (defense in depth)", () => {
    // Reads the actor's role from the existing practitioners.role column,
    // scoped to the resolved studio, and rejects non-owners.
    expect(HELPER_CODE).toMatch(/\.from\("practitioners"\)/);
    expect(HELPER_CODE).toMatch(/\.select\("role"\)/);
    expect(HELPER_CODE).toMatch(/\.eq\("id", args\.practitionerId\)/);
    expect(HELPER_CODE).toMatch(/\.eq\("studio_id", args\.studioId\)/);
    expect(HELPER_CODE).toMatch(/role !== "owner"/);
    expect(HELPER_CODE).toMatch(/outcome: "not_authorized"/);
  });

  it("the helper owner re-check runs BEFORE the claim UPDATE and the Stripe refund", () => {
    const ownerCheck = HELPER.indexOf("payment_refund_helper_not_owner");
    const claim = HELPER.indexOf("refund_initiated_by_practitioner_id");
    const refundCall = HELPER.indexOf("refunds.create");
    expect(ownerCheck).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(ownerCheck); // before the claim mutation
    expect(refundCall).toBeGreaterThan(ownerCheck); // before the Stripe refund
  });

  it("keeps exactly one refunds.create call site (gate unchanged)", () => {
    const count = (HELPER_CODE.match(/refunds\.create/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("non-owner denial logging carries safe IDs only — no client PII", () => {
    for (const [src, event] of [
      [HELPER, "payment_refund_helper_not_owner"],
      [ACTION, "payment_refund_denied_not_owner"],
      [FEE_ACTION, "payment_refund_denied_not_owner"],
      // F-PAY-002. The prepare action's owner gate for an operator-authored
      // final charge logs a denial the same way, so it is held to the same
      // no-PII standard as the refund denials rather than inheriting it by
      // resemblance.
      [ACTION, "session_payment_amount_change_denied_not_owner"],
    ] as const) {
      const idx = src.indexOf(event);
      expect(idx, event).toBeGreaterThan(-1);
      // The logInternal({...}) payload immediately follows the event name.
      const payload = src.slice(idx, idx + 240);
      expect(payload).not.toMatch(/email|phone|\bname\b|client\.|first_name|last_name/i);
    }
  });
});

describe("refundPaymentChargeAttempt: server boundary", () => {
  it("imports 'server-only'", () => {
    expect(HELPER).toMatch(/^import "server-only";/);
  });

  it("uses createAdminClient (service-role)", () => {
    expect(HELPER).toMatch(/createAdminClient/);
  });

  it("uses inferStripeLivemode for the live-mode dormancy guard", () => {
    expect(HELPER).toMatch(/inferStripeLivemode\(\)/);
  });

  it("imports recordOpsAlert from the ops alerts helper", () => {
    expect(HELPER).toMatch(
      /import \{ recordOpsAlert \} from "@\/lib\/ops\/alerts"/,
    );
  });
});

describe("refundPaymentChargeAttempt: reason-agnostic by construction", () => {
  it("does NOT hardcode 'session_payment' anywhere in the eligibility path", () => {
    // The helper passes charge_reason through to Stripe metadata
    // without branching on it. A test row's reason flows through
    // unchanged.
    expect(HELPER).not.toMatch(
      /charge_reason\s*===?\s*"session_payment"|charge_reason\s*!==?\s*"session_payment"/,
    );
    expect(HELPER).not.toMatch(
      /charge_reason\s*===?\s*"late_cancellation_fee"|charge_reason\s*===?\s*"no_show_fee"/,
    );
  });

  it("records charge_reason as Stripe-refund metadata", () => {
    expect(HELPER).toMatch(/hone_charge_reason:\s*attempt\.charge_reason/);
  });
});

describe("refundPaymentChargeAttempt: eligibility predicates", () => {
  it("refuses non-succeeded attempt with outcome 'not_succeeded'", () => {
    expect(HELPER).toMatch(
      /attempt\.status !== "succeeded"[\s\S]{0,300}outcome:\s*"not_succeeded"/,
    );
  });

  it("refuses a mode-mismatched row with outcome 'live_mode_blocked' (PR #323)", () => {
    expect(HELPER).toMatch(
      /attempt\.stripe_livemode !== livemode[\s\S]{0,300}outcome:\s*"live_mode_blocked"/,
    );
    expect(HELPER).not.toMatch(/attempt\.stripe_livemode !== false/);
  });

  it("refuses missing stripe_charge_id with outcome 'missing_charge_id'", () => {
    expect(HELPER).toMatch(
      /!attempt\.stripe_charge_id[\s\S]{0,300}outcome:\s*"missing_charge_id"/,
    );
  });

  it("refuses missing stripe_payment_intent_id", () => {
    expect(HELPER).toMatch(
      /!attempt\.stripe_payment_intent_id[\s\S]{0,300}outcome:\s*"missing_payment_intent_id"/,
    );
  });

  it("refuses already-refunded with outcome 'already_refunded'", () => {
    expect(HELPER).toMatch(
      /attempt\.refund_status === "succeeded"[\s\S]{0,300}outcome:\s*"already_refunded"/,
    );
  });

  it("refuses in-flight refund with outcome 'refund_in_flight'", () => {
    expect(HELPER).toMatch(
      /attempt\.refund_status === "pending_stripe"[\s\S]{0,300}outcome:\s*"refund_in_flight"/,
    );
  });

  it("refuses cross-studio attempt with outcome 'not_authorized'", () => {
    expect(HELPER).toMatch(
      /attempt\.studio_id !== args\.studioId[\s\S]{0,300}outcome:\s*"not_authorized"/,
    );
  });

  it("refuses amount_cents <= 0 with outcome 'amount_invalid'", () => {
    expect(HELPER).toMatch(
      /attempt\.amount_cents <= 0[\s\S]{0,300}outcome:\s*"amount_invalid"/,
    );
  });
});

describe("refundPaymentChargeAttempt: env-gated mode (PR #323)", () => {
  it("derives the deployment mode from inferStripeLivemode() before any DB call", () => {
    // PR #323: the old hard `if (inferStripeLivemode()) return live_mode_blocked`
    // early-return is removed; the mode is derived once at the top and used by
    // the row-mode-consistency guard. Live refunds stay env/key gated.
    expect(HELPER).toMatch(/const livemode = inferStripeLivemode\(\)/);
    const livemodeIdx = HELPER.indexOf("inferStripeLivemode()");
    const firstDbIdx = HELPER.indexOf('.from("payment_charge_attempts")');
    expect(livemodeIdx).toBeGreaterThan(-1);
    expect(firstDbIdx).toBeGreaterThan(-1);
    expect(livemodeIdx).toBeLessThan(firstDbIdx);
    // The mode-consistency guard still yields live_mode_blocked.
    expect(HELPER).toMatch(
      /attempt\.stripe_livemode !== livemode[\s\S]{0,300}outcome:\s*"live_mode_blocked"/,
    );
  });
});

describe("refundPaymentChargeAttempt: atomic claim", () => {
  it("claim conditional UPDATE happens BEFORE refunds.create", () => {
    // Use HELPER_CODE so a docblock mention of refunds.create or of
    // refund_status='pending_stripe' does not move the indices.
    const claimIdx = HELPER_CODE.indexOf(
      `refund_status: "pending_stripe"`,
    );
    const refundIdx = HELPER_CODE.indexOf("stripe.refunds.create(");
    expect(claimIdx).toBeGreaterThan(-1);
    expect(refundIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeLessThan(refundIdx);
  });

  it("claim filters by status='succeeded' AND the deployment mode", () => {
    expect(HELPER).toMatch(/\.eq\("status", "succeeded"\)/);
    expect(HELPER).toMatch(/\.eq\("stripe_livemode", livemode\)/);
    expect(HELPER).not.toMatch(/\.eq\("stripe_livemode", false\)/);
  });

  it("claim filters by refund_status null or 'failed'", () => {
    // The OR uses Supabase's `.or()` shorthand.
    expect(HELPER).toMatch(
      /\.or\("refund_status\.is\.null,refund_status\.eq\.failed"\)/,
    );
  });

  it("claim stamps the deterministic idempotency key", () => {
    expect(HELPER).toMatch(/refund_idempotency_key:\s*idempotencyKey/);
  });

  it("claim clears prior failure fields so a retry starts clean", () => {
    expect(HELPER).toMatch(/refund_failure_code:\s*null/);
    expect(HELPER).toMatch(/refund_failure_message_safe:\s*null/);
    expect(HELPER).toMatch(/refunded_at:\s*null/);
    expect(HELPER).toMatch(/stripe_refund_id:\s*null/);
  });

  it("zero-row claim returns outcome='claim_lost' (no duplicate Stripe call)", () => {
    expect(HELPER).toMatch(
      /claimedRows\.length === 0[\s\S]{0,400}outcome:\s*"claim_lost"/,
    );
  });
});

describe("refundPaymentChargeAttempt: deterministic idempotency key", () => {
  it("the key shape is exactly hone:payment_refund:<attemptId>:v1", () => {
    expect(HELPER).toMatch(
      /buildRefundIdempotencyKey\(attemptId: string\): string \{[\s\S]{0,200}`hone:payment_refund:\$\{attemptId\}:v1`/,
    );
  });

  it("the helper builds the key from attempt.id and passes it to Stripe", () => {
    expect(HELPER).toMatch(
      /const idempotencyKey = buildRefundIdempotencyKey\(attempt\.id\);/,
    );
    expect(HELPER).toMatch(/idempotencyKey,\s*\n\s*\},\s*\);/);
  });
});

describe("refundPaymentChargeAttempt: Stripe refund call shape", () => {
  it("calls stripe.refunds.create exactly once (code only, comments excluded)", () => {
    const matches = HELPER_CODE.match(/stripe\.refunds\.create\(/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("passes the connected account context", () => {
    expect(HELPER).toMatch(
      /stripeAccount:\s*attempt\.stripe_account_id/,
    );
  });

  it("passes charge id + amount + metadata", () => {
    expect(HELPER).toMatch(
      /stripe\.refunds\.create\(\s*\{[\s\S]{0,800}charge:\s*attempt\.stripe_charge_id[\s\S]{0,400}amount:\s*refundAmountCents[\s\S]{0,400}metadata:\s*\{/,
    );
  });

  it("metadata carries the Hone identity tuple + charge reason + dynamic environment", () => {
    expect(HELPER).toMatch(/hone_payment_charge_attempt_id:\s*attempt\.id/);
    expect(HELPER).toMatch(/hone_studio_id:\s*attempt\.studio_id/);
    expect(HELPER).toMatch(/hone_client_id:\s*attempt\.client_id/);
    expect(HELPER).toMatch(/hone_charge_reason:\s*attempt\.charge_reason/);
    expect(HELPER).toMatch(/hone_environment: livemode \? "live" : "test"/);
    expect(HELPER).not.toMatch(/hone_environment:\s*"test"/);
  });

  it("does NOT pass application_fee_amount or transfer/reverse_transfer (code only)", () => {
    expect(HELPER_CODE).not.toMatch(/application_fee_amount/);
    expect(HELPER_CODE).not.toMatch(/reverse_transfer/);
  });
});

describe("refundPaymentChargeAttempt: outcome writes", () => {
  it("success writes refund_status='succeeded', stripe_refund_id, refunded_at", () => {
    expect(HELPER).toMatch(
      /\.update\(\{\s*\n\s*refund_status:\s*"succeeded"[\s\S]{0,400}stripe_refund_id:\s*refund\.id[\s\S]{0,400}refunded_at:\s*refundedAtIso/,
    );
  });

  it("success write matches refund_status='pending_stripe' (no overwrite of a reconciled row)", () => {
    expect(HELPER).toMatch(
      /\.update\(\{\s*\n\s*refund_status:\s*"succeeded"[\s\S]{0,800}\.eq\("refund_status", "pending_stripe"\)/,
    );
  });

  it("Stripe terminal error writes refund_status='failed' with sanitised code + message", () => {
    expect(HELPER).toMatch(
      /\.update\(\{\s*\n\s*refund_status:\s*"failed"[\s\S]{0,400}refund_failure_code:\s*code[\s\S]{0,400}refund_failure_message_safe:\s*safeMessage/,
    );
  });

  it("unknown Stripe outcome leaves refund_status='pending_stripe' and records critical ops_alert", () => {
    expect(HELPER).toMatch(
      /payment_refund_stripe_unknown_outcome[\s\S]{0,800}severity:\s*"critical"/,
    );
    expect(HELPER).toMatch(/outcome:\s*"needs_manual_review"/);
  });

  it("success-write DB failure records critical ops_alert with the Stripe refund id", () => {
    // The ops_alert call lists severity before event in this code;
    // pin both literals + the stripe_refund_id payload separately so
    // a refactor that reorders the keys still passes.
    expect(HELPER).toMatch(/event:\s*"payment_refund_succeeded_write_failed"/);
    const alertBlock =
      HELPER.match(
        /payment_refund_succeeded_write_failed[\s\S]{0,2000}stripe_refund_id:\s*refund\.id/,
      )?.[0] ?? "";
    expect(alertBlock).toMatch(/severity:\s*"critical"/);
  });
});

describe("refundPaymentChargeAttempt: failure handling discriminates Stripe vs unknown errors", () => {
  it("catches Stripe.errors.StripeError separately from generic errors", () => {
    expect(HELPER).toMatch(/err instanceof Stripe\.errors\.StripeError/);
  });

  it("sanitises Stripe failure code via the slice helper", () => {
    expect(HELPER).toMatch(/sanitizeFailureCode\(err\.code/);
  });

  it("sanitises Stripe failure message via the strip-and-slice helper", () => {
    expect(HELPER).toMatch(/sanitizeFailureMessage\(err\.message\)/);
  });
});

describe("refundPaymentChargeAttempt: forbidden operations", () => {
  it("does NOT call paymentIntents.create", () => {
    expect(HELPER).not.toMatch(/paymentIntents\.create/);
  });

  it("does NOT call setupIntents.create", () => {
    expect(HELPER).not.toMatch(/setupIntents\.create/);
  });

  it("does NOT call charges.create", () => {
    expect(HELPER).not.toMatch(/charges\.create/);
  });

  it("does NOT call checkout.sessions", () => {
    expect(HELPER).not.toMatch(/checkout\.sessions/);
  });

  it("does NOT touch manual_fee_charge_attempts (code only, comments excluded)", () => {
    expect(HELPER_CODE).not.toMatch(/manual_fee_charge_attempts/);
  });

  it("does NOT send email or SMS (code only)", () => {
    expect(HELPER_CODE).not.toMatch(/sendEmailSafely|sendSms|twilio/i);
  });
});

describe("Action layer: refundPaymentChargeAttemptAction", () => {
  it("declares the action", () => {
    expect(ACTION).toMatch(
      /export async function refundPaymentChargeAttemptAction\(/,
    );
  });

  it("imports the helper from lib/billing/payment-refund", () => {
    expect(ACTION).toMatch(
      /import \{\s*\n?\s*refundPaymentChargeAttempt,\s*\n?\s*type PaymentRefundResult,\s*\n?\s*\} from "@\/lib\/billing\/payment-refund"/,
    );
  });

  it("resolves practitioner + studio server-side (never trusts the browser)", () => {
    const block =
      ACTION.match(
        /export async function refundPaymentChargeAttemptAction\([\s\S]{0,3000}\n\}/,
      )?.[0] ?? "";
    expect(block).toMatch(/getCurrentPractitionerWithStudio/);
  });

  it("does NOT accept amount from the browser", () => {
    const block =
      ACTION.match(
        /export async function refundPaymentChargeAttemptAction\([\s\S]{0,3000}\n\}/,
      )?.[0] ?? "";
    expect(block).not.toMatch(/formData\.get\("amount/);
  });

  it("forwards only attempt_id, internal_note, plus session/client for revalidate", () => {
    const block =
      ACTION.match(
        /export async function refundPaymentChargeAttemptAction\([\s\S]{0,3000}\n\}/,
      )?.[0] ?? "";
    expect(block).toMatch(/refundPaymentChargeAttempt\(\{[\s\S]{0,400}attemptId/);
    expect(block).toMatch(/internalNote/);
    expect(block).toMatch(
      /revalidatePath\(`\/clients\/\$\{clientId\}\/sessions\/\$\{sessionId\}`\)/,
    );
  });
});

describe("Action layer: discriminated outcome union mirrors the helper", () => {
  it("includes every helper outcome literal", () => {
    for (const tok of [
      '"live_mode_blocked"',
      '"not_found"',
      '"not_authorized"',
      '"not_succeeded"',
      '"missing_charge_id"',
      '"missing_payment_intent_id"',
      '"missing_charged_at"',
      '"already_refunded"',
      '"refund_in_flight"',
      '"amount_invalid"',
      '"claim_lost"',
      '"failed"',
      '"needs_manual_review"',
      '"database_error"',
    ]) {
      expect(ACTION).toContain(tok);
    }
  });
});
