import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STUCK_PENDING_THRESHOLD_MINUTES,
  MANUAL_REVIEW_NEXT_STEP,
  PAYMENT_MANUAL_REVIEW_EVENT_PREFIXES,
  isPaymentManualReviewEvent,
  formatAmountLabel,
  toStuckAttemptView,
  selectPaymentReviewAlerts,
  type StuckAttemptRow,
  type ReviewAlertRow,
} from "@/lib/billing/payment-manual-review";

// PR #290. Read-only admin payment manual-review queue. Critical-only alert
// scope + stuck pending_stripe attempts. This proves the pure selection +
// safe view-models leak no PII, and (source-grep) the page is admin-only,
// read-only, and makes no Stripe write / payment mutation.

// ---------------------------------------------------------------------------
// Pure selection: which events / thresholds are in the queue.
// ---------------------------------------------------------------------------
describe("isPaymentManualReviewEvent", () => {
  it("includes the critical payment manual-review events", () => {
    for (const ev of [
      "session_payment_succeeded_write_failed",
      "session_payment_succeeded_write_zero_rows",
      "session_payment_needs_manual_review",
      "payment_refund_succeeded_write_failed",
      "payment_refund_stripe_unknown_outcome",
      "payment_intent_succeeded_local_terminal_mismatch",
      "payment_intent_failed_after_local_succeeded",
      "charge_refunded_partial_out_of_band",
      "stripe_webhook_metadata_mismatch",
      "payment_charge_dispute_created",
    ]) {
      expect(isPaymentManualReviewEvent(ev), ev).toBe(true);
    }
  });

  it("excludes non-payment events and card-on-file setup failures", () => {
    for (const ev of [
      "reminder_scheduler_stale",
      "reminder_scheduler_missing",
      "treatment_image_upload_failed",
      "cron_route_failed",
      "email_send_gave_up",
      "sms_send_failed",
      "card_on_file_setup_failed", // card setup, not a charge — stays on ops-alerts
      "",
    ]) {
      expect(isPaymentManualReviewEvent(ev), ev).toBe(false);
    }
    expect(isPaymentManualReviewEvent(null)).toBe(false);
    expect(isPaymentManualReviewEvent(undefined)).toBe(false);
  });

  it("the prefix set is the documented six", () => {
    expect([...PAYMENT_MANUAL_REVIEW_EVENT_PREFIXES]).toEqual([
      "session_payment_",
      "payment_intent_",
      "payment_refund_",
      "payment_charge_",
      "charge_refunded_",
      "stripe_webhook_",
    ]);
  });

  it("the stuck-pending threshold matches the 60-minute reconcile window", () => {
    expect(STUCK_PENDING_THRESHOLD_MINUTES).toBe(60);
  });

  it("the next-step text is conservative (Stripe dashboard, do NOT retry, runbook)", () => {
    expect(MANUAL_REVIEW_NEXT_STEP).toMatch(/Stripe dashboard/i);
    expect(MANUAL_REVIEW_NEXT_STEP).toMatch(/do NOT retry/i);
    expect(MANUAL_REVIEW_NEXT_STEP).toMatch(/runbook|docs\/16/i);
  });
});

