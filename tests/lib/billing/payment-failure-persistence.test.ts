import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #310. Payment FAILURE persistence alert hardening.
//
// The final pre-live review found a P1 asymmetry: when Stripe returns a
// failed/non-success outcome and Hone cannot persist that local 'failed' state,
// the DB-error branch of writeFailedOutcome logged to stderr ONLY (no ops
// alert), and the zero-row branch raised a WARNING, both invisible to the
// critical-only manual-review queue, unlike the succeeded-outcome path (PR
// #281, critical on both). This PR makes the two symmetric: DB-error now raises
// a CRITICAL `session_payment_failed_write_failed`, and the zero-row alert is
// promoted warning -> CRITICAL. Alerting-only: no Stripe call, no flow change.
// (lib/billing is tested 100% via source-grep; this mirrors that.)

const REPO_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string =>
  readFileSync(path.join(REPO_ROOT, rel), "utf8");

const CHARGE = read("lib/billing/session-payment-charge.ts");
const MANUAL_REVIEW = read("lib/billing/payment-manual-review.ts");
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

// The writeFailedOutcome function body only, so success-path alerts (and the
// PR #320 finalizeRequiresActionPaymentIntent helper, which follows it) can't
// satisfy the failure-path assertions.
const FAILED_FN = (() => {
  const start = CHARGE.indexOf("async function writeFailedOutcome");
  // PR #320: bound at the next function (finalizeRequiresActionPaymentIntent)
  // so this stays exactly the writeFailedOutcome body.
  const end = CHARGE.indexOf("async function finalizeRequiresActionPaymentIntent");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return CHARGE.slice(start, end);
})();

// The DB-error branch (before the zero-row detection) vs the zero-row branch.
const DBERR_BRANCH = FAILED_FN.slice(0, FAILED_FN.indexOf("zero-row detection"));
const ZEROROW_BRANCH = FAILED_FN.slice(FAILED_FN.indexOf("zero-row detection"));

