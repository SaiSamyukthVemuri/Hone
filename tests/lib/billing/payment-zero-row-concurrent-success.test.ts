import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// PAY-ZERO-ROW-RACE-01 — THE WEBHOOK WINS THE SUCCEEDED ROW
// ===========================================================================
//
// THE REAL INCIDENT THIS PINS. 2026-09-27, livemode, 150.00 CAD,
// pi_3UKQ8hFFVFNfy7qR07fa7N4i:
//
//   22:01:45.282  payment_intent.succeeded webhook starts processing
//   22:01:45.398  reconcile_card_payment_succeeded stamps the row (DB clock)
//   22:01:45.448  webhook finishes cleanly
//   22:01:47.524  writeSucceededOutcome's conditional UPDATE matches ZERO rows
//                 -> CRITICAL "manual reconciliation required"
//
// The ledger was already perfect. The alert was true about the zero rows and
// false about everything an operator would act on, and it woke somebody at
// 22:01 for nothing.
//
// TWO THINGS WERE WRONG, and the second is the dangerous one:
//
//   1. A false CRITICAL on a correct ledger.
//   2. A RECEIPT WAS OWED AND ALMOST LOST. Automatic receipts require
//      `committedNow === true`, the webhook path sends no receipts at all, and
//      in the race `committedNow` is true ZERO times for a charge that really
//      moved money. In the incident a human noticed and clicked Send receipt 13
//      seconds later; nothing in the system would have.
//
// WHY THIS FILE DRIVES THE REAL RUNNER. A source-shape test cannot tell whether
// the classifier is REACHED, and the previous release of this area was caught by
// exactly that gap. So Stripe and the admin client are faked, the webhook is
// simulated by making the conditional UPDATE match zero rows, and the real
// `runSessionPaymentCharge` decides. Every mutation control below flips one fact
// in the re-read and proves the verdict changes.

class Tripwire extends Error {}

const h = vi.hoisted(() => ({
  /** Rows the conditional succeeded UPDATE reports back. [] simulates the race. */
  succeededUpdateRows: [] as Array<{ id: string }>,
  /** What the authoritative re-read returns. null simulates an unreadable row. */
  recheckRow: null as Record<string, unknown> | null,
  recheckError: null as { code: string } | null,
  alerts: [] as Array<{ severity: string; event: string; details: unknown }>,
  stripeCalls: [] as string[],
  updates: [] as Array<Record<string, unknown>>,
  rows: {} as Record<string, unknown>,
  /** Which claim result the RPC reports. Only "claimed" owns the receipt. */
  claimResult: "claimed" as string,
}));

const PI_ID = "pi_RACE0000000000000001";
const CHARGE_ID = "ch_RACE0000000000000001";
const AMOUNT = 15000;

const fakeStripe = {
  paymentIntents: {
    create: async () => {
      h.stripeCalls.push("paymentIntents.create");
      return {
        id: PI_ID,
        status: "succeeded",
        amount: AMOUNT,
        currency: "cad",
        livemode: false,
        latest_charge: CHARGE_ID,
      };
    },
    retrieve: async () => {
      h.stripeCalls.push("paymentIntents.retrieve");
      throw new Tripwire("retrieve must not be reached on a fresh charge");
    },
    cancel: async () => {
      h.stripeCalls.push("paymentIntents.cancel");
      throw new Tripwire("cancel must not be reached on a succeeded PI");
    },
    confirm: async () => {
      h.stripeCalls.push("paymentIntents.confirm");
      throw new Tripwire("confirm must not be reached");
    },
  },
  refunds: {
    create: async () => {
      h.stripeCalls.push("refunds.create");
      throw new Tripwire("no refund belongs in this flow");
    },
  },
};

vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => false,
  getStripe: () => fakeStripe,
}));
vi.mock("@/lib/stripe/session-payment-stripe", () => ({
  getSessionPaymentStripe: () => fakeStripe,
}));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (input: {
    severity: string;
    event: string;
    safeDetails?: unknown;
  }) => {
    h.alerts.push({
      severity: input.severity,
      event: input.event,
      details: input.safeDetails,
    });
  },
}));
vi.mock("@/lib/billing/charge-description", () => ({
  buildChargeDescription: () => "desc",
}));
vi.mock("@/lib/consent/current-card-authorization", () => ({
  getChargeReadyCardAuthorizationStatus: async () => ({
    kind: "signed_current",
    signatureId: "sig-1",
    templateId: "tpl-1",
    templateVersion: 3,
    signedAt: "2026-08-01T00:00:00.000Z",
  }),
  getCardAuthorizationStatus: async () => ({
    kind: "signed_current",
    signatureId: "sig-1",
    templateId: "tpl-1",
    templateVersion: 3,
    signedAt: "2026-08-01T00:00:00.000Z",
  }),
}));

