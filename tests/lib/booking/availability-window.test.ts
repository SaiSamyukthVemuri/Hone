import { describe, expect, it } from "vitest";
import {
  classifyAgainstWindow,
  decideManualTime,
  localInterval,
  readFullDayBlockout,
  resolveAvailabilityWindow,
  type AvailabilityWindow,
} from "@/lib/booking/availability-window";
import {
  dayOfWeekFromLocalDate,
  localDayOfWeek,
  utcInstantFromLocal,
} from "@/lib/booking/tz";

// The availability-window authority: the thing Hone did not have.
//
// Before this, the only code that knew a practitioner's real working hours was
// the code that generates PACKED SUGGESTIONS, so the internal booking action
// substituted "is this one of the suggestions?" for "is this inside your
// hours?" — and a deliberate 15:30 on a 09:00-17:00 day was reported as an
// availability violation and filed as an out-of-hours override.

const OPEN_9_17: AvailabilityWindow = {
  kind: "open",
  openTime: "09:00",
  closeTime: "17:00",
};
const CLOSED: AvailabilityWindow = { kind: "closed" };

// A plain, non-DST summer Monday. classifyAgainstWindow now takes the interval
// projected from real instants (see localInterval), so these cases route
// through the same construction the booking path uses; on a day with no
// transition that is exactly the old wall-clock arithmetic, so every assertion
// below keeps its original meaning.
const TZ = "America/Toronto";
const PLAIN_DAY = "2026-06-15";
const at = (hhmm: string, durationMinutes: number, date = PLAIN_DAY, tz = TZ) =>
  localInterval(utcInstantFromLocal(date, hhmm, tz), durationMinutes, tz);

describe("classifyAgainstWindow — mirrors validate_appointment_availability", () => {
  it("a time strictly inside the window is inside_availability", () => {
    expect(classifyAgainstWindow(OPEN_9_17, at("15:30", 60))).toBe(
      "inside_availability",
    );
  });

  it("THE REPORT: 15:30 is inside, even though it is not a packed suggestion", () => {
    // 15:30 + 60 = 16:30 <= 17:00. Nothing about suggestion membership can
    // reach this function, which is the point.
    expect(classifyAgainstWindow(OPEN_9_17, at("15:30", 60))).toBe(
      "inside_availability",
    );
  });

  it("the opening edge is inclusive", () => {
    expect(classifyAgainstWindow(OPEN_9_17, at("09:00", 60))).toBe(
      "inside_availability",
    );
  });

  it("one minute before open is outside", () => {
    expect(classifyAgainstWindow(OPEN_9_17, at("08:59", 60))).toBe(
      "outside_availability",
    );
  });

  it("the SERVICE end may land exactly on close", () => {
    expect(classifyAgainstWindow(OPEN_9_17, at("16:00", 60))).toBe(
      "inside_availability",
    );
  });

  it("a service end one minute past close is outside", () => {
    expect(classifyAgainstWindow(OPEN_9_17, at("16:01", 60))).toBe(
      "outside_availability",
    );
  });

  it("the window is measured on the SERVICE end, never a buffered end", () => {
    // Hone lets the trailing studio buffer spill past closing time: the slot
    // engine's fit filter, migration 0152's `v_end_time > v_close`, and 0170's
    // port all agree. Subtracting a buffer here would refuse the last
    // appointment of every day that Hone already offers.
    expect(classifyAgainstWindow(OPEN_9_17, at("16:00", 60))).toBe(
      "inside_availability",
    );
  });

  it("duration changes the verdict for the same start", () => {
    expect(classifyAgainstWindow(OPEN_9_17, at("16:30", 30))).toBe(
      "inside_availability",
    );
    expect(classifyAgainstWindow(OPEN_9_17, at("16:30", 60))).toBe(
      "outside_availability",
    );
  });

  it("a closed day is practitioner_closed, NOT outside_availability", () => {
    // Different truths deserve different words: a day you do not work is not
    // the same as a time outside the hours you do work.
    expect(classifyAgainstWindow(CLOSED, at("15:30", 60))).toBe(
      "practitioner_closed",
    );
  });

  it("an appointment that would cross local midnight is refused", () => {
    // 0152 refuses `v_end_date <> v_local_date` BEFORE comparing against close,
    // so a late booking cannot pass by arithmetic that wraps.
    const lateWindow: AvailabilityWindow = {
      kind: "open",
      openTime: "09:00",
      closeTime: "23:59",
    };
    expect(classifyAgainstWindow(lateWindow, at("23:30", 60))).toBe(
      "outside_availability",
    );
  });
});

