import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #263. Payment outcome zero-row detection.
//
// Every payment-OUTCOME write (charge succeeded/failed, refund
// succeeded/failed, and the four Stripe-webhook reconciliations) is a
// status-conditional `.update().eq(...)` that, before this PR, only
// checked the DB `error`. A conditional UPDATE matching ZERO rows
// returns no error and persisted nothing, so a real Stripe outcome
// could be silently treated as recorded. These source-grep pins lock in
// that each outcome write now (a) proves a row was affected via
// `.select("id")` and (b) on zero rows surfaces an explicit
// failure/manual-review/ops-alert instead of continuing as success.
// (lib/billing is tested 100% via source-grep; this mirrors that.)

const REPO_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string =>
  readFileSync(path.join(REPO_ROOT, rel), "utf8");

const CHARGE = read("lib/billing/session-payment-charge.ts");
const REFUND = read("lib/billing/payment-refund.ts");
const RECON = read("lib/billing/payment-webhook-reconciliation.ts");

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

// ---------------------------------------------------------------------------
// Charge executor: writeSucceededOutcome / writeFailedOutcome.
// ---------------------------------------------------------------------------
describe("charge outcome writes detect zero rows (session-payment-charge.ts)", () => {
  it("both outcome writers prove a row was affected via .select(\"id\")", () => {
    // 2 outcome writers, each with a .select("id") row-affected check.
    expect(count(CHARGE, /\.select\("id"\)/g)).toBeGreaterThanOrEqual(2);
    expect(CHARGE).toMatch(/!updatedRows \|\| updatedRows\.length === 0/);
  });

  it("succeeded write raises a CRITICAL ops alert on zero rows (money moved)", () => {
    expect(CHARGE).toMatch(
      /severity: "critical",\s*event: "session_payment_succeeded_write_zero_rows"/,
    );
  });

  it("failed write surfaces a zero-row ops alert", () => {
    expect(CHARGE).toContain("session_payment_failed_write_zero_rows");
  });

  it("does not silently fall through after a write error (early return added)", () => {
    // Each writer returns after logging the DB error, so the zero-row
    // branch only evaluates a real (non-error) zero-row result.
    expect(count(CHARGE, /logInternal\("session_payment_(succeeded|failed)_write_failed"/g)).toBe(2);
  });

  // PR #281: a DB ERROR on the succeeded write is also a real-money /
  // unstamped-ledger split. PR #263 only logged it to stderr; now it
  // raises a CRITICAL ops alert just like the zero-row case.
  it("succeeded write raises a CRITICAL ops alert on a DB error (not just stderr)", () => {
    expect(CHARGE).toMatch(
      /severity: "critical",\s*event: "session_payment_succeeded_write_failed"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Refund: success + terminal-failure outcome writes.
// ---------------------------------------------------------------------------
describe("refund outcome writes detect zero rows (payment-refund.ts)", () => {
  it("success + failure writes both add .select(\"id\") (claim already had one)", () => {
    // claim (pre-existing) + 2 outcome writes = >= 3.
    expect(count(REFUND, /\.select\("id"\)/g)).toBeGreaterThanOrEqual(3);
  });

  it("success write treats zero rows as needs_manual_review (never reports success unproven)", () => {
    expect(REFUND).toMatch(/const okWriteZeroRows =\s*!writeOkErr && \(!okRows \|\| okRows\.length === 0\)/);
    expect(REFUND).toMatch(/if \(writeOkErr \|\| okWriteZeroRows\)/);
  });

  it("terminal-failure write folds zero rows into the critical alert path", () => {
    expect(REFUND).toMatch(/const failedWriteZeroRows =\s*!writeFailedErr && \(!failedRows \|\| failedRows\.length === 0\)/);
    expect(REFUND).toMatch(/if \(writeFailedErr \|\| failedWriteZeroRows\)/);
  });
});

// ---------------------------------------------------------------------------
// Webhook reconciliation: the four payment-outcome reconcile UPDATEs.
// ---------------------------------------------------------------------------
describe("webhook reconcile outcome writes detect zero rows (payment-webhook-reconciliation.ts)", () => {
  it("every DIRECT reconcile UPDATE proves a row was affected via .select(\"id\")", () => {
    // PAY-SETTLE / 0187 moved ONE of the four — payment_intent.succeeded —
    // into a database command, because it was the only writer that could turn
    // a retirable `ready` row into money without holding the shared appointment
    // advisory key. The remaining three are still direct UPDATEs and still
    // carry their own zero-row detection.
    expect(count(RECON, /\.select\("id"\)/g)).toBeGreaterThanOrEqual(3);
  });

  it("the succeeded reconcile proves the same thing through the command's result", () => {
    // The invariant is unchanged — never report a reconciliation that did not
    // happen — only its mechanism moved. The command returns `zero_rows` when
    // its status-conditional UPDATE matches nothing, and the caller treats that
    // exactly as it treated an empty .select("id").
    expect(RECON).toMatch(/rpc\(\s*\n?\s*"reconcile_card_payment_succeeded"/);
    expect(RECON).toMatch(/reconcileResult === "zero_rows"/);
  });

  it("each reconcile returns zeroRowNoMutation instead of claiming a reconcile that did not happen", () => {
    expect(count(RECON, /zeroRowNoMutation: true/g)).toBeGreaterThanOrEqual(4);
  });

  it("each outcome event has a dedicated zero-row ops alert", () => {
    for (const ev of [
      "payment_intent_succeeded_reconcile_zero_rows",
      "payment_intent_failed_reconcile_zero_rows",
      "charge_refunded_pending_reconcile_zero_rows",
      "charge_refunded_out_of_band_zero_rows",
    ]) {
      expect(RECON, `missing zero-row event ${ev}`).toContain(ev);
    }
  });

  it("out-of-band 'reconciled' alert no longer fires unconditionally (gated by rows>0)", () => {
    // The zero-row guard + return must appear BEFORE the
    // charge_refunded_out_of_band_reconciled success alert.
    const zeroIdx = RECON.indexOf("charge_refunded_out_of_band_zero_rows");
    const reconciledIdx = RECON.indexOf("charge_refunded_out_of_band_reconciled");
    expect(zeroIdx).toBeGreaterThan(-1);
    expect(reconciledIdx).toBeGreaterThan(zeroIdx);
  });
});

// ---------------------------------------------------------------------------
// Safety: zero-row logs/alerts carry NO raw Stripe payload or customer PII.
// ---------------------------------------------------------------------------
describe("zero-row alerts leak no raw payload or PII", () => {
  const ALL = `${CHARGE}\n${REFUND}\n${RECON}`;

  it("never serializes or spreads a raw Stripe payload object into a log/alert", () => {
    expect(ALL).not.toMatch(/JSON\.stringify\(\s*(event|pi|charge|dispute)\b/);
    // No raw payload object passed as / spread into safeDetails.
    expect(ALL).not.toMatch(/safeDetails:\s*(pi|charge|event|dispute)\b/);
    expect(ALL).not.toMatch(/safeDetails:\s*\{\s*\.\.\.(pi|charge|event|dispute)\b/);
  });

  it("contains no card/secret data tokens", () => {
    expect(ALL).not.toMatch(/\b(client_secret|card_number|cardnumber|cvc|cvv)\b/i);
  });

  it("each new zero-row alert identifies the row by safe id (attempt_id), not customer PII", () => {
    // Every new zero-row event sits in a recordOpsAlert whose safeDetails
    // carries attempt_id (a UUID), proving a safe-id shape was used.
    for (const ev of [
      "session_payment_succeeded_write_zero_rows",
      "session_payment_succeeded_write_failed",
      "session_payment_failed_write_zero_rows",
      "payment_intent_succeeded_reconcile_zero_rows",
      "payment_intent_failed_reconcile_zero_rows",
      "charge_refunded_pending_reconcile_zero_rows",
      "charge_refunded_out_of_band_zero_rows",
    ]) {
      const idx = ALL.indexOf(`event: "${ev}"`);
      expect(idx, `event ${ev} not found`).toBeGreaterThan(-1);
      const block = ALL.slice(idx, idx + 600);
      expect(block, `event ${ev} should log attempt_id`).toMatch(/attempt_id:/);
    }
  });
});

// ---------------------------------------------------------------------------
// Stripe gates unchanged: no new charge/refund callsites, no live-mode change.
// ---------------------------------------------------------------------------
describe("Stripe gates unchanged by the zero-row hardening", () => {
  it("exactly one paymentIntents.create (in the charge executor)", () => {
    expect(count(CHARGE, /paymentIntents\.create/g)).toBe(1);
    expect(count(REFUND, /paymentIntents\.create/g)).toBe(0);
    expect(count(RECON, /paymentIntents\.create/g)).toBe(0);
  });

  it("exactly one refunds.create (in the refund helper)", () => {
    expect(count(REFUND, /refunds\.create/g)).toBe(1);
    expect(count(CHARGE, /refunds\.create/g)).toBe(0);
    expect(count(RECON, /refunds\.create/g)).toBe(0);
  });

  it("adds no charges.create / checkout.sessions and no live-mode gate flip", () => {
    const ALL = `${CHARGE}\n${REFUND}\n${RECON}`;
    expect(ALL).not.toMatch(/charges\.create/);
    expect(ALL).not.toMatch(/checkout\.sessions/);
    expect(ALL).not.toMatch(/STRIPE_ALLOW_LIVE_MODE\s*=\s*true/);
  });
});
