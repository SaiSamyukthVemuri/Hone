import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  feeExecuteBlock,
  feePrepareBlock,
  ONE_FEE_PER_APPOINTMENT_MESSAGE,
  SAME_TYPE_ACTIVE_MESSAGE,
  type OneFeeAttempt,
} from "@/lib/billing/manual-fee-one-per-appointment";

// One manual fee per appointment, across both types. Synthetic rows; no Stripe, no database.
const NOW = new Date("2026-11-12T12:00:00.000Z");
const at = (i: number) => `2026-11-12T10:0${i}:00.000Z`;
function a(over: Partial<OneFeeAttempt> & { id: string }): OneFeeAttempt {
  return { charge_type: "late_cancel", status: "ready", created_at: at(0), updated_at: NOW.toISOString(), ...over };
}

describe("prepare: any fee of EITHER type that is open or taken blocks a new one", () => {
  it("a no-show after a SUCCEEDED late-cancel is refused", () => {
    expect(feePrepareBlock([a({ id: "1", status: "succeeded", charge_type: "late_cancel" })], "no_show", NOW)).toBe(ONE_FEE_PER_APPOINTMENT_MESSAGE);
  });
  it("a late-cancel after a REFUNDED no-show is refused (a refunded fee was still taken once)", () => {
    const refunded = a({ id: "1", status: "succeeded", charge_type: "no_show" }) as OneFeeAttempt & Record<string, unknown>;
    refunded.refund_status = "succeeded";
    expect(feePrepareBlock([refunded], "late_cancel", NOW)).toBe(ONE_FEE_PER_APPOINTMENT_MESSAGE);
  });
  it("every open state of the other type blocks: ready, pending (recent), unclear (old pending), unknown status, needs-the-client's-action", () => {
    const open: Partial<OneFeeAttempt>[] = [
      { status: "ready" },
      { status: "pending_stripe", updated_at: NOW.toISOString() },
      { status: "pending_stripe", updated_at: "2026-11-01T00:00:00.000Z" },
      { status: "weird" },
      { status: null },
      { status: "failed", failure_code: "requires_action_canceled", stripe_payment_intent_id: "pi_x" },
    ];
    for (const o of open) {
      expect(feePrepareBlock([a({ id: "1", charge_type: "no_show", ...o })], "late_cancel", NOW), JSON.stringify(o)).toBe(ONE_FEE_PER_APPOINTMENT_MESSAGE);
    }
  });
  it("only a failed or cancelled attempt frees the appointment: the other type is allowed", () => {
    expect(feePrepareBlock([a({ id: "1", status: "failed", failure_code: "card_declined", charge_type: "late_cancel" })], "no_show", NOW)).toBeNull();
    expect(feePrepareBlock([a({ id: "1", status: "cancelled", charge_type: "no_show" })], "late_cancel", NOW)).toBeNull();
    expect(feePrepareBlock([], "no_show", NOW)).toBeNull();
  });
  it("the same type keeps its own message", () => {
    expect(feePrepareBlock([a({ id: "1", status: "ready", charge_type: "no_show" })], "no_show", NOW)).toBe(SAME_TYPE_ACTIVE_MESSAGE);
  });
  it("a failed attempt next to a succeeded one of the other type still blocks (the succeeded one holds it)", () => {
    const rows = [a({ id: "1", status: "failed" }), a({ id: "2", status: "succeeded", charge_type: "no_show", created_at: at(1) })];
    expect(feePrepareBlock(rows, "late_cancel", NOW)).not.toBeNull();
  });
});

describe("execute: the re-check just before the claim closes the two-tab race", () => {
  const lc = { id: "lc", created_at: at(1) };
  const ns = { id: "ns", created_at: at(2) };
  const rowOf = (x: { id: string; created_at: string }, type: OneFeeAttempt["charge_type"], status = "ready"): OneFeeAttempt =>
    a({ id: x.id, created_at: x.created_at, charge_type: type, status });

  it("two prepares of different types raced: BOTH exist as ready; exactly one of them may execute", () => {
    const first = feeExecuteBlock(lc, [rowOf(ns, "no_show")], NOW); // earlier attempt runs
    const second = feeExecuteBlock(ns, [rowOf(lc, "late_cancel")], NOW); // later attempt is refused
    expect(first).toBeNull();
    expect(second).toBe(ONE_FEE_PER_APPOINTMENT_MESSAGE);
  });
  it("whichever click lands first, the verdict is the same (order-independent): one charge", () => {
    const verdict = (self: typeof lc, other: typeof lc, otherType: OneFeeAttempt["charge_type"]) => feeExecuteBlock(self, [rowOf(other, otherType)], NOW) === null;
    expect([verdict(lc, ns, "no_show"), verdict(ns, lc, "late_cancel")].filter(Boolean)).toHaveLength(1);
  });
  it("once the earlier one is charged or in flight, the later one is refused regardless of order", () => {
    for (const status of ["succeeded", "pending_stripe"]) {
      expect(feeExecuteBlock(ns, [rowOf(lc, "late_cancel", status)], NOW)).toBe(ONE_FEE_PER_APPOINTMENT_MESSAGE);
    }
  });
  it("a LATER rival that is only ready never blocks the earlier attempt; a non-ready rival blocks even if later", () => {
    expect(feeExecuteBlock(lc, [rowOf(ns, "no_show")], NOW)).toBeNull();
    expect(feeExecuteBlock(lc, [rowOf(ns, "no_show", "succeeded")], NOW)).toBe(ONE_FEE_PER_APPOINTMENT_MESSAGE);
  });
  it("a failed or cancelled rival frees it; equal timestamps break on id so exactly one wins", () => {
    expect(feeExecuteBlock(ns, [rowOf(lc, "late_cancel", "failed")], NOW)).toBeNull();
    expect(feeExecuteBlock(ns, [rowOf(lc, "late_cancel", "cancelled")], NOW)).toBeNull();
    const t = at(3);
    const x = { id: "a1", created_at: t };
    const y = { id: "b2", created_at: t };
    expect([feeExecuteBlock(x, [rowOf(y, "no_show")], NOW), feeExecuteBlock(y, [rowOf(x, "late_cancel")], NOW)].filter((v) => v === null)).toHaveLength(1);
  });
  it("itself is never its own rival", () => {
    expect(feeExecuteBlock(lc, [rowOf(lc, "late_cancel")], NOW)).toBeNull();
  });
});

describe("wiring: the rule is used at prepare and re-checked before the claim", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
  it("eligibility (prepare) uses feePrepareBlock over the merged attempts of both types", () => {
    const e = read("lib/billing/manual-fee-eligibility.ts");
    expect(e).toMatch(/feePrepareBlock\(existingAttempts, serverChargeType, new Date\(\)\)/);
    expect(e).not.toMatch(/row\.charge_type === serverChargeType && ACTIVE_STATUSES/);
  });
  it("the execute action runs feeExecuteBlock BEFORE the shared runner, reads both types, and fails closed", () => {
    const x = read("app/(app)/calendar/[id]/manual-fee-actions.ts");
    const charge = x.slice(x.indexOf("export async function chargeManualFeeAttemptAction"));
    const check = charge.indexOf("feeExecuteBlock(");
    const run = charge.indexOf("runSessionPaymentCharge(");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(run);
    expect(charge).toMatch(/\.in\("charge_reason", \["no_show_fee", "late_cancellation_fee"\]\)/);
    expect(charge).toMatch(/\.neq\("id", attemptId\)/);
    expect(charge).toMatch(/if \(siblingsError \|\| !siblings\) \{\s*return \{ ok: false, outcome: "blocked"/);
  });
});
