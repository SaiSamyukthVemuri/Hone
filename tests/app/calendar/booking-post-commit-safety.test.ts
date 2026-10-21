import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR B Part 4 Item 8 — regression guard for the three defects the adversarial
// review confirmed in the booking action: a post-commit dispatch that could
// falsely fail a committed booking, and two raw-DB-message leaks to the browser.

const ACTIONS = readFileSync(
  join(process.cwd(), "app/(app)/calendar/actions.ts"),
  "utf8",
);

const booking = vi.hoisted(() => ({
  assignedId: "B",
  assigned: { id: "B", studio_id: "studio", active: true, display_name: "Assigned B", email: "b@example.test" },
  lookupError: false,
  slotError: null as unknown,
  capacityEnabled: true as boolean | null | undefined,
  emptySlots: false,
  onSlotsRead: null as null | (() => void),
  rpcResult: "created",
  rpcError: null as null | { code: string },
  clientEmail: vi.fn(async () => ({ ok: true })),
  practitionerEmail: vi.fn(async () => ({ ok: true })),
  rpc: vi.fn(async () => ({ data: [{ result: booking.rpcResult, appointment_id: "appointment" }], error: booking.rpcError })),
  event: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: async () => ({
  practitioner: { id: "A", role: "owner", active: true, display_name: "Owner A", email: "a@example.test" },
  studio: { id: "studio", timezone: "America/Toronto", practitioner_capacity_enabled: booking.capacityEnabled,
    default_appointment_duration_minutes: 60, buffer_minutes: 0, send_confirmation_emails: true },
}) }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc: booking.rpc }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: (table: string) => {
  const filters: Record<string, unknown> = {};
  const query: Record<string, unknown> = {
    select: () => query,
    eq: (key: string, value: unknown) => { filters[key] = value; return query; },
    maybeSingle: async () => {
      if (table === "services") return { data: { id: "service", default_duration_minutes: 60 }, error: null };
      if (table === "clients") return { data: { id: "client", name: "Synthetic Client", email: "client@example.test", phone: null }, error: null };
      if (table === "appointments") return { data: { id: "appointment", client_id: "client", practitioner_id: booking.assignedId, starts_at: "2099-01-01T15:00:00.000Z" }, error: null };
      if (booking.lookupError) return { data: null, error: { message: "synthetic private lookup detail" } };
      const assigned = booking.assigned as Record<string, unknown>;
      return { data: Object.entries(filters).every(([k, v]) => assigned[k] === v) ? assigned : null, error: null };
    },
  };
  return query;
} }) }));
vi.mock("@/lib/booking/slots", () => ({ INTERNAL_SLOT_PACKING: {}, getAvailableSlots: async () => { booking.onSlotsRead?.(); if (booking.slotError !== null) throw booking.slotError; return booking.emptySlots ? [] : [{ start: "2099-01-01T15:00:00.000Z", end: "2099-01-01T16:00:00.000Z" }]; } }));
vi.mock("@/lib/booking/appointment-token", () => ({ generateAppointmentToken: () => "synthetic", hashAppointmentToken: () => "hash" }));
vi.mock("@/lib/booking/tokens", () => ({ generateCancellationToken: () => "synthetic" }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: booking.event }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://synthetic.example.test" }));
vi.mock("@/lib/intake/queries", () => ({ ensureIntakeForClient: async () => null }));
vi.mock("@/lib/email/send-appointment", () => ({
  sendBookingConfirmationToClient: booking.clientEmail,
  sendBookingNotificationToPractitioner: booking.practitionerEmail,
  recordEmailAttempt: vi.fn(), logEmailFailure: vi.fn(),
  sendCancellationEmail: vi.fn(), sendPostcareToClient: vi.fn(),
}));
vi.mock("@/lib/sms/send-appointment", () => ({ sendBookingConfirmationSmsToClient: vi.fn() }));

import { bookAppointmentForClientAction } from "@/app/(app)/calendar/actions";
import { fetchSlotsForClientBookingAction } from "@/app/(app)/clients/[id]/booking-actions";

function bookFor(target = "B") {
  const form = new FormData();
  for (const [key, value] of Object.entries({ client_id: "client", service_id: "service", starts_at: "2099-01-01T15:00:00.000Z", practitioner_id: target })) form.set(key, value);
  return bookAppointmentForClientAction(form);
}

beforeEach(() => {
  booking.onSlotsRead = null;
  booking.capacityEnabled = true;
  booking.slotError = null; booking.emptySlots = false; booking.rpcResult = "created"; booking.rpcError = null;
  vi.clearAllMocks(); booking.assignedId = "B"; booking.lookupError = false;
  booking.assigned = { id: "B", studio_id: "studio", active: true, display_name: "Assigned B", email: "b@example.test" };
});

describe("SCH-001 assigned notification context preserves booking actor", () => {
  it("owner A books B: client context and practitioner recipient name B, but audit/authorization actor stays A", async () => {
    expect(await bookFor()).toEqual({ ok: true, appointmentId: "appointment" });
    expect(booking.rpc).toHaveBeenCalledWith("create_internal_appointment_v2", expect.objectContaining({ p_actor_practitioner_id: "A", p_target_practitioner_id: "B" }));
    expect(booking.clientEmail).toHaveBeenCalledWith(expect.objectContaining({ practitionerDisplayName: "Assigned B" }));
    expect(booking.practitionerEmail).toHaveBeenCalledWith(expect.objectContaining({ practitionerName: "Assigned B", practitionerEmail: "b@example.test" }));
    expect(booking.event).toHaveBeenCalledWith(expect.objectContaining({ actor: { kind: "user", id: "A" } }));
  });

  it("uses the committed assignment rather than trusting a submitted target for notification", async () => {
    await bookFor("submitted-target");
    expect(booking.practitionerEmail).toHaveBeenCalledWith(expect.objectContaining({ practitionerEmail: "b@example.test" }));
  });

  it.each(["foreign", "inactive", "lookup error"])("never falls back to notifying the actor when assigned contact is %s", async (mode) => {
    if (mode === "foreign") booking.assigned.studio_id = "other-studio";
    if (mode === "inactive") booking.assigned.active = false;
    if (mode === "lookup error") booking.lookupError = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await bookFor()).toEqual({ ok: true, appointmentId: "appointment" });
      expect(booking.clientEmail).not.toHaveBeenCalled();
      expect(booking.practitionerEmail).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic private lookup detail");
    } finally { log.mockRestore(); }
  });

  it("retains self-assigned owner notifications", async () => {
    booking.assignedId = "A";
    booking.assigned = { ...booking.assigned, id: "A", display_name: "Owner A", email: "a@example.test" };
    await bookFor("A");
    expect(booking.practitionerEmail).toHaveBeenCalledWith(expect.objectContaining({ practitionerEmail: "a@example.test" }));
  });
});

