import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PAY-RECEIPT-01. Receipt outcome persistence / permanent "sending" recovery.
//
// THE DEFECT. The two settlement writes that record a FAILED send discarded
// their PostgREST error entirely (no `const { error }` at all):
//
//   retryable -> UPDATE receipt_status = null      (release the claim)
//   terminal  -> UPDATE receipt_status = 'failed'  (park for the operator)
//
// If either write fails, the row stays at receipt_status='sending'. The claim
// predicate admits ONLY (null, 'failed'), and ReceiptSubPanel hides the Send
// button whenever receipt_status is 'sending' -- so the receipt becomes
// PERMANENTLY UNRETRYABLE through the normal path, while the helper still
// returned send_failed_retryable ("Try again in a moment"): advice that can
// never succeed.
//
// THE DISTINCTION THAT MUST SURVIVE. Provider-success + DB-failure
// (`sent_but_record_update_failed`, PR #175) is NOT the same as provider
// failure. There an email IS in the wild and the instruction is "do not send
// again". Collapsing the two would re-open exactly what PR #175 closed, so
// these tests pin them apart.
//
// THE MOCK DISCRIMINATES EVERY STATEMENT. A mock that replays one scripted
// response per table cannot express "the claim succeeded but the release
// failed", which is the entire defect. This one keys on
// (table, op, receipt_status payload) so a failure can be injected at exactly
// one statement and nowhere else, and it records every statement in order so
// the tests can assert what did and did not run.

type Stmt = {
  isReread?: boolean;
  key: string;
  table: string;
  op: "select" | "update";
  payload?: Record<string, unknown>;
  filters: Array<[string, unknown]>;
};

const h = vi.hoisted(() => ({
  livemode: true,
  // key -> { data, error }
  responses: {} as Record<string, { data: unknown; error: unknown }>,
  stmts: [] as Array<{
    key: string;
    table: string;
    op: string;
    payload?: Record<string, unknown>;
    filters: Array<[string, unknown]>;
  }>,
  alerts: [] as Array<Record<string, unknown>>,
  sends: [] as Array<Record<string, unknown>>,
  sendResult: { ok: true } as Record<string, unknown>,
}));

vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => h.livemode,
}));

vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: async (a: Record<string, unknown>) => {
    h.alerts.push(a);
  },
}));

vi.mock("@/lib/email/send-appointment", () => ({
  sendEmailSafely: async (opts: Record<string, unknown>) => {
    h.sends.push(opts);
    return h.sendResult;
  },
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const st: Stmt = { key: "", table, op: "select", filters: [] };
      const q: Record<string, unknown> = {};
      const settle = () => {
        // Statement identity:
        //   update -> the receipt_status it is trying to write
        //   select -> the table (the two attempt selects are told apart by
        //             the narrow re-read column list)
        if (st.op === "update") {
          st.key = `${table}:update:${String(st.payload?.receipt_status)}`;
        } else if (st.isReread) {
          st.key = `${table}:reread`;
        } else {
          st.key = `${table}:select`;
        }
        h.stmts.push({ ...st });
        return (
          h.responses[st.key] ?? { data: st.op === "update" ? [] : null, error: null }
        );
      };
      q.select = (cols?: string) => {
        if (st.op === "select" && typeof cols === "string" && cols.startsWith("receipt_status,")) {
          st.key = "reread";
        }
        // MARK THE STATEMENT, do not return a divergent object.
        //
        // This used to hand back `{ ...q }` with its own `maybeSingle`, but
        // `q.eq()` returns the ORIGINAL `q` — so `.select(...).eq(...).maybeSingle()`
        // silently landed on the default handler and the configured re-read
        // response was never used. Every claim-loser test therefore passed on the
        // null fallback, which reports `in_flight` — including the one meant to
        // prove `already_sent`. A fixture that is never read is a test that
        // proves nothing.
        if (st.op === "select" && st.key === "reread") {
          st.isReread = true;
        }
        return q;
      };
      q.update = (payload: Record<string, unknown>) => {
        st.op = "update";
        st.payload = payload;
        return q;
      };
      q.eq = (col: string, val: unknown) => {
        st.filters.push([col, val]);
        return q;
      };
      q.or = (expr: string) => {
        st.filters.push(["__or__", expr]);
        return q;
      };
      q.is = (col: string, val: unknown) => {
        // RECORDED, so the claim POLICY can be asserted directly. Without this
        // the automatic NULL-only claim was untestable: an early return for a
        // `failed` row short-circuits before the claim query, so widening the
        // query changed no observable outcome and a mutation of it went unnoticed.
        st.filters.push([col, val === null ? "__is_null__" : val]);
        return q;
      };
      q.order = () => q;
      q.maybeSingle = async () => settle();
      q.then = (resolve: (v: unknown) => unknown) => resolve(settle());
      return q;
    },
  }),
}));

