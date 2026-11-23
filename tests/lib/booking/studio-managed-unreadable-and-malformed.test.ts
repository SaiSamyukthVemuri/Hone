import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clientSelfServicePolicyFromStudio,
  studioManagesAppointments,
} from "@/lib/booking/client-self-service-policy";
import { loadClientSelfServicePolicy } from "@/lib/booking/client-self-service-policy-store";

// Two behaviours the studio-managed mode relies on and that nothing else pinned:
//   1. a policy that cannot be read WITHDRAWS the self-service links (it never opens a path);
//   2. a stored mode that is not exactly false (or absent) is treated as managed, never as off.

describe("a malformed stored mode is treated as managed", () => {
  it.each([true, "true", "false", "", "off", 0, 1, {}, []])("%j manages appointments", (value) => {
    expect(studioManagesAppointments({ studio_managed_appointments: value })).toBe(true);
    expect(clientSelfServicePolicyFromStudio({ studio_managed_appointments: value })).toEqual({
      cancellation: false,
      reschedule: false,
      portal: false,
    });
  });
  it.each([false, undefined, null])("%j leaves the saved preferences in force", (value) => {
    expect(studioManagesAppointments({ studio_managed_appointments: value })).toBe(false);
    expect(
      clientSelfServicePolicyFromStudio({ studio_managed_appointments: value, client_cancellation_enabled: false }),
    ).toEqual({ cancellation: false, reschedule: true, portal: true });
  });
  it("a studio row without the column (before the rollout) and no row at all do not manage", () => {
    expect(studioManagesAppointments({})).toBe(false);
    expect(studioManagesAppointments(null)).toBe(false);
    expect(studioManagesAppointments(undefined)).toBe(false);
  });
});

function reader(answer: { data: Record<string, unknown> | null; error: { code?: string | null } | null }) {
  return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => answer }) }) }) };
}

describe("an unreadable policy is not an answer that opens anything", () => {
  beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());
  it("a read error, a missing row and a missing studio id are all not-ok, and log only a code", async () => {
    const privateText = "row data patient@example.test";
    const cases = [
      await loadClientSelfServicePolicy(reader({ data: null, error: { code: "57014" } }), "studio"),
      await loadClientSelfServicePolicy(reader({ data: null, error: null }), "studio"),
      await loadClientSelfServicePolicy(reader({ data: { name: privateText }, error: null }), ""),
      await loadClientSelfServicePolicy(reader({ data: { name: privateText }, error: null }), null),
    ];
    expect(cases).toEqual([{ ok: false }, { ok: false }, { ok: false }, { ok: false }]);
    for (const call of (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
      expect(JSON.stringify(call)).not.toContain(privateText);
    }
  });
  it("a readable row with the mode on is ok and refuses every self-service path", async () => {
    const read = await loadClientSelfServicePolicy(
      reader({ data: { name: "Synthetic Studio", studio_managed_appointments: true }, error: null }),
      "studio",
    );
    expect(read).toEqual({ ok: true, policy: { cancellation: false, reschedule: false, portal: false }, studioName: "Synthetic Studio" });
  });
});

describe("reminders: an unreadable policy withdraws the links", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_ORIGIN", "https://app.harness.local");
    vi.stubEnv("APPOINTMENT_SIGNING_SECRET", "synthetic-appointment-secret-32-bytes");
    vi.stubEnv("INTAKE_SIGNING_SECRET", "synthetic-intake-secret-32-bytes");
  });
  afterEach(() => vi.unstubAllEnvs());
  const projection = () => ({
    appointment: { id: "appointment-1", studio_id: "studio", client_id: "client", status: "confirmed" as const, starts_at: "2026-10-23T12:00:00.000Z", ends_at: "2026-10-23T13:00:00.000Z", duration_minutes: 60 },
    client: { id: "client", name: "Synthetic Client", email: "client@harness.local" },
    studio: { id: "studio", name: "Synthetic Studio", address: "1 Synthetic Street", slug: "synthetic-studio", timezone: "America/Toronto", owner_email: null, postcare_contact_email: null },
    service: null, practitioner: null, treatmentTime: null, intake: null, attachments: null,
  });
  const links = /\/(cancel|reschedule|portal)\//;

  it("the hold is decided as managed for an error, a missing row and a managed studio, and open only for a readable studio that is not", async () => {
    const { resolveOperationStudioManaged } = await import("@/lib/email/send-appointment");
    expect(resolveOperationStudioManaged({ data: null, error: { code: "57014", message: "private" } })).toBe(true);
    expect(resolveOperationStudioManaged({ data: null, error: null })).toBe(true);
    expect(resolveOperationStudioManaged({ data: { studio_managed_appointments: true }, error: null })).toBe(true);
    expect(resolveOperationStudioManaged({ data: { studio_managed_appointments: "garbage" }, error: null })).toBe(true);
    expect(resolveOperationStudioManaged({ data: { studio_managed_appointments: false }, error: null })).toBe(false);
    expect(resolveOperationStudioManaged({ data: {}, error: null })).toBe(false);
  });

  it("a reminder composed from an unreadable policy carries no cancel, reschedule or portal link, and still carries the appointment", async () => {
    const { buildAppointmentEmailOperationPayload, resolveOperationStudioManaged } = await import("@/lib/email/send-appointment");
    const hold = resolveOperationStudioManaged({ data: null, error: { code: "57014" } });
    const payload = buildAppointmentEmailOperationPayload(projection() as never, "reminder_24h", "appointment-1", "both", undefined, false, hold) as { html: string; text: string };
    expect(payload).not.toBeNull();
    expect(payload.html).not.toMatch(links);
    expect(payload.text).not.toMatch(links);
    expect(payload.text).toContain("Synthetic Studio");
    // and the same reminder with a readable, unmanaged studio keeps them (the check above is not vacuous)
    const open = buildAppointmentEmailOperationPayload(projection() as never, "reminder_24h", "appointment-1", "both", undefined, true, false) as { html: string };
    expect(open.html).toMatch(/\/(cancel|reschedule)\//);
  });
});