describe("booking action — post-commit + safe-error hardening (Item 8)", () => {
  it("the post-commit notification dispatch is fail-open (a throw never fails a committed booking)", () => {
    // dispatchBookingEmails must be wrapped so a throwing helper cannot reject
    // the already-committed booking.
    expect(ACTIONS).toMatch(/try \{\s*\n\s*await dispatchBookingEmails\(/);
    expect(ACTIONS).toMatch(/booking_action_post_commit_error:dispatch:/);
  });

  it("no server action returns a raw Postgres/PostgREST message to the browser", () => {
    // No `error: <x>.message`, no `err.message` returned, no `${...message}` copy.
    expect(ACTIONS.match(/error:\s*[\w?.]*\.message/g) ?? []).toEqual([]);
    expect(ACTIONS.match(/err instanceof Error \? err\.message/g) ?? []).toEqual([]);
    expect(ACTIONS.match(/\$\{[^}]*\.message\}/g) ?? []).toEqual([]);
  });

  it("the new-client + last-service helpers log a bounded SQLSTATE and return fixed copy", () => {
    expect(ACTIONS).toMatch(/logBookingDbError\("create_client", "insert", error\?\.code\)/);
    expect(ACTIONS).toMatch(/Could not create the client\. Please try again\./);
    expect(ACTIONS).toMatch(/logBookingDbError\("last_service", "query", error\.code\)/);
    expect(ACTIONS).toMatch(/Could not load the last service\. Please try again\./);
  });
});


describe("SCH-002 internal submit advisory availability failures", () => {
  it.each(["blockouts", "reservations", "window", "defaults"])("refuses a failed %s preflight even when the ON pre-read command would accept", async (stage) => {
    booking.slotError = new Error(`availability_read_failed:${stage}`);
    await expect(bookFor()).rejects.toBe(booking.slotError);
    expect(booking.rpc).not.toHaveBeenCalled();
  });
  it("preserves authoritative refusal after a successful offered-slot read", async () => {
    booking.rpcResult = "time_unavailable";
    expect(await bookFor()).toMatchObject({ ok: false }); expect(booking.rpc).toHaveBeenCalledTimes(1);
    expect(booking.clientEmail).not.toHaveBeenCalled();
  });
  it.each(["23514", "42501"])("preserves command error %s after a successful offered-slot read", async (code) => {
    booking.rpcError = { code };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect(await bookFor()).toMatchObject({ ok: false }); expect(booking.rpc).toHaveBeenCalledTimes(1); expect(booking.clientEmail).not.toHaveBeenCalled(); }
    finally { log.mockRestore(); }
  });
  it("refuses successfully read empty slots without calling the command", async () => {
    booking.emptySlots = true;
    expect(await bookFor()).toMatchObject({ ok: false }); expect(booking.rpc).not.toHaveBeenCalled();
  });
  it.each([new Error("unexpected programming error"), "availability_read_failed:blockouts"])("propagates unclassified/non-Error throws without command", async (failure) => {
    booking.slotError = failure;
    await expect(bookFor()).rejects.toBe(failure); expect(booking.rpc).not.toHaveBeenCalled();
  });
});