describe("writeFailedOutcome: DB-error persistence failure is CRITICAL (PR #310)", () => {
  it("keeps the internal log and adds a critical ops alert", () => {
    expect(DBERR_BRANCH).toMatch(/logInternal\("session_payment_failed_write_failed"/);
    expect(DBERR_BRANCH).toMatch(
      /severity: "critical",\s*event: "session_payment_failed_write_failed"/,
    );
    expect(DBERR_BRANCH).toMatch(/await recordOpsAlert\(/);
  });

  it("carries safe top-level ids consistent with the success alert", () => {
    expect(DBERR_BRANCH).toMatch(/studioId: args\.studioId/);
    expect(DBERR_BRANCH).toMatch(/clientId: args\.clientId/);
    expect(DBERR_BRANCH).toMatch(/stripePaymentIntentId: args\.paymentIntentId/);
    expect(DBERR_BRANCH).toMatch(
      /route: "lib\/billing\/session-payment-charge:writeFailedOutcome"/,
    );
  });

  it("logs safe details only (attempt_id, attempted_status, stripe_status, db_code)", () => {
    expect(DBERR_BRANCH).toMatch(/attempt_id: args\.attemptId/);
    expect(DBERR_BRANCH).toMatch(/attempted_status: "failed"/);
    expect(DBERR_BRANCH).toMatch(/stripe_status: args\.stripeStatus/);
    expect(DBERR_BRANCH).toMatch(/db_code: error\.code/);
  });
});

describe("writeFailedOutcome: zero-row persistence failure is CRITICAL (PR #310)", () => {
  it("keeps the event name and is now critical (not warning)", () => {
    expect(ZEROROW_BRANCH).toMatch(/!updatedRows \|\| updatedRows\.length === 0/);
    expect(ZEROROW_BRANCH).toMatch(
      /severity: "critical",\s*event: "session_payment_failed_write_zero_rows"/,
    );
  });

  it("carries the same safe ids + details as the DB-error branch", () => {
    expect(ZEROROW_BRANCH).toMatch(/studioId: args\.studioId/);
    expect(ZEROROW_BRANCH).toMatch(/clientId: args\.clientId/);
    expect(ZEROROW_BRANCH).toMatch(/attempt_id: args\.attemptId/);
    expect(ZEROROW_BRANCH).toMatch(/attempted_status: "failed"/);
  });

  it("the whole failure path never uses warning severity now", () => {
    expect(FAILED_FN).not.toMatch(/severity: "warning"/);
  });
});

describe("writeFailedOutcome: safe details only, no PII / no raw payload (PR #310)", () => {
  it("never logs client name/email/phone or health/treatment notes", () => {
    expect(FAILED_FN).not.toMatch(/\b(name|email|phone|first_name|last_name|notes?|health|treatment|dob|address)\b\s*:/i);
  });
  it("never dumps the raw Stripe object / failure message into safeDetails", () => {
    // sanitizeFailureMessage/Code feed the DB columns, not the alert details.
    expect(FAILED_FN).not.toMatch(/safeDetails:\s*[\s\S]{0,120}(failure_message|last_payment_error|JSON\.stringify|args\.pi\b|raw)/);
    expect(FAILED_FN).not.toMatch(/JSON\.stringify\(/);
  });
});

describe("writeFailedOutcome: studioId + clientId threaded into ALL call sites (PR #310)", () => {
  it("every writeFailedOutcome call passes studioId and clientId", () => {
    // PR #320 added a 4th call site (finalizeRequiresActionPaymentIntent's
    // cancel-success path); it too threads both ids.
    const calls = count(CHARGE, /await writeFailedOutcome\(\{/g);
    expect(calls).toBe(4);
    // Each call block must carry both ids. Slice each call's argument object.
    const re = /await writeFailedOutcome\(\{([\s\S]*?)\}\);/g;
    let m: RegExpExecArray | null;
    let checked = 0;
    while ((m = re.exec(CHARGE)) !== null) {
      expect(m[1]).toMatch(/studioId:/);
      expect(m[1]).toMatch(/clientId:/);
      checked += 1;
    }
    expect(checked).toBe(4);
  });
});

describe("PR #310 leaves the rest of the payment path unchanged", () => {
  it("success unknown-outcome alerts remain critical + unchanged", () => {
    expect(CHARGE).toMatch(
      /severity: "critical",\s*event: "session_payment_succeeded_write_failed"/,
    );
    expect(CHARGE).toMatch(
      /severity: "critical",\s*event: "session_payment_succeeded_write_zero_rows"/,
    );
  });

  it("Stripe call inventory: one create + one retrieve, plus PR #320's one cancel", () => {
    expect(count(CHARGE, /paymentIntents\.create/g)).toBe(1);
    // The single reconcile retrieve; no new retrieve added.
    expect(count(CHARGE, /paymentIntents\.retrieve/g)).toBe(1);
    // PR #320: exactly one paymentIntents.cancel (the requires_action safety
    // cancel), pinned in scripts/check-stripe-gates.mjs.
    expect(count(CHARGE, /paymentIntents\.cancel\(/g)).toBe(1);
  });

  it("manual-review still keys off the session_payment_ prefix + critical severity", () => {
    expect(MANUAL_REVIEW).toMatch(/"session_payment_"/);
    // The new events start with that prefix, so they surface automatically.
    expect("session_payment_failed_write_failed".startsWith("session_payment_")).toBe(true);
    expect("session_payment_failed_write_zero_rows".startsWith("session_payment_")).toBe(true);
  });

  it("manual-review stuck-pending_stripe section is untouched by this PR", () => {
    const PAGE = read("app/admin/payments/manual-review/page.tsx");
    expect(PAGE).toMatch(/\.eq\("status", "pending_stripe"\)/);
    expect(PAGE).toMatch(/\.eq\("severity", "critical"\)/);
  });
});
