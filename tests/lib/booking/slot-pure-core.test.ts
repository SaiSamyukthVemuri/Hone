import { describe, expect, it } from "vitest";

import {
  buildDaySlots,
  getAvailableSlots,
  pickDayWindow,
  protectedIntervals,
  INTERNAL_SLOT_PACKING,
  type ReservationRow,
  type Slot,
} from "@/lib/booking/slots";
import { utcInstantFromLocal } from "@/lib/booking/tz";

// ===========================================================================
// The booking-slot PURE CORE, and the proof that the loader really uses it
// ===========================================================================
//
// getAvailableSlots was one function that both READ a day's inputs and applied
// the RULES to them. The rules are now three exported pieces — pickDayWindow,
// protectedIntervals, buildDaySlots — and getAvailableSlots is the day loader
// that composes them.
//
// The 296 pre-existing booking tests, unmodified, are the behaviour contract:
// this refactor is only honest if they pass untouched. This file adds what they
// cannot say — that each primitive holds its rule on its own, and that the
// loader is genuinely COMPOSED of them rather than merely accompanied by them.
//
// The composition claim is the one that needs care, because "getAvailableSlots
// agrees with buildDaySlots" is trivially true of any two functions that happen
// to compute the same thing. Every equality assertion below is therefore paired
// with a CONTROL that must diverge — if the control also matched, the equality
// would be proving nothing.

const TZ = "America/Toronto";
const DATE = "2026-07-06"; // a summer Monday: EDT, no DST transition
const at = (hhmm: string) => utcInstantFromLocal(DATE, hhmm, TZ).toISOString();
const ms = (hhmm: string) => utcInstantFromLocal(DATE, hhmm, TZ).getTime();
const starts = (slots: ReadonlyArray<Slot>) => slots.map((s) => s.start);

const reservation = (
  from: string,
  to: string,
  source_kind: string,
  source_id = `${source_kind}-${from}`,
): ReservationRow => ({
  starts_at: at(from),
  ends_at: at(to),
  source_kind,
  source_id,
});

// Minimal chainable + thenable Supabase stub keyed by table, matching the
// convention the sibling slot suites already use. Filter arguments are ignored;
// the canned rows ARE the day.
function mockSupabase(d: {
  blockouts?: unknown[];
  override?: unknown | null;
  defaultRow?: unknown | null;
  reservations?: ReservationRow[];
}) {
  const results: Record<string, { data: unknown }> = {
    studio_blockouts: { data: d.blockouts ?? [] },
    studio_availability_overrides: { data: d.override ?? null },
    studio_availability_default: { data: d.defaultRow ?? null },
    studio_calendar_reservations: { data: d.reservations ?? [] },
  };
  function builder(table: string) {
    const result = results[table] ?? { data: null };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "lte", "gte", "lt", "gt", "order"]) {
      b[m] = () => b;
    }
    b.maybeSingle = () => Promise.resolve(result);
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onF, onR);
    return b;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (t: string) => builder(t) } as any;
}

const studioRow = (buffer: number) => ({
  id: "s1",
  timezone: TZ,
  default_appointment_duration_minutes: 60,
  buffer_minutes: buffer,
});

const OPEN_9_17 = { is_open: true, open_time: "09:00:00", close_time: "17:00:00" };

// ---------------------------------------------------------------------------
// pickDayWindow — the precedence rule
// ---------------------------------------------------------------------------

describe("pickDayWindow", () => {
  const DEFAULT_OPEN = { is_open: true, open_time: "09:00:00", close_time: "17:00:00" };
  const OVERRIDE_LATE = { is_open: true, open_time: "12:00:00", close_time: "16:00:00" };

  it("prefers a dated override over the weekly default", () => {
    expect(pickDayWindow(OVERRIDE_LATE, DEFAULT_OPEN)).toEqual({
      isOpen: true,
      openTime: "12:00",
      closeTime: "16:00",
    });
  });

  it("lets an override CLOSE a day the weekly default opens", () => {
    // The load-bearing half of the rule: a holiday is an override that says
    // closed, and falling back to the default here would open the studio on it.
    expect(
      pickDayWindow({ is_open: false, open_time: null, close_time: null }, DEFAULT_OPEN),
    ).toEqual({ isOpen: false, openTime: null, closeTime: null });
  });

  it("falls back to the weekly default when no override exists", () => {
    expect(pickDayWindow(null, DEFAULT_OPEN).openTime).toBe("09:00");
    expect(pickDayWindow(undefined, DEFAULT_OPEN).openTime).toBe("09:00");
  });

  it("is closed when neither row exists", () => {
    expect(pickDayWindow(null, null)).toEqual({
      isOpen: false,
      openTime: null,
      closeTime: null,
    });
  });

  it("trims the seconds a postgres time column carries", () => {
    // "09:00:00" reaches the minute arithmetic as "09:00" or it parses wrong.
    expect(pickDayWindow(null, DEFAULT_OPEN).closeTime).toBe("17:00");
  });
});

