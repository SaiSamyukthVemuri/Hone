import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchParams } from "@/lib/booking/booking-notifications";

// Real dispatcher, policy links, SMS consent/fence/claim/transport flow.
// Only email/preparation/database and the provider network are fake.
const h = vi.hoisted(() => ({
  emails: [] as Record<string, unknown>[],
  emailRecords: [] as boolean[],
  emailOk: true,
  preparationFailure: "none" as "none" | "context" | "intake",
  failures: [] as Record<string, unknown>[],
  practitioner: [] as Record<string, unknown>[],
  allowPractitioner: false,
  recordThrows: false,
  intakeCalls: 0,
  claim: true,
  rpc: [] as Array<[string, Record<string, unknown>]>,
}));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://hone.test" }));
vi.mock("@/lib/booking/tokens", () => ({ generateCancellationToken: () => "fake-token" }));
vi.mock("@/lib/intake/queries", () => ({ ensureIntakeForClient: async () => {
  h.intakeCalls++;
  if (h.preparationFailure === "intake") throw new Error("SYNTHETIC_PRIVATE_CONTEXT client@example.invalid");
  return { url: "https://hone.test/intake/fake-intake" };
} }));
vi.mock("@/lib/treatment-time/queries", () => ({
  getTreatmentTimeContextForEmail: async () => {
    if (h.preparationFailure === "context") throw new Error("SYNTHETIC_PRIVATE_CONTEXT client@example.invalid");
    return {};
  }, buildTreatmentTimeLine: () => null,
}));
vi.mock("@/lib/email/send-appointment", () => ({
  sendBookingConfirmationToClient: async (p: Record<string, unknown>) => {
    h.emails.push(p);
    return h.emailOk ? { ok: true, messageId: "fake-email" } : { ok: false, error: "fake refusal", retryable: false };
  },
  recordEmailAttempt: async (_admin: unknown, _id: string, _type: string, ok: boolean) => {
    h.emailRecords.push(ok);
    if (h.recordThrows) throw new Error("SYNTHETIC_PRIVATE_RECORD client@example.invalid");
  },
  logEmailFailure: (p: Record<string, unknown>) => { h.failures.push(p); },
  sendBookingNotificationToPractitioner: async (p: Record<string, unknown>) => {
    if (!h.allowPractitioner) throw new Error("unexpected practitioner email");
    h.practitioner.push(p);
    return { ok: true, messageId: "fake-practitioner-email" };
  },
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: async () => undefined }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({
  rpc: (fn: string, args: Record<string, unknown>) => {
    h.rpc.push([fn, args]);
    return Promise.resolve({ data: fn === "claim_sms_send" ? h.claim : null, error: null });
  },
}) }));

import { dispatchBookingNotifications } from "@/lib/booking/booking-notifications";
import { STUDIO_ROUTING_ENV } from "@/lib/sms/send-time-route";

const SID = `SM${"0f".repeat(16)}`;
let fetchMock: ReturnType<typeof vi.fn>;
const params = (): DispatchParams => ({
  appointment: { id: "appt-1", client_id: "client-1", studio_id: "studio-1", starts_at: "2026-10-25T15:00:00Z" },
  service: { name: "Synthetic service" },
  studio: { id: "studio-1", name: "Synthetic studio", timezone: "America/Toronto",
    send_confirmation_emails: false, send_confirmation_sms: true,
    notify_practitioner_on_new_booking: false, show_treatment_time_to_clients: false,
    client_cancellation_enabled: false, client_reschedule_enabled: false },
  clientName: "Synthetic client", clientEmail: "client@example.invalid", clientPhone: "+16475550123",
  clientSmsConsentAt: "2026-10-01T00:00:00Z", clientSmsOptedOutAt: null,
  practitionerName: "Synthetic practitioner", practitionerEmail: "staff@example.invalid", notes: null,
} as DispatchParams);
const bodies = () => fetchMock.mock.calls.map(([, init]) => new URLSearchParams((init as RequestInit).body as string).get("Body"));

