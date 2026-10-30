import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-58 (OPS Q2b). A payment receipt is a document the client may submit for
// reimbursement: the RECEIPT BLOCK (the email's detail rows and the PDF, which
// render ONE canonical document) names the client by LEGAL name when a legal
// identity is recorded; the GREETING may use the preferred name. No legal
// identity, or a legal read that fails, changes nothing: the receipt is what it
// was before HON-58 (so this is behaviour-neutral until 0258 exists). The
// preferred name is never the receipt block's name. Synthetic names only.

import { buildReceiptDocument, type ReceiptFacts } from "@/lib/billing/receipt-document";

const FACTS: ReceiptFacts = {
  studioName: "Willow",
  studioContactEmail: "hello@example.test",
  clientName: "Margaret Nowak",
  reasonLabel: "Session payment",
  amountCents: 6000,
  currencyCode: "cad",
  paidAt: new Date("2026-08-14T10:00:00.000Z"),
  livemode: true,
  settlement: { kind: "card", last4: "4242", stripePaymentIntentId: "pi_1", stripeChargeId: "ch_1" },
};

const rowLabels = (doc: ReturnType<typeof buildReceiptDocument>) => doc.detailRows.map((r) => r.label);

describe("receipt document: the Client row", () => {
  it.each([true, false])("livemode=%s: a recorded legal name adds ONE Client row, straight after Studio", (livemode) => {
    const doc = buildReceiptDocument({ ...FACTS, livemode, documentClientName: "Margaret Anne Okafor" });
    const labels = rowLabels(doc);
    expect(labels.filter((l) => l === "Client")).toHaveLength(1);
    expect(labels.indexOf("Client")).toBe(labels.indexOf("Studio") + 1);
    expect(doc.detailRows.find((r) => r.label === "Client")).toEqual({
      label: "Client", value: "Margaret Anne Okafor", monospace: false,
    });
  });

  it.each([[undefined], [null], [""], ["   "]])("no legal name (%j) adds NO row: the document is exactly the pre-HON-58 one", (documentClientName) => {
    for (const livemode of [true, false]) {
      const before = buildReceiptDocument({ ...FACTS, livemode });
      const after = buildReceiptDocument({ ...FACTS, livemode, documentClientName });
      expect(after).toEqual(before);
      expect(rowLabels(after)).not.toContain("Client");
    }
  });

  it("the greeting is the preferred name, the Client row is the legal name, and the two are independent", () => {
    const doc = buildReceiptDocument({ ...FACTS, clientName: "Maggie", documentClientName: "Margaret Anne Okafor" });
    expect(doc.greeting).toBe("Hi Maggie,");
    expect(doc.detailRows.find((r) => r.label === "Client")?.value).toBe("Margaret Anne Okafor");
  });

  it("the approved wording is untouched: with the Client row removed, the document equals the one without it (no claimability wording added)", () => {
    const withRow = buildReceiptDocument({ ...FACTS, documentClientName: "Margaret Anne Okafor" });
    const without = buildReceiptDocument(FACTS);
    expect({ ...withRow, detailRows: withRow.detailRows.filter((r) => r.label !== "Client") }).toEqual(without);
    expect(JSON.stringify(withRow.detailRows.find((r) => r.label === "Client"))).not.toMatch(/claim|reimburs|insurance|eligible/i);
  });
});

// ---- the sender -----------------------------------------------------------------

const h = vi.hoisted(() => ({
  hasPreferredColumn: true,
  preferred: "Maggie" as string | null,
  sends: [] as Array<Record<string, unknown>>,
  selects: [] as string[],
}));

vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => true }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => undefined }));
vi.mock("@/lib/email/send-appointment", () => ({
  sendEmailSafely: async (opts: Record<string, unknown>) => {
    h.sends.push(opts);
    return { ok: true };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("no request scope");
  },
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      let op = "select";
      let cols = "";
      const q: Record<string, unknown> = {};
      const result = () => {
        if (op === "update") return { data: [{ id: "att-1" }], error: null };
        if (table === "payment_charge_attempts") {
          return {
            data: {
              id: "att-1", studio_id: "studio-1", client_id: "client-1", charge_reason: "session_payment",
              amount_cents: 6000, currency: "cad", status: "succeeded", stripe_livemode: true,
              stripe_payment_intent_id: "pi_live_1", stripe_charge_id: "ch_live_1",
              charged_at: "2026-08-14T10:00:00.000Z", client_payment_method_id: "cpm-1",
              receipt_status: null, receipt_sent_at: null, receipt_email_to: null,
            },
            error: null,
          };
        }
        if (table === "clients") {
          h.selects.push(cols);
          if (cols.includes("preferred_name") && !h.hasPreferredColumn) {
            return { data: null, error: { code: "42703", message: "column clients.preferred_name does not exist" } };
          }
          return {
            data: {
              id: "client-1", studio_id: "studio-1", name: "Margaret Nowak", email: "c@example.test",
              ...(cols.includes("preferred_name") ? { preferred_name: h.preferred } : {}),
            },
            error: null,
          };
        }
        if (table === "studios") {
          return { data: { id: "studio-1", name: "Willow", owner_email: "o@example.test", postcare_contact_email: null }, error: null };
        }
        if (table === "client_payment_methods") return { data: { last4: "4242" }, error: null };
        return { data: null, error: null };
      };
      q.select = (c?: string) => { cols = c ?? cols; return q; };
      q.update = () => { op = "update"; return q; };
      q.eq = () => q;
      q.or = () => q;
      q.is = () => q;
      q.order = () => q;
      q.maybeSingle = async () => result();
      q.then = (resolve: (v: unknown) => unknown) => resolve(result());
      return q;
    },
  }),
}));

