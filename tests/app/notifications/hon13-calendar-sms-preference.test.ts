import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-13 (NOTIF-PREFS-01), matrix cell: internal (calendar) booking x
// send_confirmation_sms.
//
// The public booking and reschedule surfaces keep the confirmation SMS
// INDEPENDENT of the confirmation email: the reschedule action even documents
// that nesting it "silently lost SMS too" for a studio that turned email
// confirmations off. The calendar's dispatchBookingEmails still nests it, so a
// studio's SMS choice is overridden by its EMAIL choice and by whether the
// client happens to have an email address.
//
// Fake providers only: the email and SMS senders are spies, nothing is sent.

const h = vi.hoisted(() => ({
  studio: {} as Record<string, unknown>,
  client: {} as Record<string, unknown>,
  email: vi.fn(async () => ({ ok: true })),
  practitionerEmail: vi.fn(async () => ({ ok: true })),
  sms: vi.fn(async () => ({ ok: true })),
  ensure: vi.fn(async () => null),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "A", role: "owner", active: true, display_name: "Owner A", email: "a@example.test" },
    studio: h.studio,
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: [{ result: "created", appointment_id: "appointment" }], error: null }),
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const query: Record<string, unknown> = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => {
          if (table === "services") return { data: { id: "service", default_duration_minutes: 60 }, error: null };
          if (table === "clients") return { data: h.client, error: null };
          if (table === "appointments") {
            return {
              data: { id: "appointment", client_id: "client", practitioner_id: "A", starts_at: "2099-01-01T15:00:00.000Z" },
              error: null,
            };
          }
          return {
            data: { id: "A", studio_id: "studio", active: true, display_name: "Owner A", email: "a@example.test" },
            error: null,
          };
        },
      };
      return query;
    },
  }),
}));
vi.mock("@/lib/booking/slots", () => ({
  INTERNAL_SLOT_PACKING: {},
  getAvailableSlots: async () => [{ start: "2099-01-01T15:00:00.000Z", end: "2099-01-01T16:00:00.000Z" }],
}));
vi.mock("@/lib/booking/appointment-token", () => ({ generateAppointmentToken: () => "synthetic", hashAppointmentToken: () => "hash" }));
vi.mock("@/lib/booking/tokens", () => ({ generateCancellationToken: () => "synthetic" }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: vi.fn() }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://synthetic.example.test" }));
vi.mock("@/lib/intake/queries", () => ({ ensureIntakeForClient: h.ensure }));
vi.mock("@/lib/email/send-appointment", () => ({
  sendBookingConfirmationToClient: h.email,
  sendBookingNotificationToPractitioner: h.practitionerEmail,
  recordEmailAttempt: vi.fn(),
  logEmailFailure: vi.fn(),
  sendCancellationEmail: vi.fn(),
  sendPostcareToClient: vi.fn(),
}));
vi.mock("@/lib/sms/send-appointment", () => ({ sendBookingConfirmationSmsToClient: h.sms }));

import { bookAppointmentForClientAction } from "@/app/(app)/calendar/actions";

function book() {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    client_id: "client",
    service_id: "service",
    starts_at: "2099-01-01T15:00:00.000Z",
    practitioner_id: "A",
  })) {
    form.set(key, value);
  }
  return bookAppointmentForClientAction(form);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.studio = {
    id: "studio",
    timezone: "America/Toronto",
    practitioner_capacity_enabled: false,
    default_appointment_duration_minutes: 60,
    buffer_minutes: 0,
    send_confirmation_emails: true,
    send_confirmation_sms: true,
    notify_practitioner_on_new_booking: true,
  };
  h.client = {
    id: "client",
    name: "Synthetic Client",
    email: "client@example.test",
    phone: "+16045550100",
    sms_consent_at: "2026-09-01T00:00:00Z",
    sms_opted_out_at: null,
  };
});

describe("HON-13: internal booking honours send_confirmation_sms on its own", () => {
  it("control: email and SMS both on, both attempted", async () => {
    expect(await book()).toEqual({ ok: true, appointmentId: "appointment" });
    expect(h.email).toHaveBeenCalledTimes(1);
    expect(h.sms).toHaveBeenCalledTimes(1);
  });

  it("send_confirmation_emails OFF does not switch the consented client's SMS confirmation off", async () => {
    h.studio.send_confirmation_emails = false;
    expect(await book()).toEqual({ ok: true, appointmentId: "appointment" });
    expect(h.email).not.toHaveBeenCalled();
    expect(h.sms).toHaveBeenCalledTimes(1);
  });

  it("a client with no email address still gets the SMS confirmation they consented to", async () => {
    h.client.email = null;
    expect(await book()).toEqual({ ok: true, appointmentId: "appointment" });
    expect(h.email).not.toHaveBeenCalled();
    expect(h.sms).toHaveBeenCalledTimes(1);
  });

  it("the SMS helper receives the client's own consent and opt-out, so it stays the only consent authority", async () => {
    h.studio.send_confirmation_emails = false;
    h.client.sms_opted_out_at = "2026-09-02T00:00:00Z";
    await book();
    // The helper owns the STOP/consent decision; the caller must hand it the
    // live opt-out rather than deciding for it.
    expect(h.sms).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({ sms_opted_out_at: "2026-09-02T00:00:00Z" }),
      }),
    );
  });

  it("the new-booking practitioner notification still follows notify_practitioner_on_new_booking alone", async () => {
    h.studio.send_confirmation_emails = false;
    await book();
    expect(h.practitionerEmail).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    h.studio.notify_practitioner_on_new_booking = false;
    await book();
    expect(h.practitionerEmail).not.toHaveBeenCalled();
  });
});

// 1181-F1: issuing an intake link creates a blank intake row and stamps the link
// as emailed. That must happen only when something can actually carry the link:
// the confirmation email, or a confirmation SMS that passes the FULL consent gate.
describe("1181-F1: no intake row or issued stamp unless a message can carry the link", () => {
  beforeEach(() => {
    h.studio.send_confirmation_emails = false;
  });

  it.each([
    ["an unconsented client", { sms_consent_at: null }],
    ["a STOPped client", { sms_opted_out_at: "2026-09-02T00:00:00Z" }],
    ["a client with no phone", { phone: null }],
    ["a client with an unusable phone", { phone: "not-a-number" }],
  ])("%s: nothing can be sent, so no intake link is issued", async (_n, patch) => {
    Object.assign(h.client, patch);
    await book();
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it("the studio SMS switch off and no email: no intake link either", async () => {
    h.studio.send_confirmation_sms = false;
    await book();
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it("control: a consented client with a valid phone gets the link via SMS", async () => {
    await book();
    expect(h.ensure).toHaveBeenCalledTimes(1);
    // Only an SMS carries it, so the issued stamp must not claim an email.
    expect(h.ensure).toHaveBeenCalledWith(expect.objectContaining({ emailed: false }));
  });

  it("control: the confirmation email going out still issues the link", async () => {
    h.studio.send_confirmation_emails = true;
    Object.assign(h.client, { sms_consent_at: null });
    await book();
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.ensure).toHaveBeenCalledWith(expect.objectContaining({ emailed: true }));
  });
});