beforeEach(() => {
  h.preparationFailure = "none"; h.failures = []; h.practitioner = [];
  h.allowPractitioner = false; h.recordThrows = false;
  h.emails = []; h.emailRecords = []; h.intakeCalls = 0; h.claim = true; h.emailOk = true; h.rpc = [];
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"1".repeat(32)}`);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "fake-token");
  vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001111");
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "");
  vi.stubEnv(STUDIO_ROUTING_ENV, "");
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: SID }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("post-commit confirmation channels remain independent (4310083201)", () => {
  it.each(["client@example.invalid", null])("email off/absent (%s) still sends consented SMS with neutral policy link", async (email) => {
    const p = params(); p.clientEmail = email;
    await dispatchBookingNotifications(p);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.emails).toHaveLength(0);
    expect(h.intakeCalls).toBe(0);
    expect(bodies()[0]).toContain("https://hone.test/manage/fake-token");
    expect(bodies()[0]).not.toMatch(/\/(cancel|reschedule)\//);
    expect(h.rpc.map(([fn]) => fn)).toContain("claim_sms_send");
    expect(h.rpc.map(([fn]) => fn)).toContain("record_sms_result");
  });
  it("both channels share one available intake URL and suppress disabled email links", async () => {
    const p = params(); p.studio.send_confirmation_emails = true;
    await dispatchBookingNotifications(p);
    expect(h.emails).toHaveLength(1); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.intakeCalls).toBe(1);
    expect(h.emails[0]).toMatchObject({ intakeUrl: "https://hone.test/intake/fake-intake", cancellationUrl: null, rescheduleUrl: null });
    expect(bodies()[0]).toContain("https://hone.test/intake/fake-intake");
    expect(h.emailRecords).toEqual([true]);
  });
  it("SMS off does not suppress an enabled email", async () => {
    const p = params(); p.studio.send_confirmation_emails = true; p.studio.send_confirmation_sms = false;
    await dispatchBookingNotifications(p);
    expect(h.emails).toHaveLength(1); expect(fetchMock).not.toHaveBeenCalled();
    expect(h.rpc).toHaveLength(0);
  });
  it.each(["no-consent", "opted-out", "invalid-phone", "no-phone", "sms-off", "preview"])("preserves the independent %s refusal before claim/provider", async (mode) => {
    const p = params();
    if (mode === "no-consent") p.clientSmsConsentAt = null;
    if (mode === "opted-out") p.clientSmsOptedOutAt = "2026-10-02T00:00:00Z";
    if (mode === "invalid-phone") p.clientPhone = "bad-phone";
    if (mode === "no-phone") p.clientPhone = null;
    if (mode === "sms-off") p.studio.send_confirmation_sms = false;
    if (mode === "preview") vi.stubEnv("VERCEL_ENV", "preview");
    await dispatchBookingNotifications(p);
    expect(fetchMock).not.toHaveBeenCalled(); expect(h.rpc).toHaveLength(0);
    expect(h.emails).toHaveLength(0);
  });
  it("claim refusal still prevents any provider attempt", async () => {
    h.claim = false;
    await dispatchBookingNotifications(params());
    expect(h.rpc.map(([fn]) => fn)).toEqual(["claim_sms_send"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("a fake provider refusal records failure without retrying or failing the committed booking", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ code: 21211, message: "fake refusal" }), { status: 400 }));
    await expect(dispatchBookingNotifications(params())).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.rpc.find(([fn]) => fn === "record_sms_result")?.[1]).toMatchObject({ p_success: false });
  });
  it("an email refusal result does not gate the independently enabled SMS", async () => {
    const p = params(); p.studio.send_confirmation_emails = true; h.emailOk = false;
    await dispatchBookingNotifications(p);
    expect(h.emailRecords).toEqual([false]); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


describe("email preparation failure stays inside its channel (4310174756)", () => {
  const enabled = () => {
    const p = params();
    p.studio.send_confirmation_emails = true;
    p.studio.show_treatment_time_to_clients = true;
    p.studio.notify_practitioner_on_new_booking = true;
    h.allowPractitioner = true;
    return p;
  };
  const safeObservability = () => {
    const observed = JSON.stringify({ failures: h.failures, logs: vi.mocked(console.error).mock.calls });
    expect(observed).not.toContain("SYNTHETIC_PRIVATE");
    expect(observed).not.toContain("client@example.invalid");
  };
  it.each(["context", "intake"] as const)("rejecting %s leaves email unsent/failed but dispatches SMS and practitioner", async (stage) => {
    const p = enabled(); h.preparationFailure = stage;
    await expect(dispatchBookingNotifications(p)).resolves.toBeUndefined();
    expect(h.emails).toHaveLength(0);
    expect(h.emailRecords).toEqual([false]);
    expect(h.failures).toEqual([expect.objectContaining({
      appointmentId: "appt-1", emailType: "confirmation", error: "confirmation_preparation_failed", retryable: true,
    })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.rpc.filter(([fn]) => fn === "claim_sms_send")).toHaveLength(1);
    expect(h.practitioner).toHaveLength(1);
    expect(bodies()[0]).toContain("https://hone.test/manage/fake-token");
    if (stage === "context") expect(bodies()[0]).toContain("https://hone.test/intake/fake-intake");
    else expect(bodies()[0]).not.toContain("/intake/");
    safeObservability();
  });
  it("a failed failure-record write also cannot suppress SMS/practitioner", async () => {
    const p = enabled(); h.preparationFailure = "context"; h.recordThrows = true;
    await expect(dispatchBookingNotifications(p)).resolves.toBeUndefined();
    expect(h.emails).toHaveLength(0); expect(h.emailRecords).toEqual([false]);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(h.practitioner).toHaveLength(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain("booking_confirmation_preparation_record_failed");
    safeObservability();
  });
  it("email prep failure does not bypass SMS consent or the practitioner toggle", async () => {
    const p = enabled(); h.preparationFailure = "context";
    p.clientSmsConsentAt = null; p.studio.notify_practitioner_on_new_booking = false;
    await expect(dispatchBookingNotifications(p)).resolves.toBeUndefined();
    expect(h.emailRecords).toEqual([false]); expect(h.emails).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled(); expect(h.rpc).toHaveLength(0);
    expect(h.practitioner).toHaveLength(0);
    safeObservability();
  });
});
