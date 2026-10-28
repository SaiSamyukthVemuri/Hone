import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detectReminderAuthorityMode } from "@/lib/email/reminder-authority-mode";
import type { SupabaseClient } from "@supabase/supabase-js";

// 0247 compatibility. (1) The mode probe: which email authority the database has.
// (2) Render parity: the operation-path email must make the SAME disclosure
// decisions the legacy reminder makes (address visibility, self-service links),
// because the SQL projection does not carry them. Synthetic data only.

vi.mock("server-only", () => ({}));

const NIL = "00000000-0000-0000-0000-000000000000";

function adminWith(answer: () => Promise<{ data: unknown; error: unknown }>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const admin = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return answer();
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

describe("detectReminderAuthorityMode", () => {
  it("an answering inspect RPC means the OPERATION authority (0247 applied)", async () => {
    const { admin, calls } = adminWith(async () => ({ data: { kind: "held", reason: "not_found" }, error: null }));
    expect(await detectReminderAuthorityMode(admin)).toBe("operation");
    expect(calls).toEqual([
      { fn: "inspect_appointment_email_operation", args: { p_studio_id: NIL, p_appointment_id: NIL, p_purpose: "reminder_24h" } },
    ]);
  });

  it.each(["PGRST202", "42883"])("a missing function (%s) means LEGACY (0247 not applied)", async (code) => {
    const { admin } = adminWith(async () => ({ data: null, error: { code, message: "could not find the function" } }));
    expect(await detectReminderAuthorityMode(admin)).toBe("legacy");
  });

  it.each([
    ["permission denied", { code: "42501", message: "permission denied for function" }],
    ["timeout", { code: "57014", message: "canceling statement due to statement timeout" }],
    ["server error", { code: "PGRST000", message: "connection" }],
    ["no code", { message: "function inspect_appointment_email_operation does not exist" }],
    ["empty error", {}],
  ])("%s is UNAVAILABLE, never legacy (a message is not a code)", async (_label, error) => {
    const { admin } = adminWith(async () => ({ data: null, error }));
    expect(await detectReminderAuthorityMode(admin)).toBe("unavailable");
  });

  it.each([null, undefined, "ok", 7, [], {}, { kind: 3 }])("an unexpected answer shape (%j) is UNAVAILABLE", async (data) => {
    const { admin } = adminWith(async () => ({ data, error: null }));
    expect(await detectReminderAuthorityMode(admin)).toBe("unavailable");
  });

  it("a thrown or rejected call is UNAVAILABLE", async () => {
    const { admin } = adminWith(async () => { throw new Error("network"); });
    expect(await detectReminderAuthorityMode(admin)).toBe("unavailable");
  });

  it("never calls a legacy RPC", async () => {
    const { admin, calls } = adminWith(async () => ({ data: { kind: "held" }, error: null }));
    await detectReminderAuthorityMode(admin);
    expect(calls.map((c) => c.fn).filter((f) => /claim_email_send|record_email_result/.test(f))).toEqual([]);
  });
});

describe("operation-path render parity with the legacy reminder", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", "https://example.invalid");
    vi.stubEnv("APPOINTMENT_SIGNING_SECRET", "synthetic-appointment-secret-32-bytes");
    vi.stubEnv("INTAKE_SIGNING_SECRET", "synthetic-intake-secret-32-bytes");
  });
  afterEach(() => vi.unstubAllEnvs());

  const projection = (studio: Record<string, unknown> = {}) => ({
    appointment: { id: "appointment-1", studio_id: "studio", client_id: "client", status: "confirmed" as const, starts_at: "2026-10-23T12:00:00.000Z", ends_at: "2026-10-23T13:00:00.000Z", duration_minutes: 60, service_id: null, practitioner_id: null },
    client: { id: "client", name: "Synthetic Client", email: "client@harness.local" },
    studio: { id: "studio", name: "Original studio", address: "1 Synthetic Street", slug: "original-studio", timezone: "America/Toronto", owner_email: null, postcare_contact_email: null, show_treatment_time_to_clients: false, send_24h_reminders: true, send_2h_reminders: true, send_intake_reminders: true, client_cancellation_enabled: true, client_reschedule_enabled: true, ...studio },
    service: null, practitioner: null, treatmentTime: null, intake: null, attachments: null,
  });

  async function render(studio: Record<string, unknown>, visibility: unknown) {
    const { buildAppointmentEmailOperationPayload } = await import("@/lib/email/send-appointment");
    const payload = buildAppointmentEmailOperationPayload(projection(studio) as never, "reminder_24h", "appointment-1", visibility);
    expect(payload).not.toBeNull();
    const p = payload as unknown as { subject: string; html: string; text: string };
    return { ...p, all: `${p.subject}\n${p.html}\n${p.text}` };
  }

  it.each([
    ["booking_page", false],
    ["emails", true],
    ["both", true],
    [undefined, true], // the column default, as the legacy renderer reads it
    ["not-a-value", true],
  ])("address visibility %s -> address in email: %s (same rule as the legacy renderer)", async (visibility, shown) => {
    const { all } = await render({}, visibility);
    expect(all.includes("1 Synthetic Street")).toBe(shown);
  });

  it("an unreadable visibility hides the address (less disclosure, never more)", async () => {
    // The caller passes "booking_page" when the studio read fails; proved at the caller below.
    const { all } = await render({}, "booking_page");
    expect(all).not.toContain("1 Synthetic Street");
  });

  it("cancel and reschedule links follow the studio flags; reminders still render", async () => {
    const on = await render({}, "both");
    expect(on.all).toContain("/cancel/");
    expect(on.all).toContain("/reschedule/");
    const off = await render({ client_cancellation_enabled: false, client_reschedule_enabled: false }, "both");
    expect(off.all).not.toContain("/cancel/");
    expect(off.all).not.toContain("/reschedule/");
    expect(off.html).toContain("Original studio");
    const cancelOnly = await render({ client_reschedule_enabled: false }, "both");
    expect(cancelOnly.all).toContain("/cancel/");
    expect(cancelOnly.all).not.toContain("/reschedule/");
  });

  it("null flags (pre-0234 rows) mean links ON, as everywhere else", async () => {
    const { all } = await render({ client_cancellation_enabled: null, client_reschedule_enabled: null }, "both");
    expect(all).toContain("/cancel/");
    expect(all).toContain("/reschedule/");
  });

  it("the booking reference is derived from the appointment id, as in the legacy subject", async () => {
    const { emailBookingReference } = await import("@/lib/email/booking-reference");
    const { subject } = await render({}, "both");
    expect(subject).toContain(emailBookingReference("appointment-1"));
  });
});

