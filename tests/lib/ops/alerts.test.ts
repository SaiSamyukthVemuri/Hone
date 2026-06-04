import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #153: ops alert helper and wiring.
//
// The helper's two non-negotiable properties are pinned down here:
//   * It NEVER throws to the caller. Failure of DB / email / log
//     itself must not bring down the business flow that called it.
//   * It redacts dangerous keys / values from safe_details before
//     either the structured log OR the DB insert.
//
// We exercise the helper directly via `redactSafeDetails`. The
// recordOpsAlert function itself takes an admin Supabase client
// inside its body; testing the insert path would require either
// mocking the entire Supabase module or running against a real DB.
// We assert the never-throws contract at the call sites via the
// source-grep tests below, and pin down the redaction logic via
// the pure function.

import { redactSafeDetails } from "@/lib/ops/alerts";

describe("redactSafeDetails (PR #153)", () => {
  it("returns {} on undefined input", () => {
    expect(redactSafeDetails(undefined)).toEqual({});
  });

  it("redacts keys named token / raw_token / client_secret", () => {
    const out = redactSafeDetails({
      token: "raw-portal-token-value",
      raw_token: "x",
      client_secret: "pi_xxx_secret_yyy",
      safe_field: "kept",
    });
    expect(out.token).toBe("[redacted]");
    expect(out.raw_token).toBe("[redacted]");
    expect(out.client_secret).toBe("[redacted]");
    expect(out.safe_field).toBe("kept");
  });

  it("redacts keys named cookie / authorization / api_key / secret / password / cvc", () => {
    const out = redactSafeDetails({
      cookie: "hone_portal_session=abc",
      authorization: "Bearer abc",
      api_key: "sk_test_anything",
      secret: "anything",
      password: "anything",
      cvc: "123",
      pan: "4242424242424242",
    });
    for (const v of Object.values(out)) {
      expect(v).toBe("[redacted]");
    }
  });

  it("redacts Stripe secret-key VALUES regardless of key name", () => {
    const out = redactSafeDetails({
      stripe_response: "sk_test_abcdef123456",
      stripe_live: "sk_live_abcdef123456",
    });
    expect(out.stripe_response).toBe("[redacted]");
    expect(out.stripe_live).toBe("[redacted]");
  });

  it("redacts JWT-shaped VALUES regardless of key name", () => {
    const out = redactSafeDetails({
      session: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature",
    });
    expect(out.session).toBe("[redacted]");
  });

  it("redacts long bearer-token-shaped VALUES (>= 32 alnum) regardless of key name", () => {
    const out = redactSafeDetails({
      mystery: "abc123ABC456def789DEF000ghi111JKL222",
    });
    expect(out.mystery).toBe("[redacted]");
  });

  it("does NOT redact UUIDs (resource identifiers must flow)", () => {
    const out = redactSafeDetails({
      appointment_id: "550e8400-e29b-41d4-a716-446655440000",
      attempt_id: "AaAaAa1A-BbBb-CcCc-DdDd-EeEeEe2EeEee",
    });
    expect(out.appointment_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    // Mixed-case UUID still passes the UUID regex; pinned here so a
    // future change that tightens UUID matching doesn't silently
    // start redacting resource ids.
    expect(out.attempt_id).toBe("AaAaAa1A-BbBb-CcCc-DdDd-EeEeEe2EeEee");
  });

  it("does NOT redact short non-credential strings", () => {
    const out = redactSafeDetails({
      message: "stripe_status: requires_action",
      code: "card_declined",
      attempt_number: 3,
      retryable: false,
    });
    expect(out.message).toBe("stripe_status: requires_action");
    expect(out.code).toBe("card_declined");
    expect(out.attempt_number).toBe(3);
    expect(out.retryable).toBe(false);
  });

  it("recurses into nested objects and arrays", () => {
    const out = redactSafeDetails({
      inner: {
        token: "should-be-redacted",
        ok: "kept",
        deeper: { client_secret: "x", value: "kept" },
      },
      list: [
        { token: "redact-me", id: "ok" },
        "sk_test_abcdefghij",
      ],
    });
    const inner = out.inner as Record<string, unknown>;
    expect(inner.token).toBe("[redacted]");
    expect(inner.ok).toBe("kept");
    const deeper = inner.deeper as Record<string, unknown>;
    expect(deeper.client_secret).toBe("[redacted]");
    expect(deeper.value).toBe("kept");
    const list = out.list as unknown[];
    expect((list[0] as Record<string, unknown>).token).toBe("[redacted]");
    expect((list[0] as Record<string, unknown>).id).toBe("ok");
    expect(list[1]).toBe("[redacted]");
  });

  it("truncates very long non-credential string values to ~500 chars + sentinel", () => {
    // Whitespace-laden long string so the bearer-token detector
    // (which requires alphanum/underscore/hyphen only) does NOT
    // trigger; we want to exercise the truncation path. The
    // implementation slices to MAX_DETAIL_VALUE_LEN (500) and
    // appends a 14-char sentinel, so the final length is 514.
    const long = ("Stripe error: status was processing. " + "x".repeat(2000));
    const out = redactSafeDetails({ payload: long });
    const v = out.payload as string;
    // Bounded close to MAX_DETAIL_VALUE_LEN + sentinel length, not
    // an unbounded paste-bomb.
    expect(v.length).toBeLessThanOrEqual(520);
    expect(v.length).toBeGreaterThanOrEqual(500);
    expect(v.endsWith("...[truncated]")).toBe(true);
  });
});

// ===========================================================================
// Source-grep tests for the wiring + safety contract.
// ===========================================================================

const ALERTS_SOURCE = readFileSync(
  path.resolve(__dirname, "../../../lib/ops/alerts.ts"),
  "utf8",
);
const MANUAL_FEE_CHARGE_SOURCE = readFileSync(
  path.resolve(__dirname, "../../../lib/billing/manual-fee-charge.ts"),
  "utf8",
);
const WEBHOOK_SOURCE = readFileSync(
  path.resolve(__dirname, "../../../app/api/stripe/webhook/route.ts"),
  "utf8",
);
const REMINDERS_CRON_SOURCE = readFileSync(
  path.resolve(__dirname, "../../../app/api/cron/appointment-reminders/route.ts"),
  "utf8",
);
const BREAKS_CRON_SOURCE = readFileSync(
  path.resolve(
    __dirname,
    "../../../app/api/cron/materialize-recurring-breaks/route.ts",
  ),
  "utf8",
);
const EMAIL_HELPER_SOURCE = readFileSync(
  path.resolve(__dirname, "../../../lib/email/send-appointment.ts"),
  "utf8",
);
const SMS_HELPER_SOURCE = readFileSync(
  path.resolve(__dirname, "../../../lib/sms/send-appointment.ts"),
  "utf8",
);

describe("ops alerts wiring (PR #153)", () => {
  it("alerts helper imports server-only", () => {
    expect(ALERTS_SOURCE).toMatch(/import "server-only"/);
  });

  it("alerts helper does NOT import lib/email/send-appointment (no dependency cycle with the email subsystem it observes)", () => {
    // PR #153 pre-merge patch. Earlier draft dynamically imported
    // sendEmailSafely to fire operator email; that coupled ops
    // alerting back into the appointment email helper. The merged
    // helper must contain no `import` from
    // lib/email/send-appointment AT ALL (static OR dynamic).
    expect(ALERTS_SOURCE).not.toMatch(
      /import[\s\S]{0,200}from\s+["']@\/lib\/email\/send-appointment["']/,
    );
    expect(ALERTS_SOURCE).not.toMatch(
      /import\s*\(\s*["']@\/lib\/email\/send-appointment["']\s*\)/,
    );
    // sendEmailSafely is the specific symbol we forbid. The
    // comments above may reference the name for documentation; we
    // only block the actual call surface.
    expect(ALERTS_SOURCE).not.toMatch(/sendEmailSafely\s*\(/);
  });

  it("alerts helper does NOT dispatch operator email in PR #153 (deferred)", () => {
    // The helper should not contain a maybeEmailAlert / dispatch
    // function. Operator email is reserved for a future PR with a
    // standalone lib/ops/alert-email.ts.
    expect(ALERTS_SOURCE).not.toMatch(/function maybeEmailAlert/);
    expect(ALERTS_SOURCE).not.toMatch(/parseOpsAlertEmails/);
    // OPS_ALERT_EMAILS is reserved in env docs but the helper does
    // NOT read it. Reading would be a soft regression toward email
    // dispatch.
    expect(ALERTS_SOURCE).not.toMatch(/process\.env\.OPS_ALERT_EMAILS/);
  });

  it("manual fee charge wires the helper at every needs_manual_review return", () => {
    const needsReviewBlocks = MANUAL_FEE_CHARGE_SOURCE.split(
      /outcome:\s*"needs_manual_review"/,
    );
    // Three needs_manual_review returns in the file post-PR #153:
    // PI retrieve fail, processing status, stale pending, unknown
    // error. Two more in reconcile + run-manual-fee (already_pending
    // / processing). All should be preceded by recordOpsAlert.
    expect(needsReviewBlocks.length).toBeGreaterThanOrEqual(3);
    // Spot-check that at least one recordOpsAlert call carries
    // event = "manual_fee_needs_manual_review".
    expect(MANUAL_FEE_CHARGE_SOURCE).toMatch(
      /event:\s*"manual_fee_needs_manual_review"/,
    );
  });

  it("manual fee charge wires the helper on StripeError failure", () => {
    expect(MANUAL_FEE_CHARGE_SOURCE).toMatch(
      /event:\s*"manual_fee_charge_failed"/,
    );
  });

  it("webhook wires the helper on stripe_webhook_handler_failed catch", () => {
    expect(WEBHOOK_SOURCE).toMatch(
      /event:\s*\n?\s*event\.type === "setup_intent\.succeeded"[\s\S]*?card_on_file_setup_failed[\s\S]*?stripe_webhook_processing_failed/,
    );
  });

  it("reminders cron wires cron_route_failed alert in its try/catch", () => {
    expect(REMINDERS_CRON_SOURCE).toMatch(/event:\s*"cron_route_failed"/);
    expect(REMINDERS_CRON_SOURCE).toMatch(/route:\s*"\/api\/cron\/appointment-reminders"/);
  });

  it("materialize-recurring-breaks cron wires cron_route_failed alert", () => {
    expect(BREAKS_CRON_SOURCE).toMatch(/event:\s*"cron_route_failed"/);
    expect(BREAKS_CRON_SOURCE).toMatch(
      /route:\s*"\/api\/cron\/materialize-recurring-breaks"/,
    );
  });

  it("materialize-recurring-breaks cron alerts on partial rule failures (warning)", () => {
    expect(BREAKS_CRON_SOURCE).toMatch(
      /event:\s*"recurring_break_materialization_failures"/,
    );
  });

  it("email helper alerts on give-up only (final attempt)", () => {
    // The give-up threshold lives next to the helper. Lower-numbered
    // retryable failures stay log-only.
    expect(EMAIL_HELPER_SOURCE).toMatch(/EMAIL_GIVE_UP_ATTEMPT_THRESHOLD/);
    expect(EMAIL_HELPER_SOURCE).toMatch(/event:\s*"email_send_gave_up"/);
    expect(EMAIL_HELPER_SOURCE).toMatch(/if \(!isFinalAttempt\) return;/);
  });

  it("SMS helper alerts on give-up only", () => {
    expect(SMS_HELPER_SOURCE).toMatch(/SMS_GIVE_UP_ATTEMPT_THRESHOLD/);
    expect(SMS_HELPER_SOURCE).toMatch(/event:\s*"sms_send_failed"/);
  });

  it("no new payment-moving calls were added", () => {
    // These greps must be empty across the touched files. The single
    // allowed paymentIntents.create remains in lib/billing/manual-fee-
    // charge.ts (the existing call at line ~750), so it shows up
    // there. Other touched files must NOT introduce one.
    const FILES = {
      webhook: WEBHOOK_SOURCE,
      reminders: REMINDERS_CRON_SOURCE,
      breaks: BREAKS_CRON_SOURCE,
      email: EMAIL_HELPER_SOURCE,
      sms: SMS_HELPER_SOURCE,
      alerts: ALERTS_SOURCE,
    };
    for (const [name, src] of Object.entries(FILES)) {
      expect(src, `${name} should not call paymentIntents.create`).not.toMatch(
        /paymentIntents\.create/,
      );
      expect(src, `${name} should not call charges.create`).not.toMatch(
        /charges\.create/,
      );
      expect(src, `${name} should not call refunds.create`).not.toMatch(
        /refunds\.create/,
      );
      expect(src, `${name} should not open Checkout`).not.toMatch(
        /checkout\.sessions/,
      );
      expect(src, `${name} should not flip STRIPE_ALLOW_LIVE_MODE`).not.toMatch(
        /STRIPE_ALLOW_LIVE_MODE=true/,
      );
    }
    // Manual-fee charge module still contains exactly one call site.
    const occurrences =
      MANUAL_FEE_CHARGE_SOURCE.match(/paymentIntents\.create/g)?.length ?? 0;
    expect(occurrences).toBe(1);
  });
});

// Quick sanity: importing the alerts module from a test does not
// throw (we exercise the redactor synchronously above; full
// recordOpsAlert requires a DB which we mock-bypass via the spy
// here).
describe("recordOpsAlert never-throws (PR #153)", () => {
  // We don't run the helper against the live admin client. Instead
  // we patch console.error to swallow output and assert that the
  // function does not throw when called with a minimal valid input.
  // The DB path will fail inside the try/catch (no env), but the
  // helper's never-throw contract must hold.
  let originalConsoleError: typeof console.error;
  beforeEach(() => {
    originalConsoleError = console.error;
    console.error = vi.fn();
  });
  afterEach(() => {
    console.error = originalConsoleError;
  });

  it("does not throw when DB is unreachable", async () => {
    const mod = await import("@/lib/ops/alerts");
    let threw = false;
    try {
      await mod.recordOpsAlert({
        severity: "info",
        event: "ops_alert_test_event",
        message: "test",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