import { sendPaymentChargeReceipt } from "@/lib/billing/payment-receipt";

const ATTEMPT = "att-1";
const STUDIO = "studio-1";
const CLIENT = "client-1";

function succeededAttempt(receiptStatus: string | null) {
  return {
    id: ATTEMPT,
    studio_id: STUDIO,
    client_id: CLIENT,
    charge_reason: "session_payment",
    amount_cents: 6000,
    currency: "cad",
    status: "succeeded",
    stripe_livemode: true,
    stripe_payment_intent_id: "pi_live_1",
    stripe_charge_id: "ch_live_1",
    charged_at: "2026-08-14T10:00:00.000Z",
    client_payment_method_id: "cpm-1",
    receipt_status: receiptStatus,
    receipt_sent_at: null,
    receipt_email_to: null,
  };
}

function baseline(receiptStatus: string | null = null) {
  h.livemode = true;
  h.stmts = [];
  h.alerts = [];
  h.sends = [];
  h.sendResult = { ok: true };
  h.responses = {
    "payment_charge_attempts:select": { data: succeededAttempt(receiptStatus), error: null },
    clients: { data: { id: CLIENT, studio_id: STUDIO, name: "A", email: "c@example.com" }, error: null },
    "clients:select": { data: { id: CLIENT, studio_id: STUDIO, name: "A", email: "c@example.com" }, error: null },
    "studios:select": { data: { id: STUDIO, name: "Willow", owner_email: "o@example.com", postcare_contact_email: null }, error: null },
    "client_payment_methods:select": { data: { last4: "4242" }, error: null },
    // claim: one row updated
    "payment_charge_attempts:update:sending": { data: [{ id: ATTEMPT }], error: null },
    "payment_charge_attempts:update:sent": { data: [{ id: ATTEMPT }], error: null },
    "payment_charge_attempts:update:null": { data: [{ id: ATTEMPT }], error: null },
    "payment_charge_attempts:update:failed": { data: [{ id: ATTEMPT }], error: null },
  };
}

const run = () =>
  sendPaymentChargeReceipt({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: "p-1" });

/** The automatic caller: claim policy admits receipt_status NULL only. */
const runAutomatic = () =>
  sendPaymentChargeReceipt({
    attemptId: ATTEMPT,
    studioId: STUDIO,
    practitionerId: "p-1",
    claimPolicy: "automatic",
  });

const keys = () => h.stmts.map((s) => s.key);
const settlementWrites = () =>
  h.stmts.filter((s) => s.op === "update" && s.key !== "payment_charge_attempts:update:sending");

beforeEach(() => baseline());
afterEach(() => vi.clearAllMocks());

describe("claim boundary", () => {
  it("C1 claim write failure -> database_error, no email attempted", async () => {
    h.responses["payment_charge_attempts:update:sending"] = {
      data: null,
      error: { code: "57014", message: "canceling statement" },
    };
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "database_error" });
    expect(h.sends).toHaveLength(0);
  });

  it("C2 already 'sent' is refused before any send", async () => {
    baseline("sent");
    const r = await run();
    expect(r).toMatchObject({ ok: false, reason: "already_sent" });
    expect(h.sends).toHaveLength(0);
  });

  it("C3 in-flight 'sending' is refused before any send (concurrency protection)", async () => {
    baseline("sending");
    const r = await run();
    expect(r).toMatchObject({ ok: false, reason: "in_flight" });
    expect(h.sends).toHaveLength(0);
    expect(settlementWrites()).toHaveLength(0);
  });

  it("C4 deployment mode mismatch is denied before any send", async () => {
    h.livemode = false; // row is livemode=true
    const r = await run();
    expect(r).toMatchObject({ ok: false, reason: "not_authorized" });
    expect(h.sends).toHaveLength(0);
  });

  it("C5 the claim stays studio-scoped and status-gated", async () => {
    await run();
    const claim = h.stmts.find((s) => s.key === "payment_charge_attempts:update:sending");
    expect(claim).toBeTruthy();
    const cols = (claim?.filters ?? []).map(([c]) => c);
    expect(cols).toContain("id");
    expect(cols).toContain("studio_id");
    expect(cols).toContain("status");
  });
});