// The admin client. Reads resolve from `h.rows`; the succeeded UPDATE reports
// `h.succeededUpdateRows`, which is how the webhook's win is simulated; and the
// re-read after a zero-row update answers from `h.recheckRow`.
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {};
      let isUpdate = false;
      let updatePayload: Record<string, unknown> | null = null;
      /** Set once the query has been narrowed to a single attempt id. */
      let selectedColumns = "";
      const read = () => {
        // The RE-READ is the only select that asks for cancelled_at/refund_status
        // together, so it is distinguishable from the runner's earlier reads
        // without depending on call ordering.
        if (
          table === "payment_charge_attempts" &&
          selectedColumns.includes("cancelled_at") &&
          selectedColumns.includes("refund_status")
        ) {
          if (h.recheckError) return { data: null, error: h.recheckError };
          return { data: h.recheckRow, error: null };
        }
        return { data: h.rows[table] ?? null, error: null };
      };
      q.select = (cols?: string) => {
        if (typeof cols === "string") selectedColumns = cols;
        if (isUpdate) {
          h.updates.push(updatePayload ?? {});
          return Promise.resolve({ data: h.succeededUpdateRows, error: null });
        }
        return q;
      };
      q.eq = () => q;
      q.is = () => q;
      q.in = () => q;
      q.order = () => q;
      q.limit = () => q;
      q.maybeSingle = async () => read();
      q.single = async () => read();
      q.then = (resolve: (v: unknown) => unknown) => resolve(read());
      q.update = (payload: Record<string, unknown>) => {
        isUpdate = true;
        updatePayload = payload;
        return q;
      };
      q.insert = () => {
        throw new Tripwire(`unexpected insert on ${table}`);
      };
      q.delete = () => {
        throw new Tripwire(`unexpected delete on ${table}`);
      };
      return q;
    },
    rpc: async (name: string) => {
      if (name !== "claim_session_payment_charge_attempt") {
        return { data: null, error: null };
      }
      return {
        data: [
          {
            result: h.claimResult,
            attempt_id: ATTEMPT,
            studio_id: STUDIO,
            client_id: CLIENT,
            session_id: SESSION,
            appointment_id: APPOINTMENT,
            charge_reason: "session_payment",
            amount_cents: AMOUNT,
            currency: "cad",
            client_payment_method_id: "cpm-1",
            card_authorization_signature_id: "sig-1",
            stripe_account_id: "acct_test",
            stripe_customer_id: "cus_test",
            stripe_payment_method_id: "pm_test",
            stripe_payment_intent_id: null,
            stripe_idempotency_key: "idem-1",
            status_before_claim: "ready",
            // RECENT, DELIBERATELY. With a stale timestamp an `already_pending`
            // claim carrying no PaymentIntent id is refused by the
            // reconciliation-window guard as `stale_pending_no_pi` — which is
            // correct behaviour, and would have made the duplicate-creator tests
            // below pass for the wrong reason by never reaching
            // paymentIntents.create at all.
            updated_at: new Date().toISOString(),
          },
        ],
        error: null,
      };
    },
  }),
}));

const { runSessionPaymentCharge } = await import(
  "@/lib/billing/session-payment-charge"
);
const { autoSendReceiptAfterCharge } = await import(
  "@/lib/billing/auto-payment-receipt"
);

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const PRACTITIONER = "44444444-4444-4444-8444-444444444444";
const SESSION = "55555555-5555-4555-8555-555555555555";
const APPOINTMENT = "66666666-6666-4666-8666-666666666666";

const HEALTHY_ATTEMPT = {
  id: ATTEMPT,
  studio_id: STUDIO,
  charge_reason: "session_payment",
  client_id: CLIENT,
  session_id: SESSION,
  appointment_id: APPOINTMENT,
  amount_cents: AMOUNT,
  currency: "cad",
  status: "ready",
  stripe_livemode: false,
  client_payment_method_id: "cpm-1",
  card_authorization_signature_id: "sig-1",
  stripe_account_id: "acct_test",
  stripe_customer_id: "cus_test",
  stripe_payment_method_id: "pm_test",
  stripe_payment_intent_id: null,
  stripe_idempotency_key: null,
  updated_at: "2026-08-01T00:00:00.000Z",
};