describe("formatAmountLabel", () => {
  it("formats cents to a $ amount + currency", () => {
    expect(formatAmountLabel(5000, "cad")).toBe("$50.00 CAD");
    expect(formatAmountLabel(199, "cad")).toBe("$1.99 CAD");
  });
  it("returns null for missing amount", () => {
    expect(formatAmountLabel(null, "cad")).toBeNull();
    expect(formatAmountLabel(undefined, "cad")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Safe view-models: no PII leaks even when the row carries sensitive fields.
// ---------------------------------------------------------------------------
describe("toStuckAttemptView strips to safe fields only", () => {
  const planted: StuckAttemptRow = {
    id: "attempt-1",
    studio_id: "s1",
    studio: { name: "Willow Electrolysis" },
    client_id: "c1",
    session_id: "sess1",
    appointment_id: "appt1",
    charge_reason: "session_payment",
    amount_cents: 5000,
    currency: "cad",
    status: "pending_stripe",
    stripe_payment_intent_id: "pi_3NabcDEF",
    stripe_livemode: false,
    failure_code: "card_declined",
    created_at: "2026-06-30T10:00:00.000Z",
    updated_at: "2026-06-30T10:00:00.000Z",
    // Planted sensitive fields that must NEVER reach the view:
    client_name: "Janet Quibblesworth",
    notes: "sensitive treatment note",
    failure_message_safe: "raw-ish provider message",
    card_fingerprint: "abc123fingerprint",
    stripe_customer_id: "cus_secretCustomer",
  };

  it("carries only the safe allowlist fields", () => {
    const v = toStuckAttemptView(planted);
    expect(Object.keys(v).sort()).toEqual(
      [
        "amountLabel",
        "appointmentId",
        "attemptId",
        "chargeReason",
        "clientId",
        "createdAt",
        "failureCode",
        "livemode",
        "sessionId",
        "status",
        "stripePaymentIntentId",
        "studioId",
        "studioName",
        "updatedAt",
      ].sort(),
    );
  });

  it("leaks none of the planted sensitive values", () => {
    const serialized = JSON.stringify(toStuckAttemptView(planted));
    for (const leak of [
      "Janet Quibblesworth",
      "sensitive treatment note",
      "raw-ish provider message",
      "abc123fingerprint",
      "cus_secretCustomer",
    ]) {
      expect(serialized, leak).not.toContain(leak);
    }
  });

  it("renders the safe fields correctly (amount, mode, studio name)", () => {
    const v = toStuckAttemptView(planted);
    expect(v.amountLabel).toBe("$50.00 CAD");
    expect(v.livemode).toBe(false);
    expect(v.studioName).toBe("Willow Electrolysis");
    expect(v.stripePaymentIntentId).toBe("pi_3NabcDEF");
    expect(v.failureCode).toBe("card_declined");
  });

  it("renders safely with missing optional fields", () => {
    const v = toStuckAttemptView({
      id: "a",
      studio_id: null,
      client_id: null,
      session_id: null,
      appointment_id: null,
      charge_reason: null,
      amount_cents: null,
      currency: null,
      status: null,
      stripe_payment_intent_id: null,
      stripe_livemode: null,
      failure_code: null,
      created_at: "2026-06-30T10:00:00.000Z",
      updated_at: "2026-06-30T10:00:00.000Z",
    });
    expect(v.amountLabel).toBeNull();
    expect(v.livemode).toBe(false);
    expect(v.studioName).toBeNull();
  });
});

describe("selectPaymentReviewAlerts: critical + unresolved + payment-event only", () => {
  const base = {
    created_at: "2026-06-30T10:00:00.000Z",
    message: "[redacted] safe message",
    studio_id: "s1",
    client_id: "c1",
    appointment_id: null,
    stripe_payment_intent_id: "pi_3NabcDEF",
    route: "lib/billing/session-payment-charge",
  };
  const rows: ReviewAlertRow[] = [
    { id: "1", severity: "critical", event: "session_payment_succeeded_write_failed", resolved_at: null, ...base },
    { id: "2", severity: "critical", event: "payment_refund_succeeded_write_failed", resolved_at: null, ...base },
    // warning payment alert — excluded
    { id: "3", severity: "warning", event: "payment_intent_succeeded_no_match", resolved_at: null, ...base },
    // resolved critical payment alert — excluded
    { id: "4", severity: "critical", event: "session_payment_needs_manual_review", resolved_at: "2026-06-30T11:00:00.000Z", ...base },
    // non-payment critical — excluded
    { id: "5", severity: "critical", event: "reminder_scheduler_missing", resolved_at: null, ...base },
  ];

  it("keeps only unresolved critical payment alerts", () => {
    const out = selectPaymentReviewAlerts(rows);
    expect(out.map((a) => a.alertId).sort()).toEqual(["1", "2"]);
  });

  it("a warning payment alert does NOT appear", () => {
    expect(selectPaymentReviewAlerts(rows).some((a) => a.alertId === "3")).toBe(false);
  });

  it("a resolved critical payment alert does NOT appear", () => {
    expect(selectPaymentReviewAlerts(rows).some((a) => a.alertId === "4")).toBe(false);
  });

  it("a non-payment critical alert does NOT appear", () => {
    expect(selectPaymentReviewAlerts(rows).some((a) => a.alertId === "5")).toBe(false);
  });

  it("the view carries only safe fields (redacted message, PI id, ids) — no raw payload", () => {
    const v = selectPaymentReviewAlerts(rows)[0];
    expect(Object.keys(v).sort()).toEqual(
      [
        "alertId",
        "appointmentId",
        "clientId",
        "createdAt",
        "event",
        "message",
        "route",
        "severity",
        "stripePaymentIntentId",
        "studioId",
      ].sort(),
    );
    expect(v.message).toContain("[redacted]");
  });
});

// ---------------------------------------------------------------------------
// Source-grep: the page is admin-only, read-only, and makes no Stripe write.
// ---------------------------------------------------------------------------
function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
const PAGE = read("app/admin/payments/manual-review/page.tsx");
const HELPER = read("lib/billing/payment-manual-review.ts");
const ADMIN_INDEX = read("app/admin/page.tsx");
const ADMIN_LAYOUT = read("app/admin/layout.tsx");
const codeOnly = (s: string) =>
  s.split("\n").filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)).join("\n");

describe("manual-review page: admin-only access", () => {
  it("inherits the app/admin layout gate (redirects non-admins) and re-checks isAdmin", () => {
    expect(ADMIN_LAYOUT).toMatch(/isAdmin\(/);
    expect(ADMIN_LAYOUT).toMatch(/redirect\("\/login"\)|redirect\("\/dashboard"\)/);
    // The page re-verifies and 404s a non-admin (defense in depth).
    expect(PAGE).toMatch(/import \{ isAdmin \} from "@\/lib\/admin"/);
    expect(PAGE).toMatch(/auth\.getUser\(\)/);
    expect(PAGE).toMatch(/if \(!user \|\| !isAdmin\(user\.email\)\) notFound\(\)/);
  });

  it("is force-dynamic and reads via the service-role admin client", () => {
    expect(PAGE).toMatch(/export const dynamic = "force-dynamic"/);
    expect(PAGE).toMatch(/createAdminClient/);
  });
});

describe("manual-review page: READ-ONLY (no payment mutation, no Stripe write)", () => {
  const code = codeOnly(PAGE);
  it("never mutates payment_charge_attempts or ops_alerts", () => {
    expect(code).not.toMatch(/\.update\(/);
    expect(code).not.toMatch(/\.insert\(/);
    expect(code).not.toMatch(/\.delete\(/);
    expect(code).not.toMatch(/\.upsert\(/);
  });
  it("imports no server action and calls no resolve/retry/refund action", () => {
    expect(code).not.toMatch(/from "\.\/actions"/);
    expect(code).not.toMatch(/resolveOpsAlertAction|retry|refund/i);
    expect(code).not.toMatch(/"use server"/);
  });
  it("calls no Stripe API (read or write) and no payment-moving SDK", () => {
    for (const src of [PAGE, HELPER]) {
      expect(src).not.toMatch(/paymentIntents\.|refunds\.|charges\.|checkout\.sessions|setupIntents\./);
      expect(src).not.toMatch(/from "stripe"|getStripe\(|@\/lib\/stripe/);
    }
  });
  it("does not render client names (ids only — studios/[id] privacy convention)", () => {
    expect(PAGE).not.toMatch(/client:\s*clients\(|clients\(name\)|client\.name/);
  });
});

describe("manual-review page: queue selection mirrors docs/16 §17.7", () => {
  it("section 1 selects payment_charge_attempts stuck in pending_stripe past the window", () => {
    expect(PAGE).toMatch(/\.from\("payment_charge_attempts"\)/);
    expect(PAGE).toMatch(/\.eq\("status", "pending_stripe"\)/);
    expect(PAGE).toMatch(/\.lt\("updated_at", cutoffIso\)/);
  });
  it("section 2 selects unresolved critical ops_alerts", () => {
    expect(PAGE).toMatch(/\.from\("ops_alerts"\)/);
    expect(PAGE).toMatch(/\.eq\("severity", "critical"\)/);
    expect(PAGE).toMatch(/\.is\("resolved_at", null\)/);
    expect(PAGE).toMatch(/selectPaymentReviewAlerts/);
  });
  it("renders empty states + links to /admin/ops-alerts for resolution", () => {
    expect(PAGE).toMatch(/No payment attempts stuck/);
    expect(PAGE).toMatch(/No unresolved critical payment alerts/);
    expect(PAGE).toMatch(/href="\/admin\/ops-alerts"/);
  });

  it("surfaces a read failure loudly (never a false 'all clear' empty queue) without leaking the provider error", () => {
    // Both reads capture .error and throw a GENERIC message — a failed query
    // must not render as an empty queue, and the raw provider message is not leaked.
    expect(PAGE).toMatch(/error: stuckErr/);
    expect(PAGE).toMatch(/error: alertErr/);
    const throwCount = (PAGE.match(/throw new Error\("Could not load the payment manual-review queue\."\)/g) ?? []).length;
    expect(throwCount).toBe(2);
    expect(PAGE).not.toMatch(/throw new Error\(`?[^"]*\$\{[^}]*Err[^}]*\}/); // no interpolated provider message
  });
});

describe("admin index links to the manual-review queue", () => {
  it("has a QuickLink to /admin/payments/manual-review", () => {
    expect(ADMIN_INDEX).toMatch(/href="\/admin\/payments\/manual-review"/);
    expect(ADMIN_INDEX).toMatch(/Payment manual review/);
  });
});
