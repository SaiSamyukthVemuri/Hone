import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getAvailableSlots } from "@/lib/booking/slots";
import { localTimeString12h, utcInstantFromLocal } from "@/lib/booking/tz";

// EDGE PACKING — the closing-edge right-pack anchor and its dominance rule.
//
// THE DEFECT (reproduced first, in "Phase 3 reproduction" below): every candidate
// family was derived from the OPENING edge or from a RESERVATION, and none from
// the CLOSING edge. On a 09:00-17:00 day with a 45-minute service the coarse
// hourly walk ends at 16:00 (16:00 + 45 = 16:45), stranding 16:45-17:00, while
// 16:15 would consume the closing window exactly.
//
// SCOPE: opt-in via { packAgainstClosingEdge: true }, passed by INTERNAL
// practitioner surfaces only. The public surfaces omit it because migrations
// 0170/0171 re-derive this candidate set in SQL and demand exact membership —
// see the "public surfaces are byte-for-byte unchanged" block at the bottom.

const TZ = "America/Toronto";
const DATE = "2026-07-06"; // summer Monday, EDT, no DST transition

function localISO(hhmm: string, date: string = DATE): string {
  return utcInstantFromLocal(date, hhmm, TZ).toISOString();
}

const studio = (bufferMinutes: number) => ({
  id: "s1",
  timezone: TZ,
  default_appointment_duration_minutes: 60,
  buffer_minutes: bufferMinutes,
});

