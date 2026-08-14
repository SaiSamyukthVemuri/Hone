import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #175. Source-grep tests pin the safety invariants of the
// reason-agnostic receipt helper. Runtime behavior (template
// rendering, label fallback) is covered by
// tests/lib/email/payment-receipt.test.ts; this file pins:
//   * server-only boundary
//   * eligibility gates BEFORE the email send
//   * atomic claim shape
//   * truthful update-on-success vs update-on-failure
//   * no new Stripe call
//   * no SMS / no live-mode change / no manual_fee touch

const HELPER_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/payment-receipt.ts",
);
const HELPER = readFileSync(HELPER_PATH, "utf8");

const ACTION_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
);
const ACTION = readFileSync(ACTION_PATH, "utf8");

describe("sendPaymentChargeReceipt: server boundary + dependencies", () => {
  it("imports 'server-only'", () => {
    expect(HELPER).toMatch(/^import "server-only";/);
  });

  it("uses createAdminClient", () => {
    expect(HELPER).toMatch(/createAdminClient/);
  });

  it("uses sendEmailSafely from the existing send-appointment module", () => {
    expect(HELPER).toMatch(
      /import \{ sendEmailSafely \} from "@\/lib\/email\/send-appointment"/,
    );
  });

  it("uses the new buildPaymentReceiptEmail template + chargeReasonLabel helper", () => {
    expect(HELPER).toMatch(/buildPaymentReceiptEmail/);
    expect(HELPER).toMatch(/chargeReasonLabel/);
  });

  it("records ops_alerts on failure paths", () => {
    expect(HELPER).toMatch(/recordOpsAlert/);
  });
});

describe("sendPaymentChargeReceipt: eligibility gates (pre-send)", () => {
  it("refuses when status !== 'succeeded'", () => {
    expect(HELPER).toMatch(/attempt\.status !== "succeeded"/);
    expect(HELPER).toMatch(/reason:\s*"not_succeeded"/);
  });

  it("refuses when the row mode does not match the deployment mode (PR #323)", () => {
    expect(HELPER).toMatch(/attempt\.stripe_livemode !== inferStripeLivemode\(\)/);
  });

  it("refuses when stripe_payment_intent_id is missing", () => {
    expect(HELPER).toMatch(/!attempt\.stripe_payment_intent_id/);
    expect(HELPER).toMatch(/reason:\s*"missing_payment_intent"/);
  });

  it("refuses when charged_at is missing", () => {
    expect(HELPER).toMatch(/!attempt\.charged_at/);
  });

  it("short-circuits when receipt_status is already 'sent'", () => {
    expect(HELPER).toMatch(/attempt\.receipt_status === "sent"/);
    expect(HELPER).toMatch(/reason:\s*"already_sent"/);
  });

  it("short-circuits when receipt_status is 'sending' (in-flight)", () => {
    expect(HELPER).toMatch(/attempt\.receipt_status === "sending"/);
    expect(HELPER).toMatch(/reason:\s*"in_flight"/);
  });

  it("refuses when the client has no email on file", () => {
    expect(HELPER).toMatch(/clientEmail\.length === 0/);
    expect(HELPER).toMatch(/reason:\s*"client_email_missing"/);
  });

  it("scopes the attempt + client lookups by studio_id", () => {
    expect(HELPER).toMatch(
      /\.from\("payment_charge_attempts"\)[\s\S]{0,400}\.eq\("studio_id",\s*args\.studioId\)/,
    );
    expect(HELPER).toMatch(
      /\.from\("clients"\)[\s\S]{0,400}\.eq\("studio_id",\s*args\.studioId\)/,
    );
  });
});