// ---------------------------------------------------------------------------
// protectedIntervals — the source-aware buffer rule
// ---------------------------------------------------------------------------

describe("protectedIntervals", () => {
  it("extends an APPOINTMENT by the current studio buffer", () => {
    // 0152 stores the ACTUAL treatment interval; the protected end is rebuilt.
    const [i] = protectedIntervals([reservation("13:00", "14:00", "appointment")], 30);
    expect(i.start).toBe(ms("13:00"));
    expect(i.end).toBe(ms("14:30"));
    expect(i.sourceKind).toBe("appointment");
  });

  it("does NOT extend a block, a break or a blockout", () => {
    // These carry no buffer and widening them would close time the studio owns.
    for (const kind of ["timed_block", "recurring_break_occurrence", "full_day_blockout"]) {
      const [i] = protectedIntervals([reservation("13:00", "14:00", kind)], 30);
      expect(i.end, kind).toBe(ms("14:00"));
    }
  });

  it("carries the buffer through as zero when the studio has none", () => {
    const [i] = protectedIntervals([reservation("13:00", "14:00", "appointment")], 0);
    expect(i.end).toBe(ms("14:00"));
  });

  it("clamps a negative buffer rather than pulling the protected end backwards", () => {
    const [i] = protectedIntervals([reservation("13:00", "14:00", "appointment")], -30);
    expect(i.end).toBe(ms("14:00"));
  });

  it("excludes ONLY the exact (kind, id) pair being moved", () => {
    const moving = reservation("13:00", "14:00", "appointment", "A");
    const other = reservation("15:00", "16:00", "appointment", "B");
    const block = reservation("13:00", "14:00", "timed_block", "A"); // same id, other kind
    const kept = protectedIntervals([moving, other, block], 30, {
      sourceKind: "appointment",
      sourceId: "A",
    });
    // The moved appointment's own row goes; a same-id row of a DIFFERENT kind
    // and every other appointment stay conflicts.
    expect(kept.map((i) => i.sourceKind).sort()).toEqual(["appointment", "timed_block"]);
    expect(kept.some((i) => i.sourceKind === "appointment" && i.end === ms("16:30"))).toBe(true);
  });

  it("excludes nothing when no exclusion is supplied", () => {
    expect(protectedIntervals([reservation("13:00", "14:00", "appointment", "A")], 30)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildDaySlots — candidate generation
// ---------------------------------------------------------------------------

describe("buildDaySlots", () => {
  const day = (over: Partial<Parameters<typeof buildDaySlots>[0]> = {}) =>
    buildDaySlots({
      dateStr: DATE,
      tz: TZ,
      duration: 60,
      buffer: 30,
      openTime: "09:00",
      closeTime: "17:00",
      reservations: [],
      ...over,
    });

  it("anchors the first candidate on the opening time", () => {
    expect(starts(day())[0]).toBe(at("09:00"));
  });

  it("anchors immediately after a reservation's PROTECTED end, not its actual end", () => {
    const slots = starts(day({ reservations: [reservation("09:00", "11:00", "appointment")] }));
    expect(slots).toContain(at("11:30")); // 11:00 + the 30-minute buffer
    expect(slots).not.toContain(at("11:00"));
  });

  it("offers a backward-packed candidate that ends exactly where a reservation begins", () => {
    // 14:00 reservation, 60-minute service, 30-minute buffer -> 12:30.
    const slots = starts(day({ reservations: [reservation("14:00", "15:00", "timed_block")] }));
    expect(slots).toContain(at("12:30"));
  });

  it("never offers a candidate whose service would run past closing time", () => {
    for (const s of day({ duration: 90 })) {
      expect(new Date(s.end).getTime()).toBeLessThanOrEqual(ms("17:00"));
    }
  });

  it("packs the closing edge only when the internal option asks for it", () => {
    const withoutPacking = starts(day({ duration: 45 }));
    const withPacking = starts(day({ duration: 45, options: INTERNAL_SLOT_PACKING }));
    expect(withoutPacking).not.toContain(at("16:15"));
    expect(withPacking).toContain(at("16:15"));
  });

  it("returns nothing when the window cannot hold one service", () => {
    expect(day({ openTime: "09:00", closeTime: "09:30", duration: 60 })).toEqual([]);
  });

  it("honours the move-exclusion so an appointment does not block its own move", () => {
    const own = reservation("13:00", "14:00", "appointment", "SELF");
    expect(starts(day({ reservations: [own] }))).not.toContain(at("13:00"));
    expect(
      starts(
        day({
          reservations: [own],
          excludeReservation: { sourceKind: "appointment", sourceId: "SELF" },
        }),
      ),
    ).toContain(at("13:00"));
  });
});

// ---------------------------------------------------------------------------
// Composition — the loader is BUILT from the core, not merely consistent with it
// ---------------------------------------------------------------------------

describe("getAvailableSlots composes the pure core", () => {
  const SCENARIOS: Array<{
    name: string;
    buffer: number;
    duration: number;
    reservations: ReservationRow[];
    options?: typeof INTERNAL_SLOT_PACKING;
  }> = [
    { name: "empty day", buffer: 30, duration: 60, reservations: [] },
    { name: "no buffer", buffer: 0, duration: 45, reservations: [] },
    {
      name: "one appointment",
      buffer: 30,
      duration: 60,
      reservations: [reservation("11:00", "12:00", "appointment")],
    },
    {
      name: "appointment + block + break",
      buffer: 15,
      duration: 30,
      reservations: [
        reservation("09:30", "10:30", "appointment"),
        reservation("12:00", "13:00", "timed_block"),
        reservation("15:00", "15:30", "recurring_break_occurrence"),
      ],
    },
    {
      name: "internal closing-edge packing",
      buffer: 15,
      duration: 45,
      reservations: [reservation("09:00", "12:00", "appointment")],
      options: INTERNAL_SLOT_PACKING,
    },
  ];

  for (const s of SCENARIOS) {
    it(`matches buildDaySlots on the same inputs — ${s.name}`, async () => {
      const loaded = await getAvailableSlots(
        mockSupabase({ defaultRow: OPEN_9_17, reservations: s.reservations }),
        studioRow(s.buffer),
        DATE,
        s.duration,
        undefined,
        undefined,
        s.options,
      );
      const pure = buildDaySlots({
        dateStr: DATE,
        tz: TZ,
        duration: s.duration,
        buffer: s.buffer,
        openTime: "09:00",
        closeTime: "17:00",
        reservations: s.reservations,
        options: s.options,
      });
      expect(starts(loaded)).toEqual(starts(pure));
      expect(loaded.length).toBeGreaterThan(0);
    });
  }

  it("CONTROL: the comparison can fail — a different reservation set diverges", async () => {
    // Without this, every assertion above would also pass if getAvailableSlots
    // and buildDaySlots were unrelated functions that happened to agree.
    const loaded = await getAvailableSlots(
      mockSupabase({
        defaultRow: OPEN_9_17,
        reservations: [reservation("11:00", "12:00", "appointment")],
      }),
      studioRow(30),
      DATE,
      60,
    );
    const pure = buildDaySlots({
      dateStr: DATE,
      tz: TZ,
      duration: 60,
      buffer: 30,
      openTime: "09:00",
      closeTime: "17:00",
      reservations: [],
    });
    expect(starts(loaded)).not.toEqual(starts(pure));
  });

  it("CONTROL: the loader's buffer really flows into protectedIntervals", async () => {
    // Same raw interval, different SOURCE. Only the source-aware rule can tell
    // them apart, so a loader that had stopped using protectedIntervals — or
    // reconstructed the buffer itself — would produce one answer for both.
    const asAppointment = await getAvailableSlots(
      mockSupabase({
        defaultRow: OPEN_9_17,
        reservations: [reservation("11:00", "12:00", "appointment")],
      }),
      studioRow(30),
      DATE,
      60,
    );
    const asBlock = await getAvailableSlots(
      mockSupabase({
        defaultRow: OPEN_9_17,
        reservations: [reservation("11:00", "12:00", "timed_block")],
      }),
      studioRow(30),
      DATE,
      60,
    );
    expect(starts(asAppointment)).toContain(at("12:30"));
    expect(starts(asBlock)).toContain(at("12:00"));
    expect(starts(asAppointment)).not.toEqual(starts(asBlock));
  });

  it("CONTROL: a closed override closes the day through the loader", async () => {
    // What this establishes, precisely: the loader honours a closed override
    // end to end. It does NOT prove pickDayWindow's precedence, because the
    // loader probes the override first and hands the chosen row over as
    // `pickDayWindow(row, null)` — the precedence tests above cover that on the
    // primitive, where a batched caller will rely on it. What the loader DOES
    // take from pickDayWindow is the normalisation, and that is load-bearing:
    // leaving the seconds on "09:00:00" fails 85 tests across this directory.
    const closed = await getAvailableSlots(
      mockSupabase({
        defaultRow: OPEN_9_17,
        override: { is_open: false, open_time: null, close_time: null },
      }),
      studioRow(30),
      DATE,
      60,
    );
    expect(closed).toEqual([]);

    const shortened = await getAvailableSlots(
      mockSupabase({
        defaultRow: OPEN_9_17,
        override: { is_open: true, open_time: "12:00:00", close_time: "14:00:00" },
      }),
      studioRow(30),
      DATE,
      60,
    );
    expect(starts(shortened)[0]).toBe(at("12:00"));
    for (const s of shortened) {
      expect(new Date(s.end).getTime()).toBeLessThanOrEqual(ms("14:00"));
    }
  });
});

// ---------------------------------------------------------------------------
// A KNOWN, PRE-EXISTING DEFECT this refactor deliberately preserves
// ---------------------------------------------------------------------------

describe("midnight buffer spill (pre-existing defect, characterised not fixed)", () => {
  it("still offers a start that the DATABASE will refuse", () => {
    // getAvailableSlots selects the day's reservations on the shadow's RAW
    // `ends_at` (`gt("ends_at", windowStart)`), so an appointment that ended
    // just before local midnight is dropped from the next day even though its
    // reconstructed protected end reaches into it.
    //
    // Reproduced against the real database on a studio open 00:00-08:00 with a
    // 30-minute buffer and an appointment ending 23:50 the previous day: the
    // generator OFFERS 00:00, and the write is REFUSED with
    // `HB001 appointment_buffer_conflict` from 0152's enforce_appointment_buffer.
    // It is an offer/accept divergence, not a silent overbooking.
    //
    // NOT FIXED HERE, and deliberately so. Repairing it changes which slots the
    // engine offers, and migrations 0170/0171 re-derive this candidate set in
    // SQL with exact millisecond membership — three parity suites assert set
    // equality between the two engines. The fix is a coordinated migration plus
    // this loader, in its own change; folding it into a behaviour-neutral
    // refactor would hide a real booking change inside a "no behaviour change"
    // PR. Reachable only by a studio whose open time falls within `buffer`
    // minutes of local midnight.
    //
    // THIS TEST PINS TODAY'S DEFECTIVE BEHAVIOUR ON PURPOSE, so the refactor is
    // provably behaviour-neutral over it. When the follow-up lands, this
    // expectation MUST flip to `not.toContain`.
    const spill = buildDaySlots({
      dateStr: DATE,
      tz: TZ,
      duration: 60,
      buffer: 30,
      openTime: "00:00",
      closeTime: "08:00",
      // The previous day's appointment is ABSENT, exactly as the loader's query
      // leaves it — that absence is the defect, and the core faithfully honours
      // the input it is given.
      reservations: [],
    });
    expect(starts(spill)).toContain(at("00:00"));
  });
});
