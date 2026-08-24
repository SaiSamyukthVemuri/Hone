import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

// PAY-SETTLE / 0187 — THE HANDLER MUST LET THE LOCKED COMMAND DECIDE.
//
// The command already refuses correctly under the shared appointment key; that
// is proved against the real database in tests/db/appointment-settlement.db.
// test.ts. This file proves the WIRING above it, which is where the last two
// findings lived:
//
//   * a locally terminal row returned through a shortcut BEFORE the command was
//     ever called — and the most likely reason a row is terminal is that a
//     settlement retired it, so the common case reported "terminal" instead of
//     naming the cash-versus-card contradiction;
//   * `already_succeeded` fell through to the success return, claiming a
//     reconciliation this webhook did not perform.
//
// So these drive the REAL handler with a scripted admin client and assert what
// it does, rather than grepping its source.

class Unexpected extends Error {}

const h = vi.hoisted(() => ({
  attempt: {} as Record<string, unknown>,
  rpcResult: "reconciled" as string,
  rpcStatusBefore: null as string | null,
  rpcCalls: [] as string[],
  alerts: [] as Array<{ event: string; severity: string; message: string }>,
  writes: [] as string[],
}));

vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (a: { event: string; severity: string; message: string }) => {
    h.alerts.push({ event: a.event, severity: a.severity, message: a.message });
  },
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      q.select = chain;
      q.eq = chain;
      q.is = chain;
      q.in = chain;
      q.order = chain;
      q.limit = chain;
      q.maybeSingle = async () => ({ data: h.attempt, error: null });
      q.single = async () => ({ data: h.attempt, error: null });
      q.update = () => {
        // ANY direct write from this handler is now a defect: the only legal
        // status write goes through the command. (The charge-id backfill on an
        // already-succeeded row is exercised separately and allowed.)
        h.writes.push(`update:${table}`);
        return { eq: () => ({ is: async () => ({ data: null, error: null }) }) };
      };
      q.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: [h.attempt], error: null });
      return q;
    },
    rpc: async (name: string) => {
      h.rpcCalls.push(name);
      if (name !== "reconcile_card_payment_succeeded") {
        throw new Unexpected(`unexpected rpc ${name}`);
      }
      return {
        data: [
          {
            result: h.rpcResult,
            attempt_id: h.attempt.id,
            appointment_id: "app-1",
            studio_id: h.attempt.studio_id,
            client_id: h.attempt.client_id,
            status_before: h.rpcStatusBefore ?? h.attempt.status,
          },
        ],
        error: null,
      };
    },
  }),
}));

const { handlePaymentIntentSucceeded } = await import(
  "@/lib/billing/payment-webhook-reconciliation"
);

const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";

function baseAttempt(status: string): Record<string, unknown> {
  return {
    id: ATTEMPT_ID,
    studio_id: "11111111-1111-4111-8111-111111111111",
    client_id: "22222222-2222-4222-8222-222222222222",
    charge_reason: "session_payment",
    status,
    stripe_livemode: false,
    stripe_payment_intent_id: "pi_test_1",
    stripe_charge_id: "ch_test_1",
    amount_cents: 4500,
    charged_at: null,
    refund_status: null,
    refund_amount_cents: null,
    refunded_at: null,
    stripe_refund_id: null,
  };
}

const EVENT = {
  id: "evt_1",
  type: "payment_intent.succeeded",
  livemode: false,
  data: {
    object: {
      id: "pi_test_1",
      latest_charge: "ch_test_1",
      metadata: { hone_payment_charge_attempt_id: ATTEMPT_ID },
    },
  },
} as unknown as Stripe.Event;

const CTX = { requestId: "req-1" } as never;

beforeEach(() => {
  h.attempt = baseAttempt("ready");
  h.rpcResult = "reconciled";
  h.rpcStatusBefore = null;
  h.rpcCalls = [];
  h.alerts = [];
  h.writes = [];
});

describe("1 · a settlement committed first is NAMED, not reported as 'terminal'", () => {
  it("reaches the locked command even though the row reads as cancelled", async () => {
    // THE SHORTCUT IS GONE. Before this repair the handler returned here and
    // the command was never called, so the conflict could not be detected.
    h.attempt = baseAttempt("cancelled");
    h.rpcResult = "settled_externally_conflict";
    h.rpcStatusBefore = "cancelled";

    const out = await handlePaymentIntentSucceeded(EVENT, CTX);

    expect(h.rpcCalls).toContain("reconcile_card_payment_succeeded");
    expect(out.settledExternallyConflict).toBe(true);
    expect(out.localTerminalMismatch).toBeUndefined();
  });

  it("raises the CONFLICT alert, at critical, naming the resolution", async () => {
    h.attempt = baseAttempt("cancelled");
    h.rpcResult = "settled_externally_conflict";

    await handlePaymentIntentSucceeded(EVENT, CTX);

    const events = h.alerts.map((a) => a.event);
    expect(events).toContain("payment_intent_succeeded_settled_externally_conflict");
    // And NOT the generic one, which is the whole point.
    expect(events).not.toContain("payment_intent_succeeded_local_terminal_mismatch");

    const alert = h.alerts.find(
      (a) => a.event === "payment_intent_succeeded_settled_externally_conflict",
    )!;
    expect(alert.severity).toBe("critical");
    expect(alert.message).toMatch(/paid cash|non-card settlement/i);
    expect(alert.message).toMatch(/refund|supersed/i);
  });

  it("writes nothing itself", async () => {
    h.attempt = baseAttempt("cancelled");
    h.rpcResult = "settled_externally_conflict";
    await handlePaymentIntentSucceeded(EVENT, CTX);
    expect(h.writes).toEqual([]);
  });
});