/** The row as the webhook's reconcile command would leave it. */
const WEBHOOK_STAMPED_ROW = {
  id: ATTEMPT,
  studio_id: STUDIO,
  client_id: CLIENT,
  status: "succeeded",
  charge_reason: "session_payment",
  amount_cents: AMOUNT,
  currency: "cad",
  stripe_livemode: false,
  stripe_payment_intent_id: PI_ID,
  stripe_charge_id: CHARGE_ID,
  cancelled_at: null,
  refund_status: null,
};

const run = () =>
  runSessionPaymentCharge({
    attemptId: ATTEMPT,
    studioId: STUDIO,
    practitionerId: PRACTITIONER,
  } as never);

const critical = () => h.alerts.filter((a) => a.severity === "critical");
const warnings = () => h.alerts.filter((a) => a.severity === "warning");

beforeEach(() => {
  h.succeededUpdateRows = []; // the race, by default
  h.recheckRow = { ...WEBHOOK_STAMPED_ROW };
  h.recheckError = null;
  h.claimResult = "claimed";
  h.alerts = [];
  h.stripeCalls = [];
  h.updates = [];
  h.rows = {
    payment_charge_attempts: HEALTHY_ATTEMPT,
    client_payment_methods: {
      id: HEALTHY_ATTEMPT.client_payment_method_id,
      studio_id: STUDIO,
      client_id: CLIENT,
      status: "active",
      stripe_livemode: false,
      stripe_account_id: HEALTHY_ATTEMPT.stripe_account_id,
      stripe_customer_id: HEALTHY_ATTEMPT.stripe_customer_id,
      stripe_payment_method_id: HEALTHY_ATTEMPT.stripe_payment_method_id,
      card_authorization_signature_id:
        HEALTHY_ATTEMPT.card_authorization_signature_id,
    },
    studio_payment_settings: {
      stripe_account_id: HEALTHY_ATTEMPT.stripe_account_id,
      stripe_livemode: false,
    },
    client_stripe_customers: {
      stripe_customer_id: HEALTHY_ATTEMPT.stripe_customer_id,
    },
  };
});

describe("the concurrent writer wins: proven benign, no false critical", () => {
  it("reports success, names the concurrent writer, and raises NO critical alert", async () => {
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      outcome: "succeeded",
      stripePaymentIntentId: PI_ID,
      // This invocation did NOT write the row...
      committedNow: false,
      // ...but a verified concurrent writer recorded the identical charge.
      concurrentlyReconciled: true,
    });
    expect(
      critical(),
      "a correct ledger must not raise a critical money alert",
    ).toEqual([]);
  });

  it("still records the race at WARNING, so it stays observable", async () => {
    await run();
    const w = warnings();
    expect(w).toHaveLength(1);
    expect(w[0].event).toBe(
      "session_payment_succeeded_write_concurrent_reconciliation",
    );
    expect(w[0].details).toMatchObject({
      attempt_id: ATTEMPT,
      resolution: "concurrent_writer_already_persisted",
    });
  });

  it("creates exactly ONE PaymentIntent — no duplicate charge", async () => {
    await run();
    expect(
      h.stripeCalls.filter((c) => c === "paymentIntents.create"),
    ).toHaveLength(1);
    expect(h.stripeCalls).toEqual(["paymentIntents.create"]);
  });

  it("attempts no second succeeded write after losing the race", async () => {
    await run();
    const succeededWrites = h.updates.filter((u) => u.status === "succeeded");
    expect(succeededWrites).toHaveLength(1);
  });
});

