import { CLIENT_NAME_MAX } from "@/lib/clients/identity";
import { describe, expect, it, vi } from "vitest";
import { DESK_FIELD_MAX, DESK_NAME_ON_FILE, DESK_SCHEDULE_ROW_CAP, DeskScheduleIncompleteError, mapDeskScheduleRow, readDeskSchedule, type DeskRpc } from "@/lib/desk/read";

// The desk's read is a closed projection: it copies named fields only, including just the display name resolved by the versioned scheduling RPC.
// Fixtures are synthetic.

const STORED = "Zeta Stored-Surname";
const PREFERRED = "Preferred-Zeta";
const row = (over: Record<string, unknown> = {}) => ({
  appointment_id: "11111111-1111-4111-8111-111111111111",
  starts_at: "2099-01-01T15:00:00.000Z",
  ends_at: "2099-01-01T16:00:00.000Z",
  status: "confirmed",
  practitioner_id: "22222222-2222-4222-8222-222222222222",
  practitioner_display_name: "Practitioner One",
  practitioner_color: "teal",
  service_id: "33333333-3333-4333-8333-333333333333",
  service_name: "Consultation",
  client_id: "44444444-4444-4444-8444-444444444444",
  display_name: STORED,
  duration_minutes: 60,
  studio_timezone: "America/Toronto",
  ...over,
});
const dbOf = (data: unknown, error: unknown = null): DeskRpc => ({ rpc: vi.fn(async () => ({ data, error })) });

describe("the closed projection", () => {
  it("keeps the booking facts and nothing else", () => {
    expect(mapDeskScheduleRow(row())).toEqual({
      appointmentId: row().appointment_id,
      practitionerId: row().practitioner_id,
      practitionerColor: "teal",
      startsAt: "2099-01-01T15:00:00.000Z",
      endsAt: "2099-01-01T16:00:00.000Z",
      status: "confirmed",
      durationMinutes: 60,
      studioTimezone: "America/Toronto",
      practitionerName: "Practitioner One",
      serviceName: "Consultation",
      clientName: STORED,
    });
  });

  it("shows the scheduling name without projecting other identity or contact fields", () => {
    for (const displayName of [PREFERRED, STORED, "N".repeat(CLIENT_NAME_MAX)]) {
      const sample = row({ display_name: displayName, legal_name: "Private identity", phone: "555-0123" });
      const allowed = mapDeskScheduleRow(sample);
      expect(allowed?.clientName).toBe(displayName);
      for (const value of ["Private identity", sample.client_id, sample.service_id, "555-0123"]) expect(JSON.stringify(allowed)).not.toContain(value);
    }
    expect(mapDeskScheduleRow(row({ display_name: "  " }))?.clientName).toBe(DESK_NAME_ON_FILE);
  });

  it("keeps historical unassigned visits and validates appointment IDs and practitioner colors", () => {
    expect(mapDeskScheduleRow(row({ practitioner_id: null, practitioner_display_name: null }))).toMatchObject({ practitionerId: null, practitionerName: "Unassigned" });
    expect(mapDeskScheduleRow(row({ appointment_id: "invalid" }))).toBeNull();
    expect(mapDeskScheduleRow(row({ practitioner_color: "unrecognized" }))?.practitionerColor).toBeNull();
  });

  it("drops a row with no readable times, and reads an unknown status as unknown", () => {
    expect(mapDeskScheduleRow(row({ starts_at: "nope" }))).toBeNull();
    expect(mapDeskScheduleRow(row({ ends_at: null }))).toBeNull();
    expect(mapDeskScheduleRow(null)).toBeNull();
    expect(mapDeskScheduleRow("x")).toBeNull();
    expect(mapDeskScheduleRow(row({ status: "refunded: card declined" }))?.status).toBe("unknown");
    for (const s of ["confirmed", "completed", "cancelled", "no_show"]) expect(mapDeskScheduleRow(row({ status: s }))?.status).toBe(s);
  });

  it("bounds text fields, collapses whitespace and falls back for blanks", () => {
    const long = "x".repeat(500);
    const m = mapDeskScheduleRow(row({ service_name: `  A   ${long}  `, practitioner_display_name: "   ", studio_timezone: 5 }));
    expect(m?.serviceName.length).toBe(DESK_FIELD_MAX);
    expect(m?.serviceName.startsWith("A x")).toBe(true);
    expect(m?.practitionerName).toBe("Practitioner");
    expect(m?.studioTimezone).toBe("");
  });

  it("accepts only a sensible duration", () => {
    for (const d of [0, -5, 1.5, 1441, "60", null]) expect(mapDeskScheduleRow(row({ duration_minutes: d }))?.durationMinutes, String(d)).toBeNull();
    expect(mapDeskScheduleRow(row({ duration_minutes: 90 }))?.durationMinutes).toBe(90);
  });
});