describe("decideManualTime — the one law both booking surfaces use", () => {
  const base = {
    window: OPEN_9_17 as AvailabilityWindow | null,
    localDate: PLAIN_DAY,
    localTime: "15:30",
    timezone: TZ,
    serviceDurationMinutes: 60,
    customDurationMinutes: null as number | null,
  };

  it("an inside-hours manual time does NOT require the override", () => {
    const d = decideManualTime(base);
    expect(d.verdict).toBe("inside_availability");
    expect(d.requiresOutsideOverride).toBe(false);
  });

  it("an outside-hours manual time DOES require the override", () => {
    const d = decideManualTime({ ...base, localTime: "18:00" });
    expect(d.verdict).toBe("outside_availability");
    expect(d.requiresOutsideOverride).toBe(true);
  });

  it("a closed day requires the override and says so distinctly", () => {
    const d = decideManualTime({ ...base, window: CLOSED });
    expect(d.verdict).toBe("practitioner_closed");
    expect(d.requiresOutsideOverride).toBe(true);
  });

  it("FAILS CLOSED when the window is unknown", () => {
    // A failed or pending slot load must never read as "open".
    const d = decideManualTime({ ...base, window: null });
    expect(d.verdict).toBeNull();
    expect(d.requiresOutsideOverride).toBe(true);
  });

  it("reports an unknown window SEPARATELY from requiring the override", () => {
    // requiresOutsideOverride answers "may this be treated as an ordinary
    // booking?" — and failing closed correctly answers no. It does NOT answer
    // "is this time outside availability?", which is an assertion the database
    // persists forever (booked_outside_availability, the audit entry, the
    // authorising owner, the disabled buffer trigger).
    //
    // Collapsing the two is how an in-hours appointment gets filed as an
    // out-of-hours exception whenever the window has not loaded. windowKnown is
    // what lets a surface refuse to assert anything instead.
    const unknown = decideManualTime({ ...base, window: null });
    expect(unknown.windowKnown).toBe(false);
    expect(unknown.requiresOutsideOverride).toBe(true);

    // ...whereas a genuinely outside time is BOTH known and overriding, so the
    // two fields cannot be conflated by an accidental alias.
    const outside = decideManualTime({ ...base, localTime: "18:00" });
    expect(outside.windowKnown).toBe(true);
    expect(outside.requiresOutsideOverride).toBe(true);
  });

  it("windowKnown is true for every window that loaded, open or closed", () => {
    // A CLOSED day is knowledge, not absence of it: the practitioner really is
    // not working, so the override path is correct and must stay reachable.
    expect(decideManualTime(base).windowKnown).toBe(true);
    expect(decideManualTime({ ...base, window: CLOSED }).windowKnown).toBe(true);
  });

  it("windowKnown does not depend on the typed time or the duration", () => {
    // It is a fact about the WINDOW only. Tying it to the other inputs would
    // make a surface block submission for the wrong reason (or, worse, unblock
    // it once a time happened to parse).
    expect(
      decideManualTime({ ...base, window: null, localTime: "" }).windowKnown,
    ).toBe(false);
    expect(
      decideManualTime({ ...base, localTime: "", serviceDurationMinutes: null })
        .windowKnown,
    ).toBe(true);
  });

  it("FAILS CLOSED when the time is unparseable, and reports timeValid", () => {
    const d = decideManualTime({ ...base, localTime: "" });
    expect(d.timeValid).toBe(false);
    expect(d.verdict).toBeNull();
    expect(d.requiresOutsideOverride).toBe(true);
  });

  it("FAILS CLOSED when no service duration is known", () => {
    const d = decideManualTime({ ...base, serviceDurationMinutes: null });
    expect(d.verdict).toBeNull();
    expect(d.requiresOutsideOverride).toBe(true);
  });

  it("a CUSTOM LENGTH always requires the override, even inside hours", () => {
    // A caller-supplied duration is owner-only inside
    // create_internal_appointment_v2 and is coupled to the flag by the server
    // action. Changing that needs a migration; this PR does not.
    const d = decideManualTime({ ...base, customDurationMinutes: 45 });
    expect(d.verdict).toBe("inside_availability");
    expect(d.requiresOutsideOverride).toBe(true);
  });

  it("a custom length is what the window is measured against", () => {
    // 15:30 + 120 = 17:30, past close.
    const d = decideManualTime({ ...base, customDurationMinutes: 120 });
    expect(d.verdict).toBe("outside_availability");
  });
});