describe("THE RECEIPT IS NOT LOST — the half the incident nearly dropped", () => {
  it("dispatches the receipt for the concurrently-reconciled charge", async () => {
    const result = await run();
    let sent = 0;
    const outcome = await autoSendReceiptAfterCharge({
      charge: result as never,
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
      send: async () => {
        sent += 1;
        return { ok: true } as never;
      },
      register: (fn: () => unknown) => {
        void fn();
      },
    } as never);
    expect(sent, "a real charge happened and owes exactly one receipt").toBe(1);
    expect(outcome).toMatchObject({ attempted: true });
  });

  it("a REPLAY still sends nothing", async () => {
    // The claim command short-circuited on an already-succeeded row: no
    // PaymentIntent was created by this invocation, so nothing is owed.
    let sent = 0;
    const outcome = await autoSendReceiptAfterCharge({
      charge: {
        ok: true,
        outcome: "succeeded",
        stripePaymentIntentId: PI_ID,
        stripeChargeId: null,
        committedNow: false,
      } as never,
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
      send: async () => {
        sent += 1;
        return { ok: true } as never;
      },
    } as never);
    expect(sent, "a replay owes no receipt").toBe(0);
    expect(outcome).toMatchObject({
      attempted: false,
      reason: "replay_not_a_new_charge",
    });
  });

  it("needs_manual_review still sends nothing", async () => {
    let sent = 0;
    await autoSendReceiptAfterCharge({
      charge: {
        ok: false,
        outcome: "needs_manual_review",
        message: "x",
      } as never,
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
      send: async () => {
        sent += 1;
        return { ok: true } as never;
      },
    } as never);
    expect(sent).toBe(0);
  });

  it("AT MOST ONE receipt: the same result cannot be replayed into a second send", async () => {
    // The durable claim lives in sendPaymentChargeReceipt (receipt_status), which
    // is mocked here — so this asserts the layer this repair owns: one charge
    // result produces one send per invocation, and the gate is the only thing
    // that decides. A second call with the SAME result is what a double-submit
    // looks like from here, and the database claim is what stops it in
    // production; that is pinned in tests/lib/billing/payment-receipt*.
    const result = await run();
    let sent = 0;
    const send = async () => {
      sent += 1;
      return { ok: true } as never;
    };
    const args = {
      charge: result as never,
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
      send,
      register: (fn: () => unknown) => {
        void fn();
      },
    };
    await autoSendReceiptAfterCharge(args as never);
    expect(sent).toBe(1);
  });
});

