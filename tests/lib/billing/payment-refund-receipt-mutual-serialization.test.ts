import { handleChargeRefunded } from "@/lib/billing/payment-webhook-reconciliation";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PAY-MUTUAL-01. Refund and receipt must serialize against EACH OTHER.
//
// THE DEFECT THIS SUITE EXISTS FOR. The first fix made the automatic receipt
// claim require `refund_status IS NULL`. That closed REFUND-FIRST only. The
// refund claim filtered id, studio, status, mode and refund_status -- and never
// receipt_status -- so RECEIPT-FIRST stayed wide open:
//
//   receipt claim wins       -> receipt_status = 'sending'
//   refund claim still wins  -> refund_status  = 'pending_stripe'
//   receipt renders its PDF and dispatches
//   => the client is emailed a receipt for a charge already being refunded.
//
// WHY THESE TESTS EVALUATE PREDICATES INSTEAD OF ASSERTING FILTER STRINGS.
// A test that greps the claim for `.or("receipt_status...")` passes as soon as
// the characters exist; it cannot tell a predicate that binds from one that is
// built and discarded. So this harness holds ONE payment_charge_attempts row and
// applies each conditional UPDATE the way Postgres does: evaluate every filter
// against the row's CURRENT state, and only then write. Both real functions --
// refundPaymentChargeAttempt and sendPaymentChargeReceipt -- run against that one
// row, so whoever transitions it first makes the other match zero rows.
//
// WHAT IS AND IS NOT BEING CLAIMED. The serialization authority is the row-level
// UPDATE on a single row, nothing more. There is NO long database transaction
// spanning the Stripe refund call or the email dispatch, and this suite does not
// pretend otherwise: it proves that the two CLAIMS cannot both succeed, which is
// what makes "who may act" unambiguous. What each side then does with its own
// claim over the network is its own concern.

type Filter =
  | { kind: "eq"; col: string; val: unknown }
  | { kind: "is"; col: string; val: unknown }
  | { kind: "or"; expr: string };

const db = vi.hoisted(() => ({
  livemode: true,
  refundProviderStatus: "succeeded" as string | null,
  afterRefund: null as null | (() => void),
  providerRefundOverrides: {} as Record<string, unknown>,
  // THE one row. Every claim is evaluated and applied against this object.
  row: {} as Record<string, unknown>,
  aux: {} as Record<string, { data: unknown; error: unknown }>,
  // Ordered log of every conditional UPDATE and whether it matched.
  writes: [] as Array<{
    patch: Record<string, unknown>;
    matched: boolean;
  }>,
  emails: [] as Array<Record<string, unknown>>,
  stripeRefunds: [] as Array<Record<string, unknown>>,
  sendResult: { ok: true } as Record<string, unknown>,
  // Lets a test make one side reach its claim after the other.
  delayBeforeClaimMs: 0,
  // Fires once, immediately before a conditional UPDATE is evaluated. This is
  // the ONLY way to model a true time-of-check/time-of-use race: the row is one
  // thing when a caller reads it and another by the time its claim runs. Seeding
  // the final state up front cannot reach the post-claim code at all, because
  // the pre-claim guards answer first.
  beforeClaim: null as null | (() => void),
  afterRefundCreate: null as null | (() => Promise<void>),
  afterCompletionCas: null as null | (() => void),
  alerts: [] as Array<Record<string, unknown>>,
  terminalFailureWriteError: false,
  refundCreateError: null as unknown,
  paymentWriteError: false,
  paymentReadMissing: false,
  paymentReadError: false,
  paymentReadThrows: false,
}));

vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => db.livemode,
}));

vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (input: Record<string, unknown>) => { db.alerts.push(input); },
}));

vi.mock("@/lib/email/send-appointment", () => ({
  sendEmailSafely: async (opts: Record<string, unknown>) => {
    db.emails.push(opts);
    return db.sendResult;
  },
}));

vi.mock("@/lib/stripe/session-payment-stripe", () => ({
  getSessionPaymentStripe: () => ({
    refunds: {
      create: async (
        params: Record<string, unknown>,
        opts: Record<string, unknown>,
      ) => {
        db.stripeRefunds.push({ params, opts });
        db.afterRefund?.();
        const originalCharge = params.charge;
        const originalIntent = db.row.stripe_payment_intent_id;
        const callback = db.afterRefundCreate;
        db.afterRefundCreate = null;
        if (callback) await callback();
        if (db.refundCreateError) throw db.refundCreateError;
        // A real Refund states its amount and its charge's currency, and the
        // helper now refuses one that does not match the row (PAY-CCY-01).
        return {
          id: "re_1",
          status: db.refundProviderStatus,
          charge: originalCharge,
          payment_intent: originalIntent,
          amount: params.amount,
          currency: "cad",
          ...db.providerRefundOverrides,
        };
      },
    },
  }),
}));

/**
 * `col.op.value` terms joined by commas, as PostgREST spells an OR group.
 * The group matches when ANY term matches.
 */
function orMatches(row: Record<string, unknown>, expr: string): boolean {
  return expr.split(",").some((term) => {
    const [col, op, raw] = term.split(".");
    const val = raw === "null" ? null : raw;
    if (op !== "is" && op !== "eq") {
      throw new Error(`unsupported or-operator: ${term}`);
    }
    return row[col] === val;
  });
}