// ---------------------------------------------------------------------------
// The async resolvers. These use a PREDICATE-SENSITIVE stub: a stub that
// ignored filters would let "the practitioner-specific row wins" pass without
// the code ever scoping a query.
// ---------------------------------------------------------------------------

type Row = { is_open: boolean; open_time: string; close_time: string };

function mockClient(opts: {
  blockouts?: unknown[];
  blockoutError?: unknown;
  practitionerOverride?: Row | null;
  studioOverride?: Row | null;
  practitionerDefault?: Row | null;
  studioDefault?: Row | null;
}) {
  const seen: { table: string; scoped: "practitioner" | "studio-wide" }[] = [];
  function builder(table: string) {
    let scoped: "practitioner" | "studio-wide" = "studio-wide";
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.eq = (col: string) => {
      if (col === "practitioner_id") scoped = "practitioner";
      return b;
    };
    b.is = (col: string) => {
      if (col === "practitioner_id") scoped = "studio-wide";
      return b;
    };
    for (const op of ["lt", "gt", "lte", "gte"]) b[op] = () => b;
    const result = () => {
      seen.push({ table, scoped });
      if (table === "studio_blockouts") {
        return {
          data: opts.blockouts ?? [],
          error: opts.blockoutError ?? null,
        };
      }
      if (table === "studio_availability_overrides") {
        return {
          data:
            scoped === "practitioner"
              ? (opts.practitionerOverride ?? null)
              : (opts.studioOverride ?? null),
          error: null,
        };
      }
      return {
        data:
          scoped === "practitioner"
            ? (opts.practitionerDefault ?? null)
            : (opts.studioDefault ?? null),
        error: null,
      };
    };
    b.maybeSingle = () => Promise.resolve(result());
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(onF, onR);
    return b;
  }
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: { from: (t: string) => builder(t) } as any,
    seen,
  };
}

const WIN = (open: string, close: string): Row => ({
  is_open: true,
  open_time: `${open}:00`,
  close_time: `${close}:00`,
});

describe("readFullDayBlockout — the two policies are explicit", () => {
  it("reports a covering blockout", async () => {
    const m = mockClient({ blockouts: [{ starts_on: "x", ends_on: "y" }] });
    expect(await readFullDayBlockout(m.client, "s1", "2026-07-06")).toEqual({
      blocked: true,
      readFailed: false,
    });
  });

  it("reports a FAILED read distinctly, never as 'no blockout'", async () => {
    // Slot generation discards this (preserving public behaviour); the manual
    // time check treats it as closed. Collapsing the two would have silently
    // hardened the public booking page.
    const m = mockClient({ blockoutError: { code: "PGRST000" } });
    expect(await readFullDayBlockout(m.client, "s1", "2026-07-06")).toEqual({
      blocked: false,
      readFailed: true,
    });
  });
});