describe("MUTATION CONTROLS — every one of these must stay CRITICAL", () => {
  const expectCritical = async (why: string) => {
    const result = await run();
    expect(result.ok, `${why}: must not report success`).toBe(false);
    expect(result).toMatchObject({ outcome: "needs_manual_review" });
    const c = critical();
    expect(c, `${why}: must raise exactly one critical alert`).toHaveLength(1);
    expect(c[0].event).toBe("session_payment_succeeded_write_zero_rows");
    expect(
      warnings(),
      `${why}: must NOT be recorded as a benign race`,
    ).toEqual([]);
    return c[0].details as { recheck_failed?: string };
  };

  it("DIFFERENT PaymentIntent -> critical", async () => {
    h.recheckRow = {
      ...WEBHOOK_STAMPED_ROW,
      stripe_payment_intent_id: "pi_SOMETHING_ELSE",
    };
    const d = await expectCritical("different PI");
    expect(d.recheck_failed).toBe("payment_intent_mismatch");
  });

  it("DIFFERENT charge lineage -> critical", async () => {
    h.recheckRow = {
      ...WEBHOOK_STAMPED_ROW,
      stripe_charge_id: "ch_A_DIFFERENT_CHARGE",
    };
    const d = await expectCritical("different charge");
    expect(d.recheck_failed).toBe("charge_id_mismatch");
  });

  it("row UNREADABLE (read error) -> critical", async () => {
    h.recheckError = { code: "57014" };
    const d = await expectCritical("unreadable row");
    expect(d.recheck_failed).toBe("recheck_read_error:57014");
  });

  it("row MISSING -> critical", async () => {
    h.recheckRow = null;
    const d = await expectCritical("missing row");
    expect(d.recheck_failed).toBe("recheck_row_missing");
  });

  it("TERMINAL non-success (cancelled) -> critical", async () => {
    h.recheckRow = { ...WEBHOOK_STAMPED_ROW, status: "cancelled" };
    const d = await expectCritical("cancelled row");
    expect(d.recheck_failed).toBe("status_not_succeeded");
  });

  it("TERMINAL non-success (failed) -> critical", async () => {
    h.recheckRow = { ...WEBHOOK_STAMPED_ROW, status: "failed" };
    await expectCritical("failed row");
  });

  it("still pending_stripe (nobody stamped it) -> critical", async () => {
    h.recheckRow = { ...WEBHOOK_STAMPED_ROW, status: "pending_stripe" };
    await expectCritical("nobody stamped it");
  });

  it("AMOUNT mismatch -> critical", async () => {
    h.recheckRow = { ...WEBHOOK_STAMPED_ROW, amount_cents: AMOUNT + 1 };
    const d = await expectCritical("amount mismatch");
    expect(d.recheck_failed).toBe("amount_mismatch");
  });

  it("CURRENCY mismatch -> critical", async () => {
    h.recheckRow = { ...WEBHOOK_STAMPED_ROW, currency: "usd" };
    const d = await expectCritical("currency mismatch");
    expect(d.recheck_failed).toBe("currency_mismatch");
  });

  it("LIVEMODE mismatch -> critical", async () => {
    h.recheckRow = { ...WEBHOOK_STAMPED_ROW, stripe_livemode: true };
    const d = await expectCritical("livemode mismatch");
    expect(d.recheck_failed).toBe("livemode_mismatch");
  });

  it("CHARGE REASON mismatch -> critical", async () => {
    h.recheckRow = { ...WEBHOOK_STAMPED_ROW, charge_reason: "no_show_fee" };
    const d = await expectCritical("charge reason mismatch");
    expect(d.recheck_failed).toBe("charge_reason_mismatch");
  });

  it("STUDIO mismatch -> critical", async () => {
    h.recheckRow = {
      ...WEBHOOK_STAMPED_ROW,
      studio_id: "99999999-9999-4999-8999-999999999999",
    };
    const d = await expectCritical("studio mismatch");
    expect(d.recheck_failed).toBe("studio_mismatch");
  });

  it("CLIENT mismatch -> critical", async () => {
    h.recheckRow = {
      ...WEBHOOK_STAMPED_ROW,
      client_id: "99999999-9999-4999-8999-999999999999",
    };
    const d = await expectCritical("client mismatch");
    expect(d.recheck_failed).toBe("client_mismatch");
  });

  it("ALREADY REFUNDED -> critical, and no fresh receipt", async () => {
    h.recheckRow = { ...WEBHOOK_STAMPED_ROW, refund_status: "succeeded" };
    const d = await expectCritical("already refunded");
    expect(d.recheck_failed).toBe("refund_in_progress_or_done");
  });

  it("a CANCELLED timestamp alone is enough -> critical", async () => {
    h.recheckRow = {
      ...WEBHOOK_STAMPED_ROW,
      cancelled_at: "2026-09-27T22:01:00.000Z",
    };
    const d = await expectCritical("cancelled_at set");
    expect(d.recheck_failed).toBe("row_cancelled");
  });

  it("a critical verdict sends NO receipt", async () => {
    h.recheckRow = {
      ...WEBHOOK_STAMPED_ROW,
      stripe_payment_intent_id: "pi_SOMETHING_ELSE",
    };
    const result = await run();
    let sent = 0;
    await autoSendReceiptAfterCharge({
      charge: result as never,
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
      send: async () => {
        sent += 1;
        return { ok: true } as never;
      },
    } as never);
    expect(sent, "an unproven ledger must never receipt a client").toBe(0);
  });
});

