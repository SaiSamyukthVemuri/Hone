import { afterEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// DELIVERY-VISIBILITY-03 — the booking confirmation joins the email delivery
// ledger inside its one sender, so all four callers are covered.
//
// Pinned: the row is begun for THIS appointment and studio with the
// confirmation purpose; the message carries the hone_m tag; the provider's
// answer is settled onto the row; and when the ledger (or the service-role
// configuration) is unavailable, the very same email is sent untagged and the
// caller sees the same result.
// ===========================================================================

type Payload = Record<string, unknown>;
const h: {
  sent: Payload[];
  rpc: Array<[string, Record<string, unknown>]>;
  begin: { data: unknown; error: unknown };
  adminThrows: boolean;
} = { sent: [], rpc: [], begin: { data: null, error: null }, adminThrows: false };

const ROW = "6e5d4c3b-2a19-4807-a6b5-c4d3e2f1a0b9";
const EMAIL_ID = "0b8f1c1e-6a52-4c0e-9f3e-2f6c3c1a7d10";

vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <hello@hone.care>",
  getResendTransport: () => ({
    emails: {
      send: (payload: Payload) => {
        h.sent.push(payload);
        return Promise.resolve({ data: { id: EMAIL_ID }, error: null });
      },
    },
  }),
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    if (h.adminThrows) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
    return {
      rpc: (fn: string, args: Record<string, unknown>) => {
        h.rpc.push([fn, args]);
        return Promise.resolve(fn === "begin_appointment_email_message" ? h.begin : { data: "settled", error: null });
      },
    };
  },
}));

const { sendBookingConfirmationToClient } = await import("@/lib/email/send-appointment");

const STUDIO_ID = "4f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b";
const APPT_ID = "9e8d7c6b-5a49-4382-a716-152433221100";

function params(over: Record<string, unknown> = {}) {
  return {
    appointment: {
      id: APPT_ID,
      studio_id: STUDIO_ID,
      starts_at: "2026-10-16T17:00:00.000Z",
      ends_at: "2026-10-16T17:45:00.000Z",
      duration_minutes: 45,
    },
    service: { name: "Electrolysis", default_duration_minutes: 45, pre_care_instructions: null },
    studio: {
      id: STUDIO_ID,
      name: "Synthetic Studio",
      address: null,
      owner_email: "owner@synthetic.test",
      timezone: "America/Los_Angeles",
      slug: null,
      postcare_contact_email: null,
    },
    practitionerDisplayName: "Practitioner",
    clientName: "Synthetic Client",
    clientEmail: "client@synthetic.test",
    cancellationUrl: "https://hone.care/cancel/x",
    rescheduleUrl: null,
    intakeUrl: null,
    treatmentTimeLine: null,
    appBaseUrl: "https://hone.care",
    ...over,
  } as never;
}

afterEach(() => {
  h.sent = [];
  h.rpc = [];
  h.begin = { data: ROW, error: null };
  h.adminThrows = false;
});

describe("sendBookingConfirmationToClient joins the ledger", () => {
  it("begins a confirmation row for this appointment, tags the email and settles the provider's answer", async () => {
    h.begin = { data: ROW, error: null };
    const result = await sendBookingConfirmationToClient(params());
    expect(result).toEqual({ ok: true, messageId: EMAIL_ID });
    expect(h.rpc[0]).toEqual([
      "begin_appointment_email_message",
      { p_studio_id: STUDIO_ID, p_appointment_id: APPT_ID, p_purpose: "appointment_confirmation" },
    ]);
    expect(h.sent[0]!.tags).toEqual([{ name: "hone_m", value: ROW }]);
    expect(h.rpc[1]).toEqual([
      "settle_email_message",
      { p_message_id: ROW, p_outcome: "accepted", p_provider_email_id: EMAIL_ID, p_provider_error: null, p_skip_reason: null },
    ]);
  });

  it("sends the same email untagged when the ledger row cannot be begun", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.begin = { data: null, error: { message: "db down" } };
    const result = await sendBookingConfirmationToClient(params());
    expect(result).toEqual({ ok: true, messageId: EMAIL_ID });
    expect(h.sent[0]).not.toHaveProperty("tags");
    expect(h.rpc.map(([fn]) => fn)).toEqual(["begin_appointment_email_message"]);
  });

  it("sends the same email untagged when there is no service-role configuration", async () => {
    h.adminThrows = true;
    const result = await sendBookingConfirmationToClient(params());
    expect(result.ok).toBe(true);
    expect(h.sent[0]).not.toHaveProperty("tags");
    expect(h.rpc).toEqual([]);
  });

  it("begins nothing when there is no recipient", async () => {
    const result = await sendBookingConfirmationToClient(params({ clientEmail: "" }));
    expect(result).toMatchObject({ ok: false, attempt: "none" });
    expect(h.rpc).toEqual([]);
    expect(h.sent).toEqual([]);
  });
});
