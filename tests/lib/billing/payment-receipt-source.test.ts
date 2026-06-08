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

  it("refuses when stripe_livemode is not false", () => {
    expect(HELPER).toMatch(/attempt\.stripe_livemode !== false/);
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
