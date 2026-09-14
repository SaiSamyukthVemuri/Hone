import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inflateSync } from "node:zlib";

// ===========================================================================
// PAY-RECEIPT-PDF — ONE email, ONE attachment, or nothing at all
// ===========================================================================
//
// The product requirement is that an automatic receipt is not release-complete
// without an attached Hone-generated PDF. That turns "the PDF failed" into a
// DELIVERY question, not a cosmetic one: sending the email anyway would ship a
// receipt the product does not consider a receipt.
//
// The statement-level mock is reused verbatim from
// payment-receipt-outcome-persistence.test.ts, because the thing that must be
// proven here is the same thing it proves: which UPDATE ran, in what order,
// and what the row was left as. A PDF failure that strands the row at
// 'sending' would hide the manual Send button and make the receipt
// permanently unretryable -- the exact defect that suite exists for.
// ===========================================================================

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
      q.maybeSingle = async () => {
        // The re-read marker set by select() must survive a chained .eq(),
        // which returns the ORIGINAL builder. Without this the re-read falls
        // through to the generic attempt select and every claim-loss case
        // reads as in_flight.
        if (st.op === "select" && st.key === "reread") {
          h.stmts.push({ ...st, key: "payment_charge_attempts:reread" });
          return (
            h.responses["payment_charge_attempts:reread"] ?? { data: null, error: null }
          );
        }
        return settle();
      };
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

/** Text actually drawn in the PDF, recovered from its content streams. */
function extractPdfText(bytes: Buffer): string {
  let decoded = "";
  let i = 0;
  for (;;) {
    const s = bytes.indexOf("stream", i);
    if (s < 0) break;
    const e = bytes.indexOf("endstream", s);
    if (e < 0) break;
    let a = s + "stream".length;
    if (bytes[a] === 0x0d) a += 1;
    if (bytes[a] === 0x0a) a += 1;
    try {
      decoded += inflateSync(bytes.subarray(a, e)).toString("latin1");
    } catch {
      /* not a Flate stream */
    }
    i = e + "endstream".length;
  }
  return [...decoded.matchAll(/<([0-9A-Fa-f\s]*)>\s*Tj/g)]
    .map((m) => Buffer.from(m[1]!.replace(/\s/g, ""), "hex").toString("latin1"))
    .join("\n");
}

type Sent = {
  subject: string;
  html: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
};

beforeEach(() => baseline());
afterEach(() => vi.restoreAllMocks());

describe("a successful receipt is ONE email carrying ONE PDF", () => {
  it("sends exactly one email with exactly one attachment", async () => {
    const res = await sendPaymentChargeReceipt({
      attemptId: ATTEMPT, studioId: STUDIO, practitionerId: "prac-1",
    });
    expect(res.ok).toBe(true);
    expect(h.sends).toHaveLength(1);
    const sent = h.sends[0] as unknown as Sent;
    expect(sent.attachments).toHaveLength(1);
  });

  it("the attachment is a real PDF, named deterministically", async () => {
    await sendPaymentChargeReceipt({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: "p" });
    const att = (h.sends[0] as unknown as Sent).attachments![0]!;
    // charged_at is 2026-08-14 in the fixture.
    expect(att.filename).toBe("receipt-2026-08-14.pdf");
    expect(Buffer.isBuffer(att.content)).toBe(true);
    expect(att.content.subarray(0, 5).toString()).toBe("%PDF-");
    expect(att.content.toString("latin1")).toContain("%%EOF");
  });

  it("THE ATTACHED BYTES agree with the email body they arrive with", async () => {
    // The whole point of the canonical document. Asserted on the bytes that
    // were actually handed to the transport, not on a re-render.
    await sendPaymentChargeReceipt({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: "p" });
    const sent = h.sends[0] as unknown as Sent;
    const pdfText = extractPdfText(sent.attachments![0]!.content);

    const amount = /\$\d+\.\d\d CAD/.exec(sent.text)?.[0];
    const date = /\d{4}-\d\d-\d\d \d\d:\d\d UTC/.exec(sent.text)?.[0];
    expect(amount).toBe("$60.00 CAD");
    expect(date).toBeTruthy();
    expect(pdfText).toContain(amount!);
    expect(pdfText).toContain(date!);
    expect(pdfText).toContain("Card ending in 4242");
    // Live row: the approved live copy, and no Stripe ids.
    expect(pdfText).toContain("not the treatment provider or merchant of record");
    expect(pdfText).not.toContain("pi_live_1");
  });

  it("the row is still marked sent — payment truth is untouched", async () => {
    await sendPaymentChargeReceipt({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: "p" });
    const keys = h.stmts.map((s) => s.key);
    expect(keys).toContain("payment_charge_attempts:update:sending");
    expect(keys).toContain("payment_charge_attempts:update:sent");
  });
});