describe("POSITIVE CONTROL — the harness can reach the clean path", () => {
  it("when OUR update matches a row, it is committedNow and not a race", async () => {
    // Without this, every assertion above could pass because the fixture never
    // reached the succeeded write at all.
    h.succeededUpdateRows = [{ id: ATTEMPT }];
    const result = await run();
    expect(result).toMatchObject({
      ok: true,
      outcome: "succeeded",
      committedNow: true,
      concurrentlyReconciled: false,
    });
    expect(critical()).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it("and that clean path also sends exactly one receipt", async () => {
    h.succeededUpdateRows = [{ id: ATTEMPT }];
    const result = await run();
    let sent = 0;
    await autoSendReceiptAfterCharge({
      charge: result as never,
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
      send: async () => {
        sent += 1;
        return { ok: true } as never;
      },
      register: (fn: () => unknown) => {
        void fn();
      },
    } as never);
    expect(sent).toBe(1);
  });
});

// ===========================================================================
// P1 REGRESSIONS FROM REVIEW — each of these shipped broken in 5237aaee
// ===========================================================================

describe("P1: a refund in flight is NOT benign", () => {
  // The first predicate was `refund_status !== "succeeded"`, which accepted
  // `pending_stripe` — a refund already on its way with an unknown Stripe
  // outcome — and then sent the client an automatic receipt for money going
  // back. Before the repair every zero-row write stayed fail-closed, so this was
  // a regression introduced BY the fix, not a pre-existing gap.
  for (const state of ["pending_stripe", "succeeded", "failed", "requested"]) {
    it(`refund_status='${state}' -> critical, and no receipt`, async () => {
      h.recheckRow = { ...WEBHOOK_STAMPED_ROW, refund_status: state };
      const result = await run();
      expect(result.ok, `refund_status ${state} must not be benign`).toBe(false);
      expect(critical()).toHaveLength(1);
      expect(
        (critical()[0].details as { recheck_failed?: string }).recheck_failed,
      ).toBe("refund_in_progress_or_done");
      let sent = 0;
      await autoSendReceiptAfterCharge({
        charge: result as never,
        attemptId: ATTEMPT,
        studioId: STUDIO,
        practitionerId: PRACTITIONER,
        send: async () => {
          sent += 1;
          return { ok: true } as never;
        },
      } as never);
      expect(sent, "never receipt a charge that is being refunded").toBe(0);
    });
  }

  it("only refund_status = NULL is benign", async () => {
    h.recheckRow = { ...WEBHOOK_STAMPED_ROW, refund_status: null };
    const result = await run();
    expect(result).toMatchObject({ ok: true, concurrentlyReconciled: true });
    expect(critical()).toEqual([]);
  });
});

describe("P1: receipt ownership is the DB claim, not the Stripe call", () => {
  // THE DUPLICATE-RECEIPT PATH THE REVIEW FOUND. The `already_pending`-with-no-PI
  // branch deliberately lets SEVERAL requests fall through to
  // paymentIntents.create with the same idempotency key, so Stripe hands the SAME
  // succeeded PI to all of them. Ownership was hardcoded `true`, so every loser
  // claimed the receipt — and `payment-receipt.ts` resets receipt_status to null
  // on a retryable failure, so the DB claim alone can be reopened and a second
  // sender can deliver a duplicate to a client.
  it("an already_pending idempotent replay does NOT own the receipt", async () => {
    h.claimResult = "already_pending";
    const result = await run();
    // The money verdict is unchanged: the ledger is right either way.
    expect(result).toMatchObject({ ok: true, outcome: "succeeded" });
    // `concurrentlyReconciled` is now a VERIFICATION fact and is legitimately
    // true here: a concurrent writer did persist the identical charge. What makes
    // this invocation ineligible is OWNERSHIP, which is the separate fact.
    expect(result).toMatchObject({
      concurrentlyReconciled: true,
      receiptOwnedHere: false,
    });
    let sent = 0;
    await autoSendReceiptAfterCharge({
      charge: result as never,
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
      send: async () => {
        sent += 1;
        return { ok: true } as never;
      },
    } as never);
    expect(sent, "an idempotent replay must not send a receipt").toBe(0);
  });

  it("N concurrent idempotent creators produce AT MOST ONE receipt owner", async () => {
    // The reviewer's scenario, counted. Only the invocation that won the claim
    // may own the receipt; every other one is a replay however Stripe answered.
    let owners = 0;
    for (const claimResult of [
      "claimed",
      "already_pending",
      "already_pending",
      "already_pending",
    ]) {
      h.alerts = [];
      h.stripeCalls = [];
      h.claimResult = claimResult;
      const result = (await run()) as { receiptOwnedHere?: boolean };
      // OWNERSHIP is what counts a sender, and it is anchored to the claim.
      if (result.receiptOwnedHere === true) owners += 1;
    }
    expect(owners, "exactly one invocation may own the receipt").toBe(1);
  });

  it("the winner still owns it", async () => {
    h.claimResult = "claimed";
    const result = await run();
    expect(result).toMatchObject({ concurrentlyReconciled: true });
  });
});

describe("P1: a benign race that owes a receipt is never SILENT", () => {
  // Returning clean success without owning the receipt would trade a false
  // critical for a silent gap, and a silently unsent receipt for real money is
  // the worse of the two.
  it("names the receipt exposure when this invocation does not own it", async () => {
    h.claimResult = "already_pending";
    await run();
    const w = warnings();
    expect(w).toHaveLength(1);
    expect(w[0].details).toMatchObject({
      receipt_owned_here: false,
      receipt_may_be_owed: true,
    });
  });

  it("and reports ownership when it DOES own it", async () => {
    h.claimResult = "claimed";
    await run();
    expect(warnings()[0].details).toMatchObject({
      receipt_owned_here: true,
      receipt_may_be_owed: false,
    });
  });
});

// ===========================================================================
// THE FOUR OWNERSHIP CASES — the table that makes this contract checkable
// ===========================================================================
//
// Receipt eligibility is the CONJUNCTION of two independent facts, and the whole
// point of the structural repair is that neither substitutes for the other:
//
//   claim result     wins succeeded write   committedNow  owned  eligible
//   ---------------  ---------------------  ------------  -----  --------
//   A claimed        yes                    true          true   YES
//   B claimed        no (webhook wins)      false         true   YES
//   C already_pending yes                   true          FALSE  no
//   D already_pending no                    false         false  no
//
// Row C is the defect two review rounds found: it looks exactly like row A on the
// persistence axis, and only ownership tells them apart.

describe("the four ownership cases", () => {
  const eligible = async (charge: unknown) => {
    let sent = 0;
    await autoSendReceiptAfterCharge({
      charge: charge as never,
      attemptId: ATTEMPT,
      studioId: STUDIO,
      practitionerId: PRACTITIONER,
      send: async () => {
        sent += 1;
        return { ok: true } as never;
      },
      register: (fn: () => unknown) => {
        void fn();
      },
    } as never);
    return sent === 1;
  };

  it("A. claimed + wins the succeeded write -> owned, committed, ELIGIBLE", async () => {
    h.claimResult = "claimed";
    h.succeededUpdateRows = [{ id: ATTEMPT }];
    const r = await run();
    expect(r).toMatchObject({
      ok: true,
      committedNow: true,
      concurrentlyReconciled: false,
      receiptOwnedHere: true,
    });
    expect(await eligible(r)).toBe(true);
  });

  it("B. claimed + webhook wins the write -> owned, NOT committed, ELIGIBLE", async () => {
    h.claimResult = "claimed";
    h.succeededUpdateRows = [];
    const r = await run();
    expect(r).toMatchObject({
      ok: true,
      committedNow: false,
      concurrentlyReconciled: true,
      receiptOwnedHere: true,
    });
    expect(await eligible(r)).toBe(true);
  });

  it("C. already_pending + WINS the write -> committed but NOT owned, ineligible", async () => {
    // THE DEFECT ROW. Indistinguishable from A on the persistence axis.
    h.claimResult = "already_pending";
    h.succeededUpdateRows = [{ id: ATTEMPT }];
    const r = await run();
    expect(r).toMatchObject({
      ok: true,
      committedNow: true,
      receiptOwnedHere: false,
    });
    expect(
      await eligible(r),
      "an idempotent replay that won the write must not send",
    ).toBe(false);
  });

  it("D. already_pending + loses the write -> neither, ineligible", async () => {
    h.claimResult = "already_pending";
    h.succeededUpdateRows = [];
    const r = await run();
    expect(r).toMatchObject({
      ok: true,
      committedNow: false,
      receiptOwnedHere: false,
    });
    expect(await eligible(r)).toBe(false);
  });

  it("across all four, exactly ONE case is eligible per charge", async () => {
    // A and B are the same invocation under two race outcomes, so exactly one of
    // the four CLAIM/write combinations that can coexist for one attempt is
    // eligible: the claim winner. C and D are the losers and send nothing.
    let owners = 0;
    for (const [claimResult, rows] of [
      ["claimed", []],
      ["already_pending", [{ id: ATTEMPT }]],
      ["already_pending", []],
      ["already_pending", []],
    ] as Array<[string, Array<{ id: string }>]>) {
      h.alerts = [];
      h.claimResult = claimResult;
      h.succeededUpdateRows = rows;
      const r = (await run()) as { receiptOwnedHere?: boolean };
      if (r.receiptOwnedHere === true) owners += 1;
    }
    expect(owners).toBe(1);
  });
});

describe("charge-lineage asymmetry", () => {
  // A missing PROVIDER charge id cannot prove an arbitrary non-null ROW charge is
  // this charge. A missing ROW charge id proves nothing either way and is allowed
  // only because every other identity and money fact must still match.
  const withProviderCharge = (latest: string | null) => {
    fakeStripe.paymentIntents.create = async () => {
      h.stripeCalls.push("paymentIntents.create");
      return {
        id: PI_ID,
        status: "succeeded",
        amount: AMOUNT,
        currency: "cad",
        livemode: false,
        latest_charge: latest,
      } as never;
    };
  };

  it("provider NULL + row NON-NULL -> CRITICAL", async () => {
    withProviderCharge(null);
    h.recheckRow = { ...WEBHOOK_STAMPED_ROW, stripe_charge_id: CHARGE_ID };
    const r = await run();
    expect(r.ok).toBe(false);
    expect(critical()).toHaveLength(1);
    expect(
      (critical()[0].details as { recheck_failed?: string }).recheck_failed,
    ).toBe("charge_id_mismatch");
  });

  it("provider X + row Y -> CRITICAL", async () => {
    withProviderCharge(CHARGE_ID);
    h.recheckRow = { ...WEBHOOK_STAMPED_ROW, stripe_charge_id: "ch_OTHER" };
    const r = await run();
    expect(r.ok).toBe(false);
    expect(critical()).toHaveLength(1);
  });

  it("provider X + row X -> benign", async () => {
    withProviderCharge(CHARGE_ID);
    h.recheckRow = { ...WEBHOOK_STAMPED_ROW, stripe_charge_id: CHARGE_ID };
    const r = await run();
    expect(r).toMatchObject({ ok: true, concurrentlyReconciled: true });
    expect(critical()).toEqual([]);
  });

  it("row NULL + provider X -> benign, because everything else matches", async () => {
    withProviderCharge(CHARGE_ID);
    h.recheckRow = { ...WEBHOOK_STAMPED_ROW, stripe_charge_id: null };
    const r = await run();
    expect(r).toMatchObject({ ok: true, concurrentlyReconciled: true });
    expect(critical()).toEqual([]);
  });

  it("row NULL + provider NULL -> benign", async () => {
    withProviderCharge(null);
    h.recheckRow = { ...WEBHOOK_STAMPED_ROW, stripe_charge_id: null };
    const r = await run();
    expect(r).toMatchObject({ ok: true, concurrentlyReconciled: true });
    expect(critical()).toEqual([]);
  });

  it("row NULL does NOT excuse an identity mismatch", async () => {
    // The null-row allowance is not a general amnesty.
    withProviderCharge(CHARGE_ID);
    h.recheckRow = {
      ...WEBHOOK_STAMPED_ROW,
      stripe_charge_id: null,
      amount_cents: AMOUNT + 1,
    };
    const r = await run();
    expect(r.ok).toBe(false);
    expect(
      (critical()[0].details as { recheck_failed?: string }).recheck_failed,
    ).toBe("amount_mismatch");
  });
});

describe("the alert never claims a receipt was delivered", () => {
  // writeSucceededOutcome runs BEFORE the action layer's sender, so it has no
  // standing to assert delivery — PDF generation, recipient lookup or the
  // provider may still fail, or execution may stop first.
  it("says OWNS and PENDING, never sent/dispatched/delivered", async () => {
    h.claimResult = "claimed";
    const w = (await run(), warnings());
    expect(w).toHaveLength(1);
    const msg = String(
      (w[0] as unknown as { message?: string }).message ?? "",
    );
    void msg;
    expect(w[0].details).toMatchObject({
      receipt_owned_here: true,
      receipt_dispatch_pending_at_action_layer: true,
    });
  });

  it("the alert COPY in source contains no delivery claim", () => {
    const src = readFileSync(
      join(process.cwd(), "lib/billing/session-payment-charge.ts"),
      "utf8",
    );
    const at = src.indexOf(
      'event: "session_payment_succeeded_write_concurrent_reconciliation"',
    );
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("});", src.indexOf("safeDetails:", at)));
    // Operator-facing copy only; comments are not persisted.
    const copy = block
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    for (const claim of [
      /receipt (was )?dispatched/i,
      /receipt (was )?sent/i,
      /receipt (was )?delivered/i,
      /dispatched it automatically/i,
    ]) {
      expect(copy, `alert copy must not claim delivery: ${claim}`).not.toMatch(claim);
    }
    expect(copy).toMatch(/OWNS RECEIPT DISPATCH|DOES NOT OWN RECEIPT DISPATCH/);
    expect(copy).toMatch(/PENDING/);
  });
});