describe("the DB-level second layer the mock does not evaluate", () => {
  // P3/C3 pin the APPLICATION guard (the mock scripts the claim as
  // succeeding, which isolates it). The claim's own predicate is an
  // independent second layer: even without the app guard, PostgREST would
  // refuse to move a 'sending' row. Assert it is present, since the mock
  // cannot prove it behaviourally.
  it("C6 the claim only admits receipt_status null or failed", async () => {
    await run();
    const claim = h.stmts.find((s) => s.key === "payment_charge_attempts:update:sending");
    const or = (claim?.filters ?? []).find(([c]) => c === "__or__");
    expect(or, "claim must carry the null/failed restriction").toBeTruthy();
    expect(String(or?.[1])).toContain("receipt_status.is.null");
    expect(String(or?.[1])).toContain("receipt_status.eq.failed");
  });
});

describe("provider SUCCESS", () => {
  it("P1 send ok + sent-write ok -> sent", async () => {
    const r = await run();
    expect(r).toMatchObject({ ok: true, status: "sent" });
    expect(h.sends).toHaveLength(1);
  });

  it("P2 send ok + sent-write FAILURE -> distinct sent_but_record_update_failed", async () => {
    h.responses["payment_charge_attempts:update:sent"] = {
      data: null,
      error: { code: "08006", message: "connection failure" },
    };
    const r = await run();
    expect(r).toMatchObject({ ok: false, reason: "sent_but_record_update_failed" });
    // MUST NOT be collapsed into an ordinary retryable failure: an email is
    // already in the wild.
    expect(r).not.toMatchObject({ reason: "send_failed_retryable" });
    expect(r).not.toMatchObject({ reason: "send_failed_state_not_recorded" });
    expect(h.alerts.some((a) => a.severity === "critical")).toBe(true);
    if (!r.ok) expect(r.message).not.toMatch(/try again/i);
  });

  it("P3 ambiguous success does NOT resend: the row stays 'sending' and a second call refuses", async () => {
    h.responses["payment_charge_attempts:update:sent"] = {
      data: null,
      error: { code: "08006", message: "connection failure" },
    };
    const first = await run();
    expect(first).toMatchObject({ reason: "sent_but_record_update_failed" });
    expect(h.sends).toHaveLength(1);

    // The row was left at 'sending' on purpose. Replay the helper against
    // that persisted state: it must refuse BEFORE the provider.
    baseline("sending");
    const second = await run();
    expect(second).toMatchObject({ ok: false, reason: "in_flight" });
    expect(h.sends).toHaveLength(0); // no second receipt to the client
  });
});

