import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #281. Payment success persistence is authoritative.
//
// The blocker (deep review): runSessionPaymentCharge returned a normal
// `ok: true, outcome: "succeeded"` after Stripe succeeded EVEN IF Hone
// failed to persist the success on the local payment ledger (DB error)
// or the conditional UPDATE affected ZERO rows. PR #263 detected those
// cases for logging/alerting but the caller still reported a clean
// success because writeSucceededOutcome returned `void`.
//
// The fix makes success authoritative: a NORMAL succeeded result
// requires Stripe success AND a proven local-ledger write. When Stripe
// succeeds but Hone cannot persist, the caller returns
// `needs_manual_review` (an indeterminate, non-success outcome) with
// non-sensitive reconciliation ids and a critical ops alert is raised.
//
// lib/billing is tested 100% via source-grep; this mirrors that and
// pins the load-bearing shape so a refactor cannot re-introduce a
// false success.

const REPO_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string =>
  readFileSync(path.join(REPO_ROOT, rel), "utf8");

const CHARGE = read("lib/billing/session-payment-charge.ts");
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

// ---------------------------------------------------------------------------
// writeSucceededOutcome returns a structured persistence result.
// ---------------------------------------------------------------------------
describe("writeSucceededOutcome reports whether the success was persisted", () => {
  it("declares a SuccessPersistenceResult union (persisted true | false+reason)", () => {
    expect(CHARGE).toMatch(/type SuccessPersistenceResult =/);
    expect(CHARGE).toMatch(/\{\s*persisted:\s*true\s*\}/);
    expect(CHARGE).toMatch(
      /persisted:\s*false;\s*reason:\s*"db_error"\s*\|\s*"zero_rows"/,
    );
  });

  it("returns Promise<SuccessPersistenceResult>, not Promise<void>", () => {
    // The success write helper's signature must resolve the structured
    // persistence result so the caller can branch on it. (writeFailedOutcome
    // legitimately stays Promise<void>; we pin the succeeded writer only.)
    const sig =
      CHARGE.match(
        /async function writeSucceededOutcome\([\s\S]*?\}\): (Promise<[^>]+(?:<[^>]+>)?>)/,
      )?.[1] ?? "";
    expect(sig).toBe("Promise<SuccessPersistenceResult>");
  });

  it("returns persisted:true only after a proven (non-error, non-zero-row) write", () => {
    expect(CHARGE).toMatch(/return \{ persisted: true \};/);
  });

  it("returns persisted:false reason 'db_error' on a DB error", () => {
    expect(CHARGE).toMatch(/return \{ persisted: false, reason: "db_error" \};/);
  });

  it("returns persisted:false reason 'zero_rows' on a zero-row update", () => {
    expect(CHARGE).toMatch(
      /return \{ persisted: false, reason: "zero_rows" \};/,
    );
  });
});

