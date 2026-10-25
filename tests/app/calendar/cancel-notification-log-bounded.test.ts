import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MSG-LOG-RAW-ERROR (calendar call site). When the client-cancel notification
// email throws, the cancel still succeeds, and the log line carries a bounded
// value only: never the thrown message (a provider or transport message can
// quote the destination), never the raw error object. Synthetic data only.

const { PHONE, EMAIL } = vi.hoisted(() => ({ PHONE: "+1 555 010 0199", EMAIL: "leak.probe@example.test" }));

const state = vi.hoisted(() => ({
  sendCancellationEmail: vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://app.example.test" }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "p-1", display_name: "Synthetic Ana", email: "ana@example.test", role: "owner" },
    studio: { id: "s-1", slug: "synthetic", timezone: "America/Los_Angeles" },
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ rpc: async () => ({ data: "cancelled", error: null }) }),
}));
vi.mock("@/lib/supabase/server", () => {
  const rows: Record<string, unknown> = {
    appointments: { client_id: "c-1", starts_at: "2031-05-12T19:00:00Z", duration_minutes: 30, service_id: "sv-1" },
    clients: { name: "Synthetic Client", email: EMAIL },
    services: { name: "Synthetic Service" },
  };
  return {
    createClient: async () => ({
      from: (table: string) => {
        const q = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
        };
        return q;
      },
    }),
  };
});
vi.mock("@/lib/email/send-appointment", () => ({
  logEmailFailure: vi.fn(),
  recordEmailAttempt: vi.fn(),
  sendBookingConfirmationToClient: vi.fn(),
  sendBookingNotificationToPractitioner: vi.fn(),
  sendCancellationEmail: state.sendCancellationEmail,
  sendPostcareToClient: vi.fn(),
}));

import { cancelAppointmentAction } from "@/app/(app)/calendar/actions";

function form(): FormData {
  const fd = new FormData();
  fd.set("appointment_id", "a-1");
  return fd;
}

function logged(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls
    .map((args: unknown[]) =>
      args
        .map((a: unknown) =>
          a instanceof Error ? `${a.name}|${a.message}|${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a),
        )
        .join(" "),
    )
    .join("\n");
}

let errorSpy: { mock: { calls: unknown[][] }; mockClear: () => void; mockRestore: () => void };
beforeEach(() => {
  state.sendCancellationEmail.mockReset();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe("client cancel notification failure log (MSG-LOG-RAW-ERROR)", () => {
  it("a thrown error quoting a phone and email never reaches the log; the cancel still succeeds", async () => {
    state.sendCancellationEmail.mockRejectedValue(new Error(`Invalid recipient: ${PHONE} / ${EMAIL}`));
    await expect(cancelAppointmentAction(form())).resolves.toEqual({ ok: true });
    expect(state.sendCancellationEmail).toHaveBeenCalledTimes(1);
    const out = logged(errorSpy);
    expect(out).not.toContain(PHONE);
    expect(out).not.toContain("555");
    expect(out).not.toContain(EMAIL);
    expect(out).not.toContain("Invalid recipient");
    expect(out).toContain("client_cancel_notification_email_failed");
    for (const call of errorSpy.mock.calls) {
      for (const arg of call) expect(arg).not.toBeInstanceOf(Error);
    }
  });

  it("logs a closed error name, and folds an unknown name into 'other'", async () => {
    state.sendCancellationEmail.mockRejectedValueOnce(new TypeError(`fetch failed for ${EMAIL}`));
    await cancelAppointmentAction(form());
    expect(logged(errorSpy)).toMatch(/"error_name":"TypeError"/);

    errorSpy.mockClear();
    const custom = new Error("x");
    custom.name = `Leak ${EMAIL}`;
    state.sendCancellationEmail.mockRejectedValueOnce(custom);
    await cancelAppointmentAction(form());
    const out = logged(errorSpy);
    expect(out).toMatch(/"error_name":"other"/);
    expect(out).not.toContain(EMAIL);
  });

  it("a thrown non-Error (string or object) is logged as its kind only", async () => {
    state.sendCancellationEmail.mockRejectedValueOnce(`raw ${PHONE}`);
    await cancelAppointmentAction(form());
    state.sendCancellationEmail.mockRejectedValueOnce({ to: EMAIL, message: PHONE });
    await cancelAppointmentAction(form());
    const out = logged(errorSpy);
    expect(out).toMatch(/"error_name":"non_error"/);
    expect(out).not.toContain(PHONE);
    expect(out).not.toContain(EMAIL);
  });

  it("no log line when the send resolves", async () => {
    state.sendCancellationEmail.mockResolvedValue({ ok: true });
    await expect(cancelAppointmentAction(form())).resolves.toEqual({ ok: true });
    expect(logged(errorSpy)).not.toContain("client_cancel_notification_email_failed");
  });
});