describe("2 · another success writer winning the lock is a NO-OP, not a reconcile", () => {
  it("reports idempotent already-succeeded, never reconciledFromStatus", async () => {
    // Read as ready; the action-layer success writer commits before the command
    // takes the lock. This webhook changed nothing.
    h.attempt = baseAttempt("ready");
    h.rpcResult = "already_succeeded";
    h.rpcStatusBefore = "succeeded";

    const out = await handlePaymentIntentSucceeded(EVENT, CTX);

    expect(out.alreadySucceeded).toBe(true);
    expect(out.reconciledFromStatus).toBeUndefined();
    expect(h.writes).toEqual([]);
    // No alert: this is an ordinary benign race, not an operator problem.
    expect(h.alerts).toEqual([]);
  });

  it("the same holds when the row was read as pending_stripe", async () => {
    h.attempt = baseAttempt("pending_stripe");
    h.rpcResult = "already_succeeded";
    const out = await handlePaymentIntentSucceeded(EVENT, CTX);
    expect(out.alreadySucceeded).toBe(true);
    expect(out.reconciledFromStatus).toBeUndefined();
  });
});

describe("3 + 4 · the ordinary reconciliations still happen", () => {
  it("ready -> succeeded reconciles", async () => {
    h.attempt = baseAttempt("ready");
    h.rpcResult = "reconciled";
    const out = await handlePaymentIntentSucceeded(EVENT, CTX);
    expect(h.rpcCalls).toContain("reconcile_card_payment_succeeded");
    expect(out.reconciledFromStatus).toBe("ready");
    expect(out.alreadySucceeded).toBeUndefined();
    expect(h.alerts).toEqual([]);
  });

  it("pending_stripe -> succeeded reconciles", async () => {
    h.attempt = baseAttempt("pending_stripe");
    h.rpcResult = "reconciled";
    const out = await handlePaymentIntentSucceeded(EVENT, CTX);
    expect(out.reconciledFromStatus).toBe("pending_stripe");
    expect(h.alerts).toEqual([]);
  });

  it("reports the status the COMMAND saw under the lock, not the stale read", async () => {
    h.attempt = baseAttempt("ready");
    h.rpcResult = "reconciled";
    h.rpcStatusBefore = "pending_stripe"; // advanced between read and lock
    const out = await handlePaymentIntentSucceeded(EVENT, CTX);
    expect(out.reconciledFromStatus).toBe("pending_stripe");
  });
});

describe("5 · already succeeded BEFORE the initial read stays idempotent", () => {
  it("returns early and never calls the command", async () => {
    h.attempt = baseAttempt("succeeded");
    const out = await handlePaymentIntentSucceeded(EVENT, CTX);
    expect(out.alreadySucceeded).toBe(true);
    expect(h.rpcCalls).toEqual([]);
    expect(h.alerts).toEqual([]);
  });
});

describe("6 · a terminal row unrelated to any settlement keeps its behaviour", () => {
  it.each(["failed", "cancelled", "blocked"])(
    "%s still raises the terminal-mismatch alert and flips nothing",
    async (status) => {
      h.attempt = baseAttempt(status);
      h.rpcResult = "terminal_mismatch";
      h.rpcStatusBefore = status;

      const out = await handlePaymentIntentSucceeded(EVENT, CTX);

      // It now gets there THROUGH the command — which is what lets the
      // settlement case be told apart — but the outcome is unchanged.
      expect(h.rpcCalls).toContain("reconcile_card_payment_succeeded");
      expect(out.localTerminalMismatch).toBe(status);
      expect(out.reconciledFromStatus).toBeUndefined();
      expect(h.writes).toEqual([]);

      const alert = h.alerts.find(
        (a) => a.event === "payment_intent_succeeded_local_terminal_mismatch",
      )!;
      expect(alert).toBeDefined();
      expect(alert.severity).toBe("critical");
      // The message still names the actual status, as it always did.
      expect(alert.message).toContain(`'${status}'`);
    },
  );

  it("zero-row detection still refuses to claim a reconciliation", async () => {
    h.attempt = baseAttempt("ready");
    h.rpcResult = "zero_rows";
    const out = await handlePaymentIntentSucceeded(EVENT, CTX);
    expect(out.zeroRowNoMutation).toBe(true);
    expect(out.reconciledFromStatus).toBeUndefined();
    expect(h.alerts.map((a) => a.event)).toContain(
      "payment_intent_succeeded_reconcile_zero_rows",
    );
  });
});

describe("the no-false-reconciliation contract, stated once", () => {
  it("reconciledFromStatus appears ONLY for an actual reconcile", async () => {
    for (const result of [
      "settled_externally_conflict",
      "terminal_mismatch",
      "already_succeeded",
      "zero_rows",
      "not_found",
    ]) {
      h.attempt = baseAttempt("ready");
      h.rpcResult = result;
      h.alerts = [];
      const out = await handlePaymentIntentSucceeded(EVENT, CTX);
      expect(out.reconciledFromStatus).toBeUndefined();
    }
    h.attempt = baseAttempt("ready");
    h.rpcResult = "reconciled";
    const ok = await handlePaymentIntentSucceeded(EVENT, CTX);
    expect(ok.reconciledFromStatus).toBe("ready");
  });
});