function mockSupabase(d: {
  blockouts?: unknown[];
  override?: unknown | null;
  defaultRow?: unknown | null;
  reservations?: {
    starts_at: string;
    ends_at: string;
    source_kind?: string;
    source_id?: string;
  }[];
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

const OPEN_09_17 = { is_open: true, open_time: "09:00:00", close_time: "17:00:00" };
const PACK = { packAgainstClosingEdge: true } as const;
const starts = (slots: { start: string }[]) => slots.map((s) => s.start);

const appt = (s: string, e: string, date = DATE) => ({
  starts_at: localISO(s, date),
  ends_at: localISO(e, date),
  source_kind: "appointment",
  source_id: "appt-1",
});
const block = (s: string, e: string, date = DATE) => ({
  starts_at: localISO(s, date),
  ends_at: localISO(e, date),
  source_kind: "timed_block",
  source_id: "blk-1",
});

/** Run the generator with edge packing ON (the internal-surface contract). */
function packed(opts: {
  duration?: number;
  buffer?: number;
  day?: unknown;
  noAvailabilityRow?: boolean;
  override?: unknown;
  reservations?: ReturnType<typeof appt>[];
  date?: string;
  blockouts?: unknown[];
  capacity?: boolean;
  practitionerId?: string | null;
  exclude?: { sourceKind: "appointment"; sourceId: string };
}) {
  return getAvailableSlots(
    mockSupabase({
      defaultRow: opts.noAvailabilityRow ? null : (opts.day ?? OPEN_09_17),
      override: opts.override ?? null,
      reservations: opts.reservations ?? [],
      blockouts: opts.blockouts ?? [],
    }),
    opts.capacity
      ? { ...studio(opts.buffer ?? 0), practitioner_capacity_enabled: true }
      : studio(opts.buffer ?? 0),
    opts.date ?? DATE,
    opts.duration ?? 45,
    opts.exclude,
    opts.practitionerId ?? undefined,
    PACK,
  );
}

// ---------------------------------------------------------------------------
// Phase 3 reproduction — kept as the regression pin for the original defect.
// ---------------------------------------------------------------------------

describe("Phase 3 reproduction: the closing edge had no anchor", () => {
  it("WITHOUT edge packing the day still ends at 16:00, stranding 15 minutes", async () => {
    const s = starts(
      await getAvailableSlots(
        mockSupabase({ defaultRow: OPEN_09_17, reservations: [] }),
        studio(0),
        DATE,
        45,
      ),
    );
    // The untouched (public) contract: hourly walk from the opening edge.
    expect(s[s.length - 1]).toBe(localISO("16:00"));
    expect(s).not.toContain(localISO("16:15"));
  });
});

// ---------------------------------------------------------------------------
// A. Chloe's closing-edge case — the primary acceptance case.
// ---------------------------------------------------------------------------

describe("A. Chloe: 09:00-17:00, 45-minute service", () => {
  it("offers 16:15 — the start whose service ends exactly at close", async () => {
    const s = starts(await packed({ duration: 45 }));
    expect(s).toContain(localISO("16:15"));
  });

  it("16:15 ends EXACTLY at 17:00", async () => {
    const slots = await packed({ duration: 45 });
    expect(slots.find((x) => x.start === localISO("16:15"))?.end).toBe(
      localISO("17:00"),
    );
  });

  it("16:00 is DOMINATED and is NOT offered (documented Phase 5 decision)", async () => {
    const s = starts(await packed({ duration: 45 }));
    // 16:00 is a COARSE grid time; its service ends 16:45, leaving a 15-minute
    // residual that cannot host another 45-minute treatment; and the genuinely
    // new precise anchor 16:15 packs the same window exactly. It is suppressed.
    expect(s).not.toContain(localISO("16:00"));
    expect(s).toContain(localISO("16:15"));
  });

  it("suppression is slot-count NEUTRAL — one dominated time traded for one packed time", async () => {
    const before = await getAvailableSlots(
      mockSupabase({ defaultRow: OPEN_09_17, reservations: [] }),
      studio(0),
      DATE,
      45,
    );
    const after = await packed({ duration: 45 });
    expect(after).toHaveLength(before.length);
  });

  it("the exact offered list is the hourly walk with the tail repacked", async () => {
    const s = starts(await packed({ duration: 45 }));
    expect(s).toEqual([
      localISO("09:00"),
      localISO("10:00"),
      localISO("11:00"),
      localISO("12:00"),
      localISO("13:00"),
      localISO("14:00"),
      localISO("15:00"),
      localISO("16:15"),
    ]);
  });

  it("only the dominated tail time is removed — every earlier choice survives", async () => {
    const s = starts(await packed({ duration: 45 }));
    for (const t of ["09:00", "10:00", "13:00", "15:00"]) {
      expect(s).toContain(localISO(t));
    }
  });
});

// ---------------------------------------------------------------------------
// B. 60-minute exact close — the anchor coincides with an existing time.
// ---------------------------------------------------------------------------

describe("B. 60-minute service, 17:00 close", () => {
  it("closing anchor is 16:00 and it IS offered (no regression)", async () => {
    const s = starts(await packed({ duration: 60 }));
    expect(s).toContain(localISO("16:00"));
    expect(s[s.length - 1]).toBe(localISO("16:00"));
  });

  it("a candidate that IS the closing anchor is never suppressed by its own rule", async () => {
    // 16:00 is simultaneously the coarse hourly step and the closing anchor.
    // The strict `start < closingAnchor` guard keeps it.
    const s = starts(await packed({ duration: 60 }));
    expect(s).toEqual([
      localISO("09:00"),
      localISO("10:00"),
      localISO("11:00"),
      localISO("12:00"),
      localISO("13:00"),
      localISO("14:00"),
      localISO("15:00"),
      localISO("16:00"),
    ]);
  });

  it("matches the pre-change generator EXACTLY for this duration", async () => {
    const before = await getAvailableSlots(
      mockSupabase({ defaultRow: OPEN_09_17, reservations: [] }),
      studio(0),
      DATE,
      60,
    );
    const after = await packed({ duration: 60 });
    expect(starts(after)).toEqual(starts(before));
  });
});

// ---------------------------------------------------------------------------
// C. 30-minute service — closing edge added, coarse time RETAINED.
// ---------------------------------------------------------------------------

describe("C. 30-minute service, 17:00 close", () => {
  it("offers the 16:30 closing edge", async () => {
    const s = starts(await packed({ duration: 30 }));
    expect(s).toContain(localISO("16:30"));
    expect(
      (await packed({ duration: 30 })).find((x) => x.start === localISO("16:30"))
        ?.end,
    ).toBe(localISO("17:00"));
  });

  it("KEEPS 16:00 — it is not terminal, a further 30-minute booking still fits", async () => {
    // 16:00 -> ends 16:30; another 30-minute service fits 16:30-17:00. The
    // candidate is real choice, not a stranded fragment, so the dominance rule
    // must not touch it. This is the case that proves the rule is not "always
    // drop the last coarse time".
    const s = starts(await packed({ duration: 30 }));
    expect(s).toContain(localISO("16:00"));
    expect(s).toContain(localISO("16:30"));
  });

  it("is slot-count POSITIVE here (adds a choice, removes none)", async () => {
    const before = await getAvailableSlots(
      mockSupabase({ defaultRow: OPEN_09_17, reservations: [] }),
      studio(0),
      DATE,
      30,
    );
    const after = await packed({ duration: 30 });
    expect(after.length).toBe(before.length + 1);
  });
});

// ---------------------------------------------------------------------------
// D. Non-round duration — exact arithmetic, no 15-minute rounding.
// ---------------------------------------------------------------------------

describe("D. 37-minute service — no rounding", () => {
  it("closing anchor is exactly close - 37m = 16:23", async () => {
    const s = starts(await packed({ duration: 37 }));
    expect(s).toContain(localISO("16:23"));
    expect(s[s.length - 1]).toBe(localISO("16:23"));
  });

  it("does NOT round to a 15-minute boundary", async () => {
    const s = starts(await packed({ duration: 37 }));
    expect(s).not.toContain(localISO("16:15"));
    expect(s).not.toContain(localISO("16:30"));
  });

  it("ends exactly at close", async () => {
    const slots = await packed({ duration: 37 });
    expect(slots.find((x) => x.start === localISO("16:23"))?.end).toBe(
      localISO("17:00"),
    );
  });

  it("a 50-minute service anchors at 16:10", async () => {
    const s = starts(await packed({ duration: 50 }));
    expect(s).toContain(localISO("16:10"));
  });
});

// ---------------------------------------------------------------------------
// E. Backward packing before the next appointment — PRESERVED.
// ---------------------------------------------------------------------------

describe("E. immediately BEFORE an existing appointment", () => {
  it("still offers reservation.start - duration - buffer", async () => {
    // Appointment 13:00-14:00, buffer 30, duration 60 -> 13:00 - 60 - 30 = 11:30.
    const s = starts(
      await packed({
        duration: 60,
        buffer: 30,
        reservations: [appt("13:00", "14:00")],
      }),
    );
    expect(s).toContain(localISO("11:30"));
  });

  it("the backward anchor still accounts for the TRAILING buffer", async () => {
    // With buffer 45: 13:00 - 60 - 45 = 11:15 is legal; 11:30 would end 12:30
    // with a protected end of 13:15, crossing the appointment start.
    const s = starts(
      await packed({
        duration: 60,
        buffer: 45,
        reservations: [appt("13:00", "14:00")],
      }),
    );
    expect(s).toContain(localISO("11:15"));
    expect(s).not.toContain(localISO("11:30"));
  });

  it("a backward anchor is PRECISE and is never suppressed by the dominance rule", async () => {
    // Day 09:00-17:00, duration 60, buffer 0, appointment 17:00 is impossible —
    // instead put a block at the very end so the backward anchor is terminal.
    const s = starts(
      await packed({
        duration: 60,
        buffer: 0,
        reservations: [block("16:00", "17:00")],
      }),
    );
    // 15:00 = 16:00 - 60 - 0 is the backward anchor and is terminal (nothing
    // fits after it), yet it is precise, so it survives.
    expect(s).toContain(localISO("15:00"));
  });
});

// ---------------------------------------------------------------------------
// F. Forward packing after the previous appointment — PRESERVED.
// ---------------------------------------------------------------------------

describe("F. immediately AFTER an existing appointment", () => {
  it("offers actual end + current studio buffer", async () => {
    const s = starts(
      await packed({
        duration: 60,
        buffer: 15,
        reservations: [appt("10:00", "11:00")],
      }),
    );
    expect(s).toContain(localISO("11:15"));
    expect(s).not.toContain(localISO("11:00")); // buffer violation
  });

  it("buffer 0 packs exactly at the appointment end", async () => {
    const s = starts(
      await packed({
        duration: 60,
        buffer: 0,
        reservations: [appt("10:00", "11:00")],
      }),
    );
    expect(s).toContain(localISO("11:00"));
  });

  it("a forward anchor is PRECISE and survives even when terminal", async () => {
    // Appointment 15:00-16:00, buffer 0, duration 45, close 17:00.
    // Forward anchor 16:00 is terminal (16:45 + 45 > 17:00) and the closing
    // anchor 16:15 exists — but 16:00 is a real packing decision (it lets the
    // practitioner finish at 16:45 and leave), so BOTH are offered.
    const s = starts(
      await packed({
        duration: 45,
        buffer: 0,
        reservations: [appt("15:00", "16:00")],
      }),
    );
    expect(s).toContain(localISO("16:00"));
    expect(s).toContain(localISO("16:15"));
  });
});

// ---------------------------------------------------------------------------
// G. Timed blocks / recurring breaks — no appointment buffer.
// ---------------------------------------------------------------------------

describe("G. timed blocks carry NO appointment buffer", () => {
  it("the slot immediately after a block is the block's RAW end", async () => {
    const s = starts(
      await packed({
        duration: 60,
        buffer: 15,
        reservations: [block("12:00", "13:00")],
      }),
    );
    expect(s).toContain(localISO("13:00")); // raw end, buffer NOT added
    expect(s).not.toContain(localISO("13:15"));
    expect(s).not.toContain(localISO("12:00"));
  });

  it("the backward anchor before a block still uses the candidate's own buffer", async () => {
    // The candidate's OWN trailing buffer must still fit: 12:00 - 60 - 15 = 10:45.
    const s = starts(
      await packed({
        duration: 60,
        buffer: 15,
        reservations: [block("12:00", "13:00")],
      }),
    );
    expect(s).toContain(localISO("10:45"));
  });

  it("closing-edge packing does not widen a block past its end", async () => {
    const s = starts(
      await packed({
        duration: 45,
        buffer: 30,
        reservations: [block("16:15", "17:00")],
      }),
    );
    // The tail is blocked, so no closing anchor can be offered at all.
    expect(s).not.toContain(localISO("16:15"));
    expect(s.every((x) => x <= localISO("15:30"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// H. The trailing buffer MAY extend past close — Hone's authoritative rule.
// ---------------------------------------------------------------------------

describe("H. trailing buffer past closing time", () => {
  it("the closing anchor is close - duration, NOT close - duration - buffer", async () => {
    // Buffer 30. The service must END by 17:00; its trailing buffer runs to
    // 17:30, past close, which Hone and the DB validator both allow.
    const s = starts(await packed({ duration: 45, buffer: 30 }));
    expect(s).toContain(localISO("16:15")); // 17:00 - 45
    expect(s).not.toContain(localISO("15:45")); // 17:00 - 45 - 30 (wrong rule)
  });

  it("holds for every buffer value — the anchor never moves", async () => {
    for (const buffer of [0, 5, 15, 30, 60]) {
      const s = starts(await packed({ duration: 45, buffer }));
      expect(s).toContain(localISO("16:15"));
    }
  });

  it("the anchor's own END is exactly close for every buffer", async () => {
    for (const buffer of [0, 15, 45]) {
      const slots = await packed({ duration: 45, buffer });
      expect(slots.find((x) => x.start === localISO("16:15"))?.end).toBe(
        localISO("17:00"),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// I. Overlap — no new candidate may overlap a protected interval.
// ---------------------------------------------------------------------------

describe("I. the closing anchor obeys the overlap contract", () => {
  it("is dropped when an appointment occupies the tail", async () => {
    const s = starts(
      await packed({
        duration: 45,
        buffer: 0,
        reservations: [appt("16:00", "17:00")],
      }),
    );
    expect(s).not.toContain(localISO("16:15"));
    // 15:15 IS legal — it is the backward anchor (16:00 - 45 - 0) and its
    // service end touches the appointment start exactly.
    expect(s).toContain(localISO("15:15"));
    expect(s[s.length - 1]).toBe(localISO("15:15"));
  });

  it("is dropped when the tail appointment's BUFFER covers it", async () => {
    // Appointment 15:00-16:00 with a 60-minute buffer -> protected to 17:00.
    const s = starts(
      await packed({
        duration: 45,
        buffer: 60,
        reservations: [appt("15:00", "16:00")],
      }),
    );
    expect(s).not.toContain(localISO("16:15"));
  });

  it("no offered slot ever overlaps any protected interval", async () => {
    const reservations = [appt("11:00", "12:00"), block("14:00", "15:00")];
    const buffer = 15;
    const duration = 45;
    const slots = await packed({ duration, buffer, reservations });
    const protectedIntervals = [
      // appointment: actual end + buffer
      [
        new Date(localISO("11:00")).getTime(),
        new Date(localISO("12:00")).getTime() + buffer * 60_000,
      ],
      // timed block: raw end
      [
        new Date(localISO("14:00")).getTime(),
        new Date(localISO("15:00")).getTime(),
      ],
    ];
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const a = new Date(s.start).getTime();
      const b = a + duration * 60_000 + buffer * 60_000;
      for (const [cs, ce] of protectedIntervals) {
        expect(a < ce && b > cs).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// J. Overrides / effective availability boundary.
// ---------------------------------------------------------------------------

describe("J. the closing edge follows the EFFECTIVE availability boundary", () => {
  it("a date override's close_time drives the anchor, not the weekly default", async () => {
    const s = starts(
      await packed({
        duration: 45,
        override: { is_open: true, open_time: "09:00:00", close_time: "15:30:00" },
      }),
    );
    expect(s).toContain(localISO("14:45")); // 15:30 - 45
    expect(s).not.toContain(localISO("16:15")); // the DEFAULT close, ignored
  });

  it("a short override window still yields exactly one packed anchor", async () => {
    const s = starts(
      await packed({
        duration: 45,
        override: { is_open: true, open_time: "09:00:00", close_time: "09:50:00" },
      }),
    );
    // Opening anchor 09:00 (precise, never suppressed) + closing anchor 09:05.
    expect(s).toContain(localISO("09:00"));
    expect(s).toContain(localISO("09:05"));
  });

  it("a window SHORTER than the service yields nothing", async () => {
    const s = starts(
      await packed({
        duration: 45,
        override: { is_open: true, open_time: "09:00:00", close_time: "09:30:00" },
      }),
    );
    expect(s).toHaveLength(0);
  });

  it("a lunch block splits the day and BOTH sub-windows keep their packing", async () => {
    // 09:00-17:00 with a 12:00-13:00 block, 45-minute service, buffer 0.
    const s = starts(
      await packed({
        duration: 45,
        buffer: 0,
        reservations: [block("12:00", "13:00")],
      }),
    );
    expect(s).toContain(localISO("11:15")); // right-pack before the block
    expect(s).toContain(localISO("13:00")); // left-pack after the block
    expect(s).toContain(localISO("16:15")); // right-pack against close
  });
});

// ---------------------------------------------------------------------------
// K. Per-practitioner capacity ON.
// ---------------------------------------------------------------------------

describe("K. per-practitioner capacity ON", () => {
  it("packs the closing edge identically", async () => {
    const s = starts(
      await packed({ duration: 45, capacity: true, practitionerId: "prac-1" }),
    );
    expect(s).toContain(localISO("16:15"));
    expect(s).not.toContain(localISO("16:00"));
  });

  it("produces the SAME list as capacity OFF for the same availability", async () => {
    const on = starts(
      await packed({ duration: 45, capacity: true, practitionerId: "prac-1" }),
    );
    const off = starts(await packed({ duration: 45 }));
    expect(on).toEqual(off);
  });

  it("respects a practitioner-specific override close time", async () => {
    const s = starts(
      await packed({
        duration: 45,
        capacity: true,
        practitionerId: "prac-1",
        override: { is_open: true, open_time: "10:00:00", close_time: "16:00:00" },
      }),
    );
    expect(s).toContain(localISO("15:15")); // 16:00 - 45
  });
});

// ---------------------------------------------------------------------------
// L. DST.
// ---------------------------------------------------------------------------

describe("L. DST boundary dates use the timezone authority", () => {
  const SPRING = "2026-03-08"; // Toronto spring-forward, 02:00 -> 03:00
  const FALL = "2026-11-01"; // Toronto fall-back, 02:00 -> 01:00

  it("spring-forward: the closing anchor ends exactly at close", async () => {
    const slots = await packed({ duration: 45, date: SPRING });
    const anchor = slots.find(
      (x) =>
        new Date(x.start).getTime() ===
        new Date(localISO("17:00", SPRING)).getTime(),
    );
    expect(anchor).toBeUndefined(); // 17:00 itself is never a start
    const last = slots[slots.length - 1];
    expect(last.end).toBe(localISO("17:00", SPRING));
    expect(localTimeString12h(new Date(last.start), TZ)).toBe("4:15 PM");
  });

  it("fall-back: the closing anchor ends exactly at close", async () => {
    const slots = await packed({ duration: 45, date: FALL });
    const last = slots[slots.length - 1];
    expect(last.end).toBe(localISO("17:00", FALL));
    expect(localTimeString12h(new Date(last.start), TZ)).toBe("4:15 PM");
  });

  it("the anchor is exactly `duration` of ELAPSED time before close, both days", async () => {
    for (const date of [SPRING, FALL, DATE]) {
      const slots = await packed({ duration: 45, date });
      const last = slots[slots.length - 1];
      const elapsed =
        new Date(localISO("17:00", date)).getTime() -
        new Date(last.start).getTime();
      expect(elapsed).toBe(45 * 60_000);
    }
  });

  it("an availability window spanning the spring-forward gap still packs correctly", async () => {
    // 01:00-05:00 local on the spring-forward day is only THREE real hours.
    const slots = await packed({
      duration: 60,
      date: SPRING,
      override: { is_open: true, open_time: "01:00:00", close_time: "05:00:00" },
    });
    const last = slots[slots.length - 1];
    expect(last.end).toBe(localISO("05:00", SPRING));
    expect(
      new Date(localISO("05:00", SPRING)).getTime() -
        new Date(last.start).getTime(),
    ).toBe(60 * 60_000);
  });
});

// ---------------------------------------------------------------------------
// M. Move / reschedule own-reservation exclusion.
// ---------------------------------------------------------------------------

describe("M. own-reservation exclusion still applies", () => {
  it("the excluded appointment frees the closing edge it was occupying", async () => {
    const reservations = [appt("16:00", "17:00")];
    const without = starts(
      await packed({ duration: 45, buffer: 0, reservations }),
    );
    expect(without).not.toContain(localISO("16:15"));

    const withExclusion = starts(
      await packed({
        duration: 45,
        buffer: 0,
        reservations,
        exclude: { sourceKind: "appointment", sourceId: "appt-1" },
      }),
    );
    expect(withExclusion).toContain(localISO("16:15"));
  });

  it("a NON-matching exclusion id changes nothing", async () => {
    const s = starts(
      await packed({
        duration: 45,
        buffer: 0,
        reservations: [appt("16:00", "17:00")],
        exclude: { sourceKind: "appointment", sourceId: "some-other-id" },
      }),
    );
    expect(s).not.toContain(localISO("16:15"));
  });

  it("a timed block is NEVER excluded by an appointment exclusion", async () => {
    const s = starts(
      await packed({
        duration: 45,
        buffer: 0,
        reservations: [block("16:00", "17:00")],
        exclude: { sourceKind: "appointment", sourceId: "blk-1" },
      }),
    );
    expect(s).not.toContain(localISO("16:15"));
  });
});

// ---------------------------------------------------------------------------
// N. Empty / closed / blocked-out days produce nothing new.
// ---------------------------------------------------------------------------

describe("N. no bogus slots on non-working days", () => {
  it("a closed day stays empty", async () => {
    const s = await packed({
      duration: 45,
      day: { is_open: false, open_time: null, close_time: null },
    });
    expect(s).toHaveLength(0);
  });

  it("a full-day blockout stays empty", async () => {
    const s = await packed({
      duration: 45,
      blockouts: [{ starts_on: DATE, ends_on: DATE }],
    });
    expect(s).toHaveLength(0);
  });

  it("a day with no availability row at all stays empty", async () => {
    const s = await packed({ duration: 45, noAvailabilityRow: true });
    expect(s).toHaveLength(0);
  });

  it("a fully booked day offers nothing", async () => {
    const s = await packed({
      duration: 45,
      buffer: 0,
      reservations: [block("09:00", "17:00")],
    });
    expect(s).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Invariants that must hold for EVERY generated list.
// ---------------------------------------------------------------------------

describe("global invariants", () => {
  const durations = [15, 30, 37, 45, 50, 60, 90];
  const buffers = [0, 15, 30];

  // The two exhaustive sweeps below are legitimately multi-second, and Vitest's
  // DEFAULT per-test budget is 5000ms. Each sweep walks 286 durations (15..300
  // inclusive) x 3 (or 2) buffers, and every step generates slots TWICE — the
  // unpacked baseline and the packed list — so the offered-count sweep alone
  // makes 1716 getAvailableSlots calls. That is the point: the range is
  // exhaustive because a finite sample of `durations` above already missed a
  // real defect (the 91-minute case in the comment further down), so it must not
  // be narrowed to buy speed.
  //
  // Measured: ~1.5s for the offered-count sweep and ~1.0s for the suppression
  // sweep when this file runs ALONE, but ~4x that under the full 506-file suite
  // on a CI runner, where the fork pool is competing for far fewer cores. Run
  // 31192253014 timed the offered-count sweep out at the 5000ms default with the
  // ASSERTION never failing — a budget problem misreported as a test failure.
  //
  // Per CLAUDE.md ("a hard timeout must always EXCEED its performance target"),
  // this is a hard ceiling well above the ~6s CI observation, not a new target.
  // It is scoped to these two tests deliberately: a repo-wide testTimeout would
  // hand the same slack to 7920 tests that should still fail fast.
  const EXHAUSTIVE_SWEEP_TIMEOUT_MS = 15_000;

  it("every offered slot's service end is <= close, for every duration/buffer", async () => {
    for (const duration of durations) {
      for (const buffer of buffers) {
        const slots = await packed({
          duration,
          buffer,
          reservations: [appt("11:00", "12:00"), block("14:00", "14:30")],
        });
        for (const s of slots) {
          expect(new Date(s.end).getTime()).toBeLessThanOrEqual(
            new Date(localISO("17:00")).getTime(),
          );
          expect(new Date(s.start).getTime()).toBeGreaterThanOrEqual(
            new Date(localISO("09:00")).getTime(),
          );
        }
      }
    }
  });

  it("lists stay sorted and unique", async () => {
    for (const duration of durations) {
      const s = starts(
        await packed({ duration, buffer: 15, reservations: [appt("13:00", "14:00")] }),
      );
      expect(s).toEqual([...s].sort());
      expect(new Set(s).size).toBe(s.length);
    }
  });

  // A SWEEP, not a sample. The first version of this test used the handful of
  // durations above and missed a real defect: the stranding condition holds
  // across an interval `duration` wide, so once the service runs longer than the
  // 60-minute fallback step, MORE THAN ONE grid time falls inside it. A 91-minute
  // service dropped both 14:00 and 15:00 for a single 15:29 anchor (7 slots -> 6).
  // Sweeping every minute is what makes the one-for-one trade provable rather
  // than assumed.
  it("edge packing NEVER reduces the offered count — every duration 15..300", async () => {
    for (let duration = 15; duration <= 300; duration += 1) {
      for (const buffer of [0, 15, 30]) {
        const before = await getAvailableSlots(
          mockSupabase({ defaultRow: OPEN_09_17, reservations: [] }),
          studio(buffer),
          DATE,
          duration,
        );
        const after = await packed({ duration, buffer });
        expect(
          after.length,
          `duration=${duration} buffer=${buffer}: ${before.length} -> ${after.length}`,
        ).toBeGreaterThanOrEqual(before.length);
      }
    }
  }, EXHAUSTIVE_SWEEP_TIMEOUT_MS);

  it("AT MOST ONE candidate is ever suppressed — every duration 15..300", async () => {
    for (let duration = 15; duration <= 300; duration += 1) {
      for (const buffer of [0, 30]) {
        const reservations = [appt("11:00", "12:00")];
        const before = starts(
          await getAvailableSlots(
            mockSupabase({ defaultRow: OPEN_09_17, reservations }),
            studio(buffer),
            DATE,
            duration,
          ),
        );
        const after = starts(await packed({ duration, buffer, reservations }));
        const removed = before.filter((x) => !after.includes(x));
        expect(
          removed.length,
          `duration=${duration} buffer=${buffer} removed ${removed.length}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  }, EXHAUSTIVE_SWEEP_TIMEOUT_MS);

  it("edge packing NEVER reduces the offered count WITH reservations present", async () => {
    for (const duration of durations) {
      for (const buffer of buffers) {
        const reservations = [appt("11:00", "12:00")];
        const before = await getAvailableSlots(
          mockSupabase({ defaultRow: OPEN_09_17, reservations }),
          studio(buffer),
          DATE,
          duration,
        );
        const after = await packed({ duration, buffer, reservations });
        expect(after.length).toBeGreaterThanOrEqual(before.length);
      }
    }
  });

  it("every slot removed by the dominance rule is replaced by a later, better-packed one", async () => {
    for (const duration of durations) {
      const reservations = [appt("11:00", "12:00")];
      const before = starts(
        await getAvailableSlots(
          mockSupabase({ defaultRow: OPEN_09_17, reservations }),
          studio(0),
          DATE,
          duration,
        ),
      );
      const after = starts(await packed({ duration, buffer: 0, reservations }));
      for (const removed of before.filter((x) => !after.includes(x))) {
        // Something strictly later must exist, and it must pack the tail exactly.
        const later = after.filter((x) => x > removed);
        expect(later.length).toBeGreaterThan(0);
        const lastEnd =
          new Date(after[after.length - 1]).getTime() + duration * 60_000;
        expect(lastEnd).toBe(new Date(localISO("17:00")).getTime());
      }
    }
  });
});

// ---------------------------------------------------------------------------
// PUBLIC SURFACES ARE BYTE-FOR-BYTE UNCHANGED.
//
// Migrations 0170/0171 re-derive this candidate set in SQL and require exact
// millisecond membership (returning 'not_a_public_slot' otherwise). Until that
// port gains the closing anchor, no public route may pass the option — or the
// page would offer a time the database refuses.
// ---------------------------------------------------------------------------

describe("display-vs-acceptance parity: public routes must NOT edge-pack", () => {
  const read = (p: string) =>
    readFileSync(path.resolve(__dirname, "../../../", p), "utf8");
  const PUBLIC_BOOK = read("app/book/[slug]/actions.ts");
  const PUBLIC_RESCHEDULE = read("app/reschedule/[token]/actions.ts");
  const SLOTS = read("lib/booking/slots.ts");

  it("the public booking route never enables closing-edge packing", () => {
    expect(PUBLIC_BOOK).not.toMatch(/packAgainstClosingEdge/);
  });

  it("the public reschedule route never enables closing-edge packing", () => {
    expect(PUBLIC_RESCHEDULE).not.toMatch(/packAgainstClosingEdge/);
  });

  it("the option is opt-in — it defaults to OFF when omitted", async () => {
    const s = starts(
      await getAvailableSlots(
        mockSupabase({ defaultRow: OPEN_09_17, reservations: [] }),
        studio(0),
        DATE,
        45,
      ),
    );
    expect(s).not.toContain(localISO("16:15"));
    expect(s).toContain(localISO("16:00"));
  });

  it("an explicitly false option is also OFF", async () => {
    const s = starts(
      await getAvailableSlots(
        mockSupabase({ defaultRow: OPEN_09_17, reservations: [] }),
        studio(0),
        DATE,
        45,
        undefined,
        undefined,
        { packAgainstClosingEdge: false },
      ),
    );
    expect(s).not.toContain(localISO("16:15"));
  });

  it("the generator documents the SQL-port coupling", () => {
    expect(SLOTS).toMatch(/public_booking_slot_candidates/);
    expect(SLOTS).toMatch(/not_a_public_slot/);
  });

  it("neither public route imports the internal packing contract", () => {
    expect(PUBLIC_BOOK).not.toMatch(/INTERNAL_SLOT_PACKING/);
    expect(PUBLIC_RESCHEDULE).not.toMatch(/INTERNAL_SLOT_PACKING/);
  });

  it("the public next-available scanners are also unpacked", () => {
    // Both public files call getAvailableSlots more than once (display, the
    // submit re-verify, and the multi-day next-available scan). NONE may pack.
    for (const src of [PUBLIC_BOOK, PUBLIC_RESCHEDULE]) {
      expect((src.match(/getAvailableSlots\(/g) ?? []).length).toBeGreaterThan(1);
      expect(src).not.toMatch(/packAgainstClosingEdge/);
    }
  });
});

// ---------------------------------------------------------------------------
// Every INTERNAL surface packs — including both halves of the move flow.
// ---------------------------------------------------------------------------

describe("internal surfaces all opt in", () => {
  const read = (p: string) =>
    readFileSync(path.resolve(__dirname, "../../../", p), "utf8");
  const MOVE = read("app/(app)/calendar/move-appointment-actions.ts");
  const CALENDAR = read("app/(app)/calendar/actions.ts");
  const CLIENT_BOOKING = read("app/(app)/clients/[id]/booking-actions.ts");

  it("the calendar quick-book precheck packs", () => {
    expect(CALENDAR).toMatch(/INTERNAL_SLOT_PACKING/);
  });

  it("the client-page booking list packs", () => {
    expect(CLIENT_BOOKING).toMatch(/INTERNAL_SLOT_PACKING/);
  });

  it("BOTH move call sites pack — display AND server re-verification", () => {
    // The move flow generates the list twice. If only the display packed, the
    // practitioner would see the packed slot and the re-check would refuse it.
    const calls = (MOVE.match(/getAvailableSlots\(/g) ?? []).length;
    // one named import + one argument per call site
    const packs = (MOVE.match(/INTERNAL_SLOT_PACKING/g) ?? []).length;
    expect(calls).toBe(2);
    expect(packs).toBe(3);
  });

  it("every internal getAvailableSlots call site is accounted for", () => {
    // Guard against a NEW internal surface being added without a packing
    // decision: the three files above are the complete internal set today.
    for (const src of [MOVE, CALENDAR, CLIENT_BOOKING]) {
      const calls = (src.match(/getAvailableSlots\(/g) ?? []).length;
      const packs = (src.match(/INTERNAL_SLOT_PACKING/g) ?? []).length;
      // one import + one per call site
      expect(packs).toBe(calls + 1);
    }
  });
});