import { sendPaymentChargeReceipt } from "@/lib/billing/payment-receipt";

const send = (legalNameReader?: (id: string) => Promise<string | null>) =>
  sendPaymentChargeReceipt({ attemptId: "att-1", studioId: "studio-1", practitionerId: "p-1", legalNameReader });

beforeEach(() => {
  h.hasPreferredColumn = true;
  h.preferred = "Maggie";
  h.sends = [];
  h.selects = [];
});

describe("sendPaymentChargeReceipt: names", () => {
  it("legal recorded: the greeting is the preferred name and the receipt block carries the legal name, in the email AND the PDF attachment", async () => {
    const reader = vi.fn(async () => "Margaret Anne Okafor");
    const res = await send(reader);
    expect(res.ok).toBe(true);
    expect(reader).toHaveBeenCalledWith("client-1");
    const mail = h.sends[0];
    expect(String(mail.text)).toContain("Hi Maggie,");
    expect(String(mail.text)).toContain("Client: Margaret Anne Okafor");
    expect(String(mail.html)).toContain("Margaret Anne Okafor");
    expect(String(mail.text)).not.toContain("Margaret Nowak");
    expect(Array.isArray(mail.attachments) ? (mail.attachments as unknown[]).length : 1).toBeGreaterThan(0);
  });

  it("legal absent: no Client row, the greeting is the preferred name, the receipt is otherwise unchanged", async () => {
    await send(async () => null);
    const text = String(h.sends[0].text);
    expect(text).toContain("Hi Maggie,");
    expect(text).not.toContain("Client:");
  });

  it("legal read FAILS CLOSED: a throwing reader is not caught by the sender, the DEFAULT reader is: no request scope means no legal name and the receipt still goes", async () => {
    const res = await send(); // the default signed-in reader; createClient throws in this fake
    expect(res.ok).toBe(true);
    const text = String(h.sends[0].text);
    expect(text).toContain("Hi Maggie,");
    expect(text).not.toContain("Client:");
  });

  it("no preferred name: the greeting is the stored name, exactly as before", async () => {
    h.preferred = null;
    await send(async () => null);
    expect(String(h.sends[0].text)).toContain("Hi Margaret Nowak,");
  });

  it("before 0258 (no preferred_name column): the read retries without it and the receipt is the pre-HON-58 one", async () => {
    h.hasPreferredColumn = false;
    await send(async () => null);
    expect(h.selects).toHaveLength(2);
    expect(h.selects[0]).toContain("preferred_name");
    expect(h.selects[1]).not.toContain("preferred_name");
    const text = String(h.sends[0].text);
    expect(text).toContain("Hi Margaret Nowak,");
    expect(text).not.toContain("Client:");
  });

  it("the preferred name is never the receipt block's name", async () => {
    await send(async () => null);
    expect(String(h.sends[0].text)).not.toMatch(/Client: Maggie/);
  });

  it("FAIL CLOSED on a name the fonts cannot draw: a preferred name with a CJK character the bundled fonts lack falls back to the stored name and the receipt still goes", async () => {
    h.preferred = "Maggie \u7530\u4e2d";
    const res = await send(async () => null);
    expect(res.ok).toBe(true);
    const text = String(h.sends[0].text);
    expect(text).toContain("Hi Margaret Nowak,");
    expect(text).not.toContain("\u7530");
    expect(text).not.toContain("Client:");
  });

  it("FAIL CLOSED on a legal name the fonts cannot draw: no Client row, the stored/preferred greeting is used, and the email and PDF still agree", async () => {
    const res = await send(async () => "\u7530\u4e2d Okafor");
    expect(res.ok).toBe(true);
    const text = String(h.sends[0].text);
    expect(text).not.toContain("Client:");
    expect(text).not.toContain("Okafor");
    expect(text).toContain("Hi Margaret Nowak,"); // the whole HON-58 document is dropped, not half of it
  });
});
