import { describe, expect, it, vi } from "vitest";
import { DESK_FIELD_MAX, DESK_NAME_ON_FILE, DESK_SCHEDULE_ROW_CAP, DeskScheduleIncompleteError, mapDeskScheduleRow, readDeskSchedule, type DeskRpc } from "@/lib/desk/read";

// The desk's read is a closed projection: it copies named fields only, and no client name of any kind survives it.
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
  practitioner_color: "#aabbcc",
  service_id: "33333333-3333-4333-8333-333333333333",
  service_name: "Consultation",
  client_id: "44444444-4444-4444-8444-444444444444",
  display_name: STORED,
  name_on_file: true,
  duration_minutes: 60,
  studio_timezone: "America/Toronto",
  ...over,
});
const dbOf = (data: unknown, error: unknown = null): DeskRpc => ({ rpc: vi.fn(async () => ({ data, error })) });

describe("the closed projection", () => {
  it("keeps the booking facts and nothing else", () => {
    expect(mapDeskScheduleRow(row())).toEqual({
      startsAt: "2099-01-01T15:00:00.000Z",
      endsAt: "2099-01-01T16:00:00.000Z",
      status: "confirmed",
      durationMinutes: 60,
      studioTimezone: "America/Toronto",
      practitionerName: "Practitioner One",
      serviceName: "Consultation",
      clientName: DESK_NAME_ON_FILE,
    });
  });

  it("never carries a stored or preferred name, an identifier or a colour, whatever the database sent", () => {
    for (const flag of [true, false, null, "false", undefined, 0]) {
      for (const shown of [STORED, PREFERRED]) {
        const out = JSON.stringify(mapDeskScheduleRow(row({ display_name: shown, name_on_file: flag, preferred_name: PREFERRED, name: STORED, legal_name: STORED })));
        expect(out.includes("Stored-Surname") || out.includes("Preferred-Zeta") || out.includes("legal"), `${String(flag)}`).toBe(false);
        for (const id of ["11111111", "22222222", "33333333", "44444444", "#aabbcc"]) expect(out.includes(id), id).toBe(false);
      }
    }
  });

  it("shows exactly the fixed words for every client, preferred name or not", () => {
    expect(mapDeskScheduleRow(row({ name_on_file: false, display_name: PREFERRED }))?.clientName).toBe("Name on file");
    expect(mapDeskScheduleRow(row({ name_on_file: true }))?.clientName).toBe("Name on file");
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
    expect(db.rpc).toHaveBeenCalledWith("receptionist_calendar_v2", { p_studio_id: "studio-1", p_from: "2099-01-01T00:00:00.000Z", p_to: "2099-01-08T00:00:00.000Z" });
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

  it("counts the rows the database returned, before any unreadable row is dropped", async () => {
    const rows = Array.from({ length: DESK_SCHEDULE_ROW_CAP }, (_, i) => (i < 10 ? { starts_at: "not a time" } : row()));
    const err = await readDeskSchedule(dbOf(rows), "s", "a", "b").then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(DeskScheduleIncompleteError);
  });
});