function allMatch(row: Record<string, unknown>, filters: Filter[]): boolean {
  return filters.every((f) =>
    f.kind === "or" ? orMatches(row, f.expr) : row[f.col] === f.val,
  );
}

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    async rpc(name: string, args: Record<string, unknown>) {
      if (name !== "reconcile_bound_payment_event") throw new Error(`unexpected RPC ${name}`);
      const object = args.p_object as Record<string, unknown>;
      if (args.p_event_type === "refund.observed" && db.paymentWriteError) {
        return { data: null, error: { code: "XX000" } };
      }
      const identityMatches = args.p_attempt_id === db.row.id && args.p_studio_id === db.row.studio_id
        && args.p_stripe_account_id === db.row.stripe_account_id && args.p_livemode === db.row.stripe_livemode
        && object.customer_id === db.row.stripe_customer_id && object.payment_intent_id === db.row.stripe_payment_intent_id
        && object.charge_id === db.row.stripe_charge_id && object.amount_cents === db.row.amount_cents
        && object.currency === db.row.currency && object.refund_amount_cents === db.row.amount_cents
        && object.refund_currency === db.row.currency && object.refund_charge_id === db.row.stripe_charge_id;
      if (!identityMatches) return { data: [{ result: "identity_mismatch" }], error: null };
      if (db.row.refund_status !== "pending_stripe") {
        db.writes.push({ patch: {}, matched: false });
        if (db.afterCompletionCas) {
          const hook = db.afterCompletionCas; db.afterCompletionCas = null; hook();
        }
        return { data: [{ result: "stale_observation" }], error: null };
      }
      // A synchronous action response has no signed event clock; it cannot
      // override a callback that arrived during the provider request. Full SQL
      // transition behavior remains prepared DB proof, not this fake's claim.
      if (db.row.stripe_refund_event_created !== null) {
        return { data: [{ result: "stale_observation" }], error: null };
      }
      const status = object.refund_status;
      const failed = status === "failed" || status === "canceled";
      const succeeded = status === "succeeded";
      const patch = {
        stripe_refund_id: object.refund_id, stripe_refund_status: status,
        refund_status: succeeded ? "succeeded" : failed ? "failed" : "pending_stripe",
        refunded_at: succeeded ? (db.row.refunded_at ?? new Date().toISOString()) : null,
        ...(object.evidence_kind === "signed_event" ? {
          stripe_refund_event_id: args.p_event_id, stripe_refund_event_created: object.event_created,
        } : {}),
        refund_failure_code: failed ? `provider_refund_${status}` : null,
        refund_failure_message_safe: failed ? "Stripe did not complete this refund." : null,
      };
      Object.assign(db.row, patch);
      db.writes.push({ patch, matched: true });
      return { data: [{ result: succeeded ? "reconciled" : failed ? "refund_failed" : "refund_pending" }], error: null };
    },
    from(table: string) {
      const filters: Filter[] = [];
      let op: "select" | "update" = "select";
      let patch: Record<string, unknown> = {};

      const q: Record<string, unknown> = {};
      let selected: string[] | null = null;
      q.select = (cols?: string) => {
        // PROJECTION IS MODELLED ON PURPOSE. PostgREST returns only the columns
        // asked for, so code that forgets one reads `undefined` rather than the
        // real value. A fake that hands back the whole row hides exactly that
        // class of bug -- and did, until a mutation control caught it.
        if (typeof cols === "string" && cols !== "id" && cols.includes(",")) {
          selected = cols.split(",").map((c) => c.trim());
        }
        return q;
      };
      q.update = (p: Record<string, unknown>) => {
        op = "update";
        patch = p;
        return q;
      };
      q.eq = (col: string, val: unknown) => {
        filters.push({ kind: "eq", col, val });
        return q;
      };
      q.is = (col: string, val: unknown) => {
        filters.push({ kind: "is", col, val });
        return q;
      };
      q.or = (expr: string) => {
        filters.push({ kind: "or", expr });
        return q;
      };

      // A conditional UPDATE: evaluate against the row as it is NOW, then write.
      // Evaluation and write are one step, which is the whole point -- it is what
      // makes two claims on the same row mutually exclusive.
      const settleUpdate = () => {
        if (db.beforeClaim) {
          const hook = db.beforeClaim;
          db.beforeClaim = null; // once, so the loser's own claim is not re-raced
          hook();
        }
        if (db.terminalFailureWriteError && patch.refund_status === "failed") {
          return { data: null, error: { code: "XX000" } };
        }
        if (db.paymentWriteError && patch.refund_status === "succeeded") {
          return { data: null, error: { code: "XX000" } };
        }
        const matched = table === "payment_charge_attempts" && allMatch(db.row, filters);
        if (matched) Object.assign(db.row, patch);
        db.writes.push({ patch, matched });
        return { data: matched ? [{ id: db.row.id }] : [], error: null };
      };

      const project = (row: Record<string, unknown>) => {
        if (!selected) return { ...row };
        const out: Record<string, unknown> = {};
        for (const c of selected) out[c] = row[c];
        return out;
      };

      q.maybeSingle = async () => {
        if (table === "payment_charge_attempts") {
          if (db.paymentReadThrows) throw new Error("synthetic private reread failure");
          return { data: db.paymentReadError || db.paymentReadMissing ? null : project(db.row), error: db.paymentReadError ? { code: "XX000" } : null };
        }
        return db.aux[table] ?? { data: null, error: null };
      };
      // `select("id")` terminates an update chain and is awaited directly.
      q.then = (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) => {
        const settle = async () => {
          if (op === "update") {
            if (db.delayBeforeClaimMs > 0) {
              await new Promise((r) => setTimeout(r, db.delayBeforeClaimMs));
            }
            return settleUpdate();
          }
          if (table === "payment_charge_attempts") {
            return { data: [{ ...db.row }], error: null };
          }
          return db.aux[table] ?? { data: null, error: null };
        };
        return settle().then(resolve, reject);
      };
      return q;
    },
  }),
}));

