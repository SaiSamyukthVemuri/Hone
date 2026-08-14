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
        if (st.op === "select" && st.key === "reread") {
          // keep the marker; settle() will use it
          const inner = { ...q };
          inner.maybeSingle = async () => {
            h.stmts.push({ ...st, key: "payment_charge_attempts:reread" });
            return (
              h.responses["payment_charge_attempts:reread"] ?? { data: null, error: null }
            );
          };
          return inner;
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
      q.is = () => q;
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

describe("provider RETRYABLE failure", () => {
  beforeEach(() => {
    h.sendResult = { ok: false, retryable: true, error: "Resend timeout after 10000ms" };
  });

  it("R1 release write ok -> send_failed_retryable, row released to null", async () => {
    const r = await run();
    expect(r).toMatchObject({ ok: false, reason: "send_failed_retryable" });
    expect(keys()).toContain("payment_charge_attempts:update:null");
  });

  it("R2 release write FAILURE -> send_failed_state_not_recorded, never 'retryable'", async () => {
    h.responses["payment_charge_attempts:update:null"] = {
      data: null,
      error: { code: "08006", message: "connection failure" },
    };
    const r = await run();
    // The row is stuck at 'sending'; the claim admits only (null,'failed'),
    // so telling the practitioner to "try again in a moment" would be a lie.
    expect(r).toMatchObject({ ok: false, reason: "send_failed_state_not_recorded" });
    expect(r).not.toMatchObject({ reason: "send_failed_retryable" });
    if (!r.ok) expect(r.message).not.toMatch(/try again in a moment/i);
  });

  it("R3 a failed release raises the PERSISTENCE failure to the operator", async () => {
    h.responses["payment_charge_attempts:update:null"] = {
      data: null,
      error: { code: "08006", message: "connection failure" },
    };
    await run();
    const alert = h.alerts.find((a) => a.event === "payment_receipt_release_failed");
    expect(alert).toBeTruthy();
    expect(alert?.severity).toBe("critical");
    expect((alert?.safeDetails as Record<string, unknown>)?.stuck_receipt_status).toBe("sending");
  });

  it("R4 a failed release sends no second email", async () => {
    h.responses["payment_charge_attempts:update:null"] = {
      data: null,
      error: { code: "08006", message: "connection failure" },
    };
    await run();
    expect(h.sends).toHaveLength(1);
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
    expect(r).toMatchObject({ ok: false, reason: "send_failed_state_not_recorded" });
    expect(r).not.toMatchObject({ reason: "send_failed_terminal" });
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
    expect(failure).toMatchObject({ reason: "send_failed_state_not_recorded" });
    expect((success as { reason: string }).reason).not.toBe(
      (failure as { reason: string }).reason,
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