describe("a PDF failure sends NOTHING, and never strands the row", () => {
  it("submits no partial email, releases the claim, and says try again", async () => {
    vi.doMock("@/lib/billing/receipt-pdf", () => ({
      renderReceiptPdf: async () => {
        throw new Error("pdf engine exploded");
      },
      toWinAnsiSafe: (s: string) => s,
    }));
    vi.resetModules();
    const { sendPaymentChargeReceipt: fresh } = await import("@/lib/billing/payment-receipt");

    const res = await fresh({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: "p" });

    // NOTHING WAS SENT. Not a receipt without its attachment; nothing.
    expect(h.sends).toHaveLength(0);
    expect(res).toMatchObject({ ok: false, reason: "receipt_pdf_unavailable" });

    // The claim was RELEASED, so the manual Send button stays available.
    const keys = h.stmts.map((s) => s.key);
    expect(keys).toContain("payment_charge_attempts:update:sending");
    expect(keys).toContain("payment_charge_attempts:update:null");
    expect(keys).not.toContain("payment_charge_attempts:update:sent");

    // Visible to an operator, but only a warning: no money and no email are
    // at risk, so this must not read like the stranded-row emergencies.
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({
      severity: "warning",
      event: "payment_receipt_pdf_failed",
    });
    vi.doUnmock("@/lib/billing/receipt-pdf");
  });

  it("if the release ALSO fails, it escalates and still sends nothing", async () => {
    baseline();
    h.responses["payment_charge_attempts:update:null"] = {
      data: null,
      error: { code: "57014", message: "statement timeout" },
    };
    vi.doMock("@/lib/billing/receipt-pdf", () => ({
      renderReceiptPdf: async () => {
        throw new Error("pdf engine exploded");
      },
      toWinAnsiSafe: (s: string) => s,
    }));
    vi.resetModules();
    const { sendPaymentChargeReceipt: fresh } = await import("@/lib/billing/payment-receipt");

    const res = await fresh({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: "p" });

    expect(h.sends).toHaveLength(0);
    // Stuck at 'sending' and definitively nothing was dispatched, so the
    // operator instruction must NOT be "reconcile with the provider".
    expect(res).toMatchObject({ ok: false, reason: "send_failed_state_not_recorded" });
    const alert = h.alerts.at(-1) as Record<string, unknown>;
    expect(alert).toMatchObject({ severity: "critical" });
    expect(String(alert.message)).toContain("No client email went out");
    vi.doUnmock("@/lib/billing/receipt-pdf");
  });

  it("ANTI-VACUITY: with the real renderer the same fixture DOES send", async () => {
    // Without this, a harness that silently sent nothing would pass both tests
    // above while proving nothing about the failure path.
    baseline();
    vi.resetModules();
    const { sendPaymentChargeReceipt: fresh } = await import("@/lib/billing/payment-receipt");
    const res = await fresh({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: "p" });
    expect(res.ok).toBe(true);
    expect(h.sends).toHaveLength(1);
  });
});

describe("the automatic/manual claim protection is unchanged", () => {
  it("a row already sent is refused before any PDF work", async () => {
    baseline();
    h.responses["payment_charge_attempts:update:sending"] = { data: [], error: null };
    h.responses["payment_charge_attempts:reread"] = {
      data: { receipt_status: "sent", receipt_sent_at: "2026-08-14T10:05:00Z", receipt_email_to: "c@example.com" },
      error: null,
    };
    const res = await sendPaymentChargeReceipt({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: "p" });
    expect(res).toMatchObject({ ok: false, reason: "already_sent" });
    expect(h.sends).toHaveLength(0);
  });

  it("a send already in flight is refused before any PDF work", async () => {
    baseline();
    h.responses["payment_charge_attempts:update:sending"] = { data: [], error: null };
    h.responses["payment_charge_attempts:reread"] = {
      data: { receipt_status: "sending", receipt_sent_at: null, receipt_email_to: null },
      error: null,
    };
    const res = await sendPaymentChargeReceipt({ attemptId: ATTEMPT, studioId: STUDIO, practitionerId: "p" });
    expect(res).toMatchObject({ ok: false, reason: "in_flight" });
    expect(h.sends).toHaveLength(0);
  });
});