import { refundPaymentChargeAttempt } from "@/lib/billing/payment-refund";
import { sendPaymentChargeReceipt } from "@/lib/billing/payment-receipt";

const ATTEMPT = "att-1";
const STUDIO = "studio-1";
const CLIENT = "client-1";

function seedRow(over: Record<string, unknown> = {}) {
  db.row = {
    id: ATTEMPT,
    studio_id: STUDIO,
    client_id: CLIENT,
    charge_reason: "session_payment",
    status: "succeeded",
    amount_cents: 6000,
    currency: "cad",
    stripe_livemode: true,
    stripe_account_id: "acct_1",
    stripe_customer_id: "cus_1",
    stripe_payment_intent_id: "pi_live_1",
    stripe_charge_id: "ch_live_1",
    charged_at: "2026-08-14T10:00:00.000Z",
    client_payment_method_id: "cpm-1",
    refund_status: null,
    refund_amount_cents: null,
    refunded_at: null,
    stripe_refund_id: null,
    stripe_refund_status: null,
    stripe_refund_event_created: null,
    stripe_refund_event_id: null,
    receipt_status: null,
    receipt_sent_at: null,
    receipt_email_to: null,
    ...over,
  };
}

beforeEach(() => {
  db.livemode = true;
  db.refundProviderStatus = "succeeded";
  db.afterRefund = null;
  db.providerRefundOverrides = {};
  db.writes = [];
  db.emails = [];
  db.stripeRefunds = [];
  db.sendResult = { ok: true };
  db.delayBeforeClaimMs = 0;
  db.beforeClaim = null;
  db.afterRefundCreate = null;
  db.afterCompletionCas = null;
  db.terminalFailureWriteError = false;
  db.refundCreateError = null;
  db.paymentWriteError = false;
  db.paymentReadMissing = false;
  db.paymentReadError = false;
  db.paymentReadThrows = false;
  db.alerts = [];
  db.aux = {
    practitioners: { data: { role: "owner" }, error: null },
    clients: {
      data: { id: CLIENT, studio_id: STUDIO, name: "A", email: "c@example.com" },
      error: null,
    },
    studios: {
      data: {
        id: STUDIO,
        name: "Willow",
        owner_email: "o@example.com",
        postcare_contact_email: null,
      },
      error: null,
    },
    client_payment_methods: { data: { last4: "4242" }, error: null },
  };
  seedRow();
});

afterEach(() => {
  vi.clearAllMocks();
});

const refund = () =>
  refundPaymentChargeAttempt({
    attemptId: ATTEMPT,
    studioId: STUDIO,
    practitionerId: "p-1",
  });

const receiptAutomatic = () =>
  sendPaymentChargeReceipt({
    attemptId: ATTEMPT,
    studioId: STUDIO,
    practitionerId: "p-1",
    claimPolicy: "automatic",
  });

const receiptManual = () =>
  sendPaymentChargeReceipt({
    attemptId: ATTEMPT,
    studioId: STUDIO,
    practitionerId: "p-1",
  });

// ---------------------------------------------------------------------------

describe("M: receipt-first — the ordering the first fix left open", () => {
  it("M1 a receipt holding the row blocks the refund claim entirely", async () => {
    // The receipt wins the row first and is mid-dispatch.
    seedRow({ receipt_status: "sending" });

    const res = await refund();

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.outcome).toBe("claim_lost");
    // The decisive assertion: Stripe was never asked to refund. Before the
    // reciprocal predicate this call went through.
    expect(db.stripeRefunds).toHaveLength(0);
    // And the row was not moved to pending_stripe by the losing claim.
    expect(db.row.refund_status).toBeNull();
  });

  it("M1b the claim-lost message does not blame a refund that does not exist", async () => {
    seedRow({ receipt_status: "sending" });
    const res = await refund();
    const msg = res.ok === false ? res.message : "";
    // The competitor here is a RECEIPT. Telling the practitioner another refund
    // is in flight would send them hunting for something that never existed.
    expect(msg).not.toMatch(/another refund attempt is already in flight/i);
    expect(msg).toMatch(/receipt/i);
    expect(msg).toMatch(/refresh/i);
  });

  it("M2 the full sequence: receipt claims, refund refused, one email and no refund", async () => {
    const receiptRes = await receiptAutomatic();
    expect(receiptRes.ok).toBe(true);
    expect(db.emails).toHaveLength(1);
    expect(db.row.receipt_status).toBe("sent");

    // A refund started after the receipt completed is fine -- see M3.
    // Here we prove the mid-flight window by rewinding to 'sending'.
    seedRow({ receipt_status: "sending" });
    const refundRes = await refund();
    expect(refundRes.ok === false && refundRes.outcome).toBe("claim_lost");
    expect(db.stripeRefunds).toHaveLength(0);
  });
});