describe("provider RETRYABLE failure — delivery UNKNOWN, claim HELD", () => {
  // `retryable` is timeout / network / empty response / 5xx: the request reached
  // Resend, or may have, so the email may already be in the client's inbox.
  //
  // THIS BLOCK USED TO ASSERT A RELEASE. It no longer does, because releasing the
  // claim on an unknown delivery is how a second caller sends a duplicate receipt
  // — and once several concurrent charge invocations can reach the sender, that
  // stopped being theoretical. The row now stays at 'sending' and a person
  // reconciles.
  beforeEach(() => {
    h.sendResult = { ok: false, retryable: true, error: "Resend timeout after 10000ms" };
  });

  it("R1 the claim is HELD: no release write is attempted at all", async () => {
    const r = await run();
    expect(r).toMatchObject({
      ok: false,
      reason: "send_ambiguous_state_not_recorded",
    });
    expect(
      keys(),
      "an ambiguous delivery must not write receipt_status back to null",
    ).not.toContain("payment_charge_attempts:update:null");
  });

  it("R2 it never reports a plain retryable outcome", async () => {
    // "try again in a moment" is advice that can duplicate a real receipt.
    const r = await run();
    expect(r).not.toMatchObject({ reason: "send_failed_retryable" });
    expect(r).not.toMatchObject({ reason: "send_failed_state_not_recorded" });
    if (!r.ok) expect(r.message).not.toMatch(/try again in a moment/i);
  });

  it("R2b the message must NOT claim the receipt did not send", async () => {
    // Asserting non-delivery after a timeout is a claim Hone cannot support, and
    // an operator acting on it can clear the row and duplicate a receipt the
    // client already received.
    const r = await run();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).not.toMatch(/did not send/i);
    expect(r.message).not.toMatch(/was not sent/i);
    expect(r.message).toMatch(/could not confirm|unknown|may already/i);
    expect(r.message).toMatch(/provider/i);
  });

  it("R2c the alert records the held claim and unknown delivery, at CRITICAL", async () => {
    // Critical because the row cannot proceed without a person: the claim is held
    // deliberately, so this is not self-healing the way a released claim was.
    await run();
    const alert = h.alerts.find(
      (a) => a.event === "payment_receipt_send_ambiguous_claim_held",
    );
    expect(alert, "the held-claim alert must be raised").toBeTruthy();
    expect(alert?.severity).toBe("critical");
    const d = alert?.safeDetails as Record<string, unknown>;
    expect(d?.delivery_unknown).toBe(true);
    expect(d?.claim_released).toBe(false);
  });

  it("R3 the alert tells the operator to reconcile BEFORE clearing or resending", async () => {
    await run();
    const alert = h.alerts.find(
      (a) => a.event === "payment_receipt_send_ambiguous_claim_held",
    );
    expect(String(alert?.message)).toMatch(/RECONCILE WITH THE EMAIL PROVIDER/i);
    expect(String(alert?.message)).toMatch(/before clearing/i);
  });

  it("R4 exactly one email left Hone", async () => {
    await run();
    expect(h.sends).toHaveLength(1);
  });

  it("R5 a second automatic caller cannot claim the held row", async () => {
    // The durable consequence: with receipt_status parked at 'sending', the
    // automatic claim (NULL only) matches nothing, so no duplicate is possible.
    await run();
    expect(keys()).not.toContain("payment_charge_attempts:update:null");
    const claimWrites = keys().filter((k) => k.includes("update") && k.includes("sending"));
    expect(claimWrites.length).toBeLessThanOrEqual(1);
  });
});

describe("provider TERMINAL failure", () => {
  beforeEach(() => {
    h.sendResult = { ok: false, retryable: false, error: "Invalid recipient" };
  });

  it("T1 failed-write ok -> send_failed_terminal, row parked as failed", async () => {
    const r = await run();
    expect(r).toMatchObject({ ok: false, reason: "send_failed_terminal" });
    expect(keys()).toContain("payment_charge_attempts:update:failed");
  });

  it("T2 failed-write FAILURE -> send_failed_state_not_recorded, not terminal", async () => {
    h.responses["payment_charge_attempts:update:failed"] = {
      data: null,
      error: { code: "08006", message: "connection failure" },
    };
    const r = await run();
    // Terminal means sendEmailSafely never reached delivery, so definitive
    // wording IS supportable here -- the ambiguous outcome would understate
    // what we know.
    expect(r).toMatchObject({ ok: false, reason: "send_failed_state_not_recorded" });
    expect(r).not.toMatchObject({ reason: "send_failed_terminal" });
    expect(r).not.toMatchObject({ reason: "send_ambiguous_state_not_recorded" });
  });

  it("T2b the terminal alert records delivery as not_delivered", async () => {
    h.responses["payment_charge_attempts:update:failed"] = {
      data: null,
      error: { code: "08006", message: "connection failure" },
    };
    await run();
    const alert = h.alerts.find(
      (a) => a.event === "payment_receipt_terminal_record_failed",
    );
    expect((alert?.safeDetails as Record<string, unknown>)?.delivery).toBe(
      "not_delivered",
    );
  });

  it("T3 a failed terminal write raises the persistence failure to the operator", async () => {
    h.responses["payment_charge_attempts:update:failed"] = {
      data: null,
      error: { code: "08006", message: "connection failure" },
    };
    await run();
    const alert = h.alerts.find(
      (a) => a.event === "payment_receipt_terminal_record_failed",
    );
    expect(alert).toBeTruthy();
    expect(alert?.severity).toBe("critical");
  });

  it("T4 a failed terminal write sends no second email", async () => {
    h.responses["payment_charge_attempts:update:failed"] = {
      data: null,
      error: { code: "08006", message: "connection failure" },
    };
    await run();
    expect(h.sends).toHaveLength(1);
  });
});

