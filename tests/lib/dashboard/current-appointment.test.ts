import { describe, expect, it } from "vitest";
import {
  NOT_CURRENT_STATUSES,
  currentAppointmentIds,
  isCurrentAppointment,
  type CurrentAppointmentCandidate,
} from "@/lib/dashboard/current-appointment";

// Chloe: "dashboard should highlight current client".
//
// The rule is `starts_at <= now < ends_at` AND the appointment is not
// completed / cancelled / no_show. These tests drive the real predicate with a
// fixed instant — no clock, no database — so removing either half of the rule
// turns them red.

const NOW = Date.parse("2026-08-18T15:30:00.000Z");
const MIN = 60_000;

function appt(
  over: Partial<CurrentAppointmentCandidate> = {},
): CurrentAppointmentCandidate {
  return {
    id: "appt-current",
    starts_at: new Date(NOW - 20 * MIN).toISOString(),
    ends_at: new Date(NOW + 40 * MIN).toISOString(),
    status: "confirmed",
    ...over,
  };
}

describe("isCurrentAppointment — the clock half of the rule", () => {
  it("now INSIDE the interval → current", () => {
    expect(isCurrentAppointment(appt(), NOW)).toBe(true);
  });

  it("a FUTURE appointment is not current", () => {
    const future = appt({
      id: "appt-future",
      starts_at: new Date(NOW + 90 * MIN).toISOString(),
      ends_at: new Date(NOW + 150 * MIN).toISOString(),
    });
    expect(isCurrentAppointment(future, NOW)).toBe(false);
  });

  it("an appointment that already ENDED is not current", () => {
    const past = appt({
      starts_at: new Date(NOW - 120 * MIN).toISOString(),
      ends_at: new Date(NOW - 60 * MIN).toISOString(),
    });
    expect(isCurrentAppointment(past, NOW)).toBe(false);
  });

  it("the interval is HALF-OPEN: start counts, end does not", () => {
    const start = new Date(NOW).toISOString();
    const end = new Date(NOW + 60 * MIN).toISOString();
    // now === starts_at → already current (she is walking in).
    expect(isCurrentAppointment(appt({ starts_at: start, ends_at: end }), NOW)).toBe(
      true,
    );
    // now === ends_at → finished. Back-to-back visits never both light up.
    expect(
      isCurrentAppointment(
        appt({ starts_at: new Date(NOW - 60 * MIN).toISOString(), ends_at: start }),
        NOW,
      ),
    ).toBe(false);
  });

  it("an unparseable or inverted interval asserts nothing", () => {
    expect(isCurrentAppointment(appt({ starts_at: "not-a-date" }), NOW)).toBe(false);
    expect(isCurrentAppointment(appt({ ends_at: "" }), NOW)).toBe(false);
    expect(
      isCurrentAppointment(
        appt({
          starts_at: new Date(NOW + 10 * MIN).toISOString(),
          ends_at: new Date(NOW - 10 * MIN).toISOString(),
        }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("isCurrentAppointment — the status half of the rule", () => {
  // Load-bearing: an appointment whose booked interval contains the current
  // minute but which is already completed / cancelled / no-show is NOT the
  // person in the room. Highlighting it sends the practitioner to an empty
  // chair.
  for (const status of NOT_CURRENT_STATUSES) {
    it(`a ${status} appointment inside the clock interval is NOT current`, () => {
      expect(isCurrentAppointment(appt({ status }), NOW)).toBe(false);
    });
  }

  it("the excluded set is exactly completed / cancelled / no_show", () => {
    expect([...NOT_CURRENT_STATUSES].sort()).toEqual([
      "cancelled",
      "completed",
      "no_show",
    ]);
    expect(isCurrentAppointment(appt({ status: "confirmed" }), NOW)).toBe(true);
  });
});

describe("currentAppointmentIds — a set, not a winner", () => {
  it("picks only the appointment covering now", () => {
    const rows = [
      appt({ id: "a" }),
      appt({
        id: "b",
        starts_at: new Date(NOW + 90 * MIN).toISOString(),
        ends_at: new Date(NOW + 150 * MIN).toISOString(),
      }),
      appt({ id: "c", status: "no_show" }),
    ];
    expect([...currentAppointmentIds(rows, NOW)]).toEqual(["a"]);
  });

  it("two GENUINELY overlapping appointments are both current", () => {
    // Two practitioners, two rooms, one minute. Nothing here may impose a
    // single-chair studio by silently picking one.
    const rows = [appt({ id: "room-1" }), appt({ id: "room-2" })];
    expect(currentAppointmentIds(rows, NOW)).toEqual(
      new Set(["room-1", "room-2"]),
    );
  });

  it("an empty day yields an empty set", () => {
    expect(currentAppointmentIds([], NOW).size).toBe(0);
  });
});