describe("readDeskSchedule", () => {
  it("calls only the schedule function, with the studio and window, and maps every row", async () => {
    const db = dbOf([row(), row({ client_id: "x", starts_at: "2099-01-02T15:00:00.000Z" })]);
    const out = await readDeskSchedule(db, "studio-1", "2099-01-01T00:00:00.000Z", "2099-01-08T00:00:00.000Z");
    expect(out).toHaveLength(2);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith("receptionist_calendar_v3", { p_studio_id: "studio-1", p_from: "2099-01-01T00:00:00.000Z", p_to: "2099-01-08T00:00:00.000Z" });
  });

  it("fails with a fixed message that carries nothing from the database", async () => {
    for (const db of [dbOf(null, { code: "42501", message: `not_authorized for ${STORED}` }), dbOf({ not: "an array" }), dbOf(null)]) {
      const err = await readDeskSchedule(db, "s", "a", "b").then(() => null, (e: Error) => e);
      expect(err?.message).toBe("Failed to load schedule");
    }
  });

  it("a response that reaches the row cap is reported incomplete, never returned as a partial list", async () => {
    expect(DESK_SCHEDULE_ROW_CAP).toBe(1000);
    const below = await readDeskSchedule(dbOf(Array.from({ length: DESK_SCHEDULE_ROW_CAP - 1 }, () => row())), "s", "a", "b");
    expect(below).toHaveLength(DESK_SCHEDULE_ROW_CAP - 1);
    for (const n of [DESK_SCHEDULE_ROW_CAP, DESK_SCHEDULE_ROW_CAP + 1]) {
      const err = await readDeskSchedule(dbOf(Array.from({ length: n }, () => row())), "s", "a", "b").then(() => null, (e: Error) => e);
      expect(err).toBeInstanceOf(DeskScheduleIncompleteError);
    }
  });

  it("recovers a busy month in shorter windows and counts a visit spanning both windows once", async () => {
    const early = row();
    const crossing = row({ appointment_id: "11111111-1111-4111-8111-111111111112", starts_at: "2099-01-16T23:30:00Z", ends_at: "2099-01-17T00:30:00Z" });
    const late = row({ appointment_id: "11111111-1111-4111-8111-111111111113", starts_at: "2099-01-20T15:00:00Z", ends_at: "2099-01-20T16:00:00Z" });
    const rpc = vi.fn().mockResolvedValueOnce({data:Array(DESK_SCHEDULE_ROW_CAP).fill(early),error:null})
      .mockResolvedValueOnce({data:[early,crossing],error:null}).mockResolvedValueOnce({data:[crossing,late],error:null});
    const visits = await readDeskSchedule({ rpc }, "studio", "2099-01-01T00:00:00Z", "2099-02-02T00:00:00Z");
    expect(visits.map(v => v.appointmentId)).toEqual([early.appointment_id,crossing.appointment_id,late.appointment_id]);
    expect(rpc.mock.calls[1][1].p_to).toBe(rpc.mock.calls[2][1].p_from);
  });

  it("counts the rows the database returned, before any unreadable row is dropped", async () => {
    const rows = Array.from({ length: DESK_SCHEDULE_ROW_CAP }, (_, i) => (i < 10 ? { starts_at: "not a time" } : row()));
    const err = await readDeskSchedule(dbOf(rows), "s", "a", "b").then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(DeskScheduleIncompleteError);
  });
});