describe("M: refund-first — the ordering the first fix closed, still closed", () => {
  it("M3 a refund in flight blocks the automatic receipt claim", async () => {
    seedRow({ refund_status: "pending_stripe" });

    const res = await receiptAutomatic();

    expect(res.ok).toBe(false);
    expect(db.emails).toHaveLength(0);
    expect(db.row.receipt_status).toBeNull();
  });

  it("M3b a refund that already SUCCEEDED also blocks the automatic receipt", async () => {
    seedRow({ refund_status: "succeeded", refunded_at: "2026-08-14T11:00:00.000Z" });

    const res = await receiptAutomatic();

    expect(res.ok).toBe(false);
    expect(db.emails).toHaveLength(0);
  });

  it("M3c a FAILED refund also blocks it — the admissible set is NULL only", async () => {
    // Deliberate: a failed refund is a charge an operator is actively working
    // on. The automatic sender is not the right thing to fire into that.
    seedRow({ refund_status: "failed" });

    const res = await receiptAutomatic();

    expect(res.ok).toBe(false);
    expect(db.emails).toHaveLength(0);
  });
});

describe("M: the refund's admissible receipt set, state by state", () => {
  it("M4 receipt_status='sent' permits the refund", async () => {
    seedRow({ receipt_status: "sent", receipt_sent_at: "2026-08-14T10:00:05.000Z" });

    const res = await refund();

    expect(res.ok).toBe(true);
    expect(db.stripeRefunds).toHaveLength(1);
    expect(db.row.refund_status).toBe("succeeded");
  });

  it("M5 receipt_status='failed' permits the refund", async () => {
    // Nothing is dispatching. Refusing here would strand refundable money
    // behind a receipt that already gave up.
    seedRow({ receipt_status: "failed" });

    const res = await refund();

    expect(res.ok).toBe(true);
    expect(db.stripeRefunds).toHaveLength(1);
  });

  it("M5b receipt_status NULL permits the refund (the ordinary case)", async () => {
    const res = await refund();

    expect(res.ok).toBe(true);
    expect(db.stripeRefunds).toHaveLength(1);
  });

  it("M5c an unrecognised receipt state is REFUSED, not admitted", async () => {
    // Fail-closed. The predicate is an explicit admissible set, so a state
    // introduced by some later PR blocks refunds until someone decides it is
    // safe -- the opposite of what `!= 'sending'` would do here.
    seedRow({ receipt_status: "queued_for_retry" });

    const res = await refund();

    expect(res.ok === false && res.outcome).toBe("claim_lost");
    expect(db.stripeRefunds).toHaveLength(0);
  });
});

describe("M: the ambiguous-delivery HOLD keeps blocking refunds", () => {
  it("M6 a held ambiguous receipt claim refuses the refund", async () => {
    // The provider failed in a way that leaves delivery UNKNOWN, so the receipt
    // deliberately HOLDS the row at 'sending' instead of releasing it. That hold
    // must keep refunds out: the client may well be holding a receipt.
    db.sendResult = {
      ok: false,
      retryable: true,
      error: "Resend timeout after 10000ms",
    };

    const receiptRes = await receiptAutomatic();
    expect(receiptRes.ok).toBe(false);
    // The hold: still 'sending', not released to null.
    expect(db.row.receipt_status).toBe("sending");

    const refundRes = await refund();
    expect(refundRes.ok === false && refundRes.outcome).toBe("claim_lost");
    expect(db.stripeRefunds).toHaveLength(0);
  });

  it("M6b a definitive pre-dispatch failure releases, and the refund may proceed", async () => {
    // The contrast case. A PDF/recipient/config failure means nothing was ever
    // dispatched, the claim is released, and there is no reason to hold money.
    seedRow({ receipt_status: "failed" });

    const res = await refund();

    expect(res.ok).toBe(true);
    expect(db.stripeRefunds).toHaveLength(1);
  });
});

describe("M: true concurrency — never both, whichever arrives first", () => {
  for (const first of ["refund", "receipt"] as const) {
    it(`M7 ${first} first: exactly one side acts, the other is refused`, async () => {
      const both =
        first === "refund"
          ? ([refund(), receiptAutomatic()] as const)
          : ([receiptAutomatic(), refund()] as const);

      const [a, b] = await Promise.all(both);
      const refundRes = first === "refund" ? a : b;
      const receiptRes = first === "refund" ? b : a;

      // THE INVARIANT. Whatever the interleaving, the row cannot have been
      // claimed by both, so Hone never both emails a receipt and refunds.
      const acted = db.stripeRefunds.length + db.emails.length;
      expect(acted).toBe(1);
      expect([refundRes.ok, receiptRes.ok].filter(Boolean)).toHaveLength(1);

      // Exactly one claim matched; the loser's claim wrote nothing.
      const claims = db.writes.filter(
        (w) =>
          w.patch.refund_status === "pending_stripe" ||
          w.patch.receipt_status === "sending",
      );
      expect(claims).toHaveLength(2);
      expect(claims.filter((c) => c.matched)).toHaveLength(1);
    });
  }
});