describe("SCH-002 legacy internal submission retains the app availability boundary", () => {
  it.each([false, null, undefined])("does not defer a failed preflight when capacity is %s, even if the command would accept", async (capacity) => {
    booking.capacityEnabled = capacity;
    const failure = new Error("availability_read_failed:window"); booking.slotError = failure;
    await expect(bookFor()).rejects.toBe(failure);
    expect(booking.rpc).not.toHaveBeenCalled();
    expect(booking.clientEmail).not.toHaveBeenCalled();
    expect(booking.practitionerEmail).not.toHaveBeenCalled();
  });
  it.each(["blockouts", "reservations"])("also refuses unread %s in legacy mode before the permissive legacy command", async (stage) => {
    booking.capacityEnabled = false;
    const failure = new Error(`availability_read_failed:${stage}`); booking.slotError = failure;
    await expect(bookFor()).rejects.toBe(failure); expect(booking.rpc).not.toHaveBeenCalled();
  });
  it("does not use an ON pre-read as authority if capacity flips OFF before the command", async () => {
    booking.capacityEnabled = true;
    booking.onSlotsRead = () => { booking.capacityEnabled = false; };
    const failure = new Error("availability_read_failed:window"); booking.slotError = failure;
    await expect(bookFor()).rejects.toBe(failure);
    expect(booking.capacityEnabled).toBe(false);
    expect(booking.rpc).not.toHaveBeenCalled();
    expect(booking.clientEmail).not.toHaveBeenCalled();
  });
  it("retains ordinary legacy submission after a successful offered-slot read", async () => {
    booking.capacityEnabled = false;
    expect(await bookFor("A")).toEqual({ ok: true, appointmentId: "appointment" });
    expect(booking.rpc).toHaveBeenCalledWith("create_internal_appointment_v2", expect.objectContaining({ p_actor_practitioner_id: "A", p_target_practitioner_id: "A", p_allow_outside_availability: false }));
  });
});


describe("SCH-002 internal client discovery uses its typed retryable refusal", () => {
  const discover = () => fetchSlotsForClientBookingAction({ serviceId: "service", date: "2099-01-01" });
  it.each(["blockouts", "window", "reservations"])("returns only sanitized failure for unread %s, never available/empty slots", async (stage) => {
    booking.slotError = new Error(`availability_read_failed:${stage}:PRIVATE_SENTINEL`);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await discover()).toEqual({ ok: false, error: "Could not load times. Please try again.", code: "could_not_load_times" });
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_SENTINEL"); expect(booking.rpc).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it.each([new Error("unexpected discovery error"), "availability_read_failed:blockouts"])("does not absorb unrelated/non-Error discovery throws", async (failure) => {
    booking.slotError = failure;
    await expect(discover()).rejects.toBe(failure); expect(booking.rpc).not.toHaveBeenCalled();
  });
  it("retains genuinely empty discovery as successful empty", async () => {
    booking.emptySlots = true;
    expect(await discover()).toEqual({ ok: true, slots: [] }); expect(booking.rpc).not.toHaveBeenCalled();
  });
  it("retains invalid-target refusal before any failing slot read", async () => {
    booking.slotError = new Error("availability_read_failed:window"); booking.onSlotsRead = vi.fn();
    expect(await fetchSlotsForClientBookingAction({ serviceId: "service", date: "2099-01-01", practitionerId: "FOREIGN" })).toEqual({ ok: false, error: "That practitioner isn't available.", code: "invalid_practitioner" });
    expect(booking.onSlotsRead).not.toHaveBeenCalled(); expect(booking.rpc).not.toHaveBeenCalled();
  });
  it("retains a successful slot read without any booking command", async () => {
    expect(await discover()).toEqual({ ok: true, slots: [{ start: "2099-01-01T15:00:00.000Z", end: "2099-01-01T16:00:00.000Z" }] });
    expect(booking.rpc).not.toHaveBeenCalled();
  });
});