describe("the two persistence-failure families stay distinct", () => {
  it("D1 provider-success/DB-failure and provider-failure/DB-failure are different outcomes", async () => {
    h.responses["payment_charge_attempts:update:sent"] = {
      data: null,
      error: { code: "08006", message: "x" },
    };
    const success = await run();

    baseline();
    h.sendResult = { ok: false, retryable: true, error: "timeout" };
    h.responses["payment_charge_attempts:update:null"] = {
      data: null,
      error: { code: "08006", message: "x" },
    };
    const failure = await run();

    expect(success).toMatchObject({ reason: "sent_but_record_update_failed" });
    expect(failure).toMatchObject({ reason: "send_ambiguous_state_not_recorded" });
    expect((success as { reason: string }).reason).not.toBe(
      (failure as { reason: string }).reason,
    );
  });

  it("D3 ambiguous and definitive settlement failures are different outcomes", async () => {
    // Codex P2. A timeout and an invalid-recipient failure both strand the
    // row, but only one of them licenses an operator to clear and resend.
    h.sendResult = { ok: false, retryable: true, error: "Resend timeout" };
    h.responses["payment_charge_attempts:update:null"] = {
      data: null,
      error: { code: "08006", message: "x" },
    };
    const ambiguous = await run();

    baseline();
    h.sendResult = { ok: false, retryable: false, error: "Invalid recipient" };
    h.responses["payment_charge_attempts:update:failed"] = {
      data: null,
      error: { code: "08006", message: "x" },
    };
    const definitive = await run();

    expect((ambiguous as { reason: string }).reason).toBe(
      "send_ambiguous_state_not_recorded",
    );
    expect((definitive as { reason: string }).reason).toBe(
      "send_failed_state_not_recorded",
    );
    expect((ambiguous as { reason: string }).reason).not.toBe(
      (definitive as { reason: string }).reason,
    );
    expect((ambiguous as { message: string }).message).not.toBe(
      (definitive as { message: string }).message,
    );
  });

  it("D2 no settlement path ever writes receipt_status='sent' on a provider failure", async () => {
    h.sendResult = { ok: false, retryable: true, error: "timeout" };
    h.responses["payment_charge_attempts:update:null"] = {
      data: null,
      error: { code: "08006", message: "x" },
    };
    await run();
    expect(keys()).not.toContain("payment_charge_attempts:update:sent");
  });
});

// ===========================================================================
// CLAIM POLICY — one sender, two policies
// ===========================================================================
//
// The durable `receipt_status: null -> sending` transition is the ONLY owner of
// email delivery. What differs between callers is which prior states they may
// claim, and the difference matters because an automatic caller is one of
// possibly several concurrent charge/recovery invocations while a manual caller
// is a person who has read the failure.

describe("claim policy", () => {
  it("P1 AUTOMATIC claims NULL only — a 'failed' receipt is not auto-retried", async () => {
    baseline("failed");
    const r = await runAutomatic();
    expect(r.ok).toBe(false);
    expect(
      h.sends,
      "an automatic caller must never resurrect a failed receipt",
    ).toHaveLength(0);
  });

  it("P2 MANUAL may still claim 'failed' — the authorised recovery path", async () => {
    baseline("failed");
    const r = await run();
    expect(r.ok).toBe(true);
    expect(h.sends).toHaveLength(1);
  });

  it("P3 neither policy may claim 'sending'", async () => {
    baseline("sending");
    expect((await runAutomatic()).ok).toBe(false);
    baseline("sending");
    expect((await run()).ok).toBe(false);
    expect(h.sends).toHaveLength(0);
  });

  it("P4 neither policy may claim 'sent'", async () => {
    baseline("sent");
    expect((await runAutomatic()).ok).toBe(false);
    baseline("sent");
    expect((await run()).ok).toBe(false);
    expect(h.sends).toHaveLength(0);
  });

  it("P5 both policies claim NULL, and exactly one send leaves Hone per claim", async () => {
    baseline(null);
    expect((await runAutomatic()).ok).toBe(true);
    expect(h.sends).toHaveLength(1);
    baseline(null);
    expect((await run()).ok).toBe(true);
    expect(h.sends).toHaveLength(1);
  });

  it("P6 THE RACE: the claim UPDATE matching zero rows is the loser, and it sends nothing", async () => {
    // Two concurrent callers both reach the sender; the database picks one. The
    // loser's conditional UPDATE matches no row.
    baseline(null);
    h.responses["payment_charge_attempts:update:sending"] = { data: [], error: null };
    h.responses["payment_charge_attempts:reread"] = {
      data: { receipt_status: "sending" },
      error: null,
    };
    const r = await runAutomatic();
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "in_flight" });
    expect(h.sends, "the claim loser must send nothing").toHaveLength(0);
  });

  it("P7 the loser is told already_sent when the winner finished", async () => {
    baseline(null);
    h.responses["payment_charge_attempts:update:sending"] = { data: [], error: null };
    h.responses["payment_charge_attempts:reread"] = {
      data: { receipt_status: "sent", receipt_sent_at: "2026-09-28T00:00:00.000Z" },
      error: null,
    };
    const r = await runAutomatic();
    expect(r).toMatchObject({ ok: false, reason: "already_sent" });
    expect(h.sends).toHaveLength(0);
  });

});