describe("M: manual receipt policy is NOT changed by any of this", () => {
  it("M8 a manual receipt may still claim a 'failed' row", async () => {
    // Manual send remains deliberately NOT refund-gated: a practitioner who
    // clicks Send is making an informed decision the automatic sender cannot.
    seedRow({ receipt_status: "failed" });

    const res = await receiptManual();

    expect(res.ok).toBe(true);
    expect(db.emails).toHaveLength(1);
  });

  it("M8b a manual receipt is still permitted while a refund is in flight", async () => {
    seedRow({ refund_status: "pending_stripe" });

    const res = await receiptManual();

    expect(res.ok).toBe(true);
    expect(db.emails).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// R1. The automatic claim-loser must say WHY it lost.
//
// The re-read used to select only the receipt_* columns, so a claim refused by
// the refund predicate was indistinguishable from one refused because another
// sender held the row -- and every such loser was reported as `in_flight`. That
// was false twice: no send was in flight, and none could start, because the
// automatic claim requires `refund_status IS NULL` and a refund_status does not
// return to NULL on its own.
//
// These run against the shared row, so the reason is derived from real state
// rather than from a scripted response.
// ---------------------------------------------------------------------------

describe("R1 — an automatic claim refused by refund activity", () => {
  for (const refundStatus of ["pending_stripe", "succeeded", "failed"] as const) {
    it(`R1.${refundStatus} -> blocked_by_refund, and nothing is sent`, async () => {
      seedRow({ refund_status: refundStatus });

      const res = await receiptAutomatic();

      expect(res.ok).toBe(false);
      expect(res.ok === false && res.reason).toBe("blocked_by_refund");
      expect(db.emails).toHaveLength(0);
      // The claim was refused, so the row was not taken.
      expect(db.row.receipt_status).toBeNull();
    });
  }

  it("R1.failed — a FAILED refund blocks it too, and does not resume later", async () => {
    // The policy is about refund ACTIVITY existing, not about how the refund
    // turned out. A failed refund leaves a charge someone is actively working
    // on; whether a receipt is still right is a person's call.
    seedRow({ refund_status: "failed" });

    const first = await receiptAutomatic();
    expect(first.ok === false && first.reason).toBe("blocked_by_refund");

    // A second automatic attempt reaches the same conclusion. There is no
    // automatic recovery path out of this state, by design.
    const second = await receiptAutomatic();
    expect(second.ok === false && second.reason).toBe("blocked_by_refund");
    expect(db.emails).toHaveLength(0);
  });

  it("R1.manual — manual recovery is still available on that same row", async () => {
    // The whole point of suppressing the automatic path rather than the manual
    // one: the decision moves to a person, it does not disappear.
    seedRow({ refund_status: "failed" });

    expect((await receiptAutomatic()).ok).toBe(false);
    const manual = await receiptManual();

    expect(manual.ok).toBe(true);
    expect(db.emails).toHaveLength(1);
  });

  it("R1.message — it does not claim an email is in flight", async () => {
    seedRow({ refund_status: "pending_stripe" });
    const res = await receiptAutomatic();
    const msg = res.ok === false ? res.message : "";

    expect(msg).not.toMatch(/in flight/i);
    expect(msg).toMatch(/refund activity/i);
    expect(msg).toMatch(/manually/i);
  });

  it("R1.4 receipt_status='sending' still reports in_flight", async () => {
    // The control that keeps the new branch honest: a row genuinely held by
    // another sender IS in flight, and must not be relabelled.
    seedRow({ receipt_status: "sending" });

    const res = await receiptAutomatic();

    expect(res.ok === false && res.reason).toBe("in_flight");
    expect(db.emails).toHaveLength(0);
  });

  it("R1.4b 'sending' wins even when a refund also exists", async () => {
    // Both conditions hold. `sending` is the more specific and more urgent
    // fact -- an email may be in the wild -- so it must not be masked.
    seedRow({ receipt_status: "sending", refund_status: "pending_stripe" });

    const res = await receiptAutomatic();

    expect(res.ok === false && res.reason).toBe("in_flight");
  });

  it("R1.5 receipt_status='sent' still reports already_sent", async () => {
    seedRow({ receipt_status: "sent", receipt_sent_at: "2026-08-14T10:00:05.000Z" });

    const res = await receiptAutomatic();

    expect(res.ok === false && res.reason).toBe("already_sent");
    expect(db.emails).toHaveLength(0);
  });

  it("R1.5b 'sent' wins over a refund too", async () => {
    seedRow({
      receipt_status: "sent",
      receipt_sent_at: "2026-08-14T10:00:05.000Z",
      refund_status: "succeeded",
    });

    const res = await receiptAutomatic();

    expect(res.ok === false && res.reason).toBe("already_sent");
  });

  it("R1.manual-unchanged — a MANUAL loser is never told blocked_by_refund", async () => {
    // Manual is not refund-gated, so a manual claim cannot lose on account of a
    // refund. Reporting that reason would be a fresh falsehood in place of the
    // one being removed.
    seedRow({ receipt_status: "sending", refund_status: "pending_stripe" });

    const res = await receiptManual();

    expect(res.ok === false && res.reason).toBe("in_flight");
  });
});

// ---------------------------------------------------------------------------
// R1, the TRUE races. The tests above seed the final state, which the PRE-claim
// guards answer before the claim ever runs -- so they pin the observable
// outcome but never reach the post-claim classification. These use beforeClaim
// to move the row between the caller's read and its claim, which is the only
// interleaving that exercises that code.
// ---------------------------------------------------------------------------

describe("R1 — the post-claim classification, reached by a real race", () => {
  it("a refund that starts between the read and the claim -> blocked_by_refund", async () => {
    // Row is clean when the automatic sender reads it. A refund claims it in
    // the gap. The claim then matches zero rows, and the re-read has to explain
    // why -- which it can only do if it selected refund_status.
    db.beforeClaim = () => {
      db.row.refund_status = "pending_stripe";
    };

    const res = await receiptAutomatic();

    expect(res.ok === false && res.reason).toBe("blocked_by_refund");
    expect(db.emails).toHaveLength(0);
    expect(res.ok === false && res.message).not.toMatch(/in flight/i);
  });

  it("another sender that wins in the same gap -> in_flight, not blocked", async () => {
    // Both facts are true of the row by the time we re-read it. `sending` is
    // the more specific and more urgent one: an email may already be in the
    // wild, and telling an operator "refund activity" would bury that.
    db.beforeClaim = () => {
      db.row.receipt_status = "sending";
      db.row.refund_status = "pending_stripe";
    };

    const res = await receiptAutomatic();

    expect(res.ok === false && res.reason).toBe("in_flight");
  });

  it("a sender that COMPLETED in the gap -> already_sent", async () => {
    db.beforeClaim = () => {
      db.row.receipt_status = "sent";
      db.row.receipt_sent_at = "2026-08-14T10:00:05.000Z";
      db.row.receipt_email_to = "c@example.com";
      db.row.refund_status = "succeeded";
    };

    const res = await receiptAutomatic();

    expect(res.ok === false && res.reason).toBe("already_sent");
    expect(res.ok === false && res.emailTo).toBe("c@example.com");
  });

  it("MANUAL loses the same race and is still never told blocked_by_refund", async () => {
    db.beforeClaim = () => {
      db.row.receipt_status = "sending";
      db.row.refund_status = "pending_stripe";
    };

    const res = await receiptManual();

    expect(res.ok === false && res.reason).toBe("in_flight");
  });
});

// PAY-002: a returned Refund object is not proof that money was returned.
describe("PAY-002 provider refund status", () => {
  it.each(["pending", "requires_action", "failed", "canceled", null])(
    "does not complete a refund whose provider status is %s",
    async (status) => {
      db.refundProviderStatus = status;
      const result = await refund();
      expect(result.ok).toBe(false);
      expect(db.row.refund_status).not.toBe("succeeded");
      expect(db.row.refunded_at).toBeNull();
      expect(db.stripeRefunds).toHaveLength(1);
      expect(db.emails).toHaveLength(0);
      expect(db.row.stripe_refund_id).toBe("re_1");
      expect(db.row.stripe_refund_status).toBe(status);
      expect(db.row.refund_status).toBe(status === "failed" || status === "canceled" ? "failed" : "pending_stripe");
      if (status !== "failed" && status !== "canceled") {
        // The unresolved claim must refuse a second provider request.
        const retry = await refund();
        expect(retry.ok).toBe(false);
        expect(db.stripeRefunds).toHaveLength(1);
      }
    },
  );
  it("does not overwrite or report completion after losing the outcome write", async () => {
    db.refundProviderStatus = "pending";
    db.afterRefund = () => { db.row.refund_status = "succeeded"; };
    const result = await refund();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.outcome).toBe("needs_manual_review");
    expect(db.row.stripe_refund_id).toBeNull();
    expect(db.row.refunded_at).toBeNull();
    expect(db.stripeRefunds).toHaveLength(1);
    expect(db.writes.at(-1)?.matched).toBe(false);
  });
  it.each([{ charge: "ch_other" }, { payment_intent: "pi_other" }, { customer: "cus_other" }])("refuses a returned refund for another provider object: %j", async (provider) => {
    db.providerRefundOverrides = provider;
    const result = await refund();
    expect(result.ok).toBe(false);
    expect(db.row.refund_status).toBe("pending_stripe");
    expect(db.row.refunded_at).toBeNull();
    expect(db.row.stripe_refund_id).toBeNull();
  });
  it("refuses before asking Stripe when the original customer is missing", async () => {
    db.row.stripe_customer_id = null;
    expect((await refund()).ok).toBe(false);
    expect(db.stripeRefunds).toHaveLength(0);
  });
  it("still records a genuinely succeeded provider refund", async () => {
    const result = await refund();
    expect(result.ok).toBe(true);
    expect(db.row.refund_status).toBe("succeeded");
    expect(db.row.stripe_refund_id).toBe("re_1");
    expect(db.stripeRefunds).toHaveLength(1);
  });
});

// PRIVACY-PAY002-TERMINAL-RETRY-01: an actual provider object is not a free retry slot.
describe("PAY-002 recorded refund retry evidence", () => {
  it.each(["failed", "canceled", null])("retains an existing provider object (%s) without claiming or calling Stripe", async (status) => {
    seedRow({ refund_status: "failed", stripe_refund_id: "re_recorded",
      stripe_refund_status: status, stripe_refund_event_created: status ? 1770000000 : null,
      stripe_refund_event_id: status ? "evt_recorded_failure" : null });
    const before = { ...db.row };
    expect((await refund()).ok).toBe(false);
    expect(db.stripeRefunds).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
    expect(db.row).toEqual(before);
  });
  it("a terminal event winning after the read prevents the atomic claim and provider call", async () => {
    seedRow({ refund_status: "failed", stripe_refund_status: null, stripe_refund_event_created: null, stripe_refund_event_id: null });
    const evidence = { refund_status: "failed", stripe_refund_status: "failed", stripe_refund_id: "re_race",
      stripe_refund_event_created: 1770000001, stripe_refund_event_id: "evt_race_failure" };
    db.beforeClaim = () => { Object.assign(db.row, evidence); };
    expect((await refund()).ok).toBe(false);
    expect(db.stripeRefunds).toHaveLength(0);
    expect(db.writes.filter((write) => write.matched)).toHaveLength(0);
    expect(db.row).toMatchObject(evidence);
  });
  it("a legacy local failure with no provider object or evidence retains its existing retry", async () => {
    seedRow({ refund_status: "failed", stripe_refund_status: null, stripe_refund_event_created: null, stripe_refund_event_id: null });
    expect((await refund()).ok).toBe(true);
    expect(db.stripeRefunds).toHaveLength(1);
    expect(db.row.stripe_refund_id).toBe("re_1");
  });
});

describe("PAY-002 recorded evidence during provider response", () => {
  it("a terminal SDK error cannot erase a concurrent signed refund object or claim failure certainty", async () => {
    const evidence = { refund_status: "pending_stripe", stripe_refund_status: "pending", stripe_refund_id: "re_concurrent",
      stripe_refund_event_created: 1770000002, stripe_refund_event_id: "evt_concurrent" };
    db.afterRefund = () => {
      Object.assign(db.row, evidence);
      throw new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: "synthetic refusal" });
    };
    const result = await refund();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.outcome).toBe("needs_manual_review");
    expect(db.row).toMatchObject(evidence);
    expect(db.stripeRefunds).toHaveLength(1);
    expect(db.writes.at(-1)?.matched).toBe(false);
  });
});