describe("resolveAvailabilityWindow — precedence matches the SQL validator", () => {
  const studioOn = {
    id: "s1",
    timezone: "America/Toronto",
    practitioner_capacity_enabled: true,
  };
  const studioOff = {
    id: "s1",
    timezone: "America/Toronto",
    practitioner_capacity_enabled: false,
  };

  it("capacity ON: a practitioner OVERRIDE beats every other row", async () => {
    const m = mockClient({
      practitionerOverride: WIN("10:00", "14:00"),
      studioOverride: WIN("09:00", "17:00"),
      practitionerDefault: WIN("08:00", "20:00"),
      studioDefault: WIN("07:00", "22:00"),
    });
    expect(
      await resolveAvailabilityWindow(m.client, studioOn, "2026-07-06", "p1"),
    ).toEqual({ kind: "open", openTime: "10:00", closeTime: "14:00" });
  });

  it("capacity ON: a studio-wide OVERRIDE beats both defaults", async () => {
    const m = mockClient({
      practitionerOverride: null,
      studioOverride: WIN("09:00", "17:00"),
      practitionerDefault: WIN("08:00", "20:00"),
      studioDefault: WIN("07:00", "22:00"),
    });
    expect(
      await resolveAvailabilityWindow(m.client, studioOn, "2026-07-06", "p1"),
    ).toEqual({ kind: "open", openTime: "09:00", closeTime: "17:00" });
  });

  it("capacity ON: a practitioner DEFAULT beats the studio-wide default", async () => {
    const m = mockClient({
      practitionerDefault: WIN("08:00", "20:00"),
      studioDefault: WIN("07:00", "22:00"),
    });
    expect(
      await resolveAvailabilityWindow(m.client, studioOn, "2026-07-06", "p1"),
    ).toEqual({ kind: "open", openTime: "08:00", closeTime: "20:00" });
  });

  it("capacity ON: falls back to the studio-wide default", async () => {
    const m = mockClient({ studioDefault: WIN("07:00", "22:00") });
    expect(
      await resolveAvailabilityWindow(m.client, studioOn, "2026-07-06", "p1"),
    ).toEqual({ kind: "open", openTime: "07:00", closeTime: "22:00" });
  });

  it("capacity OFF: reads ONLY studio-wide rows, never a retained practitioner row", async () => {
    // A studio that had capacity enabled and then disabled it RETAINS its
    // per-practitioner rows. Reading one here would resolve a window the SQL
    // validator does not even look at.
    const m = mockClient({
      practitionerDefault: WIN("08:00", "20:00"),
      studioDefault: WIN("09:00", "17:00"),
    });
    const w = await resolveAvailabilityWindow(
      m.client,
      studioOff,
      "2026-07-06",
      "p1",
    );
    expect(w).toEqual({ kind: "open", openTime: "09:00", closeTime: "17:00" });
    expect(m.seen.every((s) => s.scoped === "studio-wide")).toBe(true);
  });

  it("a row with is_open=false resolves to closed", async () => {
    const m = mockClient({
      studioDefault: { is_open: false, open_time: "09:00:00", close_time: "17:00:00" },
    });
    expect(
      await resolveAvailabilityWindow(m.client, studioOff, "2026-07-06"),
    ).toEqual({ kind: "closed" });
  });

  it("no row at all resolves to closed (fail closed)", async () => {
    const m = mockClient({});
    expect(
      await resolveAvailabilityWindow(m.client, studioOff, "2026-07-06"),
    ).toEqual({ kind: "closed" });
  });

  it("trims the seconds Postgres returns on a time column", async () => {
    const m = mockClient({ studioDefault: WIN("09:00", "17:00") });
    const w = await resolveAvailabilityWindow(m.client, studioOff, "2026-07-06");
    expect(w).toEqual({ kind: "open", openTime: "09:00", closeTime: "17:00" });
  });
});

// ---------------------------------------------------------------------------
// FIVE CONFIRMED P2 REGRESSIONS (Codex, exact head 20744766). Each one is
// reproduced against the SEMANTICS the authoritative validator uses, not
// against the implementation that produced them.
// ---------------------------------------------------------------------------