// ---------------------------------------------------------------------------
// Critical ops alerts on both non-persistence cases (money moved).
// ---------------------------------------------------------------------------
describe("non-persistence raises a critical ops alert (operator wake-up)", () => {
  it("DB error raises CRITICAL session_payment_succeeded_write_failed", () => {
    expect(CHARGE).toMatch(
      /severity: "critical",\s*event: "session_payment_succeeded_write_failed"/,
    );
  });

  it("zero rows keeps the CRITICAL session_payment_succeeded_write_zero_rows alert", () => {
    expect(CHARGE).toMatch(
      /severity: "critical",\s*event: "session_payment_succeeded_write_zero_rows"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Both success callers branch on persistence: never report a clean
// success they could not persist.
// ---------------------------------------------------------------------------
describe("callers return needs_manual_review when persistence fails, not succeeded", () => {
  it("both success callers call writeSucceededOutcome and capture the result", () => {
    // main create/confirm path + reconcileExistingPaymentIntent.
    expect(count(CHARGE, /const persistence = await writeSucceededOutcome\(/g)).toBe(2);
  });

  it("both callers guard on !persistence.persisted before returning success", () => {
    expect(count(CHARGE, /if \(!persistence\.persisted\)/g)).toBe(2);
  });

  it("the persistence-failed branch returns needs_manual_review (ok:false), never succeeded", () => {
    // Each !persisted branch returns outcome: needs_manual_review with
    // the safe message — never ok:true / outcome:"succeeded".
    const branches = CHARGE.match(
      /if \(!persistence\.persisted\)\s*\{([\s\S]*?)\}\n/g,
    );
    expect(branches?.length).toBe(2);
    for (const b of branches ?? []) {
      expect(b).toMatch(/outcome:\s*"needs_manual_review"/);
      expect(b).toMatch(/message:\s*SUCCESS_NOT_PERSISTED_MESSAGE/);
      expect(b).not.toMatch(/ok:\s*true/);
      expect(b).not.toMatch(/outcome:\s*"succeeded"/);
    }
  });

  it("returns a normal success only on the persisted path", () => {
    // The ok:true succeeded return for the live charge sits AFTER the
    // !persistence.persisted guard in both callers.
    const guardIdx = CHARGE.indexOf("if (!persistence.persisted)");
    const okIdx = CHARGE.indexOf('outcome: "succeeded"', guardIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(okIdx).toBeGreaterThan(guardIdx);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation ids on the indeterminate result; no sensitive data.
// ---------------------------------------------------------------------------
describe("needs_manual_review-after-success carries safe reconciliation ids", () => {
  it("the result type allows stripePaymentIntentId + attemptId on the failure variant", () => {
    expect(CHARGE).toMatch(/stripePaymentIntentId\?:\s*string;/);
    expect(CHARGE).toMatch(/attemptId\?:\s*string;/);
  });

  it("the persistence-failed branch returns both reconciliation ids", () => {
    const branches = CHARGE.match(
      /if \(!persistence\.persisted\)\s*\{([\s\S]*?)\}\n/g,
    );
    for (const b of branches ?? []) {
      expect(b).toMatch(/stripePaymentIntentId:\s*pi\.id/);
      expect(b).toMatch(/attemptId:/);
    }
  });

  it("the operator-facing message names no card data, payload, or secret", () => {
    expect(CHARGE).toMatch(/const SUCCESS_NOT_PERSISTED_MESSAGE =/);
    const msg =
      CHARGE.match(/SUCCESS_NOT_PERSISTED_MESSAGE =\s*\n?\s*"([^"]*)"/)?.[1] ??
      "";
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toMatch(/client_secret|card|cvc|cvv|sk_(live|test)_/i);
  });
});

// ---------------------------------------------------------------------------
// Stripe failed/declined behavior is unchanged.
// ---------------------------------------------------------------------------
describe("Stripe failure paths unchanged", () => {
  it("still writes a failed outcome and returns outcome:'failed' on decline", () => {
    expect(CHARGE).toMatch(/writeFailedOutcome/);
    expect(CHARGE).toMatch(/outcome:\s*"failed"/);
  });

  it("still leaves the row pending + needs_manual_review on an unknown post-claim error", () => {
    expect(CHARGE).toMatch(/unknown_error_after_claim/);
  });
});

// ---------------------------------------------------------------------------
// Stripe gates + live-mode block unchanged by this PR.
// ---------------------------------------------------------------------------
describe("Stripe gates + live-mode block unchanged", () => {
  it("keeps exactly one paymentIntents.create", () => {
    expect(count(CHARGE, /paymentIntents\.create/g)).toBe(1);
  });

  it("introduces no refunds.create / charges.create / checkout.sessions here", () => {
    expect(count(CHARGE, /refunds\.create/g)).toBe(0);
    expect(CHARGE).not.toMatch(/charges\.create/);
    expect(CHARGE).not.toMatch(/checkout\.sessions/);
  });

  it("does not relax the live-mode gate (no STRIPE_ALLOW_LIVE_MODE; early return intact)", () => {
    expect(CHARGE).not.toMatch(/STRIPE_ALLOW_LIVE_MODE/);
    expect(CHARGE).toMatch(
      /inferStripeLivemode\(\) === true[\s\S]{0,200}outcome:\s*"live_mode_blocked"/,
    );
  });

  it("does not introduce a retry of the charge on the persistence-failed path (no double charge)", () => {
    // The !persisted branch returns immediately; it must not call
    // paymentIntents.create again.
    const branches = CHARGE.match(
      /if \(!persistence\.persisted\)\s*\{([\s\S]*?)\}\n/g,
    );
    for (const b of branches ?? []) {
      expect(b).not.toMatch(/paymentIntents\.create/);
    }
  });
});