describe("the claim POLICY itself, not just its observable outcome", () => {
  // WHY THIS EXISTS. `P1 AUTOMATIC claims NULL only` passes even if the claim
  // query is widened to admit 'failed', because the early return for a failed row
  // fires first. A mutation that widened the query therefore went UNCAUGHT. The
  // policy has to be asserted where it lives: in the filters of the claim UPDATE.
  const claimFilters = () => {
    const claim = h.stmts.find(
      (x) => x.key === "payment_charge_attempts:update:sending",
    );
    return (claim?.filters ?? []).map(([c, v]) => `${c}=${String(v)}`);
  };

  it("AUTOMATIC claims with receipt_status IS NULL and no OR", async () => {
    baseline(null);
    await runAutomatic();
    const f = claimFilters();
    expect(f, "automatic must claim NULL only").toContain(
      "receipt_status=__is_null__",
    );
    expect(
      f.some((x) => x.startsWith("__or__")),
      "automatic must not widen the claim with an OR",
    ).toBe(false);
  });

  it("MANUAL claims with the NULL-or-failed OR, preserving recovery", async () => {
    baseline(null);
    await run();
    const f = claimFilters();
    const or = f.find((x) => x.startsWith("__or__"));
    expect(or, "manual must keep its OR claim").toBeTruthy();
    expect(or).toMatch(/receipt_status\.is\.null/);
    expect(or).toMatch(/receipt_status\.eq\.failed/);
  });

  it("neither policy claims a row that is already 'sending' or 'sent'", async () => {
    // Both are excluded by the claim's own status predicate, so the filters must
    // never mention them as admissible.
    baseline(null);
    await runAutomatic();
    const f = claimFilters().join(" ");
    expect(f).not.toMatch(/sending/);
    expect(f).not.toMatch(/eq\.sent/);
  });
});

describe("the refund predicate survives to the CLAIM, not just the classifier", () => {
  // THE TIME-OF-CHECK / TIME-OF-USE GAP. `classifyZeroRowSuccessWrite` refuses a
  // benign verdict unless `refund_status` is NULL, but it checks that at READ
  // time and the receipt claim runs later. `refundPaymentChargeAttempt` writes
  // `refund_status` on the same row independently, so a refund starting in that
  // gap used to leave the charge eligible: the claim filtered only
  // `receipt_status`, matched, and an automatic receipt went out while the
  // client's refund was in flight.
  //
  // Checking a condition and then acting on it in a separate statement is not the
  // same as requiring it. These tests assert the requirement is in the claim.

  const claimFilters = () => {
    const claim = h.stmts.find(
      (x) => x.key === "payment_charge_attempts:update:sending",
    );
    return (claim?.filters ?? []).map(([c, v]) => `${c}=${String(v)}`);
  };

  it("AUTOMATIC claims require refund_status IS NULL", async () => {
    baseline(null);
    await runAutomatic();
    expect(
      claimFilters(),
      "the automatic claim must carry the refund predicate",
    ).toContain("refund_status=__is_null__");
  });

  it("a refund that starts AFTER classification cannot be receipted", async () => {
    // The row is succeeded with receipt_status NULL — classification-time state —
    // but a refund has since begun. The claim must match nothing.
    baseline(null);
    h.responses["payment_charge_attempts:update:sending"] = { data: [], error: null };
    h.responses["payment_charge_attempts:reread"] = {
      data: { receipt_status: null },
      error: null,
    };
    const r = await runAutomatic();
    expect(r.ok).toBe(false);
    expect(h.sends, "no receipt for a charge being refunded").toHaveLength(0);
  });

  it("MANUAL keeps its own decision and is NOT refund-gated", async () => {
    // A practitioner sending a receipt for a charge later refunded is deciding
    // about a real document; manual recovery owns that. Only the automatic path
    // must never make the call on its own.
    baseline(null);
    await run();
    expect(claimFilters()).not.toContain("refund_status=__is_null__");
  });
});