describe("P2-1 — the weekday comes from the calendar date, not a noon-UTC round trip", () => {
  // Pacific/Kiritimati is UTC+14: noon UTC on a Monday is already Tuesday
  // there, so the old expression read Tuesday's weekly hours for a Monday.
  const FAR_EAST = "Pacific/Kiritimati";
  const MONDAY = "2026-06-15";

  it("dayOfWeekFromLocalDate is timezone-independent", () => {
    for (const tz of [FAR_EAST, "America/Toronto", "Pacific/Apia", "UTC"]) {
      // The helper takes no timezone at all -- that is the point. The loop
      // exists to state that no zone can change the answer.
      expect(tz && dayOfWeekFromLocalDate(MONDAY)).toBe(1); // Monday
    }
    expect(dayOfWeekFromLocalDate("2026-06-14")).toBe(0); // Sunday
    expect(dayOfWeekFromLocalDate("2026-06-20")).toBe(6); // Saturday
  });

  it("the OLD derivation really did skip a day in UTC+14 (anti-vacuity)", () => {
    // If this ever stops being true the regression test above is toothless.
    const old = localDayOfWeek(new Date(`${MONDAY}T12:00:00Z`), FAR_EAST);
    expect(old).toBe(2); // Tuesday — the bug being fixed
    expect(old).not.toBe(dayOfWeekFromLocalDate(MONDAY));
  });

  it("resolveAvailabilityWindow asks for the REQUESTED day's row", async () => {
    // Records the day_of_week actually queried. A stub that discarded filters
    // could not tell Monday's read from Tuesday's, and this test would pass
    // whatever the resolver asked for.
    const asked: number[] = [];
    const supabase = {
      from(table: string) {
        let dow: number | null = null;
        const b: Record<string, unknown> = {};
        for (const op of ["eq", "is", "lte", "gte"]) {
          b[op] = (col: string, val: unknown) => {
            if (col === "day_of_week") {
              dow = val as number;
              asked.push(dow);
            }
            return b;
          };
        }
        b.select = () => b;
        b.maybeSingle = () =>
          Promise.resolve({
            data:
              table === "studio_availability_default" && dow === 1
                ? { is_open: true, open_time: "09:00:00", close_time: "17:00:00" }
                : null,
            error: null,
          });
        b.then = (f: (v: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(f);
        return b;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const w = await resolveAvailabilityWindow(
      supabase,
      { id: "s1", timezone: FAR_EAST },
      MONDAY,
    );
    expect(asked).toContain(1); // Monday, not Tuesday
    expect(asked).not.toContain(2);
    expect(w).toEqual({ kind: "open", openTime: "09:00", closeTime: "17:00" });
  });
});

describe("P2-2 — the end is the real end instant, across DST", () => {
  const TORONTO = "America/Toronto";
  // 2026-03-08 spring-forward (02:00 -> 03:00); 2026-11-01 fall-back.
  const SPRING = "2026-03-08";
  const FALL = "2026-11-01";
  const win = (open: string, close: string): AvailabilityWindow => ({
    kind: "open",
    openTime: open,
    closeTime: close,
  });

  it("spring-forward: 01:30 + 60min really ends 03:30, so it is OUTSIDE a 03:00 close", () => {
    // Wall-clock addition said 02:30 and called this inside. The database adds
    // the duration to the UTC instant and sees 03:30.
    const iv = localInterval(
      utcInstantFromLocal(SPRING, "01:30", TORONTO),
      60,
      TORONTO,
    );
    expect(iv.endMinutes).toBe(3 * 60 + 30);
    expect(classifyAgainstWindow(win("01:00", "03:00"), iv)).toBe(
      "outside_availability",
    );
  });

  it("spring-forward: the same booking IS inside a 04:00 close", () => {
    const iv = localInterval(
      utcInstantFromLocal(SPRING, "01:30", TORONTO),
      60,
      TORONTO,
    );
    expect(classifyAgainstWindow(win("01:00", "04:00"), iv)).toBe(
      "inside_availability",
    );
  });

  it("fall-back: 01:30 + 60min really ends 01:30 again, so it is INSIDE a 02:00 close", () => {
    // The inverse error: wall-clock addition said 02:30 and demanded the
    // persistent override for a booking the database would have accepted.
    const iv = localInterval(
      utcInstantFromLocal(FALL, "01:30", TORONTO),
      60,
      TORONTO,
    );
    expect(iv.endMinutes).toBeLessThanOrEqual(2 * 60);
    expect(classifyAgainstWindow(win("01:00", "02:00"), iv)).toBe(
      "inside_availability",
    );
  });

  it("an ordinary day is unaffected — end is start + duration", () => {
    const iv = localInterval(
      utcInstantFromLocal("2026-06-15", "15:30", TORONTO),
      60,
      TORONTO,
    );
    expect(iv.startMinutes).toBe(15 * 60 + 30);
    expect(iv.endMinutes).toBe(16 * 60 + 30);
    expect(iv.startDate).toBe(iv.endDate);
  });

  it("an appointment running to local midnight lands on the NEXT date and is refused", () => {
    const iv = localInterval(
      utcInstantFromLocal("2026-06-15", "23:30", TORONTO),
      60,
      TORONTO,
    );
    expect(iv.endDate).not.toBe(iv.startDate);
    expect(classifyAgainstWindow(win("09:00", "23:59"), iv)).toBe(
      "outside_availability",
    );
  });

  it("decideManualTime routes through the same instants", () => {
    // The UI decision and the server decision must not diverge across DST.
    const d = decideManualTime({
      window: win("01:00", "03:00"),
      localDate: SPRING,
      localTime: "01:30",
      timezone: TORONTO,
      serviceDurationMinutes: 60,
      customDurationMinutes: null,
    });
    expect(d.verdict).toBe("outside_availability");
  });
});

describe("P2-5 — the override REASON is factual, not the permission answer", () => {
  const TZ2 = "America/Toronto";
  const DAY = "2026-06-15";
  const base = {
    window: OPEN_9_17 as AvailabilityWindow | null,
    localDate: DAY,
    localTime: "10:00",
    timezone: TZ2,
    serviceDurationMinutes: 60,
    customDurationMinutes: null as number | null,
  };

  it("a custom length INSIDE working hours reports custom_duration, not outside", () => {
    // 10:00 + 45 = 10:45, squarely inside 09:00-17:00. The override is required
    // only because a caller-supplied length is owner-only in the DB command.
    // Calling this "outside your normal availability" is a false statement
    // about the practitioner's own schedule.
    const d = decideManualTime({ ...base, customDurationMinutes: 45 });
    expect(d.verdict).toBe("inside_availability");
    expect(d.requiresOutsideOverride).toBe(true);
    expect(d.overrideReason).toBe("custom_duration");
  });

  it("a genuinely out-of-hours time still reports outside_availability", () => {
    const d = decideManualTime({ ...base, localTime: "18:00" });
    expect(d.overrideReason).toBe("outside_availability");
  });

  it("out-of-hours WINS over custom_duration when both apply", () => {
    // The more serious fact is the one the acknowledgement is really about.
    const d = decideManualTime({
      ...base,
      localTime: "18:00",
      customDurationMinutes: 45,
    });
    expect(d.overrideReason).toBe("outside_availability");
  });

  it("a closed day reports practitioner_closed", () => {
    const d = decideManualTime({ ...base, window: CLOSED });
    expect(d.overrideReason).toBe("practitioner_closed");
  });

  it("no override required means no reason", () => {
    const d = decideManualTime(base);
    expect(d.requiresOutsideOverride).toBe(false);
    expect(d.overrideReason).toBeNull();
  });

  it("an unknown window yields no reason — nothing may be asserted", () => {
    const d = decideManualTime({ ...base, window: null });
    expect(d.requiresOutsideOverride).toBe(true);
    expect(d.windowKnown).toBe(false);
    expect(d.overrideReason).toBeNull();
  });
});