// The callback executes the REAL existing webhook handler while the refund
// request awaits its fake SDK response. It wins the terminal row before the
// action's conditional completion, not merely before the action initially reads.
describe("refund callback completion wins before action persistence", () => {
  async function completeByCallback() {
  const result = await handleChargeRefunded({
    id: "evt_refund_race", created: 1786701605, type: "charge.refunded", account: "acct_1", livemode: true,
    data: { object: {
      id: "ch_live_1", payment_intent: "pi_live_1", customer: "cus_1",
      amount: 6000, currency: "cad", refunded: true, amount_refunded: 6000,
      refunds: { data: [{ id: "re_1", object: "refund", status: "succeeded", amount: 6000, currency: "cad", charge: "ch_live_1", payment_intent: "pi_live_1" }] },
      metadata: { hone_payment_charge_attempt_id: ATTEMPT, hone_studio_id: STUDIO,
        hone_client_id: CLIENT, hone_charge_reason: "session_payment" },
    } },
  } as unknown as Stripe.Event, { studioId: STUDIO, stripeAccountId: "acct_1", livemode: true });
  expect(result.reconciledFromPending).toBe(true);
  }
  it("reports the identical persisted refund without a false critical or second effect", async () => {
    let callbackRow: Record<string, unknown> | null = null;
    db.afterRefundCreate = async () => {
      await completeByCallback();
      callbackRow = { ...db.row };
    };
    const result = await refund();
    expect(callbackRow).not.toBeNull();
    expect(result).toMatchObject({ ok: true, outcome: "succeeded", stripeRefundId: "re_1", refundAmountCents: 6000 });
    expect(result.ok && result.refundedAt).toBe(callbackRow!.refunded_at);
    expect(db.row).toEqual(callbackRow);
    expect(db.stripeRefunds).toHaveLength(1);
    expect(db.emails).toEqual([]);
    expect(db.alerts).toEqual([]);
    expect(db.writes.filter(({ matched }) => !matched)).toHaveLength(1);
  });

  it.each([
    ["attempt", { id: "att-other" }], ["studio", { studio_id: "studio-other" }],
    ["client", { client_id: "client-other" }], ["reason", { charge_reason: "late_cancel_fee" }],
    ["account", { stripe_account_id: "acct_other" }], ["customer", { stripe_customer_id: "cus_other" }],
    ["PI", { stripe_payment_intent_id: "pi_other" }], ["charge", { stripe_charge_id: "ch_other" }],
    ["mode", { stripe_livemode: false }], ["money", { amount_cents: 5999 }],
    ["currency", { currency: "usd" }], ["payment terminal state", { status: "failed" }],
    ["refund terminal state", { refund_status: "failed" }],
    ["another Refund", { stripe_refund_id: "re_other" }],
    ["refund amount", { refund_amount_cents: 5999 }],
    ["missing completion", { refunded_at: null }], ["invalid completion", { refunded_at: "invalid" }],
    ["failure evidence", { refund_failure_code: "provider_failed" }],
    ["failure message", { refund_failure_message_safe: "Retained failure" }],
    ["charge timestamp", { charged_at: "2026-08-15T00:00:00.000Z" }],
    ["missing Refund", { stripe_refund_id: null }],
    ["pending terminal state", { refund_status: "pending_stripe" }],
    ["cancelled payment", { status: "cancelled" }],
    ["blocked payment", { status: "blocked" }],
    ["missing customer", { stripe_customer_id: null }],
  ])("does not call a different %s a benign callback winner", async (_label, changed) => {
    db.afterRefundCreate = async () => { await completeByCallback(); db.afterCompletionCas = () => { Object.assign(db.row, changed); }; };
    const result = await refund();
    expect(result).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(db.stripeRefunds).toHaveLength(1);
    expect(db.alerts).toEqual([expect.objectContaining({ severity: "critical", event: "payment_refund_outcome_write_refused" })]);
    expect(db.emails).toEqual([]);
  });
  it.each(["error", "throw", "missing"])("an unreadable callback winner (%s) stays critical/manual review", async (mode) => {
    db.afterRefundCreate = async () => {
      await completeByCallback();
      db.paymentReadError = mode === "error"; db.paymentReadThrows = mode === "throw";
      db.paymentReadMissing = mode === "missing";
    };
    expect(await refund()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(db.stripeRefunds).toHaveLength(1);
    expect(db.alerts).toEqual([expect.objectContaining({ severity: "critical", event: "payment_refund_outcome_write_refused" })]);
    expect(JSON.stringify(db.alerts)).not.toContain("synthetic private reread failure");
  });
  it("a write error stays critical even when the callback saved an identical outcome", async () => {
    db.afterRefundCreate = async () => { await completeByCallback(); db.paymentWriteError = true; };
    expect(await refund()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
    expect(db.row.refund_status).toBe("succeeded");
    expect(db.stripeRefunds).toHaveLength(1);
    expect(db.alerts).toEqual([expect.objectContaining({ severity: "critical", event: "payment_refund_outcome_write_refused" })]);
    expect(db.emails).toEqual([]);
  });
  it("a later action sees already refunded and creates no second refund", async () => {
    db.afterRefundCreate = completeByCallback;
    expect(await refund()).toMatchObject({ ok: true, outcome: "succeeded" });
    expect(await refund()).toMatchObject({ ok: false, outcome: "already_refunded" });
    expect(db.stripeRefunds).toHaveLength(1);
    expect(db.alerts).toEqual([]);
  });
  describe("refund terminal-error persistence", () => {
    const refusal = () => new Stripe.errors.StripeInvalidRequestError({ message: "synthetic processor refusal", code: "charge_already_refunded" });
    it("retains callback completion and reports manual review instead of an unpersisted failure", async () => {
      let callbackRow: Record<string, unknown> | null = null;
      db.afterRefundCreate = async () => { await completeByCallback(); callbackRow = { ...db.row }; };
      db.refundCreateError = refusal();
      expect(await refund()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
      expect(db.row).toEqual(callbackRow);
      expect(db.row).toMatchObject({ refund_status: "succeeded", stripe_refund_id: "re_1" });
      expect(db.stripeRefunds).toHaveLength(1);
      expect(db.emails).toEqual([]);
      expect(db.alerts).toEqual([expect.objectContaining({ severity: "critical", event: "payment_refund_failed_write_failed" })]);
    });
    it("a database error cannot claim that the failed outcome was saved", async () => {
      db.refundCreateError = refusal();
      db.terminalFailureWriteError = true;
      expect(await refund()).toMatchObject({ ok: false, outcome: "needs_manual_review" });
      expect(db.row).toMatchObject({ refund_status: "pending_stripe", stripe_refund_id: null });
      expect(db.stripeRefunds).toHaveLength(1);
      expect(db.alerts).toEqual([expect.objectContaining({ severity: "critical", event: "payment_refund_failed_write_failed" })]);
      expect(db.emails).toEqual([]);
    });
    it("a genuinely persisted processor refusal still reports failed", async () => {
      db.refundCreateError = refusal();
      expect(await refund()).toMatchObject({ ok: false, outcome: "failed", failureCode: "charge_already_refunded" });
      expect(db.row).toMatchObject({ refund_status: "failed", refund_failure_code: "charge_already_refunded" });
      expect(db.stripeRefunds).toHaveLength(1);
      expect(db.alerts).toEqual([expect.objectContaining({ severity: "warning", event: "payment_refund_failed" })]);
      expect(db.emails).toEqual([]);
    });
  });

});