describe("resolveOperationAddressVisibility", () => {
  const miss = { code: "42703", message: "column studios.address_visibility does not exist" };
  it("an undefined address_visibility column is the legacy default: address shown", async () => {
    const { resolveOperationAddressVisibility } = await import("@/lib/email/send-appointment");
    const { appointmentEmailAddress } = await import("@/lib/booking/studio-location");
    const v = resolveOperationAddressVisibility({ data: null, error: miss });
    expect(v).toBe("both");
    expect(appointmentEmailAddress({ address: "1 Test St", address_visibility: v } as never)).toBe("1 Test St");
  });
  it("PostgREST schema-cache miss for the column is the same", async () => {
    const { resolveOperationAddressVisibility } = await import("@/lib/email/send-appointment");
    expect(resolveOperationAddressVisibility({ data: null, error: { code: "PGRST204", message: "Could not find the 'address_visibility' column of 'studios' in the schema cache" } })).toBe("both");
  });
  it("any other read failure hides the address", async () => {
    const { resolveOperationAddressVisibility } = await import("@/lib/email/send-appointment");
    expect(resolveOperationAddressVisibility({ data: null, error: { code: "57014", message: "statement timeout" } })).toBe("booking_page");
    expect(resolveOperationAddressVisibility({ data: null, error: { code: "42703", message: "column studios.other does not exist" } })).toBe("booking_page");
  });
  it("a missing row hides; a present value passes through; an absent key is the default", async () => {
    const { resolveOperationAddressVisibility } = await import("@/lib/email/send-appointment");
    const { appointmentEmailAddress } = await import("@/lib/booking/studio-location");
    expect(resolveOperationAddressVisibility({ data: null, error: null })).toBe("booking_page");
    expect(resolveOperationAddressVisibility({ data: { address_visibility: "booking_page" }, error: null })).toBe("booking_page");
    const absent = resolveOperationAddressVisibility({ data: {}, error: null });
    expect(appointmentEmailAddress({ address: "1 Test St", address_visibility: absent } as never)).toBe("1 Test St");
  });
});

describe("operation caller reads address visibility before freezing the request", () => {
  it("a failed studio read renders no address and a successful one renders per visibility (source contract)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/email/send-appointment.ts", "utf8");
    const i = src.indexOf("export async function sendAppointmentReminderOperation");
    const body = src.slice(i);
    expect(body).toMatch(/from\("studios"\)\.select\("address_visibility"\)/);
    expect(body).toMatch(/resolveOperationAddressVisibility\(/);
    expect(body.indexOf('from("studios")')).toBeLessThan(body.indexOf("adapter.freeze("));
  });
});
