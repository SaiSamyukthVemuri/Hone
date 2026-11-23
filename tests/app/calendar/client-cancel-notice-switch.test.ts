import { beforeEach, describe, expect, it, vi } from "vitest";

// When the studio cancels an appointment, the client's cancellation email follows send_client_cancellation_emails (0373):
// its own switch, read live, default ON, independent of send_confirmation_emails. The same cancel submitted twice (a double click,
// a resubmitted form) sends one notice, and a refused send is never retried. Spy senders only: nothing is sent.

const h = vi.hoisted(() => ({
  rpcResults: [] as string[],
  switchReply: { data: {}, error: null } as { data: unknown; error: { code?: string } | null },
  switchReads: 0,
  clientEmail: "client@example.invalid" as string | null,
  studioConfirmationEmails: false,
  email: vi.fn<(p: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://app.example.test" }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "p-1", display_name: "Synthetic Ana", email: "ana@example.test", role: "owner" },
    studio: { id: "s-1", slug: "synthetic", timezone: "America/Los_Angeles", send_confirmation_emails: h.studioConfirmationEmails },
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: h.rpcResults.shift() ?? "cancelled", error: null }),
    from: (table: string) => {
      let columns = "";
      const q = {
        select: (c: string) => { columns = c; return q; },
        eq: () => q,
        maybeSingle: async () => {
          if (table === "studios" && columns === "send_client_cancellation_emails") { h.switchReads += 1; return h.switchReply; }
          return { data: null, error: null };
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const rows: Record<string, unknown> = {
        appointments: { client_id: "c-1", starts_at: "2031-05-12T19:00:00Z", duration_minutes: 30, service_id: "sv-1" },
        clients: { name: "Synthetic Client", email: h.clientEmail },
        services: { name: "Synthetic Service" },
      };
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) };
      return q;
    },
  }),
}));
vi.mock("@/lib/email/send-appointment", () => ({
  logEmailFailure: vi.fn(),
  recordEmailAttempt: vi.fn(),
  sendBookingConfirmationToClient: vi.fn(),
  sendBookingNotificationToPractitioner: vi.fn(),
  sendCancellationEmail: h.email,
  sendPostcareToClient: vi.fn(),
}));

import { cancelAppointmentAction } from "@/app/(app)/calendar/actions";

function form(): FormData {
  const fd = new FormData();
  fd.set("appointment_id", "a-1");
  return fd;
}

beforeEach(() => {
  h.rpcResults = [];
  h.switchReply = { data: {}, error: null };
  h.switchReads = 0;
  h.clientEmail = "client@example.invalid";
  h.studioConfirmationEmails = false;
  h.email.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the client's cancellation email follows its own switch", () => {
  it("ON: sends one email to the client", async () => {
    h.switchReply = { data: { send_client_cancellation_emails: true }, error: null };
    expect((await cancelAppointmentAction(form())).ok).toBe(true);
    expect(h.email).toHaveBeenCalledTimes(1);
    expect(h.email.mock.calls[0][0]).toMatchObject({ to: "client@example.invalid", isClient: true });
  });

  it("ABSENT (default): sends, so shipping the code before the column changes nothing", async () => {
    expect((await cancelAppointmentAction(form())).ok).toBe(true);
    expect(h.email).toHaveBeenCalledTimes(1);
  });

  it("OFF: no email, and the cancel still succeeds", async () => {
    h.switchReply = { data: { send_client_cancellation_emails: false }, error: null };
    expect(await cancelAppointmentAction(form())).toEqual({ ok: true });
    expect(h.email).not.toHaveBeenCalled();
  });

  it("UNREADABLE setting: no email (fail closed), the cancel still succeeds, and the log carries no private detail", async () => {
    h.switchReply = { data: null, error: { code: "XX000" } };
    const log = vi.spyOn(console, "error");
    expect((await cancelAppointmentAction(form())).ok).toBe(true);
    expect(h.email).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).toContain("client_cancel_notification_setting_unreadable");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/client@example|XX000/);
  });

  it("the booking-confirmation switch has no effect: confirmations off, cancellation on, still sends", async () => {
    h.studioConfirmationEmails = false;
    h.switchReply = { data: { send_client_cancellation_emails: true }, error: null };
    await cancelAppointmentAction(form());
    expect(h.email).toHaveBeenCalledTimes(1);
  });

  it("the booking-confirmation switch has no effect: confirmations on, cancellation off, sends nothing", async () => {
    h.studioConfirmationEmails = true;
    h.switchReply = { data: { send_client_cancellation_emails: false }, error: null };
    await cancelAppointmentAction(form());
    expect(h.email).not.toHaveBeenCalled();
  });

  it("a client with no email on file is never emailed, and the setting is not read", async () => {
    h.clientEmail = null;
    await cancelAppointmentAction(form());
    expect(h.email).not.toHaveBeenCalled();
    expect(h.switchReads).toBe(0);
  });
});

describe("retries and duplicates", () => {
  it("the same cancel submitted twice sends ONE notice: the second finds it already cancelled and stops before the setting or the sender", async () => {
    h.rpcResults = ["cancelled", "already_cancelled"];
    expect((await cancelAppointmentAction(form())).ok).toBe(true);
    expect((await cancelAppointmentAction(form())).ok).toBe(true);
    expect(h.email).toHaveBeenCalledTimes(1);
    expect(h.switchReads).toBe(1);
  });

  it("a refused send is not retried: exactly one attempt, and the cancel still succeeds", async () => {
    h.email.mockResolvedValue({ ok: false, error: "PRIVATE", retryable: true });
    expect((await cancelAppointmentAction(form())).ok).toBe(true);
    expect(h.email).toHaveBeenCalledTimes(1);
  });

  it("a thrown send is not retried either", async () => {
    h.email.mockRejectedValue(new Error("PRIVATE"));
    expect((await cancelAppointmentAction(form())).ok).toBe(true);
    expect(h.email).toHaveBeenCalledTimes(1);
  });

  it("a cancel the studio may not make sends nothing", async () => {
    h.rpcResults = ["not_authorized"];
    expect((await cancelAppointmentAction(form())).ok).toBe(false);
    expect(h.email).not.toHaveBeenCalled();
  });
});
