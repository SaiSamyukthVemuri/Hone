import { describe, expect, it, vi, beforeEach } from "vitest";

// ===========================================================================
// PAY-RECEIPT-PDF — one Resend path, one attachments array
// ===========================================================================
//
// `payload.attachments` used to be a direct ASSIGNMENT for the calendar
// invite. A second assignment for the receipt PDF would have silently
// clobbered it, and the symptom would have been a missing .ics on some other
// email entirely -- a defect in a feature this lane never touched.
//
// Widening the one transport is also what keeps "no second Resend path" true:
// a separate client would fork From-header sanitisation, Reply-To, the 15s
// timeout and the retryable/terminal classification the receipt row depends on.
// ===========================================================================

const h = vi.hoisted(() => ({
  payloads: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <hello@hone.care>",
  resend: {
    emails: {
      send: async (payload: Record<string, unknown>) => {
        h.payloads.push(payload);
        return { data: { id: "msg_1" }, error: null };
      },
    },
  },
}));

import { sendEmailSafely } from "@/lib/email/send-appointment";

const BASE = { to: "c@example.com", subject: "s", html: "<p>h</p>", text: "t" };

beforeEach(() => {
  h.payloads = [];
});

describe("the attachments array accumulates instead of overwriting", () => {
  it("no attachments at all leaves the field absent", async () => {
    await sendEmailSafely({ ...BASE });
    expect(h.payloads[0]!.attachments).toBeUndefined();
  });

  it("an ics alone still works, exactly as before", async () => {
    await sendEmailSafely({ ...BASE, icsContent: "BEGIN:VCALENDAR" });
    const att = h.payloads[0]!.attachments as Array<{ filename: string }>;
    expect(att).toHaveLength(1);
    expect(att[0]!.filename).toBe("appointment.ics");
  });

  it("a pdf alone attaches exactly one file", async () => {
    await sendEmailSafely({
      ...BASE,
      attachments: [{ filename: "receipt-2026-03-04.pdf", content: Buffer.from("%PDF-1.7") }],
    });
    const att = h.payloads[0]!.attachments as Array<{ filename: string }>;
    expect(att).toHaveLength(1);
    expect(att[0]!.filename).toBe("receipt-2026-03-04.pdf");
  });

  it("BOTH coexist — the ics is not clobbered by the pdf", async () => {
    // The regression this seam was rewritten to prevent.
    await sendEmailSafely({
      ...BASE,
      icsContent: "BEGIN:VCALENDAR",
      attachments: [{ filename: "receipt.pdf", content: Buffer.from("%PDF-1.7") }],
    });
    const att = h.payloads[0]!.attachments as Array<{ filename: string }>;
    expect(att).toHaveLength(2);
    expect(att.map((a) => a.filename)).toEqual(["appointment.ics", "receipt.pdf"]);
  });

  it("there is exactly ONE place attachments are assigned", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "lib/email/send-appointment.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code.match(/payload\.attachments\s*=/g) ?? []).toHaveLength(1);
  });

  it("there is exactly ONE Resend client in the codebase", async () => {
    const { execSync } = await import("node:child_process");
    // `new Resend(` anywhere outside the one client module would be a second path.
    const hits = execSync(
      "grep -rln 'new Resend(' lib app --include=*.ts --include=*.tsx || true",
      { encoding: "utf8", cwd: process.cwd() },
    )
      .split("\n")
      .filter(Boolean);
    // Exactly one. lib/ops/alert-email.ts is the separate OPERATOR alert path
    // and it takes its client from this same module rather than constructing
    // its own. This lane added no client and no second transport.
    expect(hits.sort()).toEqual(["lib/email/client.ts"]);
  });
});