describe("sendPaymentChargeReceipt: atomic claim shape", () => {
  it("claim is an UPDATE that flips receipt_status to 'sending'", () => {
    expect(HELPER).toMatch(
      /\.from\("payment_charge_attempts"\)\s*\n?\s*\.update\(\{\s*\n?\s*receipt_status:\s*"sending"/,
    );
  });

  it("the claim filter only matches succeeded rows whose receipt_status is null or 'failed'", () => {
    expect(HELPER).toMatch(/\.eq\("status",\s*"succeeded"\)/);
    expect(HELPER).toMatch(
      /\.or\("receipt_status\.is\.null,receipt_status\.eq\.failed"\)/,
    );
  });

  it("returns the post-update row id so the action can detect a lost race", () => {
    // claimedRows.length === 0 means the row moved between SELECT
    // and UPDATE; the action re-reads and returns already_sent
    // or in_flight.
    expect(HELPER).toMatch(/claimedRows\.length === 0/);
  });
});

describe("sendPaymentChargeReceipt: write on success", () => {
  it("stamps receipt_status='sent', receipt_sent_at, receipt_email_to on success", () => {
    expect(HELPER).toMatch(
      /receipt_status:\s*"sent",\s*\n?\s*receipt_sent_at:\s*new Date\(\)\.toISOString\(\)/,
    );
    expect(HELPER).toMatch(/receipt_email_to:\s*clientEmail/);
  });

  it("clears the failure detail on success", () => {
    expect(HELPER).toMatch(
      /receipt_status:\s*"sent"[\s\S]{0,300}receipt_failure_code:\s*null[\s\S]{0,80}receipt_failure_message_safe:\s*null/,
    );
  });

  it("the success UPDATE only matches rows that were just claimed (receipt_status='sending')", () => {
    expect(HELPER).toMatch(
      /receipt_status:\s*"sent"[\s\S]{0,800}\.eq\("receipt_status",\s*"sending"\)/,
    );
  });
});

describe("sendPaymentChargeReceipt: write on retryable failure (release claim)", () => {
  it("a retryable failure releases the claim back to null", () => {
    expect(HELPER).toMatch(
      /sendResult\.retryable[\s\S]{0,200}receipt_status:\s*null/,
    );
  });

  it("a retryable failure records a warning-severity ops_alert", () => {
    expect(HELPER).toMatch(
      /severity:\s*"warning"[\s\S]{0,200}event:\s*"payment_receipt_send_failed_retryable"/,
    );
  });

  it("retryable failure returns reason='send_failed_retryable' to the caller", () => {
    expect(HELPER).toMatch(/reason:\s*"send_failed_retryable"/);
  });
});

describe("sendPaymentChargeReceipt: write on terminal failure", () => {
  it("a terminal failure stamps receipt_status='failed' + safe code + safe message", () => {
    expect(HELPER).toMatch(/receipt_status:\s*"failed"/);
    expect(HELPER).toMatch(/receipt_failure_code:\s*safeCode/);
    expect(HELPER).toMatch(/receipt_failure_message_safe:\s*safeMessage/);
  });

  it("a terminal failure records a critical-severity ops_alert", () => {
    expect(HELPER).toMatch(
      /severity:\s*"critical"[\s\S]{0,200}event:\s*"payment_receipt_send_failed_terminal"/,
    );
  });

  it("the failure UPDATE only matches rows still in 'sending'", () => {
    expect(HELPER).toMatch(
      /receipt_status:\s*"failed"[\s\S]{0,800}\.eq\("receipt_status",\s*"sending"\)/,
    );
  });

  it("the safe failure message is sanitised (newlines stripped, capped to 1000)", () => {
    expect(HELPER).toMatch(/sanitiseSafe\(sendResult\.error,\s*1000\)/);
  });
});

describe("PR #175 patch: sent-email but DB-update-failed safety", () => {
  // Bug fixed by the patch: the initial PR returned ok:true even
  // when the post-send UPDATE to stamp receipt_status='sent'
  // failed. That lost the truthful state -- the email was in the
  // wild, the row stayed at 'sending', and no ops_alert was
  // recorded. The patch returns a distinct sent_but_record_update
  // _failed outcome with a critical-severity ops_alert.

  it("the result type declares the new sent_but_record_update_failed reason", () => {
    expect(HELPER).toMatch(/"sent_but_record_update_failed"/);
  });

  it("the post-send UPDATE error branch returns ok:false with sent_but_record_update_failed", () => {
    // The write-failure block must NOT return ok:true. Pin the
    // shape: when writeErr is truthy on the success-path UPDATE,
    // the helper returns {ok:false, reason:'sent_but_record_update_failed'}.
    expect(HELPER).toMatch(
      /if \(writeErr\)\s*\{[\s\S]{0,2000}reason:\s*"sent_but_record_update_failed"[\s\S]{0,1000}\}/,
    );
  });

  it("the failure-message warns the operator NOT to send again until reconciled", () => {
    expect(HELPER).toMatch(
      /The receipt email may have been sent, but Hone could not record it\. Do not send again until this is checked\./,
    );
  });

  it("records a critical-severity ops_alert for the operator", () => {
    expect(HELPER).toMatch(
      /severity:\s*"critical"[\s\S]{0,400}event:\s*"payment_receipt_sent_record_update_failed"/,
    );
  });

  it("the ops_alert safeDetails carries attempt_id + receipt_email_to + db_code", () => {
    const block =
      HELPER.match(
        /payment_receipt_sent_record_update_failed[\s\S]{0,2000}safeDetails:\s*\{[\s\S]{0,400}\}/,
      )?.[0] ?? "";
    expect(block).toMatch(/attempt_id:\s*attempt\.id/);
    expect(block).toMatch(/receipt_email_to:\s*clientEmail/);
    expect(block).toMatch(/db_code:\s*writeErr\.code/);
  });

  it("returns the recipient address on the failed-record outcome (so the UI can name it)", () => {
    const block =
      HELPER.match(
        /reason:\s*"sent_but_record_update_failed"[\s\S]{0,1000}/,
      )?.[0] ?? "";
    expect(block).toMatch(/emailTo:\s*clientEmail/);
  });
});

describe("sendPaymentChargeReceipt: NO new Stripe / SMS / live-mode", () => {
  it("does NOT call paymentIntents.create", () => {
    expect(HELPER).not.toMatch(/paymentIntents\.create/);
  });

  it("does NOT call charges.create / refunds.create / checkout.sessions", () => {
    expect(HELPER).not.toMatch(/charges\.create/);
    expect(HELPER).not.toMatch(/refunds\.create/);
    expect(HELPER).not.toMatch(/checkout\.sessions/);
  });

  it("does NOT reference STRIPE_ALLOW_LIVE_MODE", () => {
    expect(HELPER).not.toMatch(/STRIPE_ALLOW_LIVE_MODE/);
  });

  it("does NOT import any SMS helper", () => {
    expect(HELPER).not.toMatch(/lib\/sms\//);
    expect(HELPER).not.toMatch(/twilio/i);
  });

  it("does NOT write to manual_fee_charge_attempts", () => {
    expect(HELPER).not.toMatch(
      /\.from\("manual_fee_charge_attempts"\)[\s\S]{0,200}\.update/,
    );
  });
});

describe("sendPaymentChargeReceipt: card last-4 lookup is display-only + tenant-scoped", () => {
  it("selects ONLY last4 from client_payment_methods (no full card / other card data)", () => {
    expect(HELPER).toMatch(/\.from\("client_payment_methods"\)/);
    expect(HELPER).toMatch(/\.select\("last4"\)/);
    // Never selects a full card number or PAN-like column.
    expect(HELPER).not.toMatch(/\.select\([^)]*card_number/);
  });

  it("scopes the lookup by (payment method id, studio, client, livemode), tenant isolation", () => {
    const block = HELPER.slice(
      HELPER.indexOf('.from("client_payment_methods")'),
    ).slice(0, 400);
    expect(block).toMatch(/\.eq\("id", attempt\.client_payment_method_id\)/);
    expect(block).toMatch(/\.eq\("studio_id", attempt\.studio_id\)/);
    expect(block).toMatch(/\.eq\("client_id", attempt\.client_id\)/);
    expect(block).toMatch(/\.eq\("stripe_livemode", attempt\.stripe_livemode\)/);
  });

  it("passes the fetched last4 to the receipt template (display-only)", () => {
    expect(HELPER).toMatch(/last4: cardLast4/);
    // The read is display-only: it must NOT gate/branch the charge or refund.
    expect(HELPER).not.toMatch(/paymentIntents\.|refunds\.create/);
  });

  it("is only a READ: no update/insert/delete on client_payment_methods", () => {
    const block = HELPER.slice(
      HELPER.indexOf('.from("client_payment_methods")'),
    ).slice(0, 400);
    expect(block).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
  });
});

describe("sendPaymentChargeReceiptAction (server action)", () => {
  it("'use server' directive present (file-level)", () => {
    expect(ACTION).toMatch(/^"use server";/);
  });

  it("resolves practitioner + studio from the session", () => {
    expect(ACTION).toMatch(/getCurrentPractitionerWithStudio/);
  });

  it("does NOT accept studio_id / practitioner_id from the form", () => {
    const block =
      ACTION.match(
        /sendPaymentChargeReceiptAction[\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(block).not.toMatch(/formData\.get\("studio_id"\)/);
    expect(block).not.toMatch(/formData\.get\("practitioner_id"\)/);
  });

  it("forwards only attemptId + studioId + practitionerId to the helper", () => {
    expect(ACTION).toMatch(
      /sendPaymentChargeReceipt\(\{\s*\n?\s*attemptId,\s*\n?\s*studioId,\s*\n?\s*practitionerId,\s*\n?\s*\}\)/,
    );
  });

  it("revalidates the session detail path on terminal result", () => {
    expect(ACTION).toMatch(
      /revalidatePath\(`\/clients\/\$\{clientId\}\/sessions\/\$\{sessionId\}`\)/,
    );
  });

  it("declares every outcome literal from the helper's discriminated union", () => {
    for (const tok of [
      '"not_found"',
      '"not_succeeded"',
      '"missing_payment_intent"',
      '"already_sent"',
      '"in_flight"',
      '"client_email_missing"',
      '"studio_missing"',
      '"send_failed_retryable"',
      '"send_failed_terminal"',
      // PR #175 patch. The action's outcome union mirrors the
      // helper's; this literal must appear so the UI can switch
      // on the discriminated reason and surface the warning.
      '"sent_but_record_update_failed"',
      '"not_authorized"',
      '"database_error"',
    ]) {
      expect(ACTION).toContain(tok);
    }
  });

  it("does NOT call any Stripe API directly", () => {
    expect(ACTION).not.toMatch(/paymentIntents\./);
    expect(ACTION).not.toMatch(/charges\./);
    expect(ACTION).not.toMatch(/refunds\./);
  });
});
